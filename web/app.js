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

// ── rich text editor (dependency-free, contenteditable → HTML) ─────────────────
// One message authored as HTML works for both channels: email sends the HTML,
// Slack gets it converted to mrkdwn server-side. Includes a clickable list of the
// available {{variables}} that insert at the caret.
function richEditor(initialHtml, placeholder) {
  const editor = el('div', { class: 'editor', contenteditable: 'true', 'data-ph': placeholder || 'Write a message — use the buttons for formatting and chips for variables' });
  editor.innerHTML = initialHtml || '';
  const cmd = (name, arg) => (e) => { e.preventDefault(); editor.focus(); document.execCommand(name, false, arg); };
  const tbtn = (label, name) => el('button', { text: label, title: name, onmousedown: cmd(name) });
  const linkBtn = el('button', { text: '🔗', title: 'link', onmousedown: (e) => {
    e.preventDefault(); editor.focus();
    const url = prompt('Link URL:'); if (url) document.execCommand('createLink', false, url);
  } });
  const toolbar = el('div', { class: 'toolbar' }, [
    tbtn('B', 'bold'), tbtn('I', 'italic'), tbtn('U', 'underline'),
    tbtn('• List', 'insertUnorderedList'), linkBtn,
    el('button', { text: 'Clear', title: 'remove formatting', onmousedown: cmd('removeFormat') }),
  ]);

  // Remember the caret position inside this editor, because clicking a chip can
  // move the selection. We snapshot the range on every interaction and restore
  // it before inserting.
  let savedRange = null;
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  ['keyup', 'mouseup', 'focus'].forEach((ev) => editor.addEventListener(ev, saveRange));

  // Insert text (a {{variable}}) at the last known caret position in this editor.
  const insertAtCaret = (text) => {
    editor.focus();
    const sel = window.getSelection();
    if (savedRange && editor.contains(savedRange.startContainer)) {
      sel.removeAllRanges(); sel.addRange(savedRange);
    }
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node); range.setEndAfter(node);
      sel.removeAllRanges(); sel.addRange(range);
      savedRange = range.cloneRange();
    } else {
      editor.innerHTML += text; // editor never focused yet → append
    }
  };
  const chips = el('div', { class: 'chips' },
    availableVariables().map((v) =>
      el('span', { class: 'chip', title: v.hint || '', text: v.token,
        // mousedown + preventDefault so the chip doesn't steal focus/selection.
        onmousedown: (e) => { e.preventDefault(); insertAtCaret(v.token); } })));
  const varsLabel = el('div', { class: 'hint', text: 'Insert variable:' });

  const node = el('div', {}, [toolbar, editor, varsLabel, chips]);
  return { node, getHtml: () => editor.innerHTML.trim(), setHtml: (h) => { editor.innerHTML = h || ''; } };
}

// The {{placeholders}} the engine resolves (see buildContext): item/group/status
// plus every column on the loaded board, addressed by id.
function availableVariables() {
  const base = [
    { token: '{{item.name}}', hint: 'Item name' },
    { token: '{{item.id}}', hint: 'Item id' },
    { token: '{{group.title}}', hint: 'Group title' },
    { token: '{{status}}', hint: 'Item status label' },
  ];
  const cols = boardCols().map((c) => ({ token: `{{column.${c.id}}}`, hint: `${c.title} [${c.type}]` }));
  return base.concat(cols);
}

// ── state ────────────────────────────────────────────────────────────────────
const state = { structure: null, boardId: null, ruleset: { rules: [] }, queue: [] };
const conditionRows = [];
const actionRows = [];

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
 * Subitem picker: a dropdown of real subitem names for the currently-selected
 * group (you can also type one). Subitems differ per item but share names
 * within a group, so rules match by name.
 */
