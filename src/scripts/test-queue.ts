import assert from 'node:assert';
import { RulesEngine } from '../rules/engine.js';
import { SqliteStore } from '../db/store.js';
import { runDueActions } from '../worker.js';
import type { ItemContext } from '../monday/hydrate.js';
import type { Senders, SlackMessage } from '../senders/index.js';
import type { NormalizedEvent } from '../events/types.js';
import type { Rule } from '../rules/types.js';

/**
 * Offline verification of the queue + scheduler using an in-memory SQLite
 * store, a mock hydrator and capturing senders. Run: `npm run test:queue`.
 */

const DAY = 86_400_000;
const BOARD = 18403436566;
const GROUP_A = 'group_a';
const GROUP_B = 'group_b';

function item(groupId: string, id = 100): ItemContext {
  return {
    id,
    boardId: BOARD,
    name: 'Item',
    groupId,
    groupTitle: groupId,
    columns: { status: { text: 'Working on it', value: null, type: 'color' } },
    subitems: [],
    people: {},
  };
}

function harness(rules: Rule[], hydrateGroup: () => string) {
  const store = new SqliteStore(':memory:');
  const slacks: SlackMessage[] = [];
  const senders: Senders = {
    async sendEmail() {},
    async sendSlack(m) {
      slacks.push(m);
    },
  };
  const engine = new RulesEngine({ rules, store, senders, hydrate: async () => item(hydrateGroup()) });
  return { store, engine, slacks };
}

const entered = (boardId = BOARD): NormalizedEvent => ({
  kind: 'item_entered_group',
  boardId,
  itemId: 100,
  groupId: GROUP_A,
  reason: 'moved',
  raw: {},
});

const left = (): NormalizedEvent => ({ kind: 'item_left_group', boardId: BOARD, itemId: 100, raw: {} });

let passed = 0;
const check = (name: string, cond: boolean) => {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
};

