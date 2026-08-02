import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../server.js';
import { env } from '../config/env.js';

/**
 * Offline verification of the configurator backend (static UI + rules API)
 * using Fastify `inject`. Run via: `npm run test:admin` (which points
 * RULES_PATH at a throwaway file so config/rules.json is never touched).
 */

let passed = 0;
const check = (name: string, cond: boolean) => {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
};

/** Build an `Authorization: Basic` header the way a browser would. */
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const auth = { authorization: basic(env.adminUser, env.adminPassword) };

const validRule = {
  id: 'admin-test-rule',
  enabled: true,
  boardId: 18403436566,
  scope: { groupId: 'group_x' },
  trigger: { type: 'item_entered_group' },
  actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'hi' }],
};

async function main() {
  // Guard: ensure we're not about to clobber the real rules file.
  assert.ok(env.rulesPath.includes('.test-rules'), 'RULES_PATH must point at a test file');
  if (existsSync(resolve(env.rulesPath))) rmSync(resolve(env.rulesPath));

  const app = buildServer(); // no engine — admin routes still work
  try {
    // ── Basic Auth gate (web/auth.ts) ────────────────────────────────────────
    // Everything below sends `auth`; these first checks prove that's required.
    let res = await app.inject({ method: 'GET', url: '/' });
    check('GET / without credentials → 401', res.statusCode === 401);
    check('401 carries a WWW-Authenticate challenge (browser prompts)',
      /^Basic realm=/.test(String(res.headers['www-authenticate'])));

    res = await app.inject({ method: 'GET', url: '/api/rules' });
    check('GET /api/rules without credentials → 401', res.statusCode === 401);

    res = await app.inject({ method: 'GET', url: '/', headers: { authorization: basic('admin', 'wrong') } });
    check('wrong password → 401', res.statusCode === 401);

    res = await app.inject({ method: 'GET', url: '/health' });
    check('GET /health stays public (healthchecks)', res.statusCode === 200);

    res = await app.inject({ method: 'POST', url: '/webhook', payload: { challenge: 'x' } });
    check('POST /webhook stays public (monday sends no auth header)',
      res.statusCode === 200 && res.json().challenge === 'x');

    // ── configurator, authenticated ──────────────────────────────────────────
    res = await app.inject({ method: 'GET', url: '/', headers: auth });
    check('GET / serves the configurator HTML', res.statusCode === 200 && res.body.includes('automation configurator'));

    res = await app.inject({ method: 'GET', url: '/app.js', headers: auth });
    check('GET /app.js serves JS', res.statusCode === 200 && res.body.includes('loadBoard'));

    res = await app.inject({ method: 'GET', url: '/api/config', headers: auth });
    check('GET /api/config returns config', res.statusCode === 200 && 'secretRequired' in res.json());

    res = await app.inject({ method: 'GET', url: '/api/rules', headers: auth });
    check('GET /api/rules returns empty ruleset initially', res.statusCode === 200 && Array.isArray(res.json().rules) && res.json().rules.length === 0);

    res = await app.inject({ method: 'PUT', url: '/api/rules', headers: auth, payload: { rules: [{ id: 'bad' }] } });
    check('PUT invalid ruleset → 400 with problems', res.statusCode === 400 && res.json().problems.length > 0);

    res = await app.inject({ method: 'PUT', url: '/api/rules', headers: auth, payload: { rules: [validRule] } });
    check('PUT valid ruleset → 200 ok', res.statusCode === 200 && res.json().count === 1);

    res = await app.inject({ method: 'GET', url: '/api/rules', headers: auth });
    check('GET /api/rules reflects the saved rule', res.json().rules[0].id === 'admin-test-rule');
    // Note: those PUTs carried no `?secret=` — Basic Auth alone authorizes writes.
  } finally {
    await app.close();
    if (existsSync(resolve(env.rulesPath))) rmSync(resolve(env.rulesPath));
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nAdmin test failed:', err?.message ?? err);
  process.exitCode = 1;
});
