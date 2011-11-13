var vm   = require("vm");
var util = require("util");

var commands = module.exports = {};


// Misc helper functions used by various commands

// Return friendly time string representing time passed since given timeMS, "2 days ago",
// "5 hours ago", "60 seconds ago" etc
function getFriendlyTime(timeMS, postfix)
{
    if (!postfix && postfix != "") postfix = " ago";

    // Calculate distance between time and Date.now() in seconds, then turn it into
    // something more friendly.
    var d = (Date.now()-timeMS)/1000;
    var week = 604800, day = 86400, hour = 3600;

    if (d > (week*2)) return Math.round(d/week)+" weeks"   + postfix;
    if (d > ( day*2)) return Math.round(d/day) +" days"    + postfix;
    if (d > (hour*2)) return Math.round(d/hour)+" hours"   + postfix;
    if (d > (  60*2)) return Math.round(d/60)  +" minutes" + postfix;
    return Math.round(d)+" seconds" + postfix;
}

commands["wipemsg"] =
{
    description: "delete any messages others left for you",
    handler: function ()
    {
        var recipient = this.client.lowerCase(this.origin.name);
        var data = this.getData("messages");

        if (data[recipient])
        {
            this.reply("deleted "+data[recipient].length+" messages");
            data[recipient] = undefined;
        }
        else
            this.punish("no messages to wipe!", 30, 46);
    }
}

// XXX: This command is very insecure, imposters can just take on someone else's nick to read
// his/her messages. There isn't a good way to make this (more) secure, other than specifying
// message recipient by hostname, which is annoying.. I could keep records of nicknames I've
// encountered along with hostnames and do something with that data, but also tricky and not
// foolproof..
commands["leavemsg"] =
{
    params: "<nickname> <message>",
    description: "leave a message for user. WARNING: don't use for private/critical stuff, its"+
                 " not very secure",

    // Reports any recorded messages for nickname, to nickname. Since this is called on various
    // events like joining channe, there is a risk of spamming nickname when he is on multiple
    // channels that I am on as well.. so I record a timestamp for when I last reported to nickname,
    // and make sure I don't spam nickname again within some period. I'll store these timestamps in
    // a temporary object, doesnt need to be stored persistently.
    sendMessages: function (nickname, data)
    {
        var messages = data && data[this.client.lowerCase(nickname)];

        // Make sure we don't spam messages more than once ever 60 seconds
        var lastTime = this.command.spamTimestamps[nickname];

        if (lastTime && (Date.now()-lastTime) < 60000)
            return;

        if (messages)
        {
            this.command.spamTimestamps[nickname] = Date.now();

            if (messages.length == 1)
            {
                var msg = messages[0];
                this.client.sendToNickname(nickname, msg.sender+
                    " ("+msg.senderHost+") left you the following message "+
                    getFriendlyTime(msg.time)+": "+ msg.message);
            }
            else if (messages.length > 1)
            {
                this.client.sendToNickname(nickname, "The following messages were left for you:");

                for (var m in messages)
                {
                    var msg = messages[m];
                    this.client.sendToNickname(nickname, "  by "+msg.sender+
                        " ("+msg.senderHost+"), "+ getFriendlyTime(msg.time)+": "+msg.message);
                }
            }
            this.client.sendToNickname(nickname, "use the '"+this.conf.command_prefix+
                "wipemsg' command to delete these messages");
        }
    },
    // Temporary storage for timestamps of when when we last spammed a user his/her messages
    spamTimestamps: {},
    hooks:
    {
        userUpdate: function (nickname, type, newName, channel, message)
        {
            var nickname = (type == "nickchange") ? newName : nickname;

            if ( type == "join" || type == "nickchange")
                this.command.sendMessages.call(this, nickname, this.getData("messages"));
        },
        userList: function (channel, names)
        {
            var data = this.getData("messages");

            if (!data || !names || !(names instanceof Array)) return;

            // Loop through names, if name has messages, send them
            for (var n in names)
            {
                this.command.sendMessages.call(this, names[n], data);
            }
        }
    },
    handler: function ()
    {
        var data = this.getData("messages");

        if (!data) return;

        // Parse out nickname + rest
        var matches = /^([\^`a-zA-Z\[\]\{\}_|][\^`a-zA-Z0-9-\[\]\{\}_|]*) (.*)$/.exec(this.rawArgs);

        // FIXME: when I ever implement user-tracking, refuse to record message if user is already
        //        present
        if (matches && matches[1] && matches[2])
        {
            var sender = this.origin.name;
            var host   = this.origin.host;
            var recipient = this.client.lowerCase(matches[1]);
            var message = matches[2];

            if (this.client.compareName(recipient, this.client.nickname))
            {
                this.reply("not recording messages for myself!");
                return;
            }

            if (sender && recipient && message)
            {
                data[recipient] = data[recipient] || []; // Initialize messages array if needed
                if (data[recipient].length < 3)
                {
                    data[recipient].push({ sender: sender, senderHost: host, message: message,
                                           time: Date.now() });
                    this.reply("message recorded");
                }
                else
                    this.reply("this user already has 3 or more messages to read, leave him/her alone!");
            }
        }
        else
            this.punish("failed to give me a nickname followed by message", 20, 60);
    }
}

