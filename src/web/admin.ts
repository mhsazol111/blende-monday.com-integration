import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { discoverBoard, getGroupSubitemNames } from '../monday/discovery.js';
import {
  listWebhooks,
  reconcileWebhooks,
  deleteWebhook,
  buildWebhookUrl,
  WEBHOOK_EVENTS,
} from '../monday/webhooks.js';
import { adminAuthorized } from './auth.js';
import { saveRules, validateRuleset } from '../rules/loader.js';
import type { RulesEngine } from '../rules/engine.js';
import type { Rule } from '../rules/types.js';
import type { QueuedStatus, Store } from '../queue/types.js';

/**
 * Configurator backend + static UI (Phase 7).
 *
 * The UI is dependency-free static assets in `web/` served by Fastify, so the
 * whole product stays one deployable. Its dropdowns are populated from the live
 * monday API (`/api/discover`) so rules are built without copy-pasting IDs.
 */

const WEB_DIR = resolve('web');

// Write routes keep an explicit gate even though the global Basic Auth hook
// (web/auth.ts) already ran — it's the same predicate, so this is now a
// belt-and-braces check that survives someone carving a path out of the hook.

/**
 * The public origin monday should call. Prefer the configured PUBLIC_URL;
 * otherwise derive it from the request (works behind Traefik/Coolify via the
 * `x-forwarded-proto`/`host` headers) so the "Connect" button works untouched.
 */
