modules.system = {
    commands: {
        savedata: {
            description: "save module data (must be trusted)",
            handler: function ()
            {
                if (!this.isFromTrusted()) return;
                this.saveData();
                this.reply("Data saved..");
            }
        },
        leavechan: {
            params: "<channel> <message>",
            description: "leave a channel (must be trusted)",
            handler: function (channel, message)
            {
                if (!this.isFromTrusted()) return;
                this.client.leaveChannel(channel, message);
            }
        },
        joinchan: {
            params: "<channel>",
            description: "join a channel (must be trusted)",
            handler: function (channel)
            {
                if (!this.isFromTrusted()) return;
                this.client.joinChannel(channel);
            }
        },
        quit: {
            description: "quit! (must be trusted)",
            handler: function ()
            {
                if (!this.isFromTrusted()) return;
                this.client.disconnect(this.rawArgs);
            }
        }
    }
};