// Not really a 'command', more like a trigger.
commands["youtube"] =
{
    hooks:
    {
        channelMessage: function (channel, sender, message)
        {
            // Do a simple check before using full regex.
            if (/youtu/.test(message))
            {
                var matches;
                if (matches = /(?:youtu.be\/|youtube\.com(?:\/watch)?\?v=)([^ &]+)/.exec(message))
                {
                    var http = require("http");
                    var self = this;

                    var options = {
                        host: "gdata.youtube.com",
                        path: "/feeds/api/videos/"+encodeURIComponent(matches[1])+"?alt=json&v=2"
                    };

                    http.get(options, function (res)
                    {
                        var dataJSON = "";

                        res.on("data", function (data) { dataJSON += data; });
                        res.on("end", function ()
                        {
                            try
                            {
                                var result = JSON.parse(dataJSON);
                                self.client.sendToChannel(channel, "title: "+result.entry.title.$t);
                            }
                            catch (e)
                            {
                                self.log("failed to parse youtube JSON response: "+e.message);
                            }
                        });
                    });
                }
            }
        }
    },
    handler: function ()
    {
    }
};

commands["google"] =
{
    params: "<query>",
    description: "list first result for query",
    handler: function (query)
    {
        var http = require("http");
        var self = this;

        if (!this.rawArgs)
        {
            this.punish("forgot to give search parameter", 20, 40);
            return;
        }

        var options =
        {
            host: "ajax.googleapis.com",
            path: "/ajax/services/search/web?v=1.0&rsz=1&q="+encodeURIComponent(this.rawArgs)
        };

        http.get(options, function (res)
        {
            var dataJSON = "";

            res.on("data", function (data)
            {
                dataJSON += data;
            });
            res.on("end", function ()
            {
                try
                {
                    var results = JSON.parse(dataJSON);

                    if (results.responseData.results.length > 0)
                        self.reply("top result for \""+self.rawArgs+"\": "+
                                   (results.responseData.results[0].unescapedUrl));
                    else
                        self.reply("no results for \""+self.rawArgs+"\" :/");
                }
                catch (e)
                {
                    self.reply("failed to parse google JSON response, FIXME");
                }
            });
        });
    }
};

commands["image"] =
{
    params: "<query>",
    description: "list first google images result for query",
    handler: function (query)
    {
        var http = require("http");
        var self = this;

        if (!this.rawArgs)
        {
            this.punish("forgot to give search parameter", 20, 40);
            return;
        }

        // More info: http://code.google.com/apis/imagesearch/v1/jsondevguide.html
        var options =
        {
            host: "ajax.googleapis.com",
            path: "/ajax/services/search/images?v=1.0&rsz=1&q="+encodeURIComponent(this.rawArgs)
        };

        http.get(options, function (res)
        {
            var dataJSON = "";

            res.on("data", function (data)
            {
                dataJSON += data;
            });
            res.on("end", function ()
            {
                try
                {
                    var results = JSON.parse(dataJSON);

                    if (results.responseData.results.length > 0)
                        self.reply("top result for \""+self.rawArgs+"\": "+
                                   (results.responseData.results[0].unescapedUrl));
                    else
                        self.reply("no results for \""+self.rawArgs+"\" :/");
                }
                catch (e)
                {
                    self.reply("failed to parse google JSON response, FIXME");
                }
            });
        });
    }
};

