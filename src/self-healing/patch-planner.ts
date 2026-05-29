import type { BugAnalysis, PatchPlan, UpgradeAnalysis } from './healing-types';

export class PatchPlanner {
  planBugFix(analysis: BugAnalysis): PatchPlan {
    return {
      files: analysis.affectedFiles.map((path) => ({
        path,
        action: 'update' as const,
        reason: analysis.fixStrategy,
      })),
      testStrategy: 'Run configured build and test commands.',
      riskLevel: analysis.confidence >= 0.7 ? 'low' : 'medium',
    };
  }

  planUpgrade(analysis: UpgradeAnalysis): PatchPlan {
    return {
      files: analysis.targetFiles.map((path) => ({
        path,
        action: 'update' as const,
        reason: analysis.implementationStrategy,
      })),
      testStrategy: 'Run configured build and test commands.',
      riskLevel: analysis.confidence >= 0.7 ? 'low' : 'medium',
    };
  }
}
