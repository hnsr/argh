// FIXME: Rewrite this to use Buffer, that way i can support utf8 instead of restricting to ascii 
modules.ascii = {
    description: "turn binary/hexadecimal ascii-encoded string into normal text",
    commands: {
        ascii: {
            params: "<hex/bin> <string> or just <string> (tries to guess if its binary or hexadecimals)",
            handler: function (a, b)
            {
                // FIXME: Might want to filter out non-printable characters, shouldn't strictly be needed
                // as \r\n is already filtered out by irc.Client, but ngircd seemed to not like certain
                // non-printable char sequences?
                var type;
                var strOut = "";
                if (arguments.length == 2 && a == "hex")
                    type = a;
                else if (arguments.length == 2 && a == "bin")
                    type = a;
                else if (arguments.length == 1 && a.trim().match(/^[10]+$/))
                {
                    type = "bin";
                    b = a;
                }
                else if (arguments.length == 1 && a.trim().match(/^[0-9a-f]+$/i))
                {
                    type = "hex";
                    b = a;
                }
                else
                    return;
                var str = b.trim();
                var byte;
                var width = type == "hex" ?  2 : 8;
                var radix = type == "hex" ? 16 : 2;
                // Pull out 'width' chars and parse
                for (var i = 0; i < (str.length/width); i++)
                {
                    byte = parseInt(str.slice(i*width, (i+1)*width), radix);
                    if (byte < 128)
                        strOut += String.fromCharCode(byte);
                    else
                        strOut += "?";
                }
                this.reply("ascii: "+strOut);
            }
        }
    }
};

