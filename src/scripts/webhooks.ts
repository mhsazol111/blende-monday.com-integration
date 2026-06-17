import { env } from '../config/env.js';
import {
  listWebhooks,
  reconcileWebhooks,
  deleteWebhook,
  buildWebhookUrl,
  WEBHOOK_EVENTS,
} from '../monday/webhooks.js';

/**
 * CLI for managing monday webhooks (the debugging counterpart to the
 * configurator's "Connect" button). Webhooks are decoupled from rule logic, so
 * you register once per board and only touch this again if the public URL
 * changes.
 *
 *   npm run webhooks                       # list webhooks on MONDAY_BOARD_ID
 *   npm run webhooks -- list [boardId]
 *   npm run webhooks -- register [boardId] # idempotent: full managed event set
 *   npm run webhooks -- delete <id>
 *
 * `register` needs PUBLIC_URL (e.g. https://blende-monday.mhsazol.me) and uses
 * WEBHOOK_SHARED_SECRET if set.
 */

function resolveBoardId(arg?: string): string {
  const boardId = (arg && !arg.startsWith('-') ? arg : '') || env.mondayBoardId;
  if (!boardId) {
    throw new Error('No board id. Pass one or set MONDAY_BOARD_ID in .env.');
  }
  return boardId;
}

async function cmdList(boardId: string) {
  const webhooks = await listWebhooks(boardId);
  const present = new Set(webhooks.map((w) => w.event));
  console.log(`\nWebhooks on board ${boardId}:`);
  if (webhooks.length === 0) console.log('  (none)');
  for (const w of webhooks) console.log(`  • ${w.event}  —  id: ${w.id}`);

  console.log('\nManaged events (needed for full trigger coverage):');
  for (const event of WEBHOOK_EVENTS) {
    console.log(`  ${present.has(event) ? '✓' : '✗'} ${event}`);
  }
  const connected = WEBHOOK_EVENTS.every((e) => present.has(e));
  console.log(`\n${connected ? '✓ Board is connected.' : '✗ Board is NOT fully connected — run: npm run webhooks -- register'}`);
}

async function cmdRegister(boardId: string) {
  if (!env.publicUrl) {
    throw new Error(
      'PUBLIC_URL is not set. Set it (e.g. PUBLIC_URL=https://blende-monday.mhsazol.me) and retry.',
    );
  }
  const url = buildWebhookUrl(env.publicUrl, env.webhookSharedSecret);
  console.log(`\nRegistering webhooks on board ${boardId} → ${url}`);
  const result = await reconcileWebhooks(boardId, url);
  if (result.removed.length) console.log(`  removed ${result.removed.length} stale: ${result.removed.join(', ')}`);
  for (const w of result.created) console.log(`  ✓ ${w.event}  —  id: ${w.id}`);
  for (const f of result.failed) console.log(`  ✗ ${f.event}  —  ${f.error}`);
  console.log(`\nDone — ${result.created.length} webhook(s) active${result.failed.length ? `, ${result.failed.length} failed` : ''}.`);
}

async function cmdDelete(id?: string) {
  if (!id) throw new Error('Usage: npm run webhooks -- delete <id>');
  const deleted = await deleteWebhook(id);
  console.log(`Deleted webhook ${deleted}.`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'list':
      await cmdList(resolveBoardId(arg));
      break;
    case 'register':
      await cmdRegister(resolveBoardId(arg));
      break;
    case 'delete':
      await cmdDelete(arg);
      break;
    default:
      console.error(`Unknown command "${cmd}". Use: list | register | delete`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('webhooks command failed:', err?.message ?? err);
  if (err?.details) console.error('Details:', JSON.stringify(err.details, null, 2));
  process.exitCode = 1;
});
