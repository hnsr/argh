

var util   = require("util");
var events = require("events");
var net    = require("net");
var codes  = require("./irccodes");

var debuggingEnabled = true;

function warning (msg) { console.log("WARNING: irc: "+msg) }
function error   (msg) { console.log("ERROR: irc: "+msg) }
function debug   (msg) { if (debuggingEnabled) console.log("DEBUG: irc: "+msg) }


function Client(options)
{
    events.EventEmitter.call(this); // Parent constructor

    options = options || {};

    // How long to wait for critical operation (i.e. QUIT) to complete.
    this.timeout = options.timeout || 10000;

    this.encoding     = options.encoding     || "utf8";
    this.username     = options.username     || "unknown";
    this.realname     = options.realname     || "unknown";
    this.password     = options.password     || null;
    this.burstCount   = options.burstCount   || 3;
    this.burstPeriod  = options.burstPeriod  || 3000;
    this.pingInterval = options.pingInterval || 120000;
    this.nicks        = options.nicks; // TODO: throw exception if not given?

    this._init();
}

util.inherits(Client, events.EventEmitter);


// Initialize client, restores everything back to a disconnected state. Should only be called in
// constructor and after socket has been closed.
Client.prototype._init = function ()
{
    // State indicates what state our connection is in, it goes from:
    //
    //   disconnected -> connected -> registered -> disconnected_wait -> disconnected
    //
    // The disconnected_wait state is entered when disconnect() is called, and has the effect that
    // the socket close event will be expected. After the socket is closed, all client state is
    // reset and state will be 'disconnected' again.
    this.state = "disconnected";

    // How many nicknames in nicks we've tried to register with
    this._nicks_tried  = 0;

    // Nickname we ended up registering with (or have changed to)
    this.nickname = null;

    // Set when a disconnect timeout timer is running (see disconnect())
    this._disconnectTimer = null;

    // Used to send a PING after some time of inactivity, gets cleared/reassigned when a message is
    // received.
    if (this._pingTimer)
        clearTimeout(this._pingTimer);

    this._pingTimer = null;

    // This is an object with arrays of names, indexed by channel name. This is used to gather up
    // the names received from RPL_NAMREPLY after joining a channel (or after requesting them)
    // once RPL_ENDOFNAMES is received they are sent off in one go through the "names" event.
    this._names = {};

    // In the disconnected_wait state, these are set if the disconnect was triggered due to some
    // error. If _error is set, _message MUST be set as well (to an empty string if you have to).
    this._disconnect_error = null;
    this._disconnect_message = null;

    // Things extracted from 005 (ISUPPORT) message
    this._support = {};

    // Ratelimiting stuff. these arrays hold recorded timestamps and queued messages when
    // ratelimiting is active.
    this._msgTimestamps = []; // FIFO, first elem is oldest sent, last elem is most recent sent.
                              // Only holds burstCount elements.
    this._msgQueue = []; // FIFO, new messages are pushed onto the end

    // msgQueueCheckTimer references the timer used to take items off the queue at the earliest
    // opportunity
    if (this._msgQueueCheckTimer)
        clearTimeout(this._msgQueueCheckTimer);

    this._msgQueueCheckTimer = null;
}

// Get a message off the queue and send it
function msgQueueCheck(self)
{
    if (self._msgQueue.length < 1)
    {
        warning("_msgQueueCheck called but nothing on the queue..");
        return;
    }

    self._sendDirect(self._msgQueue.shift());

    // If there are additional messages, process as many as possible until another delay is needed.
    while (self._msgQueue.length)
    {
        var delay = self._msgDelayNeeded();

        if (!delay)
            self._sendDirect(self._msgQueue.shift());
        else
        {
            // Next message needs to be delayed, call ourselfes again later and exit..
            self._msgQueueCheckTimer = setTimeout(function () { msgQueueCheck(self); }, delay);
            return;
        }
    }

    // No more messages to be processed, clear timeout ID and everything goes back to normal
    self._msgQueueCheckTimer = null;
}


