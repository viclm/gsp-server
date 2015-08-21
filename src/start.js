const chalk = require('chalk');
const config = require('./util/config');
const domain = require('domain');
const forever = require('forever');
const http = require('http');
const url = require('url');
const upa = require('upa');
const path = require('path');
const publish = require('./publish').publish;

let routers = {

    publish: function (querydata, callback) {
        querydata.callback = callback;
        publish(querydata);
    },

    pull: function (querydata, callback) {
        let configFile = path.join(process.cwd(), 'gss.conf.js');
        require(configFile)(config);
        let options = config.get().gitrepos;
        let gitrepos = options.urls;
        if (options.url_prefix) {
            gitrepos = gitrepos.map(function (url) {
                return options.url_prefix + url;
            });
        }
        callback(JSON.stringify(gitrepos));
        delete require.cache[configFile];
    },

    auth: function (querydata, callback) {
        upa.set(querydata.username, querydata.password);
        if (upa.get(querydata.username)) {
            callback(chalk.green('Authentication updated successfuly.'));
        }
        else {
            callback(chalk.red('Authentication updated failed.'));
        }
    }

};

let exception = function (error) {
    console.log(Date());
    console.log(error.stack + '\n');
    try {
        let killTimer = setTimeout(function () {
            process.exit(1);
        }, 30000);
        killTimer.unref();
    }
    catch (e) {
        console.log(e.stack);
    }
};

let start = function (options) {
    options.port = options.port || 7070;
    let server = http.createServer();
    server.on('request', function (request, response) {
        let d = domain.create();
        d.on('error', function (err) {
            server.close();
            exception(err);
        });
        d.run(function () {
            let urlparts = url.parse(request.url);
            let route = path.basename(urlparts.pathname);
            let querydata = JSON.parse(decodeURIComponent(urlparts.query));
            if (routers[route]) {
                routers[route](querydata, response.end.bind(response));
            }
            else {
                response.end(chalk.red('Unvalid request.'));
            }
        });
    });
    server.on('listening', function (err) {
        if (err) {
            console.log(chalk.red('Gsp server failed to start'));
        }
        else {
            console.log('Gsp server started, listening on port %s', options.port);
        }
    });
    server.listen(options.port);
    process.on('uncaughtException', function (err) {
        server.close();
        exception(err);
    });
};

exports.start = function (options) {
    options.cwd = options.cwd || process.cwd();
    process.chdir(options.cwd);
    if (options.nodaemon) {
        start(options);
    }
    else {
        let args = ['--nodaemon'];
        Object.keys(options).forEach(function (key) {
            let value = options[key];
            if (value !== undefined) {
                if (value === true) {
                    args.push('--' + key);
                }
                else {
                    args.push('--' + key + '=' + value);
                }
            }
        });
        forever.startDaemon('start', {
            command: 'gss',
            args: args,
            env: {FORCE_COLOR: true},
            logFile: path.join(options.cwd, 'gss.log')
        });
    }
};