// FIXME: also hook on channelMessage?
commands["seen"] =
{
    params: "<nickname>",
    description: "report when a specific nickname was last seen",
    hooks:
    {
        userUpdate: function (name, type, newName, channel, message)
        {
            var data = this.getData("seen");
            var globalData = data.global || (data.global = {});

            if (!name) return;
            var time = Date.now();

            // Add to global or channel data depending on type of event:
            if (type == "nickchange" || type == "quit")
            {
                globalData[this.client.lowerCase(name)] =
                {
                    time: time, type: type, newName: newName, message: message
                };

                // For nickchanges, add record for new nickname as well
                if (type == "nickchange")
                {
                    globalData[this.client.lowerCase(newName)] =
                    {
                        time: time, type: "nickchangefrom", fromName: name
                    };
                }
            }
            else
            {
                var channels    = data.channels     || (data.channels     = {});
                var channelData = channels[channel] || (channels[channel] = {});

                channelData[this.client.lowerCase(name)] =
                {
                    time: time, type: type, message: message
                };
            }
        },
        userList: function (channel, names)
        {
            var data = this.getData("seen");

            if (!data || !names) return;

            var channels = data.channels || (data.channels = {});
            var channelData = channels[channel] || (channels[channel] = {});
            var time = Date.now();

            for (var n in names)
            {
                channelData[this.client.lowerCase(names[n])] =
                {
                    time: time, type: "present"
                };
            }
        }
    },
    handler: function (name)
    {
        var data = this.getData("seen");
        var global   = data.global   || (data.global   = {});
        var channels = data.channels || (data.channels = {});
        var res, resChannel;

        if (!name)
        {
            this.punish("forgot to give <nickname> argument", 10, 20);
            return;
        }
        var lcName = this.client.lowerCase(name);

        // Check channel records first, then global
        for (var c in channels)
        {
            // Check this channel if .seen came in privately, or if it equals origin channel
            if (!this.origin.channel || this.client.compareName(this.origin.channel, c))
            {
                // If there is a record for this nick, store it in res if it is more recent than
                // whatever is in res currently.
                if (channels[c][lcName])
                {
                    if (!res || res.time < channels[c][lcName])
                    {
                        res = channels[c][lcName];
                        resChannel = c;
                    }
                }
            }
        }
        // Also check global records
        if (global[lcName])
        {
            if (!res || res.time < global[lcName].time)
                res = global[lcName];
        }

        if (res)
        {
            var str;

            if (res.type == "nickchange")
                str = "changing nickname to "+res.newName;
            else if (res.type == "nickchangefrom")
                str = "changing nickname from "+res.fromName;
            else if (res.type == "join")
                str = "joining "+resChannel;
            else if (res.type == "part")
                str = "leaving "+resChannel+" (message: "+res.message+")";
            else if (res.type == "kick")
                str = "being kicked from "+res.channel+" (reason: "+res.message+")";
            else if (res.type == "quit")
                str = "quitting (message: "+res.message+")";
            else if (res.type == "present")
                str = "hanging out on "+resChannel;

            this.reply("i last saw '"+name+"' "+getFriendlyTime(res.time)+", "+str);
        }
        else
            this.reply("i haven't seen "+name+" yet :/");
    }
};


commands["coffee"] =
{
    description: "coffee!",
    handler: function ()
    {
        this.punish("tried to steal my coffee", -100, 100);
    }
};

commands["pigs"] =
{
    description: "show biggest piggers",
    handler: function ()
    {
        var data = this.getData("pig");
        var str = "", count = 3;
        var top = this.getTop(count, data, function (a,b) { return a > b; } );

        for (var i in top)
        {
            if (i == top.length-1)
                str += top[i]+" ("+data[top[i]]+")";
            else
                str += top[i]+" ("+data[top[i]]+"), ";
        }
        this.reply("top "+count+" piggers: "+str);
    }
};

commands["showpig"] =
{
    params: "<nickname>",
    description: "display nickname's level of pig",
    handler: function (name)
    {
        var data = this.getData("pig");

        if (!name)
        {
            this.punish("failed to give <nickname> argument", 10, 30);
            return;
        }

        var lcName = this.client.lowerCase(name);

        if (data[lcName])
            this.reply("level of pig for "+ name + " is " + data[lcName]);
        else
            this.reply("hrm.. "+name+" hasn't pigged yet!");
    }
};


