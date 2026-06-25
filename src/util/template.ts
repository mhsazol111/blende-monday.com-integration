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
 * Blocks may be nested. Conditionals are resolved before placeholder
 * substitution, so the chosen branch's {{vars}} are still expanded.
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
// the open keyword via the \1 backreference.
const BLOCK_RE =
  /\{\{#(if|unless|ifEquals)\s+([\w.]+)\s*(?:"([^"]*)")?\s*\}\}((?:(?!\{\{#)[\s\S])*?)\{\{\/\1\}\}/;

export function renderConditionals(tpl: string, context: Record<string, unknown>): string {
  let s = tpl;
  // Resolve innermost blocks until none remain (bounded to avoid pathological loops).
  for (let guard = 0; guard < 1000; guard++) {
    const m = BLOCK_RE.exec(s);
    if (!m) break;
    const [full, keyword, path, quoted, body] = m;
    const value = resolvePath(path, context);
    let pass: boolean;
    if (keyword === 'unless') pass = !isTruthy(value);
    else if (keyword === 'ifEquals') pass = String(value ?? '').trim().toLowerCase() === (quoted ?? '').trim().toLowerCase();
    else pass = isTruthy(value); // 'if'

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

/** Build the child context for a `{{#subitem "name"}}` block. */
function scopeForSubitem(context: Record<string, unknown>, name: string): Record<string, unknown> {
  const list = Array.isArray(context.subitems)
    ? (context.subitems as Array<{ name: string; column: Record<string, string> }>)
    : [];
  const sub = list.find((s) => String(s.name).toLowerCase() === name.toLowerCase());
  const resolvedName = sub?.name ?? name;
  const column = sub?.column ?? {};
  return { ...context, name: resolvedName, column, subitem: { name: resolvedName, column } };
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
    out += renderTemplate(body, scopeForSubitem(context, m[1]));
    rest = rest.slice(close + SUBITEM_CLOSE_TAG.length);
  }
  return out;
}

export function renderTemplate(tpl: string, context: Record<string, unknown>): string {
  const scoped = renderSubitemBlocks(tpl, context);
  const resolved = renderConditionals(scoped, context);
  return resolved.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = resolvePath(path, context);
    return value === undefined || value === null ? '' : String(value);
  });
}
