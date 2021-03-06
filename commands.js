var vm     = require("vm");
var util   = require("util");
var common = require("./common.js");

var get             = common.get;
var getRandom       = common.getRandom;
var getFriendlyTime = common.getFriendlyTime;

var commands = module.exports = {};

var isPunctuated=function(s){
    return /^.*[^\.!?\s][\.!?]$/.test(s);
};

commands["wipemsg"] =
{
    description: "delete any messages others left for you",
    handler: function ()
    {
        var recipient = this.client.lowerCase(this.origin.name);
        var data = this.getData("messages");

        if (get(data, recipient))
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
        var messages = data && get(data, this.client.lowerCase(nickname));

        // Make sure we don't spam messages more than once ever 60 seconds
        var lastTime = get(this.command.spamTimestamps, nickname);

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
                data[recipient] = get(data, recipient) || []; // Initialize messages array if needed

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

// Search for youtube videos, also prints titles for videos linked in a channel
commands["youtube"] =
{
    // Helper function for querying the youtube API for movie info on given video ID or search query
    fetchInfo: function (query, doSearch, resFunc)
    {
        var self = this;
        var http = require("http");
        var matches;
        var options = { host: "gdata.youtube.com" };

        if (doSearch)
            options.path = "/feeds/api/videos?q="+encodeURIComponent(query)+"&max-results=1&alt=json&v=2";
        else
            options.path = "/feeds/api/videos/"+encodeURIComponent(query)+"?alt=json&v=2";

        http.get(options, function (res)
        {
            var dataJSON = "";

            res.on("data", function (data) { dataJSON += data; });
            res.on("end", function ()
            {
                try
                {
                    var result = JSON.parse(dataJSON);

                    if (doSearch)
                    {
                        if (result.feed && result.feed.entry)
                            result = result.feed.entry[0];
                        else
                            result = null;
                    }
                    else
                        result = result.entry;

                    resFunc(result);
                }
                catch (e)
                {
                    self.log("failed to parse youtube JSON response: "+e.message);
                    resFunc(null);
                }
            });
        });
    },
    hooks:
    {
        channelMessage: function (channel, sender, message)
        {
            var matches;
            var self = this;

            // If the message contained something that might be a youtube URL, pull out the movie ID
            // and attempt to look it up.
            if (/youtu/.test(message) &&
                (matches = /(?:youtu.be\/|youtube\.com.*?[&\?]v=)([^ &#]+)/.exec(message)))
            {
                this.command.fetchInfo.call(this, matches[1], false, onInfo);

                function onInfo(entry)
                {
                    if (entry)
                        self.client.sendToChannel(channel, "title: "+entry.title.$t);
                    else
                        self.log("channelMessage: failed to look up youtube movie");
                }
            }
        }
    },
    params: "<query>",
    description: "search youtube for given query string",
    handler: function (query)
    {
        if (this.rawArgs)
        {
            var self = this;

            this.command.fetchInfo.call(this, this.rawArgs, true, onInfo);

            function onInfo(entry)
            {
                if (entry)
                    self.reply("http://youtube.com/watch?v="+entry.media$group.yt$videoid.$t+
                               " - "+entry.title.$t);
                else
                    self.reply("no results for \""+self.rawArgs+"\"");

            }
        }
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
                    self.reply("no.");
                    self.log("bad JSON response: "+dataJSON);
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
                var channels    = data.channels          || (data.channels     = {});
                var channelData = get(channels, channel) || (channels[channel] = {});

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
            var channelData = get(channels, channel) || (channels[channel] = {});
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
                if (get(channels[c], lcName))
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
        if (get(global, lcName))
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


commands["pigs"] =
{
    description: "show biggest piggers",
    handler: function ()
    {
        var data = this.getData("pig");
        var str = "", count = 3;
        var top = common.getTop(count, data, function (a,b) { return a > b; } );

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

        if (get(data, lcName))
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
            data[lcName] = (get(data, lcName) || 0) + 1;
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

        if (name && (cmd = get(this.commands, name)))
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
    params: "<code>",
    description: "runs a piece of JavaScript in a sandbox",
    handler: function ()
    {
        var self = this;
        var timeout = this.conf.eval_timeout;

        common.runCode(self.rawArgs, (timeout ? timeout : 10000), onExit, onError);

        function onExit(value, valueStr)
        {
            // Special case for strings, split by \n and print line by line
            if (typeof value == "string")
            {
                var lines = value.split("\n");

                for (l in lines)
                    self.reply("result: "+lines[l]);
            }
            // Else just print the util.inspect string
            else
                self.reply("result: " + valueStr);
        }

        function onError(type, message)
        {
            if      (type == "timeout")    self.reply("eval: code ran for too long!");
            else if (type == "code_error") self.reply("eval: "+message);
            else if (type == "memory")     self.reply("eval: code used too much memory!");
            else if (type == "unknown")    self.log(message);
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
                var picked = getRandom(split);

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
            "home: http://github.com/hnsr/argh"
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

        var md5sum = require("crypto").createHash("md5");

        md5sum.update(this.rawArgs);

        this.reply("md5: " + md5sum.digest("hex"));
    }
};

commands["autorejoin"] =
{
    description: "this is a module for automatically rejoining after a kick (not a command)",
    hooks:
    {
        userUpdate: function (nickname, type, newName, channel, message)
        {
            if (type == "kick")
            {
                if (this.client.compareName(nickname, this.client.nickname))
                {
                    this.log("got kicked by " + newName + " from channel " + channel);
                    // Trying to rejoining channel
                    this.client.joinChannel(channel);
                }
            }
        }
    }
};

commands["addquote"] =
{
    description: "add a quote",
    params: "<string>",
    handler: function ()
    {
        if (!this.rawArgs)
        {
            this.reply("no.");
            return;
        }

        var data = this.getData("quotes");
        var quotes = data.quotes || (data.quotes = []);
        var quote = this.rawArgs.replace(/^\s+|\s+$/g, '')

        if (quote.length)
        {
            quotes.push(quote);
            this.reply("added quote \""+quote+"\"");
        }
    }
};

commands["quote"] =
{
    description: "print a random quote, or one that contains the given string",
    params: "<string>",
    handler: function ()
    {
        var data = this.getData("quotes");

        var quotes = data.quotes || (data.quotes = []);

        if (quotes.length)
        {
            if (this.rawArgs)
            {
                // Build list of matches, then randomly pick one from it
                var matches = [];

                this.rawArgs = this.rawArgs.toLowerCase();

                for (var q in quotes)
                {
                    if (quotes[q].toLowerCase().indexOf(this.rawArgs) >= 0)
                    {
                        matches.push(quotes[q]);
                    }
                }

                if (matches.length)
                {
                    this.reply("quote: "+getRandom(matches));
                }
            }
            else
            {
                this.reply("quote: "+getRandom(quotes));
            }
        }
    }
};

commands["addtea"] =
{
    description: "add something to the tea menu",
    params: "<string>",
    handler: function ()
    {
        if (!this.rawArgs)
        {
            this.reply("No!");
            return;
        }

        var tea = this.getData("tea");
        var items = tea.items || (tea.items = []);
        var item = this.rawArgs.replace(/^\s+|\s+$/g, '')

        if (item.length)
        {
            if(isPunctuated(item))
            {
                items.push(item);
                this.reply("Added \""+item+"\" to the tea menu.");  
            }
            else 
            {
                this.reply("Item is not in accordance with standing punctuation guidelines. Tea refused.");
            }
        }
    }
};

commands["tea"] =
{
    description: "tea",
    handler: function ()
    {
        var tea = this.getData("tea");

        var items = tea.items || (tea.items = []);

        if (items.length)
        {
            this.reply("\001ACTION serves "+this.origin.name+" "+getRandom(items)+"\001");
        }
    }
};

commands["addcoffee"] =
{
    description: "add something to the coffee menu",
    params: "<string>",
    handler: function ()
    {
        if (!this.rawArgs)
        {
            this.reply("No!");
            return;
        }

        var coffee = this.getData("coffee");
        var items = coffee.items || (coffee.items = []);
        var item = this.rawArgs.replace(/^\s+|\s+$/g, '')

        if (item.length)
        {
            if(isPunctuated(item))
            {
                items.push(item);
                this.reply("Added \""+item+"\" to the coffee menu.");  
            }
            else 
            {
                this.reply("Item is not in accordance with standing punctuation guidelines. Coffee refused.");
            }
        }
    }
};

commands["coffee"] =
{
    description: "coffee!",
    handler: function ()
    {
        var coffee = this.getData("coffee");

        var items = coffee.items || (coffee.items = []);

        if (items.length)
        {
            this.reply("\001ACTION serves "+this.origin.name+" "+getRandom(items)+"\001");
        }
    }
};

commands["oink"] =
{
    description: "Finds some oink in the internets",
    handler: function (query)
    {
        function chooseOne(array){
            return array[Math.floor(Math.random()*array.length)];
        }
    
        var http = require("http");
        var self = this;
        
        var term=chooseOne(["pig","hog","boar","oink"]);
        var color=chooseOne(["black","blue","brown","gray","green","orange","pink","purple","red","teal","white","yellow"]);
        var start=Math.floor(Math.random()*50);

        var path="/ajax/services/search/images?v=1.0&rsz=5&q="+term+"&start="+start;
        if(Math.random()>0.3) path+="&imgcolor="+color;

        // More info: http://code.google.com/apis/imagesearch/v1/jsondevguide.html
        var options =
        {
            host: "ajax.googleapis.com",
            path: path
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

                    if (results.responseData.results.length > 0){
                        var images=results.responseData.results;
                        var image=images[Math.floor(Math.random()*images.length)];
                        self.reply("Oink! "+image.unescapedUrl);
                    }
                    else
                        self.reply("no oink for you");
                }
                catch (e)
                {
                    self.reply("no oink for you!");
                }
            });
        });
    }
};

commands["girrroink"] =
{
    description: "Finds some girrr, or oink, or both, or neither, or something totally different in the internets",
    handler: function (query)
    {
        function chooseOne(array){
            return array[Math.floor(Math.random()*array.length)];
        }
    
        var http = require("http");
        var self = this;
        
        var term=chooseOne(["giraffe+pig","giraffe+oink","giraffe+hog"]);
        var start=Math.floor(Math.random()*20);

        var path="/ajax/services/search/images?v=1.0&rsz=5&q="+term+"&start="+start;

        // More info: http://code.google.com/apis/imagesearch/v1/jsondevguide.html
        var options =
        {
            host: "ajax.googleapis.com",
            path: path
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

                    if (results.responseData.results.length > 0){
                        var images=results.responseData.results;
                        var image=images[Math.floor(Math.random()*images.length)];
                        self.reply("Girrroink! "+image.unescapedUrl);
                    }
                    else
                        self.reply("no girrroink for you");
                }
                catch (e)
                {
                    self.reply("no girrroink for you!");
                }
            });
        });
    }
};

commands["define"] =
{
    description: "Defines a word",
    handler: function (query)
    {
        if(!this.rawArgs || !(query=this.rawArgs.trim())) {
            this.reply("No.");
            return;
        }
        
    
        var path="/dictionary/json?callback=a&sl=en&tl=en&q="+encodeURIComponent(query)

        var options =
        {
            host: "www.google.com",
            path: path
        };

        var http = require("http");
        var self = this;
        
        http.get(options, function (res)
        {
            var dataJSON = "";

            res.on("data", function (data)
            {
                dataJSON += data;
            });
            res.on("end", function ()
            {
                var ind1=dataJSON.indexOf("{");
                var ind2=dataJSON.lastIndexOf("}");
                if(ind1<0 || ind2<0) {
                    self.reply("I don't feel like doing that, maybe later.");
                    debug("Got an unexpected reply to define: "+dataJSON);
                }
                else {
                    dataJSON=dataJSON.substring(ind1,ind2+1);
                    dataJSON=dataJSON.replace(/\\x/g,"\\u00"); // google sends escapes \xHH which JSON.parse doesn't like, it wants \u00HH
                    try
                    {
                        var res=[];
                        var totalResults=0;
                        
                        var results = JSON.parse(dataJSON);
                        if(results["primaries"]) {
                            for(var i=0;i<results["primaries"].length;i++){
                                var res2=[];
                                var primary=results["primaries"][i];
                                if(primary["type"]!="headword") continue;
                                if(!primary["terms"]) continue;
                                var type=null;
                                for(var j=0;j<primary["terms"].length;j++){
                                    var term=primary["terms"][j];
                                    if(!term["type"]=="text") continue;
                                    type=term["labels"][0]["text"];
                                    break;
                                }
                                if(type==null) continue;
                                
                                for(j=0;j<primary["entries"].length;j++){
                                    var entry=primary["entries"][j];
                                    if(entry["type"]!="meaning") continue;
                                    
                                    var meaning=entry["terms"][0]["text"];
                                    if(meaning){
                                        meaning=meaning.replace(/<(\/?)([a-z]+)>/g,""); // google sends some html tags, strip those                                
                                        totalResults++;
                                        res2.push(type+". "+meaning);
                                    }
                                }
                                if(res2.length>0) res.push(res2);
                            }
                        }
                        
                        if(totalResults>0){
                            self.reply("Results for \""+query+"\":");
                            
                            var maxRes=8;
                            var printed=0;
                            
                            for(i=0;i<res.length && printed<maxRes;i++){
                                for(j=0;    j<res[i].length
                                            && printed<maxRes
                                            && (j==0 || printed+1+res.length-1-i<=maxRes);    j++){
                                    printed++;
                                    self.reply(printed+". "+res[i][j]);
                                }
                            }
                            
                            if(printed<totalResults) self.reply((totalResults-printed)+" more...");
                        }
                        else self.reply("\""+query+"\" is undefined.");
                    }
                    catch (e)
                    {
                        self.reply("I don't feel like doing that, maybe later!");
                    }
                }
                
            });
        });
    }
};

