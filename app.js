/* Reading Workbench — app logic
   Data source: inline window.__DATA__, local data/*.json, or bundled sample-data.
   Principle: reading first; AI assistance stays clearly labeled and separate from source notes.
   Modes: reading queue and reviewable knowledge cards. */

const STATE_OPTIONS = ["未读", "阅读中", "已读", "暂存", "已归档"];
const LS_STATUS = "rw04-reading-status";
const LS_AI = "rw04-ai-config";
const LS_CARDS = "rw04-cards";
const LS_NOTES = "rw04-notes";

const TRACKS = [
  { id: "today", label: "今日" }, { id: "deep", label: "深读" },
  { id: "radar", label: "创投雷达" }, { id: "browse", label: "泛读" }, { id: "all", label: "全部" },
];

// Content format, independent from track and topic.
const FORMATS = [
  { id: "article", label: "文章", color: "#6b6f76" },
  { id: "interview", label: "访谈", color: "#cf8a3c" },
  { id: "podcast", label: "播客", color: "#b0568f" },
  { id: "report", label: "报告", color: "#3f9a7a" },
  { id: "book", label: "书·PDF", color: "#a06a4a" },
  { id: "newsletter", label: "Newsletter", color: "#5a78c8" },
  { id: "flash", label: "快讯", color: "#cf5a6e" },
];
const FMT = Object.fromEntries(FORMATS.map(f => [f.id, f]));
const FMT_ICON = {
  article: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 15.5h6M9 8.5h2"/>',
  interview: '<path d="M3 5h10v7H7l-3 3v-3H3z"/><path d="M16 9h5v7h-2v3l-3-3h-4"/>',
  podcast: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8.5 21h7"/>',
  report: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9.5 17v-3M12 17v-5M14.5 17v-2"/>',
  book: '<path d="M12 6c-1.6-1.4-4-2-7-2v13c3 0 5.4.6 7 2 1.6-1.4 4-2 7-2V4c-3 0-5.4.6-7 2z"/><path d="M12 6v13"/>',
  newsletter: '<rect x="3" y="6" width="18" height="12.5" rx="2"/><path d="M3.5 8l8.5 6 8.5-6"/>',
  flash: '<path d="M13 2.5L5 13h6l-1 8.5L19 10h-6z"/>',
};

let ENTRIES = [], ASSETS = {}, SOURCES = [];
let mode = "read";              // read | review
let activeTrack = "today";
let formatFilter = new Set();    // 多选；空 = 全部
let filters = { topic: "全部", status: "全部", q: "" };
let reviewFilter = { topic: "全部", q: "" };
let reviewFormat = new Set();
let readingStatus = {};
let allExpanded = false;
let lastAI = "";

// Storage channel: if the local helper is available, write cards/notes/status to local files;
// otherwise fall back to browser localStorage.
let STORE = "local";            // "local" | "vault"
let CARDS = [];                 // vault 模式卡片镜像
let NOTES = {};                 // vault 模式笔记镜像 { entryId: text }
let HELPER = { cli: false, clis: [] };   // Local helper CLI presets.
// BYO-key provider registry for OpenAI-compatible browser requests.
const API_PROVIDERS = [
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", models: ["gpt-5.5", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"] },
  { id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", models: ["openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.0-flash", "meta-llama/llama-3.1-70b-instruct"] },
  { id: "custom", label: "自定义（OpenAI 兼容端点）", endpoint: "", models: [] },
];
const providerById = id => API_PROVIDERS.find(p => p.id === id) || API_PROVIDERS[0];
const cliFront = id => (HELPER.clis || []).find(c => c.id === id) || (HELPER.clis || [])[0];
let DEMO = false;               // sample-data fallback
let DEMO_CARDS = [];            // bundled sample cards

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const uniq = a => [...new Set(a.filter(Boolean))];
const ficon = (id, size = 14) => `<svg class="ficon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${FMT_ICON[id] || FMT_ICON.article}</svg>`;

/* ---------- 数据 ---------- */
async function loadData() {
  if (window.__DATA__) { ({ entries: ENTRIES, assets: ASSETS, sources: SOURCES } = window.__DATA__); return; }
  const j = p => fetch(p).then(r => { if (!r.ok) throw new Error(p + " " + r.status); return r.json(); });
  try {
    const [e, a, s] = await Promise.all([j("data/entries.json"), j("data/assets.json"), j("data/sources.json")]);
    ENTRIES = e; ASSETS = a; SOURCES = s; return;
  } catch { /* no local data/ available; fall back to sample-data/ */ }
  DEMO = true;
  const [e, a, s] = await Promise.all([j("sample-data/entries.json"), j("sample-data/assets.json").catch(() => ({})), j("sample-data/sources.json").catch(() => [])]);
  ENTRIES = e; ASSETS = a; SOURCES = s;
  DEMO_CARDS = await j("sample-data/sample-cards.json").catch(() => []);
}
function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k) || d); } catch { return JSON.parse(d); } }

