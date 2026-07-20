import assert from 'node:assert';
import { RulesEngine } from '../rules/engine.js';
import { SqliteStore } from '../db/store.js';
import { runDueActions } from '../worker.js';
import type { ItemContext } from '../monday/hydrate.js';
import type { EmailMessage, Senders } from '../senders/index.js';
import type { NormalizedEvent } from '../events/types.js';
import type { EmailAction, Rule } from '../rules/types.js';

/**
 * Phase 5 verification: column-based recipient resolution + worker retry.
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
  columns: {
    status: { text: 'Working on it', value: null, type: 'color' },
    // A people column's text is the person's NAME — only the users() lookup
    // (the `people` map below) can turn it into an address.
    person: { text: 'Alyssa', value: '{"personsAndTeams":[{"id":1,"kind":"person"}]}', type: 'people' },
    // A person whose email the users() lookup couldn't resolve: absent from `people`.
    person_unresolved: { text: 'Bob Nomail', value: '{"personsAndTeams":[{"id":2,"kind":"person"}]}', type: 'people' },
    // An email column whose display label is NOT the address.
    email_patient: { text: 'Test Patient', value: '{"text":"Test Patient","email":"patient@example.com"}', type: 'email' },
    // Addresses kept as free text (as on the real board's "Referring Provider Email").
    text_referrer: { text: 'ref1@example.com, ref2@example.com', value: null, type: 'text' },
    text_blank: { text: '', value: null, type: 'text' },
  },
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

  // 1b) recipients from arbitrary (email/text) columns via toFromColumns.
  {
    const sendWith = async (action: Partial<EmailAction>): Promise<string[]> => {
      const emails: EmailMessage[] = [];
      const senders: Senders = { async sendEmail(m) { emails.push(m); }, async sendSlack() {} };
      const rules: Rule[] = [
        {
          id: 'email-cols',
          enabled: true,
          boardId: BOARD,
          scope: { groupId: GROUP },
          trigger: { type: 'item_entered_group' },
          actions: [{ type: 'email', when: { mode: 'immediate' }, subject: 's', body: 'b', ...action } as EmailAction],
        },
      ];
      const engine = new RulesEngine({ rules, senders, hydrate: async () => itemWithPeople });
      await engine.handleEvent(entered);
      return emails[0]?.to ?? [];
    };

    const both = await sendWith({ to: ['pm@example.com'], toFromColumns: ['email_patient', 'text_referrer'] });
    check(
      'toFromColumns merges literal + several columns',
      ['pm@example.com', 'patient@example.com', 'ref1@example.com', 'ref2@example.com'].every((e) => both.includes(e)),
    );
    check('email column prefers value.email over its display label', !both.includes('Test Patient'));
    check('text column splits comma-separated addresses', both.filter((e) => e.startsWith('ref')).length === 2);

    const legacyPlusNew = await sendWith({ toFromColumn: 'person', toFromColumns: ['email_patient'] });
    check(
      'legacy toFromColumn still resolves alongside toFromColumns',
      legacyPlusNew.includes('owner@example.com') && legacyPlusNew.includes('patient@example.com'),
    );

    const unresolved = await sendWith({ toFromColumns: ['person_unresolved'] });
    check('people column never leaks the person name as a recipient', unresolved.length === 0);

    const nothing = await sendWith({ to: ['pm@example.com'], toFromColumns: ['text_blank', 'no_such_column'] });
    check('blank + unknown columns yield no recipients and do not throw', nothing.length === 1 && nothing[0] === 'pm@example.com');
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

  // 3) email opt-out gate (patient contact consent).
  {
    const OPTOUT = 'color_optout';
    const itemWithFlag = (text: string | null): ItemContext => ({
      ...itemWithPeople,
      columns: {
        ...itemWithPeople.columns,
        ...(text === null ? {} : { [OPTOUT]: { text, value: null, type: 'color' } }),
      },
    });

    const emailRule: Rule = {
      id: 'optout-email',
      enabled: true,
      boardId: BOARD,
      scope: { groupId: GROUP },
      trigger: { type: 'item_entered_group' },
      actions: [{ type: 'email', when: { mode: 'immediate' }, to: ['p@example.com'], subject: 's', body: 'b' }],
    };

    /** Fire the immediate email rule and report how many mails went out. */
    const sentWith = async (
      flag: string | null,
      optOut: { columnId: string; blockValue: string } | undefined = { columnId: OPTOUT, blockValue: 'No' },
    ): Promise<number> => {
      const emails: EmailMessage[] = [];
      const senders: Senders = { async sendEmail(m) { emails.push(m); }, async sendSlack() {} };
      const engine = new RulesEngine({
        rules: [emailRule],
        senders,
        hydrate: async () => itemWithFlag(flag),
        emailOptOut: optOut,
      });
      await engine.handleEvent(entered);
      return emails.length;
    };

    check('gate off (no column configured) → sends', (await sentWith('No', { columnId: '', blockValue: 'No' })) === 1);
    check('flag "No" → suppressed', (await sentWith('No')) === 0);
    check('flag "Yes" → sends', (await sentWith('Yes')) === 1);
    check('flag empty → sends (default-allow)', (await sentWith('')) === 1);
    check('column absent → sends (default-allow)', (await sentWith(null)) === 1);
    check('flag " no " (case + whitespace) → suppressed', (await sentWith(' no ')) === 0);

    // Slack is internal staff notification, not patient contact — never gated.
    {
      let slacks = 0;
      const senders: Senders = { async sendEmail() {}, async sendSlack() { slacks++; } };
      const engine = new RulesEngine({
        rules: [{ ...emailRule, id: 'optout-slack', actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'hi' }] }],
        senders,
        hydrate: async () => itemWithFlag('No'),
        emailOptOut: { columnId: OPTOUT, blockValue: 'No' },
      });
      await engine.handleEvent(entered);
      check('slack unaffected by an opted-out item', slacks === 1);
    }

    // The case a per-rule condition could not cover: a queued email is gated at
    // SEND time, so flipping the flag after it was armed still suppresses it.
    {
      const store = new SqliteStore(':memory:');
      const emails: EmailMessage[] = [];
      const senders: Senders = { async sendEmail(m) { emails.push(m); }, async sendSlack() {} };
      const engine = new RulesEngine({
        rules: [],
        senders,
        store,
        hydrate: async () => itemWithFlag('No'),
        emailOptOut: { columnId: OPTOUT, blockValue: 'No' },
      });
      const now = Date.now();
      store.enqueue({ itemId: 100, ruleId: 'r', actionType: 'email', payload: { to: ['p@example.com'], subject: 's', body: 'b' }, dueAt: now });

      const res = await runDueActions(store, engine, now);
      check('queued email for an opted-out item is suppressed at send time', emails.length === 0);
      check('suppressed queued email is marked sent, not failed', res.sent === 1 && res.failed === 0);
      store.close();
    }

    // Unreadable flag → fail closed: throw, so the worker retries rather than
    // mailing an item whose consent state is unknown.
    {
      const store = new SqliteStore(':memory:');
      const emails: EmailMessage[] = [];
      const senders: Senders = { async sendEmail(m) { emails.push(m); }, async sendSlack() {} };
      const engine = new RulesEngine({
        rules: [],
        senders,
        store,
        hydrate: async () => { throw new Error('monday down'); },
        emailOptOut: { columnId: OPTOUT, blockValue: 'No' },
      });
      const now = Date.now();
      store.enqueue({ itemId: 100, ruleId: 'r', actionType: 'email', payload: { to: ['p@example.com'], subject: 's', body: 'b' }, dueAt: now });

      const res = await runDueActions(store, engine, now, { maxAttempts: 2, retryBackoffMs: 1000 });
      check('unreadable flag → no email sent (fail closed)', emails.length === 0);
      check('unreadable flag → retried, not marked sent', res.retried === 1 && res.sent === 0);
      store.close();
    }
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nPolish test failed:', err?.message ?? err);
  process.exitCode = 1;
});
