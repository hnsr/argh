#!/usr/bin/env node

var vm       = require("vm");
var fs       = require("fs");
var util     = require("util");
var repl     = require("repl");
GLOBAL.modules  = new Array;//  = require("./modules.js");
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

var moduleHooks;  // Object with for each 'event' an array of objects specifying a handler function
                   // and a context to invoke that handler function with, for each module hooking
                   // into that event.
var moduleCommands; // Object for all commands possible
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
loadModules(false);
initHooks();
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

//client.connect(conf.host, conf.port);

// Setup a module prompt that can be used to give modules, and in emergencies can also eval code
// in this file's local scope to fix things on the fly:
var prompt = repl.start("> ");

log(""); // Prevent first log message ending up behind prompt

prompt.context.run = function (cmd) {
    var pcmd;

    if (pcmd = parseModule(cmd))
    {
        var origin = { fromConsole: true };
        runCommand(pcmd, origin);
    }
}
prompt.context.eval = function (code) {
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

// Returns unicode-escaped module prefix character for safe use in RegExp string, i.e "\\u005c"
function getEscapedCmdPrefix() {
    // Just take the first character and turn it into a unicode escape sequence
    var prefix = conf.module_prefix.charCodeAt(0);
    var prefixHex = prefix.toString(16);

    if (prefixHex.length > 0 && prefixHex.length < 5)
    {
        // Add leading zeroes if needed
        var numZeroes = 4-prefixHex.length;
        for (var i = 0; i < numZeroes; i++) prefixHex = "0" + prefixHex;

        return "\\u" + prefixHex;
    }
    else
        error("module_prefix setting is invalid");
}

// Load and parse json from file at given path, returns false on failure, else the parsed data.
function loadJSON(path) {
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
function saveJSON(path, outData) {
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
function loadConfig() {
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
function mkdir(path, mode) {
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
function checkConfDirs() {
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
function loadData() {
    var files = fs.readdirSync(confPrefix+"/data");
    data = {};

    // Load each file as JSON and exit if we fail; to prevent modules losing their data by
    // overwriting it with an empty data object.
    files.forEach(function (file)
    {
        var matches = /^([a-zA-Z0-9]+)\.js$/.exec(file);

        if (matches)
        {
            var fileBase = matches[1];

            log("Loading data for module '"+fileBase+"'");

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
function saveData() {
    log("Saving data");

    // Loop over data array, save each element to file, make sure that key has no funny
    // characters in it (just /[a-z0-9]+/i)
    for (var file in data)
    {
        var fileData = data[file];
        if (fileData && /^[a-zA-Z0-9]+$/.test(file))
        {
            if (!saveJSON(confPrefix+"/data/"+file+".js", fileData))
                warning("failed to save data for module: "+file);
        }
        else
            waning("Not saving data for "+file+" (no data or invalid format)");
    }
}

// Returns a handle to a data object (and creates one if needed), returns null on error.
function getData(name) {
    if (!name) return null;

    return (data[name] = data[name] || {});
}

// Load modules from directory
function loadModules(clear) {
    if (clear) {
        modules = null;
        moduleHooks = null;
        delete( require.cache )
    }
    
    var moduleFiles = fs.readdirSync('./modules');
    //var moduleData = '';
    for (fileName in moduleFiles) {
        var moduleData = fs.readFileSync('./modules/' + moduleFiles[fileName], encoding='utf8');
        modules.push(vm.runInThisContext(moduleData));
    }
    //var modData = fs.readFileSync('./modules/pig.js', encoding='utf8');
    modules.push(vm.runInThisContext(moduleData));
};

// Initialize hooks, for now, it adds entries to moduleHooks
function initHooks()
{
    moduleHooks = {};
    
    // For every module, check if it has hooks, if so, loop over its hooks and add them to
    // moduleHooks, along with ModuleContext used when the hook handler function is invoked.
    for (var cmd in modules)
    {
        if (modules[cmd].hooks) {
            for (var p in modules[cmd].hooks)
            {
                // Add entry to array for this event, initialize array first if needed.
                if (!moduleHooks[p]) moduleHooks[p] = [];
                var context = new ModuleContext(modules[cmd], null, cmd, null);
                moduleHooks[p].push({ context: context, handler: modules[cmd].hooks[p] });
            }
        }
    }
    // I can remove a module from moduleHooks by iterating over a module's hooks object, then for
    // each hook, scan moduleHooks[hookEvent] to find matching handler, then remove it?
};

// Initialize Commands within the modules
function initCommands() {
    moduleCommands = new Array();
    for (var mod in modules) {
        if (modules[mod].commands) {
            for (var cmd in modules[mod].commands) {
                if (!moduleCommands[cmd]) moduleCommands[cmd] = [];
                var context = new ModuleContext(modules[mod], null, cmd, null);
                debug('ADDED CMD: ' + cmd + ' with code: ');
                dump(modules[mod].commands[cmd]);
                moduleCommands[cmd].push({context: context, handler: modules[mod].commands[cmd] });
            }
        }
    }
};

// Call all registered module hooks for event 'name', passing args as arguments
function callModuleHooks(name, args)
{
    for (var p in moduleHooks[name])
    {
        var hook = moduleHooks[name][p];

        try
        {
           if (hook.handler && hook.context)
                hook.handler.apply(hook.context, args);
        }
        catch(err)
        {
            // Add more info
            log("Failed to execute module hooks for event "+name);
            log(err.stack);
        }
    }
};


// irc.Client processing ///////////////////////////////////////////////////////////////////////////

function onOutput(msg)      { logTimed(">> " + msg) }
function onInput(msg)       { logTimed("<< "+msg) }
function onError(code, msg) { log("An error occured: "+msg); }

function onConnect(remoteAddress) {
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

    callModuleHooks("register", arguments);
}

function onRegister(nickname) {
    log("Registered with \""+nickname+"\"");

    for (var p in conf.channels)
        client.joinChannel(conf.channels[p]);

    callModuleHooks("register", arguments);
}

function onUserList(channel, names) {
    callModuleHooks("userList", arguments);
}

function onUserUpdate(nickname, type, newname, channel, message) {
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

    callModuleHooks("userUpdate", arguments);
}

function onDisconnect(error, message) {
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

    callModuleHooks("disconnect", arguments);

    // Now is a good time to save data, even if we're going to reconnect
    saveData();
}

function onChannelMessage(channel, sender, message)
{
    var pcmd;

    if (pcmd = parseModule(message))
    {
        var origin = { name: sender.name, user: sender.user, host: sender.host, channel: channel };
        runCommand(pcmd, origin);
    }

    callModuleHooks("channelMessage", arguments);
}

function onPrivateMessage(sender, message)
{
    var pcmd;

    if (pcmd = parseModule(message))
    {
        var origin = { name: sender.name, user: sender.user, host: sender.host, channel: null };
        runCommand(pcmd, origin);
    }

    callModuleHooks("privateMessage", arguments);
}




// module processing //////////////////////////////////////////////////////////////////////////////

var module_regex = new RegExp("^"+getEscapedCmdPrefix()+
                               "([a-z0-9]+)(?:\\s+((?:\\s*[^\\s]+)+))?\\s*$", "i");

// Return a parsed module object with the properties name (string), args (array), and
// raw_args (string) if the message passed was a valid module, else null is returned.
function parseModule(msg)
{
    var pcmd = { name: null, args: null, rawArgs: null };

    // Extract module and argstring stripped of whitespace
    //var matches = /^!([a-z0-9]+)(?:\s+((?:\s*[^\s]+)+))?\s*$/i.exec(msg);
    var matches = module_regex.exec(msg);

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
function runCommand(pcmd, origin) {
//dump(pcmd);
//dump(origin);

    var command = moduleCommands[pcmd.name];
debug('===================> ' + pcmd.name + ' <==============================');    
dump(command);
    //var command = modules[pcmd.name];

    if (command && command.handler)
    {
        var ctx = new ModuleContext(command, origin, pcmd.name, pcmd.rawArgs);

        try
        {
            command.handler.apply(ctx, pcmd.args);
        }
        catch(err)
        {
            log("Failed to (completely) execute module:");
            log(err.stack);
            ctx.reply("Error while executing module, someone repair me :(");
        }
    }
    else
        log("Unknown module: "+pcmd.name);
}


// The context modules handlers are run in, this way module handlers don't have to pass the
// relevant data around as parameters to the utility functions, but instead they can just do things
// like this.reply("moo"), and it will do the right thing.
function ModuleContext(module, origin, name, rawArgs)
{
    this.module = module;
    this.origin  = origin;
    this.name    = name;
    this.rawArgs = rawArgs;
}

// Other things that are not directly related to module input, but should be reachable
// XXX: Consider putting these in the constructor? makes more sense, even if it means I have a bunch
// more assignments every time a module is invoked.
ModuleContext.prototype.version     = version;
ModuleContext.prototype.getData     = getData;
ModuleContext.prototype.saveData    = saveData;
ModuleContext.prototype.client      = client;
ModuleContext.prototype.conf        = conf;
ModuleContext.prototype.modules    = modules;
ModuleContext.prototype.data        = data;


// Write log message for module
ModuleContext.prototype.log = function (message)
{
    log(this.name+": "+message);
}


// Add given piglevel to sender of message to punish for incorrect usage. If amount2 is given as
// well, a random number between amount and amount2 will be picked.
ModuleContext.prototype.punish = function (reason, amount, amount2)
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
ModuleContext.prototype.reply = function (message)
{
    if (this.origin.channel)
        client.sendToChannel(this.origin.channel, message);
    else if (this.origin.name)
        client.sendToNickname(this.origin.name, message);
    else
        log("reply: "+message);
}


// Sends message to sender privately even it it originated on a channel
ModuleContext.prototype.replyPrivately = function (message)
{
    if (this.origin.name)
        client.sendToNickname(this.origin.name, message);
    else
        log("replyPrivately: "+message);
}


// Returns true of origin is trusted
ModuleContext.prototype.isFromTrusted = function ()
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
// XXX: There must be a nicer way to expose these to modules..
ModuleContext.prototype.getTimes = function ()
{
    return { connectTime: connectTime, startTime: startTime };
}

// Reload the modules
ModuleContext.prototype.reloadModules = function() {

    loadModules();
    initModules();
    debug("Modules reloaded!");
}

function dump(arr,level) {
	var dumped_text = "";
	if(!level) level = 0;
	
	//The padding given at the beginning of the line.
	var level_padding = "";
	for(var j=0;j<level+1;j++) level_padding += "    ";
	
	if(typeof(arr) == 'object') { //Array/Hashes/Objects 
		for(var item in arr) {
			var value = arr[item];
			
			if(typeof(value) == 'object') { //If it is an array,
				dumped_text += level_padding + "'" + item + "' ...\n";
				dumped_text += dump(value,level+1);
			} else {
				dumped_text += level_padding + "'" + item + "' => \"" + value + "\"\n";
			}
		}
	} else { //Stings/Chars/Numbers etc.
		dumped_text = "===>"+arr+"<===("+typeof(arr)+")";
	}
	debug(dumped_text);
}
