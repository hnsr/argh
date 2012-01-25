#!/usr/bin/env node

var vm       = require("vm");
var fs       = require("fs");
var util     = require("util");
var repl     = require("repl");
var commands = require("./commands.js");
var common   = require("./common.js");
var codes    = require("./irccodes.js");
var irc      = require("./irc.js");


// Init ////////////////////////////////////////////////////////////////////////////////////////////

var version = "0.1";
var conf;
var confPrefix = (process.env["HOME"] || "")+"/.argh/";
var retryCount = 0;
var retryTimer;      // !null if a reconnect is scheduled
var retryResetTimer; // !null if we've connected and haven't reset retryCount yet
var client;
var data; // Object with persistent data objects

var commandHooks;  // Object with for each 'event' an array of objects specifying a handler function
                   // and a context to invoke that handler function with, for each command hooking
                   // into that event.

var startTime = Date.now();   // Time when we started
var connectTime = null; // Time since last connect

// Some magic to have everything that is logged prefixed with '**', and make 'log' an alias for it.
var logRaw = console.log;
var logTimed = function (msg) { logRaw(common.getTimestampStr(false)+" "+msg); };
var log = console.log = function (msg) { logTimed("** "+msg) };


log("Argh " + version + " starting up");

checkConfDirs();
loadConfig();

client = new irc.Client(
{
    burstCount: conf.burstCount,
    burstPeriod: conf.burstPeriod,
    password: conf.password,
    nicks: conf.nicks
});

loadData();
initCommands();

client.on("output",         onOutput);
client.on("input",          onInput);
client.on("connect",        onConnect);
client.on("register",       onRegister);
client.on("userList",       onUserList);
client.on("userUpdate",     onUserUpdate);
client.on("channelMessage", onChannelMessage);
client.on("privateMessage", onPrivateMessage);
client.on("error",          onError);
client.on("disconnect",     onDisconnect);

log("Connecting to "+conf.host+":"+conf.port+"...");

client.connect(conf.host, conf.port);

// Setup a command prompt that can be used to give commands, and in emergencies can also eval code
// in this file's local scope to fix things on the fly:
var prompt = repl.start("> ");

log(""); // Prevent first log message ending up behind prompt

prompt.context.run = function (cmd)
{
    var pcmd;

    if (pcmd = parseCommand(cmd))
    {
        var origin = { fromConsole: true };
        runCommand(pcmd, origin);
    }
}
prompt.context.eval = function (code)
{
    try
    {
        eval(code);
    }
    catch (e)
    {
        log(e.message);
    }
}


// Misc functions //////////////////////////////////////////////////////////////////////////////////

function error   (message) { log("ERROR: "  +message); process.exit(1); }
function warning (message) { log("WARNING: "+message); }
function debug   (message) { log("DEBUG: "  +message); }


// Returns unicode-escaped command prefix character for safe use in RegExp string, i.e "\\u005c"
function getEscapedCmdPrefix()
{
    // Just take the first character and turn it into a unicode escape sequence
    var prefix = conf.command_prefix.charCodeAt(0);
    var prefixHex = prefix.toString(16);

    if (prefixHex.length > 0 && prefixHex.length < 5)
    {
        // Add leading zeroes if needed
        var numZeroes = 4-prefixHex.length;
        for (var i = 0; i < numZeroes; i++) prefixHex = "0" + prefixHex;

        return "\\u" + prefixHex;
    }
    else
        error("command_prefix setting is invalid");
}

// Load and parse json from file at given path, returns false on failure, else the parsed data.
function loadJSON(path)
{
    var json;

    try
    {
        json = fs.readFileSync(path, "utf8");
        return JSON.parse(json)
    }
    catch (err)
    {
        warning("failed to load/parse '"+path+"': "+err.message);
        return false;
    }
}

// JSONify and save data to path, returns false on failure.
function saveJSON(path, outData)
{
    var json = JSON.stringify(outData, null, 4);

    if (json)
    {
        try
        {
            fs.writeFileSync(path, json);
            return true;
        }
        catch (err)
        {
            warning("failed to write to "+path+": "+err.message);
            return false;
        }
    }
    else
        warning("failed to JSONify data: "+util.inspect(outData));

    return false;
}

// Load configuration from JSON encoded config file
function loadConfig()
{
    var confPath = confPrefix+"/config.js";
    var loaded;

    if ( !(loaded = loadJSON(confPath)) )
    {
        error("failed to load configuration");
    }
    conf = loaded;

    // Ensure some defaults
    conf.port = conf.port ? conf.port : 6667;
}

// Synchroneously create a directory, fail silently if it already exists
function mkdir(path, mode)
{
    try
    {
        fs.mkdirSync(path, mode);
        log("Created configuration directory at "+fs.realpathSync(path));
    }
    catch (e)
    {
        if (e.code != "EEXIST") throw e; // Filter EEXIST exceptions
    }
}

// Attempts to create configuration dirs if they don't exist yet, returns true on success or false.
function checkConfDirs()
{
    try
    {
        mkdir(confPrefix, "777"); // Redundant? Wouldn't have started without config..
        mkdir(confPrefix+"/data", "777");
    }
    catch (e)
    {
        error("failed to create configuration directories "+e.message);
    }
}

