// Simple node script that takes JS code from stdin, runs it in a sandboxed VM, and returns the
// resulting value inside a JSON-encoded object that is written to stdout. The purpose of this is
// to run code for the "eval" command in a properly isolated way (inside a node child process).

var vm   = require("vm");
var util = require("util");

var code = "";

process.stdin.resume();
process.stdin.setEncoding('utf8');

process.stdin.on('data', function (chunk)
{
    code += chunk;
});

process.stdin.on('end', function ()
{
    var evalResult = { "error": false };

    try
    {
        var res = vm.runInNewContext(code, {});
        evalResult.value = res;
    }
    catch (err)
    {
        evalResult.error = true;
        evalResult.value = err.toString();
    }

    process.stdout.write(JSON.stringify(evalResult));
});