function resolvePublicBaseUrl(req: { headers: Record<string, unknown> }): string {
  if (env.publicUrl) return env.publicUrl;
  const h = req.headers;
  const host = String(h['x-forwarded-host'] ?? h['host'] ?? '').split(',')[0].trim();
  const proto = String(h['x-forwarded-proto'] ?? 'https').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

export function registerAdmin(app: FastifyInstance, engine?: RulesEngine, store?: Store): void {
  // ── static UI ──────────────────────────────────────────────────────────────
  // `no-store` so the app shell is never cached by browsers or the CDN
  // (Cloudflare) — otherwise a deploy ships new code but stale assets keep being
  // served from the edge. It's a tiny admin UI, so there's no perf cost.
  app.get('/', async (_req, reply) => {
    reply
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .send(await readFile(resolve(WEB_DIR, 'index.html'), 'utf8'));
  });
  app.get('/app.js', async (_req, reply) => {
    reply
      .type('application/javascript')
      .header('Cache-Control', 'no-store')
      .send(await readFile(resolve(WEB_DIR, 'app.js'), 'utf8'));
  });

  // ── API ─────────────────────────────────────────────────────────────────────
  app.get('/api/config', async () => ({
    defaultBoardId: env.mondayBoardId || null,
    secretRequired: !!env.webhookSharedSecret,
    contactOptOut: env.contactOptOutColumnId
      ? {
          columnId: env.contactOptOutColumnId,
          blockValue: env.contactOptOutBlockValue,
          channels: env.contactOptOutChannels,
        }
      : null,
  }));

  app.get('/api/discover', async (request, reply) => {
    const boardId = (request.query as { boardId?: string }).boardId;
    if (!boardId) return reply.code(400).send({ error: 'boardId is required' });
    try {
      const result = await discoverBoard(boardId);
      return result;
    } catch (err: any) {
      log.warn(`discover failed for board ${boardId}: ${err?.message}`);
      return reply.code(502).send({ error: err?.message ?? 'discover failed' });
    }
  });

  app.get('/api/group-subitems', async (request, reply) => {
    const { boardId, groupId } = request.query as { boardId?: string; groupId?: string };
    if (!boardId || !groupId) return reply.code(400).send({ error: 'boardId and groupId are required' });
    try {
      return { names: await getGroupSubitemNames(boardId, groupId) };
    } catch (err: any) {
      log.warn(`group-subitems failed: ${err?.message}`);
      return reply.code(502).send({ error: err?.message ?? 'failed' });
    }
  });

  app.get('/api/rules', async (_req, reply) => {
    try {
      const raw = await readFile(resolve(env.rulesPath), 'utf8');
      return JSON.parse(raw);
    } catch {
      return reply.send({ rules: [] });
    }
  });

  app.put('/api/rules', async (request, reply) => {
    if (!adminAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });

    const body = (request.body ?? {}) as { rules?: unknown };
    const problems = validateRuleset(body.rules);
    if (problems.length) return reply.code(400).send({ error: 'validation failed', problems });

    const rules = body.rules as Rule[];
    try {
      saveRules(rules);
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed to save' });
    }
    engine?.setRules(rules); // hot-reload the running engine
    log.info(`Configurator saved ${rules.length} rule(s); engine reloaded.`);
    return { ok: true, count: rules.length };
  });

  // ── webhooks (connect a board) ───────────────────────────────────────────────
  // List the webhooks currently on a board, plus the events this service manages
  // and whether each is present — drives the "Connected?" status in the UI.
  app.get('/api/webhooks', async (request, reply) => {
    const boardId = (request.query as { boardId?: string }).boardId;
    if (!boardId) return reply.code(400).send({ error: 'boardId is required' });
    try {
      const webhooks = await listWebhooks(boardId);
      const present = new Set(webhooks.map((w) => w.event));
      const managed = WEBHOOK_EVENTS.map((event) => ({ event, registered: present.has(event) }));
      const connected = managed.every((m) => m.registered);
      return { boardId, webhooks, managed, connected };
    } catch (err: any) {
      log.warn(`list webhooks failed for board ${boardId}: ${err?.message}`);
      return reply.code(502).send({ error: err?.message ?? 'failed' });
    }
  });

  // Idempotently register the full managed event set on a board (the "Connect"
  // button). Re-running is safe: it reconciles to exactly one webhook per event.
  app.post('/api/webhooks/register', async (request, reply) => {
    if (!adminAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const boardId = (request.body as { boardId?: string } | undefined)?.boardId
      ?? (request.query as { boardId?: string }).boardId;
    if (!boardId) return reply.code(400).send({ error: 'boardId is required' });

    const base = resolvePublicBaseUrl(request);
    if (!base) {
      return reply.code(400).send({
        error: 'Could not determine the public URL. Set PUBLIC_URL in the environment.',
      });
    }
    const url = buildWebhookUrl(base, env.webhookSharedSecret);
    try {
      const result = await reconcileWebhooks(boardId, url);
      log.info(`Registered ${result.created.length} webhook(s) on board ${boardId} → ${base}`);
      return { ok: true, ...result };
    } catch (err: any) {
      log.warn(`register webhooks failed for board ${boardId}: ${err?.message}`, err?.details);
      return reply.code(502).send({ error: err?.message ?? 'failed', details: err?.details });
    }
  });

  // Delete a single webhook by id (cleanup / debugging from the UI).
  app.delete('/api/webhooks/:id', async (request, reply) => {
    if (!adminAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const id = (request.params as { id?: string }).id;
    if (!id) return reply.code(400).send({ error: 'id is required' });
    try {
      return { ok: true, deleted: await deleteWebhook(id) };
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message ?? 'failed' });
    }
  });

  // ── scheduled actions (queue) management ─────────────────────────────────────
  // List queued/sent actions (most recent first) so the UI can show what's
  // pending and let the user run/reschedule/delete each one.
  // Filters are applied in SQL and `total` counts every match, so the pager and
  // the status filter stay honest however big the table gets.
  app.get('/api/queue', async (request, reply) => {
    if (!store) return reply.send({ actions: [], total: 0, limit: 0, offset: 0 });
    const q = request.query as Record<string, string | undefined>;
    const itemId = q.item ? Number(q.item) : undefined;
    return store.listActions({
      status: (q.status || undefined) as QueuedStatus | undefined,
      actionType: q.type || undefined,
      ruleId: q.rule || undefined,
      itemId: Number.isNaN(itemId) ? undefined : itemId,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });

  // Distinct filter values across the whole table (the dropdowns must not be
  // limited to whatever page is on screen).
  app.get('/api/queue/facets', async (_req, reply) => {
    if (!store) return reply.send({ statuses: [], actionTypes: [], ruleIds: [], itemIds: [] });
    return store.queueFacets();
  });

  // Bulk delete (the UI's checkbox selection). Ids only — never a filter — so a
  // mis-set filter can't wipe rows the user never saw.
  app.post('/api/queue/bulk-delete', async (request, reply) => {
    if (!adminAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!store) return reply.code(503).send({ error: 'queue unavailable' });
    const ids = (request.body as { ids?: unknown } | undefined)?.ids;
    if (!Array.isArray(ids) || !ids.length) return reply.code(400).send({ error: '`ids` array is required' });
    const deleted = store.deleteActions(ids as number[]);
    log.info(`Queue: bulk-deleted ${deleted} action(s).`);
    return { ok: true, deleted };
  });

  // Run a queued action immediately (dispatch now, mark sent).
  app.post('/api/queue/:id/run', async (request, reply) => {
    if (!adminAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!store || !engine) return reply.code(503).send({ error: 'queue unavailable' });
    const id = Number((request.params as { id?: string }).id);
    const action = store.getAction(id);
    if (!action) return reply.code(404).send({ error: 'action not found' });
    // "Run now" answers "what would the worker do at the due date?", so it runs
    // the SAME fire-time condition gate. Testing a rule must not silently
    // contradict it — that made a gated x-ray reminder look broken when it was
    // the button, not the rule, ignoring the condition. `force` is the explicit
    // override ("Send anyway" in the UI).
    const force = (request.body as { force?: boolean } | undefined)?.force === true;
    try {
      // Re-render against current data (same as the worker).
      const prep = await engine.prepareQueued(action, { recheckConditions: !force });
      if (!prep.fire) {
        // Deliberately NOT marked cancelled: the user asked to send early and we
        // declined, so the action stays pending and still fires at its due date.
        log.info(`Queue: action ${id} not run — ${prep.reason}`);
        return { ok: true, skipped: true, reason: prep.reason ?? "the rule's conditions do not hold" };
      }
      const res = await engine.dispatch(action.actionType, prep.payload, { itemId: action.itemId });
      if (res.suppressed) {
        // Not a failure — but never report it as a successful send either.
        store.markSuppressed(id, Date.now(), res.suppressed.detail);
        log.info(`Queue: action ${id} suppressed — ${res.suppressed.detail}`);
        return { ok: true, suppressed: true, reason: res.suppressed.detail };
      }
      store.markSent(id, Date.now());
      log.info(`Queue: ran action ${id} (${action.actionType}) now.`);
      return { ok: true, suppressed: false };
    } catch (err: any) {
      log.warn(`Queue: run action ${id} failed: ${err?.message}`);
      return reply.code(502).send({ error: err?.message ?? 'dispatch failed' });
    }
  });

  // Reschedule a queued action to a new time (ISO timestamp); resets to pending.
  app.post('/api/queue/:id/reschedule', async (request, reply) => {
    if (!adminAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!store) return reply.code(503).send({ error: 'queue unavailable' });
    const id = Number((request.params as { id?: string }).id);
    const at = (request.body as { at?: string } | undefined)?.at;
    const dueAt = at ? Date.parse(at) : NaN;
    if (Number.isNaN(dueAt)) return reply.code(400).send({ error: 'valid ISO `at` is required' });
    if (!store.getAction(id)) return reply.code(404).send({ error: 'action not found' });
    store.rescheduleAction(id, dueAt);
    return { ok: true, dueAt };
  });

  // Delete a queued action.
  app.delete('/api/queue/:id', async (request, reply) => {
    if (!adminAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!store) return reply.code(503).send({ error: 'queue unavailable' });
    const id = Number((request.params as { id?: string }).id);
    if (!store.getAction(id)) return reply.code(404).send({ error: 'action not found' });
    store.deleteAction(id);
    return { ok: true };
  });
}
