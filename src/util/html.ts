/**
 * Convert the rich-text (HTML) authored in the configurator into the two forms
 * we actually send:
 *  - email → HTML is used directly; we also derive a plain-text fallback.
 *  - Slack → Slack's `mrkdwn` (it does NOT render HTML).
 *
 * Authors write one message; these keep it "robust for both". Plain text passes
 * through unchanged, so older rules (plain `body`/`text`) keep working.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => ENTITIES[m] ?? m);
}

function collapseBlankLines(s: string): string {
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Does the string contain HTML markup OR entities? Entities matter because a
 * contenteditable editor emits `&nbsp;` for spaces even with no tags — without
 * this they'd reach email/Slack literally (the "spaces show as &nbsp;" bug).
 */
export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(s) || /&(?:[a-z]+|#\d+);/i.test(s);
}

/** Insert newlines for block-level tags and bullets for list items. */
function blockify(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    // `</li>` ends the bullet's line, so it also absorbs the source newline that
    // normally follows it — otherwise each `</li>\n` yields two newlines and
    // every bullet in a list arrives with a blank line above it. Paragraph
    // breaks (`</p>\n\n<p>`) are left alone and still separate with a blank line.
    .replace(/<\s*\/\s*li\s*>[ \t]*\r?\n?/gi, '\n')
    .replace(/<\s*\/\s*(p|div|ul|ol|h[1-6]|tr)\s*>/gi, '\n');
}

const LINK_RE = /<\s*a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi;
const STRIP_RE = /<[^>]+>/g;

/** HTML to Slack mrkdwn (*bold*, _italic_, <url|text> links, bullets). */
export function htmlToSlack(input: string): string {
  if (!looksLikeHtml(input)) return input;
  let s = blockify(input);
  s = s.replace(/<\s*(strong|b)\s*>/gi, '*').replace(/<\s*\/\s*(strong|b)\s*>/gi, '*');
  s = s.replace(/<\s*(em|i)\s*>/gi, '_').replace(/<\s*\/\s*(em|i)\s*>/gi, '_');
  s = s.replace(/<\s*(s|strike|del)\s*>/gi, '~').replace(/<\s*\/\s*(s|strike|del)\s*>/gi, '~');
  // Slack links use angle brackets, which the tag-strip below would eat — so
  // stash them behind a token sentinel and restore after stripping.
  const links: string[] = [];
  s = s.replace(LINK_RE, (_m, url, text) => {
    links.push('<' + url + '|' + String(text).replace(STRIP_RE, '').trim() + '>');
    return '@@LINK' + (links.length - 1) + '@@';
  });
  s = s.replace(STRIP_RE, '');
  s = s.replace(/@@LINK(\d+)@@/g, (_m, i) => links[Number(i)] ?? '');
  return collapseBlankLines(decodeEntities(s));
}

/**
 * Prepare an HTML body for a monday **Update** (`create_update`).
 *
 * monday's update renderer turns every newline in the submitted body into a
 * literal `<br>`, which a browser would have collapsed as insignificant
 * whitespace. Our templates are authored with newlines between block tags for
 * readability, so `</p>\n\n<p>` arrived as `</p><br><br><p>` — a paragraph gap
 * plus two blank lines — and `<ul>\n<li>` put a stray break above every bullet.
 *
 * This restores browser whitespace semantics before the body is sent: a newline
 * between two tags is insignificant and disappears, a newline inside running
 * text collapses to a single space. Explicit `<br>` and spaces already in the
 * markup are untouched, so nothing an author *asked* for is lost — and the
 * Update now renders like the same HTML does in the email path.
 *
 * Only applied to markup: a plain-text body has no tags, so its newlines are
 * the author's only line breaks and monday's `\n`→`<br>` is exactly right.
 * Whitespace-significant elements bail out for the same reason.
 */
const PREFORMATTED_RE = /<\s*(pre|textarea)\b/i;

export function htmlForMondayUpdate(input: string): string {
  if (!looksLikeHtml(input) || PREFORMATTED_RE.test(input)) return input;
  return input
    .replace(/>[ \t]*\r?\n[ \t\r\n]*</g, '><') // between tags: insignificant
    .replace(/[ \t]*\r?\n[ \t\r\n]*/g, ' ') // inside text: one space
    .trim();
}

/** HTML to plain text (links become "text (url)"); the email text fallback. */
export function htmlToText(input: string): string {
  if (!looksLikeHtml(input)) return input;
  let s = blockify(input);
  s = s.replace(LINK_RE, '$2 ($1)');
  s = s.replace(STRIP_RE, '');
  return collapseBlankLines(decodeEntities(s));
}
