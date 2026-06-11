import { env } from './config/env.js';
import { log } from './util/logger.js';
import type { RulesEngine } from './rules/engine.js';
import type { Store } from './queue/types.js';

export interface WorkerOptions {
  maxAttempts?: number;
  retryBackoffMs?: number;
}

/**
 * Scheduler/worker (Phase 4). Polls the queue for due actions and dispatches
 * them. This is the proactive clock — independent of webhooks — that delivers
 * scheduled sends and the `item_in_group_for_days` reminders.
 */

/** Process all actions due at `now`. Returns counts. Exposed for testing. */
export async function runDueActions(
  store: Store,
  engine: RulesEngine,
  now: number = Date.now(),
  opts: WorkerOptions = {},
): Promise<{ sent: number; failed: number; retried: number }> {
  const maxAttempts = opts.maxAttempts ?? env.workerMaxAttempts;
  const backoff = opts.retryBackoffMs ?? env.workerRetryBackoffMs;

  const due = store.dueActions(now);
  let sent = 0;
  let failed = 0;
  let retried = 0;
  for (const row of due) {
    try {
      await engine.dispatch(row.actionType, row.payload);
      store.markSent(row.id, Date.now());
      sent++;
    } catch (err) {
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        log.error(`Queued action ${row.id} (rule ${row.ruleId}) failed permanently after ${attempts} attempts`, err);
        store.markFailed(row.id);
        failed++;
      } else {
        log.warn(`Queued action ${row.id} failed (attempt ${attempts}/${maxAttempts}); retrying later.`);
        store.retryLater(row.id, now + backoff * attempts);
        retried++;
      }
    }
  }
  if (sent || failed || retried) {
    log.info(`Worker: ${sent} sent, ${retried} retrying, ${failed} failed.`);
  }
  return { sent, failed, retried };
}

export interface WorkerHandle {
  stop(): void;
}

export function startWorker(store: Store, engine: RulesEngine, intervalMs: number): WorkerHandle {
  const tick = () => {
    runDueActions(store, engine).catch((err) => log.error('Worker tick error', err));
  };
  const handle = setInterval(tick, intervalMs);
  handle.unref?.(); // don't keep the process alive solely for the timer
  log.info(`Scheduler/worker started (every ${Math.round(intervalMs / 1000)}s).`);
  tick(); // run once immediately on boot
  return { stop: () => clearInterval(handle) };
}