function subitemNamePicker(initValue) {
  const listId = 'dl_' + Math.random().toString(36).slice(2);
  const input = el('input', { list: listId, placeholder: 'subitem — pick or type', value: initValue || '' });
  const dl = el('datalist', { id: listId });
  const node = el('div', {}, [input, dl]);
  const groupId = $('scopeGroup') ? $('scopeGroup').value : '';
  if (state.boardId && groupId) {
    fetch('/api/group-subitems?boardId=' + encodeURIComponent(state.boardId) + '&groupId=' + encodeURIComponent(groupId))
      .then((r) => r.json())
      .then((d) => {
        const names = d.names || [];
        names.forEach((n) => dl.appendChild(el('option', { value: n })));
        if (!names.length) input.placeholder = 'no subitems found in group — type a name';
      })
      .catch(() => { input.placeholder = 'could not load subitems — type a name'; });
  } else {
    input.placeholder = 'select a group first';
  }
  return { node, serialize: () => input.value.trim() };
}

/** A linked column-select + label-select; label list follows the chosen column. */
function columnLabelPair(cols, init) {
  const colSel = select([{ value: '', label: '— column —' }, ...colOptions(cols)]);
  const labelSel = select([{ value: '', label: '— label —' }]);
  const refresh = () => {
    labelSel.innerHTML = '';
    [{ value: '', label: '— label —' }, ...labelsFor(colSel.value)].forEach((o) =>
      labelSel.appendChild(el('option', { value: o.value, text: o.label })),
    );
  };
  colSel.addEventListener('change', refresh);
  if (init && init.columnId) { colSel.value = init.columnId; refresh(); labelSel.value = init.label || ''; }
  const node = el('div', { class: 'row' }, [colSel, labelSel]);
  return { node, serialize: () => ({ columnId: colSel.value, label: labelSel.value }) };
}

// ── trigger params ───────────────────────────────────────────────────────────
const TRIGGERS = [
  { value: 'item_entered_group', label: 'Item entered the group' },
  { value: 'item_left_group', label: 'Item left the group' },
  { value: 'status_changed_to', label: 'Status column changed to…' },
  { value: 'subitem_checked', label: 'Subitem set (status →)' },
  { value: 'all_subitems_checked', label: 'All of these subitems set (any order)' },
  { value: 'item_in_group_for_days', label: 'Item in group for N days' },
];

/** Multiple subitem pickers with add/remove; serializes to a names array. */
function multiSubitemPicker(initNames) {
  const rows = [];
  const list = el('div');
  const add = (value) => {
    const picker = subitemNamePicker(value);
    const remove = el('button', {
      class: 'danger',
      text: '✕',
      onclick: (e) => { e.preventDefault(); const i = rows.indexOf(entry); if (i >= 0) { rows.splice(i, 1); row.remove(); } },
    });
    const row = el('div', { class: 'row' }, [picker.node, remove]);
    const entry = { row, serialize: picker.serialize };
    rows.push(entry);
    list.appendChild(row);
  };
  if (initNames && initNames.length) initNames.forEach((n) => add(n));
  else { add(); add(); } // start with two empty rows
  const addBtn = el('button', { class: 'link', text: '+ add subitem', onclick: (e) => { e.preventDefault(); add(); } });
  const node = el('div', {}, [list, addBtn]);
  return { node, serialize: () => rows.map((r) => r.serialize()).filter(Boolean) };
}
let triggerSerialize = () => ({ type: 'item_entered_group' });

