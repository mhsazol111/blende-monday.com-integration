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

/** Does the string actually contain HTML tags? (plain text shouldn't be touched) */
export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(s);
}

/** Insert newlines for block-level tags and bullets for list items. */
function blockify(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr)\s*>/gi, '\n');
}

const LINK_RE = /<\s*a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi;
const STRIP_RE = /<[^>]+>/g;

/** HTML to Slack mrkdwn (*bold*, _italic_, <url|text> links, bullets). */
export function htmlToSlack(input: string): string {
  if (!looksLikeHtml(input)) return input;
  let s = blockify(input);
  s = s.replace(/<\s*(strong|b)\s*>/gi, '*').replace(/<\s*\/\s*(strong|b)\s*>/gi, '*');
  s = s.replace(/<\s*(em|i)\s*>/gi, '_').replace(/<\s*\/\s*(em|i)\s*>/gi, '_');
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

/** HTML to plain text (links become "text (url)"); the email text fallback. */
export function htmlToText(input: string): string {
  if (!looksLikeHtml(input)) return input;
  let s = blockify(input);
  s = s.replace(LINK_RE, '$2 ($1)');
  s = s.replace(STRIP_RE, '');
  return collapseBlankLines(decodeEntities(s));
}
