const async = require('async');
const gspdata = require('./util/gspdata');
const isBinaryPath = require('is-binary-path');
const path = require('path');
const minimatch = require('minimatch');
const nodegit = require('nodegit');

const DEFAULT_PREPROCESSOR_CONFIG = {
    "coffee": ["coffee", "modular"],
    "less": ["less"],
    "js": ["modular"]
};

class File {

    constructor(workdir, filename, config) {
        this.workdir = workdir;
        this.filename = filename;
        this.config = config;
        this.filedata = null;
    }

    get(key) {
        return this[key];
    }

    set(key, value) {
        this[key] = value;
    }

    readFileCommit(callback) {
        let filename = this.filename;
        this.workdir.getEntry(filename).then(function(entry) {
            if (entry.isTree()) {
                callback(new Error(filename + ' is a directory.'));
                return;
            }
            entry.getBlob().then(function(blob) {
                callback(null, blob.content());
            }, callback);
        }, callback);
    }

    read(callback) {
        this.readFileCommit((err, filedata) => {
            if (isBinaryPath(this.filename)) {
                this.filedata = filedata;
                callback(null, filedata);
                return;
            }
            this.filedata = filedata.toString();
            this.preprocess((err) => {
                callback(err, this.filedata);
            });
        });
    }

    preprocess(callback) {
        let preprocessorConfig = this.config.preprocessors || DEFAULT_PREPROCESSOR_CONFIG;
        async.eachSeries(Object.keys(preprocessorConfig), (extname, callback) => {
            if (path.extname(this.filename).slice(1) === extname) {
                async.eachSeries(preprocessorConfig[extname], (preprocessor, callback) => {
                    let mod;
                    try {
                        mod = require(`./preprocessors/${preprocessor}`);
                    }
                    catch (e) {
                        callback();
                        return;
                    }
                    mod(this, callback);
                }, callback);
            }
            else {
                callback();
            }
        }, callback);
    }

}

File.$inject = ['workdir', 'filename', 'config'];

class Concat extends File {

    constructor() {
        super();
        this.concatconfig = null;
    }

    read(callback) {
        if (isBinaryPath(this.filename)) {
            super.read(callback);
        }
        else {
            this.getconcatconfig((err, concatconfig) => {
                if (err) {
                    callback(err);
                }
                else {
                    this.concatconfig = concatconfig;
                    this.concatFiles(this.filename, callback);
                }
            });
        }
    }

    getconcatconfig(callback) {
        let file = new File(this.workdir, 'concatfile.json', this.config);
        file.read((err, filedata) => {
            if (err) {
                callback(null, {});
            }
            else {
                try {
                    filedata = JSON.parse(filedata);
                }
                catch (e) {
                    callback(new Error('concatfile.json isn\'t a valid JSON file.'));
                    return;
                }
                callback(null, filedata);
            }
        });
    }

    concatFiles(filename, callback) {

        let flattenFiles = [];

        if (!this.concatconfig.pkg[filename]) {
            this.concatconfig.pkg[filename] = [filename.replace(path.extname(filename), '.*')];
        }
        else if (typeof this.concatconfig.pkg[filename] === 'string') {
            this.concatconfig.pkg[filename] = [this.concatconfig.pkg[filename]];
        }

        async.eachSeries(this.concatconfig.pkg[filename], (file, c) => {
            let ignore = false;
            if (file.indexOf('!') === 0) {
                file = file.slice(1);
                ignore = true;
            }
            this.flattenFiles(file, (err, files) => {
                for (let f of files) {
                    let index = flattenFiles.indexOf(f);
                    if (index === -1) {
                        if (!ignore) {
                            flattenFiles.push(f);
                        }
                    }
                    else {
                        if (ignore) {
                            flattenFiles.splice(index, 1);
                        }
                    }
                }
                c();
            });
        }, () => {

            async.mapSeries(flattenFiles, (file, c) => {
                let ext = this.concatconfig.ext && this.concatconfig.ext[file];
                if (ext) {
                    if (gspdata.get('repositories', ext.repo)) {
                        this.getExternalFile(gspdata.get('repositories', ext.repo), ext.uri, c);
                    }
                    else {
                        c(new Error('Repository ' + ext.repo + ' doesn\'t exits'));
                    }
                }
                else if (this.concatconfig.pkg[file] && file !== filename) {
                    this.concatFiles(file, c);
                }
                else {
                    file = new File(this.workdir, file, this.config);
                    file.read((err, filedata) => {
                        if (!err) {
                            filedata = `/* from ${file.get('filename')} */\n` + filedata;
                        }
                        c(err, filedata);
                    });
                }
            }, (err, result) => {
                callback(err, result.join('\n'));
            });

        });
    }

    flattenFiles(filename, callback) {
        if (filename.indexOf('*') === -1) {
            callback(null, [filename]);
            return;
        }
        let wildcardStart = filename.indexOf('*');
        let cwd = filename.slice(0, wildcardStart).replace(/[^\/]*$/, '');
        let readCommitTree = function (t, callback) {
            t.getTree().then(function (tree) {
                if (tree.path().indexOf(cwd) === 0 || cwd.indexOf(tree.path()) === 0) {
                    async.concatSeries(tree.entries(), function (te, cb) {
                        if (te.isTree()) {
                            readCommitTree(te, cb);
                        }
                        else {
                            if (minimatch(te.path(), filename)) {
                                cb(null, [te.path()]);
                            }
                            else {
                                cb(null, []);
                            }
                        }
                    }, callback);
                }
                else {
                    callback(null, []);
                }
            });
        };
        readCommitTree(this.workdir, callback);
    }

    getExternalFile(repoPath, filename, callback) {
        nodegit.Repository.openBare(repoPath).then(function (repository) {
            repository.getMasterCommit().then(function (commit) {
                commit.getEntry('.gspconfig').then(function(entry) {
                    entry.getBlob().then(function(blob) {
                        let config;
                        try {
                            config = JSON.parse(blob.toString());
                        }
                        catch (e) {
                            config = {};
                        }
                        let file = new Concat();
                        file.set('workdir', commit);
                        file.set('filename', filename);
                        file.set('config', config);
                        file.read(callback);
                    }, callback);
                }, callback);
            });
        });
    }
}

Concat.$inject = [];

exports.File = File;
exports.Concat = Concat;
