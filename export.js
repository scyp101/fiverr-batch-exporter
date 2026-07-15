/* Fiverr Batch Exporter — export page logic.
 *
 * Pipeline:
 *  1. Load contacts   — paginated fetch of the full inbox contact list.
 *  2. Analyze         — fetches each selected conversation's message metadata
 *                       (attachment names + sizes come from the API, nothing is
 *                       downloaded) and caches messages for the export step.
 *  3. Export          — builds Markdown/HTML/JSON per chat, downloads selected
 *                       attachments, and packs everything into in-memory ZIPs.
 *                       When a ZIP would exceed the configured limit it is
 *                       finalized as ONE browser download and a new part starts.
 *
 * Every file is timestamp-prefixed so extracted output sorts chronologically.
 */

const MB = 1024 * 1024;

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const logEl = $('log');
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;

function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- state ----------
let contacts = [];                    // [{username, recentMessageDate, _sel, _att, analysis}]
const convCache = new Map();          // username -> messages[] (kept in memory only)
const deselectedAtt = new Set();      // attachment ids the user unchecked individually
let cancelled = false;
let running = false;
const stats = { done: 0, fail: 0, att: 0, parts: 0 };

function updateStats(currentSize) {
  $('stDone').textContent = stats.done;
  $('stFail').textContent = stats.fail;
  $('stAtt').textContent = stats.att;
  $('stParts').textContent = stats.parts;
  if (currentSize !== undefined) $('stSize').textContent = (currentSize / MB).toFixed(1) + ' MB';
}

function setProgress(i, total, label) {
  const pct = total ? Math.round((i / total) * 100) : 0;
  $('pbar').style.width = pct + '%';
  $('ptext').textContent = total ? `${i} / ${total} · ${label || ''} (${pct}%)` : '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- timestamp helpers ----------
function toMs(ts) {
  const n = Number(ts);
  if (!n || isNaN(n)) return Date.now();
  return n < 1e12 ? n * 1000 : n;   // tolerate seconds-based timestamps
}
const pad = n => String(n).padStart(2, '0');

function tsStamp(ts) {  // 2024-11-13_14-22-05
  const d = new Date(toMs(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function dateOnly(ts) { // 2024-11-13
  const d = new Date(toMs(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtTime(ts) {  // 2024-11-13 14:22:05
  const d = new Date(toMs(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sanitize(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'file';
}

function uniqueName(used, name) {
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (used.has(`${base} (${i})${ext}`)) i++;
  const out = `${base} (${i})${ext}`;
  used.add(out);
  return out;
}

function fmtSize(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes || isNaN(bytes)) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < MB) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * MB) return (bytes / MB).toFixed(1) + ' MB';
  return (bytes / (1024 * MB)).toFixed(2) + ' GB';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Fiverr API access ----------
// Primary: direct fetch from this extension page (host_permissions grant cookies).
// Fallback: run the fetch inside an open fiverr.com tab via chrome.scripting.

async function fetchViaTab(url) {
  const tabs = await chrome.tabs.query({ url: 'https://www.fiverr.com/*' });
  if (!tabs.length) throw new Error('Not authorized directly and no fiverr.com tab is open. Open fiverr.com in another tab (logged in) and retry.');
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: async (u) => {
      try {
        const r = await fetch(u, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
        if (!r.ok) return { __err: `HTTP ${r.status} ${r.statusText}` };
        return await r.json();
      } catch (e) { return { __err: e.message }; }
    },
    args: [url]
  });
  const out = res && res[0] && res[0].result;
  if (!out || out.__err) throw new Error((out && out.__err) || 'Fetch via tab failed');
  return out;
}

async function fiverrJson(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
      if (r.ok) return await r.json();
      if (r.status === 401 || r.status === 403 || r.status === 429) {
        try { return await fetchViaTab(url); } catch (e) { /* also blocked — cool down */ }
        if (attempt < retries) { await cancellableSleep(12000 * (attempt + 1)); continue; }
      }
      throw new Error(`HTTP ${r.status} ${r.statusText}`);
    } catch (e) {
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      return await fetchViaTab(url);   // last resort
    }
  }
}

// Fetch a fiverr.com page as text through an open fiverr tab (real page context —
// often passes bot checks that block extension-context requests).
async function fetchTextViaTab(url) {
  const tabs = await chrome.tabs.query({ url: 'https://www.fiverr.com/*' });
  if (!tabs.length) throw new Error('no fiverr.com tab open');
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return { __err: `HTTP ${r.status} ${r.statusText}` };
        return { __text: await r.text() };
      } catch (err) { return { __err: err.message }; }
    },
    args: [url]
  });
  const out = res && res[0] && res[0].result;
  if (!out || out.__err) throw new Error((out && out.__err) || 'fetch via tab failed');
  return out.__text;
}

// Fetch a fiverr.com page as text (order pages). Fiverr's bot protection answers
// bursts of page loads with HTTP 403 for ~30-60s, so 403/429 get long cooldowns
// (with a via-tab attempt first) instead of fast retries.
async function fiverrText(url, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    if (cancelled) throw new Error('cancelled');
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (r.ok) return await r.text();
      if (r.status === 403 || r.status === 429) {
        try { return await fetchTextViaTab(url); } catch (e) { /* also blocked — cool down */ }
        if (attempt < retries) { await cancellableSleep(15000 * (attempt + 1)); continue; }
      }
      throw new Error(`HTTP ${r.status} ${r.statusText}`);
    } catch (e) {
      if (e.message === 'cancelled') throw e;
      if (attempt < retries) { await cancellableSleep(2000 * (attempt + 1)); continue; }
      try { return await fetchTextViaTab(url); } catch (e2) { throw e; }
    }
  }
}

async function cancellableSleep(ms) {
  const step = 500;
  for (let t = 0; t < ms; t += step) {
    if (cancelled) throw new Error('cancelled');
    await sleep(Math.min(step, ms - t));
  }
}