// FIXME: make random, use larger amounts so its not  as useless compared with punish()
commands["pig"] =
{
    params: "<nickname>",
    description: "increase someone's level of pig",
    handler: function (name)
    {
        if (name)
        {
            var data = this.getData("pig");
            var lcName = this.client.lowerCase(name);
            data[lcName] = (data[lcName] || 0) + 1;
            this.reply("level of pig for "+ name + " has increased to "+data[lcName]);
        }
    }
};


commands["help"] =
{
    params: "<command>",
    description: "list all commands available or show info for a specific command",
    handler: function (name)
    {
        var cmd;

        name = name && name.toLowerCase();

        if (name && (cmd = this.commands[name]))
        {
            if (cmd.params && cmd.description)
                this.replyPrivately(name+" "+cmd.params+": "+cmd.description);
            else if (cmd.description)
                this.replyPrivately(name+": "+cmd.description);
            else
                this.replyPrivately("no description for command available");
        }
        else
        {
            var str = "supported commands: ";

            for (var c in this.commands)
            {
                var cmd = this.commands[c];

                if (cmd.description) str += c+" ";
            }
            this.replyPrivately(str);
            this.replyPrivately("use \""+this.conf.command_prefix+
                "help <commandname>\" for a description of a specific command");
        }
    }
};


commands["echo"] =
{
    params: "<string>",
    description: "echo!",
    handler: function ()
    {
        this.reply("echo: " + (this.rawArgs || "") );
    }
};


commands["eval"] =
{
    // using vm for this might not be entirely safe (infinite loops etc), see
    // http://gf3.github.com/sandbox/ for a possible solution

    params: "<code>",
    description: "runs a piece of JavaScript in a sandbox",
    handler: function ()
    {
        //if (!this.isFromTrusted()) return;

        try
        {
            var res = vm.runInNewContext(this.rawArgs, {});
            if (typeof res == "string")
            {
                // Split by \n and print each individually
                var lines = res.split("\n");

                for (l in lines)
                    this.reply("result: "+lines[l]);
            }
            else
                this.reply("result: "+util.inspect(res));
        }
        catch (err)
        {
            this.reply("eval: "+err);
        }
    }
};

commands["savedata"] =
{
    description: "save command data (must be trusted)",
    handler: function ()
    {
        if (!this.isFromTrusted()) return;

        this.saveData();
        this.reply("Data saved..");
    }
}

commands["leavechan"] =
{
    params: "<channel> <message>",
    description: "leave a channel (must be trusted)",
    handler: function (channel, message)
    {
        if (!this.isFromTrusted()) return;

        this.client.leaveChannel(channel, message);
    }
};

commands["joinchan"] =
{
    params: "<channel>",
    description: "join a channel (must be trusted)",
    handler: function (channel)
    {
        if (!this.isFromTrusted()) return;

        this.client.joinChannel(channel);
    }
};

commands["pick"] =
{
	description: "randomly pick an item out of a list of items (separated with commas)",
	handler: function ()
	{
		if (this.rawArgs)
        {
        	var split = this.rawArgs.trim().split(',');

        	if (split && split.length)
            {
            	// Generate random index from 0 to length-1
            	var picked = split[Math.floor(split.length * Math.random())];

            	this.reply("i picked \'"+picked.trim()+"\'!");
            }
        }
    }
}

commands["info"] =
{
    description: "display some miscellaneous info",
    handler: function ()
    {
        this.reply(
            "Argh version "+this.version+", "+
            "uptime: "+getFriendlyTime(this.getTimes().startTime, "")+", "+
            "connect time: "+getFriendlyTime(this.getTimes().connectTime, "")+", "+
            "platform: "+process.platform+", "+
            "node version: "+process.version+", "+
            "sources: http://aphax.nl/cgit/argh"
        );

    }
};

commands["quit"] =
{
    description: "quit! (must be trusted)",
    handler: function ()
    {
        if (!this.isFromTrusted()) return;

        this.client.disconnect(this.rawArgs);
    }
};

