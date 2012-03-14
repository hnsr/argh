// Search for youtube videos, also prints titles for videos linked in a channel 
modules.youtube = {
    description: "search youtube for given query string",
    commands: {
        youtube: {
            params: "<query>",
            handler: function (query)
            {
                if (this.rawArgs)
                {
                    var self = this;
                    this.module.fetchInfo.call(this, this.rawArgs, true, onInfo);
                    function onInfo(entry)
                    {
                        if (entry)
                            self.reply("http://youtube.com/watch?v="+entry.media$group.yt$videoid.$t+
                                       " - "+entry.title.$t);
                    }
                }
            }
        }
    },
    hooks: {
        channelMessage: function (channel, sender, message)
        {
            var matches;
            var self = this;
            // If the message contained something that might be a youtube URL, pull out the movie ID
            // and attempt to look it up.
            if (/youtu/.test(message) &&
                (matches = /(?:youtu.be\/|youtube\.com.*?[&\?]v=)([^ &#]+)/.exec(message)))
            {
                this.module.fetchInfo.call(this, matches[1], false, onInfo);
                function onInfo(entry)
                {
                    if (entry)
                        self.client.sendToChannel(channel, "title: "+entry.title.$t);
                    else
                        self.log("channelMessage: failed to look up youtube movie");
                }
            }
        }
    },

    // Helper function for querying the youtube API for movie info on given video ID or search query
    fetchInfo: function (query, doSearch, resFunc) {
        var self = this;
        var http = require("http");
        var matches;
        var options = { host: "gdata.youtube.com" };
        if (doSearch)
            options.path = "/feeds/api/videos?q="+encodeURIComponent(query)+"&max-results=1&alt=json&v=2";
        else
            options.path = "/feeds/api/videos/"+encodeURIComponent(query)+"?alt=json&v=2";
        http.get(options, function (res)
        {
            var dataJSON = "";
            res.on("data", function (data) { dataJSON += data; });
            res.on("end", function ()
            {
                try
                {
                    var result = JSON.parse(dataJSON);
                    if (doSearch)
                        result = result.feed.entry[0];
                    else
                        result = result.entry;
                    resFunc(result);
                }
                catch (e)
                {
                    self.log("failed to parse youtube JSON response: "+e.message);
                    resFunc(null);
                }
            });
        });
    }
};
