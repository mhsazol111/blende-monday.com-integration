'use strict';

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}
function select(options, attrs = {}) {
  return el('select', attrs, options.map((o) => el('option', { value: o.value, text: o.label })));
}
function $(id) { return document.getElementById(id); }
function fmtDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}

// ── searchable combobox (dependency-free) ────────────────────────────────────
// Drop-in for high-cardinality <select>s: shows labels, stores a value, filters
// as you type. API: { node, value (get/set) } + optional onChange callback.
function combo(options, { value = '', placeholder = '— select —', onChange } = {}) {
  let current = value;
  let active = -1;
  const input = el('input', { class: 'combo-input', placeholder, autocomplete: 'off', spellcheck: 'false' });
  const panel = el('div', { class: 'combo-panel hidden' });
  const wrap = el('div', { class: 'combo' }, [input, panel]);
  const labelFor = (v) => { const o = options.find((x) => x.value === v); return o ? o.label : ''; };
  input.value = labelFor(current);

  let matches = [];
  const renderList = (filter) => {
    const f = (filter || '').toLowerCase();
    matches = options.filter((o) => o.label.toLowerCase().includes(f)).slice(0, 300);
    panel.innerHTML = '';
    if (!matches.length) { panel.appendChild(el('div', { class: 'combo-empty', text: 'no matches' })); return; }
    matches.forEach((o, idx) => panel.appendChild(el('div', {
      class: 'combo-opt' + (o.value === current ? ' sel' : '') + (idx === active ? ' active' : ''),
      text: o.label, onmousedown: (e) => { e.preventDefault(); choose(o); },
    })));
  };
  const open = () => { active = -1; renderList(''); panel.classList.remove('hidden'); };
  const close = () => { panel.classList.add('hidden'); input.value = labelFor(current); };
  const choose = (o) => { current = o.value; input.value = o.label; panel.classList.add('hidden'); if (onChange) onChange(current); };

  input.addEventListener('focus', open);
  input.addEventListener('input', () => { active = -1; renderList(input.value); panel.classList.remove('hidden'); });
  input.addEventListener('blur', () => setTimeout(close, 130)); // let option mousedown land first
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); renderList(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderList(input.value); }
    else if (e.key === 'Enter') { e.preventDefault(); if (matches[active]) choose(matches[active]); else if (matches[0]) choose(matches[0]); }
  });

  return { node: wrap, get value() { return current; }, set value(v) { current = v; input.value = labelFor(v); } };
}

// ── rich text editor (dependency-free, contenteditable → HTML) ─────────────────
// Tags we keep in WYSIWYG output. Anything else from a paste is unwrapped (text
// kept). `htmlToText`/`htmlToSlack` (src/util/html.ts) understand this same set.
const RICH_ALLOWED = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'A', 'SPAN', 'DIV']);

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// Keep only whitelisted style properties (e.g. color, text-align) — drops the
// font-family / mso-* noise that Word and Google Docs paste in.
function filterStyle(styleText, keep) {
  const out = [];
  for (const part of String(styleText || '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (name && val && keep.includes(name)) out.push(name + ': ' + val);
  }
  return out.join('; ');
}

// Strip attributes/junk from one element (in place), keeping only safe ones.
function cleanElementAttrs(node) {
  const tag = node.tagName;
  let href = '';
  if (tag === 'A') {
    href = node.getAttribute('href') || '';
    if (href && !/^([a-z][a-z0-9+.-]*:|#|\/|mailto:)/i.test(href)) href = 'https://' + href;
    if (/^\s*javascript:/i.test(href)) href = '';
  }
  const style = filterStyle(node.getAttribute('style'), tag === 'SPAN' ? ['color'] : ['text-align', 'color']);
  for (const a of Array.from(node.attributes)) node.removeAttribute(a.name);
  if (href) node.setAttribute('href', href);
  if (style) node.setAttribute('style', style);
}

// Walk a detached container: drop comments/script/style/Office tags, convert
// <font> → <span style="color">, unwrap disallowed tags (keep their text), and
// scrub attributes on the rest.
function walkClean(container) {
  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === 8) { child.remove(); continue; } // comment
    if (child.nodeType !== 1) continue; // keep text nodes
    const tag = child.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag.indexOf(':') >= 0 || /^O:/i.test(tag)) { child.remove(); continue; }
    if (tag === 'FONT') {
      const span = document.createElement('span');
      const c = child.getAttribute('color');
      let style = filterStyle(child.getAttribute('style'), ['color']);
      if (c && !/color/i.test(style)) style = 'color: ' + c + (style ? '; ' + style : '');
      if (style) span.setAttribute('style', style);
      while (child.firstChild) span.appendChild(child.firstChild);
      child.parentNode.replaceChild(span, child);
      walkClean(span);
      continue;
    }
    walkClean(child);
    if (!RICH_ALLOWED.has(tag)) {
      while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
      child.parentNode.removeChild(child);
    } else {
      cleanElementAttrs(child);
    }
  }
}

/** Clean pasted HTML down to the supported tag set (keeps structure). */
function sanitizeHtml(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  walkClean(root);
  return root.innerHTML;
}

/** Deeper cleanup for save/source view: drop empties & stray &nbsp;, tidy <br>. */
function normalizeHtml(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  walkClean(root);
  // Non-breaking spaces → regular spaces (the "&nbsp; everywhere" annoyance).
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (tw.nextNode()) texts.push(tw.currentNode);
  for (const t of texts) t.nodeValue = t.nodeValue.replace(/ /g, ' ');
  // Remove empty elements (no text and no <br>/media), repeatedly for nesting.
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    root.querySelectorAll('*').forEach((node) => {
      if (/^(BR|IMG|HR)$/.test(node.tagName) || node.querySelector('br, img, hr')) return;
      if (node.textContent.trim() === '' && node.children.length === 0) { node.remove(); changed = true; }
    });
    if (!changed) break;
  }
  let out = root.innerHTML;
  out = out.replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>'); // collapse runs of breaks
  out = out.replace(/(?:\s*<br\s*\/?>)+\s*$/i, '');         // trim trailing breaks
  return out.trim();
}

// True when the HTML uses tags outside our set (e.g. a full table-based email
// template). We then preserve it verbatim instead of normalizing/mangling it.
function hasUnsupportedTags(html) {
  return (String(html).match(/<([a-z][a-z0-9]*)\b/gi) || []).some((t) => !RICH_ALLOWED.has(t.replace(/[<]/, '').toUpperCase()));
}

