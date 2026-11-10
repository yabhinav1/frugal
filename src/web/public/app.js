// Browser front end for frugal. Everything from the agent is inserted with textContent, never
// as HTML: file contents and model output are untrusted and must not be able to run script here.
'use strict';

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const input = $('input');
let busy = false;
let workingEl = null;
let streamEl = null;
const toolEls = new Map();

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtUsd = (n) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(3)}`);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function append(node) {
  $('empty').hidden = true;
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  if (workingEl) chat.insertBefore(node, workingEl);
  else chat.appendChild(node);
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
  return node;
}

/** Inline formatting: **bold**, `code` and http(s) links. Everything else stays plain text. */
function inline(parent, text) {
  const re = /(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(<?(https?:\/\/[^\s<>)]+)>?)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) parent.appendChild(el('strong', '', m[2]));
    else if (m[3]) parent.appendChild(el('code', '', m[4]));
    else {
      const a = el('a', '', m[6] || m[9]);
      a.href = m[7] || m[9];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

/** Headings, lists and paragraphs outside code fences. Built from DOM nodes only, never innerHTML. */
function prose(box, text) {
  let list = null;
  let para = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /^\s*\d/.test(line);
      if (!list || (list.tagName === 'OL') !== ordered) list = box.appendChild(el(ordered ? 'ol' : 'ul'));
      inline(list.appendChild(el('li')), item[1]);
      para = null;
    } else if (heading) {
      inline(box.appendChild(el('h3')), heading[2]);
      list = para = null;
    } else if (!line.trim()) {
      list = para = null;
    } else {
      if (!para) para = box.appendChild(el('p'));
      else para.appendChild(document.createElement('br'));
      inline(para, line);
      list = null;
    }
  }
}

/** Assistant text: fenced code as <pre>, the rest as light Markdown. */
function assistantMessage(text) {
  const box = el('div', 'msg assistant');
  text.split(/```[\w-]*\n?/).forEach((part, i) => {
    if (!part.trim()) return;
    if (i % 2) box.appendChild(el('pre', '', part.replace(/\n$/, '')));
    else prose(box, part);
  });
  return box;
}

function setBusy(value) {
  busy = value;
  $('send').hidden = value;
  $('stop').hidden = !value;
  if (value && !workingEl) {
    workingEl = el('div', 'working', 'Working');
    chat.appendChild(workingEl);
    chat.scrollTop = chat.scrollHeight;
  } else if (!value && workingEl) {
    workingEl.remove();
    workingEl = null;
  }
}

function setWorking(text) {
  if (workingEl) workingEl.textContent = text;
}

// ---- sidebar ----

function showBudget(b) {
  const pct = b.limitUsd > 0 ? Math.min(100, (b.spentUsd / b.limitUsd) * 100) : 100;
  const fill = $('meter-fill');
  fill.style.width = `${pct}%`;
  fill.className = pct >= 100 ? 'full' : pct >= 75 ? 'high' : '';
  $('budget-text').textContent = `${fmtUsd(b.spentUsd)} of ${fmtUsd(b.limitUsd)}`;
  $('budget-user').textContent = `${b.user} · per ${b.period}`;
}

function showStats(s) {
  $('s-in').textContent = fmtTokens(s.tokensIn);
  $('s-out').textContent = fmtTokens(s.tokensOut);
  $('s-saved').textContent = fmtTokens(s.tokensSaved);
  $('s-calls').textContent = s.calls;
  $('s-tools').textContent = s.toolCalls;
  $('s-cost').textContent = fmtUsd(s.costUsd);
}

function showPrivacy(localOnly, confidential, sources) {
  const rule = $('rule-privacy');
  rule.textContent = confidential ? 'Confidential: local model only, web search off' : localOnly ? 'Local model only (your choice)' : 'Cloud models allowed';
  rule.className = localOnly ? 'strict' : '';
  const mode = $('mode');
  mode.hidden = !confidential;
  mode.textContent = 'CONFIDENTIAL · local only';
  mode.title = (sources || []).join(', ');
}

// ---- cards that need a human ----

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

function resolveCard(card, text) {
  card.classList.add('resolved');
  card.querySelector('.card-actions').replaceChildren(el('span', 'muted', text));
}

