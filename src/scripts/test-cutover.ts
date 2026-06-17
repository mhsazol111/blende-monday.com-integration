import assert from 'node:assert';
import { RulesEngine } from '../rules/engine.js';
import {
  matchTemplateByGroupTitle,
  prepareSubitemColumnValues,
  templateAlreadyApplied,
  type CloneOptions,
} from '../monday/clone.js';
import type { ItemContext } from '../monday/hydrate.js';
import type { NormalizedEvent } from '../events/types.js';
import type { Rule } from '../rules/types.js';

/**
 * Phase 6 verification: the ported template-subitem cloner (pure logic) and its
 * wiring as a `clone_template_subitems` action. Run: `npm run test:cutover`.
 */

const BOARD = 18403436566;
const GROUP = 'group_x';
const SOURCE_COL = 'text_mm1n5vbd';

let passed = 0;
const check = (name: string, cond: boolean) => {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
};

function item(over: Partial<ItemContext> = {}): ItemContext {
  return {
    id: 100,
    boardId: BOARD,
    name: 'Patient',
    groupId: GROUP,
    groupTitle: 'NP Consultation Active',
    columns: {},
    subitems: [],
    people: {},
    ...over,
  };
}

const entered: NormalizedEvent = {
  kind: 'item_entered_group',
  boardId: BOARD,
  itemId: 100,
  groupId: GROUP,
  reason: 'moved',
  raw: {},
};

async function main() {
  // 1) template matching by group title substring.
  {
    const templates = [{ id: '1', name: 'NP Consultation' }, { id: '2', name: 'On Lok' }];
    const m = matchTemplateByGroupTitle('NP Consultation Active', templates);
    check('matches template whose name is in the group title', m?.id === '1');
    check('no match returns null', matchTemplateByGroupTitle('Unrelated', templates) === null);
  }

  // 2) prepareSubitemColumnValues skips non-portable cols and forces source.
  {
    const out = prepareSubitemColumnValues(
      [
        { id: 'name', type: 'name', value: '"x"' },
        { id: 'mirror_1', type: 'mirror', value: '"y"' },
        { id: 'status', type: 'color', value: '{"index":1}' },
        { id: SOURCE_COL, type: 'text', value: '"old"' },
      ],
      SOURCE_COL,
      'NP Consultation',
    );
    check('skips name + mirror columns', !('name' in out) && !('mirror_1' in out));
    check('keeps portable status column (parsed)', JSON.stringify((out as any).status) === '{"index":1}');
    check('forces template-source column to template name', (out as any)[SOURCE_COL] === 'NP Consultation');
  }

  // 3) already-applied detection via the source column on a subitem.
  {
    const applied = item({
      subitems: [{ id: 1, boardId: 0, name: 'sub', columns: { [SOURCE_COL]: { text: 'NP Consultation', value: null, type: 'text' } } }],
    });
    check('detects already-applied template', templateAlreadyApplied(applied, SOURCE_COL, 'NP Consultation'));
    check('detects not-applied template', !templateAlreadyApplied(item(), SOURCE_COL, 'NP Consultation'));
  }

  // 4) engine invokes the clone action with the right options.
  {
    const captured: { opts?: CloneOptions } = {};
    const rules: Rule[] = [
      {
        id: 'clone',
        enabled: true,
        boardId: BOARD,
        scope: { groupId: GROUP },
        trigger: { type: 'item_entered_group' },
        actions: [
          { type: 'clone_template_subitems', templatesGroupTitle: 'Templates', templateSourceColumnId: SOURCE_COL },
        ],
      },
    ];
    const engine = new RulesEngine({
      rules,
      hydrate: async () => item(),
      cloner: async (_it, opts) => {
        captured.opts = opts;
        return { action: 'created', created: 3, templateName: 'NP Consultation' };
      },
    });
    const r = await engine.handleEvent(entered);
    check('clone action executed', r.executed === 1);
    check('cloner received configured options', captured.opts?.templatesGroupTitle === 'Templates' && captured.opts?.templateSourceColumnId === SOURCE_COL);
  }

  console.log(`\n${passed} checks passed.`);
}

main().catch((err) => {
  console.error('\nCutover test failed:', err?.message ?? err);
  process.exitCode = 1;
});