function richEditor(initialHtml, placeholder) {
  const editor = el('div', { class: 'editor', contenteditable: 'true', 'data-ph': placeholder || 'Write a message — format with the toolbar, insert variables below' });
  editor.innerHTML = initialHtml || ''; // verbatim on load (preserves pasted templates)
  const source = el('textarea', { class: 'editor editor-source hidden', spellcheck: 'false' });
  let sourceMode = false;

  // Normalize simple rich text on the way out, but leave full HTML templates
  // (tables/inline CSS — `hasUnsupportedTags`) untouched so they round-trip.
  const cleanForSave = (html) => (hasUnsupportedTags(html) ? html.trim() : normalizeHtml(html));

  // Consistent, convertible markup: <p> paragraphs (not Chrome's <div>) and
  // tag-based bold/italic (<b>/<i>, not <span style>) for clean html.ts output.
  const setEditingModes = () => {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}
    try { document.execCommand('styleWithCSS', false, false); } catch (_) {}
  };
  editor.addEventListener('focus', setEditingModes);

  let savedRange = null;
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreRange = () => {
    editor.focus();
    if (savedRange && editor.contains(savedRange.startContainer)) {
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange);
    }
  };
  const exec = (name, arg) => (e) => { e.preventDefault(); restoreRange(); document.execCommand(name, false, arg); saveRange(); syncToolbar(); };
  const fmtBtns = {};
  const tbtn = (label, name, title) => { const b = el('button', { text: label, title: title || name, onmousedown: exec(name) }); fmtBtns[name] = b; return b; };

  const heading = select(
    [{ value: 'P', label: 'Normal' }, { value: 'H1', label: 'Heading 1' }, { value: 'H2', label: 'Heading 2' }, { value: 'H3', label: 'Heading 3' }],
    { title: 'text style' },
  );
  heading.addEventListener('mousedown', saveRange);
  heading.addEventListener('change', () => { restoreRange(); document.execCommand('formatBlock', false, heading.value); saveRange(); });

  const color = el('input', { type: 'color', title: 'text color', value: '#323338' });
  color.addEventListener('input', () => { restoreRange(); document.execCommand('foreColor', false, color.value); saveRange(); });

  const link = el('button', { text: '🔗', title: 'insert link', onmousedown: (e) => {
    e.preventDefault(); restoreRange();
    let url = prompt('Link URL:');
    if (url) { url = url.trim(); if (!/^([a-z][a-z0-9+.-]*:|#|\/|mailto:)/i.test(url)) url = 'https://' + url; document.execCommand('createLink', false, url); }
    saveRange();
  } });

  const htmlBtn = el('button', { text: '</>', title: 'edit raw HTML', onmousedown: (e) => { e.preventDefault(); toggleSource(); } });
  const toggleSource = () => {
    if (!sourceMode) {
      source.value = cleanForSave(editor.innerHTML);
      editor.classList.add('hidden'); source.classList.remove('hidden'); htmlBtn.classList.add('active');
    } else {
      editor.innerHTML = source.value; // verbatim back into the editor
      editor.classList.remove('hidden'); source.classList.add('hidden'); htmlBtn.classList.remove('active');
    }
    sourceMode = !sourceMode;
  };

  // Reflect the caret's formatting on the toolbar (proper-editor feel).
  const syncToolbar = () => {
    if (sourceMode) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return;
    for (const [cmd, btn] of Object.entries(fmtBtns)) {
      try { btn.classList.toggle('active', document.queryCommandState(cmd)); } catch (_) {}
    }
    try {
      const blk = String(document.queryCommandValue('formatBlock') || '').toUpperCase();
      heading.value = ['H1', 'H2', 'H3'].includes(blk) ? blk : 'P';
    } catch (_) {}
  };

  const toolbar = el('div', { class: 'toolbar' }, [
    heading,
    tbtn('B', 'bold'), tbtn('I', 'italic'), tbtn('U', 'underline'), tbtn('S', 'strikeThrough', 'strikethrough'),
    tbtn('•', 'insertUnorderedList', 'bullet list'), tbtn('1.', 'insertOrderedList', 'numbered list'),
    tbtn('⬅', 'justifyLeft', 'align left'), tbtn('▤', 'justifyCenter', 'align center'), tbtn('➡', 'justifyRight', 'align right'),
    link, tbtn('⛓', 'unlink', 'remove link'), color,
    tbtn('⌫', 'removeFormat', 'clear formatting'), htmlBtn,
  ]);
  ['keyup', 'mouseup', 'focus'].forEach((ev) => editor.addEventListener(ev, () => { saveRange(); syncToolbar(); }));
  document.addEventListener('selectionchange', syncToolbar);

  // Paste handler: strip Word/Docs/web junk before it enters the document.
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    const html = cd && cd.getData('text/html');
    const clean = html
      ? sanitizeHtml(html)
      : String((cd && cd.getData('text/plain')) || '').split(/\r?\n/).map(escapeHtml).join('<br>');
    restoreRange();
    document.execCommand('insertHTML', false, clean);
    saveRange();
  });

  const insertAtCaret = (text) => {
    if (sourceMode) {
      const s = source.selectionStart ?? source.value.length;
      const e = source.selectionEnd ?? source.value.length;
      source.value = source.value.slice(0, s) + text + source.value.slice(e);
      source.focus(); source.selectionStart = source.selectionEnd = s + text.length;
      return;
    }
    restoreRange();
    const sel = window.getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node); range.setEndAfter(node);
      sel.removeAllRanges(); sel.addRange(range);
      savedRange = range.cloneRange();
    } else {
      editor.innerHTML += text;
    }
  };
  const chips = el('div', { class: 'chips' },
    availableVariables().map((v) =>
      el('span', { class: 'chip', title: v.hint || '', text: v.token,
        onmousedown: (e) => { e.preventDefault(); insertAtCaret(v.token); } })));

  const condChips = el('div', { class: 'chips' },
    conditionalSnippets().map((v) =>
      el('span', { class: 'chip cond-chip', title: v.hint || '', text: v.label,
        onmousedown: (e) => { e.preventDefault(); insertAtCaret(v.snippet); } })));

  const node = el('div', { class: 'rich' }, [
    toolbar, editor, source,
    el('div', { class: 'insert-panel' }, [
      el('div', { class: 'insert-title', text: 'Insert variable' }), chips,
      el('div', { class: 'insert-title', text: 'Insert condition (edit the column id / value)' }), condChips,
    ]),
  ]);
  return {
    node,
    getHtml: () => (sourceMode ? source.value.trim() : cleanForSave(editor.innerHTML)),
    setHtml: (h) => { editor.innerHTML = h || ''; if (sourceMode) source.value = h || ''; },
  };
}

// The {{placeholders}} the engine resolves (see buildContext).
function availableVariables() {
  const base = [
    { token: '{{item.name}}', hint: 'Item name' },
    { token: '{{item.id}}', hint: 'Item id' },
    { token: '{{group.title}}', hint: 'Group title' },
    { token: '{{status}}', hint: 'Item status label' },
  ];
  const cols = boardCols().map((c) => ({ token: `{{column.${c.id}}}`, hint: `${c.title} [${c.type}]` }));
  const subs = subCols().length
    ? [{ token: '{{subitem.name}}', hint: 'Triggering subitem name (subitem rules)' }].concat(
        subCols().map((c) => ({ token: `{{subitem.column.${c.id}}}`, hint: `subitem ${c.title} [${c.type}]` })),
      )
    : [];
  return base.concat(cols).concat(subs);
}

// Block-conditional snippets the template engine understands (renderConditionals).
// Uses a real column id from the loaded board as an example so it's easy to edit.
function conditionalSnippets() {
  const exCol = boardCols()[0]?.id || 'COLUMN_ID';
  const exSub = subCols()[0]?.id;
  const out = [
    { label: 'if/else', snippet: `{{#if column.${exCol}}}has a value{{else}}empty{{/if}}`, hint: 'Show one of two texts based on whether a column has a value' },
    { label: 'if equals', snippet: `{{#ifEquals column.${exCol} "Done"}}done!{{else}}not yet{{/ifEquals}}`, hint: 'Compare a column value (case-insensitive) and branch' },
    { label: 'unless (empty)', snippet: `{{#unless column.${exCol}}}still missing{{/unless}}`, hint: 'Show text only when a column is empty' },
  ];
  if (exSub) {
    out.push({ label: 'if subitem', snippet: `{{#ifEquals subitem.column.${exSub} "Done"}}received{{else}}pending{{/ifEquals}}`, hint: 'Branch on the triggering subitem’s column value' });
    const exName = (state.groupSubitemNames && state.groupSubitemNames[0]) || 'Subitem name';
    out.push({ label: 'subitem block', snippet: `{{#subitem "${exName}"}}{{#ifEquals column.${exSub} "Done"}}done{{else}}pending{{/ifEquals}}{{/subitem}}`, hint: 'Scope to a named subitem (edit the name); inside, {{name}}, {{column.<id>}} and conditionals refer to that subitem' });
  }
  return out;
}

// ── state ────────────────────────────────────────────────────────────────────
const state = { structure: null, boardId: null, ruleset: { rules: [] }, queue: [] };
const queueFilter = { item: '', status: '', type: '', rule: '' };
const conditionGroups = []; // OR-of-ANDs: each group has its own AND'd condition rows
const actionRows = [];
let scopeGroupCombo = null;

function secret() {
  return new URLSearchParams(location.search).get('secret') || localStorage.getItem('mas_secret') || '';
}

// ── column helpers ───────────────────────────────────────────────────────────
function boardCols() { return state.structure?.board?.columns ?? []; }
function subCols() { return state.structure?.subitemBoard?.columns ?? []; }
function byType(cols, types) { return cols.filter((c) => types.includes(c.type)); }
function colOptions(cols) { return cols.map((c) => ({ value: c.id, label: `${c.title} [${c.type}]` })); }
function groupOptions() { return (state.structure?.board?.groups ?? []).map((g) => ({ value: g.id, label: g.title })); }
function labelsFor(columnId) {
  const c = [...boardCols(), ...subCols()].find((x) => x.id === columnId);
  return (c?.labels ?? []).map((l) => ({ value: l.label, label: l.label }));
}

