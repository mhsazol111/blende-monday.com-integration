/**
 * Tiny {{placeholder}} renderer used for email/Slack subject & body and
 * set_column values. Supports dotted paths: {{item.name}}, {{group.title}},
 * {{status}}, {{column.text_abc123}}, {{subitem.column.x}}. Unknown placeholders
 * render as empty string.
 *
 * Also supports block conditionals so a message can show different text based on
 * a column/subitem value:
 *   {{#if column.x}}has a value{{else}}empty{{/if}}
 *   {{#unless column.x}}still missing{{/unless}}
 *   {{#ifEquals column.x "Done"}}done!{{else}}not yet{{/ifEquals}}
 * `ifEquals` accepts SEVERAL quoted values and passes when the column matches
 * any one of them — the OR the block syntax otherwise lacks:
 *   {{#ifEquals column.status "Done" "NA"}}nothing to chase{{else}}<li>…</li>{{/ifEquals}}
 * Blocks may be nested. Conditionals are resolved before placeholder
 * substitution, so the chosen branch's {{vars}} are still expanded.
 *
 * A block tag that sits ALONE on its own line takes that line with it, so the
 * newline the tag was formatted on doesn't survive into the message as a blank
 * line (the Mustache/Handlebars "standalone tag" rule). Without it, a six-tag
 * block laid out readably leaves six stray newlines behind and every bullet in
 * the rendered list gets a blank line above it. A line that is genuinely blank
 * in the template is untouched.
 *
 * And a scoping block to reference a SPECIFIC subitem by name (matched
 * case-insensitively against `context.subitems`). Inside it, {{name}},
 * {{column.<id>}} and {{subitem.*}} — plus the conditionals above — resolve
 * against that subitem, so one message can describe several named subitems:
 *   {{#subitem "Receive NP paperwork"}}status: {{column.status}}{{/subitem}}
 * A missing subitem renders with its name but empty columns (conditionals fall
 * to {{else}}). Subitem blocks may nest and be nested inside conditionals.
 */

/** Resolve a dotted path (e.g. "subitem.column.x") against the context object. */
function resolvePath(path: string, context: Record<string, unknown>): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, context);
}

/** Truthy = the resolved value is present and not an empty/whitespace string. */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return String(value).trim() !== '';
}

// Matches an INNERMOST block (its body contains no nested `{{#` open tag), so
// repeated passes resolve nesting from the inside out. The close tag is tied to
// the open keyword via the \1 backreference. The argument list is captured whole
// (zero or more quoted values) and split by `quotedValues` below.
const BLOCK_RE =
  /\{\{#(if|unless|ifEquals)\s+([\w.]+)\s*((?:"[^"]*"\s*)*)\}\}((?:(?!\{\{#)[\s\S])*?)\{\{\/\1\}\}/;

const QUOTED_RE = /"([^"]*)"/g;

/** The quoted arguments of a block tag, in order. */
function quotedValues(raw: string): string[] {
  return [...(raw ?? '').matchAll(QUOTED_RE)].map((m) => m[1]);
}

