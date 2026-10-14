#!/usr/bin/env node
"use strict";
// board-sync.js: export the Open Loops text mirror from a board dump in one command, behind the
// Brain clock's lock, and stamp the result so a missed day shows up.
//
//   run --dump <dir> [--dry-run] [--wait-s 60] [--allow-shrink] [--file <md>]
//        Takes the brain-clock lock, checks the dump, plans the Inbox, exports the block and the
//        draft files, re-indexes codes to document ids and writes the stamp.
//        --dry-run takes no lock and writes nothing outside a temp copy it removes. It prints
//        what the export would change and exits with the code the real run would give.
//   status [--max-age-h 24]
//        One line. Exit 1 when the stamp is missing, holds no export, or is older than the limit.
//
// Exit codes for run: 0 exported, 1 a named failure, 2 the dump is empty, partial or unreadable
// (nothing exported), 3 the lock stayed held for the whole wait (nothing written).
//
// A dump is an ArtifactData out_dir: <dir>/items/<doc_id>.json, the document body at top level.
// Applying a plan is a board write, and only a session can do that. The plan lands in
// autodev/board-sync-plan.json for whoever applies it. The one Inbox change made here is to
// remove the plan's alreadyAppliedLines: lines whose effect the dump already shows, so the
// "to apply" count is real work. That writes only the list, under the lock, never the board.
//
// The lock is brain-clock.js's own: <claude dir>/autodev/brain-clock/lock.json, taken and dropped
// through brain-clock.js's takeLock and dropLock, so the rule has one copy. An owner is judged by
// identity, never by age: a live owner keeps it however old it is. This file adds a "by" field.
// tooling/test-board-sync.js fails when this file grows a lock rule of its own.
//
// Paths. Each is read from the environment, then from <claude dir>/autodev/runtime/config.json
// ({"boardSync": {"list": "<md>", "scriptsDir": "<dir>"}}), then from a generic default:
//   BRAIN_CLOCK_CLAUDE_DIR   ~/.claude, the same override the clock reads. It holds the lock, the
//                            stamp (autodev/board-sync.json), the plan and the code index.
//   BOARD_SYNC_LIST          boardSync.list, else <claude dir>/autodev/OUTSTANDING.md (--file wins)
//   BOARD_SYNC_SCRIPTS_DIR   boardSync.scriptsDir, else this file's folder: where board-index.js and
//                            open-loops-mirror.js live. They are the owner's own exporters, so a
//                            missing one is a named failure (exit 1) before anything is written.
//   BOARD_SYNC_CLOCK         the brain-clock.js whose lock this takes (default: the one beside this file)

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const HOME = os.homedir();
const CLAUDE_DIR = process.env.BRAIN_CLOCK_CLAUDE_DIR || path.join(HOME, ".claude");
const AUTODEV = path.join(CLAUDE_DIR, "autodev");
const STAMP = path.join(AUTODEV, "board-sync.json");
const PLAN = path.join(AUTODEV, "board-sync-plan.json");
const INDEX = path.join(AUTODEV, "board-index.json");
// The owner's runtime config, or {} when there is none or it does not parse.
function runtimeConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(AUTODEV, "runtime", "config.json"), "utf8"));
    return c && typeof c === "object" && c.boardSync && typeof c.boardSync === "object" ? c.boardSync : {};
  } catch { return {}; }
}
const CONFIG = runtimeConfig();
const CONFIG_FILE = path.join(AUTODEV, "runtime", "config.json");
const SCRIPTS = process.env.BOARD_SYNC_SCRIPTS_DIR || (typeof CONFIG.scriptsDir === "string" && CONFIG.scriptsDir) || __dirname;
const clock = require(process.env.BOARD_SYNC_CLOCK || path.join(__dirname, "brain-clock.js"));
const LOCK = clock.LOCK_PATH;
// A dump under three quarters of the last count reads as one page of a paged list, not a board.
const SHRINK_FLOOR = 0.75;
const CHILD_TIMEOUT_MS = 120 * 1000;
const DEFAULT_WAIT_S = 60;
const START = "<!-- open-loops:start";
const END = "<!-- open-loops:end -->";
// The same pattern outstanding-gate.js reads, so the stamp and the session-start line agree.
const GENERATED_RE = /Generated from the Open Loops board at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)/;

