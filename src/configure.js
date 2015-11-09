const async = require('async');
const chalk = require('chalk');
const child_process = require('child_process');
const config = require('./util/config');
const gspdata = require('./util/gspdata');
const fs = require('fs');
const path = require('path');
const nodegit = require('nodegit');

exports.configure = function () {
    let cwd = process.cwd();
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
            console.log('Starting cloning publish repository...');
            if (fs.existsSync(path.join(cwd, '.svnrepo'))) {
                callback();
            }
            else {
                if (options.svnrepo.type === 'svn') {
                    let cp = child_process.spawn(
                        'svn',
                        [
                            'co',
                            options.svnrepo.url,
                            '--username',
                            options.svnrepo.name,
                            '--password',
                            options.svnrepo.password,
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
                else if (options.svnrepo.type === 'git') {
                    nodegit.Clone.clone(options.svnrepo.url, cwd + '/.svnrepo').then(function () {
                        console.log('Clone finished.');
                        callback();
                    }, callback);
                }
                else {
                    console.log(chalk.red('Wrong type of publish repository.'));
                    callback(true);
                }
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
