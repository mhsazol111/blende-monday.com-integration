import { env } from '../config/env.js';
import { discoverBoard, type BoardStructure } from '../monday/discovery.js';

/**
 * CLI: print a board's structure (groups, columns, status labels) plus its
 * subitem board's columns. These are the IDs the rules engine / configurator
 * need — so nobody has to copy-paste them from the monday UI.
 *
 *   npm run discover            # uses MONDAY_BOARD_ID
 *   npm run discover -- 12345   # explicit board id
 */

function printBoard(board: BoardStructure, label: string) {
  console.log(`\n=== ${label}: ${board.name} (id ${board.id}) ===`);

  console.log('\n  Groups:');
  if (board.groups.length === 0) console.log('    (none)');
  for (const g of board.groups) {
    console.log(`    • ${g.title}  —  id: ${g.id}`);
  }

  console.log('\n  Columns:');
  for (const c of board.columns) {
    let line = `    • ${c.title}  —  id: ${c.id}  [${c.type}]`;
    if (c.subitemBoardIds) line += `  → subitem board(s): ${c.subitemBoardIds.join(', ')}`;
    console.log(line);
    if (c.labels) {
      for (const l of c.labels) {
        console.log(`        - "${l.label}" (index ${l.index})`);
      }
    }
  }
}

async function main() {
  const arg = process.argv[2]?.trim();
  const boardId = arg || env.mondayBoardId;
  if (!boardId) {
    console.error(
      'No board id. Pass one (`npm run discover -- <id>`) or set MONDAY_BOARD_ID in .env.',
    );
    process.exitCode = 1;
    return;
  }

  const { board, subitemBoard } = await discoverBoard(boardId);
  printBoard(board, 'BOARD');
  if (subitemBoard) {
    printBoard(subitemBoard, 'SUBITEM BOARD');
  } else {
    console.log('\n  (No subitem board detected on this board.)');
  }
  console.log('');
}

main().catch((err) => {
  console.error('Discovery failed:', err?.message ?? err);
  if (err?.details) console.error('Details:', JSON.stringify(err.details, null, 2));
  process.exitCode = 1;
});