/**
 * Subitem name picker — same searchable combo look as the other selects, but
 * free-typeable (subitems can be typed, not only picked) and async-loaded for
 * the selected group.
 */
function subitemNamePicker(initValue) {
  const input = el('input', { class: 'combo-input', placeholder: 'subitem — pick or type', value: initValue || '', autocomplete: 'off', spellcheck: 'false' });
  const panel = el('div', { class: 'combo-panel hidden' });
  const node = el('div', { class: 'combo' }, [input, panel]);
  let names = [];
  let shown = [];
  let active = -1;

  const pick = (n) => { input.value = n; active = -1; panel.classList.add('hidden'); };
  const renderList = () => {
    const f = input.value.toLowerCase();
    shown = names.filter((n) => n.toLowerCase().includes(f)).slice(0, 300);
    panel.innerHTML = '';
    if (!shown.length) { panel.classList.add('hidden'); return; }
    shown.forEach((n, idx) => panel.appendChild(el('div', {
      class: 'combo-opt' + (idx === active ? ' active' : ''), text: n,
      onmousedown: (e) => { e.preventDefault(); pick(n); },
    })));
    panel.classList.remove('hidden');
  };
  input.addEventListener('focus', () => { active = -1; renderList(); });
  input.addEventListener('input', () => { active = -1; renderList(); });
  input.addEventListener('blur', () => setTimeout(() => panel.classList.add('hidden'), 130));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.classList.add('hidden');
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderList(); }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); pick(shown[active]); }
  });

  const groupId = scopeGroupCombo ? scopeGroupCombo.value : '';
  if (state.boardId && groupId) {
    input.placeholder = 'loading subitems…';
    fetch('/api/group-subitems?boardId=' + encodeURIComponent(state.boardId) + '&groupId=' + encodeURIComponent(groupId))
      .then((r) => r.json())
      .then((d) => {
        names = d.names || [];
        state.groupSubitemNames = names; // cache so snippet chips can suggest a real name
        input.placeholder = names.length ? 'subitem — pick or type' : 'no subitems found in group — type a name';
        if (document.activeElement === input) renderList();
      })
      .catch(() => { input.placeholder = 'could not load subitems — type a name'; });
  } else {
    input.placeholder = 'select a group first';
  }
  return { node, serialize: () => input.value.trim() };
}

/**
 * A linked column-combo + label-select; label list follows the chosen column.
 * `opts.emptyLabel` sets the first option's text — pass '(no value / empty)' for
 * conditions where selecting it means "the column has no value".
 */
function columnLabelPair(cols, init, opts = {}) {
  const emptyLabel = opts.emptyLabel || '— label —';
  const colSel = combo([{ value: '', label: '— column —' }, ...colOptions(cols)], { placeholder: '— column —', onChange: () => refresh() });
  const labelSel = select([{ value: '', label: emptyLabel }]);
  const refresh = () => {
    labelSel.innerHTML = '';
    [{ value: '', label: emptyLabel }, ...labelsFor(colSel.value)].forEach((o) =>
      labelSel.appendChild(el('option', { value: o.value, text: o.label })),
    );
  };
  if (init && init.columnId) { colSel.value = init.columnId; refresh(); labelSel.value = init.label || ''; }
  const node = el('div', { class: 'row' }, [colSel.node, labelSel]);
  return { node, serialize: () => ({ columnId: colSel.value, label: labelSel.value }) };
}

// ── trigger params ───────────────────────────────────────────────────────────
const TRIGGERS = [
  { value: 'item_entered_group', label: 'Item entered the group' },
  { value: 'item_left_group', label: 'Item left the group' },
  { value: 'item_column_changed', label: 'Item column changed to' },
  { value: 'subitem_checked', label: 'Subitem set (status →)' },
  { value: 'all_subitems_checked', label: 'All of these subitems set (any order)' },
  { value: 'item_in_group_for_days', label: 'Item in group for N days' },
];

// Short, clean kebab-case slugs used when generating a rule ID (nicer than the raw trigger value).
const TRIGGER_SLUG = {
  item_entered_group: 'entered-group',
  item_left_group: 'left-group',
  item_column_changed: 'column-changed',
  subitem_checked: 'subitem-set',
  all_subitems_checked: 'all-subitems-set',
  item_in_group_for_days: 'in-group-days',
};

// value → human label, for the rule-list summary (falls back to the raw type for legacy triggers).
const TRIGGER_LABEL = TRIGGERS.reduce((m, t) => { m[t.value] = t.label; return m; }, {});

function multiSubitemPicker(initNames) {
  const rows = [];
  const list = el('div');
  const add = (value) => {
    const picker = subitemNamePicker(value);
    const remove = el('button', { class: 'danger', text: '✕',
      onclick: (e) => { e.preventDefault(); const i = rows.indexOf(entry); if (i >= 0) { rows.splice(i, 1); row.remove(); } } });
    const row = el('div', { class: 'row' }, [picker.node, remove]);
    const entry = { row, serialize: picker.serialize };
    rows.push(entry);
    list.appendChild(row);
  };
  if (initNames && initNames.length) initNames.forEach((n) => add(n));
  else { add(); add(); }
  const addBtn = el('button', { class: 'link', text: '+ add subitem', onclick: (e) => { e.preventDefault(); add(); } });
  const node = el('div', {}, [list, addBtn]);
  return { node, serialize: () => rows.map((r) => r.serialize()).filter(Boolean) };
}
let triggerSerialize = () => ({ type: 'item_entered_group' });

function renderTriggerParams(init) {
  const type = $('triggerType').value;
  const i = init && init.type === type ? init : null;
  const box = $('triggerParams');
  box.innerHTML = '';
  if (type === 'item_column_changed') {
    const col = combo([{ value: '', label: '— column —' }, ...colOptions(boardCols())], { placeholder: '— column —', value: i?.columnId || '', onChange: () => renderVal() });
    const modeSel = select([{ value: 'any', label: 'Any change' }, { value: 'value', label: 'A specific value' }]);
    if (i && i.value) modeSel.value = 'value';
    const valWrap = el('div');
    let getValue = () => '';
    let initVal = i?.value;
    const renderVal = () => {
      valWrap.innerHTML = '';
      if (modeSel.value === 'any') { getValue = () => ''; return; }
      const c = boardCols().find((x) => x.id === col.value);
      if (c && (c.type === 'status' || c.type === 'color') && c.labels) {
        const sel = select([{ value: '', label: '— label —' }, ...c.labels.map((l) => ({ value: l.label, label: l.label }))]);
        if (initVal) sel.value = initVal;
        valWrap.appendChild(sel);
        getValue = () => sel.value;
      } else {
        const inp = el('input', { placeholder: 'value to match (the column’s text)', value: initVal || '' });
        valWrap.appendChild(inp);
        getValue = () => inp.value;
      }
      initVal = '';
    };
    modeSel.addEventListener('change', renderVal);
    renderVal();
    box.append(el('label', { text: 'Column' }), col.node, el('label', { text: 'Fires on' }), modeSel, valWrap);
    triggerSerialize = () => {
      const t = { type, columnId: col.value };
      const v = getValue();
      if (modeSel.value === 'value' && v) t.value = v;
      return t;
    };
  } else if (type === 'subitem_checked') {
    const pair = columnLabelPair(byType(subCols(), ['status', 'color']), i);
    const picker = subitemNamePicker(i?.subitemName);
    box.append(el('label', { text: 'Subitem' }), picker.node, el('label', { text: 'Status column → label that counts as "checked" (e.g. Done)' }), pair.node);
    triggerSerialize = () => {
      const p = pair.serialize();
      const nm = picker.serialize();
      return nm ? { type, ...p, subitemName: nm } : { type, ...p };
    };
  } else if (type === 'all_subitems_checked') {
    const pair = columnLabelPair(byType(subCols(), ['status', 'color']), i);
    const multi = multiSubitemPicker(i?.subitemNames);
    box.append(el('label', { text: 'Subitems — fires once when ALL reach the status (any order)' }), multi.node, el('label', { text: 'Status column → label (e.g. Done)' }), pair.node);
    triggerSerialize = () => {
      const p = pair.serialize();
      return { type, columnId: p.columnId, label: p.label, subitemNames: multi.serialize() };
    };
  } else if (type === 'item_in_group_for_days') {
    const days = el('input', { type: 'number', min: '1', value: i?.days != null ? String(i.days) : '7' });
    const repeat = el('input', { type: 'number', min: '0', placeholder: 'repeat every N days (optional)', value: i?.repeatEveryDays != null ? String(i.repeatEveryDays) : '' });
    box.append(el('label', { text: 'Days' }), days, el('label', { text: 'Repeat every (days)' }), repeat);
    triggerSerialize = () => {
      const t = { type, days: Number(days.value) || 0 };
      if (Number(repeat.value) > 0) t.repeatEveryDays = Number(repeat.value);
      return t;
    };
  } else {
    box.appendChild(el('span', { class: 'hint', text: 'No extra settings — the group above scopes it.' }));
    triggerSerialize = () => ({ type });
  }
}

