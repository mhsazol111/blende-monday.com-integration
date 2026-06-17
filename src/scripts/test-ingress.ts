import assert from 'node:assert';
import { buildServer } from '../server.js';
import { normalizeEvent } from '../monday/normalizer.js';

/**
 * Offline verification of the ingress + normalizer using Fastify `inject`
 * (no network). Run: `npm run test:ingress`.
 *
 * Sample payloads approximate monday's webhook shapes; they will be reconciled
 * against real captured payloads during live testing.
 */

const SUBITEM_BOARD = 18403436575;
const BOARD = 18403436566;

async function main() {
  const app = buildServer();
  let passed = 0;
  const check = (name: string, cond: boolean) => {
    assert.ok(cond, `FAILED: ${name}`);
    console.log(`  ✓ ${name}`);
    passed++;
  };

  // 1) challenge handshake
  let res = await app.inject({ method: 'POST', url: '/webhook', payload: { challenge: 'abc123' } });
  check('challenge echoed', res.json().challenge === 'abc123');

  // 2) health
  res = await app.inject({ method: 'GET', url: '/health' });
  check('health ok', res.json().ok === true);

  // 3) normalizer unit checks (independent of HTTP)
  const created = normalizeEvent({ type: 'create_pulse', boardId: BOARD, pulseId: 1, groupId: 'group_x' });
  check('create_pulse → item_entered_group/created', created.kind === 'item_entered_group');

  const moved = normalizeEvent({ type: 'move_pulse_into_group', boardId: BOARD, pulseId: 2, groupId: 'group_y' });
  check(
    'move_pulse_into_group → item_entered_group/moved',
    moved.kind === 'item_entered_group' && moved.reason === 'moved',
  );

  const status = normalizeEvent({
    type: 'update_column_value',
    boardId: BOARD,
    pulseId: 3,
    columnId: 'status',
    columnType: 'color',
    value: { label: { index: 1, text: 'Done' } },
  });
  check(
    'status column change → status_changed (Done)',
    status.kind === 'status_changed' && status.label === 'Done' && status.labelIndex === 1,
  );

  const text = normalizeEvent({
    type: 'update_column_value',
    boardId: BOARD,
    pulseId: 4,
    columnId: 'text_mm2wm34h',
    columnType: 'text',
    value: { value: 'hello' },
  });
  check('text column change → column_changed', text.kind === 'column_changed');

  const sub = normalizeEvent({
    type: 'update_column_value',
    boardId: SUBITEM_BOARD,
    pulseId: 99,
    parentItemId: 3,
    columnId: 'status',
    columnType: 'color',
    value: { label: { index: 1, text: 'Done' } },
  });
  check(
    'subitem status change → subitem_changed (parent linked)',
    sub.kind === 'subitem_changed' && sub.parentItemId === 3,
  );

  const unknown = normalizeEvent({ type: 'something_new', boardId: BOARD, pulseId: 6 });
  check('unrecognized type → unknown', unknown.kind === 'unknown');

  // 4) full HTTP path with a real-ish event
  res = await app.inject({
    method: 'POST',
    url: '/webhook',
    payload: { event: { type: 'create_pulse', boardId: BOARD, pulseId: 7, groupId: 'group_z' } },
  });
  check('POST event → ok + kind', res.json().ok === true && res.json().kind === 'item_entered_group');

  await app.close();
  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nIngress test failed:', err?.message ?? err);
  process.exitCode = 1;
});
