import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import { discoverBoard, getGroupSubitemNames } from '../monday/discovery.js';
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

export function registerAdmin(app: FastifyInstance, engine?: RulesEngine): void {
  // ── static UI ──────────────────────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(await readFile(resolve(WEB_DIR, 'index.html'), 'utf8'));
  });
  app.get('/app.js', async (_req, reply) => {
    reply.type('application/javascript').send(await readFile(resolve(WEB_DIR, 'app.js'), 'utf8'));
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
}
