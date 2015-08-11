const async = require('async');
const chalk = require('chalk');
const child_process = require('child_process');
const file = require('./file');
const fs = require('fs-extra');
const gspdata = require('./util/gspdata');
const minimatch = require('minimatch');
const net = require('net');
const nodegit = require('nodegit');
const path = require('path');
const upa = require('upa');

let createSocket = function (options) {
    let server = net.createServer(), timer;
    server.on('listening', function () {
        options.listening(server.address().port);
        timer = setTimeout(function () {
            server.getConnections(function (err, count) {
                if (err || count === 0) {
                    options.error('Can not connect to server, timeout.');
                    server.close();
                }
            });
        }, 10000);
    });
    server.on('connection', function (socket) {
        let orignalWrite = socket.write;
        socket.write = function () {
            arguments[0] += '@@@';
            return orignalWrite.apply(socket, arguments);
        };
        options.connection(socket);
        server.close();
    });
    server.on('error', function (e) {
        options.error(e.message);
        server.close();
    });
    server.on('close', function () {
        clearTimeout(timer);
    });
    server.listen();
};

let SVN = (function () {
    let commands = ['status', 'update', 'add', 'rm', 'commit'];
    let method = function (command, args, cwd, callback) {
        child_process.exec('svn ' + command + ' ' + args, {cwd: cwd}, callback);
    };
    let constructor = function (cwd) {this.cwd = cwd;};
    commands.forEach(function (command) {
        constructor.prototype[command] = function (args, callback) {
            if (typeof args === 'function') {
                callback = args;
                args = '';
            }
            method(command, args, this.cwd, callback);
        };
    });
    return constructor;
})();

let readFileCommit = function (filename, commit, callback, buffer) {
    commit.getEntry(filename).then(function(entry) {
        if (entry.isTree()) {
            callback(new Error(filename + ' is a directory.'));
            return;
        }
        entry.getBlob().then(function(blob) {
            callback(null, buffer ? blob.content() : blob.toString());
        }, callback);
    }, callback);
};

let getConcatConfig = function (commit, callback) {
    readFileCommit('concatfile.json', commit, function (err, data) {
        let c;
        try {
            c = JSON.parse(data);
        }
        catch (e) {
            callback(new Error('concatfile.json isn\'t a valid JSON file.'));
            return;
        }
        c.pkg = c.pkg || {};
        c.ext = c.ext || {};
        c.rfs = {};
        Object.keys(c.pkg).forEach(function (pkgPath) {
            if (!Array.isArray(c.pkg[pkgPath])) {
                c.pkg[pkgPath] = [c.pkg[pkgPath]];
            }
        });
        Object.keys(c.pkg).forEach(function (pkgPath, index, pkgArray) {
            let rfs = [];
            pkgArray.slice(0, index)
            .concat(pkgArray.slice(index))
            .forEach(function (pkgPathOther) {
                c.pkg[pkgPathOther].some(function (filepath) {
                    if (minimatch(pkgPath, filepath)) {
                        rfs.push(pkgPathOther);
                        return true;
                    }
                });
            });
            c.rfs[pkgPath] = rfs;
        });
        callback(null, c);
    });
}

let getDiff = function (commit, config, diff, callback) {
    let concatConfigs;
    async.waterfall([
        function (callback) {
            concatConfigs = gspdata.get('concat', config.id);
            if (diff['concatfile.json'] === 1 || diff['concatfile.json'] === 3 || !concatConfigs) {
                getConcatConfig(commit, function (err, cc) {
                    if (!err) {
                        concatConfigs = cc;
                        gspdata.set('concat', config.id, cc)
                    }
                    callback(err);
                });
            }
            else {
                callback();
            }
        },
        function (callback) {

            let addRfs = function (filename) {
                if (concatConfigs.rfs[filename]) {
                    concatConfigs.rfs[filename].forEach(function (f) {
                        if (!diff[f]) {
                            diff[f] = 3;
                            addRfs(f);
                        }
                    });
                }
            };

            Object.keys(diff).forEach(function (filename) {
                Object.keys(concatConfigs.pkg).forEach(function (pkg) {
                    return concatConfigs.pkg[pkg].some(function (include) {
                        if (minimatch(filename, include)) {
                            diff[pkg] = 3;
                            return true;
                        }
                        else {
                            return false;
                        }
                    });
                });
            });

            Object.keys(diff).forEach(addRfs);

            callback();
        }

    ], function (err) {
        callback(err, diff);
    });
};

let getExtDiffs = function (diffs, configs) {
    let wholeConcatConfigs = gspdata.get('concat');
    let externalRepos = {};
    Object.keys(wholeConcatConfigs).forEach(function (repoId) {
        if (configs.id === repoId) {
            return;
        }
        let extDiffs = {};
        Object.keys(wholeConcatConfigs[repoId].ext).forEach(function (extfilepath) {
            let ext = wholeConcatConfigs[repoId].ext[extfilepath];
            if (ext.repo === configs.id && diffs[ext.uri] !== undefined) {
                Object.keys(wholeConcatConfigs[repoId].pkg).forEach(function (pkgfilepath) {
                    wholeConcatConfigs[repoId].pkg[pkgfilepath].some(function (filepath) {
                        if (minimatch(extfilepath, filepath)) {
                            extDiffs[pkgfilepath] = 3;
                            return true;
                        }
                    });
                });
            }
        });
        if (Object.keys(extDiffs).length) {
            externalRepos[repoId] = extDiffs;
        }
    });
    return externalRepos;
};

