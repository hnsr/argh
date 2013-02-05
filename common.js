

// Returns value of obj[prop] if prop exists on obj itself, else undefined.
function get(obj, prop)
{
    if (Object.prototype.hasOwnProperty.call(obj, prop))
        return obj[prop];

    return undefined;
}

// Return friendly time string representing time passed since given timeMS, "2 days ago",
// "5 hours ago", "60 seconds ago" etc
function getFriendlyTime (timeMS, postfix)
{
    if (!postfix && postfix != "") postfix = " ago";

    // Calculate distance between time and Date.now() in seconds, then turn it into
    // something more friendly.
    var d = (Date.now()-timeMS)/1000;
    var week = 604800, day = 86400, hour = 3600;

    if (d > (week*2)) return Math.round(d/week)+" weeks"   + postfix;
    if (d > ( day*2)) return Math.round(d/day) +" days"    + postfix;
    if (d > (hour*2)) return Math.round(d/hour)+" hours"   + postfix;
    if (d > (  60*2)) return Math.round(d/60)  +" minutes" + postfix;
    return Math.round(d)+" seconds" + postfix;
}


function getTimestampStr(useUTC)
{
    var d = new Date();

    if (useUTC)
    {
        var Y = d.getUTCFullYear();
        var M = d.getUTCMonth()+1;
        var D = d.getUTCDate();
        var h = d.getUTCHours();
        var m = d.getUTCMinutes();
        var s = d.getUTCSeconds();
        return sprintf("[%04d-%02d-%02d %02d:%02d:%02d]", Y, M, D, h, m, s);
    }
    else
    {
        var Y = d.getFullYear();
        var M = d.getMonth()+1;
        var D = d.getDate();
        var h = d.getHours();
        var m = d.getMinutes();
        var s = d.getSeconds();
        var z = -(d.getTimezoneOffset()/60);
        return sprintf("[%04d-%02d-%02d %02d:%02d:%02d UTC%+f]", Y, M, D, h, m, s, z);
    }

}


// Returns array of the count 'topmost' keys in obj. 'topmost' is defined by the given compareFunc,
// which is passed two values associated with two keys in obj, and should return true if the first
// is to be considered larger/higher than the second.
function getTop(count, obj, compareFunc)
{
    var top = [];

    for (var key in obj)
    {
        for (var i = 0; i < count; i++)
        {
            if (!top[i] || compareFunc(obj[key], obj[top[i]]))
            {
                top.splice(i, 0, key);
                top.length = count; // Trim here so it doesnt grow too big
                break;
            }
        }
    }

    return top;
}


// Return a random item from an array
function getRandom(arr)
{
    if (arr instanceof Array && arr.length)
    {
        return arr[Math.floor(arr.length*Math.random())];
    }

    return null;
}


// Run code in an isolated child process with timeout. Timeout is ignored when not a positive
// number. exitFunc is called when the code has been succesfully executed and is passed the result
// as first parameter, and a string representation of the value as second paramter (using
// util.inspect). On error, errorFunc is called with a string indicating the type of error and an
// optional message. TODO: Maybe exceptions are a better way to handle errors here
function runCode(evalCode, timeout, exitFunc, errorFunc)
{
    var output = "";
    var outputErr = "";
    var timedOut = false;
    var timeoutHandle;

    var child = require("child_process").spawn("node", [__dirname+"/eval-child.js"]);

    // Kill child process after timeout ms, if given
    if (timeout > 0)
    {
        timeoutHandle = setTimeout(function ()
            {
                child.kill('SIGKILL');
                timedOut = true;
            },
            timeout);
    }

    // Write the code that is to be evaluated to child's stdin and immediately close the stream
    child.stdin.end(evalCode);

    child.stdout.on("data", function (data) { output    += data; });
    child.stderr.on("data", function (data) { outputErr += data; });

    child.on("exit", function (code, signal)
    {
        if (timedOut)
        {
            errorFunc("timeout");
        }
        else if (code == 0)
        {
            try
            {
                var evalResult = JSON.parse(output);
            }
            catch (err)
            {
                errorFunc("unknown", "something bad happened, child produced invalid JSON: " + err);
                return;
            }

            if (!evalResult.error)
                exitFunc(evalResult.value, evalResult.valueStr);
            else
                errorFunc("code_error", evalResult.errorMsg);
        }
        else
        {
            // A bit hacky, but there doesn't seem to be a better way to detect this..
            if (outputErr.search(/JS Allocation failed/i))
                errorFunc("memory");
            else
                errorFunc("unknown", "child exited with error code " + code + ", and signal " +
                                     signal);
        }

        if (timeoutHandle) clearTimeout(timeoutHandle);
    });
}