// Load data from all the files under data/
function loadData()
{
    var files = fs.readdirSync(confPrefix+"/data");
    data = {};

    // Load each file as JSON and exit if we fail; to prevent commands losing their data by
    // overwriting it with an empty data object.
    files.forEach(function (file)
    {
        var matches = /^([a-zA-Z0-9]+)\.js$/.exec(file);

        if (matches)
        {
            var fileBase = matches[1];

            log("Loading data for command '"+fileBase+"'");

            var dataFile = loadJSON(confPrefix+"/data/"+file);

            if (dataFile)
                data[fileBase] = dataFile;
            else
                error("Failed to load data from '"+file+"'");
        }
        else log("Ignoring '"+file+"'");
    });
}


// Write out data objects to files.
function saveData()
{
    log("Saving data");

    // Loop over data array, save each element to file, make sure that key has no funny
    // characters in it (just /[a-z0-9]+/i)
    for (var file in data)
    {
        var fileData = data[file];
        if (fileData && /^[a-zA-Z0-9]+$/.test(file))
        {
            if (!saveJSON(confPrefix+"/data/"+file+".js", fileData))
                warning("failed to save data for command: "+file);
        }
        else
            waning("Not saving data for "+file+" (no data or invalid format)");
    }
}


// Returns a handle to a data object (and creates one if needed), returns null on error.
function getData(name)
{
    if (!name) return null;

    return (data[name] = data[name] || {});
}


// Initialize commands, for now, it adds entries to commandHooks
function initCommands()
{
    commandHooks = {};

    // For every command, check if it has hooks, if so, loop over its hooks and add them to
    // commandHooks, along with CommandContext used when the hook handler function is invoked.
    for (var cmd in commands)
    {
        if (!commands[cmd].hooks) continue;

        var context = new CommandContext(commands[cmd], null, cmd, null);

        for (var p in commands[cmd].hooks)
        {
            // Add entry to array for this event, initialize array first if needed.
            if (!commandHooks[p]) commandHooks[p] = [];

            commandHooks[p].push({ context: context, handler: commands[cmd].hooks[p] });
        }
    }
    // I can remove a command from commandHooks by iterating over a command's hooks object, then for
    // each hook, scan commandHooks[hookEvent] to find matching handler, then remove it?
}


// Call all registered command hooks for event 'name', passing args as arguments
function callCommandHooks(name, args)
{
    for (var p in commandHooks[name])
    {
        var hook = commandHooks[name][p];

        try
        {
           if (hook.handler && hook.context)
                hook.handler.apply(hook.context, args);
        }
        catch(err)
        {
            // Add more info
            log("Failed to execute command hooks for event "+name);
            log(err.stack);
        }
    }
}


// irc.Client processing ///////////////////////////////////////////////////////////////////////////

function onOutput(msg)      { logTimed(">> " + msg) }
function onInput(msg)       { logTimed("<< "+msg) }
function onError(code, msg) { log("An error occured: "+msg); }

function onConnect(remoteAddress)
{
    log("Connected to "+remoteAddress);

    connectTime = Date.now();

    // Now that we're connected, make sure we reset retryCount if the connection lasts for longer
    // than say.. a minute
    retryResetTimer = setTimeout(function ()
    {
        debug("Resetting retryCount to 0");
        retryResetTimer = null;
        retryCount = 0;
    }, 60000);

    callCommandHooks("register", arguments);
}

function onRegister(nickname)
{
    log("Registered with \""+nickname+"\"");

    for (var p in conf.channels)
        client.joinChannel(conf.channels[p]);

    callCommandHooks("register", arguments);
}

function onUserList(channel, names)
{
    callCommandHooks("userList", arguments);
}

function onUserUpdate(nickname, type, newname, channel, message)
{
    if (type == "nickchange")
        log("Nick change: "+nickname+" to "+newname);
    else if (type == "join")
        log("Join: "+nickname+" joined "+channel);
    else if (type == "part")
        log("Part: "+nickname+" left "+channel+" msg: "+message);
    else if (type == "kick")
        log("Kicked: "+nickname+" from "+channel+" reason: "+message);
    else if (type == "quit")
        log("Quit: "+nickname+" quit, msg: "+message);

    callCommandHooks("userUpdate", arguments);
}

function onDisconnect(error, message)
{
    // Stop any retryResetTimer if one is active
    if (retryResetTimer)
    {
        clearTimeout(retryResetTimer);
        retryResetTimer = null;
    }

    if (error)
    {
        // Wait 20 seconds longer for each consecutive attempt, clamp to 300 (5 minutes);
        var timeWait = (retryCount * 20) > 80 ? 80 : (retryCount * 20);

        log("Disconnected due to error: " + error + ", " + message);
        log("Will try to reconnect in "+timeWait+" seconds");

        retryTimer = setTimeout(function ()
        {
            retryTimer = null;
            client.connect(conf.host, conf.port);
        },
        timeWait*1000);

        retryCount++;
    }
    else
        log("Disconnected.");

    callCommandHooks("disconnect", arguments);

    // Now is a good time to save data, even if we're going to reconnect
    saveData();
}

