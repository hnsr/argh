modules.coffee = {
    description: "coffee!",
    commands: {
        coffee: {
            handler: function ()
            {
                this.punish("tried to steal my coffee", -100, 100);
            }
        }
    }
};

