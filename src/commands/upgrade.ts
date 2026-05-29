import { performSelfUpgrade } from '../core/selfUpgrade';

export interface UpgradeCommandOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface UpgradeCommand {
  name: 'upgrade';
  description: string;
  run(options?: UpgradeCommandOptions): Promise<string>;
}

export function createUpgradeCommand(): UpgradeCommand {
  return {
    name: 'upgrade',
    description: 'Upgrade OpenClaw to the latest version',
    run(options: UpgradeCommandOptions = {}) {
      return performSelfUpgrade(options);
    },
  };
}
