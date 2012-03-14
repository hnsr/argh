modules.info = {
    description: "display some miscellaneous info",
    commands:{
        info: {
            handler: function ()
            {
                this.reply(
                    "Argh version "+this.version+", "+
                    "uptime: "+getFriendlyTime(this.getTimes().startTime, "")+", "+
                    "connect time: "+getFriendlyTime(this.getTimes().connectTime, "")+", "+
                    "platform: "+process.platform+", "+
                    "node version: "+process.version+", "+
                    "home: http://github.com/hnsr/argh"
                );
            }
        }
    }
};