// Detect the local helper; if available, load cards/notes/status from local files.
async function detectStore() {
  try {
    const h = await fetch("api/health", { cache: "no-store" });
    if (!h.ok) return;
    const meta = await h.json(); if (!meta.ok) return;
    HELPER = { cli: !!(meta.clis && meta.clis.length), clis: meta.clis || [] };
    const s = await fetch("api/store", { cache: "no-store" }); if (!s.ok) return;
    const { cards = [], notes = {}, status = {} } = await s.json();
    STORE = "vault"; CARDS = cards; NOTES = notes; readingStatus = status;
    window.__VAULT__ = meta.vault || "";
  } catch { /* helper unavailable; stay on localStorage */ }
}
// Local-file writes are fire-and-forget; notes are debounced.
function postJSON(path, body) { fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(e => console.warn("Write failed", path, e)); }
let notesTimer = null;
function persistNotes() { clearTimeout(notesTimer); notesTimer = setTimeout(() => postJSON("api/notes", { notes: NOTES }), 350); }

function getStatus(id) { return readingStatus[id] || "未读"; }
function setStatus(id, s) {
  if (s === "未读") delete readingStatus[id]; else readingStatus[id] = s;
  if (STORE === "vault") postJSON("api/status", { status: readingStatus });
  else localStorage.setItem(LS_STATUS, JSON.stringify(readingStatus));
}
function getNote(id) { return STORE === "vault" ? (NOTES[id] || "") : (lsGet(LS_NOTES, "{}")[id] || ""); }
function setNote(id, v) {
  if (STORE === "vault") { if (v) NOTES[id] = v; else delete NOTES[id]; persistNotes(); }
  else { const n = lsGet(LS_NOTES, "{}"); if (v) n[id] = v; else delete n[id]; localStorage.setItem(LS_NOTES, JSON.stringify(n)); }
}
function getCards() {
  if (STORE === "vault") return CARDS;
  const ls = lsGet(LS_CARDS, "[]");
  return (DEMO && !ls.length) ? DEMO_CARDS : ls;   // demo：本地无卡时展示样本卡
}
function saveCards(cs) {
  if (STORE === "vault") { CARDS = cs; postJSON("api/cards", { cards: cs }); }
  else localStorage.setItem(LS_CARDS, JSON.stringify(cs));
}

/* ---------- 分类映射 ---------- */
function trackOf(e) {
  const c = e.content_category, rl = e.reading_layer;
  if (c === "快讯速扫" || c === "来源池" || rl === "速递" || rl === "快讯速扫") return "radar";
  if (c === "泛读观察" || rl === "泛读信息流") return "browse";
  return "deep";
}
function formatOf(e) {
  const c = e.content_category;
  const blob = ((e.source_channel_type || "") + " " + (e.source_name || "")).toLowerCase();
  if (/pdf|书籍|论文|\bbook\b/.test(blob) || c === "书籍/论文") return "book";
  if (/播客|podcast|dwarkesh/.test(blob)) return "podcast";
  if (c === "深度访谈") return "interview";
  if (c === "深度报告/研究") return "report";
  if (/newsletter/.test(blob)) return "newsletter";
  if (c === "快讯速扫" || c === "来源池") return "flash";
  return "article";
}
function pubKey(e) { return e.published_at || e.published_date || e.publication_date_bucket || ""; }
function fmtDate(e) { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(e.published_date || e.publication_date_bucket || ""); return m ? `${m[2]}-${m[3]}` : "—"; }
function sortDesc(a) { return [...a].sort((x, y) => String(pubKey(y)).localeCompare(String(pubKey(x)))); }
function assetOf(id) { return ASSETS[id] || { links: [] }; }
function deepLinks(id) { return (assetOf(id).links || []).filter(l => ["item_deep_read", "cross_pack", "rendered_markdown"].includes(l.type)); }
function sourceLinkOf(e) { return e.canonical_url || e.primary_button_url || (assetOf(e.id).links.find(l => l.type === "primary_original" || l.type === "source") || {}).url || ""; }

/* ---------- 筛选 ---------- */
function passFilters(e) {
  if (filters.topic !== "全部" && e.main_topic !== filters.topic) return false;
  if (filters.status !== "全部" && getStatus(e.id) !== filters.status) return false;
  if (formatFilter.size && !formatFilter.has(formatOf(e))) return false;
  const q = filters.q.trim().toLowerCase();
  if (q) { const h = [e.title, e.source_name, e.summary, e.author_or_guest, e.main_topic, ...(e.tags || [])].join(" ").toLowerCase(); if (!h.includes(q)) return false; }
  return true;
}
function entriesForTrack(t) {
  const pool = ENTRIES.filter(passFilters);
  if (t === "today") return sortDesc(pool.filter(e => e.today_suggested));
  if (t === "all") return sortDesc(pool);
  return sortDesc(pool.filter(e => trackOf(e) === t));
}

/* ---------- 左侧功能区（阅读 / 回顾 双模式） ---------- */
function renderRail() {
  const cards = getCards().length;
  $("#rail").innerHTML = `
    <div class="wordmark">阅读台</div>
    <nav class="modes">
      <button class="mode ${mode === "read" ? "active" : ""}" data-mode="read">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h7a3 3 0 0 1 3 3v12a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 5h-7a3 3 0 0 0-3 3v12a2.5 2.5 0 0 1 2.5-2.5H20z"/></svg>
        <span>阅读</span></button>
      <button class="mode ${mode === "review" ? "active" : ""}" data-mode="review">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="14" width="7" height="6" rx="1.5"/><rect x="13.5" y="14" width="7" height="6" rx="1.5"/></svg>
        <span>回顾</span>${cards ? `<em class="badge-n">${cards}</em>` : ""}</button>
    </nav>
    <div class="rail-foot">v0.4 · 浅色极简<br>用你自己的模型<br><span class="store-tag ${STORE === "vault" ? "on" : ""}" title="${STORE === "vault" ? esc(window.__VAULT__ || "") : (DEMO ? "Sample data · stored in this browser" : "Stored in this browser")}">${STORE === "vault" ? "● Local files" : (DEMO ? "○ Sample data" : "○ Browser storage")}</span></div>`;
  $("#rail").querySelectorAll(".mode").forEach(b => b.onclick = () => { mode = b.dataset.mode; render(); window.scrollTo(0, 0); });
}

