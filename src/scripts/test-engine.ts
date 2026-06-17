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

  // 5c) all_subitems_checked: fires only when the LAST of the set is Done (order-independent).
  {
    const SUBITEM_BOARD = 18403436575;
    const rules: Rule[] = [
      {
        id: 'both-xrays',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP },
        trigger: { type: 'all_subitems_checked', columnId: 'status', label: 'Done', subitemNames: ['Request x-rays', 'Receive x-rays'] },
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'both x-rays done' }],
      },
    ];
    const doneCols = { status: { text: 'Done', value: null, type: 'color' } };
    const notCols = { status: { text: '', value: null, type: 'color' } };
    const sub = (name: string, done: boolean) => ({ id: 1, boardId: SUBITEM_BOARD, name, columns: done ? doneCols : notCols });
    const evtFor = (name: string): NormalizedEvent => ({
      kind: 'subitem_changed', boardId: SUBITEM_BOARD, subitemId: 1, parentItemId: 100,
      columnId: 'status', label: 'Done', value: null, raw: { pulseName: name },
    });

    // First x-ray done, second not yet → no fire.
    const eng1 = makeEngine(rules, makeItem({ subitems: [sub('Request x-rays', true), sub('Receive x-rays', false)] }));
    const r1 = await eng1.engine.handleEvent(evtFor('Request x-rays'));
    check('all_subitems_checked: not all done → no fire', r1.matched === 0 && eng1.slacks.length === 0);

    // Now both done, second one is the change → fires once.
    const eng2 = makeEngine(rules, makeItem({ subitems: [sub('Request x-rays', true), sub('Receive x-rays', true)] }));
    const r2 = await eng2.engine.handleEvent(evtFor('Receive x-rays'));
    check('all_subitems_checked: last one done → fires', r2.matched === 1 && eng2.slacks.length === 1);

    // An unrelated subitem completing does NOT fire (not in the set).
    const eng3 = makeEngine(rules, makeItem({ subitems: [sub('Request x-rays', true), sub('Receive x-rays', true)] }));
    const r3 = await eng3.engine.handleEvent(evtFor('Some other subitem'));
    check('all_subitems_checked: unrelated subitem → no fire', r3.matched === 0 && eng3.slacks.length === 0);
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

  // 8) rich-text (HTML) body → HTML email + plain-text fallback + Slack mrkdwn.
  {
    const rules: Rule[] = [
      {
        id: 'rich',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP },
        trigger: { type: 'item_entered_group' },
        actions: [
          { type: 'email', when: { mode: 'immediate' }, to: ['x@y.com'], subject: 's', body: '<p>Hi <strong>{{item.name}}</strong></p>' },
          { type: 'slack', when: { mode: 'immediate' }, text: 'See <a href="https://m.co">board</a> for <strong>{{item.name}}</strong>' },
        ],
      },
    ];
    const { engine, emails, slacks } = makeEngine(rules, makeItem());
    await engine.handleEvent(entered(100));
    check('email keeps HTML body', emails[0].html === '<p>Hi <strong>NP Patient</strong></p>');
    check('email plain-text fallback strips tags', emails[0].body === 'Hi NP Patient');
    check('slack converts HTML to mrkdwn', slacks[0].text === 'See <https://m.co|board> for *NP Patient*');
  }

  // 9) moved_from_group condition uses the event's sourceGroupId.
  {
    const rules: Rule[] = [
      {
        id: 'from-intake',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP },
        trigger: { type: 'item_entered_group' },
        conditions: [{ type: 'moved_from_group', groupId: 'group_intake' }],
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'moved from intake' }],
      },
    ];
    const evt = (from?: string): NormalizedEvent => ({
      kind: 'item_entered_group', boardId: BOARD, itemId: 100, groupId: GROUP, reason: 'moved', fromGroupId: from, raw: {},
    });
    let e = makeEngine(rules, makeItem());
    await e.engine.handleEvent(evt('group_intake'));
    check('moved_from_group matches when source group matches', e.slacks.length === 1);

    e = makeEngine(rules, makeItem());
    await e.engine.handleEvent(evt('group_other'));
    check('moved_from_group skips when source group differs', e.slacks.length === 0);

    e = makeEngine(rules, makeItem());
    await e.engine.handleEvent(evt(undefined)); // created in group → no source
    check('moved_from_group skips on create (no source group)', e.slacks.length === 0);
  }

  // 10) set_column writes to monday (item + subitem), with subitem-by-name guard.
  {
    const SUBITEM_BOARD = 18403436575;
    const writes: any[] = [];
    const mk = (rules: Rule[]) =>
      new RulesEngine({
        rules,
        senders: { async sendEmail() {}, async sendSlack() {} },
        columnWriter: async (a) => { writes.push(a); },
        hydrate: async () => makeItem({ subitems: [{ id: 55, boardId: SUBITEM_BOARD, name: 'X-ray', columns: {} }] }),
      });
    const rule = (over: any): Rule => ({
      id: 'r', enabled: true, boardId: BOARD, scope: { groupId: GROUP },
      trigger: { type: 'item_entered_group' },
      actions: [{ type: 'set_column', when: { mode: 'immediate' }, ...over }],
    });

    writes.length = 0;
    await mk([rule({ columnId: 'status', value: '1' })]).handleEvent(entered(100));
    check('set_column (item) writes item id + value', writes.length === 1 && writes[0].itemId === 100 && writes[0].value === '1');

    writes.length = 0;
    await mk([rule({ target: 'subitem', subitemName: 'X-ray', columnId: 'status', value: '1' })]).handleEvent(entered(100));
    check('set_column (subitem) writes subitem id + board', writes.length === 1 && writes[0].itemId === 55 && writes[0].boardId === SUBITEM_BOARD);

    writes.length = 0;
    const r = await mk([rule({ target: 'subitem', subitemName: 'Missing', columnId: 'status', value: '1' })]).handleEvent(entered(100));
    check('set_column skips when named subitem absent', writes.length === 0 && r.matched === 1);
  }

  // 11) action isolation: a throwing action must not abort the rest of the rule.
  {
    const writes: any[] = [];
    const engine = new RulesEngine({
      rules: [
        {
          id: 'iso', enabled: true, boardId: BOARD, scope: { groupId: GROUP },
          trigger: { type: 'item_entered_group' },
          actions: [
            { type: 'slack', when: { mode: 'immediate' }, text: 'boom' },
            { type: 'set_column', when: { mode: 'immediate' }, columnId: 'status', value: '1' },
          ],
        },
      ],
      senders: { async sendEmail() {}, async sendSlack() { throw new Error('slack down'); } },
      columnWriter: async (a) => { writes.push(a); },
      hydrate: async () => makeItem(),
    });
    const r = await engine.handleEvent(entered(100));
    check('failing slack does not block following set_column', writes.length === 1 && r.failed === 1);
  }

  // 12) clone → set_column on a just-cloned subitem: re-hydrate after clone.
  {
    let calls = 0;
    const writes: any[] = [];
    const before = makeItem({ subitems: [] });
    const after = makeItem({ subitems: [{ id: 77, boardId: 18403436575, name: 'New subitem', columns: {} }] });
    const engine = new RulesEngine({
      rules: [
        {
          id: 'clone-set', enabled: true, boardId: BOARD, scope: { groupId: GROUP },
          trigger: { type: 'item_entered_group' },
          actions: [
            { type: 'clone_template_subitems', templatesGroupTitle: 'Templates', templateSourceColumnId: 'text_x' },
            { type: 'set_column', when: { mode: 'immediate' }, target: 'subitem', subitemName: 'New subitem', columnId: 'status', value: '1' },
          ],
        },
      ],
      senders: { async sendEmail() {}, async sendSlack() {} },
      columnWriter: async (a) => { writes.push(a); },
      cloner: async () => ({ action: 'created', created: 1 }),
      hydrate: async () => (++calls === 1 ? before : after),
    });
    await engine.handleEvent(entered(100));
    check('clone re-hydrates so set_column finds the new subitem', writes.length === 1 && writes[0].itemId === 77);
  }

  // 13) item_left_group fires on a move out of its source group (not on create).
  {
    const SOURCE = 'group_source', DEST = 'group_dest';
    const rule: Rule = {
      id: 'left', enabled: true, boardId: BOARD, scope: { groupId: SOURCE },
      trigger: { type: 'item_left_group' },
      actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'left source' }],
    };
    const move = (from?: string, reason: 'moved' | 'created' = 'moved'): NormalizedEvent => ({
      kind: 'item_entered_group', boardId: BOARD, itemId: 100, groupId: DEST, reason, fromGroupId: from, raw: {},
    });

    let e = makeEngine([rule], makeItem({ groupId: DEST, groupTitle: 'Dest' }));
    let r = await e.engine.handleEvent(move(SOURCE));
    check('item_left_group fires when item leaves its source group', r.matched === 1 && e.slacks.length === 1);

    e = makeEngine([rule], makeItem({ groupId: DEST }));
    r = await e.engine.handleEvent(move('group_other'));
    check('item_left_group ignores leaving a different group', r.matched === 0 && e.slacks.length === 0);

    e = makeEngine([rule], makeItem({ groupId: SOURCE }));
    r = await e.engine.handleEvent(move(undefined, 'created'));
    check('item_left_group does not fire on create', r.matched === 0 && e.slacks.length === 0);
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nEngine test failed:', err?.message ?? err);
  process.exitCode = 1;
});
