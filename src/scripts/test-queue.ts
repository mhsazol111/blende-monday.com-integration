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
    const all = store.listActions();
    check('listActions returns the queued row', all.length === 1 && all[0].itemId === 7);
    const id = all[0].id;
    check('getAction fetches by id', store.getAction(id)?.ruleId === 'r');

    store.rescheduleAction(id, 1); // move into the past → becomes due
    check('rescheduleAction set new due + pending', store.dueActions(future).some((a) => a.id === id));

    store.markSent(id, Date.now());
    store.rescheduleAction(id, 1);
    check('reschedule resets a sent action back to pending', store.getAction(id)?.status === 'pending');

    store.deleteAction(id);
    check('deleteAction removes the row', store.getAction(id) === null && store.listActions().length === 0);
    store.close();
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nQueue test failed:', err?.message ?? err);
  process.exitCode = 1;
});
