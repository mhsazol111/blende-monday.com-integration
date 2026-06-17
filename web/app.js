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

// ── state ────────────────────────────────────────────────────────────────────
const state = { structure: null, boardId: null, ruleset: { rules: [] } };
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
function subitemNamePicker() {
  const listId = 'dl_' + Math.random().toString(36).slice(2);
  const input = el('input', { list: listId, placeholder: 'subitem — pick or type' });
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
function columnLabelPair(cols) {
  const colSel = select([{ value: '', label: '— column —' }, ...colOptions(cols)]);
  const labelSel = select([{ value: '', label: '— label —' }]);
  const refresh = () => {
    labelSel.innerHTML = '';
    [{ value: '', label: '— label —' }, ...labelsFor(colSel.value)].forEach((o) =>
      labelSel.appendChild(el('option', { value: o.value, text: o.label })),
    );
  };
  colSel.addEventListener('change', refresh);
  const node = el('div', { class: 'row' }, [colSel, labelSel]);
  return { node, serialize: () => ({ columnId: colSel.value, label: labelSel.value }) };
}

// ── trigger params ───────────────────────────────────────────────────────────
const TRIGGERS = [
  { value: 'item_entered_group', label: 'Item entered the group' },
  { value: 'item_left_group', label: 'Item left the group' },
  { value: 'item_moved', label: 'Item moved to another board/workspace' },
  { value: 'status_changed_to', label: 'Status column changed to…' },
  { value: 'subitem_checked', label: 'Subitem set (status →)' },
  { value: 'all_subitems_checked', label: 'All of these subitems set (any order)' },
  { value: 'item_in_group_for_days', label: 'Item in group for N days' },
];

/** Multiple subitem pickers with add/remove; serializes to a names array. */
function multiSubitemPicker() {
  const rows = [];
  const list = el('div');
  const add = () => {
    const picker = subitemNamePicker();
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
  add();
  add(); // start with two rows
  const addBtn = el('button', { class: 'link', text: '+ add subitem', onclick: (e) => { e.preventDefault(); add(); } });
  const node = el('div', {}, [list, addBtn]);
  return { node, serialize: () => rows.map((r) => r.serialize()).filter(Boolean) };
}
let triggerSerialize = () => ({ type: 'item_entered_group' });

function renderTriggerParams() {
  const type = $('triggerType').value;
  const box = $('triggerParams');
  box.innerHTML = '';
  if (type === 'status_changed_to') {
    const pair = columnLabelPair(byType(boardCols(), ['status', 'color']));
    box.appendChild(el('span', { class: 'hint', text: 'Status column → label' }));
    box.appendChild(pair.node);
    triggerSerialize = () => ({ type, ...pair.serialize() });
  } else if (type === 'subitem_checked') {
    const pair = columnLabelPair(byType(subCols(), ['status', 'color']));
    const picker = subitemNamePicker();
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
    const pair = columnLabelPair(byType(subCols(), ['status', 'color']));
    const multi = multiSubitemPicker();
    box.appendChild(el('label', { text: 'Subitems — fires once when ALL reach the status (any order)' }));
    box.appendChild(multi.node);
    box.appendChild(el('label', { text: 'Status column → label (e.g. Done)' }));
    box.appendChild(pair.node);
    triggerSerialize = () => {
      const p = pair.serialize();
      return { type, columnId: p.columnId, label: p.label, subitemNames: multi.serialize() };
    };
  } else if (type === 'item_in_group_for_days') {
    const days = el('input', { type: 'number', min: '1', value: '7' });
    const repeat = el('input', { type: 'number', min: '0', placeholder: 'repeat every N days (optional)' });
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

function makeConditionRow() {
  const typeSel = select(CONDITIONS.map((c) => ({ value: c.value, label: c.label })));
  const params = el('div');
  let serializeParams = () => ({});

  const render = () => {
    const t = typeSel.value;
    params.innerHTML = '';
    if (t === 'status_is' || t === 'status_is_not') {
      const pair = columnLabelPair(byType(boardCols(), ['status', 'color']));
      params.appendChild(pair.node);
      serializeParams = pair.serialize;
    } else if (t === 'column_equals') {
      const col = select([{ value: '', label: '— column —' }, ...colOptions(boardCols())]);
      const val = el('input', { placeholder: 'value (matches column text)' });
      params.appendChild(el('div', { class: 'row' }, [col, val]));
      serializeParams = () => ({ columnId: col.value, value: val.value });
    } else if (t === 'column_empty' || t === 'column_not_empty') {
      const col = select([{ value: '', label: '— column —' }, ...colOptions(boardCols())]);
      params.appendChild(col);
      serializeParams = () => ({ columnId: col.value });
    } else if (t === 'in_group') {
      const g = select([{ value: '', label: '— group —' }, ...groupOptions()]);
      params.appendChild(g);
      serializeParams = () => ({ groupId: g.value });
    } else if (t === 'subitem_checked') {
      const pair = columnLabelPair(byType(subCols(), ['status', 'color']));
      const picker = subitemNamePicker();
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

function whenControl() {
  const mode = select([
    { value: 'immediate', label: 'immediately' },
    { value: 'relative', label: 'after a delay' },
    { value: 'absolute', label: 'at a specific time' },
  ]);
  const rel = el('div', { class: 'row hidden' }, [
    el('input', { type: 'number', min: '0', value: '0', id: '_wd' }),
    el('input', { type: 'number', min: '0', value: '0', id: '_wh' }),
  ]);
  const relDays = rel.children[0];
  const relHours = rel.children[1];
  const abs = el('input', { type: 'datetime-local', class: 'hidden' });
  const sync = () => {
    rel.classList.toggle('hidden', mode.value !== 'relative');
    abs.classList.toggle('hidden', mode.value !== 'absolute');
  };
  mode.addEventListener('change', sync);
  const node = el('div', {}, [el('span', { class: 'hint', text: 'When' }), mode, rel, abs]);
  const serialize = () => {
    if (mode.value === 'relative') return { mode: 'relative', days: Number(relDays.value) || 0, hours: Number(relHours.value) || 0 };
    if (mode.value === 'absolute') return { mode: 'absolute', at: abs.value ? new Date(abs.value).toISOString() : '' };
    return { mode: 'immediate' };
  };
  return { node, serialize };
}

function makeActionRow() {
  const typeSel = select(ACTIONS.map((a) => ({ value: a.value, label: a.label })));
  const params = el('div');
  let serializeParams = () => ({});

  const render = () => {
    const t = typeSel.value;
    params.innerHTML = '';
    if (t === 'slack') {
      const when = whenControl();
      const url = el('input', { placeholder: 'webhook URL (optional — uses default)' });
      const text = el('input', { placeholder: 'message, e.g. {{item.name}} entered {{group.title}}' });
      params.append(when.node, el('label', { text: 'Webhook URL' }), url, el('label', { text: 'Text' }), text);
      serializeParams = () => {
        const a = { when: when.serialize(), text: text.value };
        if (url.value.trim()) a.webhookUrl = url.value.trim();
        return a;
      };
    } else if (t === 'email') {
      const when = whenControl();
      const to = el('input', { placeholder: 'a@x.com, b@y.com' });
      const toCol = select([{ value: '', label: '— none —' }, ...colOptions(byType(boardCols(), ['people']))]);
      const subject = el('input', { placeholder: 'subject, e.g. {{item.name}} is Done' });
      const body = el('textarea', { style: 'min-height:80px', placeholder: 'body…' });
      params.append(
        when.node,
        el('label', { text: 'To (literal addresses)' }), to,
        el('label', { text: 'To (from people column)' }), toCol,
        el('label', { text: 'Subject' }), subject,
        el('label', { text: 'Body' }), body,
      );
      serializeParams = () => {
        const a = { when: when.serialize(), subject: subject.value, body: body.value };
        const list = to.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) a.to = list;
        if (toCol.value) a.toFromColumn = toCol.value;
        return a;
      };
    } else if (t === 'clone_template_subitems') {
      const grp = el('input', { value: 'Templates', placeholder: 'Templates group title' });
      const srcCol = select([{ value: '', label: '— subitem source column —' }, ...colOptions(subCols())]);
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
    const del = el('button', { class: 'danger', text: 'delete', onclick: () => { state.ruleset.rules.splice(i, 1); syncJsonFromState(); } });
    list.appendChild(el('div', { class: 'rule-item' }, [meta, del]));
  });
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

function init() {
  $('triggerType').innerHTML = '';
  TRIGGERS.forEach((t) => $('triggerType').appendChild(el('option', { value: t.value, text: t.label })));
  $('triggerType').addEventListener('change', renderTriggerParams);
  $('scopeGroup').addEventListener('change', renderTriggerParams); // refresh subitem list per group

  $('loadBoard').addEventListener('click', loadBoard);
  $('connectBtn').addEventListener('click', connectBoard);
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
}

init();