function approvalCard(req) {
  const titles = { read: 'Read needs approval', write: 'File change needs approval', shell: 'Shell command needs approval', git: 'Git operation needs approval' };
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  head.append(el('strong', '', titles[req.category] || 'Approval needed'), el('span', '', req.summary));
  card.appendChild(head);
  for (const w of req.warnings) card.appendChild(el('div', 'card-warn', `! ${w}`));

  const pre = el('pre');
  for (const line of req.detail.split('\n')) {
    pre.appendChild(el('span', line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : line.startsWith('@@') ? 'hunk' : '', line || ' '));
  }
  card.appendChild(pre);

  const actions = el('div', 'card-actions');
  const allow = el('button', 'primary', 'Allow');
  const deny = el('button', 'danger', 'Deny');
  const note = el('input');
  note.placeholder = 'Optional: tell the agent why not';
  note.setAttribute('aria-label', 'Reason for denying');
  const decide = async (allowIt, remember) => {
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    try {
      await post('/api/approval', { id: req.id, allow: allowIt, remember, note: note.value });
      resolveCard(card, allowIt ? (remember ? 'Allowed for the rest of this session' : 'Allowed') : 'Denied');
    } catch (err) {
      resolveCard(card, err.message);
    }
  };
  allow.onclick = () => decide(true, false);
  deny.onclick = () => decide(false, false);
  actions.append(allow);
  if (req.canRemember && req.warnings.length === 0) {
    const always = el('button', '', req.category === 'write' ? 'Allow all edits this session' : 'Always allow this command');
    always.onclick = () => decide(true, true);
    actions.append(always);
  }
  actions.append(deny, note);
  card.appendChild(actions);
  append(card);
  setWorking('Waiting for your approval');
  allow.focus();
}

function budgetCard(status, estimateUsd) {
  const card = el('div', 'card budget');
  const head = el('div', 'card-head');
  head.append(el('strong', '', 'Spending limit reached'));
  card.appendChild(head);
  card.appendChild(el('div', 'card-body', `${status.user} has spent ${fmtUsd(status.spentUsd)} of ${fmtUsd(status.limitUsd)} this ${status.period}. The next call (about ${fmtUsd(estimateUsd)}) was not sent, and the session is saved.`));
  const actions = el('div', 'card-actions');
  const local = el('button', 'primary', 'Continue on the free local model');
  const raise = el('button', '', 'Raise limit to');
  const amount = el('input');
  amount.type = 'number';
  amount.step = '0.1';
  amount.min = String(status.limitUsd);
  amount.value = String(Math.round(status.limitUsd * 2 * 100) / 100);
  amount.setAttribute('aria-label', 'New limit in US dollars');
  const stop = el('button', 'danger', 'Stop and save');
  const choose = async (body, label) => {
    try {
      await post('/api/budget', body);
      resolveCard(card, label);
    } catch (err) {
      head.append(el('span', 'card-warn', err.message));
    }
  };
  local.onclick = () => choose({ action: 'local' }, 'Continuing on the local model');
  raise.onclick = () => choose({ action: 'raise', limitUsd: Number(amount.value) }, `Limit raised to ${fmtUsd(Number(amount.value))}`);
  stop.onclick = () => choose({ action: 'stop' }, 'Stopped. The session is saved.');
  actions.append(local, raise, amount, stop);
  card.appendChild(actions);
  append(card);
  setWorking('Waiting for your decision');
}

// ---- event stream ----

