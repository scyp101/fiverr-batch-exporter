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
      if (r.status === 429) { await sleep(5000 * (attempt + 1)); if (attempt < retries) continue; }
      if (r.status === 401 || r.status === 403) return await fetchViaTab(url);
      throw new Error(`HTTP ${r.status} ${r.statusText}`);
    } catch (e) {
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      return await fetchViaTab(url);   // last resort
    }
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
async function fetchConversation(username) {
  if (convCache.has(username)) return convCache.get(username);
  let all = [];
  let lastPage = false;
  let timestamp = null;
  let guard = 0;
  while (!lastPage && guard++ < 500) {
    if (cancelled) throw new Error('cancelled');
    const url = timestamp
      ? `https://www.fiverr.com/inbox/contacts/${encodeURIComponent(username)}/conversation?timestamp=${timestamp}`
      : `https://www.fiverr.com/inbox/contacts/${encodeURIComponent(username)}/conversation`;
    const data = await fiverrJson(url);
    const msgs = data.messages || [];
    all = all.concat(msgs);
    lastPage = !!data.lastPage || msgs.length === 0;
    if (!lastPage) timestamp = Math.min(...msgs.map(m => Number(m.createdAt)));
    await sleep(600);
  }
  all.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  convCache.set(username, all);
  return all;
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
function renderContacts() {
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
  $('btnExport').disabled = contacts.length === 0;
  $('btnAnalyze').disabled = contacts.length === 0;
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

// ---------- analyze ----------
async function runAnalyze() {
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
      const md = buildMarkdown(c.username, messages, atts, attStates);
      const html = buildHtml(c.username, messages, atts, attStates);
      const json = JSON.stringify({ username: c.username, messages }, null, 2);

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
function buildMarkdown(username, messages, atts, attStates) {
  const byAtt = new Map(atts.map(a => [a.att, a]));
  let md = `# Conversation with ${username}\n\n`;
  md += `- Messages: ${messages.length}\n`;
  if (messages.length) {
    md += `- First message: ${fmtTime(messages[0].createdAt)}\n`;
    md += `- Last message: ${fmtTime(messages[messages.length - 1].createdAt)}\n`;
  }
  md += `- Exported: ${fmtTime(Date.now())}\n\n---\n\n`;

  for (const m of messages) {
    md += `### ${m.sender || 'Unknown'} — ${fmtTime(m.createdAt)}\n\n`;

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
function buildHtml(username, messages, atts, attStates) {
  const byAtt = new Map(atts.map(a => [a.att, a]));
  let body = '';
  let currentDate = null;

  for (const m of messages) {
    const dayStr = new Date(toMs(m.createdAt)).toDateString();
    if (dayStr !== currentDate) {
      body += `<div class="day"><span>${escapeHtml(dayStr)}</span></div>\n`;
      currentDate = dayStr;
    }
    const side = m.sender === username ? 'them' : 'me';
    body += `<div class="msg ${side}"><div class="meta"><b>${escapeHtml(m.sender || 'Unknown')}</b><time>${fmtTime(m.createdAt)}</time></div>`;
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

// ---------- main export ----------
async function runExport() {
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
      if (fmts.md) {
        const md = buildMarkdown(c.username, messages, atts, attStates);
        await batcher.add(`${folder}/${base}.md`, md, { size: new Blob([md]).size, compress: true, date: new Date(toMs(lastTs)) });
      }
      if (fmts.html) {
        const html = buildHtml(c.username, messages, atts, attStates);
        await batcher.add(`${folder}/${base}.html`, html, { size: new Blob([html]).size, compress: true, date: new Date(toMs(lastTs)) });
      }
      if (fmts.json) {
        const json = JSON.stringify({ username: c.username, messages }, null, 2);
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

// ---------- wiring ----------
$('btnFetchContacts').addEventListener('click', fetchAllContacts);
$('btnAnalyze').addEventListener('click', runAnalyze);
$('btnExport').addEventListener('click', runExport);
$('btnCancel').addEventListener('click', () => { cancelled = true; $('btnCancel').disabled = true; setTimeout(() => $('btnCancel').disabled = false, 3000); });
$('btnSelAll').addEventListener('click', () => { contacts.forEach(c => c._sel = true); renderContacts(); persistContacts(); });
$('btnSelNone').addEventListener('click', () => { contacts.forEach(c => c._sel = false); renderContacts(); persistContacts(); });
$('btnAttAll').addEventListener('click', () => { contacts.forEach(c => c._att = true); deselectedAtt.clear(); renderContacts(); persistContacts(); });
$('btnAttNone').addEventListener('click', () => { contacts.forEach(c => c._att = false); renderContacts(); persistContacts(); });
$('filter').addEventListener('input', renderContacts);
['fmtMd', 'fmtHtml', 'fmtJson', 'maxMB'].forEach(id => $(id).addEventListener('change', refreshSummary));

window.addEventListener('beforeunload', (e) => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
});

// restore previous session (contact list + analysis summaries + deselections)
chrome.storage.local.get(['batchExportContacts', 'batchExportDeselected'], res => {
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
});
