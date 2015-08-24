const async = require('async');
const chalk = require('chalk');
const child_process = require('child_process');
const config = require('./util/config');
const gspdata = require('./util/gspdata');
const fs = require('fs');
const path = require('path');
const upa = require('upa');

exports.configure = function () {
    let cwd = process.cwd();
    require(cwd + '/gss.conf.js')(config);
    let options = config.get();

    console.log('Configuring...');

    async.waterfall([
        function (callback) {
            if (!fs.existsSync(path.join(cwd, '.gitrepos'))) {
                fs.mkdirSync(path.join(cwd, '.gitrepos'));
            }
            console.log('Starting cloning git repositories...');
            async.eachLimit(options.gitrepos.urls, 5, function (repo, c) {
                if (fs.existsSync(path.join(cwd, '.gitrepos', path.basename(repo)))) {
                    c();
                }
                else {
                    console.log('Cloning ' + repo + '...');
                    child_process.exec('git clone --mirror ' + options.gitrepos.url_prefix + repo, {cwd: path.join(cwd, '.gitrepos')}, c);
                }
            }, callback);
        },
        function (callback) {
            fs.readdir(path.join(cwd, '.gitrepos'), function (err, result) {
                if (!err) {
                    let repoLocation = {};
                    result.forEach(function (repo) {
                        repoLocation[repo.slice(0, -4)] = path.join(cwd, '.gitrepos', repo);
                    });
                    gspdata.set('repositories', repoLocation);
                }
                callback(err);
            });
        },
        function (callback) {
            console.log('Starting cloning subversion repository...');
            if (fs.existsSync(path.join(cwd, '.svnrepo'))) {
                callback();
            }
            else {
                let username = upa.list()[0];
                let password = upa.get(username);
                let cp = child_process.spawn(
                    'svn',
                    [
                        'co',
                        options.svnrepo.url,
                        '--username',
                        username,
                        '--password',
                        password,
                        '--non-interactive',
                        cwd + '/.svnrepo'
                    ]
                );
                let cperror = null;
                cp.stdout.on('data', function (chunk) {
                    process.stdout.write(chunk.toString());
                });
                cp.stderr.on('data', function (chunk) {
                    process.stdout.write(chunk.toString());
                    cperror = true;
                });
                cp.stdout.on('end', function () {
                    callback(cperror);
                });
            }
        }
    ],
    function (err) {
        if (err) {
            console.log(chalk.red('Configure failed.'));
        }
        else {
            console.log(chalk.green('Configure finished.'));
            console.log('restarting...');
            require('./stop').stop({restart: true});
        }
    });
};
