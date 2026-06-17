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
import { saveRules, validateRuleset } from '../rules/loader.js';
import type { RulesEngine } from '../rules/engine.js';
import type { Rule } from '../rules/types.js';

/**
 * Configurator backend + static UI (Phase 7).
 *
 * The UI is dependency-free static assets in `web/` served by Fastify, so the
 * whole product stays one deployable. Its dropdowns are populated from the live
 * monday API (`/api/discover`) so rules are built without copy-pasting IDs.
 */

const WEB_DIR = resolve('web');

function adminAuthorized(req: { query: unknown; headers: Record<string, unknown> }): boolean {
  const expected = env.webhookSharedSecret;
  if (!expected) return true; // no secret configured → open (dev)
  const fromQuery = (req.query as { secret?: string } | undefined)?.secret;
  return fromQuery === expected || req.headers['x-webhook-secret'] === expected;
}

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

export function registerAdmin(app: FastifyInstance, engine?: RulesEngine): void {
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
}