function handle(e) {
  switch (e.type) {
    case 'text_delta':
      // The reply as it is being written: plain text now, formatted when complete.
      if (!streamEl) streamEl = append(el('div', 'msg assistant streaming'));
      streamEl.textContent += e.text;
      if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160) chat.scrollTop = chat.scrollHeight;
      break;
    case 'text_clear':
      if (streamEl) streamEl.remove();
      streamEl = null;
      break;
    case 'text':
      if (streamEl) {
        streamEl.replaceWith(assistantMessage(e.text));
        streamEl = null;
      } else append(assistantMessage(e.text));
      break;
    case 'tool_start': {
      const row = append(el('div', `tool ${e.category}`, e.summary));
      toolEls.set(e.id, row);
      setWorking(e.summary.slice(0, 80));
      break;
    }
    case 'tool_end': {
      const row = toolEls.get(e.id);
      const isCommand = row && (row.classList.contains('shell') || row.classList.contains('git'));
      if (row && !e.ok) row.classList.add('failed');
      if (isCommand && !/^The user denied/.test(e.preview)) {
        // What the command printed, shown right under it.
        const out = el('pre', `output${e.ok ? '' : ' failed'}`, e.preview);
        row.after(out);
      } else if (row && !e.ok) {
        row.appendChild(el('span', 'tag', e.preview.split('\n')[0].slice(0, 120)));
      }
      setWorking('Working');
      break;
    }
    case 'approval_request':
      approvalCard(e.request);
      break;
    case 'approval_result':
      setWorking('Working');
      break;
    case 'model':
      $('model').textContent = e.model;
      if (e.previous !== null || e.failedOver) {
        const text = e.previous !== null ? `Model changed: ${e.previous} → ${e.model} (${e.reason})` : `Answering model: ${e.model} (${e.reason})`;
        append(el('div', 'notice switch', text));
        $('switches').appendChild(el('li', '', `⇄ ${e.model}: ${e.reason}`));
      }
      break;
    case 'notice':
      append(el('div', `notice ${e.level === 'warn' ? 'warn' : ''}`, e.text));
      if (/local model/i.test(e.text)) refresh(false);
      break;
    case 'usage':
      showStats(e.stats);
      $('model').textContent = e.model;
      break;
    case 'budget':
      showBudget(e.status);
      break;
    case 'budget_limit':
      budgetCard(e.status, e.estimateUsd);
      break;
    case 'turn_end':
      setBusy(false);
      if (e.reason === 'error') append(el('div', 'notice error', `Error: ${e.error}`));
      if (e.reason === 'stopped') append(el('div', 'notice', 'Stopped. The session is saved; send another message to continue.'));
      if (e.reason === 'max_steps') append(el('div', 'notice warn', 'Step limit reached. Send "continue" to keep going.'));
      input.focus();
      break;
  }
}

async function refresh(withHistory) {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(res.status === 401 ? 'Not authorised. Open the link printed in your terminal.' : `Server error ${res.status}`);
  const s = await res.json();
  $('repo').textContent = s.repo;
  $('repo').title = s.root;
  $('session').textContent = `session ${s.session.id}`;
  document.title = `frugal · ${s.repo}`;
  $('chain').textContent = s.chain.length > 1 ? `order: ${s.chain.join(' → ')}` : '';
  if ($('model').textContent === '–') $('model').textContent = s.chain[0];
  showBudget(s.budget);
  showStats(s.stats);
  showPrivacy(s.localOnly, s.confidential, s.confidentialSources);
  if (!withHistory) return s;
  for (const h of s.history) {
    if (h.kind === 'user') append(el('div', 'msg user', h.text));
    else if (h.kind === 'assistant') append(assistantMessage(h.text));
    else append(el('div', `tool ${h.category || ''}`, h.text));
  }
  setBusy(s.busy);
  if (s.pendingApproval) approvalCard(s.pendingApproval);
  if (s.pendingBudget) budgetCard(s.pendingBudget.status, s.pendingBudget.estimateUsd);
  chat.scrollTop = chat.scrollHeight;
  return s;
}

function connect() {
  const source = new EventSource('/api/events');
  source.onopen = () => ($('conn').textContent = 'connected');
  source.onerror = () => ($('conn').textContent = 'reconnecting…');
  source.onmessage = (m) => handle(JSON.parse(m.data));
}

// ---- composer ----

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  input.style.height = 'auto';
  append(el('div', 'msg user', text));
  setBusy(true);
  chat.scrollTop = chat.scrollHeight;
  try {
    await post('/api/message', { text });
  } catch (err) {
    setBusy(false);
    append(el('div', 'notice error', err.message));
  }
}

$('composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  send();
});
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    send();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});
$('stop').addEventListener('click', () => post('/api/stop').catch(() => {}));

refresh(true)
  .then(connect)
  .catch((err) => {
    $('conn').textContent = 'offline';
    append(el('div', 'notice error', err.message));
  });
