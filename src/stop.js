const di = require('di');
const forever = require('forever');
const start = require('./start');

let stop = function (options, start) {
    options.cwd = options.cwd || process.cwd();
    forever.list(false, function (err, daemons) {
        let stoped = 0;
        (daemons || []).some(function (daemon, index) {
            if (daemon.command === 'gss') {
                let opt = {};
                for (let arg of daemon.args) {
                    arg = arg.slice(2).split('=');
                    opt[arg[0]] = arg[1] || true;
                }
                delete opt.nodaemon;
                if (options.all) {
                    stoped += 1;
                    forever.stop(index).on('stop', function () {
                        console.log('gsp server stoped');
                        if (options.restart) {
                            console.log('Restarting...');
                            start(opt);
                        }
                    });
                }
                else if (opt.cwd === options.cwd) {
                    stoped += 1;
                    forever.stop(index).on('stop', function () {
                        console.log('gsp server stoped');
                        if (options.restart) {
                            console.log('Restarting...');
                            start(opt);
                        }
                    });
                    return true;
                }
            }
        });
        if (stoped === 0) {
            console.log('No gsp server running.');
        }
    });
};

exports.stop = function (options) {
    let injector = new di.Injector([{
        options: ['value', options],
        start: ['value', start.start]
    }]);
    injector.invoke(stop);
};
