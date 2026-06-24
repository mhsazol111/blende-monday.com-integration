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

export function renderTemplate(tpl: string, context: Record<string, unknown>): string {
  const resolved = renderConditionals(tpl, context);
  return resolved.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = resolvePath(path, context);
    return value === undefined || value === null ? '' : String(value);
  });
}
