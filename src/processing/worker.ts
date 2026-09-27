import type pg from 'pg';
import type { Logger } from 'pino';
import type { ModelProvider } from '../ai/provider.js';
import { purgeExpired } from '../store/control.js';
import { IslandNotFound } from '../store/islands.js';
import { claimJob, completeJob, failJob } from '../store/jobs.js';
import { processItem } from './pipeline.js';

export interface WorkerOptions {
  pollMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
}

/** Pulls jobs from the queue, one at a time. Logs carry ids and codes only. */
export class Worker {
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private wake: (() => void) | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly provider: ModelProvider,
    private readonly log: Logger,
    private readonly opts: WorkerOptions,
  ) {}

  /** Runs one job if one is due. Returns false when the queue is idle. */
  async tick(): Promise<boolean> {
    const job = await claimJob(this.pool);
    if (!job) return false;
    let result: string;
    try {
      result = await processItem(this.pool, this.provider, job.boardId, job.itemKey);
    } catch (err) {
      // Island dropped (board deleted) while the job was running: nothing left to do.
      if (!(err instanceof IslandNotFound)) throw err;
      result = 'skipped';
    }
    if (result === 'failed') {
      result = await failJob(this.pool, job, this.opts.maxAttempts, this.opts.backoffBaseMs);
    } else {
      await completeJob(this.pool, job);
    }
    this.log.info({ boardId: job.boardId, item: job.itemKey, result }, 'job');
    return true;
  }

  /** Processes due jobs until the queue is idle. */
  async drain(): Promise<number> {
    let n = 0;
    while (await this.tick()) n++;
    return n;
  }

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.tick();
        if (!busy) await purgeExpired(this.pool);
      } catch (err) {
        this.log.error(
          { code: (err as { code?: string }).code ?? 'worker_error' },
          'worker tick failed',
        );
      }
      if (!busy && this.running) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, this.opts.pollMs);
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }
}
