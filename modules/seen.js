// FIXME: also hook on channelMessage? 
modules.seen = {
    description: "report when a specific nickname was last seen",
    commands: {
        seen: {
            params: "<nickname>",
            handler: function (name)
            {
                var data = this.getData("seen");
                var global = data.global || (data.global = {});
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
        }
    },
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
                var channels = data.channels || (data.channels = {});
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
    }
};