// If the next message needs to be delayed, return amount of delay needed, else false.
Client.prototype._msgDelayNeeded = function ()
{
    var now = Date.now();

    // If we've sent burstCount messages AND if the time delta since last tracked message would
    // be within burstPeriod, delay
    if (this._msgTimestamps.length >= this.burstCount &&
        (now - this._msgTimestamps[0]) <= this.burstPeriod)
    {
        return this.burstPeriod - (now - this._msgTimestamps[0]);
    }
    else
        return false
}


// Send message to server, first argument must be command, after which additional arguments can be
// given. If there is an argument with whitespace, it *must* be the last argument given.
Client.prototype.send = function ()
{
    if (arguments.length < 1)
    {
        warning("send: not enough parameters");
        return;
    }
    else if (this.state == "disconnected" || this.state == "disconnected_wait")
    {
        warning("send: tried to send while "+this.state);
        return;
    }

    var msg = arguments[0];

    for (var i = 1; i < arguments.length; i++)
    {
        if (i != arguments.length-1)
            msg += " "+arguments[i];
        else
            msg += " :" + arguments[i];
    }

    // Reject messages that are too long, functions higher up in the chain can do smarter things
    // like truncating argumantes, if appropiate
    if (msg.length > 510)
    {
        warning("rejected message for being too long (>510): "+msg);
        return;
    }

    var delay;

    if (this._msgQueueCheckTimer)
    {
        // Queue already active, just add to it
        this._msgQueue.push(msg);
    }
    else if (delay = this._msgDelayNeeded())
    {
        var self = this;
        // Queue not active yet, but need to start queueing messages
        this._msgQueue.push(msg);
        this._msgQueueCheckTimer = setTimeout(function () { msgQueueCheck(self); }, delay);
    }
    else
        this._sendDirect(msg);
}


// Actually send the raw message over the socket, msg should be unterminated
Client.prototype._sendDirect = function (msg)
{
    // Remove \r and \n from outgoing messages to prevent injection-type attacks
    msg = msg.replace(/(\r|\n)/g, '');

    this._sock.write(msg+"\r\n", this.encoding);

    // Record timestamp for this message for ratelimiting code
    if (this._msgTimestamps.length >= this.burstCount)
        // Remove oldest timestamp unless msgTimestamps wasn't filled yet
        this._msgTimestamps.shift();

    this._msgTimestamps.push(Date.now());

    this.emit("output", msg);
}


// Send request to register ourselfes with the server. When the server tells us our nickname is in
// use, this function can be called again, and it will use the next nickname in this.nicks. Once all
// have been tried an error will be emitted and the connection will be severed (resulting in a
// disconnect event).
Client.prototype._register = function ()
{
    if (this.nicks.length && this._nicks_tried >= this.nicks.length)
    {
        this.disconnect(null, "out_of_nicknames", "failed to register, no more nicknames to try");
    }

    if (this.password)
        this.send("PASS", this.password);

    this.send("NICK", this.nicks[this._nicks_tried]);

    // Only send USER on our first register attempt
    if (this._nicks_tried == 0)
        this.send("USER", this.username, "*", "*", this.realname);

    this._nicks_tried++;
}



