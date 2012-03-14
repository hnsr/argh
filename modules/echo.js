modules.echo = {
    description: "echo!",
    commands: {
        echo: {
            params: "<string>",
            handler: function ()
            {
                this.reply("echo: " + (this.rawArgs || "") );
            }
        }
    }
};
