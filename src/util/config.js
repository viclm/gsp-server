const path = require('path');

let options;

exports.set = function (o) {
    options = o;
};

exports.get = function () {
    return arguments.length > 0 ? options[arguments[0]] : options;
};

require(path.join(process.cwd(), 'gss.conf.js'))(exports);
