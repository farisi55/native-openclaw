import { Command } from 'commander';
import { performSelfUpgrade } from '../core/selfUpgrade';

export function createUpgradeCommand() {
  return new Command('upgrade')
    .description('Upgrade OpenClaw to the latest version')
    .option('--dry-run', 'Show what would be upgraded without making changes')
    .option('--force', 'Force upgrade even if versions match')
    .action(async (options) => {
      try {
        const result = await performSelfUpgrade(options);
        console.log(result);
      } catch (error) {
        console.error('Upgrade failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}