modules.conversion = {
    description: "Conversion module",
    commands: {
        bin: {
            description: "turn ascii text into binary",
            params: "<string>",
            handler: function ()
            {
                if (!this.rawArgs) return;
                var str = this.rawArgs;
                var strOut = "";
                for (var i in str)
                {
                    var c = str.charCodeAt(i);
                    if (c < 128)
                        strOut += (c+256).toString(2).slice(1);
                    else
                        strOut += (63+256).toString(2).slice(1); // insert '?' for non-ascii charcodes
                }
                this.reply("bin: "+strOut);
            }
        },
        hex: {
            description: "turn ascii text into hexadecimals",
            params: "<string>",
            handler: function ()
            {
                if (!this.rawArgs) return;
                var str = this.rawArgs;
                var strOut = "";
                for (var i in str)
                {
                    var c = str.charCodeAt(i);
                    if (c < 128)
                        strOut += (c+256).toString(16).slice(1);
                    else
                        strOut += (63+256).toString(16).slice(1); // insert '?' for non-ascii charcodes
                }
                this.reply("hex: "+strOut);
            }
        },
        rot13: {
            description: "encrypt text using the highly secure rot13 algorithm!",
            params: "<string>",
            handler: function ()
            {
                if (!this.rawArgs) return;
                // Rotate a single a-z/A-Z character by offset
                function rot(char, offset)
                {
                    var code = char.charCodeAt(0);
                    if (code > 64 && code < 91)
                        return String.fromCharCode( (((code-65)+offset)%26)+65 );
                    else if (code > 96 && code < 123)
                        return String.fromCharCode( (((code-97)+offset)%26)+97 );
                    else
                        return "";
                }
                this.reply("rot13: "+this.rawArgs.replace(/[a-zA-Z]/g, function (m) { return rot(m, 13) }));
            }
        },
        md5: {
            description: "calculate md5 hash of given string",
            params: "<string>",
            handler: function ()
            {
                if (!this.rawArgs) return;
                var md5sum = require("crypto").createHash("md5");
                md5sum.update(this.rawArgs);
                this.reply("md5: " + md5sum.digest("hex"));
            }
        }
    }
};