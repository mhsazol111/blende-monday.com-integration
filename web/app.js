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
function richEditor(initialHtml, placeholder) {
  const editor = el('div', { class: 'editor', contenteditable: 'true', 'data-ph': placeholder || 'Write a message — format with the toolbar, insert variables below' });
  editor.innerHTML = initialHtml || '';
  const source = el('textarea', { class: 'editor editor-source hidden', spellcheck: 'false' });
  let sourceMode = false;

  let savedRange = null;
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  ['keyup', 'mouseup', 'focus'].forEach((ev) => editor.addEventListener(ev, saveRange));
  const restoreRange = () => {
    editor.focus();
    if (savedRange && editor.contains(savedRange.startContainer)) {
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange);
    }
  };
  const exec = (name, arg) => (e) => { e.preventDefault(); restoreRange(); document.execCommand(name, false, arg); saveRange(); };
  const tbtn = (label, name, title) => el('button', { text: label, title: title || name, onmousedown: exec(name) });

  const heading = select(
    [{ value: 'P', label: 'Normal' }, { value: 'H1', label: 'Heading 1' }, { value: 'H2', label: 'Heading 2' }, { value: 'H3', label: 'Heading 3' }],
    { title: 'text style' },
  );
  heading.addEventListener('mousedown', saveRange);
  heading.addEventListener('change', () => { restoreRange(); document.execCommand('formatBlock', false, heading.value); });

  const color = el('input', { type: 'color', title: 'text color', value: '#323338' });
  color.addEventListener('input', () => { restoreRange(); document.execCommand('foreColor', false, color.value); });

  const link = el('button', { text: '🔗', title: 'insert link', onmousedown: (e) => {
    e.preventDefault(); restoreRange();
    const url = prompt('Link URL:'); if (url) document.execCommand('createLink', false, url); saveRange();
  } });

  const htmlBtn = el('button', { text: '</>', title: 'edit raw HTML', onmousedown: (e) => { e.preventDefault(); toggleSource(); } });
  const toggleSource = () => {
    if (!sourceMode) {
      source.value = editor.innerHTML;
      editor.classList.add('hidden'); source.classList.remove('hidden'); htmlBtn.classList.add('active');
    } else {
      editor.innerHTML = source.value;
      editor.classList.remove('hidden'); source.classList.add('hidden'); htmlBtn.classList.remove('active');
    }
    sourceMode = !sourceMode;
  };

  const toolbar = el('div', { class: 'toolbar' }, [
    heading,
    tbtn('B', 'bold'), tbtn('I', 'italic'), tbtn('U', 'underline'), tbtn('S', 'strikeThrough', 'strikethrough'),
    tbtn('•', 'insertUnorderedList', 'bullet list'), tbtn('1.', 'insertOrderedList', 'numbered list'),
    tbtn('⬅', 'justifyLeft', 'align left'), tbtn('▤', 'justifyCenter', 'align center'), tbtn('➡', 'justifyRight', 'align right'),
    link, tbtn('⛓', 'unlink', 'remove link'), color,
    tbtn('⌫', 'removeFormat', 'clear formatting'), htmlBtn,
  ]);

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

  const node = el('div', {}, [toolbar, editor, source, el('div', { class: 'hint', text: 'Insert variable:' }), chips]);
  return {
    node,
    getHtml: () => (sourceMode ? source.value.trim() : editor.innerHTML.trim()),
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

// ── state ────────────────────────────────────────────────────────────────────
const state = { structure: null, boardId: null, ruleset: { rules: [] }, queue: [] };
const conditionRows = [];
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
        input.placeholder = names.length ? 'subitem — pick or type' : 'no subitems found in group — type a name';
        if (document.activeElement === input) renderList();
      })
      .catch(() => { input.placeholder = 'could not load subitems — type a name'; });
  } else {
    input.placeholder = 'select a group first';
  }
  return { node, serialize: () => input.value.trim() };
}