class Fail extends Error {
  constructor(exit, message) { super(message); this.exit = exit; }
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
      else { out[a.slice(2)] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function readJsonOr(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }
function firstLine(s) { return String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ""; }
function oneLine(s, n) { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
function tilde(p) {
  const a = path.resolve(String(p)).replace(/\\/g, "/");
  const h = HOME.replace(/\\/g, "/");
  return a.toLowerCase().startsWith(h.toLowerCase()) ? "~" + a.slice(h.length) : a;
}
function ageText(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return h >= 48 ? `${Math.floor(h / 24)} days` : h >= 1 ? `${h}h` : `${m} min`;
}
function listPath(o) {
  if (typeof o.file === "string") return path.resolve(o.file);
  return process.env.BOARD_SYNC_LIST || (typeof CONFIG.list === "string" && CONFIG.list) || path.join(AUTODEV, "OUTSTANDING.md");
}
// Which account ran it. A Desktop session on the default account leaves CLAUDE_CONFIG_DIR unset.
function account() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env ? { configDir: tilde(env), configDirFrom: "CLAUDE_CONFIG_DIR" } : { configDir: tilde(path.join(HOME, ".claude")), configDirFrom: "default" };
}

// ---------- lock: brain-clock.js's own ----------
function tryLock(now) { return clock.takeLock(now, { waitMs: 0, by: "board-sync" }); }
function takeLock(waitMs) {
  return clock.takeLock(Date.now(), { waitMs, by: "board-sync" });
}
function dropLock() { return clock.dropLock(); }

// ---------- the dump and the block ----------
function checkDump(dir) {
  const idir = path.join(dir, "items");
  if (!fs.existsSync(idir) || !fs.statSync(idir).isDirectory()) throw new Fail(2, `no items folder under the dump ${tilde(dir)}, so nothing was exported`);
  const files = fs.readdirSync(idir).filter((f) => f.endsWith(".json"));
  if (!files.length) throw new Fail(2, `the dump ${tilde(dir)} holds no items. Refusing to export an empty board over the block`);
  const bad = [];
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(idir, f), "utf8")); } catch { j = null; }
    if (!j || typeof j !== "object" || Array.isArray(j)) bad.push(f);
  }
  if (bad.length) throw new Fail(2, `${bad.length} of ${files.length} dump files are not a JSON object (first: ${bad[0]}), so nothing was exported`);
  return files.length;
}
function priorCount() {
  const s = readJsonOr(STAMP, null);
  if (s && Number.isInteger(s.items) && s.exportedAt) return { n: s.items, from: "the last sync" };
  const i = readJsonOr(INDEX, null);
  if (i && i.counts && Number.isInteger(i.counts.documents)) return { n: i.counts.documents, from: `the code index of ${String(i.generatedAt).slice(0, 10)}` };
  return null;
}
function checkShrink(count, allow) {
  const prior = priorCount();
  if (!prior || allow || count >= Math.ceil(prior.n * SHRINK_FLOOR)) return;
  throw new Fail(2, `the dump holds ${count} items but ${prior.from} read ${prior.n}. That looks like one page of a paged list. Re-dump following next_cursor, or pass --allow-shrink if the board really shrank`);
}
function readBlock(file) {
  if (!fs.existsSync(file)) throw new Fail(1, `no list at ${tilde(file)}`);
  const text = fs.readFileSync(file, "utf8");
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  const ib = e < 0 ? -1 : text.indexOf("\n## Inbox", e);
  if (s < 0 || e < s || ib < e) throw new Fail(1, `the open-loops markers or the Inbox heading after them are missing in ${tilde(file)}`);
  const lineEnd = text.indexOf("-->", s) + 3;
  const body = text.slice(lineEnd, e);
  const g = GENERATED_RE.exec(body);
  return { text, body, recorded: (text.slice(s, lineEnd).match(/sha256=([0-9a-f]+)/) || [])[1] || null, actual: sha(body), generatedAt: g ? g[1] : null };
}
function refuseHandEdit(b, file, dry) {
  if (!b.recorded || b.recorded === b.actual) return;
  throw new Fail(1, `the block in ${tilde(file)} was edited by hand since its last export (sha ${b.actual}, recorded ${b.recorded}). ${dry ? "A real run would refuse. " : "Nothing written. "}Move those edits into the Inbox or onto the board, then delete " sha256=${b.recorded}" from the start marker so the next export may overwrite the block`);
}

