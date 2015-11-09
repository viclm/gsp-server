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
const gssconfig = require('./util/config');

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
        child_process.exec(`svn ${command} ${args}`, {cwd: cwd}, callback);
    };
    let constructor = function (repodir, mappingdir) {
        this.repodir = repodir;
        this.mappingdir = mappingdir;
        this.publishdir = path.join(this.repodir, this.mappingdir);
        if (!fs.existsSync(this.publishdir)) {
            child_process.execSync('mkdir -p ' + this.publishdir);
        }
        this.auth = gssconfig.get('svnrepo');
    };
    commands.forEach(function (command) {
        constructor.prototype[command] = function (args, callback) {
            if (typeof args === 'function') {
                callback = args;
                args = '';
            }
            if (typeof args === 'object') {
                let argsStr = '';
                for (let arg in args) {
                    argsStr += '--' + arg;
                    if (args[arg] !== true) {
                        argsStr += '=' + args[arg];
                    }
                }
                args = argsStr;
            }
            args += ` --username "${this.auth.name}" --password "${this.auth.password}" --no-auth-cache --non-interactive`;
            method(command, args, this.repodir, callback);
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
                let includeArray = [], excludeArray = [];
                for (let include of c.pkg[pkgPathOther]) {
                    if (include.charAt(0) === '!') {
                        excludeArray.push(include.slice(1));
                    }
                    else {
                        includeArray.push(include);
                    }
                }
                includeArray.some(function (include) {
                    if (minimatch(pkgPath, include)) {
                        if (!excludeArray.some(function (exclude) {
                            return minimatch(pkgPath, exclude);
                        })) {
                            rfs.push(pkgPathOther);
                            return true;
                        }
                    }
                });
            });
            c.rfs[pkgPath] = rfs;
        });
        callback(null, c);
    });
}

let getDiff = function (commit, config, diff, callback) {
    let concatConfigs = gspdata.get('concat', config.id);
    let getDiff = function () {

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
                let includeArray = [], excludeArray = [];
                for (let include of concatConfigs.pkg[pkg]) {
                    if (include.charAt(0) === '!') {
                        excludeArray.push(include.slice(1));
                    }
                    else {
                        includeArray.push(include);
                    }
                }
                return includeArray.some(function (include) {
                    if (minimatch(filename, include)) {
                        if (!excludeArray.some(function (exclude) {
                            return minimatch(filename, exclude);
                        })) {
                            diff[pkg] = 3;
                            return true;
                        }
                    }
                });
            });
        });

        Object.keys(diff).forEach(addRfs);

        if (config['publish_dir']) {
            Object.keys(diff).forEach(function (filename) {
                if (!minimatch(filename, path.join(config['publish_dir'], '**'))) {
                    delete diff[filename];
                }
            });
        }

        callback(null, diff);

    };

    if (diff['concatfile.json'] === 1 || diff['concatfile.json'] === 3 || !concatConfigs) {
        getConcatConfig(commit, function (err, cc) {
            if (err) {
                callback(err);
            }
            else {
                gspdata.set('concat', config.id, cc);
                concatConfigs = cc;
                getDiff();
            }
        });
    }
    else {
        getDiff();
    }
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

let transportToSVN = function (diffs, auth, configs, socket, globalCallback) {
    let publishRepo = path.join(process.cwd(), '.svnrepo'), svn;

    async.waterfall([
        function (callback) {
            if (configs.mapping_dir) {
                svn = new SVN(publishRepo, configs.mapping_dir);
                callback();
            }
            else {
                callback(new Error('mapping_dir is not configed.'));
            }
        },
        function (callback) {
            async.each(Object.keys(diffs), function (filepath, c) {
                let filecontent = diffs[filepath];
                let absolutefilepath = path.join(svn.publishdir, path.relative(configs['publish_dir'], filepath));
                if (filecontent === false) {
                    socket.write('Deleting ' + filepath + '...');
                    fs.unlink(absolutefilepath, function() {
                        c();
                    });
                }
                else {
                    socket.write('Copying ' + filepath + '...');
                    fs.outputFile(absolutefilepath, filecontent, c);
                }
            }, callback);
        },
        function (callback) {
            svn.status(function (err, stdout) {
                if (!err && !stdout) {
                    socket.write(chalk.yellow('Files have been commited already.'));
                }
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
            }, callback);
        },
        function (callback) {
            svn.commit(`-m "Author: ${auth.name}<${auth.email}>\n${auth.message}"`, function (err, stdout) {
                if (err) {
                    callback(err);
                }
                else {
                    let version = /\s(\d+)\D*$/.exec(stdout);
                    if (version) {
                        version = version[1];
                        stdout.match(/^(?:Add|Send)ing.+$/mg).forEach(function (filename) {
                            filename = filename.match(/\S+$/)[0];
                            if (fs.statSync(path.join(publishRepo, filename)).isFile()) {
                                socket.write('Committing ' + version + '/' + filename);
                            }
                        });
                    }
                    callback();
                }
            });
        }
    ], globalCallback);
};