/** A linked column-combo + label-select; label list follows the chosen column. */
function columnLabelPair(cols, init) {
  const colSel = combo([{ value: '', label: '— column —' }, ...colOptions(cols)], { placeholder: '— column —', onChange: () => refresh() });
  const labelSel = select([{ value: '', label: '— label —' }]);
  const refresh = () => {
    labelSel.innerHTML = '';
    [{ value: '', label: '— label —' }, ...labelsFor(colSel.value)].forEach((o) =>
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

// ── condition rows ───────────────────────────────────────────────────────────
const CONDITIONS = [
  { value: 'status_is', label: 'Status is' },
  { value: 'status_is_not', label: 'Status is not' },
  { value: 'column_equals', label: 'Column equals' },
  { value: 'column_not_empty', label: 'Column is not empty' },
  { value: 'column_empty', label: 'Column is empty' },
  { value: 'in_group', label: 'Item is in group' },
  { value: 'moved_from_group', label: 'Item moved from group' },
  { value: 'subitem_checked', label: 'Subitem is checked' },
];

function makeConditionRow(init) {
  const typeSel = select(CONDITIONS.map((c) => ({ value: c.value, label: c.label })));
  const params = el('div');
  let serializeParams = () => ({});
  let pending = init || null;
  if (init && init.type) typeSel.value = init.type;

  const render = () => {
    const t = typeSel.value;
    const i = pending; pending = null;
    params.innerHTML = '';
    if (t === 'status_is' || t === 'status_is_not') {
      const pair = columnLabelPair(byType(boardCols(), ['status', 'color']), i);
      params.appendChild(pair.node);
      serializeParams = pair.serialize;
    } else if (t === 'column_equals') {
      const col = combo([{ value: '', label: '— column —' }, ...colOptions(boardCols())], { placeholder: '— column —', value: i?.columnId || '' });
      const val = el('input', { placeholder: 'value (matches column text)', value: i?.value || '' });
      params.appendChild(el('div', { class: 'row' }, [col.node, val]));
      serializeParams = () => ({ columnId: col.value, value: val.value });
    } else if (t === 'column_empty' || t === 'column_not_empty') {
      const col = combo([{ value: '', label: '— column —' }, ...colOptions(boardCols())], { placeholder: '— column —', value: i?.columnId || '' });
      params.appendChild(col.node);
      serializeParams = () => ({ columnId: col.value });
    } else if (t === 'in_group' || t === 'moved_from_group') {
      const g = combo([{ value: '', label: '— group —' }, ...groupOptions()], { placeholder: '— group —', value: i?.groupId || '' });
      params.appendChild(g.node);
      serializeParams = () => ({ groupId: g.value });
    } else if (t === 'subitem_checked') {
      const pair = columnLabelPair(byType(subCols(), ['status', 'color']), i);
      const picker = subitemNamePicker(i?.subitemName);
      params.append(el('label', { text: 'Subitem' }), picker.node, el('label', { text: 'Status → label' }), pair.node);
      serializeParams = () => {
        const p = pair.serialize();
        const nm = picker.serialize();
        return nm ? { ...p, subitemName: nm } : p;
      };
    }
  };
  typeSel.addEventListener('change', render);
  render();

  const remove = el('button', { class: 'danger', text: '✕', onclick: () => removeRow(conditionRows, row) });
  const node = el('div', { class: 'subform' }, [el('div', { class: 'row' }, [typeSel, remove]), params]);
  const row = { node, serialize: () => ({ type: typeSel.value, ...serializeParams() }) };
  return row;
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
      const inp = el('input', { placeholder: 'value (supports {{variables}}, e.g. text/number/YYYY-MM-DD)', value: initValue || '' });
      valWrap.appendChild(inp);
      getValue = () => inp.value;
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
    { value: 'absolute', label: 'at a specific time' },
  ]);
  const relDays = el('input', { type: 'number', min: '0', value: '0' });
  const relHours = el('input', { type: 'number', min: '0', value: '0' });
  const relMins = el('input', { type: 'number', min: '0', value: '0' });
  const field = (label, input) => el('div', {}, [el('label', { text: label }), input]);
  const rel = el('div', { class: 'row hidden' }, [field('Days', relDays), field('Hours', relHours), field('Minutes', relMins)]);
  const abs = el('input', { type: 'datetime-local', class: 'hidden' });
  const sync = () => {
    rel.classList.toggle('hidden', mode.value !== 'relative');
    abs.classList.toggle('hidden', mode.value !== 'absolute');
  };
  mode.addEventListener('change', sync);
  if (init && init.mode) {
    mode.value = init.mode;
    if (init.mode === 'relative') { relDays.value = init.days || 0; relHours.value = init.hours || 0; relMins.value = init.minutes || 0; }
    if (init.mode === 'absolute' && init.at) {
      const d = new Date(init.at);
      if (!isNaN(d)) abs.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    sync();
  }
  const node = el('div', {}, [el('span', { class: 'hint', text: 'When' }), mode, rel, abs]);
  const serialize = () => {
    if (mode.value === 'relative') return { mode: 'relative', days: Number(relDays.value) || 0, hours: Number(relHours.value) || 0, minutes: Number(relMins.value) || 0 };
    if (mode.value === 'absolute') return { mode: 'absolute', at: abs.value ? new Date(abs.value).toISOString() : '' };
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
      params.append(when.node, el('label', { text: 'Webhook URL' }), url, el('label', { text: 'Message (HTML → Slack mrkdwn)' }), editor.node);
      serializeParams = () => {
        const a = { when: when.serialize(), text: editor.getHtml() };
        if (url.value.trim()) a.webhookUrl = url.value.trim();
        return a;
      };
    } else if (t === 'email') {
      const when = whenControl(i?.when);
      const to = el('input', { placeholder: 'a@x.com, b@y.com', value: (i?.to || []).join(', ') });
      const toCol = combo([{ value: '', label: '— none —' }, ...colOptions(byType(boardCols(), ['people']))], { placeholder: '— none —', value: i?.toFromColumn || '' });
      const subject = el('input', { placeholder: 'subject, e.g. {{item.name}} is Done', value: i?.subject || '' });
      const editor = richEditor(i?.body, 'Email body — rich text supported');
      params.append(
        when.node,
        el('label', { text: 'To (literal addresses)' }), to,
        el('label', { text: 'To (from people column)' }), toCol.node,
        el('label', { text: 'Subject' }), subject,
        el('label', { text: 'Body (rich HTML)' }), editor.node,
      );
      serializeParams = () => {
        const a = { when: when.serialize(), subject: subject.value, body: editor.getHtml() };
        const list = to.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) a.to = list;
        if (toCol.value) a.toFromColumn = toCol.value;
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
    } else {
      params.appendChild(el('span', { class: 'hint', text: 'Cancels all pending scheduled actions for the item.' }));
      serializeParams = () => ({});
    }
  };
  typeSel.addEventListener('change', render);
  render();

  const remove = el('button', { class: 'danger', text: '✕', onclick: () => removeRow(actionRows, row) });
  const node = el('div', { class: 'subform' }, [el('div', { class: 'row' }, [typeSel, remove]), params]);
  const row = { node, serialize: () => ({ type: typeSel.value, ...serializeParams() }) };
  return row;
}

function removeRow(arr, row) {
  const i = arr.indexOf(row);
  if (i >= 0) { arr.splice(i, 1); row.node.remove(); }
}

// ── assemble + persist ───────────────────────────────────────────────────────
function generateRuleId() {
  const type = ($('triggerType') && $('triggerType').value) || 'rule';
  const existing = new Set(state.ruleset.rules.map((r) => r.id));
  let id;
  do { id = `${type}-${Math.random().toString(36).slice(2, 7)}`; } while (existing.has(id));
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
  const conds = conditionRows.map((r) => r.serialize());
  if (conds.length) rule.conditions = conds;
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
  state.ruleset.rules.forEach((r, i) => {
    const meta = el('div', {}, [
      el('strong', { text: r.id }),
      el('div', {}, [el('code', { text: `${r.trigger?.type} · ${r.scope?.groupId ?? ''} · ${(r.actions || []).length} action(s)` })]),
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

  conditionRows.length = 0;
  $('conditions').innerHTML = '';
  (rule.conditions || []).forEach((c) => { const row = makeConditionRow(c); conditionRows.push(row); $('conditions').appendChild(row.node); });

  actionRows.length = 0;
  $('actions').innerHTML = '';
  (rule.actions || []).forEach((a) => { const row = makeActionRow(a); actionRows.push(row); $('actions').appendChild(row.node); });

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
    scopeGroupCombo = combo([{ value: '', label: '— select group —' }, ...groupOptions()], { placeholder: '— select group —', onChange: () => renderTriggerParams() });
    const mount = $('scopeGroupMount'); mount.innerHTML = ''; mount.appendChild(scopeGroupCombo.node);
    renderTriggerParams();
    $('builderCard').classList.remove('disabled');
    const b = state.structure.board;
    $('boardChip').className = 'board-chip live';
    $('boardChip').textContent = b.name;
    const sb = state.structure.subitemBoard ? `, subitem board ${state.structure.subitemBoard.id}` : '';
    $('boardStatus').innerHTML = `<span class="ok">Loaded "${b.name}"</span> — ${b.groups.length} groups, ${b.columns.length} columns${sb}.`;
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

function renderQueue() {
  const list = $('queueList');
  list.innerHTML = '';
  const q = state.queue || [];
  $('queueCount').textContent = q.length;
  if (!q.length) { list.appendChild(el('div', { class: 'empty' }, [el('span', { class: 'big', text: '🗓️' }), 'No scheduled actions yet.'])); return; }
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
  $('addCondition').addEventListener('click', () => { const r = makeConditionRow(); conditionRows.push(r); $('conditions').appendChild(r.node); });
  $('addAction').addEventListener('click', () => { const r = makeActionRow(); actionRows.push(r); $('actions').appendChild(r.node); });
  $('saveRule').addEventListener('click', saveRule);
  $('applyJson').addEventListener('click', applyAndSaveJson);

  loadRules();
  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    if (cfg.defaultBoardId) { $('boardId').value = cfg.defaultBoardId; loadBoard(); }
    else { $('boardChip').className = 'board-chip'; $('boardChip').textContent = 'no board set'; }
  }).catch(() => {});
}

init();
