#!/usr/bin/env node
"use strict";
// brain-clock.js: the Brain's clock. No model in the loop.
//
// Windows Task Scheduler runs `tick --observe` every 5 minutes. One bounded pass reads every
// fleet source, diffs it against the previous pass and appends one event per change to
// ~/.claude/autodev/events.jsonl. An observe pass settles nothing, relaunches nothing, messages
// nobody and writes no board.
//
//   tick --observe [--now <iso>]     one observe pass.
//   tick --act <caps> [--live] [--grace-min 15] [--now <iso>]
//                                    the observe pass, then act. caps is a comma list of
//                                    mark-dead, settle-finished, settle-unattended and judge. Without --live it is a dry
//                                    run: would-* events only, and no ledger is written.
//   health [--max-age-min 15]        exit 1 when the last pass is stale or the last 3 failed
//   events [--tail 20]               prints the last N events
//
// Every source reports its population, and an unreadable one reports COULD-NOT-READ and keeps
// its previous entries, so a read failure never reads as everything disappearing.
// Timestamps come from this process's clock, never from a model.
//
// Acting (G7 step 1). Each capability is off unless named, and dry unless --live.
//   mark-dead        a running record with no exit line whose pid no probe can find, quiet
//                    for the grace. Live, it runs `headless-worker.js settle --lost`.
//   settle-finished  a running record whose log has the exit line and whose report has a
//                    RESULT line for its code, quiet for the grace. Live, it runs plain `settle`.
//   settle-unattended  a started unattended-worker record whose report's last line is a RESULT
//                    line for its own slug, and whose Desktop session is no longer running:
//                    archived, or its last turn ended and it has been quiet for the grace.
//                    Live, it runs `unattended-worker.js settle --report-read` and appends
//                    act.delete-scheduled-task, because only a Brain turn can call
//                    delete_scheduled_task. The same capability appends unattended-stranded
//                    once for a started record whose session has been quiet for 30 minutes
//                    with no RESULT line: a worker that stopped to ask a question.
//   judge            runs `worker-reconcile.js tick` and then `brain-judge.js tick`, once each per
//                    pass, with --live when the pass is live, and relays their lines and events
//                    (sources worker-reconcile and brain-judge). The reconcile tick settles and
//                    closes every reserved headless attempt first, so the judge reads settled
//                    records. brain-judge closes, judges and starts the headless-channel queue
//                    behind its own kill switch, caps and breaker, so a live clock does not make it
//                    live. Both run even when a source is unreadable: they read none of the clock's
//                    sources. A failed tick is one reconcile.tick-failed or judge.tick-failed event
//                    per distinct error, never a failed pass, and a failed reconcile still lets the
//                    judge run. A reconcile outcome is relayed once, not every pass it repeats.
// Each ledger keeps one writer: the clock only spawns headless-worker.js, keyed on code plus
// startedAt, or unattended-worker.js, keyed on task id, and reports COULD-NOT-ACT when the
// script cannot take the key. It acts on nothing when any source was unreadable in this pass,
// and never twice on one record.
//
// Stalled missions. Every pass, observe or act, lists the mission-queue.js files beside it whose
// owner stopped with pending work and has not touched the queue for BRAIN_CLOCK_STALL_MIN minutes
// (default 60). It is a read like the sources, so it is always on and acts on no session: one
// mission.stalled event per mission (source mission-queue, key the mission file id), relayed once
// while it repeats, and one mission.recovered when it clears. A missions directory that cannot be
// listed is one COULD-NOT-CHECK line and one mission.check-failed event per distinct error, keeps
// what was stalled before, and never fails the pass.
//
// Which code runs. Every helper is the copy BESIDE this file, so a pass runs one release end to
// end. The clock never scans the plugin cache for the newest version: that would undo a rollback
// the moment a newer cache directory appeared. runtime-release.js pins the release a scheduler
// runs, by version and file hashes, and launches this file from it.
//
// State schema. STATE_SCHEMA names the layout of <claude dir>/autodev/brain-clock. A pass records
// it in state-meta.json, and a clock whose schema is older than the recorded one refuses its pass
// and writes nothing, so a rolled-back clock never rewrites state it cannot read.
// runtime-release.js activate restores a compatible backup before such a rollback.
//
// Paths, overridable for the suite:
//   BRAIN_CLOCK_CLAUDE_DIR   ~/.claude
//   BRAIN_CLOCK_DESKTOP_DIR  %APPDATA%/Claude, else the MSIX package copy (resolveDesktopDir)
//   BRAIN_CLOCK_ROLE_CHECKER check-brain-role.js (default: beside this file), "off" skips it
//   BRAIN_CLOCK_GH_FIXTURE   a JSON file standing in for gh: {"open": {repo: [pr]}, "view": {"repo#n": pr}}
//   BRAIN_CLOCK_HEADLESS_WORKER  headless-worker.js (default: beside this file)
//   BRAIN_CLOCK_UNATTENDED_WORKER  unattended-worker.js (default: beside this file)
//   BRAIN_CLOCK_BRAIN_JUDGE  brain-judge.js (default: beside this file), "off" skips it
//   BRAIN_CLOCK_WORKER_RECONCILE  worker-reconcile.js (default: beside this file), "off" skips it
//   AUTODEV_MISSIONS_DIR     <claude dir>/autodev/missions, as mission-queue.js reads it
//   BRAIN_CLOCK_STALL_MIN    60, minutes a mission with pending work may sit idle
//   BRAIN_CLOCK_PS           Git's MSYS ps (default: found beside git), "off" means absent.
//                            A path ending in .js runs through node, for the suite.
// The lock is ledger-lock.js beside this file, the operating lock every ledger writer shares.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const ledgerLock = require("./ledger-lock.js");