// Connect to IRC server, Client must be in a disconnected state. When an initial connection is
// established, the connect event is emitted. After succesfully registering the register event is
// emitted. Only after the register event is emitted other functions can be called (which the
// exception of disconnect(), which can be called immediately after the connect event is fired.)
// If either connecting fails, or registering fails, an error event will be fired, followed by the
// disconnect event.
Client.prototype.connect = function (host, port)
{
    var self = this;

    if (self.state != "disconnected")
    {
    // might want to disconnect here first and then reconnect? (MN: 2012-03-08)
        warning("can't connect when already connected");
        return;
    }

    var sock = new net.createConnection(port ? port : 6667, host);

    self._sock = sock;

    sock.setEncoding(self.encoding);

    sock.on("connect", function ()
    {
        self.localAddress  = this.localAddress;
        self.localPort     = this.localPort;
        self.remoteAddress = this.remoteAddress;
        self.remotePort    = this.remotePort;
        self.state = "connected";
        self.emit("connect",
            this.remoteAddress,
            this.remotePort,
            this.localAddress,
            this.localPort
        );
        self._register();
    });

    var leftover = null;

    sock.on("data", function (data)
    {
        var msg;

        // When large amounts of data is being received, it can sometimes be split over multiple
        // data events, potentially splitting lines in the middle. I can detect this eventuality by
        // looking for a non-empty final element in 'lines' (since I am splitting on line
        // terminators). I'll save the partial message (leftover) so that it can be prepended to the
        // next data chunk

        if (leftover && data.length > 0)
        {
            data = leftover + data;
            leftover = null;
        }

        var lines = data.split(/\r\n/);

        for (var i = 0; i < lines.length-1; i++)
        {
            // Send a PING after pingInterval ms has passed since last message. This helps with
            // detecting broken connections. Eventually I think I might want to actually check for a
            // PONG, in case the other end has dissappeared for too long (and we dont get a RST)
            if (self._pingTimer) clearTimeout(self._pingTimer);

            self._pingTimer = setTimeout(function ()
            {
                self._pingTimer = null;
                self.send("PING", self.nickname);

            }, self.pingInterval);

            self.emit("input", lines[i]);
            self._dispatchMessage(lines[i]);
        }

        // Ensure we store unterminated lines for later.
        if (lines[lines.length-1] !== "")
        {
            // Just append if leftover already set
            leftover = leftover || "";
            leftover += lines[lines.length-1];
        }
    });

    sock.on("end", function ()
    {
        // This is fired when other end closes connection, before 'close'. This is only expected if
        // we're in the process of disconnecting (= QUIT has been sent).
        if (self.state != "disconnected_wait")
        {
            self._disconnect_error = "remote_closed";
            self._disconnect_message = "remote end closed connection";
        }
    });

    sock.on("error", function (exception)
    {
        // A 'close' event will follow after this.
        self._disconnect_error = "socket_error";
        self._disconnect_message = exception.message;
    });

    sock.on("close", function (hadError)
    {
        var error = null, message = null;

        // Stop disconnect timeout timer if it was running
        if (self._disconnectTimer)
        {
            clearTimeout(self._disconnectTimer);
            self._disconnectTimer = null;
        }

        // If we were waiting for a socket close (due to disconnect() being called), assume
        // error/message are set correctly, if we weren't awaiting a socket close, make sure we
        // report any error/messag set by possibly the socket error event (maybe other things in the
        // future?) or otherwise fallback to a default error.
        if (self.state == "disconnected_wait")
        {
            error = self._disconnect_error;
            message = self._disconnect_message;
        }
        else
        {
            error = self._disconnect_error || "socket_closed";
            message = self._disconnect_message || "connection closed unexpectedly";
        }

        self._init();
        self.emit("disconnect", error, message);
    });
}


// Disconnect from the server with given message. This can also be called internally for some error
// conditions, in which case error/error_message will be set so that the 'disconnect' event can
// inform the user what happened.
Client.prototype.disconnect = function (message, error, error_message)
{
    var self = this;

    if (self.state == "disconnected" || self.state == "disconnected_wait")
    {
        warning("disconnect() called while not connected/already disconnecting");
        return;
    }

    // Send QUIT message, and set a timer to forcibly break the connection when a timeout has been
    // reached.
    message = message || "";

    self.send("QUIT", message);
    self.state = "disconnected_wait";
    self._disconnect_error = error || null;
    self._disconnect_message = error_message || null;

    // After some period, I should check if the connection has been broken yet in response to QUIT,
    // and if it hasn't, forcibly disconnect the socket.
    self._disconnectTimer = setTimeout(function ()
    {
        warning("timeout reached after trying to quit");

        self._disconnectTimer = null;
        self._sock.end(); // FIXME: What does this actually do if the other end has really gone?

    }, self.timeout);
}


// Send request to join a channel
Client.prototype.joinChannel = function (name, key)
{
    if (name && key) this.send("JOIN", name, key);
    else if (name)   this.send("JOIN", name);
}


// Send request to join a channel
Client.prototype.leaveChannel = function (name, message)
{
    if (name && message) this.send("PART", name, message);
    else if (name)   this.send("PART", name);
}


Client.prototype.sendToChannel = function (channel, message)
{
    // Check for valid channelname
    if (this.isChannelName(channel) && message)
        this.send("PRIVMSG", channel, message);
    else
        warning("sendToChannel: invalid channel name or message");
}


