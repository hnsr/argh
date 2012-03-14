modules.eval = {
    description: "runs a piece of JavaScript in a sandbox",
    commands: {
        eval: {
            params: "<code>",
            handler: function ()
            {
                var self = this;
                var timeout = this.conf.evalTimeout;
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
                    if (type == "timeout") self.reply("eval: code ran for too long!");
                    else if (type == "code_error") self.reply("eval: "+message);
                    else if (type == "memory") self.reply("eval: code used too much memory!");
                    else if (type == "unknown") self.log(message);
                }
            }
        }
    }
};

