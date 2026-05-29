// @openclaw/self-upgrade-marker
import { createUpgradeCommand } from './commands/upgrade';
import { Command } from 'commander';

const program = new Command();

// Existing commands
program
  .name('openclaw')
  .description('OpenClaw CLI tool')
  .version('1.0.0');

// Add upgrade command
program.addCommand(createUpgradeCommand());

program.parse(process.argv);