// ── condition rows (Field → Operator → Value) ────────────────────────────────
// The row is a query-builder: pick a subject (Item column / Subitem / Item's
// group), an operator, and (for equality operators) a value. The value control
// adapts — a label dropdown when the chosen column has labels (status/dropdown),
// otherwise a text field. It serializes to the engine's existing condition types
// (see src/rules/types.ts) and reverse-maps legacy types on edit, including the
// retired-from-the-UI `status_is` / `status_is_not`.

const CONDITION_SUBJECTS = [
  { value: 'column', label: 'Item column' },
  { value: 'subitem', label: 'Subitem' },
  { value: 'group', label: "Item's group" },
];
const COLUMN_OPERATORS = [
  { value: 'eq', label: 'is equal' },
  { value: 'neq', label: 'is not equal' },
  { value: 'not_empty', label: 'has any value' },
  { value: 'empty', label: 'has no value' },
];

// Saved condition object → {subject, operator, columnId, value, subitemName, groupId}.
function decodeCondition(i) {
  switch (i && i.type) {
    case 'status_is': return { subject: 'column', operator: 'eq', columnId: i.columnId, value: i.label };
    case 'status_is_not': return { subject: 'column', operator: 'neq', columnId: i.columnId, value: i.label };
    case 'column_equals': return { subject: 'column', operator: 'eq', columnId: i.columnId, value: i.value };
    case 'column_not_equals': return { subject: 'column', operator: 'neq', columnId: i.columnId, value: i.value };
    case 'column_empty': return { subject: 'column', operator: 'empty', columnId: i.columnId };
    case 'column_not_empty': return { subject: 'column', operator: 'not_empty', columnId: i.columnId };
    case 'in_group': return { subject: 'group', operator: 'in', groupId: i.groupId };
    case 'moved_from_group': return { subject: 'group', operator: 'from', groupId: i.groupId };
    case 'subitem_checked':
      return i.label === ''
        ? { subject: 'subitem', operator: 'empty', columnId: i.columnId, subitemName: i.subitemName }
        : { subject: 'subitem', operator: 'eq', columnId: i.columnId, value: i.label, subitemName: i.subitemName };
    case 'subitem_not_checked':
      return i.label === ''
        ? { subject: 'subitem', operator: 'not_empty', columnId: i.columnId, subitemName: i.subitemName }
        : { subject: 'subitem', operator: 'neq', columnId: i.columnId, value: i.label, subitemName: i.subitemName };
    default: return { subject: 'column', operator: 'eq' };
  }
}

function makeConditionRow(init, ownerRows) {
  let dec = decodeCondition(init);
  const subjectSel = select(CONDITION_SUBJECTS.map((s) => ({ value: s.value, label: s.label })));
  subjectSel.value = dec.subject;
  const body = el('div');
  let serialize = () => ({ type: 'column_equals', columnId: '', value: '' });
  // A labelled control cell — grouped so Field/Condition/Value sit as 3 columns.
  const cell = (labelText, node) => el('div', {}, [el('label', { text: labelText }), node]);

  // Item column / Subitem share the field → operator → value shape.
  const renderColumnLike = (isSubitem) => {
    const cols = isSubitem ? subCols() : boardCols();
    const namePicker = isSubitem ? subitemNamePicker(dec.subitemName) : null;
    const colCombo = combo([{ value: '', label: '— column —' }, ...colOptions(cols)], {
      placeholder: '— column —',
      value: dec.columnId || (isSubitem ? 'status' : ''),
      onChange: () => { dec.value = getValue(); renderValue(); },
    });
    const opSel = select(COLUMN_OPERATORS.map((o) => ({ value: o.value, label: o.label })));
    if (dec.operator) opSel.value = dec.operator;

    const valWrap = el('div');
    const valCell = cell('Value', valWrap);
    let getValue = () => '';
    const renderValue = () => {
      valWrap.innerHTML = '';
      getValue = () => '';
      const noValue = opSel.value === 'empty' || opSel.value === 'not_empty';
      valCell.style.display = noValue ? 'none' : ''; // drop the Value column entirely
      if (noValue) return;
      const c = cols.find((x) => x.id === colCombo.value);
      if (c && c.labels && c.labels.length) {
        const sel = select([{ value: '', label: '— label —' }, ...c.labels.map((l) => ({ value: l.label, label: l.label }))]);
        if (dec.value) sel.value = dec.value;
        valWrap.appendChild(sel);
        getValue = () => sel.value;
      } else {
        const inp = el('input', { placeholder: 'value (matches column text)', value: dec.value || '' });
        valWrap.appendChild(inp);
        getValue = () => inp.value;
      }
    };
    opSel.addEventListener('change', () => { const v = getValue(); if (v) dec.value = v; renderValue(); });
    renderValue();

    if (namePicker) body.append(cell('Subitem', namePicker.node));
    body.append(el('div', { class: 'row' }, [cell('Field', colCombo.node), cell('Condition', opSel), valCell]));

    serialize = () => {
      const columnId = colCombo.value;
      if (isSubitem) {
        const nm = namePicker ? namePicker.serialize() : '';
        const base = nm ? { columnId, subitemName: nm } : { columnId };
        switch (opSel.value) {
          case 'neq': return { type: 'subitem_not_checked', ...base, label: getValue() };
          case 'empty': return { type: 'subitem_checked', ...base, label: '' };
          case 'not_empty': return { type: 'subitem_not_checked', ...base, label: '' };
          default: return { type: 'subitem_checked', ...base, label: getValue() };
        }
      }
      switch (opSel.value) {
        case 'neq': return { type: 'column_not_equals', columnId, value: getValue() };
        case 'empty': return { type: 'column_empty', columnId };
        case 'not_empty': return { type: 'column_not_empty', columnId };
        default: return { type: 'column_equals', columnId, value: getValue() };
      }
    };
  };

  const renderGroup = () => {
    const opSel = select([{ value: 'in', label: 'is in' }, { value: 'from', label: 'moved from' }]);
    opSel.value = dec.operator === 'from' ? 'from' : 'in';
    const g = combo([{ value: '', label: '— group —' }, ...groupOptions()], { placeholder: '— group —', value: dec.groupId || '' });
    body.append(el('div', { class: 'row' }, [cell('Condition', opSel), cell('Group', g.node)]));
    serialize = () => (opSel.value === 'from' ? { type: 'moved_from_group', groupId: g.value } : { type: 'in_group', groupId: g.value });
  };

  const render = () => {
    body.innerHTML = '';
    if (subjectSel.value === 'group') renderGroup();
    else renderColumnLike(subjectSel.value === 'subitem');
  };
  // Switching subject resets stale field/value defaults from the loaded rule.
  subjectSel.addEventListener('change', () => { dec = { subject: subjectSel.value, operator: 'eq' }; render(); });
  render();

  const remove = el('button', { class: 'danger', text: '✕', onclick: () => removeRow(ownerRows, row) });
  const node = el('div', { class: 'subform' }, [el('div', { class: 'row' }, [subjectSel, remove]), body]);
  const row = { node, serialize: () => serialize() };
  return row;
}