let transport = function (diffs, configs, auth, socket, globalCallback) {
    let base = process.cwd(), dirname, svn;

    async.waterfall([
        function (callback) {
            if (configs.mapping_dir) {
                dirname = path.join(base, '.svnrepo', configs.mapping_dir);
                svn = new SVN(dirname);
                if (fs.existsSync(dirname)) {
                    callback();
                }
                else {
                    let mappingDir = path.join(base, '.svnrepo');
                    async.eachSeries(configs.mapping_dir.split('/'), function (dir, c) {
                        mappingDir = path.join(mappingDir, dir);
                        if (!fs.existsSync(mappingDir)) {
                            fs.mkdirSync(mappingDir);
                            child_process.exec('svn add ' + mappingDir, function () {
                                child_process.exec('svn ci -m "create gsp mapping directory" ' + auth.svnauth + ' ' + mappingDir, function (err) {
                                    if (err) {
                                        err = err.message.trim().match(/[^\n]+$/)[0];
                                        if (err.indexOf('E170001') > -1) {
                                            err = new Error('svn: authentication failed for ' + auth.author);
                                        }
                                        else {
                                            err = new Error(err);
                                        }
                                        fs.rmdirSync(mappingDir);
                                    }
                                    c(err);
                                });
                            });
                        }
                        else {
                            c();
                        }
                    }, callback);
                }
            }
            else {
                callback(new Error('mapping_dir is not configed.'));
            }
        },
        function (callback) {
            svn.update(auth.svnauth, function (err) {
                if (err) {
                    err = err.message.trim().match(/[^\n]+$/)[0];
                    if (err.indexOf('E170001') > -1) {
                        err = new Error('svn: authentication failed for ' + auth.author);
                    }
                    else {
                        err = new Error(err);
                    }
                }
                callback(err);
            });
        },
        function (callback) {
            async.each(Object.keys(diffs), function (filepath, c) {
                let filecontent = diffs[filepath];
                let absolutefilepath = path.join(dirname, path.relative(configs['publish_dir'], filepath));
                if (filecontent === false) {
                    fs.unlinkSync(absolutefilepath);
                }
                else {
                    fs.outputFileSync(absolutefilepath, filecontent);
                }
                c();
            }, callback);
        },
        function (callback) {
            svn.status(function (err, stdout) {
                callback(err, stdout);
            });
        },
        function (svnst, callback) {
            async.eachSeries(svnst.match(/[?!]\s+\S+/mg) || [], function (entry, c) {
                let st = entry.slice(0, 1);
                let filename = entry.slice(1).trim();
                if (st === '?') {
                    svn.add(filename, function (err, stdout) {
                        if (/^A/.test(stdout)) {
                            c();
                        }
                        else {
                            c(err);
                        }
                    });
                }
                else if (st === '!') {
                    svn.rm(filename, function (err, stdout) {
                        if (/^D/.test(stdout)) {
                            c();
                        }
                        else {
                            c(err);
                        }
                    });
                }
            }, function (err) {
                if (err) {
                    callback(err);
                }
                else {
                    svn.commit('-m "' + auth.message + '" ' + auth.svnauth, function (err, stdout) {
                        if (err) {
                            err = err.message.trim().match(/[^\n]+$/)[0];
                            if (err.indexOf('E170001') > -1) {
                                err = new Error('svn: authentication failed for ' + auth.author);
                            }
                            else {
                                err = new Error(err);
                            }
                            callback(err);
                        }
                        else {
                            let version = /\s(\d+)\D*$/.exec(stdout);
                            if (version) {
                                version = version[1];
                                let svndir = path.relative(base, dirname).replace('.svnrepo/', '');
                                stdout.match(/^(?:Add|Send|Delet)ing.+$/mg).forEach(function (filename) {
                                    filename = filename.match(/\S+$/)[0];
                                    if (fs.statSync(path.join(dirname, filename)).isFile()) {
                                        socket.write('Committing ' + version + '/' + path.join(svndir, filename));
                                    }
                                });
                            }
                            callback();
                        }
                    });
                }
            });
        }
    ], globalCallback);
};

