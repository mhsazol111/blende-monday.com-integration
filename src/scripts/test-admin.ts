import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../server.js';
import { env } from '../config/env.js';
import { RulesEngine } from '../rules/engine.js';
import { SqliteStore } from '../db/store.js';
import type { ItemContext } from '../monday/hydrate.js';
import type { Senders, SlackMessage } from '../senders/index.js';
import type { Rule } from '../rules/types.js';

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

  await runNowConditionGate();

  console.log(`\n${passed} checks passed.`);
}

/**
 * "Run now" must apply the SAME fire-time condition gate as the worker, so a
 * manual test of a gated rule demonstrates the condition instead of bypassing
 * it. `force: true` is the deliberate override.
 */
async function runNowConditionGate() {
  const GATED_RULE: Rule = {
    id: 'timed-gated-rule',
    enabled: true,
    boardId: 1,
    scope: { groupId: 'group_a' },
    trigger: { type: 'item_in_group_for_days', days: 2 },
    conditionGroups: [{ conditions: [{ type: 'column_equals', columnId: 'xrays', value: 'Yes' }] }],
    actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'request x-rays' }],
  };

  let xrays = 'No';
  const item = (): ItemContext => ({
    id: 500,
    boardId: 1,
    name: 'Test Patient',
    groupId: 'group_a',
    groupTitle: 'NP Intake',
    columns: { xrays: { text: xrays, value: null, type: 'color' } },
    subitems: [],
    people: {},
  });

  const store = new SqliteStore(':memory:');
  const slacks: SlackMessage[] = [];
  const senders: Senders = { async sendEmail() {}, async sendSlack(m) { slacks.push(m); } };
  const engine = new RulesEngine({ rules: [GATED_RULE], store, senders, hydrate: async () => item() });
  const app = buildServer(engine, store);

  const enqueue = () =>
    store.enqueue({
      itemId: 500,
      ruleId: GATED_RULE.id,
      actionType: 'slack',
      payload: { text: 'request x-rays' },
      dueAt: Date.now() + 2 * 86_400_000, // not due for two days
    });

  try {
    enqueue();
    const first = store.listActions().actions[0];

    // ── condition does NOT hold (X-rays = "No") ──────────────────────────────
    let res = await app.inject({ method: 'POST', url: `/api/queue/${first.id}/run`, headers: auth, payload: {} });
    check('run now on a gated rule whose condition fails → skipped, not sent',
      res.statusCode === 200 && res.json().skipped === true && slacks.length === 0);
    check('the skip explains which column blocked it',
      /xrays/.test(res.json().reason) && /"No"/.test(res.json().reason) && /"Yes"/.test(res.json().reason));
    check('a skipped action stays pending (it is not cancelled)',
      store.getAction(first.id)?.status === 'pending');

    // ── the deliberate override ──────────────────────────────────────────────
    res = await app.inject({ method: 'POST', url: `/api/queue/${first.id}/run`, headers: auth, payload: { force: true } });
    check('run now with force:true overrides the gate and sends',
      res.statusCode === 200 && res.json().skipped !== true && slacks.length === 1);
    check('the forced send is marked sent', store.getAction(first.id)?.status === 'sent');

    // ── condition DOES hold (X-rays = "Yes") ─────────────────────────────────
    xrays = 'Yes';
    enqueue();
    const second = store.listActions({ status: 'pending' }).actions[0];
    res = await app.inject({ method: 'POST', url: `/api/queue/${second.id}/run`, headers: auth, payload: {} });
    check('run now sends normally once the condition holds',
      res.statusCode === 200 && res.json().skipped !== true && slacks.length === 2);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('\nAdmin test failed:', err?.message ?? err);
  process.exitCode = 1;
});