const CLAUDE_DIR = process.env.BRAIN_CLOCK_CLAUDE_DIR || path.join(os.homedir(), ".claude");
// The Desktop app is an MSIX package: its own child processes see %APPDATA%/Claude virtualized,
// while a Task Scheduler process sees only the package's real copy under
// %LOCALAPPDATA%/Packages/Claude_<id>/LocalCache/Roaming/Claude. Measured 2026-09-23: 129 scheduled
// passes read both Desktop stores as ENOENT while the same path listed fine from a Desktop shell.
function resolveDesktopDir(env) {
  if (env.BRAIN_CLOCK_DESKTOP_DIR) return env.BRAIN_CLOCK_DESKTOP_DIR;
  const direct = path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude");
  if (fs.existsSync(path.join(direct, "claude-code-sessions"))) return direct;
  const pkgs = path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Packages");
  let names = [];
  try { names = fs.readdirSync(pkgs).filter((n) => /^Claude_/.test(n)).sort(); } catch { /* no Packages dir: fall through */ }
  for (const n of names) {
    const d = path.join(pkgs, n, "LocalCache", "Roaming", "Claude");
    if (fs.existsSync(path.join(d, "claude-code-sessions"))) return d;
  }
  return direct;
}
const DESKTOP_DIR = resolveDesktopDir(process.env);
const AUTODEV = path.join(CLAUDE_DIR, "autodev");
const STATE_DIR = path.join(AUTODEV, "brain-clock");
const EVENTS = path.join(AUTODEV, "events.jsonl");
// The layout of STATE_DIR this clock reads and writes. Raise it with any incompatible change.
const STATE_SCHEMA = 1;
const STATE_META = path.join(STATE_DIR, "state-meta.json");
// A lock with no readable owner (its writer died between create and body) is abandoned after this.
const LOCK_OWNERLESS_MS = ledgerLock.OWNERLESS_MS;
// The reconcile tick settles records and hands verify to a detached child, so it is short.
const RECONCILE_TIMEOUT_MS = 60 * 1000;
const FAIL_STREAK_UNHEALTHY = 3;
// A cron slot counts as missed only after this grace, so a run that starts a minute late is not one.
const MISS_GRACE_MS = 20 * 60 * 1000;
const CRON_LOOKBACK_MIN = 32 * 1440;
const GH_TIMEOUT_MS = 30 * 1000;
const TERMINAL = new Set(["settled", "done", "finished", "closed", "stopped", "failed", "error", "died", "dead", "exited"]);
// Acting.
const CAPS = ["mark-dead", "settle-finished", "settle-unattended", "judge"];
const HEADLESS_CAPS = ["mark-dead", "settle-finished"];
// A started unattended record whose session is this quiet with no RESULT line stopped to ask.
const STRANDED_MS = 30 * 60 * 1000;
const GRACE_MIN_DEFAULT = 15;
// A mission with pending work idle this long is stalled.
const STALL_MIN_DEFAULT = 60;
const GRACE_MIN_FLOOR = 5;
const PROBE_TIMEOUT_MS = 10 * 1000;
const WRITER_TIMEOUT_MS = 30 * 1000;
// The task kills a pass after 4 minutes, so live acting stops early and the rest waits a pass.
const MAX_LIVE_ACTS = 10;
const ACT_BUDGET_MS = 90 * 1000;
// The judge tick gets what is left of the pass under this, less a margin to write the pass.
const PASS_LIMIT_MS = 225 * 1000;
const JUDGE_MARGIN_MS = 20 * 1000;
const JUDGE_MIN_BUDGET_MS = 30 * 1000;
const LOG_TAIL_BYTES = 64 * 1024;
const REPORT_TAIL_BYTES = 1024 * 1024;
const EXIT_LINE_RE = /^CLAUDE_EXIT=(-?\d+)\s*$/gm;
const RESULT_STATES = ["done", "stopped", "failed"];

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); }
function readJsonOr(p, fallback) { try { return readJson(p); } catch { return fallback; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { encoding: "utf8" });
  fs.renameSync(tmp, p);
}
function ms(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function expandHome(p) { return String(p).replace(/^~(?=[\\/]|$)/, os.homedir()); }

// ---------- lock: one writer ----------
// <claude dir>/autodev/brain-clock/lock.json, the operating lock of ledger-lock.js beside this file.
// An owner is judged by identity, never by age: a live owner keeps the lock however long its pass
// runs, a reused pid does not keep a dead owner's lock, reclaim is serialized by tickets, and only
// the holder releases. A second scheduler that starts a pass while one runs finds the lock held and
// skips. board-sync.js and runtime-release.js take this lock through these two functions.
const LOCK_PATH = path.join(STATE_DIR, "lock.json");
let heldLock = null;
function holderOf(cur, now, why) {
  return { acquired: false, holder: cur ? cur.pid : null, by: (cur && cur.by) || "brain-clock", ageSec: cur && cur.at ? Math.round((now - Date.parse(cur.at)) / 1000) : 0, why };
}
function takeLock(now, { waitMs = 0, by = null } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const meta = by ? { at: iso(now), by } : { at: iso(now) };
  const h = ledgerLock.acquireLock(LOCK_PATH, { waitMs, meta });
  if (!h.acquired) return holderOf(h.holder, now, h.why);
  heldLock = h;
  return { acquired: true, stolenFrom: h.reclaimed ? (h.reclaimed.owner ? h.reclaimed.owner.pid : null) : null };
}
function dropLock() {
  const h = heldLock;
  heldLock = null;
  if (h && h.release) return h.release();
  return { released: false, why: "this process holds no lock" };
}

// ---------- sources ----------
// Each returns { population, entries: { key: {...} } } or throws. The caller turns a throw into COULD-NOT-READ.

function workerState(rec, fallback) {
  let state = String(rec.state || fallback || "unknown");
  if (!TERMINAL.has(state) && Number.isInteger(rec.pid) && !pidAlive(rec.pid)) state = "dead";
  return state;
}

function srcHeadless() {
  const doc = readJson(path.join(AUTODEV, "headless-workers.json"));
  const entries = {};
  for (const r of doc.records || []) {
    entries[`${r.code}@${r.startedAt}`] = { state: workerState(r), result: r.result || null, code: r.code, sentence: r.sentence || null };
  }
  // records goes to the act pass only. The snapshot keeps entries, as before.
  return { population: `${(doc.records || []).length} records`, entries, records: doc.records || [] };
}
function srcUnattended() {
  const doc = readJson(path.join(AUTODEV, "unattended-workers.json"));
  const entries = {};
  for (const r of doc.records || []) entries[r.taskId] = { state: String(r.state || "unknown"), result: r.runStatus || null, code: r.slug || r.taskId };
  // records goes to the act pass only, as for headless.
  return { population: `${(doc.records || []).length} records`, entries, records: doc.records || [] };
}
function srcBgRunner() {
  const doc = readJson(path.join(AUTODEV, "bg-runner.json"));
  const entries = {};
  for (const w of doc.workers || []) entries[`${w.code}@${w.id}`] = { state: String(w.state || "unknown"), result: w.closedFrom || null, code: w.code };
  return { population: `${(doc.workers || []).length} workers`, entries };
}
function srcRuns() {
  const root = path.join(AUTODEV, "runs");
  const entries = {};
  let runs = 0; let asks = 0; let answers = 0; let unreadable = 0;
  for (const job of fs.readdirSync(root)) {
    const jd = path.join(root, job);
    if (!fs.statSync(jd).isDirectory()) continue;
    for (const stamp of fs.readdirSync(jd)) {
      const d = path.join(jd, stamp);
      if (!fs.statSync(d).isDirectory()) continue;
      const id = `${job}/${stamp}`;
      if (fs.existsSync(path.join(d, "status.json"))) {
        const s = readJsonOr(path.join(d, "status.json"), null);
        if (s) { runs++; entries[`run:${id}`] = { state: String(s.state || "unknown"), result: s.exitCode === undefined ? null : s.exitCode, code: job }; } else unreadable++;
      }
      if (fs.existsSync(path.join(d, "ask.json"))) {
        const a = readJsonOr(path.join(d, "ask.json"), {});
        asks++; entries[`ask:${id}`] = { state: "open", code: job, header: a.header || null };
      }
      if (fs.existsSync(path.join(d, "answer.json"))) {
        const a = readJsonOr(path.join(d, "answer.json"), {});
        answers++; entries[`answer:${id}`] = { state: "answered", code: job, label: a.label || null, by: a.by || null };
      }
    }
  }
  return { population: `${runs} status.json, ${asks} ask.json, ${answers} answer.json${unreadable ? `, ${unreadable} unparseable` : ""}`, entries };
}
function srcInbox() {
  const root = path.join(AUTODEV, "inbox");
  const entries = {};
  let projects = 0;
  for (const proj of fs.readdirSync(root)) {
    const pd = path.join(root, proj);
    if (!fs.statSync(pd).isDirectory()) continue;
    projects++;
    for (const f of fs.readdirSync(pd)) {
      if (fs.statSync(path.join(pd, f)).isFile()) entries[`${proj}/${f}`] = { state: "present", code: proj };
    }
  }
  return { population: `${Object.keys(entries).length} files in ${projects} projects`, entries };
}
// The local ask queue (ask-queue.js beside this file). A missing queue is zero intents, not a failure.
// Held, unacknowledged and conflicted intents become events, so work waiting on reconciliation shows.
function srcAskQueue() {
  const s = require(path.join(__dirname, "ask-queue.js")).status();
  const entries = {};
  for (const [id, state] of Object.entries(s.intents)) entries[id] = { state };
  const c = s.counts;
  return { population: `${s.total} intents, ${c.pending} pending, ${c.held + c.unacknowledged} held, ${c.conflict} in conflict, board adapter ${s.adapter}`, entries };
}
// A helper script from the same release as this clock: the copy beside this file, or null.
// The plugin cache is never scanned, so a newer cache directory cannot replace a pinned release.
function releaseScript(file) {
  const p = path.join(__dirname, file);
  return fs.existsSync(p) ? p : null;
}
function roleChecker() {
  const env = process.env.BRAIN_CLOCK_ROLE_CHECKER;
  if (env) return env === "off" ? null : env;
  return releaseScript("check-brain-role.js");
}
function srcBrainRole() {
  const p = path.join(CLAUDE_DIR, "brain-role.json");
  if (!fs.existsSync(p)) return { population: "no brain-role.json", entries: { brain: { state: "absent" } }, homeRepos: [] };
  const role = readJson(p);
  let verdict = "unchecked";
  const checker = roleChecker();
  if (checker) {
    const r = spawnSync(process.execPath, [checker], { encoding: "utf8", timeout: 20000, windowsHide: true });
    const m = /brain-role:\s*([A-Z-]+)/.exec(r.stdout || "");
    verdict = m ? m[1].toLowerCase() : `checker-exit-${r.status}`;
  }
  return {
    population: `1 role file, checker ${checker ? "ran" : "absent"}, verdict ${verdict}`,
    entries: { brain: { state: verdict, session: role.session_id || null, code: role.peer_name || null, claimedAt: role.claimed_at || null } },
    homeRepos: Array.isArray(role.home_repos) ? role.home_repos : [],
  };
}
function ghJson(argv, cwd) {
  const r = spawnSync("gh", argv, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true, shell: false });
  if (r.error) throw new Error(`gh ${argv.slice(0, 2).join(" ")}: ${r.error.code || r.error.message}`);
  if (r.status !== 0) throw new Error(`gh ${argv.slice(0, 2).join(" ")} exit ${r.status}: ${String(r.stderr).trim().slice(0, 160)}`);
  return JSON.parse(r.stdout);
}
function makeGh() {
  const fx = process.env.BRAIN_CLOCK_GH_FIXTURE;
  if (fx) {
    const doc = readJson(fx);
    return {
      open: (repo) => { if (!doc.open || !(repo in doc.open)) throw new Error(`fixture has no open list for ${repo}`); return doc.open[repo]; },
      view: (repo, n) => { const v = (doc.view || {})[`${repo}#${n}`]; if (!v) throw new Error(`fixture has no view for ${repo}#${n}`); return v; },
    };
  }
  return {
    open: (repo) => ghJson(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,headRefName,createdAt"], expandHome(repo)),
    view: (repo, n) => ghJson(["pr", "view", String(n), "--json", "state,mergedAt,closedAt"], expandHome(repo)),
  };
}
function srcPrs(homeRepos) {
  const gh = makeGh();
  const entries = {};
  const failures = [];
  for (const repo of homeRepos) {
    let list;
    try { list = gh.open(repo); } catch (e) { failures.push(`${repo}: ${e.message}`); continue; }
    for (const pr of list) entries[`${repo}#${pr.number}`] = { state: "open", code: pr.headRefName || null, title: String(pr.title || "").slice(0, 120) };
  }
  if (homeRepos.length && failures.length === homeRepos.length) throw new Error(failures.join("; "));
  return { population: `${Object.keys(entries).length} open PRs across ${homeRepos.length - failures.length}/${homeRepos.length} repos${failures.length ? ` (COULD-NOT-READ ${failures.join("; ")})` : ""}`, entries, gh };
}
function desktopStores() {
  const root = path.join(DESKTOP_DIR, "claude-code-sessions");
  const out = [];
  for (const acct of fs.readdirSync(root)) {
    const ad = path.join(root, acct);
    if (!fs.statSync(ad).isDirectory()) continue;
    for (const org of fs.readdirSync(ad)) {
      const od = path.join(ad, org);
      if (fs.statSync(od).isDirectory()) out.push({ acct, org, dir: od });
    }
  }
  return out;
}
function srcDesktopSessions() {
  const entries = {};
  // sessions goes to the act pass only, so the snapshot keeps the entries it always had.
  const sessions = {};
  let total = 0; let unreadable = 0;
  for (const s of desktopStores()) {
    for (const f of fs.readdirSync(s.dir)) {
      if (!/^local_.*\.json$/.test(f)) continue;
      total++;
      const r = readJsonOr(path.join(s.dir, f), null);
      if (!r) { unreadable++; continue; }
      const id = r.sessionId || f.slice(0, -5);
      entries[id] = {
        state: r.isArchived ? "archived" : "open",
        code: String(r.title || "").slice(0, 80),
        task: r.scheduledTaskId || null,
      };
      // A turn has ended when its post-turn summary is for the last assistant message.
      // `[measured 2026-09-26]` true on every finished worker session with a summary, and
      // false on the two running ones, which had none yet.
      sessions[id] = {
        archived: !!r.isArchived,
        lastActivityAt: ms(r.lastActivityAt),
        turnEnded: !!r.postTurnSummaryFor && r.postTurnSummaryFor === r.lastAssistantUuid,
        summary: r.postTurnSummary && typeof r.postTurnSummary.status_detail === "string" ? r.postTurnSummary.status_detail.slice(0, 200) : null,
      };
    }
  }
  const open = Object.values(entries).filter((e) => e.state === "open").length;
  return { population: `${total} session records, ${open} not archived${unreadable ? `, ${unreadable} unparseable` : ""}`, entries, sessions };
}

// Minimal 5-field cron (minute hour dom month dow) in local time: *, */n, a-b, a-b/n, lists.
function cronField(spec, lo, hi) {
  const set = new Set();
  for (const part of String(spec).split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad cron field ${spec}`);
    let a = lo; let b = hi;
    if (m[1] !== "*") { a = Number(m[2]); b = m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : a); }
    const step = m[4] ? Number(m[4]) : 1;
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}
function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: ${expr}`);
  const dow = cronField(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return { min: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31), mon: cronField(f[3], 1, 12), dow, domAny: f[2] === "*", dowAny: f[4] === "*" };
}
function cronMatches(c, d) {
  if (!c.min.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate()); const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}
// The latest slot at or before `at`, or null inside the lookback.
function prevCronSlot(expr, at) {
  const c = parseCron(expr);
  const d = new Date(at); d.setSeconds(0, 0);
  for (let i = 0; i < CRON_LOOKBACK_MIN; i++) {
    if (cronMatches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() - 1);
  }
  return null;
}
function srcRoutines(now) {
  const entries = {};
  let files = 0; let tasks = 0;
  for (const s of desktopStores()) {
    const p = path.join(s.dir, "scheduled-tasks.json");
    if (!fs.existsSync(p)) continue;
    files++;
    const doc = readJson(p);
    for (const t of doc.scheduledTasks || []) {
      tasks++;
      const key = `${s.acct.slice(0, 8)}/${t.id}`;
      const lastRun = ms(t.lastRunAt);
      let missedSlot = null;
      if (t.enabled) {
        const ref = ms(t.lastScheduledFor) ?? lastRun ?? ms(t.createdAt) ?? 0;
        if (t.cronExpression) {
          let slot = null;
          try { slot = prevCronSlot(t.cronExpression, now - MISS_GRACE_MS); } catch { slot = null; }
          if (slot !== null && slot > ref) missedSlot = slot;
        } else if (ms(t.fireAt) !== null && ms(t.fireAt) + MISS_GRACE_MS < now && !(lastRun !== null && lastRun >= ms(t.fireAt) - 60000)) {
          missedSlot = ms(t.fireAt);
        }
      }
      entries[key] = {
        state: t.enabled ? "enabled" : "disabled",
        code: t.id,
        lastRunAt: lastRun === null ? null : iso(lastRun),
        missedSlot: missedSlot === null ? null : iso(missedSlot),
        cron: t.cronExpression || null,
      };
    }
  }
  return { population: `${tasks} tasks in ${files} scheduled-tasks.json`, entries };
}

// ---------- diff ----------
function workerEvent(prev, cur) {
  if (!prev) return TERMINAL.has(cur.state) ? "worker.seen-finished" : "worker.started";
  if (prev.state === cur.state && prev.result === cur.result) return null;
  if (cur.state === "dead" || cur.state === "died") return "worker.died";
  if (TERMINAL.has(cur.state)) return /fail|error/i.test(`${cur.result} ${cur.state}`) ? "worker.failed" : "worker.done";
  return "worker.state";
}

function diff(name, prevEntries, curEntries, ctx) {
  const events = [];
  const add = (type, key, cur, prev) => events.push({ type, source: name, key, detail: { from: prev ? prev.state : null, to: cur ? cur.state : null, ...(cur || prev ? pick(cur || prev) : {}) } });
  const keys = new Set([...Object.keys(prevEntries), ...Object.keys(curEntries)]);
  for (const key of [...keys].sort()) {
    const p = prevEntries[key]; const c = curEntries[key];
    if (name === "headless" || name === "unattended" || name === "bg-runner") {
      if (c) { const t = workerEvent(p, c); if (t) add(t, key, c, p); } else add("worker.removed", key, null, p);
    } else if (name === "runs") {
      const kind = key.split(":")[0];
      if (!p && c) add(kind === "run" ? (TERMINAL.has(c.state) ? "run.seen-finished" : "run.started") : kind === "ask" ? "ask.opened" : "ask.answered", key, c, p);
      else if (p && c && kind === "run" && p.state !== c.state) add(TERMINAL.has(c.state) ? (c.result && c.result !== 0 ? "run.failed" : "run.finished") : "run.state", key, c, p);
      else if (p && !c) add(kind === "ask" ? "ask.closed" : `${kind}.removed`, key, null, p);
    } else if (name === "inbox") {
      if (!p && c) add("inbox.received", key, c, p);
      else if (p && !c) add("inbox.cleared", key, null, p);
    } else if (name === "ask-queue") {
      const flag = (st) => (st === "held" || st === "unacknowledged" ? "intent.held" : st === "conflict" ? "intent.conflict" : null);
      const t = c ? flag(c.state) : null;
      if (t && (!p || flag(p.state) !== t)) add(t, key, c, p);
    } else if (name === "brain-role") {
      if (p && c && p.session !== c.session) add("brain.claimed", key, c, p);
      else if (!p && c && ctx.hadPrevious) add("brain.claimed", key, c, p);
      else if (p && c && p.state !== c.state) add(c.state === "ok" ? "brain.healthy" : "brain.unhealthy", key, c, p);
    } else if (name === "prs") {
      if (!p && c) add("pr.opened", key, c, p);
      else if (p && !c) {
        let type = "pr.closed-or-merged";
        try {
          const [repo, n] = [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)];
          const v = ctx.gh.view(repo, n);
          type = v.mergedAt || v.state === "MERGED" ? "pr.merged" : v.state === "OPEN" ? "pr.unlisted" : "pr.closed";
        } catch { /* stays closed-or-merged: the view could not be read */ }
        add(type, key, null, p);
      }
    } else if (name === "desktop-sessions") {
      if (!p && c) add(c.state === "archived" ? "session.seen-archived" : "session.started", key, c, p);
      else if (p && c && p.state !== c.state) add(c.state === "archived" ? "session.archived" : "session.unarchived", key, c, p);
      else if (p && !c) add("session.deleted", key, null, p);
    } else if (name === "routines") {
      if (!p && c) add("routine.added", key, c, p);
      else if (p && !c) add("routine.removed", key, null, p);
      else if (p && c) {
        if (c.lastRunAt && c.lastRunAt !== p.lastRunAt) add("routine.ran", key, c, p);
        if (p.state !== c.state) add(c.state === "enabled" ? "routine.enabled" : "routine.disabled", key, c, p);
      }
      if (c && c.missedSlot && (!p || p.missedSlot !== c.missedSlot)) add("routine.missed", key, c, p);
    }
  }
  return events;
}
function pick(e) {
  const out = {};
  for (const k of ["code", "result", "title", "label", "by", "sentence", "session", "lastRunAt", "missedSlot", "cron", "header", "task"]) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  return out;
}