/* ---------- 阅读模式：顶部 ---------- */
function opt(v, cur) { return `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(v)}</option>`; }
function facetHTML(active, counts) {
  return `<div class="facet">${FORMATS.map(f => {
    const on = active.has(f.id), n = counts[f.id] || 0;
    return `<button class="chip ${on ? "on" : ""}" data-fmt="${f.id}" style="${on ? `--c:${f.color}` : ""}" ${n ? "" : "disabled"}>
      <span class="ci" style="color:${on ? f.color : "var(--faint)"}">${ficon(f.id, 13)}</span>${f.label}<em>${n}</em></button>`;
  }).join("")}</div>`;
}
function renderReadHead() {
  const base = ENTRIES.filter(passFilters);
  const counts = { today: base.filter(e => e.today_suggested).length, deep: base.filter(e => trackOf(e) === "deep").length, radar: base.filter(e => trackOf(e) === "radar").length, browse: base.filter(e => trackOf(e) === "browse").length, all: base.length };
  // format 计数（不受 formatFilter 自身影响，受其它筛选影响）
  const fpool = ENTRIES.filter(e => { const s = formatFilter; formatFilter = new Set(); const ok = passFilters(e); formatFilter = s; return ok; });
  const fcounts = {}; fpool.forEach(e => { const f = formatOf(e); fcounts[f] = (fcounts[f] || 0) + 1; });
  const topics = uniq(ENTRIES.map(e => e.main_topic)).sort();
  const aiOn = aiReady();
  $("#readhead").innerHTML = `
    <header class="masthead"><h1>多源阅读</h1><p class="sub">按你自己的节奏读 — AI 辅助，不替代阅读</p></header>
    <nav class="tracks">${TRACKS.map(t => `<button class="track ${activeTrack === t.id ? "active" : ""}" data-track="${t.id}">${t.label}<span class="n">${counts[t.id]}</span></button>`).join("")}</nav>
    <div class="toolbar">
      <input id="search" class="search" placeholder="搜索标题、来源、作者、标签…" value="${esc(filters.q)}">
      <select id="f-topic" class="selectish">${["全部", ...topics].map(v => opt(v, filters.topic)).join("")}</select>
      <select id="f-status" class="selectish">${["全部", ...STATE_OPTIONS].map(v => opt(v, filters.status)).join("")}</select>
      <button id="ai-settings" class="icon-btn" title="配置你自己的模型 API"><span class="dot ${aiOn ? "on" : ""}"></span>AI</button>
      ${(filters.topic !== "全部" || filters.status !== "全部" || filters.q || formatFilter.size) ? `<button id="clearf" class="clearfilter">清除</button>` : ""}
    </div>
    ${facetHTML(formatFilter, fcounts)}`;
  const s = $("#search"); s.oninput = () => { filters.q = s.value; renderReadHead(); renderContent(); s2 = $("#search"); s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); };
  $("#f-topic").onchange = e => { filters.topic = e.target.value; render(); };
  $("#f-status").onchange = e => { filters.status = e.target.value; render(); };
  $("#ai-settings").onclick = openAISettings;
  const cf = $("#clearf"); if (cf) cf.onclick = () => { filters = { topic: "全部", status: "全部", q: "" }; formatFilter = new Set(); render(); };
  $("#readhead").querySelectorAll("[data-track]").forEach(b => b.onclick = () => { activeTrack = b.dataset.track; allExpanded = false; render(); });
  $("#readhead").querySelectorAll("[data-fmt]").forEach(b => b.onclick = () => { const f = b.dataset.fmt; formatFilter.has(f) ? formatFilter.delete(f) : formatFilter.add(f); render(); });
}
let s2;