function onChannelMessage(channel, sender, message)
{
    var pcmd;

    if (pcmd = parseCommand(message))
    {
        var origin = { name: sender.name, user: sender.user, host: sender.host, channel: channel };
        runCommand(pcmd, origin);
    }

    callCommandHooks("channelMessage", arguments);
}

function onPrivateMessage(sender, message)
{
    var pcmd;

    if (pcmd = parseCommand(message))
    {
        var origin = { name: sender.name, user: sender.user, host: sender.host, channel: null };
        runCommand(pcmd, origin);
    }

    callCommandHooks("privateMessage", arguments);
}




// Command processing //////////////////////////////////////////////////////////////////////////////

var command_regex = new RegExp("^"+getEscapedCmdPrefix()+
                               "([a-z0-9]+)(?:\\s+((?:\\s*[^\\s]+)+))?\\s*$", "i");

// Return a parsed command object with the properties name (string), args (array), and
// raw_args (string) if the message passed was a valid command, else null is returned.
function parseCommand(msg)
{
    var pcmd = { name: null, args: null, rawArgs: null };

    // Extract command and argstring stripped of whitespace
    //var matches = /^!([a-z0-9]+)(?:\s+((?:\s*[^\s]+)+))?\s*$/i.exec(msg);
    var matches = command_regex.exec(msg);

    if (matches)
    {
        pcmd.name = matches[1];

        if (matches[2])
        {
            pcmd.rawArgs = matches[2];
            pcmd.args = pcmd.rawArgs.match(/[^ ]+/g)
        }

        return pcmd;
    }

    return null;
}


// Invoke handler for parsed command, if there is one..
function runCommand(pcmd, origin)
{
    var command = commands[pcmd.name];

    if (command)
    {
        var ctx = new CommandContext(command, origin, pcmd.name, pcmd.rawArgs);

        try
        {
            command.handler.apply(ctx, pcmd.args);
        }
        catch(err)
        {
            log("Failed to (completely) execute command:");
            log(err.stack);
            ctx.reply("Error while executing command, someone repair me :(");
        }
    }
    else
        log("Unknown command: "+pcmd.name);
}


// The context commands handlers are run in, this way command handlers don't have to pass the
// relevant data around as parameters to the utility functions, but instead they can just do things
// like this.reply("moo"), and it will do the right thing.
function CommandContext(command, origin, name, rawArgs)
{
    this.command = command;
    this.origin  = origin;
    this.name    = name;
    this.rawArgs = rawArgs;
}

// Other things that are not directly related to command input, but should be reachable
// XXX: Consider putting these in the constructor? makes more sense, even if it means I have a bunch
// more assignments every time a command is invoked.
CommandContext.prototype.version     = version;
CommandContext.prototype.getData     = getData;
CommandContext.prototype.saveData    = saveData;
CommandContext.prototype.client      = client;
CommandContext.prototype.conf        = conf;
CommandContext.prototype.commands    = commands;
CommandContext.prototype.data        = data;


// Write log message for command
CommandContext.prototype.log = function (message)
{
    log(this.name+": "+message);
}


// Add given piglevel to sender of message to punish for incorrect usage. If amount2 is given as
// well, a random number between amount and amount2 will be picked.
CommandContext.prototype.punish = function (reason, amount, amount2)
{
    if (this.origin.name)
    {
        // FIXME: use a per-nick cooldown to prevent abuse
        if (amount2 != null)
            amount = Math.floor(amount+((amount2-amount)*Math.random()));

        var name = this.client.lowerCase(this.origin.name);

        var pigData = getData("pig");

        pigData[name] = (pigData[name] || 0) + amount;

        if (amount > 0)
            this.reply(reason + ", level of pig increased by " + amount);
        else
            this.reply(reason + ", level of pig decreased by " + Math.abs(amount));
    }
}


// Sends message to either channel or nickname depending on origin
CommandContext.prototype.reply = function (message)
{
    if (this.origin.channel)
        client.sendToChannel(this.origin.channel, message);
    else if (this.origin.name)
        client.sendToNickname(this.origin.name, message);
    else
        log("reply: "+message);
}


// Sends message to sender privately even it it originated on a channel
CommandContext.prototype.replyPrivately = function (message)
{
    if (this.origin.name)
        client.sendToNickname(this.origin.name, message);
    else
        log("replyPrivately: "+message);
}


// Returns true of origin is trusted
CommandContext.prototype.isFromTrusted = function ()
{
    var match = false;
    var fromHost = this.origin.host;

    if (this.origin.fromConsole) return true;

    if (fromHost)
    {
        function testHost(host) { if (host && host == fromHost) return true; }

        return conf.trusted_hosts.some(testHost);
    }

    return match;
}

// Return object with timestamps for when we started up, and when we most recently connected.
// XXX: There must be a nicer way to expose these to commands..
CommandContext.prototype.getTimes = function ()
{
    return { connectTime: connectTime, startTime: startTime };
}


