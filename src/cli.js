const program = require('commander');
const pkg = require('../package.json');

let run = function (command) {
    require('./' + command.name())[command.name()](command.opts());
};

program
.version(pkg.version);

program
.command('help [cmd]')
.description('display help for [cmd]')
.action(function (cmd) {
    program.commands.some(function (command) {
        if (command.name() === cmd) {
            command.help();
        }
    });
    if (cmd) {
        console.log("'\s' is not a gss command. See 'gsp --help'.", cmd);
    }
    else {
        program.help();
    }
});

program
.command('configure')
.description('init/update a working directory')
.action(run);

program
.command('start')
.description('start a working server')
.option('--nodaemon', 'do not run server on daemon mode')
.option('--cwd <dir>', 'set the working directory, default is process.cwd()')
.option('-p, --port <port>', 'the port for the server listening')
.action(run);

program
.command('stop')
.option('--cwd <dir>', 'the working directory, default is process.cwd()')
.option('-a, --all', 'stop all the daemon servers')
.option('-r, --restart', 'restart server after stop')
.description('stop the working server')
.action(run);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.help();
}