/* ---------- 卡片 / 行 ---------- */
function cardHTML(e) {
  const f = FMT[formatOf(e)], st = getStatus(e.id), pills = [];
  if (e.article_path) pills.push(`<span class="pill local">可离线读</span>`);
  if (deepLinks(e.id).length) pills.push(`<span class="pill deep">深读包</span>`);
  return `<article class="card" data-id="${esc(e.id)}">
    <span class="ctype" style="color:${f.color}">${ficon(f.id)}<span>${f.label}</span><span class="src-sep">·</span><span class="src">${esc(e.source_name || "")}</span></span>
    <h3>${esc(e.title || "无标题")}</h3>
    ${e.summary ? `<p class="excerpt">${esc(e.summary)}</p>` : ""}
    <div class="foot"><span class="date">${fmtDate(e)}</span>
      ${e.author_or_guest ? `<span class="sep">·</span><span>${esc(e.author_or_guest)}</span>` : ""}
      ${st !== "未读" ? `<span class="sep">·</span><span class="state">${esc(st)}</span>` : ""}
      ${pills.length ? `<span class="pills">${pills.join("")}</span>` : ""}</div>
  </article>`;
}
function rowHTML(e) {
  return `<div class="row" data-id="${esc(e.id)}"><span class="date">${fmtDate(e)}</span>
    <div class="body"><div class="t">${esc(e.title || "无标题")}</div>${e.why || e.summary ? `<div class="w">${esc(e.why || e.summary)}</div>` : ""}</div>
    <span class="src">${esc(e.source_name || "")}</span></div>`;
}
function listBlock(list, style) {
  if (!list.length) return `<div class="empty">这一组暂时没有内容</div>`;
  return style === "row" ? `<div class="rows">${list.map(rowHTML).join("")}</div>` : `<div class="cards">${list.map(cardHTML).join("")}</div>`;
}
function renderContent() {
  const c = $("#content");
  if (activeTrack === "all") {
    const today = entriesForTrack("today"), rest = sortDesc(ENTRIES.filter(passFilters)), shown = allExpanded ? rest : rest.slice(0, 12);
    c.innerHTML = `${today.length ? `<section class="section"><div class="sec-head"><h2>今日建议</h2><span class="count">${today.length}</span></div>${listBlock(today, "card")}</section>` : ""}
      <section class="section"><div class="sec-head"><h2>全部材料</h2><span class="count">${rest.length}</span></div>${listBlock(shown, "card")}
      ${rest.length > 12 ? `<div class="more"><button class="fold-toggle" id="fold">${allExpanded ? "收起" : `展开全部 ${rest.length} 条`}</button></div>` : ""}</section>`;
    const fd = $("#fold"); if (fd) fd.onclick = () => { allExpanded = !allExpanded; renderContent(); };
  } else {
    const list = entriesForTrack(activeTrack), style = activeTrack === "radar" ? "row" : "card";
    const tm = { today: "今日建议", deep: "深读", radar: "创投雷达", browse: "泛读 · 观察" };
    c.innerHTML = `<section class="section"><div class="sec-head"><h2>${tm[activeTrack]}</h2><span class="count">${list.length}</span></div>${listBlock(list, style)}</section>`;
  }
  c.querySelectorAll("[data-id]").forEach(el => el.onclick = () => openReader(el.dataset.id));
}

