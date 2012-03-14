modules.google = {
    description: "list first result for query",
    commands: {
        google: {
            params: "<query>",
            handler: function (query)
            {
                var http = require("http");
                var self = this;
                if (!this.rawArgs)
                {
                    this.punish("forgot to give search parameter", 20, 40);
                    return;
                }
                var options =
                {
                    host: "ajax.googleapis.com",
                    path: "/ajax/services/search/web?v=1.0&rsz=1&q="+encodeURIComponent(this.rawArgs)
                };
                http.get(options, function (res)
                {
                    var dataJSON = "";
                    res.on("data", function (data)
                    {
                        dataJSON += data;
                    });
                    res.on("end", function ()
                    {
                        try
                        {
                            var results = JSON.parse(dataJSON);
                            if (results.responseData.results.length > 0)
                                self.reply("top result for \""+self.rawArgs+"\": "+
                                           (results.responseData.results[0].unescapedUrl));
                            else
                                self.reply("no results for \""+self.rawArgs+"\" :/");
                        }
                        catch (e)
                        {
                            self.reply("failed to parse google JSON response, FIXME");
                        }
                    });
                });
            }
        }
    }
};