// ── condition groups (OR-of-ANDs) ────────────────────────────────────────────
function makeConditionGroup(initConditions) {
  const rows = [];
  const list = el('div', { class: 'cond-list' });
  const addRow = (init) => {
    const row = makeConditionRow(init, rows);
    rows.push(row);
    list.appendChild(row.node);
  };
  const seed = initConditions && initConditions.length ? initConditions : [null];
  seed.forEach((c) => addRow(c));
  const addBtn = el('button', { class: 'link', text: '+ AND condition', onclick: (e) => { e.preventDefault(); addRow(); } });
  const removeBtn = el('button', { class: 'danger', text: '✕ remove group', onclick: (e) => { e.preventDefault(); removeRow(conditionGroups, group); renderConditionGroups(); } });
  const node = el('div', { class: 'cond-group' }, [
    el('div', { class: 'row' }, [el('span', { class: 'hint', text: 'Match ALL of:' }), removeBtn]),
    list, addBtn,
  ]);
  const group = { node, rows, serialize: () => ({ conditions: rows.map((r) => r.serialize()) }) };
  return group;
}

/** Re-render the condition groups with "OR" separators between them. */
function renderConditionGroups() {
  const container = $('conditions');
  container.innerHTML = '';
  if (!conditionGroups.length) {
    container.appendChild(el('div', { class: 'hint', text: 'No conditions — the rule fires whenever the trigger matches. Add an OR group to gate it.' }));
    return;
  }
  conditionGroups.forEach((g, i) => {
    if (i > 0) container.appendChild(el('div', { class: 'or-sep', text: 'OR' }));
    container.appendChild(g.node);
  });
}

// ── action rows ──────────────────────────────────────────────────────────────
const ACTIONS = [
  { value: 'slack', label: 'Send Slack' },
  { value: 'email', label: 'Send email' },
  { value: 'set_column', label: 'Set a monday value (item/subitem)' },
  { value: 'clear_pending', label: 'Clear pending actions' },
  { value: 'clone_template_subitems', label: 'Clone template subitems' },
];

function setColumnControls(init) {
  let initSubitem = init?.subitemName;
  let initColumnId = init?.columnId;
  let initValue = init?.value;
  const target = select([{ value: 'item', label: 'Item' }, { value: 'subitem', label: 'Subitem' }]);
  if (init?.target) target.value = init.target;

  const subWrap = el('div');
  let subPicker = null;
  const colWrap = el('div');
  let colSel = null;
  const valWrap = el('div');
  let getValue = () => '';

  const colsFor = () => (target.value === 'subitem' ? subCols() : boardCols());

  const renderValue = () => {
    valWrap.innerHTML = '';
    const col = colsFor().find((c) => c.id === (colSel && colSel.value));
    if (col && (col.type === 'status' || col.type === 'color') && col.labels) {
      const sel = select([{ value: '', label: '— label —' }, ...col.labels.map((l) => ({ value: l.index, label: l.label }))]);
      if (initValue) sel.value = initValue;
      valWrap.appendChild(sel);
      getValue = () => sel.value;
    } else {
      // Rich editor: lets you compose a message (with variables + if/else) to
      // stash in a column for manual reuse. HTML is flattened to plain text on write.
      const editor = richEditor(initValue, 'Value — plain text, {{variables}}, dates (YYYY-MM-DD), or a generated message to stash');
      valWrap.appendChild(editor.node);
      getValue = () => editor.getHtml();
    }
    initValue = '';
  };
  const renderCol = () => {
    colWrap.innerHTML = '';
    colSel = combo([{ value: '', label: '— column —' }, ...colOptions(colsFor())], { placeholder: '— column —', value: initColumnId || '', onChange: () => renderValue() });
    colWrap.appendChild(colSel.node);
    renderValue();
    initColumnId = '';
  };
  const renderSub = () => {
    subWrap.innerHTML = '';
    subPicker = null;
    if (target.value === 'subitem') {
      subPicker = subitemNamePicker(initSubitem);
      subWrap.append(el('label', { text: 'Subitem (by name)' }), subPicker.node);
      initSubitem = '';
    }
  };
  target.addEventListener('change', () => { renderSub(); renderCol(); });
  renderSub();
  renderCol();

  const node = el('div', {}, [el('label', { text: 'Target' }), target, subWrap, el('label', { text: 'Column' }), colWrap, el('label', { text: 'Value' }), valWrap]);
  const serialize = () => {
    const a = { columnId: colSel ? colSel.value : '', value: getValue() };
    if (target.value === 'subitem') { a.target = 'subitem'; if (subPicker) a.subitemName = subPicker.serialize(); }
    return a;
  };
  return { node, serialize };
}

