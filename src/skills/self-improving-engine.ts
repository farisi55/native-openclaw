/**
 * skills/self-improving-engine.ts
 * Orchestrates the self-improving pipeline per completed turn.
 */

import { loadSkillFromFile } from './loader';
import type { SkillRegistry } from './registry';
import type { SkillExtractionInput } from './skill-extractor';
import { SkillExtractor } from './skill-extractor';
import { SkillWriter } from './skill-writer';
import { SkillQualityTracker } from './skill-quality-tracker';
import { SkillEvaluator } from './skill-evaluator';
import { createLogger } from '../utils/logger';

const logger = createLogger('skills:self-improving');

export class SelfImprovingEngine {
  constructor(
    private readonly extractor: SkillExtractor,
    private readonly writer: SkillWriter,
    private readonly tracker: SkillQualityTracker,
    private readonly evaluator: SkillEvaluator,
    private readonly registry: SkillRegistry
  ) {}

  async processCompletedTurn(input: SkillExtractionInput): Promise<void> {
    try {
      let skillId: string | null = null;
      const extracted = await this.extractor.extract(input);

      if (extracted) {
        const filePath = await this.writer.write(extracted);
        if (filePath) {
          const loaded = await loadSkillFromFile(filePath);
          if (loaded.ok) {
            this.registry.registerAndActivate(loaded.value);
            skillId = loaded.value.id;
            logger.info('new skill extracted and registered', {
              id: loaded.value.id,
              name: loaded.value.name,
              filePath,
            });
          } else {
            logger.warn('extracted skill could not be loaded', {
              filePath,
              error: loaded.error.message,
            });
          }
        }
      }

      await this.tracker.recordTaskCompletion(skillId, true);

      if (await this.tracker.shouldRunEvaluation()) {
        logger.info('running self-evaluation pass');
        await this.evaluator.evaluate(this.registry.all());
        await this.registry.load({ skillsDir: 'skills' });
        await this.tracker.resetEvaluationCounter();
      }
    } catch (err) {
      logger.warn('self-improving processing failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