// FIXME: Rewrite this to use Buffer, that way i can support utf8 instead of restricting to ascii
commands["ascii"] =
{
    description: "turn binary/hexadecimal ascii-encoded string into normal text",
    params: "<hex/bin> <string> or just <string> (tries to guess if its binary or hexadecimals)",
    handler: function (a, b)
    {
        // FIXME: Might want to filter out non-printable characters, shouldn't strictly be needed
        // as \r\n is already filtered out by irc.Client, but ngircd seemed to not like certain
        // non-printable char sequences?
        var type;
        var strOut = "";

        if (arguments.length == 2 && a == "hex")
            type = a;
        else if (arguments.length == 2 && a == "bin")
            type = a;
        else if (arguments.length == 1 && a.trim().match(/^[10]+$/))
        {
            type = "bin";
            b = a;
        }
        else if (arguments.length == 1 && a.trim().match(/^[0-9a-f]+$/i))
        {
            type = "hex";
            b = a;
        }
        else
            return;

        var str = b.trim();
        var byte;
        var width = type == "hex" ?  2 : 8;
        var radix = type == "hex" ? 16 : 2;

        // Pull out 'width' chars and parse
        for (var i = 0; i < (str.length/width); i++)
        {
            byte = parseInt(str.slice(i*width, (i+1)*width), radix);

            if (byte < 128)
                strOut += String.fromCharCode(byte);
            else
                strOut += "?";
        }
        this.reply("ascii: "+strOut);
    }
};

commands["bin"] =
{
    description: "turn ascii text into binary",
    params: "<string>",
    handler: function ()
    {
        if (!this.rawArgs) return;

        var str = this.rawArgs;
        var strOut = "";

        for (var i in str)
        {
            var c = str.charCodeAt(i);

            if (c < 128)
                strOut += (c+256).toString(2).slice(1);
            else
                strOut += (63+256).toString(2).slice(1); // insert '?' for non-ascii charcodes
        }
        this.reply("bin: "+strOut);
    }
};

commands["hex"] =
{
    description: "turn ascii text into hexadecimals",
    params: "<string>",
    handler: function ()
    {
        if (!this.rawArgs) return;

        var str = this.rawArgs;
        var strOut = "";

        for (var i in str)
        {
            var c = str.charCodeAt(i);

            if (c < 128)
                strOut += (c+256).toString(16).slice(1);
            else
                strOut += (63+256).toString(16).slice(1); // insert '?' for non-ascii charcodes
        }
        this.reply("hex: "+strOut);
    }
};

commands["rot13"] =
{
    description: "encrypt text using the highly secure rot13 algorithm!",
    params: "<string>",
    handler: function ()
    {
        if (!this.rawArgs) return;

        // Rotate a single a-z/A-Z character by offset
        function rot(char, offset)
        {
            var code = char.charCodeAt(0);

            if (code > 64 && code < 91)
                return String.fromCharCode( (((code-65)+offset)%26)+65 );
            else if (code > 96 && code < 123)
                return String.fromCharCode( (((code-97)+offset)%26)+97 );
            else
                return "";
        }

        this.reply("rot13: "+this.rawArgs.replace(/[a-zA-Z]/g, function (m) { return rot(m, 13) }));
    }
};

