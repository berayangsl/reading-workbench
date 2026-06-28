// Reading Workbench local helper
// It serves the static app and, when configured, exposes /api/* endpoints that
// write knowledge cards, notes, and reading status to local markdown/json files.
//
// Cards are human-readable markdown with frontmatter and separated sections for
// source notes, personal thoughts, and AI assistance. The helper only writes
// inside the configured notes directory.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, normalize, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8766;

// === Notes directory ==========================================================
// Resolution order:
// 1. VAULT_CARDS_DIR environment variable
// 2. untracked vault.local.json
// 3. repository-local _vault_out fallback
function readLocalConfig() {
  const cfg = join(ROOT, "vault.local.json");
  if (existsSync(cfg)) { try { return JSON.parse(readFileSync(cfg, "utf8")); } catch {} }
  return {};
}
const LOCAL = readLocalConfig();
function resolveVaultDir() {
  if (process.env.VAULT_CARDS_DIR) return resolve(process.env.VAULT_CARDS_DIR);
  if (LOCAL.vaultCardsDir) return resolve(LOCAL.vaultCardsDir);
  return resolve(ROOT, "_vault_out");
}
const VAULT_CARDS_DIR = resolveVaultDir();

// Local CLI model providers, for example "claude -p", "codex exec", or
// "ollama run llama3". Commands are configured server-side; the browser sends
// only prompts and whitelisted option values.
function loadClis() {
  if (Array.isArray(LOCAL.aiClis) && LOCAL.aiClis.length) return LOCAL.aiClis.filter(c => c && c.cmd);
  const cmd = (process.env.AI_CLI || LOCAL.aiCli || "").trim();
  if (!cmd) return [];
  return [{ id: "cli", label: (cmd.split(" ")[0] || "CLI"), cmd, modelArg: LOCAL.aiCliModelArg || "", effortArg: LOCAL.aiCliEffortArg || "", models: Array.isArray(LOCAL.aiCliModels) ? LOCAL.aiCliModels : [], efforts: Array.isArray(LOCAL.aiCliEfforts) ? LOCAL.aiCliEfforts : [] }];
}
const CLIS = loadClis();
const cliById = id => CLIS.find(c => c.id === id) || CLIS[0];
const CARDS_DIR = join(VAULT_CARDS_DIR, "卡片");
const STATE_DIR = join(VAULT_CARDS_DIR, "_state");
const NOTES_FILE = join(STATE_DIR, "notes.json");
const STATUS_FILE = join(STATE_DIR, "reading-status.json");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
};

// === Local file store =========================================================
async function ensureDirs() {
  await mkdir(CARDS_DIR, { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });
  await ensureReadme();
}
let readmeDone = false;
async function ensureReadme() {
  if (readmeDone) return; readmeDone = true;
  const p = join(VAULT_CARDS_DIR, "README.md");
  try { await readFile(p); return; } catch {}
  const txt = `# Reading Workbench Cards

This directory is maintained by the Reading Workbench local helper.

- \`卡片/\` stores one markdown file per knowledge card.
- \`_state/\` stores \`notes.json\` and \`reading-status.json\`.

The helper only writes inside this directory. If the helper is not running, the app uses browser localStorage.
`;
  await writeFile(p, txt);
}