// ---------- children ----------
function child(script, argv, what) {
  if (!fs.existsSync(path.join(SCRIPTS, script))) throw new Fail(1, `${what} needs ${script}, and ${tilde(SCRIPTS)} has none. Set BOARD_SYNC_SCRIPTS_DIR, or boardSync.scriptsDir in ${tilde(CONFIG_FILE)}`);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...argv], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 << 20 });
  const said = firstLine(r.stderr) || firstLine(r.stdout);
  if (r.error) throw new Fail(1, `${what} did not finish: ${r.error.code || r.error.message}${said ? `. It printed: ${oneLine(said, 200)}` : ""}`);
  if (r.status !== 0) throw new Fail(1, `${what} exited ${r.status}: ${oneLine(said, 300) || "no output"}`);
  return r;
}
function planCounts(p) {
  const n = (k) => (Array.isArray(p && p[k]) ? p[k].length : null);
  const ig = Array.isArray(p && p.ignored) ? p.ignored : null;
  // A plan from before 2026-10-12 has no kinds: every ignored entry was a parse failure.
  const notParsed = ig ? ig.filter((i) => !i.kind || i.kind === "not-parsed").length : null;
  return { apply: n("apply"), alreadyApplied: n("alreadyAppliedLines"), conflicts: n("conflicts"), notParsed, notBoardCodes: ig ? ig.length - notParsed : null };
}

// ---------- the local ask queue ----------
// Every Inbox line the plan would apply is accepted into ask-queue.js, keyed by the line, so it has a
// stable intent id and survives whatever account next reaches the board. Accepting is idempotent, so
// a line seen on every run stays one intent. A queue failure never fails the export: it is reported.
function queueInbox(p) {
  try {
    const queue = require(path.join(path.dirname(process.env.BOARD_SYNC_CLOCK || path.join(__dirname, "brain-clock.js")), "ask-queue.js"));
    const lines = Array.isArray(p && p.apply) ? p.apply.map((a) => a && a.line).filter((l) => typeof l === "string" && l.trim()) : [];
    let created = 0;
    for (const line of lines) if (queue.accept({ source: "inbox", body: line, by: "board-sync" }).created) created++;
    return { accepted: lines.length, created };
  } catch (e) {
    return { error: oneLine(e && e.message, 200) };
  }
}

// ---------- run ----------
function run(o) {
  const dump = path.resolve(o.dump);
  const list = listPath(o);
  const waitS = o["wait-s"] === undefined ? DEFAULT_WAIT_S : Number(o["wait-s"]);
  if (!(waitS >= 0)) throw new Fail(1, "--wait-s needs a number of seconds, 0 or more");
  const started = Date.now();
  const lock = takeLock(waitS * 1000);
  if (!lock.acquired) throw new Fail(3, `the ${lock.by} lock is held by pid ${lock.holder} (${lock.ageSec}s old) and stayed held for the ${waitS}s wait. Nothing written`);
  const lines = [];
  if (lock.stolenFrom) lines.push(`board-sync: took over a stale lock left by pid ${lock.stolenFrom}`);
  let exported = null;
  try {
    const items = checkDump(dump);
    checkShrink(items, !!o["allow-shrink"]);
    refuseHandEdit(readBlock(list), list, false);
    fs.mkdirSync(AUTODEV, { recursive: true });
    child("open-loops-mirror.js", ["plan", "--dump", dump, "--file", list, "--out", PLAN], "the Inbox plan");
    const plan = planCounts(readJsonOr(PLAN, null));
    const queued = queueInbox(readJsonOr(PLAN, null));
    child("open-loops-mirror.js", ["export", "--dump", dump, "--file", list, "--already-applied", PLAN], "the export");
    // Exit 0 is a claim. The block must carry this run's time and a sha that matches it.
    const after = readBlock(list);
    const gen = after.generatedAt ? Date.parse(after.generatedAt) : NaN;
    if (!(gen >= Math.floor(started / 60000) * 60000) || after.recorded !== after.actual) {
      throw new Fail(1, `the export exited 0 but the block does not carry this run's export (block time ${after.generatedAt || "none"}, sha ${after.recorded === after.actual ? "matches" : "does not match"})`);
    }
    exported = Object.assign({ exportedAt: new Date(gen).toISOString(), blockGeneratedAt: after.generatedAt, items }, plan, { queue: queued }, account(),{ dump: tilde(dump), list: tilde(list), planFile: tilde(PLAN) });
    child("board-index.js", ["index", dump, "--out", INDEX], "the code index");
    const ix = readJsonOr(INDEX, {}).counts || {};
    exported.index = { documents: ix.documents ?? null, mismatched: ix.mismatched ?? null, duplicateCodes: ix.duplicateCodes ?? null };
    exported.finishedAt = new Date().toISOString();
    writeJson(STAMP, Object.assign(readJsonOr(STAMP, {}) || {}, exported, { lastAttempt: { at: exported.finishedAt, exit: 0, reason: null } }));
    lines.push(`board-sync: exported ${items} items at ${after.generatedAt} into ${tilde(list)}. Plan: ${plan.apply} Inbox lines to apply, ${plan.alreadyApplied ?? 0} already on the board, removed from the Inbox, ${plan.conflicts} conflicts, ${plan.notParsed} not parsed, ${plan.notBoardCodes ?? 0} ignored as no board code. Index: ${exported.index.mismatched} codes differ from their id. Queue: ${queued.error ? `not written, ${queued.error}` : `${queued.accepted} Inbox asks held in the local ask queue, ${queued.created} new`}. Run by ${exported.configDir}.`);
    return { exit: 0, lines };
  } catch (e) {
    const fail = e instanceof Fail ? e : new Fail(1, `unexpected error: ${e && e.message}`);
    try {
      const prev = readJsonOr(STAMP, {}) || {};
      writeJson(STAMP, Object.assign(prev, exported || {}, { lastAttempt: Object.assign({ at: new Date().toISOString(), exit: fail.exit, reason: oneLine(fail.message, 400) }, account()) }));
    } catch { /* the failure line still prints */ }
    fail.lines = lines;
    throw fail;
  } finally {
    dropLock();
  }
}