/**
sprintf() for JavaScript 0.7-beta1
http://www.diveintojavascript.com/projects/javascript-sprintf

Copyright (c) Alexandru Marasteanu <alexaholic [at) gmail (dot] com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of sprintf() for JavaScript nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL Alexandru Marasteanu BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

**/
var sprintf = (function() {
    function get_type(variable) {
        return Object.prototype.toString.call(variable).slice(8, -1).toLowerCase();
    }
    function str_repeat(input, multiplier) {
        for (var output = []; multiplier > 0; output[--multiplier] = input) {/* do nothing */}
        return output.join('');
    }

    var str_format = function() {
        if (!str_format.cache.hasOwnProperty(arguments[0])) {
            str_format.cache[arguments[0]] = str_format.parse(arguments[0]);
        }
        return str_format.format.call(null, str_format.cache[arguments[0]], arguments);
    };

    str_format.format = function(parse_tree, argv) {
        var cursor = 1, tree_length = parse_tree.length, node_type = '', arg, output = [], i, k, match, pad, pad_character, pad_length;
        for (i = 0; i < tree_length; i++) {
            node_type = get_type(parse_tree[i]);
            if (node_type === 'string') {
                output.push(parse_tree[i]);
            }
            else if (node_type === 'array') {
                match = parse_tree[i]; // convenience purposes only
                if (match[2]) { // keyword argument
                    arg = argv[cursor];
                    for (k = 0; k < match[2].length; k++) {
                        if (!arg.hasOwnProperty(match[2][k])) {
                            throw(sprintf('[sprintf] property "%s" does not exist', match[2][k]));
                        }
                        arg = arg[match[2][k]];
                    }
                }
                else if (match[1]) { // positional argument (explicit)
                    arg = argv[match[1]];
                }
                else { // positional argument (implicit)
                    arg = argv[cursor++];
                }

                if (/[^s]/.test(match[8]) && (get_type(arg) != 'number')) {
                    throw(sprintf('[sprintf] expecting number but found %s', get_type(arg)));
                }
                switch (match[8]) {
                    case 'b': arg = arg.toString(2); break;
                    case 'c': arg = String.fromCharCode(arg); break;
                    case 'd': arg = parseInt(arg, 10); break;
                    case 'e': arg = match[7] ? arg.toExponential(match[7]) : arg.toExponential(); break;
                    case 'f': arg = match[7] ? parseFloat(arg).toFixed(match[7]) : parseFloat(arg); break;
                    case 'o': arg = arg.toString(8); break;
                    case 's': arg = ((arg = String(arg)) && match[7] ? arg.substring(0, match[7]) : arg); break;
                    case 'u': arg = Math.abs(arg); break;
                    case 'x': arg = arg.toString(16); break;
                    case 'X': arg = arg.toString(16).toUpperCase(); break;
                }
                arg = (/[def]/.test(match[8]) && match[3] && arg >= 0 ? '+'+ arg : arg);
                pad_character = match[4] ? match[4] == '0' ? '0' : match[4].charAt(1) : ' ';
                pad_length = match[6] - String(arg).length;
                pad = match[6] ? str_repeat(pad_character, pad_length) : '';
                output.push(match[5] ? arg + pad : pad + arg);
            }
        }
        return output.join('');
    };

    str_format.cache = {};

    str_format.parse = function(fmt) {
        var _fmt = fmt, match = [], parse_tree = [], arg_names = 0;
        while (_fmt) {
            if ((match = /^[^\x25]+/.exec(_fmt)) !== null) {
                parse_tree.push(match[0]);
            }
            else if ((match = /^\x25{2}/.exec(_fmt)) !== null) {
                parse_tree.push('%');
            }
            else if ((match = /^\x25(?:([1-9]\d*)\$|\(([^\)]+)\))?(\+)?(0|'[^$])?(-)?(\d+)?(?:\.(\d+))?([b-fosuxX])/.exec(_fmt)) !== null) {
                if (match[2]) {
                    arg_names |= 1;
                    var field_list = [], replacement_field = match[2], field_match = [];
                    if ((field_match = /^([a-z_][a-z_\d]*)/i.exec(replacement_field)) !== null) {
                        field_list.push(field_match[1]);
                        while ((replacement_field = replacement_field.substring(field_match[0].length)) !== '') {
                            if ((field_match = /^\.([a-z_][a-z_\d]*)/i.exec(replacement_field)) !== null) {
                                field_list.push(field_match[1]);
                            }
                            else if ((field_match = /^\[(\d+)\]/.exec(replacement_field)) !== null) {
                                field_list.push(field_match[1]);
                            }
                            else {
                                throw('[sprintf] huh?');
                            }
                        }
                    }
                    else {
                        throw('[sprintf] huh?');
                    }
                    match[2] = field_list;
                }
                else {
                    arg_names |= 2;
                }
                if (arg_names === 3) {
                    throw('[sprintf] mixing positional and named placeholders is not (yet) supported');
                }
                parse_tree.push(match);
            }
            else {
                throw('[sprintf] huh?');
            }
            _fmt = _fmt.substring(match[0].length);
        }
        return parse_tree;
    };

    return str_format;
})();

var vsprintf = function(fmt, argv) {
    argv.unshift(fmt);
    return sprintf.apply(null, argv);
};


exports.get                 = get;
exports.getFriendlyTime     = getFriendlyTime;
exports.getTimestampStr     = getTimestampStr;
exports.getTop              = getTop;
exports.getRandom           = getRandom;
exports.runCode             = runCode;
exports.sprintf             = sprintf;
exports.vsprintf            = vsprintf;