Client.prototype.sendToNickname = function (nick, message)
{
    // TODO: Check for valid nickname
    if (message)
        this.send("PRIVMSG", nick, message);
    else
        warning("sendToNickname: invalid name or message");
}



// Lower-case a string according to IRC rules, this behaves differently depending on CASEMAPPING
// value.
Client.prototype.lowerCase = function (str)
{
    // Do normal lower casing first, then RFC1459 lower casing if needed
    var lowered = str.toLowerCase();

    if (this._support.CASEMAPPING == "ascii")
    {
        return lowered;
    }
    else if (this._support.CASEMAPPING == "strict-rfc1459")
    {
        // Strict interpretation of rfc1459, which forgot to mention ~ and ^
        var rep = { "[":"{",  "]":"}",  "\\":"|" };
        lowered = lowered.replace(/[\[\]\\]/g, function (match) { return rep[match] } );
    }
    else // rfc1459, also the default method
    {
        var rep = { "[":"{",  "]":"}",  "\\":"|",  "~":"^" };
        lowered = lowered.replace(/[\[\]\\~]/g, function (match) { return rep[match] } );
    }

    return lowered;
}


// Compare two strings in a case-insensitive manner using IRC rules (see RFC 2812 section 2.2)
Client.prototype.compareName = function (str1, str2)
{
    if (!str1 || !str2) return false;

    return this.lowerCase(str1) == this.lowerCase(str2);
}