// ---------- act ----------
// The clock never writes a ledger. A live act is a spawn of headless-worker.js, the ledger's one
// writer, and a dry run only appends would-* events.

function parseAct(opts) {
  const out = { caps: null, live: false, graceMs: GRACE_MIN_DEFAULT * 60000 };
  if (opts.act !== undefined) {
    if (opts.act === true) return { error: `--act needs a comma list of ${CAPS.join(", ")}` };
    const caps = [...new Set(String(opts.act).split(",").map((s) => s.trim()).filter(Boolean))];
    const bad = caps.filter((c) => !CAPS.includes(c));
    if (!caps.length || bad.length) return { error: `--act takes ${CAPS.join(", ")}, not ${bad.join(", ") || "an empty list"}` };
    out.caps = caps;
  }
  if (opts.live !== undefined) {
    if (opts.live !== true) return { error: "--live takes no value" };
    if (!out.caps) return { error: "--live needs --act <caps>" };
    out.live = true;
  }
  if (opts["grace-min"] !== undefined) {
    const g = Number(opts["grace-min"]);
    if (!Number.isFinite(g) || g < GRACE_MIN_FLOOR) return { error: `--grace-min is a number of minutes, at least ${GRACE_MIN_FLOOR}` };
    out.graceMs = g * 60000;
  }
  return out;
}

