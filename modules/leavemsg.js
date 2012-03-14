// XXX: This module is very insecure, imposters can just take on someone else's nick to read 
// his/her messages. There isn't a good way to make this (more) secure, other than specifying 
// message recipient by hostname, which is annoying.. I could keep records of nicknames I've 
// encountered along with hostnames and do something with that data, but also tricky and not 
// foolproof..
modules.leavemsg = {
    description: "leave a message for user. WARNING: don't use for private/critical stuff, its not very secure",
    commands: {
        leavemsg: {
            params: "<nickname> <message>",
            handler: function ()
            {
                var data = this.getData("messages");
                if (!data) return;
                // Parse out nickname + rest
                var matches = /^([\^`a-zA-Z\[\]\{\}_|][\^`a-zA-Z0-9-\[\]\{\}_|]*) (.*)$/.exec(this.rawArgs);
                // FIXME: when I ever implement user-tracking, refuse to record message if user is already
                // present
                if (matches && matches[1] && matches[2])
                {
                    var sender = this.origin.name;
                    var host = this.origin.host;
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
    },
    // Reports any recorded messages for nickname, to nickname. Since this is called on various
    // events like joining channe, there is a risk of spamming nickname when he is on multiple
    // channels that I am on as well.. so I record a timestamp for when I last reported to nickname,
    // and make sure I don't spam nickname again within some period. I'll store these timestamps in
    // a temporary object, doesnt need to be stored persistently.
    sendMessages: function (nickname, data)
    {
        var messages = data && data[this.client.lowerCase(nickname)];
        // Make sure we don't spam messages more than once ever 60 seconds
        var lastTime = this.module.spamTimestamps[nickname];
        if (lastTime && (Date.now()-lastTime) < 60000)
            return;
        if (messages)
        {
            this.module.spamTimestamps[nickname] = Date.now();
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
                    this.client.sendToNickname(nickname, " by "+msg.sender+
                        " ("+msg.senderHost+"), "+ getFriendlyTime(msg.time)+": "+msg.message);
                }
            }
            this.client.sendToNickname(nickname, "use the '"+this.conf.module_prefix+
                "wipemsg' module to delete these messages");
        }
    },
    // Temporary storage for timestamps of when when we last spammed a user his/her messages
    spamTimestamps: {},
    hooks: {
        userUpdate: function (nickname, type, newName, channel, message)
        {
            var nickname = (type == "nickchange") ? newName : nickname;
            if ( type == "join" || type == "nickchange")
                this.module.sendMessages.call(this, nickname, this.getData("messages"));
        },
        userList: function (channel, names)
        {
            var data = this.getData("messages");
            if (!data || !names || !(names instanceof Array)) return;
            // Loop through names, if name has messages, send them
            for (var n in names)
            {
                this.module.sendMessages.call(this, names[n], data);
            }
        }
    }
}
