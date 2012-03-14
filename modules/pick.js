modules.pick = {
    description: "randomly pick an item out of a list of items (separated with commas)",
    commands: {
        pick: {
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
    }
};