// The mtime and the last bytes of a file. Missing is { text: null }. Anything else is { error }.
function fileFacts(p, tailBytes) {
  if (!p) return { text: null, mtime: null };
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const st = fs.fstatSync(fd);
    const n = Math.min(st.size, tailBytes);
    const buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, st.size - n);
    return { text: buf.toString("utf8"), mtime: st.mtimeMs };
  } catch (e) {
    return e && e.code === "ENOENT" ? { text: null, mtime: null } : { error: (e && e.code) || "unreadable" };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}
// The readings headless-worker.js makes: the last CLAUDE_EXIT line, and the last RESULT line for this exact code.
function exitCodeOf(text) {
  let last = null;
  for (const m of String(text).matchAll(EXIT_LINE_RE)) last = Number(m[1]);
  return last;
}
function resultOf(text, code) {
  const esc = String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^RESULT\\s+${esc}\\s+(${RESULT_STATES.join("|")}):\\s*(.+)$`, "gm");
  let last = null;
  for (const m of String(text).matchAll(re)) last = m[1];
  return last;
}

// Git's MSYS ps, the only probe that knows an MSYS pid. Task Scheduler's PATH has Git\cmd and not
// Git\usr\bin, so ps is looked for beside git first. null when there is none.
function psCommand() {
  const env = process.env.BRAIN_CLOCK_PS;
  if (env) return env === "off" ? null : env;
  if (process.platform !== "win32") return "ps";
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const cands = [];
  for (const d of dirs) if (fs.existsSync(path.join(d, "git.exe"))) cands.push(path.join(d, "..", "usr", "bin", "ps.exe"), path.join(d, "..", "..", "usr", "bin", "ps.exe"));
  for (const d of dirs) cands.push(path.join(d, "ps.exe"));
  cands.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "ps.exe"));
  for (const c of cands) if (fs.existsSync(c)) return path.resolve(c);
  return null;
}
function runProbe(cmd, argv) {
  const js = /\.js$/i.test(cmd);
  return spawnSync(js ? process.execPath : cmd, js ? [cmd, ...argv] : argv, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
}
// Each probe answers alive, dead or unknown. Only ESRCH, a tasklist with no row for the pid, and
// ps exiting 1 after its header line mean dead.
function killProbe(pid) {
  try { process.kill(pid, 0); return "alive"; } catch (e) { return e.code === "ESRCH" ? "dead" : e.code === "EPERM" ? "alive" : "unknown"; }
}
function tasklistProbe(pid) {
  if (process.platform !== "win32") return "n/a";
  const r = runProbe("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  if (r.error || r.status !== 0) return "unknown";
  for (const m of String(r.stdout).matchAll(/^"[^"]*","(\d+)"/gm)) if (Number(m[1]) === pid) return "alive";
  return "dead";
}
function psProbe(pid, ps) {
  if (!ps) return "absent";
  const r = runProbe(ps, ["-p", String(pid)]);
  if (r.error) return "unknown";
  if (r.status === 0) return "alive";
  if (r.status === 1 && /\bPID\b.*\bCOMMAND\b/.test(String(r.stdout))) return "dead";
  return "unknown";
}
// A pid's liveness from three probes, because each sees a different pid space.
// `[measured 2026-09-25]` a Git Bash $$ was an MSYS pid: process.kill read ESRCH while ps -p found
// it, and ps -p exits 1 for a plain Windows pid. So a pid is dead only when every probe answered
// and none found it. A probe that cannot tell, or an absent ps, leaves the pid alive.
function pidLiveness(pid, ps) {
  const probes = {};
  const steps = [["kill", () => killProbe(pid)], ["tasklist", () => tasklistProbe(pid)], ["ps", () => psProbe(pid, ps)]];
  for (const [name, fn] of steps) {
    probes[name] = fn();
    if (probes[name] === "alive") return { verdict: "alive", probes };
  }
  const all = Object.values(probes).filter((p) => p !== "n/a");
  if (all.some((p) => p === "unknown" || p === "absent")) return { verdict: "unknown", probes };
  return { verdict: "dead", probes };
}

// What one unsettled record is ready for: { cap, ... }, or { skip: reason }.
function classify(rec, now, graceMs, caps, ps) {
  if (rec.state !== "running") return { skip: `state ${rec.state || "unknown"}` };
  if (!rec.code) return { skip: "no code" };
  const started = typeof rec.startedAt === "string" ? ms(rec.startedAt) : null;
  if (started === null) return { skip: "no startedAt" };
  const log = fileFacts(rec.log, LOG_TAIL_BYTES);
  const report = fileFacts(rec.report, REPORT_TAIL_BYTES);
  if (log.error || report.error) return { skip: "log or report unreadable" };
  // The last sign of life is the latest of the start and the log and report writes. It is never
  // before the start, so this one check also leaves a record younger than the grace untouched.
  const ageMs = now - started;
  const quietMs = now - Math.max(started, log.mtime || 0, report.mtime || 0);
  if (quietMs < graceMs) return { skip: ageMs < graceMs ? "younger than the grace" : "active within the grace" };
  const base = { code: String(rec.code), startedAt: rec.startedAt, ageMin: Math.floor(ageMs / 60000), quietMin: Math.floor(quietMs / 60000) };
  const exit = log.text === null ? null : exitCodeOf(log.text);
  if (exit !== null) {
    if (!caps.includes("settle-finished")) return { skip: "exited (settle-finished not asked)" };
    if (report.text === null) return { skip: "exited without a report" };
    if (report.mtime < started - 1000) return { skip: "exited (report from an earlier run)" };
    const result = resultOf(report.text, rec.code);
    if (!result) return { skip: "exited without a RESULT line for its code" };
    return { cap: "settle-finished", ...base, exit, result };
  }
  if (!caps.includes("mark-dead")) return { skip: "no exit line (mark-dead not asked)" };
  if (!Number.isInteger(rec.pid) || rec.pid <= 0) return { skip: "no pid" };
  const l = pidLiveness(rec.pid, ps);
  if (l.verdict === "alive") return { skip: "pid alive" };
  if (l.verdict !== "dead") return { skip: "pid cannot tell" };
  return { cap: "mark-dead", ...base, pid: rec.pid, probes: l.probes };
}

function headlessWriter() {
  const env = process.env.BRAIN_CLOCK_HEADLESS_WORKER;
  if (env) return env;
  return releaseScript("headless-worker.js");
}
function writerLabel(p) {
  const m = /[\\/](\d+\.\d+\.\d+)[\\/]scripts[\\/]/.exec(String(p));
  return m ? `headless-worker.js ${m[1]}` : path.basename(String(p));
}
// Can the writer settle ONE record of a code? A code can hold several records, so the record is
// named by --started-at too. Read from --help, which runs nothing. missing[cap] is null when it can.
function writerSupport(script) {
  const none = (reason) => ({ script, missing: Object.fromEntries(CAPS.map((c) => [c, reason])) });
  if (!script) return none("no headless-worker.js beside the clock");
  const r = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: WRITER_TIMEOUT_MS, windowsHide: true });
  if (r.error || r.status !== 0) return none(`${writerLabel(script)} --help ${r.error ? r.error.code : `exit ${r.status}`}`);
  const settle = String(r.stdout).split(/\r?\n/).filter((l) => /\bsettle\b/.test(l) && /--code\b/.test(l));
  const has = (flag) => settle.some((l) => l.includes(flag));
  const lacks = (flags) => { const m = flags.filter((f) => !has(f)); return m.length ? `${writerLabel(script)} settle has no ${m.join(" or ")}, so it cannot settle one record of a code` : null; };
  return { script, missing: { "mark-dead": lacks(["--started-at", "--lost"]), "settle-finished": lacks(["--started-at"]) } };
}
// One keyed settle through the writer. Returns { ok, state } or { ok: false, error: <writer code> }.
function runWriter(script, c, ledger) {
  const argv = [script, "settle", "--code", c.code, "--started-at", c.startedAt, ...(c.cap === "mark-dead" ? ["--lost"] : []), "--ledger", ledger];
  const r = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: WRITER_TIMEOUT_MS, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.code === "ETIMEDOUT" ? "timeout" : `spawn-${r.error.code}` };
  let doc = null;
  try { doc = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch { doc = null; }
  if (!doc || typeof doc.ok !== "boolean") return { ok: false, error: `unparseable-exit-${r.status}` };
  if (!doc.ok) return { ok: false, error: String((doc.error && doc.error.code) || "unknown") };
  return { ok: true, state: String((doc.value && doc.value.state) || "unknown") };
}

function detailOf(c) {
  const d = { cap: c.cap, code: c.code, startedAt: c.startedAt, ageMin: c.ageMin, quietMin: c.quietMin };
  if (c.cap === "mark-dead") { d.pid = c.pid; d.probes = Object.entries(c.probes).map(([k, v]) => `${k}=${v}`).join(" "); } else { d.exit = c.exit; d.result = c.result; }
  return d;
}
// What the clock has acted on, keyed on code@startedAt: 15 codes had more than one record.
// dry keys stop a repeat would-* event, live keys stop a repeat act. A dry key never blocks a live act.
function loadActed(p) {
  if (!fs.existsSync(p)) return { version: 1, dry: {}, live: {}, blocked: {}, stranded: {} };
  const doc = readJson(p);
  return { version: 1, dry: doc.dry || {}, live: doc.live || {}, blocked: doc.blocked || {}, stranded: doc.stranded || {} };
}

// ---------- act: unattended workers ----------
// The newest installed unattended-worker.js, the unattended ledger's one writer.
function unattendedWriter() {
  const env = process.env.BRAIN_CLOCK_UNATTENDED_WORKER;
  if (env) return env;
  return releaseScript("unattended-worker.js");
}
// Can the writer settle a record with its result read? Read from --help, which runs nothing.
function unattendedSupport(script) {
  if (!script) return { script, missing: "no unattended-worker.js beside the clock" };
  const r = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: WRITER_TIMEOUT_MS, windowsHide: true });
  if (r.error || r.status !== 0) return { script, missing: `${path.basename(script)} --help ${r.error ? r.error.code : `exit ${r.status}`}` };
  const ok = String(r.stdout).split(/\r?\n/).some((l) => /\bsettle\b/.test(l) && /--task-id\b/.test(l) && /--run-status\b/.test(l) && /--report-read\b/.test(l));
  return { script, missing: ok ? null : `${path.basename(script)} settle has no --task-id, --run-status or --report-read` };
}
// A RESULT line's state as a run status: a stopped run still ended and reported.
function runStatusOf(result) { return result === "failed" ? "failed" : "succeeded"; }
// The state on the report's LAST line when it is a RESULT line for this slug, else null.
function lastLineResult(text, slug) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  if (!lines.length) return null;
  const esc = String(slug).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^RESULT\\s+${esc}\\s+(${RESULT_STATES.join("|")}):\\s*(.+)$`).exec(lines[lines.length - 1]);
  return m ? { result: m[1], sentence: m[2].slice(0, 200) } : null;
}
// What one started unattended record is ready for: { cap } to settle, { stranded } to report, or { skip }.
function classifyUnattended(rec, sessions, now, graceMs) {
  if (rec.state !== "started") return { skip: `state ${rec.state || "unknown"}` };
  // A headless run has no Desktop session: headless-worker settles it and brain-judge closes it.
  if (rec.channel === "headless") return { skip: "headless channel, closed by brain-judge" };
  if (!rec.taskId || !rec.slug) return { skip: "no task id or slug" };
  const started = ms(rec.startedAt);
  if (started === null) return { skip: "no startedAt" };
  const sess = rec.sessionId ? sessions[rec.sessionId] : null;
  if (!sess) return { skip: "session not in the Desktop store" };
  const quietMs = sess.lastActivityAt === null ? null : now - Math.max(sess.lastActivityAt, started);
  const ended = sess.archived || (sess.turnEnded && quietMs !== null && quietMs >= graceMs);
  const report = fileFacts(rec.report, REPORT_TAIL_BYTES);
  if (report.error) return { skip: "report unreadable" };
  // A report older than this run is an earlier run's, whatever its last line says.
  const fresh = report.text !== null && report.mtime >= started - 1000;
  const res = fresh ? lastLineResult(report.text, rec.slug) : null;
  const base = { taskId: rec.taskId, slug: rec.slug, startedAt: rec.startedAt, session: rec.sessionId, quietMin: quietMs === null ? null : Math.floor(quietMs / 60000) };
  if (res) {
    // [measured 2026-09-26] a worker waiting its turn in the gate queue writes
    // "RESULT <slug> stopped: interim, ..." and ends its turn; it resumes when
    // the gate lands, so an interim line is progress, not an end.
    if (res.result === "stopped" && /^interim(?![a-z])/i.test(res.sentence)) return { skip: "interim report, the worker resumes" };
    if (!ended) return { skip: sess.archived || sess.turnEnded ? "reported, session quiet less than the grace" : "reported, session still running" };
    return { cap: "settle-unattended", ...base, result: res.result, runStatus: runStatusOf(res.result), sentence: res.sentence };
  }
  if (quietMs !== null && quietMs >= STRANDED_MS && !sess.archived) {
    return { stranded: true, ...base, turnEnded: sess.turnEnded, summary: sess.summary, why: report.text === null ? "no report" : fresh ? "report has no RESULT line for its slug as its last line" : "report from an earlier run" };
  }
  return { skip: report.text === null ? "no report yet" : "no RESULT line yet" };
}
function runUnattendedWriter(script, c, ledger) {
  const argv = [script, "settle", "--task-id", c.taskId, "--run-status", c.runStatus, "--report-read", "--ledger", ledger];
  const r = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: WRITER_TIMEOUT_MS, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.code === "ETIMEDOUT" ? "timeout" : `spawn-${r.error.code}` };
  let doc = null;
  try { doc = JSON.parse(String(r.stdout)); } catch { doc = null; }
  if (!doc || typeof doc.ok !== "boolean") return { ok: false, error: `unparseable-exit-${r.status}` };
  if (!doc.ok) return { ok: false, error: String((doc.error && doc.error.code) || "unknown") };
  const d = doc.value && doc.value.decision;
  if (!d || d.deleteSafe !== true) return { ok: false, error: `not-delete-safe: ${String((d && d.reason) || "no decision").slice(0, 160)}` };
  return { ok: true, state: String((doc.value.record && doc.value.record.state) || "unknown") };
}
function unattendedDetail(c) {
  return { cap: "settle-unattended", taskId: c.taskId, slug: c.slug, startedAt: c.startedAt, session: c.session, quietMin: c.quietMin, result: c.result, runStatus: c.runStatus, sentence: c.sentence };
}
function actUnattended(a, results, now, stamp, acted, out, budget) {
  const ev = (type, key, detail) => out.events.push({ type, source: "unattended", key, detail });
  const sessions = results["desktop-sessions"].sessions || {};
  const skips = {}; const todo = []; let ready = 0; let before = 0; let stranded = 0;
  for (const rec of results.unattended.records) {
    if (!rec) continue;
    const key = `unattended:${rec.taskId}@${rec.startedAt}`;
    if (rec.state === "started") out.present.add(key);
    const c = classifyUnattended(rec, sessions, now, a.graceMs);
    if (c.stranded) {
      stranded++;
      // Reported once per record: it is a fact for a Brain turn, not an act.
      if (!acted.stranded[key]) {
        ev("unattended-stranded", key, { taskId: c.taskId, slug: c.slug, session: c.session, quietMin: c.quietMin, turnEnded: c.turnEnded, why: c.why, summary: c.summary });
        acted.stranded[key] = { at: stamp };
      }
      continue;
    }
    if (!c.cap) { skips[c.skip] = (skips[c.skip] || 0) + 1; continue; }
    ready++;
    if (acted.live[key] || (!a.live && acted.dry[key])) { before++; continue; }
    todo.push({ key, ...c });
  }
  out.lines.push(`settle-unattended: ${ready} ready, ${ready - before} new, ${before} acted on before, ${stranded} stranded`);
  const skipText = Object.entries(skips).filter(([k]) => !/^state /.test(k)).sort().map(([k, n]) => `${n} ${k}`).join(", ");
  if (skipText) out.lines.push(`settle-unattended not ready: ${skipText}`);
  if (!todo.length) return;
  const support = unattendedSupport(unattendedWriter());
  if (!a.live) {
    for (const c of todo) {
      ev("act.would-settle-unattended", c.key, unattendedDetail(c));
      acted.dry[c.key] = { cap: c.cap, at: stamp };
      out.list.push(unattendedDetail(c));
    }
    if (support.missing) out.lines.push(`settle-unattended: live would be COULD-NOT-ACT: ${support.missing}`);
    return;
  }
  if (support.missing) {
    out.lines.push(`settle-unattended: COULD-NOT-ACT: ${support.missing} (${todo.length} waiting)`);
    if (acted.blocked["settle-unattended"] !== support.missing) { ev("act.could-not-act", "settle-unattended", { cap: "settle-unattended", reason: support.missing, waiting: todo.length }); acted.blocked["settle-unattended"] = support.missing; }
    return;
  }
  delete acted.blocked["settle-unattended"];
  const ledger = path.join(AUTODEV, "unattended-workers.json");
  let spawned = 0; let deferred = 0;
  for (const c of todo) {
    if (budget.spawned >= MAX_LIVE_ACTS || Date.now() > budget.deadline) { deferred++; continue; }
    budget.spawned++; spawned++;
    const r = runUnattendedWriter(support.script, c, ledger);
    if (r.ok) {
      ev("act.settled-unattended", c.key, { ...unattendedDetail(c), state: r.state });
      // A script cannot call delete_scheduled_task, so the next Brain turn does.
      ev("act.delete-scheduled-task", c.taskId, { taskId: c.taskId, session: c.session, after: "act.settled-unattended", then: `unattended-worker.js deleted --task-id ${c.taskId}` });
    } else ev("act.refused", c.key, { ...unattendedDetail(c), error: r.error });
    acted.live[c.key] = { cap: c.cap, at: stamp, outcome: r.ok ? `ok ${r.state}` : `refused ${r.error}` };
    out.list.push({ ...unattendedDetail(c), outcome: r.ok ? r.state : `refused ${r.error}` });
  }
  if (spawned) out.lines.push(`unattended writer: ${path.basename(support.script)}, ${spawned} spawned`);
  if (deferred) out.lines.push(`settle-unattended deferred to the next pass: ${deferred}`);
}