// ---------- dry run: nothing written outside a temp copy ----------
function sections(body) {
  const out = [];
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^## (.+?)(?: \((\d+)\))?\s*$/.exec(line);
    if (h) { cur = { name: h[1], codes: [] }; out.push(cur); continue; }
    const r = /^\| ([^|]+?) \|/.exec(line);
    if (cur && r && r[1].trim() !== "Code") cur.codes.push(r[1].trim());
  }
  return out;
}
function openCodes(secs) { return new Set(secs.filter((s) => !/^(Closed|Not applied)\b/.test(s.name)).flatMap((s) => s.codes)); }
function mdFiles(dir) {
  const m = new Map();
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.endsWith(".md") && fs.statSync(p).isFile()) m.set(f, fs.readFileSync(p, "utf8"));
  }
  return m;
}
function dryRun(o) {
  const dump = path.resolve(o.dump);
  const list = listPath(o);
  const items = checkDump(dump);
  checkShrink(items, !!o["allow-shrink"]);
  const before = readBlock(list);
  refuseHandEdit(before, list, true);
  const planOut = child("open-loops-mirror.js", ["plan", "--dump", dump, "--file", list], "the Inbox plan");
  let plan = null;
  try { plan = JSON.parse(planOut.stdout); } catch { plan = null; }
  const pc = planCounts(plan);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "board-sync-dry-"));
  let after;
  let drafts;
  try {
    const copy = path.join(tmp, path.basename(list));
    fs.copyFileSync(list, copy);
    const realDrafts = mdFiles(path.join(path.dirname(list), "open-loops"));
    fs.mkdirSync(path.join(tmp, "open-loops"));
    for (const [f, c] of realDrafts) fs.writeFileSync(path.join(tmp, "open-loops", f), c, "utf8");
    const tmpPlan = path.join(tmp, "plan.json");
    fs.writeFileSync(tmpPlan, planOut.stdout, "utf8");
    child("open-loops-mirror.js", ["export", "--dump", dump, "--file", copy, "--already-applied", tmpPlan], "the export (on a temp copy)");
    after = readBlock(copy);
    const next = mdFiles(path.join(tmp, "open-loops"));
    drafts = { written: [...next].filter(([f, c]) => realDrafts.get(f) !== c).length, removed: [...realDrafts.keys()].filter((f) => !next.has(f)).length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const bs = sections(before.body);
  const as = sections(after.body);
  const was = openCodes(bs);
  const now = openCodes(as);
  const added = [...now].filter((c) => !was.has(c));
  const gone = [...was].filter((c) => !now.has(c));
  const counts = new Map(bs.map((s) => [s.name, s.codes.length]));
  const moved = as.filter((s) => counts.get(s.name) !== s.codes.length).map((s) => `${s.name} ${counts.has(s.name) ? counts.get(s.name) : 0} -> ${s.codes.length}`);
  for (const s of bs) if (!as.some((x) => x.name === s.name)) moved.push(`${s.name} ${s.codes.length} -> gone`);
  const show = (a) => (a.length ? a.slice(0, 10).join(", ") + (a.length > 10 ? `, and ${a.length - 10} more` : "") : "none");
  const ix = readJsonOr(INDEX, null);
  const held = readJsonOr(LOCK, null);
  const lines = [
    `board-sync dry run on ${tilde(list)}. Nothing written.`,
    `  dump: ${items} items${ix && ix.counts ? ` (the code index holds ${ix.counts.documents} from ${String(ix.generatedAt).slice(0, 10)})` : ""}`,
    `  plan: ${pc.apply} Inbox lines to apply, ${pc.alreadyApplied ?? 0} already on the board (a real run removes them from the Inbox), ${pc.conflicts} conflicts, ${pc.notParsed} not parsed, ${pc.notBoardCodes ?? 0} ignored as no board code. Every other Inbox line is kept`,
    `  block: exported ${before.generatedAt || "never"}, would be ${after.generatedAt}`,
    `  sections: ${moved.length ? moved.join(", ") : "no count changes"}`,
    `  open rows added: ${show(added)}`,
    `  open rows gone: ${show(gone)}`,
    `  draft files: ${drafts.written} would be written, ${drafts.removed} removed`,
    `  lock: ${held ? `present, pid ${held.pid} since ${held.at}. A real run waits for it` : "free"}`,
  ];
  return { exit: 0, lines };
}

// ---------- status ----------
function status(o) {
  const maxH = o["max-age-h"] === undefined ? 24 : Number(o["max-age-h"]);
  if (!(maxH > 0)) throw new Fail(1, "--max-age-h needs a positive number of hours");
  if (!fs.existsSync(STAMP)) return { exit: 1, line: `board-sync: STALE, no stamp at ${tilde(STAMP)}, so no sync has run here.` };
  const s = readJsonOr(STAMP, null);
  if (!s || typeof s !== "object") return { exit: 1, line: `board-sync: STALE, the stamp at ${tilde(STAMP)} is not readable JSON.` };
  const at = Date.parse(s.exportedAt);
  const la = s.lastAttempt;
  const failedSince = la && la.exit !== 0 && !(Date.parse(la.at) <= at);
  const tail = failedSince ? ` Last attempt ${la.at} exited ${la.exit}: ${oneLine(la.reason, 300)}` : "";
  if (!Number.isFinite(at)) return { exit: 1, line: `board-sync: STALE, the stamp records no export.${tail}` };
  const age = Date.now() - at;
  const stale = age > maxH * 3600000;
  // Counted apart so "to apply" means real work. A stamp written before 2026-10-12 has no count.
  const applied = Number.isInteger(s.alreadyApplied) ? `, ${s.alreadyApplied} already on the board and removed from the Inbox` : "";
  return {
    exit: stale ? 1 : 0,
    line: `board-sync: ${stale ? "STALE" : "fresh"}, exported ${ageText(age)} ago (${s.exportedAt}), ${s.items} items, ${s.conflicts} conflicts, ${s.apply} Inbox lines to apply${applied}, run by ${s.configDir}, limit ${maxH}h.${tail}`,
  };
}

function main(argv) {
  const o = args(argv);
  const cmd = o._[0];
  if (!cmd || o.help || cmd === "help") {
    process.stdout.write(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 36).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  try {
    if (cmd === "run") {
      if (typeof o.dump !== "string") throw new Fail(1, "run needs --dump <dir>");
      const out = o["dry-run"] ? dryRun(o) : run(o);
      process.stdout.write(out.lines.join("\n") + "\n");
      return out.exit;
    }
    if (cmd === "status") {
      const s = status(o);
      process.stdout.write(s.line + "\n");
      return s.exit;
    }
    throw new Fail(1, `unknown command ${cmd}`);
  } catch (e) {
    const fail = e instanceof Fail ? e : new Fail(1, `unexpected error: ${e && e.message}`);
    if (fail.lines && fail.lines.length) process.stdout.write(fail.lines.join("\n") + "\n");
    process.stderr.write(`board-sync: exit ${fail.exit}. ${fail.message}\n`);
    return fail.exit;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { tryLock, takeLock, dropLock, readBlock, sha, LOCK, GENERATED_RE };