let transportToGit = function (diffs, auth, configs, socket, globalCallback) {
    let publishRepo = path.join(process.cwd(), '.svnrepo'),
        publishConfig = gssconfig.get('svnrepo'), repository;

    async.waterfall([
        function (callback) {
            if (configs.mapping_dir) {
                if (!fs.existsSync(path.join(publishRepo, configs.mapping_dir))) {
                    child_process.execSync('mkdir -p ' + path.join(publishRepo, configs.mapping_dir));
                }
                callback();
            }
            else {
                callback(new Error('mapping_dir is not configed.'));
            }
        },
        function (callback) {
            async.each(Object.keys(diffs), function (filepath, c) {
                let filecontent = diffs[filepath];
                let absolutefilepath = path.join(publishRepo, configs.mapping_dir, path.relative(configs['publish_dir'], filepath));
                if (filecontent === false) {
                    socket.write('Deleting ' + filepath + '...');
                    fs.unlink(absolutefilepath, function() {
                        c();
                    });
                }
                else {
                    socket.write('Copying ' + filepath + '...');
                    fs.outputFile(absolutefilepath, filecontent, c);
                }
            }, callback);
        },
        function (callback) {
            nodegit.Repository.open(publishRepo).then(function (r) {
                repository = r;
                callback();
            }, callback);
        },
        function (callback) {
            repository.getStatus().then(function (status) {
                status = status.map(function (file) {
                    socket.write('Committing ' + file.path());
                    return file.path();
                });
                if (status.length) {
                    let author = nodegit.Signature.now(auth.name, auth.email);
                    let committer = nodegit.Signature.now(publishConfig.name, publishConfig.email);
                    repository.createCommitOnHead(status, author, committer, auth.message).then(function (oid) {
                        callback(null, oid.toString());
                    }, callback);
                }
                else {
                    callback(null, null);
                }
            }, callback);
        },
        function (oid, callback) {
            if (oid) {
                child_process.exec('git push origin master', {cwd: publishRepo}, function (err) {
                    if (err) {
                        callback(err);
                    }
                    else {
                        socket.write('Commited ' + oid);
                        callback();
                    }
                });
            }
            else {
                socket.write(chalk.yellow('Files have been commited already.'));
                callback();
            }
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
                async.each(diffList, function (diff, callback) {
                    diff.patches().then(function (arrayConvenientPatch) {
                        arrayConvenientPatch.forEach(function (cp) {
                            // 1:add 2:delete 3:modify
                            diffs[cp.newFile().path()] = cp.status();
                        });
                        callback();
                    });
                }, callback);
            });
        },
        function (callback) {
            getDiff(commit, configs, diffs, function (err, diff) {
                if (!err) {
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
                socket.write('Compiling ' + filename + '...');
                let f = new file.Concat();
                f.set('workdir', commit);
                f.set('filename', filename);
                f.set('config', configs);
                f.read(function (err, data) {
                    if (!err) {
                        delete diffs[filename];
                        diffs[f.get('filename')] = data;
                    }
                    c(err);
                });
            }, callback);
        },
        function (callback) {
            if (!auth) {
                auth = {
                    name: commit.author().name(),
                    email: commit.author().email(),
                    message: commit.message()
                };
            }
            let publishConfig = gssconfig.get('svnrepo');
            if (publishConfig.type === 'svn') {
                transportToSVN(diffs, auth, configs, socket, callback);
            }
            else if (publishConfig.type === 'git') {
                transportToGit(diffs, auth, configs, socket, callback);
            }
            else {
                callback(new Error('Wrong type of publish repository.'));
            }
        },
        function (callback) {
            let extDiffs = getExtDiffs(diffs, configs);
            auth.message = 'Recompile automatically because it contains content that belongs to anothor repository which has updated\n'
                            + 'repository: ' + configs.id + '\n'
                            + 'message:' + auth.message;
            async.eachSeries(Object.keys(extDiffs), function (repoId, c) {
                let repoLocation = gspdata.get('repositories', repoId);
                let repoRev = gspdata.get('changeset', repoId);
                if (repoLocation && repoRev) {
                    socket.write(`Republish repository ${repoId} which refers files updated in this commit.`);
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
                            publish(repository, options.repo, rev, null, null, socket, function (err) {
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