// Returns true if given string is a valid channelname
Client.prototype.isChannelName = function (name)
{
    // Simple channel regexp
    // FIXME maybe account for "!channelid" prefix, or ":chanstring" affix, which I've never seen used
    var channel_regexp = /^[#&+][^\x07 ,:]+$/;

    // FIXME: allow only channel prefixes indicated in RPL_ISUPPORT
    return channel_regexp.test(name);
}



// Message handling, the handlers are called with 'this' referring to the irc.Client object. If no
// handler is registered for some command, defaultHandler is called, which currently does nothing
var handlers = {};


handlers["JOIN"] = function (msg)
{
    var prefix = parsePrefix(msg.prefix);
    var channel = msg.args[0];

    if (prefix && this.isChannelName(channel))
        this.emit("userUpdate", prefix.name, "join", null, channel, null);
    else
        warning("malformed JOIN: "+msg.raw);
}

handlers["NICK"] = function (msg)
{
    var prefix = parsePrefix(msg.prefix);
    var newName = msg.args[0];

    if (prefix && newName) // XXX: check for valid nickname? I'm screwed anyway if the server sends
                           // something invalid..
    {
        if (this.compareName(prefix.name, this.nickname))
            this.nickname = newName;

        this.emit("userUpdate", prefix.name, "nickchange", newName, null, null);
    }
    else
        warning("malformed NICK: "+msg.raw);
}

handlers["PART"] = function (msg)
{
    var prefix = parsePrefix(msg.prefix);
    var channel = msg.args[0];
    var message = msg.args[1];

    if (prefix && channel)
        this.emit("userUpdate", prefix.name, "part", null, channel, message);
    else
        warning("malformed PART: "+msg.raw);
}

handlers["KICK"] = function (msg)
{
    var prefix = parsePrefix(msg.prefix); // prefix of kicker
    var channel  = msg.args[0];
    var nickname = msg.args[1]; // nickname of kicked user
    var message  = msg.args[2];

    if (prefix && channel && nickname)
        this.emit("userUpdate", nickname, "kick", prefix.name, channel, message);
    else
        warning("malformed PART: "+msg.raw);
}

handlers["QUIT"] = function (msg)
{
    var prefix = parsePrefix(msg.prefix);
    var message = msg.args[0];

    if (prefix)
    {
        if (this.compareName(prefix.name, this.nickname))
            ; // XXX: does this ever occur?
        else
            this.emit("userUpdate", prefix.name, "quit", null, null, message);
    }
    else
        warning("malformed QUIT: "+msg.raw);
}

handlers[codes.RPL_ENDOFNAMES] = function (msg)
{
    var channel = msg.args[1];

    if (this.isChannelName(channel))
    {
        if (this._names[channel])
        {
            this.emit("userList", channel, this._names[channel]);
            this._names[channel] = null;
        }
        else
            warning("spurious RPL_ENDOFNAMES for channel " + channel);
    }
    else
        warning("malformed RPL_ENDOFNAMES: " + msg.raw);
}


handlers[codes.RPL_NAMREPLY] = function (msg)
{
    var channel = msg.args[2]; // XXX: Is this arg 2 on all servers? RFC suggest no space should be
                               // after = / * / @
    if (this.isChannelName(channel))
    {
        // Init new names array if needed
        this._names[channel] = (this._names[channel] || []);

        // Parse out names (while stripping off channel status) into array and concat to existing
        // one.
        var split_names = msg.args[3].trim().replace(/@|\+/g, '').split(/ +/);

        this._names[channel] = this._names[channel].concat(split_names);
    }
    else
        warning("malformed RPL_NAMREPLY: "+msg.raw);

}


handlers["PING"] = function (msg)
{
    // The RFC is unclear on what I should send back as a client, but xchat does it this way, so
    // I'll do the same !
    this.send("PONG", msg.args[0] || null);
}


handlers["PRIVMSG"] = function (msg)
{
    var prefix = parsePrefix(msg.prefix);

    if (prefix && msg.args.length == 2)
    {
        // Message to a channel
        // XXX: Should maybe check if I actually am on this channel, to prevent spurious
        // channelMessage events
        if (this.isChannelName(msg.args[0]))
        {
            var channel = msg.args[0], sender = prefix, message = msg.args[1];
            this.emit("channelMessage", channel, sender, message);
            return;
        }
        // Message for us if first arg == this.nickname
        else if (this.compareName(this.nickname, msg.args[0]))
        {
            var sender = prefix, message = msg.args[1];
            this.emit("privateMessage", sender, message);
            return;
        }
        debug("PRIVMSG: couldn't process \""+msg.raw+"\"");
    }
    else
        warning("malformed PRIVMSG: "+msg.raw);
}


handlers[codes.RPL_WELCOME] = function (msg)
{
    this.state = "registered";
    this.emit("register", msg.args[0]);
    this.nickname = msg.args[0];
}


handlers[codes.RPL_ISUPPORT] = function (msg)
{
    var matches;
    // See http://www.irc.org/tech_docs/005.html

    // Parse just the things I need, could make this more generic if I ever need to parse more than
    // just a handful of things
    if (matches = /CASEMAPPING=(ascii|rfc1459|strict-rfc1459)(?: +|$)/.exec(msg.raw))
    {
        this._support.CASEMAPPING = matches[1];
    }
}

// Handle nick in use error
handlers[codes.ERR_NICKNAMEINUSE] = function (msg)
{
    warning("nickname in use, trying again with next");
    this._register();
}

// Handle banned from channel error
handlers[codes.ERR_BANNEDFROMCHAN] = function(msg)
{
    // Adding timer to try to join channel every minute
    var thisRef = this;

    setTimeout(function () { thisRef.joinChannel(msg.args[1]) }, 60000);
}


function defaultHandler(msg) { }


// Parse and call handler for raw_message
Client.prototype._dispatchMessage = function (raw_message)
{
    var msg;

    if (msg = parseMessage(raw_message))
    {
        (handlers[msg.command] || defaultHandler).call(this, msg);
    }
}



// Message parsing:
//
// http://irchelp.org/irchelp/rfc/chapter2.html#c2_3
// http://www.mirc.com/rfc2812.html


// Return a string indicating the type of message, returns one of "command", "command_response",
// "error_response" or false if the type could not be determined.
function messageType(msg)
{
    // Determine the class of message. A message can be a normal command (PING, JOIN, etc), a
    // command response (RPL_WELCOME, RPL_LIST), or an error response (ERR_NOSUCHNICK,
    // ERR_UNKNOWNCOMMAND). Normal commands consists of letters, responses are indicated by three
    // digits (001, 002 etc). Command responses have digits in the range of 001-099 (client-server
    // only), or in the range of 200-399. Error responses are in the range of 400-599.

    if (/^[a-zA-Z]+$/.test(msg.command))
        return "command";

    if (/^[0-9]{3}$/.test(msg.command))
    {
        var num = parseInt(msg.command, 10);

        if (num > 0 && num < 100) // client-server only
            return "command_response";

        if (num > 199 && num < 400)
            return "command_response";

        if (num > 399 && num < 600)
            return "error_response";
    }

    return false;
}



// Prefix can either be a simple hostname or one of the following forms:
//   nickname
//   nickname@host
//   nickname!user@host
//
// nickname may consist of letters, digits, hyphens and specials: - [ ] \ ` ^ { } _ |
//   ^ first character may not be a hyphen or digit
// user may consist of anything except NUL, CR, LF, " " and "@"
// host can be a simple hostname, or an ipv4/6 address - however networks like freenode use other
// things in the host part, so I'm not going to be strict about it,

// FIXME: not correct, considers "foo.bar-" valid, should match each label like
// [aplhanum]+ | [alphanum]+ [alphanum-]+ [alphanum]+
var prefix_hostname_regexp = /^([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)*)$/;

//var prefix_tuple_regexp = /^([a-zA-Z`\[\]\{\}_|][a-zA-Z0-9-`\[\]\{\}_|]+)(?:(?:!([^\0\r\n @]+))?@([^ ]+))?$/;
//                          ^nickname----------------------------------         ^user---------   ^host

var prefix_tuple_regexp = /^([\^`a-zA-Z\[\]\{\}_|][\^`a-zA-Z0-9-\[\]\{\}_|]*)(?:(?:!([^\0\r\n @]+))?@([^ ]+))?$/;
//                          ^nickname------------------------------------       ^user---------   ^host

// Returns an object with the fields 'name', 'user', and 'host', where
// user and host are optional and may be null. If the prefix given is malformed, null is
// returned instead of an object. Note that when only 'name' is set, this could refer to either a
// servername, or a nickname. When other fields are set, name always refers to a nickname. This last
// bit is unfortunate, but a hostname can also be a valid nickname if I interpret the RFC's syntax
// correctly.
function parsePrefix(prefix)
{
    // Try to match a nickname/user/host tuple first, it's possible a servername that consists of
    // just one word to match as nickname.
    var matches;

    if (matches = prefix_tuple_regexp.exec(prefix))
        return { name: matches[1], user: matches[2] || null, host: matches[3] || null };

    // XXX: Maybe the context (i.e. which command) is meant to indicate wether the prefix is a
    // hostname or a nick/user/host tuple. If this is true, I should add a boolean param that
    // indicates what we're attempting to parse.. I can then return null when appropriate.

    if (matches = prefix_hostname_regexp.exec(prefix))
        return { name: matches[1], user: null, host: null };

    warning("parsePrefix: invalid prefix: "+prefix);

    return null;
}


var message_regexp = /^(?::([^ ]+) )?([a-zA-Z]+|[0-9]{3})((?: [^\0\r\n: ][^\0\r\n ]*)+)?(?: :(.+))?$/;
//                         ^prefix   ^cmd----------------^args-------------------------      ^trailing
//     ^ if this regex ever turns out to be incorrect: FUUUUUUUUUUUUUUUUUUUUUUUU


// Parse an IRC message. Returns an object with the fields 'prefix', 'command', and 'args' where
// prefix can be null if no prefix was given, command is a string indicating the IRC command, and
// args is a table with command arguments or null if no arguments were given. parseMessage will
// return null if the message couldn't be parsed.
function parseMessage(msg)
{
    // Since it's not possible to capture all matches of a repeating subpattern, I pull out all the
    // args as a string and simply split them by the sepearating spaces.
    var matches = message_regexp.exec(msg);

    if (matches)
    {
        var prefix = null, command = null, args = null, trailing;

        command = matches[2]; // regex ensures command is given

        if (matches[1]) prefix   = matches[1];
        if (matches[3]) args     = matches[3];
        if (matches[4]) trailing = matches[4];

        // Split args and add trailing if any arguments were given.
        if (args || trailing)
        {
            if (args)
                args = args.substr(1).split(/ +/); // substr(1) to remove leading space
            else
                args = [];

            if (trailing)
                args.push(trailing);
        }

        return { "prefix": prefix, "command": command, "args": args, "raw": msg };
    }
    else
        warning("parseMessage: ignoring malformed message: \""+msg+"\"");

    return null;
}


exports.Client       = Client;
exports.messageType  = messageType;
exports.parsePrefix  = parsePrefix;
exports.parseMessage = parseMessage;

