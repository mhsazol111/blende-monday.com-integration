import Fastify, { type FastifyInstance } from 'fastify';
import { env } from './config/env.js';
import { log } from './util/logger.js';
import { normalizeEvent } from './monday/normalizer.js';
import { RulesEngine } from './rules/engine.js';
import { loadRules } from './rules/loader.js';
import { SqliteStore } from './db/store.js';
import { startWorker } from './worker.js';
import { registerAdmin } from './web/admin.js';
import type { Store } from './queue/types.js';

/**
 * Webhook ingress (Phase 2/3). Responsibilities:
 *  - answer monday's one-time `challenge` handshake,
 *  - verify a shared secret before processing,
 *  - normalize the event and hand it to the rules engine.
 */

interface WebhookBody {
  challenge?: string;
  event?: Record<string, unknown>;
}

// Debug ring buffer: the last few raw webhook payloads + how they normalized.
// Exposed at GET /api/last-events to reconcile real monday payloads. Capped.
const recentEvents: unknown[] = [];
function recordEvent(entry: unknown) {
  recentEvents.unshift(entry);
  if (recentEvents.length > 20) recentEvents.length = 20;
}

/** Constant-time-ish secret check via query `?secret=` or `x-webhook-secret` header. */
function isAuthorized(req: { query: unknown; headers: Record<string, unknown> }): boolean {
  const expected = env.webhookSharedSecret;
  if (!expected) {
    // No secret configured — allowed, but warn so it isn't forgotten in prod.
    log.warn('WEBHOOK_SHARED_SECRET is not set — ingress is accepting unauthenticated requests.');
    return true;
  }
  const fromQuery = (req.query as { secret?: string } | undefined)?.secret;
  const fromHeader = req.headers['x-webhook-secret'];
  return fromQuery === expected || fromHeader === expected;
}

export function buildServer(engine?: RulesEngine, store?: Store): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ ok: true, service: 'monday-automation-service' }));
  app.get('/api/last-events', async () => ({ events: recentEvents }));

  // Configurator UI + its API (Phase 7).
  registerAdmin(app, engine);

  app.post('/webhook', async (request, reply) => {
    const body = (request.body ?? {}) as WebhookBody;

    // 1) monday challenge handshake — must echo before any auth check.
    if (body.challenge) {
      log.info('Responded to monday challenge handshake.');
      return reply.send({ challenge: body.challenge });
    }

    // 2) shared-secret verification.
    if (!isAuthorized(request)) {
      log.warn('Rejected webhook: bad or missing secret.');
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }

    if (!body.event) {
      return reply.code(400).send({ ok: false, error: 'missing event' });
    }

    const normalized = normalizeEvent(body.event);
    recordEvent({ at: new Date().toISOString(), raw: body.event, normalizedKind: normalized.kind });

    // 3) idempotency: skip resends of the same monday event.
    if (store && normalized.eventId) {
      if (store.hasProcessedEvent(normalized.eventId)) {
        log.debug(`Duplicate event ${normalized.eventId} ignored.`);
        return reply.send({ ok: true, kind: normalized.kind, duplicate: true });
      }
      store.markProcessedEvent(normalized.eventId, Date.now());
    }

    log.info(`webhook event: ${normalized.kind}`);

    if (engine) {
      try {
        const r = await engine.handleEvent(normalized);
        return reply.send({ ok: true, kind: normalized.kind, ...r });
      } catch (err) {
        log.error('Rules engine error', err);
        return reply.code(500).send({ ok: false, error: 'engine error' });
      }
    }

    return reply.send({ ok: true, kind: normalized.kind });
  });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const store = new SqliteStore();
  const engine = new RulesEngine({ rules: loadRules(), store });
  startWorker(store, engine, env.workerIntervalMs);

  const app = buildServer(engine, store);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  log.info(`Webhook ingress listening on http://0.0.0.0:${env.port} (POST /webhook)`);
  return app;
}