function eq(a: unknown, b: string): boolean {
  return String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

export function renderConditionals(tpl: string, context: Record<string, unknown>): string {
  let s = tpl;
  // Resolve innermost blocks until none remain (bounded to avoid pathological loops).
  for (let guard = 0; guard < 1000; guard++) {
    const m = BLOCK_RE.exec(s);
    if (!m) break;
    const [full, keyword, path, args, body] = m;
    const value = resolvePath(path, context);
    let pass: boolean;
    if (keyword === 'unless') pass = !isTruthy(value);
    else if (keyword === 'ifEquals') {
      // Several values ⇒ OR. No value at all keeps the old meaning (compare to
      // the empty string), so `{{#ifEquals column.x}}` still tests "is empty".
      const wanted = quotedValues(args);
      pass = wanted.length ? wanted.some((w) => eq(value, w)) : eq(value, '');
    } else pass = isTruthy(value); // 'if'

    // A single top-level {{else}} splits the body (innermost → no nested else).
    // Whitespace-tolerant to match the {{ var }} convention used elsewhere.
    const elseMatch = /\{\{\s*else\s*\}\}/.exec(body);
    const truthyPart = elseMatch ? body.slice(0, elseMatch.index) : body;
    const falsyPart = elseMatch ? body.slice(elseMatch.index + elseMatch[0].length) : '';
    const chosen = pass ? truthyPart : falsyPart;
    s = s.slice(0, m.index) + chosen + s.slice(m.index + full.length);
  }
  return s;
}

// ── scope blocks: {{#subitem "Name"}}…{{/subitem}} ──────────────────────────
const SUBITEM_OPEN = /\{\{#subitem\s+"([^"]*)"\s*\}\}/;
const SUBITEM_OPEN_TAG = '{{#subitem';
const SUBITEM_CLOSE_TAG = '{{/subitem}}';

/**
 * Find the `{{/subitem}}` that closes the block whose body starts at `from`,
 * accounting for nested `{{#subitem …}}`. Returns its index, or -1 if unbalanced.
 */
function findSubitemClose(s: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < s.length) {
    const open = s.indexOf(SUBITEM_OPEN_TAG, i);
    const close = s.indexOf(SUBITEM_CLOSE_TAG, i);
    if (close < 0) return -1;
    if (open >= 0 && open < close) {
      depth++;
      i = open + SUBITEM_OPEN_TAG.length;
    } else if (depth > 0) {
      depth--;
      i = close + SUBITEM_CLOSE_TAG.length;
    } else {
      return close;
    }
  }
  return -1;
}

/**
 * Build the child context for a `{{#subitem "name"}}` block, or `null` when the
 * item has no such subitem.
 *
 * `null` means the block renders NOTHING. It used to render with empty columns,
 * which made "subitem absent" indistinguishable from "subitem not done" — so
 * `{{#ifEquals column.status "Done"}}…{{else}}` took the else branch and the
 * message claimed work was outstanding on a checklist item that doesn't exist on
 * that patient. A block can only describe a subitem the item actually has.
 */
function scopeForSubitem(context: Record<string, unknown>, name: string): Record<string, unknown> | null {
  type SubitemScope = {
    name: string;
    column: Record<string, string>;
    columnDate?: Record<string, string>;
    columnTime?: Record<string, string>;
  };
  const list = Array.isArray(context.subitems) ? (context.subitems as SubitemScope[]) : [];
  const sub = list.find((s) => String(s.name).toLowerCase() === name.toLowerCase());
  if (!sub) return null;
  const column = sub.column ?? {};
  // The date/time halves are shadowed too, so inside the block every column
  // lookup — raw or split — reads the subitem, not the parent item.
  const columnDate = sub.columnDate ?? {};
  const columnTime = sub.columnTime ?? {};
  return {
    ...context,
    name: sub.name,
    column,
    columnDate,
    columnTime,
    subitem: { name: sub.name, column, columnDate, columnTime },
  };
}

/** Pre-render {{#subitem "Name"}} blocks with the named subitem as the scope. */
function renderSubitemBlocks(tpl: string, context: Record<string, unknown>): string {
  let out = '';
  let rest = tpl;
  for (let guard = 0; guard < 1000; guard++) {
    const m = SUBITEM_OPEN.exec(rest);
    if (!m) {
      out += rest;
      break;
    }
    out += rest.slice(0, m.index);
    const bodyStart = m.index + m[0].length;
    const close = findSubitemClose(rest, bodyStart);
    if (close < 0) {
      // Unbalanced — emit the remainder literally and stop.
      out += rest.slice(m.index);
      break;
    }
    const body = rest.slice(bodyStart, close);
    // Recurse so nested blocks, conditionals, and {{vars}} render against the scope.
    // No such subitem on this item → the whole block is dropped.
    const scope = scopeForSubitem(context, m[1]);
    if (scope) out += renderTemplate(body, scope);
    rest = rest.slice(close + SUBITEM_CLOSE_TAG.length);
  }
  return out;
}

// ── standalone block tags ───────────────────────────────────────────────────
// One whole block tag: {{#if …}} {{#unless …}} {{#ifEquals …}} {{#subitem "…"}}
// {{/if}} {{/unless}} {{/ifEquals}} {{/subitem}} {{else}}. Tag bodies never
// contain `}`, so `[^}]*` is a safe scan to the closing braces.
const BLOCK_TAG_SRC =
  '\\{\\{(?:#(?:if|unless|ifEquals|subitem)[^}]*\\}\\}|/(?:if|unless|ifEquals|subitem)\\}\\}|\\s*else\\s*\\}\\})';

// A line holding nothing but block tags and whitespace. Consuming the trailing
// newline is what keeps the tag's line out of the output; `$` covers a final
// line with no newline after it.
const STANDALONE_LINE_RE = new RegExp(`^[ \\t]*(?:${BLOCK_TAG_SRC}[ \\t]*)+(?:\\r?\\n|$)`, 'gm');

/**
 * Drop the indentation and the trailing newline of any line that is only block
 * tags, leaving the tags themselves in place for the renderers below.
 *
 * A block tag is punctuation, not content: written on its own line for
 * legibility, it should cost nothing in the message. Authors lay a subitem block
 * out over six lines, and every one of those newlines used to survive the tags
 * disappearing — which is where the blank line above each bullet came from.
 */
function stripStandaloneTagLines(tpl: string): string {
  return tpl.replace(STANDALONE_LINE_RE, (line) => line.trim());
}

export function renderTemplate(tpl: string, context: Record<string, unknown>): string {
  const scoped = renderSubitemBlocks(stripStandaloneTagLines(tpl), context);
  const resolved = renderConditionals(scoped, context);
  return resolved.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = resolvePath(path, context);
    return value === undefined || value === null ? '' : String(value);
  });
}