function whenControl(init) {
  const mode = select([
    { value: 'immediate', label: 'immediately' },
    { value: 'relative', label: 'after a delay' },
    { value: 'relative_from_column', label: 'after a delay from a column value' },
    { value: 'absolute', label: 'at a specific time' },
  ]);
  const relDays = el('input', { type: 'number', min: '0', value: '0' });
  const relHours = el('input', { type: 'number', min: '0', value: '0' });
  const relMins = el('input', { type: 'number', min: '0', value: '0' });
  const field = (label, input) => el('div', {}, [el('label', { text: label }), input]);
  const rel = el('div', { class: 'row hidden' }, [field('Days', relDays), field('Hours', relHours), field('Minutes', relMins)]);
  const abs = el('input', { type: 'datetime-local', class: 'hidden' });

  // ── delay-from-column (reads a number from an item/subitem column at event time) ──
  const colTarget = select([{ value: 'item', label: 'Item' }, { value: 'subitem', label: 'Subitem' }]);
  const colSubWrap = el('div');
  let colSubPicker = null;
  const colColWrap = el('div');
  let colCombo = null;
  const colUnit = select([{ value: 'days', label: 'Days' }, { value: 'hours', label: 'Hours' }, { value: 'minutes', label: 'Minutes' }]);
  let initColId = init?.mode === 'relative_from_column' ? init.columnId : '';
  let initColSub = init?.mode === 'relative_from_column' ? init.subitemName : '';
  // Only number/dropdown columns make sense as a delay source (their text is a
  // number); keep the saved column visible even if its type isn't in the list.
  const colColsFor = () => {
    const all = colTarget.value === 'subitem' ? subCols() : boardCols();
    return all.filter((c) => ['numbers', 'numeric', 'dropdown'].includes(c.type) || c.id === initColId);
  };
  const renderColCombo = () => {
    colColWrap.innerHTML = '';
    const opts = colOptions(colColsFor());
    const placeholder = opts.length ? '— number/dropdown column —' : '— no number/dropdown column on this board —';
    colCombo = combo([{ value: '', label: placeholder }, ...opts], { placeholder, value: initColId || '' });
    colColWrap.appendChild(colCombo.node);
    initColId = '';
  };
  const renderColSub = () => {
    colSubWrap.innerHTML = '';
    colSubPicker = null;
    if (colTarget.value === 'subitem') {
      colSubPicker = subitemNamePicker(initColSub);
      colSubWrap.append(el('label', { text: 'Subitem (by name)' }), colSubPicker.node);
      initColSub = '';
    }
  };
  colTarget.addEventListener('change', () => { renderColSub(); renderColCombo(); });
  const fromCol = el('div', { class: 'subform hidden' }, [
    el('span', { class: 'hint', text: 'Delay = (the column’s number) × the unit below' }),
    el('label', { text: 'Read from' }), colTarget, colSubWrap,
    el('label', { text: 'Column' }), colColWrap,
    el('label', { text: 'Unit' }), colUnit,
  ]);

  const sync = () => {
    rel.classList.toggle('hidden', mode.value !== 'relative');
    abs.classList.toggle('hidden', mode.value !== 'absolute');
    fromCol.classList.toggle('hidden', mode.value !== 'relative_from_column');
  };
  mode.addEventListener('change', sync);
  if (init && init.mode) {
    mode.value = init.mode;
    if (init.mode === 'relative') { relDays.value = init.days || 0; relHours.value = init.hours || 0; relMins.value = init.minutes || 0; }
    if (init.mode === 'absolute' && init.at) {
      const d = new Date(init.at);
      if (!isNaN(d)) abs.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    if (init.mode === 'relative_from_column') { colTarget.value = init.target || 'item'; colUnit.value = init.unit || 'days'; }
  }
  renderColSub();
  renderColCombo();
  if (init?.mode) sync();

  const node = el('div', {}, [el('span', { class: 'hint', text: 'When' }), mode, rel, abs, fromCol]);
  const serialize = () => {
    if (mode.value === 'relative') return { mode: 'relative', days: Number(relDays.value) || 0, hours: Number(relHours.value) || 0, minutes: Number(relMins.value) || 0 };
    if (mode.value === 'absolute') return { mode: 'absolute', at: abs.value ? new Date(abs.value).toISOString() : '' };
    if (mode.value === 'relative_from_column') {
      const w = { mode: 'relative_from_column', columnId: colCombo ? colCombo.value : '', unit: colUnit.value };
      if (colTarget.value === 'subitem') { w.target = 'subitem'; if (colSubPicker) w.subitemName = colSubPicker.serialize(); }
      return w;
    }
    return { mode: 'immediate' };
  };
  return { node, serialize };
}

function makeActionRow(init) {
  const typeSel = select(ACTIONS.map((a) => ({ value: a.value, label: a.label })));
  const params = el('div');
  let serializeParams = () => ({});
  let pending = init || null;
  if (init && init.type) typeSel.value = init.type;

  const render = () => {
    const t = typeSel.value;
    const i = pending; pending = null;
    params.innerHTML = '';
    if (t === 'slack') {
      const when = whenControl(i?.when);
      const url = el('input', { placeholder: 'webhook URL (optional — uses default)', value: i?.webhookUrl || '' });
      const editor = richEditor(i?.text, 'Slack message — {{item.name}} entered {{group.title}}');
      const subPicker = state.structure?.subitemBoard ? subitemNamePicker(i?.subitemName) : null;
      params.append(when.node, el('label', { text: 'Webhook URL' }), url, el('label', { text: 'Message (HTML → Slack mrkdwn)' }), editor.node);
      if (subPicker) params.append(
        el('label', { text: 'Subitem for {{subitem.*}} (optional)' }),
        subPicker.node,
        el('span', { class: 'hint', text: 'Binds {{subitem.*}} to one subitem for the whole message. To reference several subitems, use a {{#subitem "Name"}}…{{/subitem}} block in the body instead.' }),
      );
      serializeParams = () => {
        const a = { when: when.serialize(), text: editor.getHtml() };
        if (url.value.trim()) a.webhookUrl = url.value.trim();
        const nm = subPicker ? subPicker.serialize() : '';
        if (nm) a.subitemName = nm;
        return a;
      };
    } else if (t === 'email') {
      const when = whenControl(i?.when);
      const to = el('input', { placeholder: 'a@x.com, b@y.com', value: (i?.to || []).join(', ') });
      const toCol = combo([{ value: '', label: '— none —' }, ...colOptions(byType(boardCols(), ['people']))], { placeholder: '— none —', value: i?.toFromColumn || '' });
      const subject = el('input', { placeholder: 'subject, e.g. {{item.name}} is Done', value: i?.subject || '' });
      const editor = richEditor(i?.body, 'Email body — rich text supported');
      const subPicker = state.structure?.subitemBoard ? subitemNamePicker(i?.subitemName) : null;
      params.append(
        when.node,
        el('label', { text: 'To (literal addresses)' }), to,
        el('label', { text: 'To (from people column)' }), toCol.node,
        el('label', { text: 'Subject' }), subject,
        el('label', { text: 'Body (rich HTML)' }), editor.node,
      );
      if (subPicker) params.append(
        el('label', { text: 'Subitem for {{subitem.*}} (optional)' }),
        subPicker.node,
        el('span', { class: 'hint', text: 'Binds {{subitem.*}} to one subitem for the whole message. To reference several subitems, use a {{#subitem "Name"}}…{{/subitem}} block in the body instead.' }),
      );
      serializeParams = () => {
        const a = { when: when.serialize(), subject: subject.value, body: editor.getHtml() };
        const list = to.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) a.to = list;
        if (toCol.value) a.toFromColumn = toCol.value;
        const nm = subPicker ? subPicker.serialize() : '';
        if (nm) a.subitemName = nm;
        return a;
      };
    } else if (t === 'set_column') {
      const when = whenControl(i?.when);
      const sc = setColumnControls(i);
      params.append(when.node, sc.node);
      serializeParams = () => ({ when: when.serialize(), ...sc.serialize() });
    } else if (t === 'clone_template_subitems') {
      const grp = el('input', { value: i?.templatesGroupTitle || 'Templates', placeholder: 'Templates group title' });
      const srcCol = combo([{ value: '', label: '— subitem source column —' }, ...colOptions(subCols())], { placeholder: '— subitem source column —', value: i?.templateSourceColumnId || '' });
      params.append(el('label', { text: 'Templates group title' }), grp, el('label', { text: 'Template-source column (subitem)' }), srcCol.node);
      serializeParams = () => ({ templatesGroupTitle: grp.value, templateSourceColumnId: srcCol.value });
    } else if (t === 'clear_pending') {
      const scope = select([
        { value: 'all', label: 'All pending actions' },
        { value: 'rules', label: 'Only specific rules' },
      ]);
      if (i?.scope) scope.value = i.scope;
      const preset = new Set(i?.ruleIds || []);
      const rulesWrap = el('div', { class: 'rule-picker' });
      let boxes = [];
      const renderRules = () => {
        rulesWrap.innerHTML = '';
        boxes = [];
        if (scope.value !== 'rules') return;
        const ids = state.ruleset.rules.map((r) => r.id);
        if (!ids.length) {
          rulesWrap.appendChild(el('span', { class: 'hint', text: 'No saved rules yet — save the target rule first, then edit this one.' }));
          return;
        }
        ids.forEach((id) => {
          const cb = el('input', { type: 'checkbox' });
          if (preset.has(id)) cb.checked = true;
          rulesWrap.appendChild(el('label', { class: 'check-row' }, [cb, el('span', { text: id })]));
          boxes.push({ id, cb });
        });
      };
      scope.addEventListener('change', renderRules);
      params.append(
        el('label', { text: 'Cancel' }), scope,
        el('span', { class: 'hint', text: 'Cancels pending scheduled actions for this item — all, or only the chosen rules’ actions.' }),
        rulesWrap,
      );
      renderRules();
      serializeParams = () => {
        if (scope.value !== 'rules') return {}; // legacy shape: { type: 'clear_pending' }
        return { scope: 'rules', ruleIds: boxes.filter((b) => b.cb.checked).map((b) => b.id) };
      };
    } else {
      params.appendChild(el('span', { class: 'hint', text: 'Cancels all pending scheduled actions for the item.' }));
      serializeParams = () => ({});
    }
  };
  typeSel.addEventListener('change', render);
  render();

  const num = el('span', { class: 'num' });
  const remove = el('button', { class: 'danger', text: '✕', onclick: () => { removeRow(actionRows, row); renumberActions(); } });
  const node = el('div', { class: 'subform' }, [el('div', { class: 'row' }, [num, typeSel, remove]), params]);
  const row = { node, serialize: () => ({ type: typeSel.value, ...serializeParams() }), setNum: (n) => { num.textContent = 'Action ' + n; } };
  return row;
}

/** Re-label the action boxes "Action 1, 2, …" after add/remove/load. */
function renumberActions() {
  actionRows.forEach((r, i) => r.setNum && r.setNum(i + 1));
}

function removeRow(arr, row) {
  const i = arr.indexOf(row);
  if (i >= 0) { arr.splice(i, 1); row.node.remove(); }
}

// ── assemble + persist ───────────────────────────────────────────────────────
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

function generateRuleId() {
  const type = ($('triggerType') && $('triggerType').value) || 'rule';
  const groupId = scopeGroupCombo ? scopeGroupCombo.value : '';
  const title = state.structure?.board?.groups?.find((g) => g.id === groupId)?.title;
  const groupSlug = title ? slugify(title) : '';
  const existing = new Set(state.ruleset.rules.map((r) => r.id));
  const trigSlug = TRIGGER_SLUG[type] || slugify(type);
  let id;
  do {
    const rand = Math.random().toString(36).slice(2, 7);
    id = (groupSlug ? `${groupSlug}-` : '') + `${trigSlug}-${rand}`;
  } while (existing.has(id));
  return id;
}