commands["md5"] =
{
    description: "calculate md5 hash of given string",
    params: "<string>",
    handler: function ()
    {
        if (!this.rawArgs) return;

        /*
         Javascript MD5 library - version 0.2

         coded (2011) by Luigi Galli - LG@4e71.org - http://faultylabs.com

        The below code is PUBLIC DOMAIN - NO WARRANTY!
        */
        function md5(data)
        {
            // for test/debug
            function fflog(msg) { }

            // convert number to (unsigned) 32 bit hex, zero filled string
            function to_zerofilled_hex(n) {
                var t1 = (n >>> 24).toString(16);
                var t2 = (n & 0x00FFFFFF).toString(16);
                return "00".substr(0, 2 - t1.length) + t1 +
                "000000".substr(0, 6 - t2.length) + t2;
            }

            // convert array of chars to array of bytes (note: Unicode not supported)
            function chars_to_bytes(ac) {
                var retval = [];
                for (var i = 0; i < ac.length; i++) {
                    retval = retval.concat(str_to_bytes(ac[i]));
                }
                return retval;
            }


            // convert a 64 bit unsigned number to array of bytes. Little endian
            function int64_to_bytes(num) {
                var retval = [];
                for (var i = 0; i < 8; i++) {
                    retval.push(num & 0xFF);
                    num = num >>> 8;
                }
                return retval;
            }

            //  32 bit left-rotation
            function rol(num, places) {
                return ((num << places) & 0xFFFFFFFF) | (num >>> (32 - places));
            }

            // The 4 MD5 functions
            function fF(b, c, d) {
                return (b & c) | (~b & d);
            }

            function fG(b, c, d) {
                return (d & b) | (~d & c);
            }

            function fH(b, c, d) {
                return b ^ c ^ d;
            }

            function fI(b, c, d) {
                return c ^ (b | ~d);
            }

            // pick 4 bytes at specified offset. Little-endian is assumed
            function bytes_to_int32(arr, off) {
                return (arr[off + 3] << 24) | (arr[off + 2] << 16) | (arr[off + 1] << 8) | (arr[off]);
            }

            /*
            Conver string to array of bytes in UTF-8 encoding
            See:
            http://www.dangrossman.info/2007/05/25/handling-utf-8-in-javascript-php-and-non-utf8-databases/
            http://stackoverflow.com/questions/1240408/reading-bytes-from-a-javascript-string
            How about a String.getBytes(<ENCODING>) for Javascript!? Isn't it time to add it?
            */
            function str_to_bytes(str) {
                // alert("got " + str.length + " chars")
                var retval = [ ];
                for (var i = 0; i < str.length; i++)
                    if (str.charCodeAt(i) <= 0x7F) {
                        retval.push(str.charCodeAt(i));
                    } else {
                        var tmp = encodeURIComponent(str.charAt(i)).substr(1).split('%');
                        for (var j = 0; j < tmp.length; j++) {
                            retval.push(parseInt(tmp[j], 0x10));
                        }
                    }
                return retval;
            };

            // convert the 4 32-bit buffers to a 128 bit hex string. (Little-endian is assumed)
            function int128le_to_hex(a, b, c, d) {
                var ra = "";
                var t = 0;
                var ta = 0;
                for (var i = 3; i >= 0; i--) {
                    ta = arguments[i];
                    t = (ta & 0xFF);
                    ta = ta >>> 8;
                    t = t << 8;
                    t = t | (ta & 0xFF);
                    ta = ta >>> 8;
                    t = t << 8;
                    t = t | (ta & 0xFF);
                    ta = ta >>> 8;
                    t = t << 8;
                    t = t | ta;
                    ra = ra + to_zerofilled_hex(t);
                }
                return ra;
            }

            // check input data type and perform conversions if needed
            var databytes = null;
            // String
            if (typeof data == 'string') {
                // convert string to array bytes
                databytes = str_to_bytes(data);
            } else if (data.constructor == Array) {
                if (data.length === 0) {
                    // if it's empty, just assume array of bytes
                    databytes = data;
                } else if (typeof data[0] == 'string') {
                    databytes = chars_to_bytes(data);
                } else if (typeof data[0] == 'number') {
                    databytes = data;
                } else {
                    fflog("input data type mismatch");
                    return null;
                }
            } else {
                fflog("input data type mismatch");
                return null;
            }

            // save original length
            var org_len = databytes.length;

            // first append the "1" + 7x "0"
            databytes.push(0x80);

            // determine required amount of padding
            var tail = databytes.length % 64;
            // no room for msg length?
            if (tail > 56) {
                // pad to next 512 bit block
                for (var i = 0; i < (64 - tail); i++) {
                    databytes.push(0x0);
                }
                tail = databytes.length % 64;
            }
            for (i = 0; i < (56 - tail); i++) {
                databytes.push(0x0);
            }
            // message length in bits mod 512 should now be 448
            // append 64 bit, little-endian original msg length (in *bits*!)
            databytes = databytes.concat(int64_to_bytes(org_len * 8));

            // initialize 4x32 bit state
            var h0 = 0x67452301;
            var h1 = 0xEFCDAB89;
            var h2 = 0x98BADCFE;
            var h3 = 0x10325476;

            // temp buffers
            var a = 0,
            b = 0,
            c = 0,
            d = 0;


            function _add(n1, n2) {
                return 0x0FFFFFFFF & (n1 + n2)
            }

            // function update partial state for each run
            var updateRun = function(nf, sin32, dw32, b32) {
                var temp = d;
                d = c;
                c = b;
                //b = b + rol(a + (nf + (sin32 + dw32)), b32);
                b = _add(b,
                    rol(
                        _add(a,
                            _add(nf, _add(sin32, dw32))
                        ), b32
                    )
                );
                a = temp;
            };


            // Digest message
            for (i = 0; i < databytes.length / 64; i++) {
                // initialize run
                a = h0;
                b = h1;
                c = h2;
                d = h3;

                var ptr = i * 64;

                // do 64 runs
                updateRun(fF(b, c, d), 0xd76aa478, bytes_to_int32(databytes, ptr), 7);
                updateRun(fF(b, c, d), 0xe8c7b756, bytes_to_int32(databytes, ptr + 4), 12);
                updateRun(fF(b, c, d), 0x242070db, bytes_to_int32(databytes, ptr + 8), 17);
                updateRun(fF(b, c, d), 0xc1bdceee, bytes_to_int32(databytes, ptr + 12), 22);
                updateRun(fF(b, c, d), 0xf57c0faf, bytes_to_int32(databytes, ptr + 16), 7);
                updateRun(fF(b, c, d), 0x4787c62a, bytes_to_int32(databytes, ptr + 20), 12);
                updateRun(fF(b, c, d), 0xa8304613, bytes_to_int32(databytes, ptr + 24), 17);
                updateRun(fF(b, c, d), 0xfd469501, bytes_to_int32(databytes, ptr + 28), 22);
                updateRun(fF(b, c, d), 0x698098d8, bytes_to_int32(databytes, ptr + 32), 7);
                updateRun(fF(b, c, d), 0x8b44f7af, bytes_to_int32(databytes, ptr + 36), 12);
                updateRun(fF(b, c, d), 0xffff5bb1, bytes_to_int32(databytes, ptr + 40), 17);
                updateRun(fF(b, c, d), 0x895cd7be, bytes_to_int32(databytes, ptr + 44), 22);
                updateRun(fF(b, c, d), 0x6b901122, bytes_to_int32(databytes, ptr + 48), 7);
                updateRun(fF(b, c, d), 0xfd987193, bytes_to_int32(databytes, ptr + 52), 12);
                updateRun(fF(b, c, d), 0xa679438e, bytes_to_int32(databytes, ptr + 56), 17);
                updateRun(fF(b, c, d), 0x49b40821, bytes_to_int32(databytes, ptr + 60), 22);
                updateRun(fG(b, c, d), 0xf61e2562, bytes_to_int32(databytes, ptr + 4), 5);
                updateRun(fG(b, c, d), 0xc040b340, bytes_to_int32(databytes, ptr + 24), 9);
                updateRun(fG(b, c, d), 0x265e5a51, bytes_to_int32(databytes, ptr + 44), 14);
                updateRun(fG(b, c, d), 0xe9b6c7aa, bytes_to_int32(databytes, ptr), 20);
                updateRun(fG(b, c, d), 0xd62f105d, bytes_to_int32(databytes, ptr + 20), 5);
                updateRun(fG(b, c, d), 0x2441453, bytes_to_int32(databytes, ptr + 40), 9);
                updateRun(fG(b, c, d), 0xd8a1e681, bytes_to_int32(databytes, ptr + 60), 14);
                updateRun(fG(b, c, d), 0xe7d3fbc8, bytes_to_int32(databytes, ptr + 16), 20);
                updateRun(fG(b, c, d), 0x21e1cde6, bytes_to_int32(databytes, ptr + 36), 5);
                updateRun(fG(b, c, d), 0xc33707d6, bytes_to_int32(databytes, ptr + 56), 9);
                updateRun(fG(b, c, d), 0xf4d50d87, bytes_to_int32(databytes, ptr + 12), 14);
                updateRun(fG(b, c, d), 0x455a14ed, bytes_to_int32(databytes, ptr + 32), 20);
                updateRun(fG(b, c, d), 0xa9e3e905, bytes_to_int32(databytes, ptr + 52), 5);
                updateRun(fG(b, c, d), 0xfcefa3f8, bytes_to_int32(databytes, ptr + 8), 9);
                updateRun(fG(b, c, d), 0x676f02d9, bytes_to_int32(databytes, ptr + 28), 14);
                updateRun(fG(b, c, d), 0x8d2a4c8a, bytes_to_int32(databytes, ptr + 48), 20);
                updateRun(fH(b, c, d), 0xfffa3942, bytes_to_int32(databytes, ptr + 20), 4);
                updateRun(fH(b, c, d), 0x8771f681, bytes_to_int32(databytes, ptr + 32), 11);
                updateRun(fH(b, c, d), 0x6d9d6122, bytes_to_int32(databytes, ptr + 44), 16);
                updateRun(fH(b, c, d), 0xfde5380c, bytes_to_int32(databytes, ptr + 56), 23);
                updateRun(fH(b, c, d), 0xa4beea44, bytes_to_int32(databytes, ptr + 4), 4);
                updateRun(fH(b, c, d), 0x4bdecfa9, bytes_to_int32(databytes, ptr + 16), 11);
                updateRun(fH(b, c, d), 0xf6bb4b60, bytes_to_int32(databytes, ptr + 28), 16);
                updateRun(fH(b, c, d), 0xbebfbc70, bytes_to_int32(databytes, ptr + 40), 23);
                updateRun(fH(b, c, d), 0x289b7ec6, bytes_to_int32(databytes, ptr + 52), 4);
                updateRun(fH(b, c, d), 0xeaa127fa, bytes_to_int32(databytes, ptr), 11);
                updateRun(fH(b, c, d), 0xd4ef3085, bytes_to_int32(databytes, ptr + 12), 16);
                updateRun(fH(b, c, d), 0x4881d05, bytes_to_int32(databytes, ptr + 24), 23);
                updateRun(fH(b, c, d), 0xd9d4d039, bytes_to_int32(databytes, ptr + 36), 4);
                updateRun(fH(b, c, d), 0xe6db99e5, bytes_to_int32(databytes, ptr + 48), 11);
                updateRun(fH(b, c, d), 0x1fa27cf8, bytes_to_int32(databytes, ptr + 60), 16);
                updateRun(fH(b, c, d), 0xc4ac5665, bytes_to_int32(databytes, ptr + 8), 23);
                updateRun(fI(b, c, d), 0xf4292244, bytes_to_int32(databytes, ptr), 6);
                updateRun(fI(b, c, d), 0x432aff97, bytes_to_int32(databytes, ptr + 28), 10);
                updateRun(fI(b, c, d), 0xab9423a7, bytes_to_int32(databytes, ptr + 56), 15);
                updateRun(fI(b, c, d), 0xfc93a039, bytes_to_int32(databytes, ptr + 20), 21);
                updateRun(fI(b, c, d), 0x655b59c3, bytes_to_int32(databytes, ptr + 48), 6);
                updateRun(fI(b, c, d), 0x8f0ccc92, bytes_to_int32(databytes, ptr + 12), 10);
                updateRun(fI(b, c, d), 0xffeff47d, bytes_to_int32(databytes, ptr + 40), 15);
                updateRun(fI(b, c, d), 0x85845dd1, bytes_to_int32(databytes, ptr + 4), 21);
                updateRun(fI(b, c, d), 0x6fa87e4f, bytes_to_int32(databytes, ptr + 32), 6);
                updateRun(fI(b, c, d), 0xfe2ce6e0, bytes_to_int32(databytes, ptr + 60), 10);
                updateRun(fI(b, c, d), 0xa3014314, bytes_to_int32(databytes, ptr + 24), 15);
                updateRun(fI(b, c, d), 0x4e0811a1, bytes_to_int32(databytes, ptr + 52), 21);
                updateRun(fI(b, c, d), 0xf7537e82, bytes_to_int32(databytes, ptr + 16), 6);
                updateRun(fI(b, c, d), 0xbd3af235, bytes_to_int32(databytes, ptr + 44), 10);
                updateRun(fI(b, c, d), 0x2ad7d2bb, bytes_to_int32(databytes, ptr + 8), 15);
                updateRun(fI(b, c, d), 0xeb86d391, bytes_to_int32(databytes, ptr + 36), 21);

                // update buffers
                h0 = _add(h0, a);
                h1 = _add(h1, b);
                h2 = _add(h2, c);
                h3 = _add(h3, d);
            }
            // Done! Convert buffers to 128 bit (LE)
            return int128le_to_hex(h3, h2, h1, h0).toUpperCase();
        };

        this.reply("md5: "+md5(this.rawArgs));
    }
};