let publish = function (repo, repoId, repoRev, diffs, auth, socket, globalCallback) {
    let commit, configs;
    async.waterfall([
        function (callback) {
            repo.getCommit(repoRev).then(function (c) {
                commit = c;
                callback();
            }, callback);
        },
        function (callback) {
            readFileCommit('.gspconfig', commit, function (err, data) {
                if (err) {
                    callback(err);
                }
                else {
                    try {
                        configs = JSON.parse(data);
                        configs.id = repoId;
                    }
                    catch (e) {
                        callback(new Error('.gspconfig isn\'t a valid JSON file.'));
                        return;
                    }
                    callback();
                }
            });
        },
        function (callback) {
            if (diffs) {
                callback();
                return;
            }
            commit.getDiff().then(function (diffList) {
                diffs = {};
                diffList.forEach(function (diff) {
                    diff.patches().forEach(function (cp) {
                        // 1:add 2:delete 3:modify
                        diffs[cp.newFile().path()] = cp.status();
                    });
                });
                callback();
            });
        },
        function (callback) {
            getDiff(commit, configs, diffs, function (err, diff) {
                if (!err) {
                    if (configs['publish_dir']) {
                        Object.keys(diff).forEach(function (filename) {
                            if (!minimatch(filename, path.join(configs['publish_dir'], '**'))) {
                                delete diff[filename];
                            }
                        });
                    }
                    diffs = diff;
                }
                callback(err);
            });
        },
        function (callback) {
            async.eachLimit(Object.keys(diffs), 5, function (filename, c) {
                if (diffs[filename] === 2) {
                    diffs[filename] = false;
                    c();
                    return;
                }
                let f = new file.Concat();
                f.set('workdir', commit);
                f.set('filename', filename);
                f.set('config', configs);
                f.read(function (err, data) {
                    if (!err) {
                        diffs[filename] = data;
                    }
                    c(err);
                });
            }, callback);
        },
        function (callback) {
            if (typeof auth === 'object') {
                callback();
                return;
            }
            let message = commit.message();
            if (auth) {
                message += '\n\nWarning: author for this commit has been rewrited, the orignal author is ' + commit.committer().name();
            }
            else {
                auth = commit.committer().name();
            }
            auth = {
                author: auth,
                message: message,
                svnauth: '--username "' + auth + '" --password "' + upa.get(auth) + '" --no-auth-cache --non-interactive'
            };
            callback();
        },
        function (callback) {
            transport(diffs, configs, auth, socket, callback);
        },
        function (callback) {
            let extDiffs = getExtDiffs(diffs, configs);
            auth.message = 'Recompile automatically because some of the content which belongs to another repository updated\n'
                            + 'repository: ' + configs.id + '\n'
                            + 'message:' + auth.message;
            async.map(Object.keys(extDiffs), function (repoId, c) {
                let repoLocation = gspdata.get('repositories', repoId);
                let repoRev = gspdata.get('changeset', repoId);
                if (repoLocation && repoRev) {
                    nodegit.Repository.openBare(repoLocation).then(function (externalRepo) {
                        publish(externalRepo, repoId, repoRev, extDiffs[repoId], auth, socket, function (err) {
                            if (err) {
                                socket.write(chalk.red(err));
                            }
                            c();
                        });
                    });
                }
                else {
                    c();
                }
            }, callback);
        }
    ], globalCallback);
};

exports.publish = function (options) {
    let cwd = process.cwd();
    let repoRev = gspdata.get('changeset', options.repo);
    let repoLocation = path.join(cwd, '.gitrepos', options.repo) + '.git';

    if (!fs.existsSync(repoLocation)) {
        options.callback(chalk.red('There\'s no repository named ' + options.repo + '.'));
        return;
    }

    child_process.exec('git fetch origin master:master', {cwd: repoLocation}, function () {
        let revRange = 'git rev-list --reverse --first-parent ';
        if (options.skip) {
            revRange += options.skip + '..HEAD';
        }
        else {
            if (repoRev) {
                revRange += repoRev + '..HEAD';
            }
            else {
                revRange += 'HEAD';
            }
        }
        child_process.exec(revRange, {cwd: repoLocation}, function (err, stdout, stderr) {
            if (stderr) {
                options.callback(stderr);
                return;
            }
            let revlist = stdout.match(/\S+/g);
            if (!revlist) {
                options.callback('No changesets needed to be published.');
                return;
            }
            if (options.preview) {
                options.callback(revlist.join('\n'));
                return;
            }
            createSocket({
                listening: function (remote) {
                    options.callback(remote.toString());
                },
                connection: function (socket) {
                    nodegit.Repository.openBare(repoLocation).then(function (repository) {
                        async.eachSeries(revlist, function (rev, callback) {
                            socket.write('Publish changeset ' + rev.slice(0, 7));
                            publish(repository, options.repo, rev, null, options.author, socket, function (err) {
                                if (err) {
                                    socket.write(chalk.red(err.message));
                                }
                                else {
                                    gspdata.set('changeset', options.repo, rev);
                                }
                                socket.write('\r \r');
                                callback(err);
                            });
                        }, function (err) {
                            if (err) {
                                socket.write(chalk.bold.red('Publish didn\'t finish due to errors.'));
                            }
                            else {
                                socket.write(chalk.bold.green('Publish finished, without errors.'));
                            }
                            socket.end();
                        });
                    });
                },
                error: function () {
                    options.callback(chalk.red('Server error, try again later.'));
                }
            });
        });
    });
};
