const Imagemin = require('imagemin');
const path = require('path');

const COMPRESS_ENGINE = {
    png: 'optipng',
    jpg: 'jpegtran',
    gif: 'gifsicle'
};

let compress = function (filename, filecontent, options, callback) {

    let extname = path.extname(filename).slice(1);

    if (!COMPRESS_ENGINE[extname]) {
        callback(null, filecontent);
        return;
    }

    new Imagemin()
    .src(filecontent)
    .use(Imagemin[COMPRESS_ENGINE[extname]](options[extname] === true ? {} : options[extname]))
    .optimize(function (err, file) {
        callback(err, file && file.contents);
    });
};

module.exports = function (file, callback) {
    compress(file.get('filename'), file.get('filedata'), file.get('config').compress, function (err, filedata) {
        if (!err) {
            file.set('filedata', filedata);
        }
        callback(err);
    });
};