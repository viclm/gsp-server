const chalk = require('chalk');
const config = require('./util/config');
const domain = require('domain');
const forever = require('forever');
const http = require('http');
const url = require('url');
const upa = require('upa');
const path = require('path');
const publish = require('./publish').publish;

//chalk.enabled = true;

let routers = {

    publish: function (querydata, callback) {
        querydata.callback = callback;
        publish(querydata);
    },

    pull: function (querydata, callback) {
        let configFile = path.join(process.cwd(), 'gss.conf.js');
        require(configFile)(config);
        let options = config.get().development_repos;
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

let exception = function (err, request, response) {
    let query = JSON.parse(decodeURIComponent(url.parse(request.url).query));
    try {
        let killTimer = setTimeout(function () {
            process.exit(1);
        }, 30000);
        killTimer.unref();
        response.end(query.stack ? err.stack : err.message);
    }
    catch (e) {
        response.end(query.stack ? err.stack : e.message);
    }
};

let start = function (options) {
    options.port = options.port || 7070;
    let server = http.createServer();
    server.on('request', function (request, response) {
        let d = domain.create();
        d.on('error', function (err) {
            exception(err, request, response);
            server.close();
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
        process.on('uncaughtException', function (err) {
            exception(err, request, response);
            server.close();
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
            logFile: path.join(options.cwd, 'gss.log')
        });
    }
};