// ---------- observe: stalled missions ----------
function missionsDir() { return process.env.AUTODEV_MISSIONS_DIR || path.join(AUTODEV, "missions"); }
function stallMinutes() {
  const n = Number(process.env.BRAIN_CLOCK_STALL_MIN);
  return Number.isFinite(n) && n > 0 ? n : STALL_MIN_DEFAULT;
}
// Missions stopped with pending work, as events relayed once while they repeat. Never throws.
function observeStalls(now) {
  const out = { events: [], line: "" };
  const statePath = path.join(STATE_DIR, "stalls.json");
  const state = readJsonOr(statePath, null) || {};
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const ev = (type, key, detail) => out.events.push({ type, source: "mission-queue", key, detail });
  const minutes = stallMinutes();
  let list = null;
  try {
    list = require(path.join(__dirname, "mission-queue.js")).stalled(minutes, now, { dir: missionsDir(), strict: true });
  } catch (e) {
    const error = String(e && e.message || e).slice(0, 300);
    out.line = `missions: COULD-NOT-CHECK ${error}`;
    // What was stalled stays stalled: an unreadable directory is not a recovery.
    if (state.lastError !== error) ev("mission.check-failed", "missions", { error });
    state.lastError = error;
  }
  if (list) {
    const cur = new Set();
    for (const s of list) {
      const key = String(s.id);
      cur.add(key);
      if (seen.has(key)) continue;
      ev("mission.stalled", key, { cwd: s.cwd || null, owner: s.owner || null, mission: s.mission ? String(s.mission).slice(0, 120) : null, pending: s.pending, idleMinutes: s.idleMinutes, reason: s.reason });
    }
    for (const key of seen) if (!cur.has(key)) ev("mission.recovered", key, {});
    if (state.lastError) ev("mission.check-recovered", "missions", { after: state.lastError });
    delete state.lastError;
    state.seen = [...cur].sort();
    out.line = `missions: ${list.length} stalled, idle ${minutes}+ min`;
  }
  out.save = () => writeJson(statePath, state);
  return out;
}

