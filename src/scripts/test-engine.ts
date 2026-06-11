import assert from 'node:assert';
import { RulesEngine } from '../rules/engine.js';
import type { ItemContext } from '../monday/hydrate.js';
import type { EmailMessage, Senders, SlackMessage } from '../senders/index.js';
import type { NormalizedEvent } from '../events/types.js';
import type { Rule } from '../rules/types.js';

/**
 * Offline verification of the rules engine using a mock hydrator + capturing
 * senders (no monday, no network). Run: `npm run test:engine`.
 *
 * Rules are defined inline (not loaded from config/rules.json) so the test is
 * stable as the sample file evolves and never touches the live monday API.
 */

const GROUP = 'group_mm1q43sd'; // NP Consultation
const BOARD = 18403436566;

const sampleRules: Rule[] = [
  {
    id: 'entered-slack',
    enabled: true,
    boardId: BOARD,
    scope: { groupId: GROUP },
    trigger: { type: 'item_entered_group' },
    actions: [
      { type: 'slack', when: { mode: 'immediate' }, text: '{{item.name}} entered {{group.title}} ({{item.id}})' },
    ],
  },
  {
    id: 'status-done-email',
    enabled: true,
    boardId: BOARD,
    scope: { groupId: GROUP },
    trigger: { type: 'status_changed_to', columnId: 'status', label: 'Done' },
    actions: [
      { type: 'email', when: { mode: 'immediate' }, to: ['pm@example.com'], subject: '{{item.name}} marked Done', body: 'done' },
    ],
  },
  {
    id: 'stale-7d',
    enabled: true,
    boardId: BOARD,
    scope: { groupId: GROUP },
    trigger: { type: 'item_in_group_for_days', days: 7 },
    actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'stale' }],
  },
];

function makeItem(over: Partial<ItemContext> = {}): ItemContext {
  return {
    id: 100,
    boardId: BOARD,
    name: 'NP Patient',
    groupId: GROUP,
    groupTitle: 'NP Consultation',
    columns: { status: { text: 'Working on it', value: null, type: 'color' } },
    subitems: [],
    people: {},
    ...over,
  };
}

function makeEngine(rules: Rule[], item: ItemContext) {
  const emails: EmailMessage[] = [];
  const slacks: SlackMessage[] = [];
  const senders: Senders = {
    async sendEmail(m) {
      emails.push(m);
    },
    async sendSlack(m) {
      slacks.push(m);
    },
  };
  const engine = new RulesEngine({
    rules,
    senders,
    hydrate: async (id) => (id === 999 ? makeItem({ groupId: 'group_other', groupTitle: 'Elsewhere' }) : item),
  });
  return { engine, emails, slacks };
}

let passed = 0;
const check = (name: string, cond: boolean) => {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
};

const entered = (itemId: number): NormalizedEvent => ({
  kind: 'item_entered_group',
  boardId: BOARD,
  itemId,
  groupId: GROUP,
  reason: 'moved',
  raw: {},
});

const statusChanged = (label: string): NormalizedEvent => ({
  kind: 'status_changed',
  boardId: BOARD,
  itemId: 100,
  columnId: 'status',
  label,
  raw: {},
});

async function main() {
  // 1) item entered NP Consultation → slack fires, templated.
  {
    const { engine, slacks } = makeEngine(sampleRules, makeItem());
    const r = await engine.handleEvent(entered(100));
    check('entered group → 1 matched', r.matched === 1);
    check('entered group → slack sent', slacks.length === 1);
    check('slack templated item name', slacks[0].text.includes('NP Patient'));
    check('slack templated group title', slacks[0].text.includes('NP Consultation'));
  }

  // 2) status → Done fires the email rule (immediate).
  {
    const { engine, emails } = makeEngine(sampleRules, makeItem());
    const r = await engine.handleEvent(statusChanged('Done'));
    check('status Done → email sent', emails.length === 1 && r.executed === 1);
    check('email subject templated', emails[0].subject.includes('NP Patient'));
  }

  // 3) status → Stuck does NOT fire the Done rule.
  {
    const { engine, emails } = makeEngine(sampleRules, makeItem());
    const r = await engine.handleEvent(statusChanged('Stuck'));
    check('status Stuck → no match', r.matched === 0 && emails.length === 0);
  }

  // 4) wrong group (scope mismatch) → nothing fires.
  {
    const { engine, slacks } = makeEngine(sampleRules, makeItem());
    const r = await engine.handleEvent(entered(999)); // hydrator returns group_other
    check('scope mismatch → no match', r.matched === 0 && slacks.length === 0);
  }

  // 5) timed rule (item_in_group_for_days) never fires from a webhook event.
  {
    const { engine, slacks } = makeEngine(sampleRules, makeItem());
    await engine.handleEvent(entered(100));
    check('timed rule not webhook-fired (only entered-group slack)', slacks.length === 1);
  }

  // 5b) subitem_checked fires even though the event carries the SUBITEM board id.
  {
    const SUBITEM_BOARD = 18403436575;
    const rules: Rule[] = [
      {
        id: 'subitem-done',
        enabled: true,
        boardId: BOARD, // parent board
        scope: { groupId: GROUP },
        trigger: { type: 'subitem_checked', columnId: 'status', label: 'Done', subitemName: 'NP intake and blue sheet' },
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: '{{item.name}} subitem done' }],
      },
    ];
    const { engine, slacks } = makeEngine(rules, makeItem());
    const evt: NormalizedEvent = {
      kind: 'subitem_changed',
      boardId: SUBITEM_BOARD, // different from rule.boardId on purpose
      subitemId: 555,
      parentItemId: 100,
      columnId: 'status',
      label: 'Done',
      value: null,
      raw: { pulseName: 'NP intake and blue sheet' },
    };
    const r = await engine.handleEvent(evt);
    check('subitem_checked fires despite subitem-board id', r.matched === 1 && slacks.length === 1);
  }

  // 6) condition gating: status_is_not blocks when item is Done.
  {
    const gated: Rule[] = [
      {
        id: 'gated',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP },
        trigger: { type: 'item_entered_group' },
        conditions: [{ type: 'status_is_not', columnId: 'status', label: 'Done' }],
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'hi' }],
      },
    ];
    const item = makeItem({ columns: { status: { text: 'Done', value: null, type: 'color' } } });
    const { engine, slacks } = makeEngine(gated, item);
    const r = await engine.handleEvent(entered(100));
    check('condition status_is_not Done blocks when Done', r.matched === 0 && slacks.length === 0);
  }

  // 7) scheduled action is deferred (not executed) in Phase 3.
  {
    const scheduled: Rule[] = [
      {
        id: 'sched',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP },
        trigger: { type: 'item_entered_group' },
        actions: [{ type: 'slack', when: { mode: 'relative', days: 3 }, text: 'later' }],
      },
    ];
    const { engine, slacks } = makeEngine(scheduled, makeItem());
    const r = await engine.handleEvent(entered(100));
    check('relative-timed action deferred, not sent', r.deferred === 1 && slacks.length === 0);
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nEngine test failed:', err?.message ?? err);
  process.exitCode = 1;
});
