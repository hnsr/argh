modules.wipemsg = {
    description: "delete any messages others left for you",
    commands: {
        wipemsg: {
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
    }
};