// ---------- act: the judge ----------
function brainJudgeScript() {
  const env = process.env.BRAIN_CLOCK_BRAIN_JUDGE;
  if (env === "off") return null;
  if (env) return env;
  return releaseScript("brain-judge.js");
}
// One brain-judge tick. Its events are relayed, and a failure is one event per distinct error.
function actJudge(a, started) {
  const out = { events: [], lines: [] };
  const statePath = path.join(STATE_DIR, "judge.json");
  const state = readJsonOr(statePath, null) || {};
  const fail = (error) => {
    out.lines.push(`judge: COULD-NOT-ACT: ${error}`);
    if (state.lastError !== error) out.events.push({ type: "judge.tick-failed", source: "brain-judge", key: "tick", detail: { error } });
    state.lastError = error;
  };
  const script = brainJudgeScript();
  const budgetMs = PASS_LIMIT_MS - (Date.now() - started) - JUDGE_MARGIN_MS;
  if (!script) fail("no brain-judge.js beside the clock");
  else if (budgetMs < JUDGE_MIN_BUDGET_MS) out.lines.push(`judge: skipped, ${Math.round(budgetMs / 1000)} s left of the pass`);
  else {
    const argv = [script, "tick", "--budget-sec", String(Math.floor(budgetMs / 1000))];
    if (a.live) argv.push("--live");
    const r = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: budgetMs + JUDGE_MARGIN_MS / 2, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    let doc = null;
    try { doc = JSON.parse(String(r.stdout)); } catch { doc = null; }
    if (r.error) fail(r.error.code === "ETIMEDOUT" ? "timeout" : `spawn-${r.error.code}`);
    else if (!doc || typeof doc.ok !== "boolean") fail(`unparseable-exit-${r.status}`);
    else if (!doc.ok) fail(String((doc.error && doc.error.code) || "unknown"));
    else {
      const v = doc.value || {};
      for (const l of v.lines || []) out.lines.push(`judge: ${l}`);
      for (const e of v.events || []) out.events.push({ type: String(e.type), source: "brain-judge", key: String(e.key), detail: e.detail || {} });
      if (state.lastError) out.events.push({ type: "judge.tick-recovered", source: "brain-judge", key: "tick", detail: { after: state.lastError } });
      delete state.lastError;
    }
  }
  out.save = () => writeJson(statePath, state);
  return out;
}