const yqApply = s => `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function slugify(s) {
  return String(s || "card").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "card";
}
function cardFilename(c) {
  const base = slugify(c.title || c.mine || "card");
  const sfx = String(c.id || "").replace(/[^a-z0-9]/gi, "").slice(-8) || "x";
  return `${base}__${sfx}.md`;
}
function cardToMd(c) {
  const fm = [
    "---",
    "type: reading-card",
    `id: ${yqApply(c.id)}`,
    `entryId: ${yqApply(c.entryId || "")}`,
    `title: ${yqApply(c.title || "")}`,
    `source: ${yqApply(c.source || "")}`,
    `link: ${yqApply(c.link || "")}`,
    `topic: ${yqApply(c.topic || "")}`,
    `format: ${yqApply(c.format || "article")}`,
    `createdAt: ${Number(c.createdAt) || 0}`,
    "---",
  ].join("\n");
  // 三层永远分开成节，绝不揉成一段。
  const body = [
    "",
    "## 原文要点",
    "",
    (c.summary || "").trim(),
    "",
    "## 我的想法",
    "",
    (c.mine || "").trim(),
    "",
    "## AI 辅助 · 非原文",
    "",
    (c.ai || "").trim(),
    "",
  ].join("\n");
  return fm + "\n" + body;
}
function parseCardMd(txt) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(txt);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const mm = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    meta[mm[1]] = v;
  }
  if (meta.type !== "reading-card") return null;
  // 按 "## " 标题切节
  const sections = {};
  const body = "\n" + m[2];
  const parts = body.split(/\n## /).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const head = (nl < 0 ? p : p.slice(0, nl)).trim();
    const val = (nl < 0 ? "" : p.slice(nl + 1)).trim();
    sections[head] = val;
  }
  return {
    id: meta.id, entryId: meta.entryId || null, title: meta.title || "",
    source: meta.source || "", link: meta.link || "", topic: meta.topic || "",
    format: meta.format || "article", createdAt: Number(meta.createdAt) || 0,
    summary: sections["原文要点"] || "",
    mine: sections["我的想法"] || "",
    ai: sections["AI 辅助 · 非原文"] || sections["AI 辅助·非原文"] || "",
  };
}
async function readCards() {
  let files = [];
  try { files = await readdir(CARDS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try {
      const c = parseCardMd(await readFile(join(CARDS_DIR, f), "utf8"));
      if (c && c.id) out.push({ ...c, _file: f });
    } catch {}
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // 与前端 unshift（新在前）一致
  return out;
}
// 全量替换：写入当前所有卡片，删除本目录内被删卡片对应的 md（只动 type: reading-card 的文件）。
async function writeCards(cards) {
  await ensureDirs();
  const existing = await readCards();          // 含 _file
  const byId = new Map(existing.map(c => [c.id, c._file]));
  const keepIds = new Set(cards.map(c => c.id));
  // 删除孤儿（被删除的卡片）
  for (const c of existing) {
    if (!keepIds.has(c.id)) { try { await unlink(join(CARDS_DIR, c._file)); } catch {} }
  }
  // 写入 / 更新
  for (const c of cards) {
    const target = cardFilename(c);
    const old = byId.get(c.id);
    if (old && old !== target) { try { await unlink(join(CARDS_DIR, old)); } catch {} } // 标题改了→换名
    await writeFile(join(CARDS_DIR, target), cardToMd(c));
  }
}
async function readJson(file, dflt) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return dflt; }
}
async function writeJson(file, obj) {
  await ensureDirs();
  await writeFile(file, JSON.stringify(obj, null, 2));
}

// === HTTP ========================================================================
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, no) => {
    let b = ""; req.on("data", d => { b += d; if (b.length > 5e6) req.destroy(); });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
    req.on("error", no);
  });
}

// 调本地 CLI 当模型底座：提示词从 stdin 喂给服务端配置的 AI_CLI。
// 取答案两种约定：① 命令含 {out} 占位 → 替换成临时文件、命令把"最终答案"写该文件、读它（适合 codex/claude
//   这类 agent CLI：stdout 夹进度日志，用 -o/--output-last-message 拿干净答案）；② 否则直接收 stdout（如 ollama）。
const reSafe = v => /^[\w.\-:]+$/.test(String(v || ""));   // 白名单值只含安全字符
function buildCliBase(preset, model, effort) {
  let cmd = preset.cmd;
  const models = Array.isArray(preset.models) ? preset.models : [];
  const efforts = Array.isArray(preset.efforts) ? preset.efforts : [];
  const mOk = model && models.includes(model) && reSafe(model);   // 只接受白名单内的值
  const eOk = effort && efforts.includes(effort) && reSafe(effort);
  // 模型：命令含 {model} 占位（如 "ollama run {model}"）→ 直接替换；否则用 modelArg 追加（如 codex "-m {v}"）。
  if (cmd.includes("{model}")) cmd = cmd.split("{model}").join(mOk ? model : (models[0] || ""));
  else if (mOk && preset.modelArg) cmd += " " + preset.modelArg.split("{v}").join(model);
  if (cmd.includes("{effort}")) cmd = cmd.split("{effort}").join(eOk ? effort : "");
  else if (eOk && preset.effortArg) cmd += " " + preset.effortArg.split("{v}").join(effort);
  return cmd;
}
let cliSeq = 0;
async function runCli(input, cliId, model, effort) {
  const preset = cliById(cliId); if (!preset) throw new Error("无可用 CLI preset");
  const base = buildCliBase(preset, model, effort);
  const useFile = base.includes("{out}");
  const outPath = useFile ? join(tmpdir(), `rw04-cli-${process.pid}-${++cliSeq}-${input.length}.txt`) : null;
  const cmd = useFile ? base.split("{out}").join(`'${outPath}'`) : base;
  const stdout = await new Promise((ok, no) => {
    const child = spawn(cmd, { shell: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); no(new Error("CLI 超时（180s）")); }, 180000);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("error", e => { clearTimeout(timer); no(e); });
    child.on("close", code => { clearTimeout(timer); (code === 0 || out.trim() || useFile) ? ok(out) : no(new Error(err.trim() || `CLI 退出码 ${code}`)); });
    try { child.stdin.write(input); child.stdin.end(); } catch (e) { clearTimeout(timer); no(e); }
  });
  if (useFile) {
    try { const txt = await readFile(outPath, "utf8"); await unlink(outPath).catch(() => {}); return txt; }
    catch { throw new Error("CLI 未写出结果文件（检查命令里的 -o/{out}）。stdout 尾部：" + stdout.slice(-300)); }
  }
  return stdout;
}

async function handleApi(req, res, path) {
  try {
    if (path === "/api/health" && req.method === "GET")
      return send(res, 200, {
        ok: true, vault: VAULT_CARDS_DIR, cardsDir: CARDS_DIR, cli: CLIS.length > 0,
        clis: CLIS.map(c => ({ id: c.id, label: c.label || c.id, models: c.modelArg ? (c.models || []) : [], efforts: c.effortArg ? (c.efforts || []) : [] })),
      });
    if (path === "/api/ai" && req.method === "POST") {
      if (!CLIS.length) return send(res, 400, { ok: false, error: "本地 CLI 未配置：在 vault.local.json 设 aiClis（或老式 aiCli）" });
      const body = await readBody(req);
      const input = [body.system || "", "", body.prompt || ""].join("\n").trim();
      if (!input) return send(res, 400, { ok: false, error: "空提示词" });
      try { const text = await runCli(input, body.cliId, body.model, body.effort); return send(res, 200, { ok: true, text: text.trim() }); }
      catch (e) { return send(res, 500, { ok: false, error: String(e && e.message || e) }); }
    }
    if (path === "/api/store" && req.method === "GET") {
      const [cards, notes, status] = await Promise.all([
        readCards(), readJson(NOTES_FILE, {}), readJson(STATUS_FILE, {}),
      ]);
      return send(res, 200, { cards: cards.map(({ _file, ...c }) => c), notes, status });
    }
    if (path === "/api/cards" && req.method === "POST") {
      const body = await readBody(req);
      await writeCards(Array.isArray(body.cards) ? body.cards : []);
      return send(res, 200, { ok: true, count: (body.cards || []).length });
    }
    if (path === "/api/notes" && req.method === "POST") {
      const body = await readBody(req);
      await writeJson(NOTES_FILE, body.notes || {});
      return send(res, 200, { ok: true });
    }
    if (path === "/api/status" && req.method === "POST") {
      const body = await readBody(req);
      await writeJson(STATUS_FILE, body.status || {});
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: "unknown api" });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message || e) });
  }
}

createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { res.writeHead(400); return res.end("Bad request"); }

  if (path.startsWith("/api/")) return handleApi(req, res, path);

  // Static files
  try {
    let p = path; if (p === "/") p = "/index.html";
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`reading-workbench v0.4 on http://localhost:${PORT}`);
  console.log(`本地写回助手已启用 → vault: ${VAULT_CARDS_DIR}`);
});
