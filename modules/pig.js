modules.pigmodule = {
    description: "The pig module!",
    commands: {
        pigs: {
            description: "show biggest piggers",
            handler: function () {
                var data = this.getData("pig");
                var str = "", count = 3;
                var top = common.getTop(count, data, function (a,b) { return a > b; } );
                for (var i in top) {
                    if (i == top.length-1)
                        str += top[i]+" ("+data[top[i]]+")";
                    else
                        str += top[i]+" ("+data[top[i]]+"), ";
                }
                this.reply("top "+count+" piggers: "+str);
            }
        },
        showpig: {
            params: "<nickname>",
            description: "display nickname's level of pig",
            handler: function (name) {
                var data = this.getData("pig");
                if (!name)
                {
                    this.punish("failed to give <nickname> argument", 10, 30);
                    return;
                }
                var lcName = this.client.lowerCase(name);
                if (data[lcName])
                    this.reply("level of pig for "+ name + " is " + data[lcName]);
                else
                    this.reply("hrm.. "+name+" hasn't pigged yet!");
            }
        },
        pig: {
            params: "<nickname>",
            description: "increase someone's level of pig",
            handler: function (name) {
                if (name) {
                    var data = this.getData("pig");
                    var lcName = this.client.lowerCase(name);
                    data[lcName] = (data[lcName] || 0) + 1;
                    this.reply("level of pig for "+ name + " has increased to "+data[lcName]);
                }
            }
        }
    }
};

