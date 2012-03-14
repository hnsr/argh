modules.image = {
    description: "list first google images result for query",
    commands: {
        image: {
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
                // More info: http://code.google.com/apis/imagesearch/v1/jsondevguide.html
                var options =
                {
                    host: "ajax.googleapis.com",
                    path: "/ajax/services/search/images?v=1.0&rsz=1&q="+encodeURIComponent(this.rawArgs)
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