// ---------- act: worker reconciliation ----------
function reconcileScript() {
  const env = process.env.BRAIN_CLOCK_WORKER_RECONCILE;
  if (env === "off") return null;
  if (env) return env;
  return releaseScript("worker-reconcile.js");
}
// The outcomes worth an event: anything but PENDING, and a held record only when it is released.
function reconcileRows(v) {
  const rows = [];
  for (const o of v.outcomes || []) if (o && o.outcome && o.outcome !== "PENDING") rows.push(o);
  for (const o of v.released || []) if (o && o.outcome === "RELEASE") rows.push(o);
  return rows;
}
// One worker-reconcile tick, before the judge's. Its outcomes are relayed as events, each once
// while it repeats, and a failure is one event per distinct error, never a failed pass.
function actReconcile(a) {
  const out = { events: [], lines: [] };
  const statePath = path.join(STATE_DIR, "reconcile.json");
  const state = readJsonOr(statePath, null) || {};
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const fail = (error) => {
    out.lines.push(`reconcile: COULD-NOT-ACT: ${error}`);
    if (state.lastError !== error) out.events.push({ type: "reconcile.tick-failed", source: "worker-reconcile", key: "tick", detail: { error } });
    state.lastError = error;
  };
  const script = reconcileScript();
  if (!script) fail("no worker-reconcile.js beside the clock");
  else {
    const argv = [script, "tick"];
    if (a.live) argv.push("--live");
    const r = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: RECONCILE_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    let doc = null;
    try { doc = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch { doc = null; }
    if (r.error) fail(r.error.code === "ETIMEDOUT" ? "timeout" : `spawn-${r.error.code}`);
    else if (!doc || typeof doc.ok !== "boolean") fail(`unparseable-exit-${r.status}`);
    else if (!doc.ok) fail(String((doc.error && doc.error.code) || "unknown"));
    else {
      const v = doc.value || {};
      if (v.line) out.lines.push(`reconcile: ${v.line}`);
      if (!v.skipped) {
        const now = new Set();
        for (const o of reconcileRows(v)) {
          const k = `${o.taskId}|${o.outcome}`;
          now.add(k);
          if (seen.has(k)) continue;
          const detail = { taskId: o.taskId || null, outcome: o.outcome, live: !!v.live };
          for (const f of ["why", "runStatus", "action", "applied"]) if (o[f] !== undefined) detail[f] = o[f];
          out.events.push({ type: `reconcile.${String(o.outcome).toLowerCase()}`, source: "worker-reconcile", key: String(o.taskId), detail });
        }
        state.seen = [...now].sort();
      }
      if (state.lastError) out.events.push({ type: "reconcile.tick-recovered", source: "worker-reconcile", key: "tick", detail: { after: state.lastError } });
      delete state.lastError;
    }
  }
  out.save = () => writeJson(statePath, state);
  return out;
}

function actPass(a, results, now, stamp) {
  const out = { events: [], lines: [], list: [], save: null, present: new Set() };
  const ev = (type, key, detail) => out.events.push({ type, source: "headless", key, detail });
  out.lines.push(`mode: ${a.live ? "live, through the ledgers' own writers" : "dry run, writes no ledger"}, caps ${a.caps.join(",")}, grace ${a.graceMs / 60000} min`);
  const unreadable = Object.entries(results).filter(([, r]) => !r.ok).map(([n]) => n);
  if (unreadable.length) { out.lines.push(`COULD-NOT-ACT: unreadable this pass: ${unreadable.join(", ")}`); return out; }
  const actedPath = path.join(STATE_DIR, "acted.json");
  let acted;
  try { acted = loadActed(actedPath); } catch (e) {
    out.lines.push(`COULD-NOT-ACT: acted.json is unreadable, so what was done before is unknown: ${String(e && e.message || e).slice(0, 160)}`);
    return out;
  }
  const hcaps = a.caps.filter((c) => HEADLESS_CAPS.includes(c));
  const budget = { spawned: 0, deadline: Date.now() + ACT_BUDGET_MS };
  const present = out.present;
  if (hcaps.length) {
    const ps = hcaps.includes("mark-dead") ? psCommand() : null;
    if (hcaps.includes("mark-dead")) out.lines.push(`pid probes: kill${process.platform === "win32" ? ", tasklist" : ""}, ps ${ps ? "found" : "absent, so a pid no other probe finds reads cannot tell"}`);

    const skips = {}; const ready = {}; const before = {};
    const todo = [];
    for (const rec of results.headless.records) {
      if (!rec || rec.state === "settled") continue;
      const key = `${rec.code}@${rec.startedAt}`;
      present.add(key);
      const c = classify(rec, now, a.graceMs, hcaps, ps);
      if (!c.cap) { skips[c.skip] = (skips[c.skip] || 0) + 1; continue; }
      ready[c.cap] = (ready[c.cap] || 0) + 1;
      if (acted.live[key] || (!a.live && acted.dry[key])) { before[c.cap] = (before[c.cap] || 0) + 1; continue; }
      todo.push({ key, ...c });
    }
    for (const cap of hcaps) out.lines.push(`${cap}: ${ready[cap] || 0} ready, ${(ready[cap] || 0) - (before[cap] || 0)} new, ${before[cap] || 0} acted on before`);
    const skipText = Object.entries(skips).sort().map(([k, n]) => `${n} ${k}`).join(", ");
    if (skipText) out.lines.push(`not ready: ${skipText}`);

    const support = todo.length ? writerSupport(headlessWriter()) : null;
    if (!a.live) {
      for (const c of todo) {
        ev(c.cap === "mark-dead" ? "act.would-mark-dead" : "act.would-settle", c.key, detailOf(c));
        acted.dry[c.key] = { cap: c.cap, at: stamp };
        out.list.push(detailOf(c));
      }
      for (const cap of hcaps) if (support && support.missing[cap] && todo.some((c) => c.cap === cap)) out.lines.push(`${cap}: live would be COULD-NOT-ACT: ${support.missing[cap]}`);
    } else if (support) {
      for (const cap of hcaps) {
        const waiting = todo.filter((c) => c.cap === cap).length;
        const reason = support.missing[cap];
        if (!reason) { delete acted.blocked[cap]; continue; }
        if (!waiting) continue;
        out.lines.push(`${cap}: COULD-NOT-ACT: ${reason} (${waiting} waiting)`);
        // One event per new reason, so a blocked capability does not repeat itself every pass.
        if (acted.blocked[cap] !== reason) { ev("act.could-not-act", cap, { cap, reason, waiting }); acted.blocked[cap] = reason; }
      }
      const ledger = path.join(AUTODEV, "headless-workers.json");
      let spawned = 0; let deferred = 0;
      for (const c of todo) {
        if (support.missing[c.cap]) continue;
        if (budget.spawned >= MAX_LIVE_ACTS || Date.now() > budget.deadline) { deferred++; continue; }
        budget.spawned++; spawned++;
        const r = runWriter(support.script, c, ledger);
        if (r.ok) ev(c.cap === "mark-dead" ? "act.marked-dead" : "act.settled", c.key, { ...detailOf(c), result: r.state });
        else ev("act.refused", c.key, { ...detailOf(c), error: r.error });
        // ledger-locked is the one refusal that provably wrote nothing, so only it is tried again.
        if (r.ok || r.error !== "ledger-locked") acted.live[c.key] = { cap: c.cap, at: stamp, outcome: r.ok ? `ok ${r.state}` : `refused ${r.error}` };
        out.list.push({ ...detailOf(c), outcome: r.ok ? r.state : `refused ${r.error}` });
      }
      if (spawned) out.lines.push(`writer: ${writerLabel(support.script)}, ${spawned} spawned`);
      if (deferred) out.lines.push(`deferred to the next pass: ${deferred}`);
    }
  } else {
    // Headless keys are kept while their capabilities are not asked this pass.
    for (const rec of results.headless.records) if (rec && rec.state !== "settled") present.add(`${rec.code}@${rec.startedAt}`);
  }
  if (a.caps.includes("settle-unattended")) actUnattended(a, results, now, stamp, acted, out, budget);
  else for (const rec of results.unattended.records) if (rec && rec.state === "started") present.add(`unattended:${rec.taskId}@${rec.startedAt}`);
  // A key leaves the memory once its record is settled or gone, so the memory cannot grow without bound.
  for (const side of ["dry", "live", "stranded"]) for (const k of Object.keys(acted[side])) if (!present.has(k)) delete acted[side][k];
  out.save = () => writeJson(actedPath, acted);
  return out;
}

// ---------- state schema ----------
// The recorded schema of STATE_DIR. A state from before state-meta.json existed is schema 1.
// An unreadable meta file is an error, never a guess.
function readStateMeta() {
  if (!fs.existsSync(STATE_META)) return { schema: 1, recorded: false };
  const m = readJsonOr(STATE_META, null);
  if (!m || !Number.isInteger(m.schema) || m.schema < 1) return { error: `${STATE_META} is unreadable or has no schema, so the clock cannot tell whether it may write the state` };
  return { schema: m.schema, recorded: true };
}

// ---------- tick ----------
function tick(opts, now) {
  const a = parseAct(opts);
  if (a.error) return { ok: false, error: a.error };
  if (!opts.observe && !a.caps) return { ok: false, error: "tick needs --observe, or --act <caps>, which observes too." };
  const started = Date.now();
  const lock = takeLock(now);
  if (!lock.acquired) return { ok: true, skipped: true, reason: `lock held by pid ${lock.holder} for ${lock.ageSec}s` };
  // A state written by a newer clock is never rewritten by this one: refuse and write nothing.
  const meta = readStateMeta();
  if (meta.error || meta.schema > STATE_SCHEMA) {
    dropLock();
    return { ok: false, refused: "state-schema", stateSchema: meta.schema === undefined ? null : meta.schema, clockSchema: STATE_SCHEMA, error: meta.error || `the clock state is schema ${meta.schema}, newer than this clock's ${STATE_SCHEMA}. Activate a release that reads it, or restore a compatible backup with runtime-release.js` };
  }
  try {
    const snapPath = path.join(STATE_DIR, "snapshot.json");
    const prevSnap = readJsonOr(snapPath, null);
    const hadPrevious = !!(prevSnap && prevSnap.sources);
    const prevSources = hadPrevious ? prevSnap.sources : {};

    const results = {};
    const read = (name, fn) => {
      try { results[name] = { ok: true, ...fn() }; } catch (e) { results[name] = { ok: false, error: String(e && e.message || e).slice(0, 300) }; }
    };
    read("headless", srcHeadless);
    read("unattended", srcUnattended);
    read("bg-runner", srcBgRunner);
    read("runs", srcRuns);
    read("inbox", srcInbox);
    read("ask-queue", srcAskQueue);
    read("brain-role", srcBrainRole);
    const homeRepos = results["brain-role"].ok ? results["brain-role"].homeRepos : ((prevSnap && prevSnap.homeRepos) || []);
    read("prs", () => srcPrs(homeRepos));
    read("desktop-sessions", srcDesktopSessions);
    read("routines", () => srcRoutines(now));

    const stamp = iso(now);
    const events = [];
    const nextSources = {};
    const lines = [];
    for (const [name, r] of Object.entries(results)) {
      const prevEntries = (prevSources[name] && prevSources[name].entries) || {};
      if (!r.ok) {
        // Keep what we knew, so an unreadable source never reads as everything vanishing.
        nextSources[name] = { ok: false, entries: prevEntries };
        lines.push(`${name}: COULD-NOT-READ ${r.error}`);
        if (!prevSources[name] || prevSources[name].ok !== false) events.push({ type: "source.unreadable", source: name, key: name, detail: { error: r.error } });
        continue;
      }
      nextSources[name] = { ok: true, entries: r.entries };
      lines.push(`${name}: ${r.population}`);
      if (prevSources[name] && prevSources[name].ok === false) events.push({ type: "source.recovered", source: name, key: name, detail: {} });
      if (hadPrevious && prevSources[name]) events.push(...diff(name, prevEntries, r.entries, { gh: r.gh || (results.prs && results.prs.gh), hadPrevious }));
    }
    if (!hadPrevious) {
      const counts = {};
      for (const [name, s] of Object.entries(nextSources)) counts[name] = Object.keys(s.entries).length;
      events.push({ type: "clock.baseline", source: "brain-clock", key: "baseline", detail: { counts } });
    }
    // Missed routines are facts about now, so a baseline pass reports them too.
    if (!hadPrevious && results.routines.ok) {
      for (const [key, e] of Object.entries(results.routines.entries)) if (e.missedSlot) events.push({ type: "routine.missed", source: "routines", key, detail: pick(e) });
    }
    // Stalled missions are observed every pass, and a failure here is one line, not a failed pass.
    let stalls;
    try { stalls = observeStalls(now); } catch (e) { stalls = { events: [], line: `missions: COULD-NOT-CHECK ${String(e && e.message || e).slice(0, 300)}`, save: null }; }
    events.push(...stalls.events);
    lines.push(stalls.line);
    // Acting runs after the observe pass and cannot break it: an act failure is one line, not a failed pass.
    let act = null;
    if (a.caps) {
      try { act = actPass(a, results, now, stamp); } catch (e) { act = { events: [], lines: [`ERROR ${String(e && e.message || e).slice(0, 300)}`], list: [], save: null }; }
      events.push(...act.events);
      if (a.caps.includes("judge")) {
        // Reconcile first, so the judge reads attempts that are already settled and closed.
        let rc;
        try { rc = actReconcile(a); } catch (e) { rc = { events: [], lines: [`reconcile: ERROR ${String(e && e.message || e).slice(0, 300)}`], save: null }; }
        events.push(...rc.events);
        act.lines.push(...rc.lines);
        if (rc.save) { const prev = act.save; act.save = () => { if (prev) prev(); rc.save(); }; }
        let j;
        try { j = actJudge(a, started); } catch (e) { j = { events: [], lines: [`judge: ERROR ${String(e && e.message || e).slice(0, 300)}`], save: null }; }
        events.push(...j.events);
        act.lines.push(...j.lines);
        if (j.save) { const prev = act.save; act.save = () => { if (prev) prev(); j.save(); }; }
      }
    }

    const unreadable = Object.values(results).filter((r) => !r.ok).length;
    fs.mkdirSync(AUTODEV, { recursive: true });
    if (events.length) fs.appendFileSync(EVENTS, events.map((e) => JSON.stringify({ at: stamp, ...e })).join("\n") + "\n", "utf8");
    writeJson(snapPath, { at: stamp, homeRepos, sources: nextSources });
    if (!meta.recorded || meta.schema !== STATE_SCHEMA) writeJson(STATE_META, { schema: STATE_SCHEMA, writtenBy: process.env.AUTODEV_RUNTIME_RELEASE || "unpinned", at: stamp });
    if (stalls.save) stalls.save();
    if (act && act.save) act.save();
    const rec = { at: stamp, status: unreadable ? "degraded" : "ok", durationMs: Date.now() - started, events: events.length, unreadable, sources: lines };
    if (act) rec.act = act.lines;
    beat(rec);
    return { ok: true, ...rec, types: countTypes(events), ...(act ? { candidates: act.list } : {}) };
  } catch (e) {
    const rec = { at: iso(now), status: "error", durationMs: Date.now() - started, error: String(e && e.stack || e).slice(0, 600) };
    try { beat(rec); } catch { /* the heartbeat itself failed; health reads that as stale */ }
    return { ok: false, ...rec };
  } finally {
    dropLock();
  }
}
function countTypes(events) {
  const c = {};
  for (const e of events) c[e.type] = (c[e.type] || 0) + 1;
  return c;
}
function beat(rec) {
  writeJson(path.join(STATE_DIR, "last.json"), rec);
  fs.appendFileSync(path.join(STATE_DIR, "passes.jsonl"), JSON.stringify(rec) + "\n", "utf8");
}

function health(opts, now) {
  const maxAge = Number(opts["max-age-min"] || 15);
  const last = readJsonOr(path.join(STATE_DIR, "last.json"), null);
  if (!last) return { ok: false, stale: true, failing: false, reason: "no pass recorded" };
  const ageMin = Math.round(((now - Date.parse(last.at)) / 60000) * 10) / 10;
  const stale = ageMin > maxAge;
  let errorStreak = 0;
  try {
    const recs = fs.readFileSync(path.join(STATE_DIR, "passes.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
    for (let i = recs.length - 1; i >= 0; i--) {
      let r = null;
      try { r = JSON.parse(recs[i]); } catch { break; }
      if (r.status !== "error") break;
      errorStreak++;
    }
  } catch { errorStreak = last.status === "error" ? 1 : 0; }
  const failing = errorStreak >= FAIL_STREAK_UNHEALTHY;
  const reason = stale ? `last pass ${ageMin} minutes ago (limit ${maxAge})` : failing ? `the last ${errorStreak} passes failed` : "";
  return { ok: !stale && !failing, stale, failing, errorStreak, ageMin, reason, last: { at: last.at, status: last.status, events: last.events } };
}

function tailEvents(opts) {
  const n = Number(opts.tail || 20);
  let lines = [];
  try { lines = fs.readFileSync(EVENTS, "utf8").split(/\r?\n/).filter(Boolean); } catch { /* none yet */ }
  return { ok: true, total: lines.length, events: lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { unparseable: l.slice(0, 200) }; } }) };
}

function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const now = a.now ? Date.parse(a.now) : Date.now();
  if (!cmd || a.help) {
    const head = fs.readFileSync(__filename, "utf8").split("\n").slice(2);
    const end = head.findIndex((l) => !l.startsWith("//"));
    process.stdout.write(head.slice(0, end < 0 ? head.length : end).join("\n") + "\n");
    return 0;
  }
  let out;
  try {
    if (cmd === "tick") out = tick(a, now);
    else if (cmd === "health") out = health(a, now);
    else if (cmd === "events") out = tailEvents(a);
    else out = { ok: false, error: `unknown command ${cmd}` };
  } catch (e) {
    out = { ok: false, error: String(e && e.stack || e) };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (cmd === "health") return out.ok ? 0 : 1;
  return out.ok ? 0 : 2;
}

if (require.main === module) process.exitCode = main();
module.exports = { takeLock, dropLock, LOCK_PATH, LOCK_OWNERLESS_MS, STATE_DIR, STATE_SCHEMA, STATE_META, readStateMeta, releaseScript, reconcileRows, prevCronSlot, parseCron, diff, workerEvent, exitCodeOf, resultOf, pidLiveness, parseAct, lastLineResult, classifyUnattended, writerSupport };