async function main() {
  const now = Date.now();
  const future = now + 100 * DAY;

  // A) relative-scheduled action: enqueued, fires only when due.
  {
    const rules: Rule[] = [
      {
        id: 'rel',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP_A },
        trigger: { type: 'item_entered_group' },
        actions: [{ type: 'slack', when: { mode: 'relative', days: 1 }, text: 'in 1 day' }],
      },
    ];
    const { store, engine, slacks } = harness(rules, () => GROUP_A);
    const r = await engine.handleEvent(entered());
    check('relative action scheduled, not sent', r.scheduled === 1 && slacks.length === 0);
    check('not due yet → worker sends nothing', (await runDueActions(store, engine, now)).sent === 0);
    check('due later → worker sends it', (await runDueActions(store, engine, now + 2 * DAY)).sent === 1);
    check('sent exactly once (no re-send)', (await runDueActions(store, engine, future)).sent === 0);
    store.close();
  }

  // B) item_in_group_for_days armed at entry, fires after N days.
  {
    const rules: Rule[] = [
      {
        id: 'timed',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP_A },
        trigger: { type: 'item_in_group_for_days', days: 7 },
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: '7 days stale' }],
      },
    ];
    const { store, engine, slacks } = harness(rules, () => GROUP_A);
    const r = await engine.handleEvent(entered());
    check('timed rule armed at entry', r.scheduled === 1);
    check('not due at day 0', (await runDueActions(store, engine, now)).sent === 0);
    check('due at day 8', (await runDueActions(store, engine, now + 8 * DAY)).sent === 1 && slacks.length === 1);
    store.close();
  }

  // C) leaving the group clears pending actions.
  {
    const rules: Rule[] = [
      {
        id: 'timed',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP_A },
        trigger: { type: 'item_in_group_for_days', days: 7 },
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'stale' }],
      },
    ];
    const { store, engine } = harness(rules, () => GROUP_A);
    await engine.handleEvent(entered());
    check('armed before leaving', store.dueActions(future).length === 1);
    const r = await engine.handleEvent(left());
    check('leaving cleared the pending action', r.cleared === 1 && store.dueActions(future).length === 0);
    store.close();
  }

  // D) re-entry to a different group resets (cancels old timer).
  {
    const rules: Rule[] = [
      {
        id: 'timed-a',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP_A },
        trigger: { type: 'item_in_group_for_days', days: 7 },
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'A stale' }],
      },
    ];
    let group = GROUP_A;
    const { store, engine } = harness(rules, () => group);
    await engine.handleEvent(entered());
    check('armed in group A', store.dueActions(future).length === 1);
    group = GROUP_B; // item now reports group B
    const enteredB: NormalizedEvent = {
      kind: 'item_entered_group',
      boardId: BOARD,
      itemId: 100,
      groupId: GROUP_B,
      reason: 'moved',
      raw: {},
    };
    const r = await engine.handleEvent(enteredB);
    check('moving to group B cancelled the group-A timer', r.cleared === 1 && store.dueActions(future).length === 0);
    store.close();
  }

  // E) dedupe_key prevents double-arming within one entry.
  {
    const store = new SqliteStore(':memory:');
    store.enqueue({ itemId: 1, ruleId: 'r', actionType: 'slack', payload: {}, dueAt: 1, dedupeKey: 'k1' });
    store.enqueue({ itemId: 1, ruleId: 'r', actionType: 'slack', payload: {}, dueAt: 1, dedupeKey: 'k1' });
    check('duplicate dedupe_key inserts only once', store.dueActions(future).length === 1);
    store.close();
  }

  // F) event dedupe (processed_events).
  {
    const store = new SqliteStore(':memory:');
    check('event not processed yet', store.hasProcessedEvent('evt-1') === false);
    store.markProcessedEvent('evt-1', Date.now());
    check('event marked processed', store.hasProcessedEvent('evt-1') === true);
    store.close();
  }

  // G) queue management (admin UI): list / get / reschedule / delete.
  {
    const store = new SqliteStore(':memory:');
    store.enqueue({ itemId: 7, ruleId: 'r', actionType: 'slack', payload: { text: 'hi' }, dueAt: future });
    const all = store.listActions().actions;
    check('listActions returns the queued row', all.length === 1 && all[0].itemId === 7);
    const id = all[0].id;
    check('getAction fetches by id', store.getAction(id)?.ruleId === 'r');

    store.rescheduleAction(id, 1); // move into the past → becomes due
    check('rescheduleAction set new due + pending', store.dueActions(future).some((a) => a.id === id));

    store.markSent(id, Date.now());
    store.rescheduleAction(id, 1);
    check('reschedule resets a sent action back to pending', store.getAction(id)?.status === 'pending');

    store.deleteAction(id);
    check('deleteAction removes the row', store.getAction(id) === null && store.listActions().actions.length === 0);
    store.close();
  }

  // H) scheduled set_column with minutes precision is queued (not yet due).
  {
    const rule: Rule = {
      id: 'sc', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
      trigger: { type: 'item_entered_group' },
      actions: [{ type: 'set_column', when: { mode: 'relative', minutes: 30 }, columnId: 'status', value: '1' }],
    };
    const { store, engine } = harness([rule], () => GROUP_A);
    await engine.handleEvent(entered());
    const sc = store.listActions().actions.find((a: any) => a.actionType === 'set_column');
    const dueInMin = sc ? Math.round((sc.dueAt - Date.now()) / 60_000) : -1;
    check('set_column scheduled ~30m out (minutes honored)', !!sc && dueInMin >= 29 && dueInMin <= 31);
    check('scheduled set_column not due now', store.dueActions(Date.now()).every((a) => a.actionType !== 'set_column'));
    store.close();
  }

  // I) move A→B clears A's pending but KEEPS B's freshly-scheduled action.
  //    (Regression: onEnteredGroup's clear-on-move used to run AFTER the rule
  //    loop, cancelling the destination group's just-enqueued action.)
  {
    const rules: Rule[] = [
      {
        id: 'a-sched', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
        trigger: { type: 'item_entered_group' },
        actions: [{ type: 'slack', when: { mode: 'relative', hours: 48 }, text: 'A 48h' }],
      },
      {
        id: 'b-sched', enabled: true, boardId: BOARD, scope: { groupId: GROUP_B },
        trigger: { type: 'item_entered_group' },
        actions: [{ type: 'slack', when: { mode: 'relative', hours: 48 }, text: 'B 48h' }],
      },
    ];
    let group = GROUP_A;
    const { store, engine } = harness(rules, () => group);
    await engine.handleEvent(entered()); // enters group A → schedules A's 48h
    check('A scheduled on entry', store.dueActions(future).length === 1);
    group = GROUP_B;
    const enteredB: NormalizedEvent = {
      kind: 'item_entered_group', boardId: BOARD, itemId: 100, groupId: GROUP_B, reason: 'moved', raw: {},
    };
    const r = await engine.handleEvent(enteredB); // move A→B
    const pending = store.dueActions(future);
    check('move cleared A but kept B (1 pending = B)', r.cleared === 1 && r.scheduled === 1 && pending.length === 1);
    check("surviving action is B's", (pending[0].payload as SlackMessage).text === 'B 48h');
    store.close();
  }

  // J) fire-time re-check: a timed rule's condition is re-evaluated before sending.
  {
    const rules: Rule[] = [
      {
        id: 'timed-cond', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
        trigger: { type: 'item_in_group_for_days', days: 7 },
        conditions: [{ type: 'status_is_not', columnId: 'status', label: 'Done' }],
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'still not done' }],
      },
    ];
    const mkHarness = (statusRef: { v: string }) => {
      const store = new SqliteStore(':memory:');
      const slacks: SlackMessage[] = [];
      const senders: Senders = { async sendEmail() {}, async sendSlack(m) { slacks.push(m); } };
      const hydrate = async (): Promise<ItemContext> => ({
        ...item(GROUP_A),
        columns: { status: { text: statusRef.v, value: null, type: 'color' } },
      });
      return { store, slacks, engine: new RulesEngine({ rules, store, senders, hydrate }) };
    };

    // J1: condition still holds at fire time → sends.
    {
      const st = { v: 'Working on it' };
      const { store, engine, slacks } = mkHarness(st);
      await engine.handleEvent(entered());
      const r = await runDueActions(store, engine, now + 8 * DAY);
      check('re-check fires when the condition still holds', r.sent === 1 && r.skipped === 0 && slacks.length === 1);
      store.close();
    }

    // J2: condition fails by fire time → skipped + cancelled (never re-tried).
    {
      const st = { v: 'Working on it' };
      const { store, engine, slacks } = mkHarness(st);
      await engine.handleEvent(entered());
      check('timed+condition armed at entry', store.dueActions(future).length === 1);
      st.v = 'Done'; // patient "signed" → condition no longer holds
      const r = await runDueActions(store, engine, now + 8 * DAY);
      check('re-check skips when the condition no longer holds', r.sent === 0 && r.skipped === 1 && slacks.length === 0);
      check('skipped action is cancelled, not left pending', store.dueActions(future).length === 0);
      store.close();
    }
  }

  // J3-J5) the shape the real x-ray nudge uses: a timed rule gated by an
  // `conditionGroups` column value that is still EMPTY when the rule is armed and
  // only gets filled in during the wait. This is why the nudge is a timed rule and
  // not a delayed action on the entry rule (those conditions run at event time).
  {
    const XRAY = 'color_mm5fdxvj';
    const rules: Rule[] = [
      {
        id: 'xray-nudge', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
        trigger: { type: 'item_in_group_for_days', days: 2 },
        conditionGroups: [{ conditions: [{ type: 'column_equals', columnId: XRAY, value: 'Yes' }] }],
        actions: [{ type: 'slack', when: { mode: 'immediate' }, text: 'Request x-rays' }],
      },
    ];
    const mkHarness = (xrayRef: { v: string }) => {
      const store = new SqliteStore(':memory:');
      const slacks: SlackMessage[] = [];
      const senders: Senders = { async sendEmail() {}, async sendSlack(m) { slacks.push(m); } };
      const hydrate = async (): Promise<ItemContext> => ({
        ...item(GROUP_A),
        columns: { [XRAY]: { text: xrayRef.v, value: null, type: 'color' } },
      });
      return { store, slacks, engine: new RulesEngine({ rules, store, senders, hydrate }) };
    };

    // J3: empty at entry, "Yes" by the 2-day mark → sends.
    {
      const xray = { v: '' };
      const { store, engine, slacks } = mkHarness(xray);
      await engine.handleEvent(entered());
      check('x-ray nudge is armed even though the column is empty at entry', store.dueActions(future).length === 1);
      xray.v = 'Yes';
      const r = await runDueActions(store, engine, now + 3 * DAY);
      check('x-ray nudge fires when the column reads Yes at the 2-day mark', r.sent === 1 && slacks.length === 1);
      store.close();
    }

    // J4: still empty at the 2-day mark → skipped (patient never had x-rays recorded).
    {
      const xray = { v: '' };
      const { store, engine, slacks } = mkHarness(xray);
      await engine.handleEvent(entered());
      const r = await runDueActions(store, engine, now + 3 * DAY);
      check('x-ray nudge is skipped while the column is empty', r.sent === 0 && r.skipped === 1 && slacks.length === 0);
      store.close();
    }

    // J5: explicit "No" → skipped.
    {
      const xray = { v: 'No' };
      const { store, engine, slacks } = mkHarness(xray);
      await engine.handleEvent(entered());
      const r = await runDueActions(store, engine, now + 3 * DAY);
      check('x-ray nudge is skipped when the column reads No', r.sent === 0 && r.skipped === 1 && slacks.length === 0);
      store.close();
    }
  }

  // L) send-time re-render: a queued message reflects the item as it is when it
  // SENDS, not as it was when the rule armed. This is the whole point of the
  // "what's still outstanding" reminders — the checklist moves during the wait.
  {
    const XRAY = 'Request x-rays';
    const mk = (rules: Rule[], subs: () => Array<{ name: string; status: string }>, itemName = () => 'Pt') => {
      const store = new SqliteStore(':memory:');
      const slacks: SlackMessage[] = [];
      const emails: any[] = [];
      const senders: Senders = { async sendEmail(m) { emails.push(m); }, async sendSlack(m) { slacks.push(m); } };
      const hydrate = async (): Promise<ItemContext> => ({
        ...item(GROUP_A),
        name: itemName(),
        subitems: subs().map((s, i) => ({
          id: i + 1, boardId: 18403436575, name: s.name,
          columns: { status: { text: s.status, value: null, type: 'color' } },
        })),
      });
      return { store, slacks, emails, engine: new RulesEngine({ rules, store, senders, hydrate }) };
    };
    const missingDocs: Rule[] = [
      {
        id: 'missing-docs', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
        trigger: { type: 'item_in_group_for_days', days: 7 },
        actions: [{
          type: 'slack', when: { mode: 'immediate' },
          text: `{{#subitem "${XRAY}"}}{{#ifEquals column.status "Done"}}{{else}}NEED-XRAYS{{/ifEquals}}{{/subitem}}`,
        }],
      },
    ];

    // L1: ticked Done during the 7-day wait → the reminder drops that line.
    {
      const sub = { name: XRAY, status: 'Pending' };
      const { store, engine, slacks } = mk(missingDocs, () => [sub]);
      await engine.handleEvent(entered());
      sub.status = 'Done'; // staff completes it during the wait
      await runDueActions(store, engine, now + 8 * DAY);
      check('re-render drops work completed during the wait', slacks[0]?.text === '');
      store.close();
    }

    // L2: still outstanding at send time → still reported.
    {
      const sub = { name: XRAY, status: 'Pending' };
      const { store, engine, slacks } = mk(missingDocs, () => [sub]);
      await engine.handleEvent(entered());
      await runDueActions(store, engine, now + 8 * DAY);
      check('re-render keeps work that is still outstanding', slacks[0]?.text === 'NEED-XRAYS');
      store.close();
    }

    // L3: a subitem added to the template AFTER the item was cloned is picked up.
    {
      const subs: Array<{ name: string; status: string }> = [];
      const { store, engine, slacks } = mk(missingDocs, () => subs);
      await engine.handleEvent(entered()); // armed with NO subitems at all
      subs.push({ name: XRAY, status: 'Pending' });
      await runDueActions(store, engine, now + 8 * DAY);
      check('re-render sees subitems that appeared after arming', slacks[0]?.text === 'NEED-XRAYS');
      store.close();
    }

    // L4: plain {{vars}} are re-read too (item renamed during the wait).
    {
      let name = 'Old Name';
      const rules: Rule[] = [{
        id: 'nm', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
        trigger: { type: 'item_entered_group' },
        actions: [{ type: 'slack', when: { mode: 'relative', days: 2 }, text: 'Hi {{item.name}}' }],
      }];
      const { store, engine, slacks } = mk(rules, () => [], () => name);
      await engine.handleEvent(entered());
      name = 'New Name';
      await runDueActions(store, engine, now + 3 * DAY);
      check('re-render picks up column/name changes', slacks[0]?.text === 'Hi New Name');
      store.close();
    }

    // L5: legacy rows (queued before render envelopes existed) send exactly as armed.
    {
      const { store, engine, slacks } = mk([], () => []);
      store.enqueue({ itemId: 100, ruleId: 'gone', actionType: 'slack', payload: { text: 'frozen' }, dueAt: now });
      const r = await runDueActions(store, engine, now + 1);
      check('row without a render envelope sends as armed', r.sent === 1 && slacks[0]?.text === 'frozen');
      store.close();
    }

    // L6: hydrate failure → send as armed rather than dropping or blanking it.
    {
      const store = new SqliteStore(':memory:');
      const slacks: SlackMessage[] = [];
      const senders: Senders = { async sendEmail() {}, async sendSlack(m) { slacks.push(m); } };
      let alive = true;
      const engine = new RulesEngine({
        rules: [{
          id: 'hf', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
          trigger: { type: 'item_entered_group' },
          actions: [{ type: 'slack', when: { mode: 'relative', days: 1 }, text: 'Hi {{item.name}}' }],
        }],
        store, senders,
        hydrate: async () => {
          if (!alive) throw new Error('monday down');
          return item(GROUP_A);
        },
      });
      await engine.handleEvent(entered());
      alive = false;
      const r = await runDueActions(store, engine, now + 2 * DAY);
      check('hydrate failure at send time → sends the armed payload', r.sent === 1 && slacks[0]?.text === 'Hi Item');
      store.close();
    }

    // L7: recipients are re-resolved, but a newly-empty column keeps the armed ones
    // (better a slightly stale address than an email with nowhere to go).
    {
      const store = new SqliteStore(':memory:');
      const emails: any[] = [];
      const senders: Senders = { async sendEmail(m) { emails.push(m); }, async sendSlack() {} };
      let addr = 'first@example.com';
      const engine = new RulesEngine({
        rules: [{
          id: 'rcp', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
          trigger: { type: 'item_entered_group' },
          actions: [{ type: 'email', when: { mode: 'relative', days: 1 }, subject: 's', body: 'b', toFromColumns: ['email_col'] }],
        }],
        store, senders,
        hydrate: async () => ({
          ...item(GROUP_A),
          columns: { email_col: { text: addr, value: null, type: 'email' } },
        }),
      });
      await engine.handleEvent(entered());
      addr = 'corrected@example.com';
      await runDueActions(store, engine, now + 2 * DAY);
      check('recipients re-resolved at send time', emails[0]?.to.join() === 'corrected@example.com');

      const store2 = new SqliteStore(':memory:');
      const emails2: any[] = [];
      const senders2: Senders = { async sendEmail(m) { emails2.push(m); }, async sendSlack() {} };
      let addr2 = 'kept@example.com';
      const engine2 = new RulesEngine({
        rules: [{
          id: 'rcp2', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
          trigger: { type: 'item_entered_group' },
          actions: [{ type: 'email', when: { mode: 'relative', days: 1 }, subject: 's', body: 'b', toFromColumns: ['email_col'] }],
        }],
        store: store2, senders: senders2,
        hydrate: async () => ({
          ...item(GROUP_A),
          columns: { email_col: { text: addr2, value: null, type: 'email' } },
        }),
      });
      await engine2.handleEvent(entered());
      addr2 = ''; // column cleared during the wait
      await runDueActions(store2, engine2, now + 2 * DAY);
      check('cleared recipient column falls back to the armed recipients', emails2[0]?.to.join() === 'kept@example.com');
      store.close();
      store2.close();
    }

    // L8: the condition gate still wins over a successful re-render.
    {
      const sub = { name: XRAY, status: 'Pending' };
      const gated: Rule[] = [{
        ...missingDocs[0], id: 'gated',
        conditions: [{ type: 'subitem_not_checked', columnId: 'status', subitemName: XRAY, label: 'Done' }],
      }];
      const { store, engine, slacks } = mk(gated, () => [sub]);
      await engine.handleEvent(entered());
      sub.status = 'Done';
      const r = await runDueActions(store, engine, now + 8 * DAY);
      check('condition gate still cancels before re-rendering matters', r.skipped === 1 && slacks.length === 0);
      store.close();
    }
  }

  // K) clear_pending scope='rules' cancels only the targeted rule's queued actions.
  {
    // K1: store-level scoped cancel.
    const store = new SqliteStore(':memory:');
    store.enqueue({ itemId: 100, ruleId: 'rule-x', actionType: 'slack', payload: { text: 'x' }, dueAt: future });
    store.enqueue({ itemId: 100, ruleId: 'rule-y', actionType: 'slack', payload: { text: 'y' }, dueAt: future });
    const n = store.cancelPendingForItem(100, ['rule-x']);
    check('scoped cancel removes only the targeted rule row', n === 1 && store.dueActions(future).length === 1);
    check("the surviving row is rule-y's", store.dueActions(future)[0].ruleId === 'rule-y');
    store.close();

    // K2: same, driven through a clear_pending action on a matched rule.
    const store2 = new SqliteStore(':memory:');
    store2.enqueue({ itemId: 100, ruleId: 'rule-x', actionType: 'slack', payload: { text: 'x' }, dueAt: future });
    store2.enqueue({ itemId: 100, ruleId: 'rule-y', actionType: 'slack', payload: { text: 'y' }, dueAt: future });
    const rules: Rule[] = [
      {
        id: 'canceller', enabled: true, boardId: BOARD, scope: { groupId: GROUP_A },
        trigger: { type: 'item_entered_group' },
        actions: [{ type: 'clear_pending', scope: 'rules', ruleIds: ['rule-x'] }],
      },
    ];
    const senders: Senders = { async sendEmail() {}, async sendSlack() {} };
    const engine = new RulesEngine({ rules, store: store2, senders, hydrate: async () => item(GROUP_A) });
    const r = await engine.handleEvent(entered());
    check('clear_pending scope=rules cancelled one action', r.cleared === 1);
    const remaining = store2.dueActions(future);
    check('only rule-y survives the scoped clear', remaining.length === 1 && remaining[0].ruleId === 'rule-y');
    store2.close();
  }

  // N) admin queue listing: SQL paging + filtering + facets + bulk delete.
  //    Regression: the list used to fetch the newest 200 rows and filter them in
  //    the browser, so an older pending action was invisible in the UI even
  //    though the worker would still fire it.
  {
    const store = new SqliteStore(':memory:');
    for (let i = 0; i < 230; i++) {
      store.enqueue({
        itemId: 1000 + (i % 4),
        ruleId: i % 2 ? 'rule-even' : 'rule-odd',
        actionType: i % 3 === 0 ? 'email' : 'slack',
        payload: { text: `n${i}` },
        dueAt: future,
        dedupeKey: `k${i}`,
      });
    }
    const everything = store.listActions({ limit: 500 });
    // Mark the 210 NEWEST as sent, leaving the 20 oldest pending — the rows the
    // old newest-200 window could never show.
    everything.actions.slice(0, 210).forEach((a) => store.markSent(a.id, Date.now()));

    const page1 = store.listActions({ limit: 25 });
    check('listActions pages (25 rows, total = whole table)', page1.actions.length === 25 && page1.total === 230);
    const page2 = store.listActions({ limit: 25, offset: 25 });
    check('offset returns a different page', page2.actions.length === 25 && page2.actions[0].id !== page1.actions[0].id);
    const lastPage = store.listActions({ limit: 25, offset: 225 });
    check('final page is a short page', lastPage.actions.length === 5 && lastPage.total === 230);

    const pending = store.listActions({ status: 'pending', limit: 25 });
    check('status filter counts every match, not just the newest 200', pending.total === 20);
    check('filtered page contains only that status', pending.actions.every((a) => a.status === 'pending'));

    const byRule = store.listActions({ ruleId: 'rule-odd', limit: 5 });
    check('ruleId filter applies in SQL', byRule.total === 115 && byRule.actions.every((a) => a.ruleId === 'rule-odd'));
    const byItem = store.listActions({ itemId: 1002, limit: 5 });
    check('itemId filter applies in SQL', byItem.total === 57 && byItem.actions.every((a) => a.itemId === 1002));
    const combined = store.listActions({ status: 'pending', actionType: 'email', limit: 50 });
    check('filters combine (AND)', combined.actions.every((a) => a.status === 'pending' && a.actionType === 'email')
      && combined.total === combined.actions.length);

    const facets = store.queueFacets();
    check('facets span the whole table, not one page',
      facets.statuses.join() === 'pending,sent' &&
      facets.actionTypes.join() === 'email,slack' &&
      facets.ruleIds.join() === 'rule-even,rule-odd' &&
      facets.itemIds.length === 4);

    const victims = page1.actions.slice(0, 3).map((a) => a.id);
    const deleted = store.deleteActions(victims);
    check('deleteActions removes exactly the given ids',
      deleted === 3 && victims.every((id) => store.getAction(id) === null) && store.listActions({ limit: 1 }).total === 227);
    check('deleteActions ignores duplicates and junk ids', store.deleteActions([...victims, NaN as any]) === 0);
    check('deleteActions on an empty list is a no-op', store.deleteActions([]) === 0);
    store.close();
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nQueue test failed:', err?.message ?? err);
  process.exitCode = 1;
});