async function fetchAttachmentBlob(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (r.status === 429) { await sleep(5000 * (attempt + 1)); if (attempt < retries) continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.blob();
    } catch (e) {
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

// ---------- conversation fetching ----------
const convMeta = new Map();   // username -> first-page response root (minus messages)

async function fetchConversation(username) {
  if (convCache.has(username)) return convCache.get(username);
  let all = [];
  let lastPage = false;
  let timestamp = null;
  let guard = 0;
  let meta = null;
  while (!lastPage && guard++ < 500) {
    if (cancelled) throw new Error('cancelled');
    const url = timestamp
      ? `https://www.fiverr.com/inbox/contacts/${encodeURIComponent(username)}/conversation?timestamp=${timestamp}`
      : `https://www.fiverr.com/inbox/contacts/${encodeURIComponent(username)}/conversation`;
    const data = await fiverrJson(url);
    if (!meta) { meta = { ...data }; delete meta.messages; }
    const msgs = data.messages || [];
    all = all.concat(msgs);
    lastPage = !!data.lastPage || msgs.length === 0;
    if (!lastPage) timestamp = Math.min(...msgs.map(m => Number(m.createdAt)));
    await sleep(600);
  }
  all.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  convCache.set(username, all);
  convMeta.set(username, meta || {});
  return all;
}

// ---------- AI-assistant labelling ----------
// Fiverr flags assistant-sent messages with senderData.isPersonalAssistant
// while keeping message.sender as the seller's username, so transcripts
// misattribute them. We relabel those messages. The assistant's display name
// is auto-detected from the conversation metadata when Fiverr provides it,
// else taken from the "AI assistant" options field.
function isAssistantMsg(m) {
  return !!(m && m.senderData && m.senderData.isPersonalAssistant);
}

function findAssistantName(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/assistant/i.test(k) && !/^is/i.test(k)) {
      if (typeof v === 'string' && v.trim() && v.trim().length <= 40) return v.trim();
      if (v && typeof v === 'object') {
        const n = v.name || v.displayName || v.assistantName;
        if (typeof n === 'string' && n.trim()) return n.trim();
      }
    }
    if (v && typeof v === 'object') {
      const r = findAssistantName(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function assistantLabelFor(username) {
  const detected = findAssistantName(convMeta.get(username));
  const manual = $('asstName').value.trim();
  const name = detected || manual || 'Assistant';
  return `${name} (AI)`;
}

// Applies the "include AI assistant replies" toggle.
function filterAsst(messages) {
  return $('inclAsst').checked ? messages : messages.filter(m => !isAssistantMsg(m));
}

// Walks a conversation's messages and produces the attachment manifest:
// stable ids (username::seq in message order) plus the timestamped zip name.
function indexAttachments(username, messages) {
  const used = new Set();
  const atts = [];
  let seq = 0;
  for (const m of messages) {
    for (const a of (m.attachments || [])) {
      const url = a.download_url || a.downloadUrl;
      const orig = a.file_name || a.filename || (url ? (url.split('/').pop() || 'file').split('?')[0] : 'file');
      const ts = a.created_at || m.createdAt;
      atts.push({
        id: `${username}::${seq++}`,
        att: a,
        url,
        name: orig,
        ts,
        size: Number(a.file_size || a.fileSize) || 0,
        zipName: uniqueName(used, `${tsStamp(ts)}_${sanitize(orig)}`)
      });
    }
  }
  return atts;
}

function attIncluded(contact, entry) {
  return contact._att !== false && !deselectedAtt.has(entry.id) && !!entry.url;
}

// ---------- contacts ----------
async function fetchAllContacts() {
  if (running) return;
  cancelled = false;
  const btn = $('btnFetchContacts');
  btn.disabled = true;
  $('contactStatus').textContent = 'Fetching contacts…';
  $('contactStatus').classList.remove('err');
  try {
    const seen = new Map();
    let olderThan = null;
    let batch = 1;
    while (batch < 500) {
      const url = olderThan
        ? `https://www.fiverr.com/inbox/contacts?older_than=${olderThan}`
        : 'https://www.fiverr.com/inbox/contacts';
      const list = await fiverrJson(url);
      if (!Array.isArray(list) || list.length === 0) break;
      for (const c of list) if (c && c.username && !seen.has(c.username)) seen.set(c.username, c);
      const nextOlderThan = Math.min(...list.map(c => Number(c.recentMessageDate) || Date.now()));
      if (nextOlderThan === olderThan) break;   // API returned the same page — stop
      olderThan = nextOlderThan;
      $('contactStatus').textContent = `Batch ${batch}: ${seen.size} contacts so far…`;
      batch++;
      await sleep(500);
    }
    contacts = [...seen.values()].sort((a, b) => (b.recentMessageDate || 0) - (a.recentMessageDate || 0));
    contacts.forEach(c => { c._sel = true; c._att = true; });
    persistContacts();
    renderContacts();
    $('contactStatus').textContent = `Done — ${contacts.length} contacts loaded.`;
  } catch (e) {
    $('contactStatus').textContent = 'Error: ' + e.message;
    $('contactStatus').classList.add('err');
  } finally {
    btn.disabled = false;
  }
}

function persistContacts() {
  // persist the list + analysis summaries (small) — never the message cache
  try {
    const slim = contacts.map(c => ({
      username: c.username,
      recentMessageDate: c.recentMessageDate,
      _sel: c._sel, _att: c._att,
      analysis: c.analysis ? {
        msgCount: c.analysis.msgCount,
        lastTs: c.analysis.lastTs,
        textSizes: c.analysis.textSizes,
        atts: c.analysis.atts.map(a => ({ id: a.id, name: a.name, ts: a.ts, size: a.size, zipName: a.zipName, hasUrl: !!a.url }))
      } : undefined
    }));
    chrome.storage.local.set({ batchExportContacts: slim, batchExportDeselected: [...deselectedAtt] });
  } catch (e) { /* storage quota — non-fatal */ }
}

// ---------- contact table ----------
let sortState = { key: 'date', dir: 'desc' };

function sortVal(c, key) {
  switch (key) {
    case 'name': return c.username.toLowerCase();
    case 'date': return Number(c.recentMessageDate) || 0;
    case 'msgs': return c.analysis ? c.analysis.msgCount : -1;      // unanalyzed sink below
    case 'attsize': return c.analysis ? c.analysis.atts.reduce((s, a) => s + a.size, 0) : -1;
    default: return 0;
  }
}

function applySort() {
  const { key, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;
  contacts.sort((a, b) => {
    const va = sortVal(a, key), vb = sortVal(b, key);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return a.username.localeCompare(b.username);   // stable tiebreak
  });
  document.querySelectorAll('#theadMessages .sortable').forEach(el => {
    el.classList.toggle('asc', el.dataset.key === key && dir === 'asc');
    el.classList.toggle('desc', el.dataset.key === key && dir === 'desc');
  });
}

function renderContacts() {
  applySort();
  const tbody = $('tbody');
  tbody.innerHTML = '';
  const filter = $('filter').value.trim().toLowerCase();

  for (const c of contacts) {
    if (filter && !c.username.toLowerCase().includes(filter)) continue;
    const an = c.analysis;

    const row = document.createElement('div');
    row.className = 'trow';

    // select checkbox
    const selWrap = document.createElement('span');
    const sel = document.createElement('input');
    sel.type = 'checkbox';
    sel.checked = c._sel !== false;
    sel.title = 'Include this chat in the export';
    sel.addEventListener('change', () => { c._sel = sel.checked; refreshSummary(); persistContacts(); });
    selWrap.appendChild(sel);

    // username + msg count
    const userCell = document.createElement('span');
    userCell.className = 'cell-user';
    userCell.innerHTML = `<div class="uname"></div>`;
    userCell.querySelector('.uname').textContent = c.username;

    // last activity
    const dateCell = document.createElement('span');
    dateCell.className = 'num col-hide';
    dateCell.textContent = c.recentMessageDate ? fmtTime(c.recentMessageDate) : '';

    // messages
    const msgCell = document.createElement('span');
    msgCell.className = 'num' + (an ? ' has' : '');
    msgCell.textContent = an ? an.msgCount : '—';

    // attachments count + size
    const attCell = document.createElement('span');
    attCell.className = 'attsize';
    if (an) {
      const total = an.atts.reduce((s, a) => s + a.size, 0);
      attCell.innerHTML = an.atts.length
        ? `<span class="n">${an.atts.length} ×</span> ${fmtSize(total)}`
        : '<span class="n">none</span>';
    } else {
      attCell.innerHTML = '<span class="n">analyze first</span>';
    }

    // include-attachments toggle
    const togWrap = document.createElement('span');
    togWrap.className = 'col-hide';
    const tog = document.createElement('input');
    tog.type = 'checkbox';
    tog.checked = c._att !== false;
    tog.disabled = !!an && an.atts.length === 0;
    tog.title = 'Download this chat\'s attachments';
    tog.addEventListener('change', () => { c._att = tog.checked; refreshSummary(); renderAttList(c, attListEl); persistContacts(); });
    togWrap.appendChild(tog);

    // expander
    const exp = document.createElement('button');
    exp.className = 'expander';
    exp.textContent = '▶';
    exp.setAttribute('aria-label', 'Show attachments');
    exp.disabled = !an || an.atts.length === 0;

    const attListEl = document.createElement('div');
    attListEl.className = 'attlist';

    exp.addEventListener('click', () => {
      const open = attListEl.classList.toggle('open');
      exp.classList.toggle('open', open);
      if (open) renderAttList(c, attListEl);
    });

    row.append(selWrap, userCell, dateCell, msgCell, attCell, togWrap, exp);
    tbody.append(row, attListEl);
  }

  $('tableWrap').style.display = 'block';
  $('tableTools').style.display = 'flex';
  $('btnAnalyze').disabled = contacts.length === 0;
  updateExportButton();
  refreshSummary();
}

function renderAttList(c, el) {
  el.innerHTML = '';
  if (!c.analysis) return;
  for (const a of c.analysis.atts) {
    const item = document.createElement('label');
    item.className = 'attitem' + (attIncluded(c, a) ? '' : ' off');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !deselectedAtt.has(a.id);
    cb.disabled = c._att === false || !a.url;
    cb.addEventListener('change', () => {
      if (cb.checked) deselectedAtt.delete(a.id); else deselectedAtt.add(a.id);
      item.classList.toggle('off', !attIncluded(c, a));
      refreshSummary();
      persistContacts();
    });
    const name = document.createElement('span');
    name.className = 'aname';
    name.textContent = a.zipName + (a.url ? '' : '  (no download URL)');
    name.title = a.name;
    const size = document.createElement('span');
    size.className = 'asize';
    size.textContent = fmtSize(a.size);
    item.append(cb, name, size);
    el.appendChild(item);
  }
}

function refreshSummary() {
  const selected = contacts.filter(c => c._sel !== false);
  $('selCount').textContent = `${selected.length} / ${contacts.length} selected`;

  const analyzed = selected.filter(c => c.analysis);
  if (!analyzed.length) { $('tiles').style.display = 'none'; $('tilesNote').style.display = 'none'; return; }

  const fmts = { md: $('fmtMd').checked, html: $('fmtHtml').checked, json: $('fmtJson').checked };
  let msgs = 0, attCount = 0, attSize = 0, textSize = 0;
  for (const c of analyzed) {
    msgs += c.analysis.msgCount;
    for (const a of c.analysis.atts) {
      if (attIncluded(c, a)) { attCount++; attSize += a.size; }
    }
    const t = c.analysis.textSizes || {};
    if (fmts.md) textSize += t.md || 0;
    if (fmts.html) textSize += t.html || 0;
    if (fmts.json) textSize += t.json || 0;
  }
  const total = attSize + textSize;
  const limit = Math.max(10, Number($('maxMB').value) || 500) * MB;
  const parts = Math.max(1, Math.ceil(total / limit));

  $('tChats').textContent = `${analyzed.length}`;
  $('tMsgs').textContent = msgs.toLocaleString();
  $('tAtts').textContent = attCount.toLocaleString();
  $('tAttSize').textContent = fmtSize(attSize);
  $('tTotal').textContent = fmtSize(total);
  $('tTotalParts').textContent = `~${parts} ZIP part${parts > 1 ? 's' : ''}`;
  $('tiles').style.display = 'grid';

  const unAnalyzed = selected.length - analyzed.length;
  const note = $('tilesNote');
  if (unAnalyzed > 0) {
    note.textContent = `${unAnalyzed} selected chat${unAnalyzed > 1 ? 's are' : ' is'} not analyzed yet — actual size will be larger. Text-format sizes are pre-compression estimates.`;
    note.style.display = 'block';
  } else {
    note.textContent = 'Text-format sizes are pre-compression estimates; the final ZIPs are usually a little smaller.';
    note.style.display = 'block';
  }
}

// ---------- analyze (messages) ----------
async function runAnalyze() {
  if (running) return;
  const selected = contacts.filter(c => c._sel !== false);
  if (!selected.length) return;

  running = true;
  cancelled = false;
  $('btnAnalyze').disabled = true;
  $('btnExport').disabled = true;
  $('btnFetchContacts').disabled = true;
  $('btnCancel').style.display = 'inline-block';
  log(`Analyzing ${selected.length} conversations (metadata only — no files are downloaded)…`);

  let done = 0, failed = 0;
  for (let i = 0; i < selected.length; i++) {
    if (cancelled) { log('Analysis cancelled.', 'log-warn'); break; }
    const c = selected[i];
    setProgress(i, selected.length, `analyzing ${c.username}`);
    if (c.analysis && convCache.has(c.username)) { done++; continue; }  // already analyzed this session
    try {
      const messages = await fetchConversation(c.username);
      const atts = indexAttachments(c.username, messages);
      const lastTs = messages.length ? messages[messages.length - 1].createdAt : (c.recentMessageDate || Date.now());

      // measure text formats so the estimate reflects the chosen formats
      const attStates = new Map(atts.map(a => [a.id, { zipName: a.zipName, included: true }]));
      const asstLabel = assistantLabelFor(c.username);
      const md = buildMarkdown(c.username, messages, atts, attStates, asstLabel);
      const html = buildHtml(c.username, messages, atts, attStates, asstLabel);
      const json = JSON.stringify({ username: c.username, messages: filterAsst(messages) }, null, 2);

      c.analysis = {
        msgCount: messages.length,
        lastTs,
        atts,
        textSizes: { md: new Blob([md]).size, html: new Blob([html]).size, json: json.length }
      };
      done++;
      const attSize = atts.reduce((s, a) => s + a.size, 0);
      log(`· ${c.username} — ${messages.length} msgs, ${atts.length} attachments (${fmtSize(attSize)})`);
    } catch (e) {
      if (e.message === 'cancelled') { log('Analysis cancelled.', 'log-warn'); break; }
      failed++;
      log(`✘ analyze failed: ${c.username} — ${e.message}`, 'log-err');
    }
    await sleep(300);
  }

  setProgress(selected.length, selected.length, 'analysis complete');
  log(`Analysis finished: ${done} analyzed, ${failed} failed.`, failed ? 'log-warn' : 'log-ok');
  persistContacts();
  renderContacts();

  running = false;
  $('btnAnalyze').disabled = false;
  $('btnExport').disabled = false;
  $('btnFetchContacts').disabled = false;
  $('btnCancel').style.display = 'none';
}

// ---------- markdown ----------
function buildMarkdown(username, messages, atts, attStates, asstLabel) {
  const byAtt = new Map(atts.map(a => [a.att, a]));
  const senderOf = m => isAssistantMsg(m) ? (asstLabel || 'Assistant (AI)') : (m.sender || 'Unknown');
  const visible = filterAsst(messages);
  const excluded = messages.length - visible.length;
  let md = `# Conversation with ${username}\n\n`;
  md += `- Messages: ${visible.length}\n`;
  if (visible.length) {
    md += `- First message: ${fmtTime(visible[0].createdAt)}\n`;
    md += `- Last message: ${fmtTime(visible[visible.length - 1].createdAt)}\n`;
  }
  if (excluded > 0) md += `- Omitted ${excluded} automated repl${excluded > 1 ? 'ies' : 'y'} from ${asstLabel || 'the AI assistant'}\n`;
  else if (asstLabel && visible.some(isAssistantMsg)) md += `- Includes automated replies sent by ${asstLabel}\n`;
  md += `- Exported: ${fmtTime(Date.now())}\n\n---\n\n`;

  for (const m of visible) {
    md += `### ${senderOf(m)} — ${fmtTime(m.createdAt)}\n\n`;

    if (m.repliedToMessage) {
      const r = m.repliedToMessage;
      md += `> Replying to ${r.sender || '?'} (${fmtTime(r.createdAt)}):\n`;
      md += `> ${String(r.body || '').replace(/\n/g, '\n> ')}\n\n`;
    }

    if (m.body) md += `${m.body}\n`;

    const msgAtts = m.attachments || [];
    if (msgAtts.length) {
      md += `\n**Attachments:**\n\n`;
      for (const raw of msgAtts) {
        const entry = byAtt.get(raw);
        const state = entry ? attStates.get(entry.id) : null;
        const sizeStr = fmtSize(entry ? entry.size : 0);
        if (entry && state && state.included && !state.error) {
          md += `- [${entry.name}](attachments/${entry.zipName.replace(/ /g, '%20')}) (${sizeStr})\n`;
        } else if (entry && state && state.error) {
          md += `- ${entry.name} (${sizeStr}) — ⚠️ download failed: ${state.error}\n`;
        } else {
          md += `- ${entry ? entry.name : 'unnamed-file'} (${sizeStr}) — not downloaded\n`;
        }
      }
    }
    md += `\n---\n\n`;
  }
  return md;
}

// ---------- html ----------
function buildHtml(username, messages, atts, attStates, asstLabel) {
  const byAtt = new Map(atts.map(a => [a.att, a]));
  const senderOf = m => isAssistantMsg(m) ? (asstLabel || 'Assistant (AI)') : (m.sender || 'Unknown');
  const visible = filterAsst(messages);
  let body = '';
  let currentDate = null;
  const excluded = messages.length - visible.length;
  if (excluded > 0) body += `<p class="omitted">${excluded} automated repl${excluded > 1 ? 'ies' : 'y'} from ${escapeHtml(asstLabel || 'the AI assistant')} omitted.</p>\n`;

  for (const m of visible) {
    const dayStr = new Date(toMs(m.createdAt)).toDateString();
    if (dayStr !== currentDate) {
      body += `<div class="day"><span>${escapeHtml(dayStr)}</span></div>\n`;
      currentDate = dayStr;
    }
    const side = m.sender === username ? 'them' : 'me';
    body += `<div class="msg ${side}${isAssistantMsg(m) ? ' ai' : ''}"><div class="meta"><b>${escapeHtml(senderOf(m))}</b><time>${fmtTime(m.createdAt)}</time></div>`;
    if (m.repliedToMessage) {
      const r = m.repliedToMessage;
      body += `<div class="reply"><b>${escapeHtml(r.sender || '?')} · ${fmtTime(r.createdAt)}</b><div>${escapeHtml(r.body || '')}</div></div>`;
    }
    if (m.body) body += `<div class="text">${escapeHtml(m.body)}</div>`;
    const msgAtts = m.attachments || [];
    if (msgAtts.length) {
      body += `<div class="atts">`;
      for (const raw of msgAtts) {
        const entry = byAtt.get(raw);
        const state = entry ? attStates.get(entry.id) : null;
        const label = `${escapeHtml(entry ? entry.name : 'unnamed-file')} <small>(${fmtSize(entry ? entry.size : 0)})</small>`;
        if (entry && state && state.included && !state.error) {
          body += `<a class="att" href="attachments/${encodeURIComponent(entry.zipName)}">📎 ${label}</a>`;
        } else {
          const why = state && state.error ? ` — download failed: ${escapeHtml(state.error)}` : ' — not downloaded';
          body += `<span class="att off">📎 ${label}${why}</span>`;
        }
      }
      body += `</div>`;
    }
    body += `</div>\n`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation with ${escapeHtml(username)}</title>
<style>
  body { font-family: "Segoe UI", -apple-system, sans-serif; background: #f2f4f7; color: #222; max-width: 780px; margin: 0 auto; padding: 24px 16px 60px; line-height: 1.5; }
  h1 { font-size: 20px; color: #159957; border-bottom: 2px solid #e3e7ec; padding-bottom: 10px; }
  .day { text-align: center; margin: 26px 0 14px; color: #98a2ad; font-size: 12px; }
  .day span { background: #f2f4f7; padding: 0 12px; position: relative; }
  .msg { background: #fff; border: 1px solid #e3e7ec; border-radius: 10px; padding: 12px 14px; margin: 10px 0; max-width: 82%; box-shadow: 0 1px 2px rgba(20,30,40,.05); }
  .msg.me { margin-left: auto; background: #e9f8f0; border-color: #cfeede; }
  .msg.ai { border-style: dashed; background: #f3f9f6; }
  .omitted { text-align: center; color: #98a2ad; font-size: 12.5px; font-style: italic; }
  .meta { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; color: #8a94a0; margin-bottom: 4px; }
  .meta b { color: #2b6cb0; font-weight: 600; }
  .msg.me .meta b { color: #159957; }
  .text { white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .reply { border-left: 3px solid #b9c3cd; background: #f5f7f9; padding: 6px 10px; margin-bottom: 8px; border-radius: 0 6px 6px 0; font-size: 12.5px; color: #66707a; }
  .reply b { display: block; font-size: 11px; margin-bottom: 2px; }
  .atts { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .att { font-size: 13px; color: #2b6cb0; text-decoration: none; }
  .att:hover { text-decoration: underline; }
  .att.off { color: #98a2ad; }
  .att small { color: #98a2ad; }
</style>
</head>
<body>
<h1>Conversation with ${escapeHtml(username)}</h1>
${body}
</body>
</html>`;
}

// ---------- zip batching ----------
class ZipBatcher {
  constructor(limitBytes, baseName) {
    this.limit = limitBytes;
    this.baseName = baseName;
    this.partNo = 0;
    this._reset();
  }
  _reset() {
    this.zip = new JSZip();
    this.size = 0;
    this.count = 0;
  }
  async add(path, content, opts = {}) {
    const size = opts.size ?? (content.size ?? content.length ?? 0);
    if (this.count > 0 && this.size + size > this.limit) {
      await this.flush();
    }
    this.zip.file(path, content, {
      compression: opts.compress ? 'DEFLATE' : 'STORE',
      date: opts.date || new Date()
    });
    this.size += size;
    this.count++;
    updateStats(this.size);
  }
  async flush() {
    if (this.count === 0) return;
    this.partNo++;
    const partName = `${this.baseName}-part${String(this.partNo).padStart(2, '0')}.zip`;
    log(`Packing ${partName} (${(this.size / MB).toFixed(1)} MB raw, ${this.count} files)…`);
    const blob = await this.zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename: partName, conflictAction: 'uniquify' }, id => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    stats.parts++;
    log(`Saved ${partName} (${(blob.size / MB).toFixed(1)} MB)`, 'log-ok');
    this._reset();
    updateStats(0);
  }
}

// ---------- main export (messages) ----------
async function runExport() {
  if (running) return;
  const selected = contacts.filter(c => c._sel !== false);
  if (!selected.length) return;

  const fmts = { md: $('fmtMd').checked, html: $('fmtHtml').checked, json: $('fmtJson').checked };
  if (!fmts.md && !fmts.html && !fmts.json) {
    log('Select at least one format (Markdown, HTML or JSON) before exporting.', 'log-err');
    return;
  }

  running = true;
  cancelled = false;
  stats.done = 0; stats.fail = 0; stats.att = 0; stats.parts = 0;
  updateStats(0);
  $('btnExport').disabled = true;
  $('btnAnalyze').disabled = true;
  $('btnFetchContacts').disabled = true;
  $('btnCancel').style.display = 'inline-block';

  const limitMB = Math.max(10, Number($('maxMB').value) || 500);
  const exportStamp = tsStamp(Date.now());
  const batcher = new ZipBatcher(limitMB * MB, `fiverr-export-${exportStamp}`);
  const report = { started: fmtTime(Date.now()), total: selected.length, formats: fmts, ok: [], failed: [], attachmentsFailed: [], attachmentsSkipped: 0 };

  log(`Starting export of ${selected.length} conversations (parts capped at ${limitMB} MB)…`);

  for (let i = 0; i < selected.length; i++) {
    if (cancelled) { log('Cancelled — saving what has been collected so far.', 'log-warn'); break; }
    const c = selected[i];
    setProgress(i, selected.length, c.username);
    try {
      const messages = await fetchConversation(c.username);
      const atts = (c.analysis && convCache.has(c.username)) ? c.analysis.atts : indexAttachments(c.username, messages);
      const lastTs = messages.length ? messages[messages.length - 1].createdAt : (c.recentMessageDate || Date.now());
      const folder = `${dateOnly(lastTs)}_${sanitize(c.username)}`;
      const attStates = new Map();
      let attCount = 0;

      for (const entry of atts) {
        if (cancelled) break;
        if (!attIncluded(c, entry)) {
          attStates.set(entry.id, { zipName: entry.zipName, included: false });
          report.attachmentsSkipped++;
          continue;
        }
        try {
          const blob = await fetchAttachmentBlob(entry.url);
          await batcher.add(`${folder}/attachments/${entry.zipName}`, blob, { size: blob.size, date: new Date(toMs(entry.ts)) });
          attStates.set(entry.id, { zipName: entry.zipName, included: true });
          attCount++;
          stats.att++;
        } catch (e) {
          attStates.set(entry.id, { zipName: entry.zipName, included: true, error: e.message });
          report.attachmentsFailed.push({ username: c.username, file: entry.name, url: entry.url, error: e.message });
          log(`  ⚠ attachment failed (${c.username} / ${entry.name}): ${e.message}`, 'log-warn');
        }
      }

      const base = `${dateOnly(lastTs)}_${sanitize(c.username)}`;
      const asstLabel = assistantLabelFor(c.username);
      if (fmts.md) {
        const md = buildMarkdown(c.username, messages, atts, attStates, asstLabel);
        await batcher.add(`${folder}/${base}.md`, md, { size: new Blob([md]).size, compress: true, date: new Date(toMs(lastTs)) });
      }
      if (fmts.html) {
        const html = buildHtml(c.username, messages, atts, attStates, asstLabel);
        await batcher.add(`${folder}/${base}.html`, html, { size: new Blob([html]).size, compress: true, date: new Date(toMs(lastTs)) });
      }
      if (fmts.json) {
        const json = JSON.stringify({ username: c.username, messages: filterAsst(messages) }, null, 2);
        await batcher.add(`${folder}/${base}.json`, json, { size: json.length, compress: true, date: new Date(toMs(lastTs)) });
      }

      stats.done++;
      report.ok.push(c.username);
      log(`✔ ${c.username} — ${messages.length} messages, ${attCount} attachments`, 'log-ok');
    } catch (e) {
      if (e.message === 'cancelled') { log('Cancelled — saving what has been collected so far.', 'log-warn'); break; }
      stats.fail++;
      report.failed.push({ username: c.username, error: e.message });
      log(`✘ ${c.username} — ${e.message}`, 'log-err');
    }
    updateStats(batcher.size);
    await sleep(400);
  }

  report.finished = fmtTime(Date.now());
  try {
    const rep = JSON.stringify(report, null, 2);
    await batcher.add(`_export-report.json`, rep, { size: rep.length, compress: true });
    await batcher.flush();
  } catch (e) {
    log(`Error saving final ZIP: ${e.message}`, 'log-err');
  }

  setProgress(selected.length, selected.length, 'finished');
  log(`Export finished. ${stats.done} ok, ${stats.fail} failed, ${stats.att} attachments, ${stats.parts} ZIP part(s). Details in _export-report.json inside the last ZIP.`, 'log-ok');

  running = false;
  $('btnExport').disabled = false;
  $('btnAnalyze').disabled = false;
  $('btnFetchContacts').disabled = false;
  $('btnCancel').style.display = 'none';
}

/* ==================================================================
 *                            ORDERS
 * ================================================================== */

let orders = [];                 // [{orderId, buyer, title, total, currency, dateMs, status, _sel, _att, analysis}]
const orderCache = new Map();    // orderId -> { page, details }  (session only)
let orderSort = { key: 'date', dir: 'desc' };

// ---------- orders list ----------
async function fetchOrdersPage(filter, cursor) {
  const input = { '0': cursor ? { filter, cursor: { cursor } } : { filter } };
  const url = `https://www.fiverr.com/manage_orders/api/fetchOrders?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
  const j = await fiverrJson(url);
  const data = j && j[0] && j[0].result && j[0].result.data;
  if (!data) throw new Error('Unexpected fetchOrders response shape');
  return data;
}

async function fetchAllOrders() {
  if (running) return;
  cancelled = false;
  const btn = $('btnFetchOrders');
  const filter = $('orderFilter').value;
  btn.disabled = true;
  $('orderStatus').textContent = `Fetching "${filter}" orders…`;
  $('orderStatus').classList.remove('err');
  try {
    const seen = new Map(orders.map(o => [o.orderId, o]));
    let cursor = null;
    let batch = 1;
    let added = 0;
    while (batch < 500) {
      const data = await fetchOrdersPage(filter, cursor);
      const results = data.results || [];
      if (!results.length) break;
      for (const r of results) {
        if (!r || !r.order_id || seen.has(r.order_id)) continue;
        seen.set(r.order_id, {
          orderId: r.order_id,
          buyer: r.username || 'unknown',
          title: r.title || '',
          total: Number(r.total) || 0,
          currency: r.currency_code || 'USD',
          dateMs: Number(r.due_date_ms) || 0,
          deliveredAt: r.delivered_at || '',
          status: r.status_text || r.status || '',
          _sel: true, _att: true
        });
        added++;
      }
      const next = data.nextPageParams && data.nextPageParams.cursor;
      if (!next || next === cursor) break;
      cursor = next;
      $('orderStatus').textContent = `Batch ${batch}: ${seen.size} orders so far…`;
      batch++;
      await sleep(500);
    }
    orders = [...seen.values()];
    persistOrders();
    renderOrders();
    $('orderStatus').textContent = `Done — ${added} new "${filter}" orders (${orders.length} total in list).`;
  } catch (e) {
    $('orderStatus').textContent = 'Error: ' + e.message;
    $('orderStatus').classList.add('err');
  } finally {
    btn.disabled = false;
  }
}

function persistOrders() {
  try {
    const slim = orders.map(o => ({
      ...o,
      analysis: o.analysis ? {
        earned: o.analysis.earned,
        activityCount: o.analysis.activityCount,
        completedTs: o.analysis.completedTs,
        textSizes: o.analysis.textSizes,
        files: o.analysis.files.map(f => ({ id: f.id, name: f.name, ts: f.ts, size: f.size, zipName: f.zipName, source: f.source, hasUrl: !!f.url }))
      } : undefined
    }));
    chrome.storage.local.set({ batchExportOrders: slim, batchExportDeselected: [...deselectedAtt] });
  } catch (e) { /* non-fatal */ }
}

// ---------- order page parsing ----------
async function fetchOrderData(orderId) {
  if (orderCache.has(orderId)) return orderCache.get(orderId);
  const html = await fiverrText(`https://www.fiverr.com/orders/${encodeURIComponent(orderId)}/activities`);
  const m = html.match(/<script type="application\/json" id="perseus-initial-props">\s*([\s\S]*?)\s*<\/script>/);
  if (!m) throw new Error('Order data not found in page (are you logged in?)');
  const page = JSON.parse(m[1]);
  let details = null;
  try {
    details = await fiverrJson(`https://www.fiverr.com/orders/${encodeURIComponent(orderId)}/ajax/fetch_order_details`);
  } catch (e) { /* some order types have no details endpoint — non-fatal */ }
  const data = { page, details };
  orderCache.set(orderId, data);
  return data;
}

// Collect every downloadable file in an order: delivery files plus any
// activity attachments (revision-request references, requirement uploads, …).
// Timestamps on order pages are in seconds; toMs() normalizes.
function indexOrderFiles(orderId, page) {
  const used = new Set();
  const seenFileIds = new Set();
  const files = [];
  let seq = 0;
  const push = (f, ts, source) => {
    if (!f || !f.downloadUrl) return;
    if (f.id) { if (seenFileIds.has(f.id)) return; seenFileIds.add(f.id); }
    const name = f.fileName || f.file_name || 'file';
    files.push({
      id: `${orderId}::${seq++}`,
      fileId: f.id || null,
      url: f.downloadUrl,
      name,
      ts,
      size: Number(f.fileSize || f.file_size) || 0,
      source,
      zipName: uniqueName(used, `${tsStamp(ts)}_${sanitize(name)}`)
    });
  };
  for (const d of (page.deliveries || [])) {
    for (const f of (d.files || [])) push(f, d.deliveredAt, `delivery #${d.serialNumber || '?'}`);
  }
  for (const a of (page.activities || [])) {
    for (const f of (a.attachments || [])) push(f, a.occurredAt, a.type || 'activity');
    for (const f of (a.files || [])) push(f, a.occurredAt, a.type || 'activity');
  }
  return files;
}

function orderMoney(amount, currency) {
  if (amount === null || amount === undefined || isNaN(Number(amount))) return '—';
  return `${Number(amount).toFixed(2)} ${currency || 'USD'}`;
}

function orderFolderTs(o) {
  return (o.analysis && o.analysis.completedTs) ? toMs(o.analysis.completedTs) : (o.dateMs || Date.now());
}

// ---------- order transcript builders ----------
function describeActivity(a, page, fileStates, filesByFileId, linkFn) {
  const lines = [];
  const t = a.type || 'event';
  const renderFiles = (list) => {
    for (const f of (list || [])) {
      const key = f.id && filesByFileId.get(f.id);
      lines.push(linkFn(key, f));
    }
  };
  switch (t) {
    case 'order_placed': lines.push('**Order placed.**'); break;
    case 'order_started': lines.push('**Order started.**'); break;
    case 'order_completed': lines.push('**Order completed.**'); break;
    case 'resolution_accepted': lines.push('**Resolution accepted.**'); break;
    case 'order_cancelled': lines.push('**Order cancelled.**'); break;
    case 'due_date_updated': lines.push(`**Due date updated** → ${fmtTime(a.dueDate)}`); break;
    case 'delivery_received': {
      const d = (page.deliveries || []).find(x => x.id === a.entityId);
      lines.push(`**Delivery #${d ? (d.serialNumber || '?') : '?'}**`);
      if (d && d.body) lines.push(d.body);
      if (d) renderFiles(d.files);
      break;
    }
    case 'revision_requested':
      lines.push('**Revision requested**');
      if (a.body) lines.push(a.body);
      renderFiles(a.attachments);
      break;
    case 'order_rated_by_buyer': {
      lines.push(`**Buyer review — ${a.totalRating != null ? a.totalRating / 2 : '?'} / 5**`);
      for (const v of (a.valuations || [])) {
        const chips = (v.chips || []).map(ch => ch.translation || ch.key || ch).join(', ');
        lines.push(`- ${v.questionKey}: ${v.value}/5${chips ? ` — tags: ${chips}` : ''}`);
      }
      if (a.comment) lines.push(`> ${String(a.comment).replace(/\n/g, '\n> ')}`);
      if (a.sellerResponse) lines.push(`**Seller reply:** ${a.sellerResponse}`);
      break;
    }
    case 'order_rated_by_seller':
      lines.push(`**Seller rated the buyer${a.totalRating != null ? ` — ${a.totalRating / 2} / 5` : ''}**`);
      if (a.comment) lines.push(`> ${String(a.comment).replace(/\n/g, '\n> ')}`);
      break;
    case 'upsell_offered':
    case 'upsell_accepted': {
      lines.push(`**${t === 'upsell_offered' ? 'Extra offered' : 'Extra accepted'}**`);
      for (const it of (a.items || [])) lines.push(`- ${it.title} (${orderMoney(it.price, a.billing && a.billing.currency)})`);
      if (a.message) lines.push(a.message);
      break;
    }
    default:
      lines.push(`**${t.replace(/_/g, ' ')}**`);
      if (a.body) lines.push(a.body);
      renderFiles(a.attachments);
  }
  return lines;
}

function buildOrderMarkdown(o, page, details, files, fileStates) {
  const filesByFileId = new Map(files.filter(f => f.fileId).map(f => [f.fileId, f]));
  const linkFn = (entry, rawFile) => {
    const name = (entry && entry.name) || rawFile.fileName || 'file';
    const size = fmtSize((entry && entry.size) || rawFile.fileSize);
    const st = entry && fileStates.get(entry.id);
    if (st && st.included && !st.error) return `- 📎 [${name}](attachments/${entry.zipName.replace(/ /g, '%20')}) (${size})`;
    if (st && st.error) return `- 📎 ${name} (${size}) — ⚠️ download failed: ${st.error}`;
    return `- 📎 ${name} (${size}) — not downloaded`;
  };

  let md = `# Order ${o.orderId} — ${o.title || 'untitled'}\n\n`;
  md += `- Buyer: ${o.buyer}\n`;
  md += `- Status: ${o.status || page.status || ''}\n`;
  if (page.orderCreatedAt) md += `- Created: ${fmtTime(page.orderCreatedAt)}\n`;
  if (page.dueDate) md += `- Due: ${fmtTime(page.dueDate)}\n`;
  if (page.completedAt) md += `- Completed: ${fmtTime(page.completedAt)}\n`;
  md += `- Order total: ${orderMoney(o.total, o.currency)}\n`;
  if (page.earnings && page.earnings.amount != null) md += `- Earned (after fees): ${orderMoney(page.earnings.amount, o.currency)}\n`;
  if (details && details.purchases) {
    const tip = details.purchases.find(x => x.type === 'TIP');
    if (tip && tip.billing && tip.billing.grossAmount && tip.billing.grossAmount.moneyInUsd) {
      md += `- Tip: ${orderMoney(tip.billing.grossAmount.moneyInUsd.amount / 100, 'USD')}\n`;
    }
  }
  md += `- Exported: ${fmtTime(Date.now())}\n`;

  if (details && details.description) {
    md += `\n## Description\n\n${details.description}\n`;
  }
  if (details && details.purchases) {
    md += `\n## Line items\n\n`;
    for (const pu of details.purchases) {
      for (const it of (pu.items || [])) {
        const price = it.price && it.price.moneyInUsd ? orderMoney(it.price.moneyInUsd.amount / 100, 'USD') : '';
        md += `- ${it.title}${it.quantity > 1 ? ` ×${it.quantity}` : ''}${price ? ` — ${price}` : ''}\n`;
        for (const sub of (it.items || [])) md += `  - ${sub.title}\n`;
      }
    }
  }

  md += `\n## Timeline\n\n`;
  const acts = [...(page.activities || [])].sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));
  for (const a of acts) {
    md += `### ${fmtTime(a.occurredAt)}\n\n`;
    md += describeActivity(a, page, fileStates, filesByFileId, linkFn).join('\n') + '\n\n---\n\n';
  }
  return md;
}

function buildOrderHtml(o, page, details, files, fileStates) {
  const filesByFileId = new Map(files.filter(f => f.fileId).map(f => [f.fileId, f]));
  const linkFn = (entry, rawFile) => {
    const name = escapeHtml((entry && entry.name) || rawFile.fileName || 'file');
    const size = fmtSize((entry && entry.size) || rawFile.fileSize);
    const st = entry && fileStates.get(entry.id);
    if (st && st.included && !st.error) return `<a class="att" href="attachments/${encodeURIComponent(entry.zipName)}">📎 ${name} <small>(${size})</small></a>`;
    if (st && st.error) return `<span class="att off">📎 ${name} <small>(${size}) — download failed</small></span>`;
    return `<span class="att off">📎 ${name} <small>(${size}) — not downloaded</small></span>`;
  };

  const facts = [];
  facts.push(['Buyer', escapeHtml(o.buyer)]);
  facts.push(['Status', escapeHtml(o.status || page.status || '')]);
  if (page.orderCreatedAt) facts.push(['Created', fmtTime(page.orderCreatedAt)]);
  if (page.completedAt) facts.push(['Completed', fmtTime(page.completedAt)]);
  facts.push(['Total', orderMoney(o.total, o.currency)]);
  if (page.earnings && page.earnings.amount != null) facts.push(['Earned', orderMoney(page.earnings.amount, o.currency)]);

  let body = `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  if (details && details.description) body += `<div class="desc"><h2>Description</h2><p>${escapeHtml(details.description)}</p></div>`;

  const acts = [...(page.activities || [])].sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));
  body += '<h2>Timeline</h2>';
  for (const a of acts) {
    const lines = describeActivity(a, page, fileStates, filesByFileId, linkFn)
      .map(l => l.startsWith('- 📎') || l.startsWith('<a') || l.startsWith('<span')
        ? l.replace(/^- /, '')
        : escapeHtml(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^&gt; /gm, '').replace(/\n/g, '<br>'));
    body += `<div class="event"><time>${fmtTime(a.occurredAt)}</time><div>${lines.join('<br>')}</div></div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Order ${escapeHtml(o.orderId)} — ${escapeHtml(o.title)}</title>
<style>
  body { font-family: "Segoe UI", -apple-system, sans-serif; background: #f2f4f7; color: #222; max-width: 780px; margin: 0 auto; padding: 24px 16px 60px; line-height: 1.55; }
  h1 { font-size: 19px; color: #159957; border-bottom: 2px solid #e3e7ec; padding-bottom: 10px; }
  h2 { font-size: 15px; color: #444; margin-top: 28px; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; background: #fff; border: 1px solid #e3e7ec; border-radius: 10px; padding: 14px; }
  .facts dt { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #98a2ad; }
  .facts dd { margin: 2px 0 0; font-weight: 600; font-size: 14px; }
  .desc p { background: #fff; border: 1px solid #e3e7ec; border-radius: 10px; padding: 14px; white-space: pre-wrap; }
  .event { display: flex; gap: 16px; background: #fff; border: 1px solid #e3e7ec; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
  .event time { flex: none; width: 150px; color: #98a2ad; font-size: 12.5px; }
  .event > div { white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .att { display: block; color: #2b6cb0; text-decoration: none; font-size: 13px; margin-top: 2px; }
  .att:hover { text-decoration: underline; }
  .att.off { color: #98a2ad; }
  .att small { color: #98a2ad; }
</style>
</head>
<body>
<h1>Order ${escapeHtml(o.orderId)} — ${escapeHtml(o.title)}</h1>
${body}
</body>
</html>`;
}

// ---------- orders table ----------
function orderSortVal(o, key) {
  switch (key) {
    case 'buyer': return o.buyer.toLowerCase();
    case 'date': return orderFolderTs(o);
    case 'total': return o.total;
    case 'filesize': return o.analysis ? o.analysis.files.reduce((s, f) => s + f.size, 0) : -1;
    default: return 0;
  }
}

function renderOrders() {
  const { key, dir } = orderSort;
  const mul = dir === 'asc' ? 1 : -1;
  orders.sort((a, b) => {
    const va = orderSortVal(a, key), vb = orderSortVal(b, key);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return a.orderId.localeCompare(b.orderId);
  });
  document.querySelectorAll('#theadOrders .sortable').forEach(el => {
    el.classList.toggle('asc', el.dataset.key === key && dir === 'asc');
    el.classList.toggle('desc', el.dataset.key === key && dir === 'desc');
  });

  const tbody = $('otbody');
  tbody.innerHTML = '';
  const q = $('orderSearch').value.trim().toLowerCase();

  for (const o of orders) {
    if (q && !o.buyer.toLowerCase().includes(q) && !o.title.toLowerCase().includes(q) && !o.orderId.toLowerCase().includes(q)) continue;
    const an = o.analysis;

    const row = document.createElement('div');
    row.className = 'trow';

    const selWrap = document.createElement('span');
    const sel = document.createElement('input');
    sel.type = 'checkbox';
    sel.checked = o._sel !== false;
    sel.title = 'Include this order in the export';
    sel.addEventListener('change', () => { o._sel = sel.checked; refreshOrderSummary(); persistOrders(); });
    selWrap.appendChild(sel);

    const userCell = document.createElement('span');
    userCell.className = 'cell-user';
    const uname = document.createElement('div');
    uname.className = 'uname';
    uname.textContent = o.buyer;
    const usub = document.createElement('div');
    usub.className = 'usub';
    usub.textContent = `${o.orderId} · ${o.status}${o.title ? ' · ' + o.title : ''}`;
    usub.title = o.title;
    userCell.append(uname, usub);

    const dateCell = document.createElement('span');
    dateCell.className = 'num col-hide';
    dateCell.textContent = an && an.completedTs ? fmtTime(an.completedTs) : (o.deliveredAt || (o.dateMs ? dateOnly(o.dateMs) : ''));

    const totalCell = document.createElement('span');
    totalCell.className = 'num has';
    totalCell.textContent = orderMoney(o.total, o.currency);

    const fileCell = document.createElement('span');
    fileCell.className = 'attsize';
    if (an) {
      const total = an.files.reduce((s, f) => s + f.size, 0);
      fileCell.innerHTML = an.files.length
        ? `<span class="n">${an.files.length} ×</span> ${fmtSize(total)}`
        : '<span class="n">none</span>';
    } else {
      fileCell.innerHTML = '<span class="n">analyze first</span>';
    }

    const togWrap = document.createElement('span');
    togWrap.className = 'col-hide';
    const tog = document.createElement('input');
    tog.type = 'checkbox';
    tog.checked = o._att !== false;
    tog.disabled = !!an && an.files.length === 0;
    tog.title = 'Download this order\'s files';
    tog.addEventListener('change', () => { o._att = tog.checked; refreshOrderSummary(); renderOrderFileList(o, listEl); persistOrders(); });
    togWrap.appendChild(tog);

    const exp = document.createElement('button');
    exp.className = 'expander';
    exp.textContent = '▶';
    exp.setAttribute('aria-label', 'Show files');
    exp.disabled = !an || an.files.length === 0;

    const listEl = document.createElement('div');
    listEl.className = 'attlist';
    exp.addEventListener('click', () => {
      const open = listEl.classList.toggle('open');
      exp.classList.toggle('open', open);
      if (open) renderOrderFileList(o, listEl);
    });

    row.append(selWrap, userCell, dateCell, totalCell, fileCell, togWrap, exp);
    tbody.append(row, listEl);
  }

  $('orderTableWrap').style.display = 'block';
  $('orderTools').style.display = 'flex';
  $('btnAnalyzeOrders').disabled = orders.length === 0;
  updateExportButton();
  refreshOrderSummary();
}

function renderOrderFileList(o, el) {
  el.innerHTML = '';
  if (!o.analysis) return;
  for (const f of o.analysis.files) {
    const item = document.createElement('label');
    const included = o._att !== false && !deselectedAtt.has(f.id) && !!f.url;
    item.className = 'attitem' + (included ? '' : ' off');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !deselectedAtt.has(f.id);
    cb.disabled = o._att === false || !f.url;
    cb.addEventListener('change', () => {
      if (cb.checked) deselectedAtt.delete(f.id); else deselectedAtt.add(f.id);
      item.classList.toggle('off', !(o._att !== false && !deselectedAtt.has(f.id) && !!f.url));
      refreshOrderSummary();
      persistOrders();
    });
    const name = document.createElement('span');
    name.className = 'aname';
    name.textContent = `${f.zipName}  ·  ${f.source}`;
    name.title = f.name;
    const size = document.createElement('span');
    size.className = 'asize';
    size.textContent = fmtSize(f.size);
    item.append(cb, name, size);
    el.appendChild(item);
  }
}

function refreshOrderSummary() {
  const selected = orders.filter(o => o._sel !== false);
  $('oSelCount').textContent = `${selected.length} / ${orders.length} selected`;

  const analyzed = selected.filter(o => o.analysis);
  if (!analyzed.length) { $('oTiles').style.display = 'none'; $('oTilesNote').style.display = 'none'; return; }

  const fmts = { md: $('fmtMd').checked, html: $('fmtHtml').checked, json: $('fmtJson').checked };
  let fileCount = 0, fileSize = 0, textSize = 0, earned = 0;
  for (const o of analyzed) {
    if (o.analysis.earned != null) earned += Number(o.analysis.earned) || 0;
    for (const f of o.analysis.files) {
      if (o._att !== false && !deselectedAtt.has(f.id) && f.url) { fileCount++; fileSize += f.size; }
    }
    const t = o.analysis.textSizes || {};
    if (fmts.md) textSize += t.md || 0;
    if (fmts.html) textSize += t.html || 0;
    if (fmts.json) textSize += t.json || 0;
  }
  const total = fileSize + textSize;
  const limit = Math.max(10, Number($('maxMB').value) || 500) * MB;
  const parts = Math.max(1, Math.ceil(total / limit));

  $('oCount').textContent = `${analyzed.length}`;
  $('oEarned').textContent = `$${earned.toFixed(0)}`;
  $('oFiles').textContent = fileCount.toLocaleString();
  $('oFileSize').textContent = fmtSize(fileSize);
  $('oTotal').textContent = fmtSize(total);
  $('oTotalParts').textContent = `~${parts} ZIP part${parts > 1 ? 's' : ''}`;
  $('oTiles').style.display = 'grid';

  const unAnalyzed = selected.length - analyzed.length;
  const note = $('oTilesNote');
  note.textContent = unAnalyzed > 0
    ? `${unAnalyzed} selected order${unAnalyzed > 1 ? 's are' : ' is'} not analyzed yet — actual size will be larger. "Earned" covers analyzed orders only.`
    : 'Text-format sizes are pre-compression estimates; final ZIPs are usually a little smaller.';
  note.style.display = 'block';
}

// ---------- analyze (orders) ----------
async function runAnalyzeOrders() {
  if (running) return;
  const selected = orders.filter(o => o._sel !== false);
  if (!selected.length) return;

  running = true;
  cancelled = false;
  $('btnAnalyzeOrders').disabled = true;
  $('btnFetchOrders').disabled = true;
  $('btnExport').disabled = true;
  $('btnCancel').style.display = 'inline-block';
  log(`Analyzing ${selected.length} orders (metadata only — no files are downloaded)…`);

  let done = 0;
  let queue = selected.slice();
  for (let pass = 1; pass <= 2 && queue.length && !cancelled; pass++) {
    if (pass === 2) {
      log(`Cooling down 60 s, then retrying ${queue.length} rate-limited order(s)…`, 'log-warn');
      try { await cancellableSleep(60000); } catch (e) { break; }
    }
    const failedThisPass = [];
    for (let i = 0; i < queue.length; i++) {
      if (cancelled) { log('Analysis cancelled.', 'log-warn'); break; }
      const o = queue[i];
      setProgress(i, queue.length, `analyzing ${o.orderId}${pass > 1 ? ' (retry)' : ''}`);
      if (o.analysis && orderCache.has(o.orderId)) { done++; continue; }
      try {
        const { page, details } = await fetchOrderData(o.orderId);
        const files = indexOrderFiles(o.orderId, page);
        const fileStates = new Map(files.map(f => [f.id, { included: true }]));
        const md = buildOrderMarkdown(o, page, details, files, fileStates);
        const html = buildOrderHtml(o, page, details, files, fileStates);
        const json = JSON.stringify({ summary: o, details, page }, null, 2);
        o.analysis = {
          files,
          earned: page.earnings && page.earnings.amount != null ? page.earnings.amount : null,
          activityCount: (page.activities || []).length,
          completedTs: page.completedAt || null,
          textSizes: { md: new Blob([md]).size, html: new Blob([html]).size, json: new Blob([json]).size }
        };
        done++;
        const fs = files.reduce((s, f) => s + f.size, 0);
        log(`· ${o.orderId} (${o.buyer}) — ${(page.activities || []).length} events, ${files.length} files (${fmtSize(fs)})`);
      } catch (e) {
        if (e.message === 'cancelled') { log('Analysis cancelled.', 'log-warn'); break; }
        failedThisPass.push(o);
        log(`✘ analyze failed: ${o.orderId} — ${e.message}${pass === 1 ? ' (will retry after cooldown)' : ''}`, 'log-err');
      }
      await sleep(1000);
    }
    queue = failedThisPass;
  }
  const failed = queue.length;

  setProgress(selected.length, selected.length, 'analysis complete');
  log(`Order analysis finished: ${done} analyzed, ${failed} failed.`, failed ? 'log-warn' : 'log-ok');
  persistOrders();
  renderOrders();

  running = false;
  $('btnAnalyzeOrders').disabled = false;
  $('btnFetchOrders').disabled = false;
  updateExportButton();
  $('btnCancel').style.display = 'none';
}

// ---------- export (orders) ----------
async function runExportOrders() {
  if (running) return;
  const selected = orders.filter(o => o._sel !== false);
  if (!selected.length) return;

  const fmts = { md: $('fmtMd').checked, html: $('fmtHtml').checked, json: $('fmtJson').checked };
  if (!fmts.md && !fmts.html && !fmts.json) {
    log('Select at least one format (Markdown, HTML or JSON) before exporting.', 'log-err');
    return;
  }

  running = true;
  cancelled = false;
  stats.done = 0; stats.fail = 0; stats.att = 0; stats.parts = 0;
  updateStats(0);
  $('btnExport').disabled = true;
  $('btnAnalyzeOrders').disabled = true;
  $('btnFetchOrders').disabled = true;
  $('btnCancel').style.display = 'inline-block';

  const limitMB = Math.max(10, Number($('maxMB').value) || 500);
  const exportStamp = tsStamp(Date.now());
  const batcher = new ZipBatcher(limitMB * MB, `fiverr-orders-${exportStamp}`);
  const report = { started: fmtTime(Date.now()), total: selected.length, formats: fmts, ok: [], failed: [], filesFailed: [], filesSkipped: 0 };

  log(`Starting export of ${selected.length} orders (parts capped at ${limitMB} MB)…`);

  for (let i = 0; i < selected.length; i++) {
    if (cancelled) { log('Cancelled — saving what has been collected so far.', 'log-warn'); break; }
    const o = selected[i];
    setProgress(i, selected.length, o.orderId);
    try {
      const { page, details } = await fetchOrderData(o.orderId);
      const files = (o.analysis && orderCache.has(o.orderId)) ? o.analysis.files : indexOrderFiles(o.orderId, page);
      const folder = `${dateOnly(orderFolderTs(o))}_${sanitize(o.orderId)}_${sanitize(o.buyer)}`;
      const fileStates = new Map();
      let fileCount = 0;

      for (const f of files) {
        if (cancelled) break;
        if (!(o._att !== false && !deselectedAtt.has(f.id) && f.url)) {
          fileStates.set(f.id, { included: false });
          report.filesSkipped++;
          continue;
        }
        try {
          const blob = await fetchAttachmentBlob(f.url);
          await batcher.add(`${folder}/attachments/${f.zipName}`, blob, { size: blob.size, date: new Date(toMs(f.ts)) });
          fileStates.set(f.id, { included: true });
          fileCount++;
          stats.att++;
        } catch (e) {
          fileStates.set(f.id, { included: true, error: e.message });
          report.filesFailed.push({ orderId: o.orderId, file: f.name, url: f.url, error: e.message });
          log(`  ⚠ file failed (${o.orderId} / ${f.name}): ${e.message}`, 'log-warn');
        }
      }

      const ts = orderFolderTs(o);
      const base = `${dateOnly(ts)}_${sanitize(o.orderId)}`;
      if (fmts.md) {
        const md = buildOrderMarkdown(o, page, details, files, fileStates);
        await batcher.add(`${folder}/${base}.md`, md, { size: new Blob([md]).size, compress: true, date: new Date(ts) });
      }
      if (fmts.html) {
        const html = buildOrderHtml(o, page, details, files, fileStates);
        await batcher.add(`${folder}/${base}.html`, html, { size: new Blob([html]).size, compress: true, date: new Date(ts) });
      }
      if (fmts.json) {
        const json = JSON.stringify({ summary: o, details, page }, null, 2);
        await batcher.add(`${folder}/${base}.json`, json, { size: new Blob([json]).size, compress: true, date: new Date(ts) });
      }

      stats.done++;
      report.ok.push(o.orderId);
      log(`✔ ${o.orderId} (${o.buyer}) — ${fileCount} files`, 'log-ok');
    } catch (e) {
      if (e.message === 'cancelled') { log('Cancelled — saving what has been collected so far.', 'log-warn'); break; }
      stats.fail++;
      report.failed.push({ orderId: o.orderId, error: e.message });
      log(`✘ ${o.orderId} — ${e.message}`, 'log-err');
    }
    updateStats(batcher.size);
    await sleep(400);
  }

  report.finished = fmtTime(Date.now());
  try {
    const rep = JSON.stringify(report, null, 2);
    await batcher.add(`_export-report.json`, rep, { size: rep.length, compress: true });
    await batcher.flush();
  } catch (e) {
    log(`Error saving final ZIP: ${e.message}`, 'log-err');
  }

  setProgress(selected.length, selected.length, 'finished');
  log(`Order export finished. ${stats.done} ok, ${stats.fail} failed, ${stats.att} files, ${stats.parts} ZIP part(s). Details in _export-report.json inside the last ZIP.`, 'log-ok');

  running = false;
  $('btnAnalyzeOrders').disabled = false;
  $('btnFetchOrders').disabled = false;
  updateExportButton();
  $('btnCancel').style.display = 'none';
}

/* ==================================================================
 *                          TABS + WIRING
 * ================================================================== */

let activeTab = 'messages';

function setTab(tab) {
  activeTab = tab;
  $('paneMessages').classList.toggle('active', tab === 'messages');
  $('paneOrders').classList.toggle('active', tab === 'orders');
  $('tabMessages').classList.toggle('active', tab === 'messages');
  $('tabOrders').classList.toggle('active', tab === 'orders');
  $('tabMessages').setAttribute('aria-selected', tab === 'messages');
  $('tabOrders').setAttribute('aria-selected', tab === 'orders');
  $('btnExport').textContent = tab === 'messages' ? 'Export chats' : 'Export orders';
  updateExportButton();
}

function updateExportButton() {
  if (running) return;
  $('btnExport').disabled = activeTab === 'messages' ? contacts.length === 0 : orders.length === 0;
}

// ---------- wiring ----------
// tabs
$('tabMessages').addEventListener('click', () => setTab('messages'));
$('tabOrders').addEventListener('click', () => setTab('orders'));

// messages
$('btnFetchContacts').addEventListener('click', fetchAllContacts);
$('btnAnalyze').addEventListener('click', runAnalyze);
$('btnSelAll').addEventListener('click', () => { contacts.forEach(c => c._sel = true); renderContacts(); persistContacts(); });
$('btnSelNone').addEventListener('click', () => { contacts.forEach(c => c._sel = false); renderContacts(); persistContacts(); });
$('btnAttAll').addEventListener('click', () => { contacts.forEach(c => c._att = true); contacts.forEach(c => (c.analysis?.atts || []).forEach(a => deselectedAtt.delete(a.id))); renderContacts(); persistContacts(); });
$('btnAttNone').addEventListener('click', () => { contacts.forEach(c => c._att = false); renderContacts(); persistContacts(); });
$('filter').addEventListener('input', renderContacts);
document.querySelectorAll('#theadMessages .sortable').forEach(el => {
  el.addEventListener('click', () => {
    const key = el.dataset.key;
    if (sortState.key === key) {
      sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      // text sorts ascending first; numeric columns descending first (biggest on top)
      sortState = { key, dir: key === 'name' ? 'asc' : 'desc' };
    }
    renderContacts();
  });
});

// orders
$('btnFetchOrders').addEventListener('click', fetchAllOrders);
$('btnAnalyzeOrders').addEventListener('click', runAnalyzeOrders);
$('btnOSelAll').addEventListener('click', () => { orders.forEach(o => o._sel = true); renderOrders(); persistOrders(); });
$('btnOSelNone').addEventListener('click', () => { orders.forEach(o => o._sel = false); renderOrders(); persistOrders(); });
$('btnOAttAll').addEventListener('click', () => { orders.forEach(o => o._att = true); orders.forEach(o => (o.analysis?.files || []).forEach(f => deselectedAtt.delete(f.id))); renderOrders(); persistOrders(); });
$('btnOAttNone').addEventListener('click', () => { orders.forEach(o => o._att = false); renderOrders(); persistOrders(); });
$('orderSearch').addEventListener('input', renderOrders);
document.querySelectorAll('#theadOrders .sortable').forEach(el => {
  el.addEventListener('click', () => {
    const key = el.dataset.key;
    if (orderSort.key === key) {
      orderSort.dir = orderSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      orderSort = { key, dir: key === 'buyer' ? 'asc' : 'desc' };
    }
    renderOrders();
  });
});

// shared
$('btnExport').addEventListener('click', () => activeTab === 'messages' ? runExport() : runExportOrders());
$('btnCancel').addEventListener('click', () => { cancelled = true; $('btnCancel').disabled = true; setTimeout(() => $('btnCancel').disabled = false, 3000); });
['fmtMd', 'fmtHtml', 'fmtJson', 'maxMB', 'inclAsst'].forEach(id => $(id).addEventListener('change', () => { refreshSummary(); refreshOrderSummary(); }));
$('inclAsst').addEventListener('change', () => chrome.storage.local.set({ uiInclAsst: $('inclAsst').checked }));
chrome.storage.local.get(['uiInclAsst'], res => { if (res.uiInclAsst === false) $('inclAsst').checked = false; });

// part-limit stepper
function stepMB(delta) {
  const el = $('maxMB');
  const cur = Number(el.value) || 500;
  el.value = Math.min(1900, Math.max(10, cur + delta));
  refreshSummary();
  refreshOrderSummary();
}
$('mbMinus').addEventListener('click', () => stepMB(-50));
$('mbPlus').addEventListener('click', () => stepMB(50));

// theme toggle (dark is the default)
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}
$('themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  chrome.storage.local.set({ uiTheme: next });
});
chrome.storage.local.get(['uiTheme'], res => applyTheme(res.uiTheme));

// assistant-name fallback (persisted)
$('asstName').addEventListener('change', () => chrome.storage.local.set({ uiAsstName: $('asstName').value.trim() }));
chrome.storage.local.get(['uiAsstName'], res => { if (res.uiAsstName) $('asstName').value = res.uiAsstName; });

window.addEventListener('beforeunload', (e) => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

// restore previous session (lists + analysis summaries + deselections)
chrome.storage.local.get(['batchExportContacts', 'batchExportOrders', 'batchExportDeselected'], res => {
  if (Array.isArray(res.batchExportDeselected)) {
    res.batchExportDeselected.forEach(id => deselectedAtt.add(id));
  }
  if (Array.isArray(res.batchExportContacts) && res.batchExportContacts.length) {
    contacts = res.batchExportContacts;
    // restored analyses carry hasUrl instead of the (session-only) url — map it
    // back so summaries and the attachment list treat them as downloadable
    for (const c of contacts) {
      if (c.analysis && c.analysis.atts) {
        for (const a of c.analysis.atts) {
          if (a.url === undefined) a.url = a.hasUrl ? true : null;
        }
      }
    }
    renderContacts();
    $('contactStatus').textContent = `Restored ${contacts.length} contacts from the previous session. Re-fetch if outdated.`;
  }
  if (Array.isArray(res.batchExportOrders) && res.batchExportOrders.length) {
    orders = res.batchExportOrders;
    for (const o of orders) {
      if (o.analysis && o.analysis.files) {
        for (const f of o.analysis.files) {
          if (f.url === undefined) f.url = f.hasUrl ? true : null;
        }
      }
    }
    renderOrders();
    $('orderStatus').textContent = `Restored ${orders.length} orders from the previous session. Re-fetch if outdated.`;
  }
});