function buildRule() {
  const id = $('ruleId').value.trim();
  if (!id) throw new Error('Rule ID is required.');
  const groupId = scopeGroupCombo ? scopeGroupCombo.value : '';
  if (!groupId) throw new Error('Pick a group.');
  const rule = {
    id, enabled: $('ruleEnabled').checked, boardId: Number(state.boardId),
    scope: { groupId }, trigger: triggerSerialize(), actions: actionRows.map((r) => r.serialize()),
  };
  const groups = conditionGroups
    .map((g) => ({ conditions: g.serialize().conditions }))
    .filter((g) => g.conditions.length);
  if (groups.length) rule.conditionGroups = groups;
  if (rule.actions.length === 0) throw new Error('Add at least one action.');
  return rule;
}

/** PUT the whole ruleset to the server. Returns {ok, count} or {ok:false, error}. */
async function persistRuleset() {
  const res = await fetch('/api/rules', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret() },
    body: JSON.stringify(state.ruleset),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, count: data.count };
  if (res.status === 401) return { ok: false, error: 'Unauthorized — append ?secret=YOUR_SECRET to the URL.' };
  return { ok: false, error: (data.error || res.statusText) + (data.problems ? '\n- ' + data.problems.join('\n- ') : '') };
}

function syncJsonFromState() {
  $('json').value = JSON.stringify(state.ruleset, null, 2);
  renderRuleList();
}

function renderRuleList() {
  const list = $('ruleList');
  list.innerHTML = '';
  $('ruleCount').textContent = state.ruleset.rules.length;
  if (!state.ruleset.rules.length) {
    list.appendChild(el('div', { class: 'empty' }, [el('span', { class: 'big', text: '📋' }), 'No rules yet — build one on the left.']));
    return;
  }
  const groupTitle = (gid) =>
    state.structure?.board?.groups?.find((g) => g.id === gid)?.title || gid || '(no group)';
  state.ruleset.rules.forEach((r, i) => {
    const enabled = r.enabled !== false;
    const trigLabel = TRIGGER_LABEL[r.trigger?.type] || r.trigger?.type || '(no trigger)';
    const badge = el('span', {
      class: 'badge ' + (enabled ? 'sent' : 'cancelled'),
      text: enabled ? 'enabled' : 'disabled',
    });
    const meta = el('div', {}, [
      el('div', {}, [badge, el('strong', { text: ' ' + r.id })]),
      el('div', {}, [el('span', { class: 'hint', text: `${trigLabel} · ${groupTitle(r.scope?.groupId)} · ${(r.actions || []).length} action(s)` })]),
    ]);
    const edit = el('button', { class: 'link', text: 'edit', onclick: () => loadRuleIntoBuilder(r) });
    const del = el('button', { class: 'danger', text: 'delete', onclick: () => deleteRule(i) });
    list.appendChild(el('div', { class: 'rule-item' }, [meta, el('div', {}, [edit, del])]));
  });
}

/** One-step save: build the rule, upsert, persist to server (rollback on fail). */
async function saveRule() {
  let rule;
  try { rule = buildRule(); } catch (e) { return toast(e.message, 'err'); }
  const prev = state.ruleset.rules.slice();
  const idx = state.ruleset.rules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) state.ruleset.rules[idx] = rule; else state.ruleset.rules.push(rule);
  toast('Saving…');
  const r = await persistRuleset();
  if (r.ok) { syncJsonFromState(); toast(`Saved "${rule.id}" — ${r.count} rule(s) live.`, 'ok'); }
  else { state.ruleset.rules = prev; toast('Save failed: ' + r.error, 'err'); }
}

async function deleteRule(i) {
  const rule = state.ruleset.rules[i];
  if (!rule || !confirm(`Delete rule "${rule.id}"?`)) return;
  const prev = state.ruleset.rules.slice();
  state.ruleset.rules.splice(i, 1);
  const r = await persistRuleset();
  if (r.ok) { syncJsonFromState(); toast(`Deleted "${rule.id}".`, 'ok'); }
  else { state.ruleset.rules = prev; syncJsonFromState(); toast('Delete failed: ' + r.error, 'err'); }
}

async function applyAndSaveJson() {
  let payload;
  try { payload = JSON.parse($('json').value); } catch (e) { return toast('Invalid JSON: ' + e.message, 'err'); }
  const prev = state.ruleset;
  state.ruleset = payload && Array.isArray(payload.rules) ? payload : { rules: [] };
  const r = await persistRuleset();
  if (r.ok) { renderRuleList(); toast(`Saved ${r.count} rule(s) live.`, 'ok'); }
  else { state.ruleset = prev; toast('Save failed: ' + r.error, 'err'); }
}

function loadRuleIntoBuilder(rule) {
  showTab('rules');
  $('ruleId').value = rule.id || '';
  $('ruleEnabled').checked = rule.enabled !== false;
  if (scopeGroupCombo) scopeGroupCombo.value = rule.scope?.groupId || '';

  let trig = rule.trigger || {};
  if (trig.type === 'status_changed_to') trig = { type: 'item_column_changed', columnId: trig.columnId, value: trig.label };
  $('triggerType').value = trig.type || TRIGGERS[0].value;
  renderTriggerParams(trig);

  conditionGroups.length = 0;
  const groupsInit = rule.conditionGroups?.length
    ? rule.conditionGroups
    : rule.conditions?.length
      ? [{ conditions: rule.conditions }]
      : [];
  groupsInit.forEach((g) => conditionGroups.push(makeConditionGroup(g.conditions || [])));
  renderConditionGroups();

  actionRows.length = 0;
  $('actions').innerHTML = '';
  (rule.actions || []).forEach((a) => { const row = makeActionRow(a); actionRows.push(row); $('actions').appendChild(row.node); });
  renumberActions();

  $('builderCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`Editing "${rule.id}" — change fields, then Save rule (same ID overwrites).`, 'ok');
}

// ── toast feedback ─────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, kind) {
  const t = $('toast');
  t.className = 'toast ' + (kind === 'err' ? 'toast-err' : kind === 'ok' ? 'toast-ok' : '');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 7000 : 3500);
}

// ── board + connect ────────────────────────────────────────────────────────────
async function loadBoard() {
  const id = $('boardId').value.trim();
  if (!id) return;
  $('boardChip').innerHTML = '<span class="spinner"></span> loading board…';
  $('boardStatus').textContent = 'Loading…';
  try {
    const res = await fetch('/api/discover?boardId=' + encodeURIComponent(id));
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    state.structure = await res.json();
    state.boardId = id;
    state.groupSubitemNames = null; // reset cached subitem-name suggestions for the new board
    scopeGroupCombo = combo([{ value: '', label: '— select group —' }, ...groupOptions()], { placeholder: '— select group —', onChange: () => { state.groupSubitemNames = null; renderTriggerParams(); } });
    const mount = $('scopeGroupMount'); mount.innerHTML = ''; mount.appendChild(scopeGroupCombo.node);
    renderTriggerParams();
    $('builderCard').classList.remove('disabled');
    const b = state.structure.board;
    $('boardChip').className = 'board-chip live';
    $('boardChip').textContent = b.name;
    const sb = state.structure.subitemBoard ? `, subitem board ${state.structure.subitemBoard.id}` : '';
    $('boardStatus').innerHTML = `<span class="ok">Loaded "${b.name}"</span> — ${b.groups.length} groups, ${b.columns.length} columns${sb}.`;
    renderRuleList(); // re-render now that group titles are available for the rule summaries
    refreshWebhookStatus();
  } catch (err) {
    $('boardChip').className = 'board-chip';
    $('boardChip').textContent = 'board error';
    $('boardStatus').innerHTML = `<span class="err">Failed: ${err.message}</span>`;
  }
}