function renderTriggerParams(init) {
  const type = $('triggerType').value;
  const i = init && init.type === type ? init : null; // only prefill matching type
  const box = $('triggerParams');
  box.innerHTML = '';
  if (type === 'status_changed_to') {
    const pair = columnLabelPair(byType(boardCols(), ['status', 'color']), i);
    box.appendChild(el('span', { class: 'hint', text: 'Status column → label' }));
    box.appendChild(pair.node);
    triggerSerialize = () => ({ type, ...pair.serialize() });
  } else if (type === 'subitem_checked') {
    const pair = columnLabelPair(byType(subCols(), ['status', 'color']), i);
    const picker = subitemNamePicker(i?.subitemName);
    box.appendChild(el('label', { text: 'Subitem' }));
    box.appendChild(picker.node);
    box.appendChild(el('label', { text: 'Status column → label that counts as "checked" (e.g. Done)' }));
    box.appendChild(pair.node);
    triggerSerialize = () => {
      const p = pair.serialize();
      const nm = picker.serialize();
      return nm ? { type, ...p, subitemName: nm } : { type, ...p };
    };
  } else if (type === 'all_subitems_checked') {
    const pair = columnLabelPair(byType(subCols(), ['status', 'color']), i);
    const multi = multiSubitemPicker(i?.subitemNames);
    box.appendChild(el('label', { text: 'Subitems — fires once when ALL reach the status (any order)' }));
    box.appendChild(multi.node);
    box.appendChild(el('label', { text: 'Status column → label (e.g. Done)' }));
    box.appendChild(pair.node);
    triggerSerialize = () => {
      const p = pair.serialize();
      return { type, columnId: p.columnId, label: p.label, subitemNames: multi.serialize() };
    };
  } else if (type === 'item_in_group_for_days') {
    const days = el('input', { type: 'number', min: '1', value: i?.days != null ? String(i.days) : '7' });
    const repeat = el('input', { type: 'number', min: '0', placeholder: 'repeat every N days (optional)', value: i?.repeatEveryDays != null ? String(i.repeatEveryDays) : '' });
    box.appendChild(el('label', { text: 'Days' }));
    box.appendChild(days);
    box.appendChild(el('label', { text: 'Repeat every (days)' }));
    box.appendChild(repeat);
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
  { value: 'subitem_checked', label: 'Subitem is checked' },
];

function makeConditionRow(init) {
  const typeSel = select(CONDITIONS.map((c) => ({ value: c.value, label: c.label })));
  const params = el('div');
  let serializeParams = () => ({});
  let pending = init || null; // consumed on first render to prefill

  if (init && init.type) typeSel.value = init.type;

  const render = () => {
    const t = typeSel.value;
    const i = pending; pending = null; // only prefill the initial type
    params.innerHTML = '';
    if (t === 'status_is' || t === 'status_is_not') {
      const pair = columnLabelPair(byType(boardCols(), ['status', 'color']), i);
      params.appendChild(pair.node);
      serializeParams = pair.serialize;
    } else if (t === 'column_equals') {
      const col = select([{ value: '', label: '— column —' }, ...colOptions(boardCols())]);
      const val = el('input', { placeholder: 'value (matches column text)', value: i?.value || '' });
      if (i?.columnId) col.value = i.columnId;
      params.appendChild(el('div', { class: 'row' }, [col, val]));
      serializeParams = () => ({ columnId: col.value, value: val.value });
    } else if (t === 'column_empty' || t === 'column_not_empty') {
      const col = select([{ value: '', label: '— column —' }, ...colOptions(boardCols())]);
      if (i?.columnId) col.value = i.columnId;
      params.appendChild(col);
      serializeParams = () => ({ columnId: col.value });
    } else if (t === 'in_group') {
      const g = select([{ value: '', label: '— group —' }, ...groupOptions()]);
      if (i?.groupId) g.value = i.groupId;
      params.appendChild(g);
      serializeParams = () => ({ groupId: g.value });
    } else if (t === 'subitem_checked') {
      const pair = columnLabelPair(byType(subCols(), ['status', 'color']), i);
      const picker = subitemNamePicker(i?.subitemName);
      params.appendChild(el('label', { text: 'Subitem' }));
      params.appendChild(picker.node);
      params.appendChild(el('label', { text: 'Status → label' }));
      params.appendChild(pair.node);
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
  { value: 'clear_pending', label: 'Clear pending actions' },
  { value: 'clone_template_subitems', label: 'Clone template subitems' },
];

function whenControl(init) {
  const mode = select([
    { value: 'immediate', label: 'immediately' },
    { value: 'relative', label: 'after a delay' },
    { value: 'absolute', label: 'at a specific time' },
  ]);
  const rel = el('div', { class: 'row hidden' }, [
    el('input', { type: 'number', min: '0', value: '0' }),
    el('input', { type: 'number', min: '0', value: '0' }),
  ]);
  const relDays = rel.children[0];
  const relHours = rel.children[1];
  const abs = el('input', { type: 'datetime-local', class: 'hidden' });
  const sync = () => {
    rel.classList.toggle('hidden', mode.value !== 'relative');
    abs.classList.toggle('hidden', mode.value !== 'absolute');
  };
  mode.addEventListener('change', sync);
  if (init && init.mode) {
    mode.value = init.mode;
    if (init.mode === 'relative') { relDays.value = init.days || 0; relHours.value = init.hours || 0; }
    if (init.mode === 'absolute' && init.at) {
      const d = new Date(init.at);
      if (!isNaN(d)) abs.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    sync();
  }
  const node = el('div', {}, [el('span', { class: 'hint', text: 'When' }), mode, rel, abs]);
  const serialize = () => {
    if (mode.value === 'relative') return { mode: 'relative', days: Number(relDays.value) || 0, hours: Number(relHours.value) || 0 };
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
      const toCol = select([{ value: '', label: '— none —' }, ...colOptions(byType(boardCols(), ['people']))]);
      if (i?.toFromColumn) toCol.value = i.toFromColumn;
      const subject = el('input', { placeholder: 'subject, e.g. {{item.name}} is Done', value: i?.subject || '' });
      const editor = richEditor(i?.body, 'Email body — rich text supported');
      params.append(
        when.node,
        el('label', { text: 'To (literal addresses)' }), to,
        el('label', { text: 'To (from people column)' }), toCol,
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
    } else if (t === 'clone_template_subitems') {
      const grp = el('input', { value: i?.templatesGroupTitle || 'Templates', placeholder: 'Templates group title' });
      const srcCol = select([{ value: '', label: '— subitem source column —' }, ...colOptions(subCols())]);
      if (i?.templateSourceColumnId) srcCol.value = i.templateSourceColumnId;
      params.append(el('label', { text: 'Templates group title' }), grp, el('label', { text: 'Template-source column (subitem)' }), srcCol);
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
/** A readable, unique rule id (trigger type + random), unique within the ruleset. */
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
  const groupId = $('scopeGroup').value;
  if (!groupId) throw new Error('Pick a group.');
  const rule = {
    id,
    enabled: $('ruleEnabled').checked,
    boardId: Number(state.boardId),
    scope: { groupId },
    trigger: triggerSerialize(),
    actions: actionRows.map((r) => r.serialize()),
  };
  const conds = conditionRows.map((r) => r.serialize());
  if (conds.length) rule.conditions = conds;
  if (rule.actions.length === 0) throw new Error('Add at least one action.');
  return rule;
}

function syncJsonFromState() {
  $('json').value = JSON.stringify(state.ruleset, null, 2);
  renderRuleList();
}
function renderRuleList() {
  const list = $('ruleList');
  list.innerHTML = '';
  $('ruleCount').textContent = state.ruleset.rules.length;
  state.ruleset.rules.forEach((r, i) => {
    const meta = el('div', {}, [
      el('strong', { text: r.id }),
      el('div', {}, [el('code', { text: `${r.trigger?.type} · ${r.scope?.groupId ?? ''} · ${(r.actions || []).length} action(s)` })]),
    ]);
    const edit = el('button', { class: 'link', text: 'edit', onclick: () => loadRuleIntoBuilder(r) });
    const del = el('button', { class: 'danger', text: 'delete', onclick: () => { state.ruleset.rules.splice(i, 1); syncJsonFromState(); } });
    list.appendChild(el('div', { class: 'rule-item' }, [meta, el('div', {}, [edit, del])]));
  });
}

/** Load a saved rule back into the builder form for editing. */
function loadRuleIntoBuilder(rule) {
  $('ruleId').value = rule.id || '';
  $('ruleEnabled').checked = rule.enabled !== false;
  $('scopeGroup').value = rule.scope?.groupId || '';

  // Trigger: set the type, then render its params prefilled.
  $('triggerType').value = rule.trigger?.type || TRIGGERS[0].value;
  renderTriggerParams(rule.trigger || {});

  // Conditions: rebuild rows from the saved list.
  conditionRows.length = 0;
  $('conditions').innerHTML = '';
  (rule.conditions || []).forEach((c) => {
    const row = makeConditionRow(c);
    conditionRows.push(row);
    $('conditions').appendChild(row.node);
  });

  // Actions: rebuild rows from the saved list.
  actionRows.length = 0;
  $('actions').innerHTML = '';
  (rule.actions || []).forEach((a) => {
    const row = makeActionRow(a);
    actionRows.push(row);
    $('actions').appendChild(row.node);
  });

  $('builderCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStatus(`Editing "${rule.id}" — change fields, then "Add rule to ruleset →" (same ID overwrites).`, 'ok');
}

function setStatus(msg, cls) {
  const s = $('status');
  s.className = cls || 'hint';
  s.textContent = msg;
}

// ── wire up ──────────────────────────────────────────────────────────────────
async function loadBoard() {
  const id = $('boardId').value.trim();
  if (!id) return;
  $('boardStatus').textContent = 'Loading…';
  try {
    const res = await fetch('/api/discover?boardId=' + encodeURIComponent(id));
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    state.structure = await res.json();
    state.boardId = id;
    $('scopeGroup').innerHTML = '';
    [{ value: '', label: '— select group —' }, ...groupOptions()].forEach((o) => $('scopeGroup').appendChild(el('option', { value: o.value, text: o.label })));
    renderTriggerParams();
    $('builderCard').style.opacity = '1';
    $('builderCard').style.pointerEvents = 'auto';
    const sb = state.structure.subitemBoard ? `, subitem board ${state.structure.subitemBoard.id}` : '';
    $('boardStatus').innerHTML = `<span class="ok">Loaded "${state.structure.board.name}"</span> — ${state.structure.board.groups.length} groups, ${state.structure.board.columns.length} columns${sb}.`;
    $('connectCard').classList.remove('hidden');
    refreshWebhookStatus();
  } catch (err) {
    $('boardStatus').innerHTML = `<span class="err">Failed: ${err.message}</span>`;
  }
}

// ── connect board (webhooks) ───────────────────────────────────────────────────
async function refreshWebhookStatus() {
  if (!state.boardId) return;
  const statusEl = $('connectStatus');
  const eventsEl = $('connectEvents');
  statusEl.textContent = 'Checking…';
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
    eventsEl.innerHTML = data.managed
      .map((m) => `${m.registered ? '✓' : '✗'} ${m.event}`)
      .join('&nbsp;&nbsp;');
  } catch (err) {
    statusEl.innerHTML = `<span class="err">Could not check: ${err.message}</span>`;
  }
}

async function connectBoard() {
  if (!state.boardId) return;
  const btn = $('connectBtn');
  btn.disabled = true;
  $('connectStatus').textContent = 'Connecting…';
  try {
    const res = await fetch('/api/webhooks/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret() },
      body: JSON.stringify({ boardId: state.boardId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { $('connectStatus').innerHTML = '<span class="err">Unauthorized — append ?secret=YOUR_SECRET to the URL.</span>'; return; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.failed && data.failed.length) {
      const list = data.failed.map((f) => `${f.event} (${f.error})`).join('; ');
      $('connectEvents').innerHTML = `<span class="err">Registered ${data.created.length}, but ${data.failed.length} unsupported: ${list}</span>`;
    }
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

async function save() {
  let payload;
  try { payload = JSON.parse($('json').value); } catch (e) { return setStatus('Invalid JSON: ' + e.message, 'err'); }
  setStatus('Saving…');
  const res = await fetch('/api/rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret() },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) { state.ruleset = payload; renderRuleList(); setStatus(`Saved ${data.count} rule(s). Engine reloaded.`, 'ok'); }
  else if (res.status === 401) { setStatus('Unauthorized — append ?secret=YOUR_SECRET to the URL.', 'err'); }
  else { setStatus('Save failed: ' + (data.error || res.statusText) + (data.problems ? '\n- ' + data.problems.join('\n- ') : ''), 'err'); }
}

// ── scheduled actions (queue) ──────────────────────────────────────────────────
async function loadQueue() {
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
  if (!q.length) { list.appendChild(el('p', { class: 'hint', text: 'No scheduled actions yet.' })); return; }
  q.forEach((a) => {
    const summary = a.actionType === 'email'
      ? `${(a.payload && a.payload.subject) || '(no subject)'} → ${((a.payload && a.payload.to) || []).join(', ')}`
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
        if (!when.value) return setStatus('Pick a date/time first to reschedule.', 'err');
        queueAction(a.id, 'reschedule', { at: new Date(when.value).toISOString() });
      } }),
      el('button', { class: 'danger', text: 'delete', onclick: () => queueAction(a.id, 'delete') }),
    ]);
    list.appendChild(el('div', { class: 'qitem' }, [head, meta, acts]));
  });
}

async function queueAction(id, kind, body) {
  const opts = { headers: { 'x-webhook-secret': secret() } };
  let url = '/api/queue/' + id;
  if (kind === 'run') { opts.method = 'POST'; url += '/run'; }
  else if (kind === 'reschedule') {
    opts.method = 'POST'; url += '/reschedule';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (kind === 'delete') { opts.method = 'DELETE'; }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.ok) { setStatus(`Queue: ${kind} ok (action ${id}).`, 'ok'); loadQueue(); }
  else if (res.status === 401) setStatus('Unauthorized — append ?secret=YOUR_SECRET to the URL.', 'err');
  else setStatus(`Queue ${kind} failed: ${data.error || res.statusText}`, 'err');
}

function init() {
  $('triggerType').innerHTML = '';
  TRIGGERS.forEach((t) => $('triggerType').appendChild(el('option', { value: t.value, text: t.label })));
  $('triggerType').addEventListener('change', () => renderTriggerParams());
  $('scopeGroup').addEventListener('change', () => renderTriggerParams()); // refresh subitem list per group

  $('loadBoard').addEventListener('click', loadBoard);
  $('connectBtn').addEventListener('click', connectBoard);
  $('refreshQueue').addEventListener('click', loadQueue);
  $('genRuleId').addEventListener('click', () => { $('ruleId').value = generateRuleId(); });
  $('addCondition').addEventListener('click', () => { const r = makeConditionRow(); conditionRows.push(r); $('conditions').appendChild(r.node); });
  $('addAction').addEventListener('click', () => { const r = makeActionRow(); actionRows.push(r); $('actions').appendChild(r.node); });
  $('addRule').addEventListener('click', () => {
    try {
      const rule = buildRule();
      const existing = state.ruleset.rules.findIndex((r) => r.id === rule.id);
      if (existing >= 0) state.ruleset.rules[existing] = rule; else state.ruleset.rules.push(rule);
      syncJsonFromState();
      setStatus('Added "' + rule.id + '" to the ruleset (not yet saved).', 'ok');
    } catch (err) { setStatus(err.message, 'err'); }
  });
  $('applyJson').addEventListener('click', () => {
    try { state.ruleset = JSON.parse($('json').value); renderRuleList(); setStatus('Applied JSON.', 'ok'); }
    catch (e) { setStatus('Invalid JSON: ' + e.message, 'err'); }
  });
  $('save').addEventListener('click', save);

  fetch('/api/config').then((r) => r.json()).then((cfg) => { if (cfg.defaultBoardId) $('boardId').value = cfg.defaultBoardId; }).catch(() => {});
  loadRules();
  loadQueue();
}

init();
