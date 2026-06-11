import assert from 'node:assert';
import { RulesEngine } from '../rules/engine.js';
import { SqliteStore } from '../db/store.js';
import { runDueActions } from '../worker.js';
import type { ItemContext } from '../monday/hydrate.js';
import type { EmailMessage, Senders } from '../senders/index.js';
import type { NormalizedEvent } from '../events/types.js';
import type { Rule } from '../rules/types.js';

/**
 * Phase 5 verification: people-column recipient resolution + worker retry.
 * Run: `npm run test:polish`.
 */

const BOARD = 18403436566;
const GROUP = 'group_a';

let passed = 0;
const check = (name: string, cond: boolean) => {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
};

const itemWithPeople: ItemContext = {
  id: 100,
  boardId: BOARD,
  name: 'Item',
  groupId: GROUP,
  groupTitle: GROUP,
  columns: { status: { text: 'Working on it', value: null, type: 'color' } },
  subitems: [],
  people: { person: ['owner@example.com'] },
};

const entered: NormalizedEvent = {
  kind: 'item_entered_group',
  boardId: BOARD,
  itemId: 100,
  groupId: GROUP,
  reason: 'moved',
  raw: {},
};

async function main() {
  // 1) recipients merge literal + people-column, deduped.
  {
    const emails: EmailMessage[] = [];
    const senders: Senders = { async sendEmail(m) { emails.push(m); }, async sendSlack() {} };
    const rules: Rule[] = [
      {
        id: 'email-merge',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP },
        trigger: { type: 'item_entered_group' },
        actions: [
          {
            type: 'email',
            when: { mode: 'immediate' },
            to: ['pm@example.com', 'owner@example.com'],
            toFromColumn: 'person',
            subject: 's',
            body: 'b',
          },
        ],
      },
    ];
    const engine = new RulesEngine({ rules, senders, hydrate: async () => itemWithPeople });
    await engine.handleEvent(entered);
    check('email sent once', emails.length === 1);
    check('recipients merged literal + column', emails[0].to.includes('pm@example.com') && emails[0].to.includes('owner@example.com'));
    check('recipients deduped', emails[0].to.filter((e) => e === 'owner@example.com').length === 1);
  }

  // 2) worker retry then permanent failure.
  {
    const store = new SqliteStore(':memory:');
    const failing: Senders = {
      async sendEmail() {},
      async sendSlack() {
        throw new Error('slack down');
      },
    };
    const engine = new RulesEngine({ rules: [], senders: failing, store });
    const now = Date.now();
    store.enqueue({ itemId: 1, ruleId: 'r', actionType: 'slack', payload: { webhookUrl: '', text: 'x' }, dueAt: now });

    const r1 = await runDueActions(store, engine, now, { maxAttempts: 2, retryBackoffMs: 1000 });
    check('first failure → retried (not failed)', r1.retried === 1 && r1.failed === 0);
    check('still pending after retry', store.dueActions(now + 10_000).length === 1);

    const r2 = await runDueActions(store, engine, now + 10_000, { maxAttempts: 2, retryBackoffMs: 1000 });
    check('second failure → permanently failed', r2.failed === 1 && store.dueActions(now + 1_000_000).length === 0);
    store.close();
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nPolish test failed:', err?.message ?? err);
  process.exitCode = 1;
});