async function refreshWebhookStatus() {
  if (!state.boardId) return;
  const statusEl = $('connectStatus');
  const eventsEl = $('connectEvents');
  statusEl.innerHTML = '<span class="spinner"></span> checking…';
  eventsEl.textContent = '';
  try {
    const res = await fetch('/api/webhooks?boardId=' + encodeURIComponent(state.boardId));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.connected) {
      statusEl.innerHTML = '<span class="ok">✓ Connected</span> — all events registered.';
      $('connectBtn').textContent = 'Re-connect';
    } else {
      const missing = data.managed.filter((m) => !m.registered).length;
      statusEl.innerHTML = `<span class="err">Not connected</span> — ${missing} of ${data.managed.length} events missing.`;
      $('connectBtn').textContent = 'Connect';
    }
    eventsEl.innerHTML = data.managed.map((m) => `${m.registered ? '✓' : '✗'} ${m.event}`).join('&nbsp;&nbsp;');
  } catch (err) {
    statusEl.innerHTML = `<span class="err">Could not check: ${err.message}</span>`;
  }
}

async function connectBoard() {
  if (!state.boardId) return;
  const btn = $('connectBtn');
  btn.disabled = true;
  $('connectStatus').innerHTML = '<span class="spinner"></span> connecting…';
  try {
    const res = await fetch('/api/webhooks/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret() },
      body: JSON.stringify({ boardId: state.boardId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { $('connectStatus').innerHTML = '<span class="err">Unauthorized — append ?secret=YOUR_SECRET to the URL.</span>'; return; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.failed && data.failed.length) {
      const list = data.failed.map((f) => `${f.event} (${f.error})`).join('; ');
      $('connectEvents').innerHTML = `<span class="err">Registered ${data.created.length}, but ${data.failed.length} unsupported: ${list}</span>`;
    }
    toast('Board connected.', 'ok');
  } catch (err) {
    $('connectStatus').innerHTML = `<span class="err">Failed: ${err.message}</span>`;
  } finally {
    btn.disabled = false;
    refreshWebhookStatus();
  }
}

async function loadRules() {
  try {
    const res = await fetch('/api/rules');
    const data = await res.json();
    state.ruleset = data && Array.isArray(data.rules) ? { rules: data.rules } : { rules: [] };
  } catch { state.ruleset = { rules: [] }; }
  syncJsonFromState();
}

// ── scheduled actions (queue) ──────────────────────────────────────────────────
async function loadQueue() {
  $('queueList').innerHTML = '<div class="empty"><span class="spinner"></span> loading…</div>';
  try {
    const res = await fetch('/api/queue');
    const data = await res.json();
    state.queue = Array.isArray(data.actions) ? data.actions : [];
  } catch { state.queue = []; }
  renderQueue();
}

/** A labelled <select>; keeps the current value if still available after a rebuild. */
function filterSelect(labelText, opts, cur, onChange) {
  const sel = select(opts);
  sel.value = opts.some((o) => o.value === cur) ? cur : '';
  sel.addEventListener('change', () => onChange(sel.value));
  return el('label', { text: labelText }, [sel]);
}

function renderQueueFilters(all) {
  const bar = $('queueFilters');
  bar.innerHTML = '';
  const distinct = (key) => [...new Set(all.map((a) => a[key]).filter((v) => v != null && v !== ''))].sort();
  const opts = (vals, allLabel) => [{ value: '', label: allLabel }, ...vals.map((v) => ({ value: String(v), label: String(v) }))];
  bar.appendChild(filterSelect('Item', opts(distinct('itemId'), 'All items'), queueFilter.item, (v) => { queueFilter.item = v; renderQueue(); }));
  bar.appendChild(filterSelect('Status', opts(['pending', 'sent', 'cancelled', 'failed'], 'All statuses'), queueFilter.status, (v) => { queueFilter.status = v; renderQueue(); }));
  bar.appendChild(filterSelect('Action', opts(['email', 'slack', 'set_column'], 'All actions'), queueFilter.type, (v) => { queueFilter.type = v; renderQueue(); }));
  bar.appendChild(filterSelect('Rule', opts(distinct('ruleId'), 'All rules'), queueFilter.rule, (v) => { queueFilter.rule = v; renderQueue(); }));
}

function renderQueue() {
  const list = $('queueList');
  list.innerHTML = '';
  const all = state.queue || [];
  renderQueueFilters(all);
  const q = all.filter((a) =>
    (!queueFilter.item || String(a.itemId) === queueFilter.item) &&
    (!queueFilter.status || a.status === queueFilter.status) &&
    (!queueFilter.type || a.actionType === queueFilter.type) &&
    (!queueFilter.rule || a.ruleId === queueFilter.rule),
  );
  $('queueCount').textContent = q.length;
  if (!all.length) { list.appendChild(el('div', { class: 'empty' }, [el('span', { class: 'big', text: '🗓️' }), 'No scheduled actions yet.'])); return; }
  if (!q.length) { list.appendChild(el('div', { class: 'empty' }, [el('span', { class: 'big', text: '🔍' }), 'No actions match these filters.'])); return; }
  q.forEach((a) => {
    const summary = a.actionType === 'email'
      ? `${(a.payload && a.payload.subject) || '(no subject)'} → ${((a.payload && a.payload.to) || []).join(', ')}`
      : a.actionType === 'set_column'
        ? `set ${(a.payload && a.payload.columnId) || ''} = ${(a.payload && a.payload.value) || ''}`
        : ((a.payload && a.payload.text) || '').replace(/<[^>]+>/g, '').slice(0, 90);
    const head = el('div', {}, [
      el('span', { class: 'badge ' + a.status, text: a.status }),
      el('strong', { text: ' ' + a.actionType }),
      el('div', { class: 'hint', text: summary }),
    ]);
    const meta = el('div', { class: 'meta', text: `rule ${a.ruleId} · item ${a.itemId} · due ${fmtDate(a.dueAt)}` });
    const when = el('input', { type: 'datetime-local' });
    const acts = el('div', { class: 'acts' }, [
      el('button', { text: '▶ run now', onclick: () => queueAction(a.id, 'run') }),
      when,
      el('button', { text: 'reschedule', onclick: () => {
        if (!when.value) return toast('Pick a date/time first to reschedule.', 'err');
        queueAction(a.id, 'reschedule', { at: new Date(when.value).toISOString() });
      } }),
      el('button', { class: 'danger', text: 'delete', onclick: () => { if (confirm(`Delete this scheduled ${a.actionType} action (rule ${a.ruleId})?`)) queueAction(a.id, 'delete'); } }),
    ]);
    list.appendChild(el('div', { class: 'qitem' }, [head, meta, acts]));
  });
}

async function queueAction(id, kind, body) {
  const opts = { headers: { 'x-webhook-secret': secret() } };
  let url = '/api/queue/' + id;
  if (kind === 'run') { opts.method = 'POST'; url += '/run'; }
  else if (kind === 'reschedule') { opts.method = 'POST'; url += '/reschedule'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  else if (kind === 'delete') { opts.method = 'DELETE'; }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.ok) { toast(`Queue: ${kind} ok (action ${id}).`, 'ok'); loadQueue(); }
  else if (res.status === 401) toast('Unauthorized — append ?secret=YOUR_SECRET to the URL.', 'err');
  else toast(`Queue ${kind} failed: ${data.error || res.statusText}`, 'err');
}

// ── tabs ───────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name));
  if (name === 'scheduled') loadQueue();
  if (name === 'board') refreshWebhookStatus();
}

function init() {
  $('triggerType').innerHTML = '';
  TRIGGERS.forEach((t) => $('triggerType').appendChild(el('option', { value: t.value, text: t.label })));
  $('triggerType').addEventListener('change', () => renderTriggerParams());

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('loadBoard').addEventListener('click', loadBoard);
  $('connectBtn').addEventListener('click', connectBoard);
  $('refreshQueue').addEventListener('click', loadQueue);
  $('genRuleId').addEventListener('click', () => { $('ruleId').value = generateRuleId(); });
  $('addGroup').addEventListener('click', () => { conditionGroups.push(makeConditionGroup()); renderConditionGroups(); });
  $('addAction').addEventListener('click', () => { const r = makeActionRow(); actionRows.push(r); $('actions').appendChild(r.node); renumberActions(); });
  $('saveRule').addEventListener('click', saveRule);
  $('applyJson').addEventListener('click', applyAndSaveJson);

  renderConditionGroups();
  loadRules();
  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    if (cfg.defaultBoardId) { $('boardId').value = cfg.defaultBoardId; loadBoard(); }
    else { $('boardChip').className = 'board-chip'; $('boardChip').textContent = 'no board set'; }
  }).catch(() => {});
}

init();
