const assert = require('assert');

const {
  completionText,
  formatSlashCommandSuggestions,
  getSlashCommandSuggestions,
} = require('../dist/cli/command-registry');
const { createSlashCommandCompleter } = require('../dist/cli/autocomplete');

function commands(input) {
  return getSlashCommandSuggestions(input).map((item) => item.command);
}

assert(commands('/').includes('/help'), 'root slash suggestions include /help');
assert(commands('/').includes('/session list'), 'root slash suggestions include nested commands');
assert(commands('/s').includes('/session'), '/s suggests /session');
assert(commands('/s').includes('/session switch'), '/s suggests /session switch');
assert(commands('/session ').includes('/session list'), '/session space suggests subcommands');
assert(!commands('/session ').includes('/session'), '/session space excludes root /session');
assert.deepStrictEqual(commands('/mcp t'), ['/mcp tools'], '/mcp t narrows to /mcp tools');
assert.deepStrictEqual(commands('/network c'), ['/network check'], '/network c narrows to /network check');
assert(commands('/tools l').includes('/tools list'), '/tools l suggests /tools list');

const switchCommand = getSlashCommandSuggestions('/session sw')[0];
assert.strictEqual(completionText(switchCommand), '/session switch ', 'argument commands complete with trailing space');

const completer = createSlashCommandCompleter();
assert(completer('hello')[0].length === 0, 'normal chat text has no slash completion');
assert(completer('/work r')[0].includes('/workspace read '), 'readline completer returns slash completions');
assert(formatSlashCommandSuggestions('/session').includes('List all sessions'), 'formatter includes descriptions');

console.log('slash-autocomplete tests passed');
