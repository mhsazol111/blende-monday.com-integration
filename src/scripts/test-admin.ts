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
    let res = await app.inject({ method: 'GET', url: '/' });
    check('GET / serves the configurator HTML', res.statusCode === 200 && res.body.includes('automation configurator'));

    res = await app.inject({ method: 'GET', url: '/app.js' });
    check('GET /app.js serves JS', res.statusCode === 200 && res.body.includes('loadBoard'));

    res = await app.inject({ method: 'GET', url: '/api/config' });
    check('GET /api/config returns config', res.statusCode === 200 && 'secretRequired' in res.json());

    res = await app.inject({ method: 'GET', url: '/api/rules' });
    check('GET /api/rules returns empty ruleset initially', res.statusCode === 200 && Array.isArray(res.json().rules) && res.json().rules.length === 0);

    res = await app.inject({ method: 'PUT', url: '/api/rules', payload: { rules: [{ id: 'bad' }] } });
    check('PUT invalid ruleset → 400 with problems', res.statusCode === 400 && res.json().problems.length > 0);

    res = await app.inject({ method: 'PUT', url: '/api/rules', payload: { rules: [validRule] } });
    check('PUT valid ruleset → 200 ok', res.statusCode === 200 && res.json().count === 1);

    res = await app.inject({ method: 'GET', url: '/api/rules' });
    check('GET /api/rules reflects the saved rule', res.json().rules[0].id === 'admin-test-rule');
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