/* ---------- 回顾模式：知识卡片 ---------- */
function renderReview() {
  $("#readhead").innerHTML = "";
  const all = getCards();
  const topics = uniq(all.map(c => c.topic)).sort();
  const fcounts = {}; all.forEach(c => { fcounts[c.format] = (fcounts[c.format] || 0) + 1; });
  let cards = all.filter(c => {
    if (reviewFilter.topic !== "全部" && c.topic !== reviewFilter.topic) return false;
    if (reviewFormat.size && !reviewFormat.has(c.format)) return false;
    const q = reviewFilter.q.trim().toLowerCase();
    if (q && ![c.title, c.summary, c.mine, c.ai, c.source].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
  $("#content").innerHTML = `
    <header class="masthead"><h1>回顾 · 知识卡片</h1><p class="sub">读过什么 · 我的想法 · AI 辅助 —— 三层分开存，可写入本地 Markdown</p></header>
    <div class="toolbar">
      <input id="rv-q" class="search" placeholder="搜索卡片…" value="${esc(reviewFilter.q)}">
      <select id="rv-topic" class="selectish">${["全部", ...topics].map(v => opt(v, reviewFilter.topic)).join("")}</select>
      <button id="rv-new" class="icon-btn"><span class="plus">＋</span>写一条</button>
      ${all.length ? `<button id="rv-export" class="icon-btn" title="导出为 Markdown">↧ 导出</button>` : ""}
    </div>
    ${all.length ? facetHTML(reviewFormat, fcounts) : ""}
    <div id="rv-form"></div>
    ${cards.length ? `<div class="kgrid">${cards.map(kcardHTML).join("")}</div>`
      : `<div class="empty">${all.length ? "没有匹配的卡片" : "还没有知识卡片。<br>在阅读时写下想法、点「存为知识卡片」，或在这里「写一条」。"}</div>`}`;
  const q = $("#rv-q"); q.oninput = () => { reviewFilter.q = q.value; renderReview(); const n = $("#rv-q"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  $("#rv-topic").onchange = e => { reviewFilter.topic = e.target.value; renderReview(); };
  $("#rv-new").onclick = toggleNewCardForm;
  const ex = $("#rv-export"); if (ex) ex.onclick = exportCards;
  $("#content").querySelectorAll("[data-fmt]").forEach(b => b.onclick = () => { const f = b.dataset.fmt; reviewFormat.has(f) ? reviewFormat.delete(f) : reviewFormat.add(f); renderReview(); });
  $("#content").querySelectorAll(".kcard [data-del]").forEach(b => b.onclick = ev => { ev.stopPropagation(); const cs = getCards().filter(c => c.id !== b.dataset.del); saveCards(cs); renderRail(); renderReview(); });
  $("#content").querySelectorAll(".kcard").forEach(el => el.onclick = () => { if (el.dataset.entry) openReader(el.dataset.entry); });
}
function kcardHTML(c) {
  const f = FMT[c.format] || FMT.article;
  const layer = (cls, lab, val) => val ? `<div class="kc-layer"><span class="kl ${cls}">${lab}</span><p>${esc(val)}</p></div>` : "";
  const d = c.createdAt ? new Date(c.createdAt) : null;
  return `<article class="kcard" ${c.entryId ? `data-entry="${esc(c.entryId)}"` : ""}>
    <div class="kc-head"><span class="kc-fmt" style="color:${f.color}">${ficon(f.id, 13)}</span>
      <h3>${esc(c.title || "未命名卡片")}</h3>
      <button class="kc-del" data-del="${esc(c.id)}" title="删除">×</button></div>
    ${layer("", "原文要点", c.summary)}
    ${layer("mine", "我的想法", c.mine)}
    ${layer("ai", "AI 辅助 · 非原文", c.ai)}
    <div class="kc-foot">${[c.source, c.topic, FMT[c.format]?.label, d ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}` : ""].filter(Boolean).map(esc).join(" · ")}${c.link ? ` · <a href="${esc(c.link)}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">源 ↗</a>` : ""}</div>
  </article>`;
}
function toggleNewCardForm() {
  const box = $("#rv-form");
  if (box.innerHTML) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="newcard">
    <input id="nc-title" placeholder="卡片标题 / 一个想法的题目">
    <textarea id="nc-mine" rows="3" placeholder="写下你的想法…"></textarea>
    <div class="nc-row"><select id="nc-topic" class="selectish">${["（无主题）", ...uniq(ENTRIES.map(e => e.main_topic)).sort()].map(v => opt(v, "（无主题）")).join("")}</select>
      <button class="btn-primary" id="nc-save">存为卡片</button></div></div>`;
  $("#nc-save").onclick = () => {
    const t = $("#nc-title").value.trim(), m = $("#nc-mine").value.trim();
    if (!t && !m) { $("#nc-title").focus(); return; }
    const cs = getCards(); cs.unshift({ id: "c" + Date.now() + Math.random().toString(36).slice(2, 6), entryId: null, title: t || m.slice(0, 24), source: "", link: "", topic: $("#nc-topic").value === "（无主题）" ? "" : $("#nc-topic").value, format: "article", summary: "", mine: m, ai: "", createdAt: Date.now() });
    saveCards(cs); renderRail(); renderReview();
  };
}
function exportCards() {
  const cs = getCards(); if (!cs.length) return;
  const md = cs.map(c => {
    const d = c.createdAt ? new Date(c.createdAt) : null;
    return `## ${c.title || "未命名卡片"}\n\n> ${[c.source, c.topic, FMT[c.format]?.label, d ? d.toLocaleDateString() : ""].filter(Boolean).join(" · ")}${c.link ? `　[源](${c.link})` : ""}\n\n**原文要点**\n${c.summary || "—"}\n\n**我的想法**\n${c.mine || "—"}\n\n**AI 辅助（非原文）**\n${c.ai || "—"}\n`;
  }).join("\n---\n\n");
  const blob = new Blob([`# 阅读卡片导出\n\n${md}`], { type: "text/markdown" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "阅读卡片.md"; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- 阅读抽屉 ---------- */
let currentId = null;
function openReader(id) {
  const e = ENTRIES.find(x => x.id === id); if (!e) return;
  currentId = id; lastAI = "";
  const f = FMT[formatOf(e)], dls = deepLinks(id), link = sourceLinkOf(e);
  const body = e.article_path
    ? `<iframe class="article-frame" id="artframe" src="${esc(e.article_path)}" title="原文"></iframe>`
    : `<div class="no-body"><p>本文未保存本地正文，正文以原网页为准。</p>${e.why ? `<p class="why">${esc(e.why)}</p>` : ""}${link ? `<a class="btn-primary" href="${esc(link)}" target="_blank" rel="noreferrer">打开原网页 ↗</a>` : ""}</div>`;
  const assetsHTML = dls.length ? `<div class="assets-wrap"><div class="lab">深读资产</div><div class="asset-grid">${dls.map(l => {
    const kind = l.type === "cross_pack" ? "跨篇包" : l.type === "rendered_markdown" ? "结构化稿" : "本篇深读";
    return `<button class="asset-card" data-url="${esc(l.url)}"><span class="ico">${l.type === "cross_pack" ? "❖" : "✦"}</span><span class="meta"><span class="name">${esc(l.label || "深读资产")}</span><span class="kind">${kind}</span></span></button>`;
  }).join("")}</div></div>` : "";

  $("#reader").innerHTML = `
    <div class="rhead"><div class="topline"><span class="ctype" style="color:${f.color}">${ficon(f.id)}<span>${f.label}</span></span>
      <button class="close" id="rclose" title="关闭 (Esc)">×</button></div>
      <h2>${esc(e.title || "无标题")}</h2>
      <div class="meta"><span class="src">${esc(e.source_name || "")}</span>${e.author_or_guest ? `<span>· ${esc(e.author_or_guest)}</span>` : ""}<span>· ${esc(e.published_date || e.publication_date_label || "")}</span>${link ? `<span>· <a href="${esc(link)}" target="_blank" rel="noreferrer">原网页 ↗</a></span>` : ""}</div></div>
    <div class="rbody"><div class="rscroll">
      <div class="state-bar"><span class="lab">我的状态</span>${STATE_OPTIONS.map(s => `<button class="state-btn ${getStatus(id) === s ? "active" : ""}" data-state="${s}">${s}</button>`).join("")}</div>
      <div class="ai-panel" id="aipanel"><div class="ai-head" id="aihead"><span class="spark">✦</span><span class="label">AI 辅助</span><span class="note">非原文 · 用你自己的模型</span></div>
        <div class="ai-body"><div class="ai-actions"><button class="ai-btn" data-ai="summary">总结要点</button><button class="ai-btn" data-ai="questions">帮我列追问</button></div>
          <div class="ai-ask"><input id="aiq" placeholder="就这篇问一个问题…"><button class="ai-btn" data-ai="ask">提问</button></div>
          <div class="ai-out" id="aiout"></div></div></div>
      <div class="note-box"><div class="nb-head"><span class="nb-lab">我的想法 / 标注</span></div>
        <textarea id="mynote" rows="3" placeholder="读到的灵感、疑问、和你自己的判断…（自动保存）">${esc(getNote(id))}</textarea>
        <div class="nb-actions">
          <button class="btn-ghost save-card" id="savecard">＋ 存为知识卡片</button>
          <button class="btn-ghost gen-card" id="gencard"><span class="spark2">✦</span> AI 生成卡片</button>
        </div></div>
      ${assetsHTML}
      <div class="article-wrap">${body}</div>
    </div></div>`;

  $("#rclose").onclick = closeReader;
  $("#reader").querySelectorAll(".state-btn").forEach(b => b.onclick = () => { setStatus(id, b.dataset.state); $("#reader").querySelectorAll(".state-btn").forEach(x => x.classList.toggle("active", x.dataset.state === getStatus(id))); });
  $("#aihead").onclick = () => $("#aipanel").classList.toggle("open");
  $("#reader").querySelectorAll("[data-ai]").forEach(b => b.onclick = () => runAI(b.dataset.ai, e));
  const nb = $("#mynote"); nb.oninput = () => setNote(id, nb.value.trim());
  $("#savecard").onclick = () => saveCardFromReader(e);
  $("#gencard").onclick = () => aiGenerateCard(e);
  $("#reader").querySelectorAll(".asset-card").forEach(b => b.onclick = () => { const fr = $("#artframe"); if (fr) { fr.src = b.dataset.url; fr.scrollIntoView({ behavior: "smooth" }); } else window.open(b.dataset.url, "_blank"); });
  const frame = $("#artframe"); if (frame) frame.onload = () => { try { frame.style.height = Math.max(frame.contentWindow.document.body.scrollHeight + 40, 400) + "px"; } catch { frame.style.height = "78vh"; } };
  $("#scrim").classList.add("open"); $("#reader").classList.add("open");
}
function closeReader() { $("#reader").classList.remove("open"); $("#scrim").classList.remove("open"); currentId = null; if (mode === "read") renderContent(); }
function saveCardFromReader(e) {
  const btn = $("#savecard"), note = ($("#mynote").value || "").trim();
  const cs = getCards();
  cs.unshift({ id: "c" + Date.now() + Math.random().toString(36).slice(2, 6), entryId: e.id, title: e.title || "", source: e.source_name || "", link: sourceLinkOf(e), topic: e.main_topic || "", format: formatOf(e), summary: e.summary || "", mine: note, ai: lastAI || "", createdAt: Date.now() });
  saveCards(cs); renderRail();
  btn.textContent = "已存入回顾 ✓"; btn.classList.add("done"); setTimeout(() => { btn.textContent = "＋ 存为知识卡片"; btn.classList.remove("done"); }, 1600);
}
// AI 生成卡片：AI 只填【原文要点】和【AI 辅助·延伸】，绝不替你写【我的想法】（守反应独立存放）
async function aiGenerateCard(e) {
  if (!aiReady()) { openAISettings(); return; }
  const btn = $("#gencard"); btn.disabled = true; btn.innerHTML = "AI 生成中…";
  const ctx = articleContext(e);
  const sys = "你是严谨的阅读助手。只依据提供的材料作答，不编造材料里没有的事实；信息不足直接说明。中文。";
  const user = `基于以下材料生成一张阅读卡片。严格用且仅用这两段，不要写别的：\n【原文要点】\n（3-5 条，忠实材料，不加入你的主观判断）\n【值得追问/延伸】\n（1-3 条，可以是你的延伸思考或值得验证的问题）\n\n材料：\n${ctx}`;
  try {
    const text = (await callModel(sys, user)).trim();
    let summary = text, insight = "";
    const parts = text.split(/【\s*值得追问[^】]*】/);
    if (parts.length >= 2) { summary = parts[0].replace(/【\s*原文要点\s*】/, "").trim(); insight = parts[1].trim(); }
    else summary = text.replace(/【\s*原文要点\s*】/, "").trim();
    const note = ($("#mynote").value || "").trim();
    const cs = getCards();
    cs.unshift({ id: "c" + Date.now() + Math.random().toString(36).slice(2, 6), entryId: e.id, title: e.title || "", source: e.source_name || "", link: sourceLinkOf(e), topic: e.main_topic || "", format: formatOf(e), summary, mine: note, ai: insight, createdAt: Date.now() });
    saveCards(cs); renderRail();
    btn.innerHTML = "已生成并存入回顾 ✓"; btn.classList.add("done");
    setTimeout(() => { btn.innerHTML = '<span class="spark2">✦</span> AI 生成卡片'; btn.classList.remove("done"); btn.disabled = false; }, 1800);
  } catch (err) {
    btn.innerHTML = "生成失败：" + esc(err.message); btn.disabled = false;
    setTimeout(() => { btn.innerHTML = '<span class="spark2">✦</span> AI 生成卡片'; }, 2600);
  }
}

/* ---------- AI（两种 BYO：① 浏览器直连 API ② 本地 CLI 当底座） ---------- */
function getAI() { return lsGet(LS_AI, "{}"); }
function aiReady() { const c = getAI(); return (c.mode === "cli" && HELPER.cli) || !!c.key; }
// 统一模型调用：CLI 模式经本地小助手调用所选 CLI preset；否则浏览器直连所选 provider 的端点。
async function callModel(system, user) {
  const cfg = getAI();
  if (cfg.mode === "cli" && HELPER.cli) {
    const r = await fetch("api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ system, prompt: user, cliId: cfg.cliId || "", model: cfg.cliModel || "", effort: cfg.cliEffort || "" }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || `${r.status} ${r.statusText}`);
    return (d.text || "").trim() || "(CLI 没有返回内容)";
  }
  if (!cfg.key) { openAISettings(); throw new Error("未配置模型（点右上角 AI 设置）"); }
  const endpoint = cfg.endpoint || providerById(cfg.provider || "openai").endpoint;
  const model = cfg.apiModel || cfg.model || "gpt-4o-mini";
  const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` }, body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const d = await r.json(); return d.choices?.[0]?.message?.content || "(模型没有返回内容)";
}
let aiDraft = null;
function selOpts(list, val, placeholder) {
  return `<option value="">${esc(placeholder)}</option>` + list.map(v => `<option value="${esc(v)}" ${val === v ? "selected" : ""}>${esc(v)}</option>`).join("");
}
function openAISettings() {
  const c = getAI();
  const clis = HELPER.clis || [];
  const prov0 = c.provider || "openai", p0 = providerById(prov0);
  aiDraft = {
    mode: (c.mode === "cli" && clis.length) ? "cli" : "key",
    cliId: c.cliId || (clis[0] && clis[0].id) || "",
    cliModel: c.cliModel || "", cliEffort: c.cliEffort || "",
    provider: prov0, endpoint: c.endpoint || p0.endpoint,
    apiCustom: (prov0 === "custom") || (!!(c.apiModel || c.model) && !p0.models.includes(c.apiModel || c.model)),
    apiModel: c.apiModel || c.model || (p0.models[0] || ""),
    key: c.key || "",
  };
  renderAISettings();
}
function renderAISettings() {
  const d = aiDraft, clis = HELPER.clis || [], cliAvail = clis.length > 0;
  const cur = cliFront(d.cliId), cliModels = cur ? (cur.models || []) : [], cliEfforts = cur ? (cur.efforts || []) : [];
  const prov = providerById(d.provider), provModels = prov.models || [];
  const showCustom = d.apiCustom || provModels.length === 0;
  $("#modal-root").innerHTML = `<div class="modal-scrim open" id="mscrim"><div class="modal">
    <h3>配置你自己的模型</h3>
    <p class="desc">阅读台不自带后端、不替你付费。接你自己的模型：</p>
    ${cliAvail ? `<div class="ai-mode">
      <label class="modeopt"><input type="radio" name="aimode" value="cli" ${d.mode === "cli" ? "checked" : ""}><span><b>本地 CLI</b> —— 用你已登录的 CLI 当底座，免 key</span></label>
      <label class="modeopt"><input type="radio" name="aimode" value="key" ${d.mode === "key" ? "checked" : ""}><span><b>BYO-key</b> —— 你自己的 API key</span></label>
    </div>` : ``}
    <div id="clifields" style="${cliAvail && d.mode === "cli" ? "" : "display:none"}">
      <div class="field"><label>CLI</label><select id="d-cli" class="selectish wide">${clis.map(x => `<option value="${esc(x.id)}" ${d.cliId === x.id ? "selected" : ""}>${esc(x.label || x.id)}</option>`).join("")}</select></div>
      ${cliModels.length ? `<div class="field"><label>模型</label><select id="d-climodel" class="selectish wide">${selOpts(cliModels, d.cliModel, "默认（跟随 CLI 配置）")}</select></div>` : ``}
      ${cliEfforts.length ? `<div class="field"><label>推理强度</label><select id="d-clieffort" class="selectish wide">${selOpts(cliEfforts, d.cliEffort, "默认（跟随 CLI 配置）")}</select></div>` : ``}
    </div>
    <div id="keyfields" style="${cliAvail && d.mode === "cli" ? "display:none" : ""}">
      <div class="field"><label>服务商</label><select id="d-prov" class="selectish wide">${API_PROVIDERS.map(p => `<option value="${esc(p.id)}" ${d.provider === p.id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></div>
      <div class="field"><label>API 端点</label><input id="d-endpoint" value="${esc(d.endpoint)}" placeholder="https://…/v1/chat/completions"></div>
      <div class="field"><label>模型</label>
        ${provModels.length ? `<select id="d-apimodel" class="selectish wide">${provModels.map(m => `<option value="${esc(m)}" ${!d.apiCustom && d.apiModel === m ? "selected" : ""}>${esc(m)}</option>`).join("")}<option value="__custom__" ${d.apiCustom ? "selected" : ""}>自定义模型…</option></select>` : ``}
        ${showCustom ? `<input id="d-apimodel-custom" placeholder="模型名，如 gpt-4o-mini" value="${esc(d.apiModel)}" style="margin-top:6px">` : ``}
      </div>
      <div class="field"><label>API Key</label><input id="d-key" type="password" placeholder="sk-…" value="${esc(d.key)}"></div>
    </div>
    <div class="row-btn"><button class="btn-ghost" id="m-cancel">取消</button><button class="btn-primary" id="m-save">保存</button></div>
    <p class="privacy">🔒 BYO-key：Key 只存你本浏览器，请求直发你选的端点。本地 CLI：提示词只发到你本机的小助手、由它调你的 CLI，绝不出本机。</p></div></div>`;
  $("#modal-root").querySelectorAll('input[name="aimode"]').forEach(r => r.onchange = () => { if (r.checked) { d.mode = r.value; renderAISettings(); } });
  const cs = $("#d-cli"); if (cs) cs.onchange = e => { d.cliId = e.target.value; d.cliModel = ""; d.cliEffort = ""; renderAISettings(); };
  const cm = $("#d-climodel"); if (cm) cm.onchange = e => d.cliModel = e.target.value;
  const ce = $("#d-clieffort"); if (ce) ce.onchange = e => d.cliEffort = e.target.value;
  const ps = $("#d-prov"); if (ps) ps.onchange = e => { d.provider = e.target.value; const p = providerById(d.provider); d.endpoint = p.endpoint; if (p.models.length) { d.apiCustom = false; d.apiModel = p.models[0]; } else { d.apiCustom = true; d.apiModel = ""; } renderAISettings(); };
  const ep = $("#d-endpoint"); if (ep) ep.oninput = e => d.endpoint = e.target.value.trim();
  const am = $("#d-apimodel"); if (am) am.onchange = e => { if (e.target.value === "__custom__") { d.apiCustom = true; d.apiModel = ""; } else { d.apiCustom = false; d.apiModel = e.target.value; } renderAISettings(); };
  const amc = $("#d-apimodel-custom"); if (amc) amc.oninput = e => d.apiModel = e.target.value.trim();
  const kf = $("#d-key"); if (kf) kf.oninput = e => d.key = e.target.value.trim();
  $("#m-cancel").onclick = () => $("#modal-root").innerHTML = "";
  $("#mscrim").onclick = ev => { if (ev.target.id === "mscrim") $("#modal-root").innerHTML = ""; };
  $("#m-save").onclick = () => {
    localStorage.setItem(LS_AI, JSON.stringify({ mode: d.mode, cliId: d.cliId, cliModel: d.cliModel, cliEffort: d.cliEffort, provider: d.provider, endpoint: d.endpoint, apiModel: d.apiModel, key: d.key }));
    $("#modal-root").innerHTML = ""; if (mode === "read") renderReadHead();
  };
}
function articleContext(e) {
  const fr = $("#artframe");
  if (fr) { try { const t = fr.contentWindow.document.body.innerText.trim(); if (t.length > 80) return t.slice(0, 7000); } catch {} }
  return [`标题：${e.title || ""}`, e.source_name && `来源：${e.source_name}`, e.author_or_guest && `作者/嘉宾：${e.author_or_guest}`, e.summary && `摘要：${e.summary}`, e.why && `为什么读：${e.why}`, (e.tags || []).length && `标签：${(e.tags || []).join("、")}`, "(注：未提供完整正文，以下回答基于以上元数据，请勿编造细节。)"].filter(Boolean).join("\n");
}
async function runAI(kind, e) {
  const out = $("#aiout"); if (!aiReady()) { openAISettings(); return; }
  const ctx = articleContext(e);
  const sys = "你是严谨的阅读助手。只依据提供的材料作答，不编造材料里没有的事实；信息不足时直接说明。中文，简洁，分点。";
  let user;
  if (kind === "summary") user = `请用 3-5 个要点总结这篇材料的核心观点：\n\n${ctx}`;
  else if (kind === "questions") user = `读完这篇材料后，列出 3 个最值得继续追问 / 验证的问题：\n\n${ctx}`;
  else { const q = ($("#aiq").value || "").trim(); if (!q) { $("#aiq").focus(); return; } user = `材料：\n${ctx}\n\n基于以上材料回答：${q}`; }
  out.innerHTML = `<span class="tag">AI 辅助 · 非原文</span><span class="ai-loading">正在请求你的模型…</span>`;
  try {
    const text = await callModel(sys, user);
    lastAI = text;
    out.innerHTML = `<span class="tag">AI 辅助 · 非原文</span>${esc(text)}`;
  } catch (err) { out.innerHTML = `<span class="tag">出错</span>请求失败：${esc(err.message)}。`; }
}

/* ---------- 启动 ---------- */
function render() { renderRail(); if (mode === "read") { renderReadHead(); renderContent(); } else { renderReview(); } }
document.addEventListener("keydown", e => { if (e.key === "Escape") { if ($("#modal-root").innerHTML) $("#modal-root").innerHTML = ""; else if (currentId) closeReader(); } });
(async function init() {
  readingStatus = lsGet(LS_STATUS, "{}");
  await detectStore();   // 可用则切 vault 模式，并用文件内容覆盖卡片/笔记/状态
  try { await loadData(); } catch (err) { $("#content").innerHTML = `<div class="empty">数据载入失败：${esc(err.message)}<br>请用本地服务器或预览版打开。</div>`; return; }
  $("#scrim").onclick = closeReader;
  render();
})();
