modules.help = {
    description: "list all modules available or show info for a specific module",
    commands: {
        help: {
            params: "<module>",
            handler: function (name)
            {
                var cmd;
                name = name && name.toLowerCase();
                if (name && (cmd = this.modules[name]))
                {
                    if (cmd.params && cmd.description)
                        this.replyPrivately(name+" "+cmd.params+": "+cmd.description);
                    else if (cmd.description)
                        this.replyPrivately(name+": "+cmd.description);
                    else
                        this.replyPrivately("no description for module available");
                }
                else
                {
                    var str = "supported modules: ";
                    for (var c in this.modules)
                    {
                        var cmd = this.modules[c];
                        if (cmd.description) str += c+" ";
                    }
                    this.replyPrivately(str);
                    this.replyPrivately("use \""+this.conf.module_prefix+
                        "help <modulename>\" for a description of a specific module");
                }
            }
        }
    }
};
