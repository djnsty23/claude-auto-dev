#!/usr/bin/env node
"use strict";
// Suite for plugins/autodev-core/scripts/brain-clock.js. Builds a fake ~/.claude and Desktop store in
// a temp dir and drives the CLI.
// Part one drives the observe pass. The lock part drives the operating lock (ledger-lock.js beside
// the clock). Part two drives tick --act against a fake headless-worker.js, unattended-worker.js,
// worker-reconcile.js, brain-judge.js and MSYS ps.
// Prints one "ok <name>" line per passing check and one "FAIL <name>" line per failing one.
//
// --plants also plants each defect in PLANTS into a copy of the scripts folder and requires the
// suite to go red on every one, so a green run is a claim about checks that can fail. It takes
// minutes, so npm test runs without it. BRAIN_CLOCK_SUBJECT overrides the subject.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const SUBJECT = process.env.BRAIN_CLOCK_SUBJECT ? path.resolve(process.env.BRAIN_CLOCK_SUBJECT) : path.resolve(__dirname, "../plugins/autodev-core/scripts/brain-clock.js");
const SCRIPTS = path.dirname(SUBJECT);
const NOW = "2026-09-22T12:00:00Z";
const LATER = "2026-09-22T12:05:00Z";
const DEAD_PID = 999999;

const w = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v, null, 2)); };
const readJsonl = (p) => { try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const readOr = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return "<absent>"; } };
// The name of every passing check, in the order it ran.
const OKS = [];
const checker = (fails, counter) => (name, cond, detail) => {
  if (cond) { counter.n++; OKS.push(name); } else fails.push(`${name}${detail ? ": " + String(detail).slice(0, 300) : ""}`);
};

// ---------- part one: observe ----------
function observeSuite(script) {
  const fails = [];
  const counter = { n: 0 };
  const check = checker(fails, counter);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-clock-test-"));
  const claude = path.join(root, "claude");
  const desktop = path.join(root, "desktop");
  const autodev = path.join(claude, "autodev");
  const ghFixture = path.join(root, "gh.json");
  const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, BRAIN_CLOCK_DESKTOP_DIR: desktop, BRAIN_CLOCK_ROLE_CHECKER: "off", BRAIN_CLOCK_GH_FIXTURE: ghFixture, BRAIN_CLOCK_WORKER_RECONCILE: "off", BRAIN_CLOCK_BRAIN_JUDGE: "off" };
  const run = (argv) => {
    const r = spawnSync(process.execPath, [script, ...argv], { env, encoding: "utf8" });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
    return { code: r.status, json, out: r.stdout + r.stderr };
  };
  const events = () => readJsonl(path.join(autodev, "events.jsonl"));
  const ofType = (list, t) => list.filter((e) => e.type === t);
  const sessDir = path.join(desktop, "claude-code-sessions", "acct1234-aaaa", "org1");

  // World at the first pass.
  w(path.join(autodev, "headless-workers.json"), { version: 1, records: [
    { code: "W1", pid: process.pid, startedAt: "2026-09-22T11:00:00Z", state: "running" },
    { code: "W2", pid: process.pid, startedAt: "2026-09-22T11:10:00Z", state: "running" },
  ] });
  w(path.join(autodev, "unattended-workers.json"), { version: 1, records: [{ taskId: "worker-a", state: "composed" }] });
  w(path.join(autodev, "bg-runner.json"), { version: 1, workers: [{ code: "BG1", id: "b1", state: "running" }, { code: "BG2", id: "b2", state: "closed", closedFrom: "done" }] });
  w(path.join(autodev, "runs", "job1", "s1", "status.json"), { job: "job1", state: "running" });
  w(path.join(autodev, "inbox", "qr", "note-1.md"), "hello");
  w(path.join(claude, "brain-role.json"), { role: "brain", session_id: "brain-A", peer_name: "Brain 1", home_repos: ["~/repo-x"] });
  w(ghFixture, { open: { "~/repo-x": [{ number: 5, title: "five", headRefName: "claude/five" }, { number: 6, title: "six" }] }, view: { "~/repo-x#5": { state: "MERGED", mergedAt: "2026-09-22T12:03:00Z" } } });
  w(path.join(sessDir, "local_s1.json"), { sessionId: "local_s1", title: "one", isArchived: false });
  w(path.join(sessDir, "scheduled-tasks.json"), { scheduledTasks: [
    { id: "daily", cronExpression: "0 9 * * *", enabled: true, lastRunAt: Date.parse("2026-09-19T06:05:00Z"), lastScheduledFor: Date.parse("2026-09-19T06:00:00Z") },
    { id: "off", cronExpression: "0 9 * * *", enabled: false, lastScheduledFor: Date.parse("2026-09-01T06:00:00Z") },
  ] });

  // 1. tick without --observe refuses and writes nothing.
  {
    const r = run(["tick", "--now", NOW]);
    check("refuses without --observe", r.code === 2 && r.json && /observe/.test(r.json.error), r.out);
    check("refusal writes no events", events().length === 0);
  }
  // 2. Baseline pass: one baseline event, no started flood, a population line per source, missed routine reported.
  {
    const r = run(["tick", "--observe", "--now", NOW]);
    check("baseline exit 0", r.code === 0 && r.json && r.json.ok, r.out);
    const ev = events();
    check("baseline event", ofType(ev, "clock.baseline").length === 1, JSON.stringify(ev.map((e) => e.type)));
    check("no started flood on baseline", ofType(ev, "worker.started").length === 0);
    check("baseline counts headless 2", ofType(ev, "clock.baseline")[0] && ofType(ev, "clock.baseline")[0].detail.counts.headless === 2);
    const names = ["headless", "unattended", "bg-runner", "runs", "inbox", "ask-queue", "brain-role", "prs", "desktop-sessions", "routines"];
    check("population line per source", r.json && names.every((n) => r.json.sources.some((l) => l.startsWith(n + ": ") && !/COULD-NOT-READ/.test(l))), r.json && r.json.sources.join(" | "));
    const missed = ofType(ev, "routine.missed");
    check("enabled stale cron is missed", missed.length === 1 && /daily$/.test(missed[0].key), JSON.stringify(missed));
    check("event stamped by process clock", ev.every((e) => e.at === NOW));
  }
  // 3. Second pass after changes: every source's transitions become events.
  {
    w(path.join(autodev, "headless-workers.json"), { version: 1, records: [
      { code: "W1", pid: process.pid, startedAt: "2026-09-22T11:00:00Z", state: "settled", result: "failed", sentence: "login expired" },
      { code: "W2", pid: DEAD_PID, startedAt: "2026-09-22T11:10:00Z", state: "running" },
      { code: "W3", pid: process.pid, startedAt: "2026-09-22T12:02:00Z", state: "running" },
    ] });
    w(path.join(autodev, "runs", "job1", "s1", "status.json"), { job: "job1", state: "finished", exitCode: 0 });
    w(path.join(autodev, "runs", "job1", "s1", "ask.json"), { header: "Pick" });
    w(path.join(autodev, "runs", "job1", "s1", "answer.json"), { label: "A", by: "owner" });
    fs.unlinkSync(path.join(autodev, "inbox", "qr", "note-1.md"));
    w(path.join(autodev, "inbox", "eb", "note-2.md"), "hi");
    w(path.join(claude, "brain-role.json"), { role: "brain", session_id: "brain-B", peer_name: "Brain 2", home_repos: ["~/repo-x"] });
    w(ghFixture, { open: { "~/repo-x": [{ number: 6, title: "six" }, { number: 7, title: "seven" }] }, view: { "~/repo-x#5": { state: "MERGED", mergedAt: "2026-09-22T12:03:00Z" } } });
    w(path.join(sessDir, "local_s1.json"), { sessionId: "local_s1", title: "one", isArchived: true });
    w(path.join(sessDir, "local_s2.json"), { sessionId: "local_s2", title: "two", isArchived: false });
    w(path.join(sessDir, "scheduled-tasks.json"), { scheduledTasks: [
      { id: "daily", cronExpression: "0 9 * * *", enabled: true, lastRunAt: Date.parse("2026-09-22T06:01:00Z"), lastScheduledFor: Date.parse("2026-09-22T06:00:00Z") },
      { id: "off", cronExpression: "0 9 * * *", enabled: false, lastScheduledFor: Date.parse("2026-09-01T06:00:00Z") },
    ] });
    const before = events().length;
    const r = run(["tick", "--observe", "--now", LATER]);
    check("second pass exit 0", r.code === 0, r.out);
    const ev = events().slice(before);
    const has = (type, keyPart) => ev.some((e) => e.type === type && e.key.includes(keyPart));
    const types = JSON.stringify(ev.map((e) => `${e.type} ${e.key}`));
    check("worker.failed on settled failed", has("worker.failed", "W1@"), types);
    check("worker.died on dead pid", has("worker.died", "W2@"), types);
    check("worker.started on new record", has("worker.started", "W3@"), types);
    check("run.finished", has("run.finished", "run:job1/s1"), types);
    check("ask.opened", has("ask.opened", "ask:job1/s1"), types);
    check("ask.answered", has("ask.answered", "answer:job1/s1"), types);
    check("inbox.received", has("inbox.received", "eb/note-2.md"), types);
    check("inbox.cleared", has("inbox.cleared", "qr/note-1.md"), types);
    check("brain.claimed", has("brain.claimed", "brain"), types);
    check("pr.merged via view", has("pr.merged", "#5"), types);
    check("pr.opened", has("pr.opened", "#7"), types);
    check("session.archived", has("session.archived", "local_s1"), types);
    check("session.started", has("session.started", "local_s2"), types);
    check("routine.ran", has("routine.ran", "daily"), types);
    check("no repeat missed after run", !has("routine.missed", "daily"), types);
    check("unchanged emits nothing", !ev.some((e) => e.key.includes("BG2") || e.key.includes("worker-a")), types);
  }
  // 4. An unreadable source keeps its entries: no removal flood, then a recovery without a started flood.
  {
    w(path.join(autodev, "bg-runner.json"), "{ not json");
    const before = events().length;
    const r = run(["tick", "--observe", "--now", "2026-09-22T12:10:00Z"]);
    const ev = events().slice(before);
    check("unreadable reported", r.json && r.json.sources.some((l) => /^bg-runner: COULD-NOT-READ/.test(l)), r.json && r.json.sources.join(" | "));
    check("unreadable pass is degraded", r.json && r.json.status === "degraded");
    check("source.unreadable event", ofType(ev, "source.unreadable").length === 1, JSON.stringify(ev));
    check("no removal flood", ofType(ev, "worker.removed").length === 0, JSON.stringify(ev));
    w(path.join(autodev, "bg-runner.json"), { version: 1, workers: [{ code: "BG1", id: "b1", state: "running" }, { code: "BG2", id: "b2", state: "closed", closedFrom: "done" }] });
    const b2 = events().length;
    run(["tick", "--observe", "--now", "2026-09-22T12:15:00Z"]);
    const ev2 = events().slice(b2);
    check("source.recovered", ofType(ev2, "source.recovered").length === 1, JSON.stringify(ev2));
    check("no started flood on recovery", ev2.filter((e) => e.source === "bg-runner" && e.type.startsWith("worker.")).length === 0, JSON.stringify(ev2));
  }
  // 5. health: fresh passes, stale, and a failing streak.
  {
    check("health fresh exit 0", run(["health", "--now", "2026-09-22T12:20:00Z"]).code === 0);
    const stale = run(["health", "--now", "2026-09-22T12:31:00Z"]);
    check("health stale exit 1", stale.code === 1 && stale.json.stale, stale.out);
    const state = path.join(autodev, "brain-clock");
    const errRec = { at: "2026-09-22T12:25:00Z", status: "error" };
    fs.appendFileSync(path.join(state, "passes.jsonl"), [errRec, errRec, errRec].map((x) => JSON.stringify(x)).join("\n") + "\n");
    w(path.join(state, "last.json"), errRec);
    const failing = run(["health", "--now", "2026-09-22T12:26:00Z"]);
    check("health failing exit 1", failing.code === 1 && failing.json.failing && failing.json.errorStreak === 3, failing.out);
    const two = { at: "2026-09-22T12:27:00Z", status: "ok" };
    fs.appendFileSync(path.join(state, "passes.jsonl"), JSON.stringify(two) + "\n");
    w(path.join(state, "last.json"), two);
    check("an ok pass resets the streak", run(["health", "--now", "2026-09-22T12:28:00Z"]).code === 0);
  }
  // 6. Lock: a live holder skips the pass, a dead one is taken over. lockSuite covers age and identity.
  {
    const lockP = path.join(autodev, "brain-clock", "lock.json");
    w(lockP, { pid: process.pid, at: "2026-09-22T12:29:30Z" });
    const before = events().length;
    const held = run(["tick", "--observe", "--now", "2026-09-22T12:30:00Z"]);
    check("held lock skips", held.code === 0 && held.json.skipped === true && events().length === before, held.out);
    w(lockP, { pid: DEAD_PID, at: "2026-09-22T11:00:00Z" });
    const stale = run(["tick", "--observe", "--now", "2026-09-22T12:31:00Z"]);
    check("a dead holder's lock is taken", stale.code === 0 && !stale.json.skipped && !fs.existsSync(lockP), stale.out);
  }
  // 7. Cron slots in local time.
  {
    delete require.cache[require.resolve(script)];
    const { prevCronSlot } = require(script);
    const at = new Date(2026, 8, 23, 8, 59).getTime();
    check("daily 9:00 before 9 is yesterday", prevCronSlot("0 9 * * *", at) === new Date(2026, 8, 22, 9, 0).getTime());
    check("every 2h at :07", prevCronSlot("7 */2 * * *", new Date(2026, 8, 23, 15, 6).getTime()) === new Date(2026, 8, 23, 14, 7).getTime());
    check("weekly Monday", new Date(prevCronSlot("0 9 * * 1", at)).getDay() === 1);
    check("list 8,20", prevCronSlot("0 8,20 * * *", new Date(2026, 8, 23, 19, 0).getTime()) === new Date(2026, 8, 23, 8, 0).getTime());
  }
  // 7b. A writer the clock cannot read refuses every capability with the reason, so no settle runs blind.
  {
    const { writerSupport } = require(script);
    const absent = writerSupport(null);
    check("no writer beside the clock: every capability is missing, with the reason",
      Object.keys(absent.missing).length === 4 && Object.values(absent.missing).every((v) => /no headless-worker\.js beside the clock/.test(v)), JSON.stringify(absent));
    const broken = writerSupport(path.join(root, "no-such-dir", "headless-worker.js"));
    check("a writer whose --help fails: every capability is missing, naming the exit",
      Object.values(broken.missing).length === 4 && Object.values(broken.missing).every((v) => /--help exit [1-9]/.test(v)), JSON.stringify(broken));
  }
  // 8. No override and nothing at %APPDATA%/Claude: the Desktop stores are found in the MSIX package
  //    copy, which is all a Task Scheduler process can see.
  {
    const pkgDir = path.join(root, "local", "Packages", "Claude_test123", "LocalCache", "Roaming", "Claude", "claude-code-sessions", "acctPkg", "orgPkg");
    w(path.join(pkgDir, "local_pkg.json"), { sessionId: "local_pkg", title: "pkg", isArchived: false });
    w(path.join(pkgDir, "scheduled-tasks.json"), { scheduledTasks: [] });
    fs.mkdirSync(path.join(root, "appdata-empty"), { recursive: true });
    const env2 = { ...env, APPDATA: path.join(root, "appdata-empty"), LOCALAPPDATA: path.join(root, "local") };
    delete env2.BRAIN_CLOCK_DESKTOP_DIR;
    const r = spawnSync(process.execPath, [script, "tick", "--observe", "--now", "2026-09-22T12:40:00Z"], { env: env2, encoding: "utf8" });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
    const line = json && json.sources.find((l) => l.startsWith("desktop-sessions: "));
    check("MSIX package copy is read when %APPDATA% has none", r.status === 0 && line && !/COULD-NOT-READ/.test(line) && /\b1\b/.test(line), line || r.stdout + r.stderr);
  }
  // 10. events prints the newest events, and without gh the prs source is one COULD-NOT-READ.
  {
    const t = run(["events", "--tail", "2"]);
    check("events prints the last N of all events", t.code === 0 && t.json && t.json.ok && t.json.events.length === 2 && t.json.total === events().length, t.out);
    const bin = path.join(root, "no-gh");
    fs.mkdirSync(bin, { recursive: true });
    const env3 = { ...env };
    for (const k of Object.keys(env3)) if (/^path$/i.test(k)) delete env3[k];
    env3.PATH = bin;
    delete env3.BRAIN_CLOCK_GH_FIXTURE;
    const r = spawnSync(process.execPath, [script, "tick", "--observe", "--now", "2026-09-22T12:42:00Z"], { env: env3, encoding: "utf8" });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
    const line = json && json.sources.find((l) => l.startsWith("prs: "));
    check("without gh the prs source is COULD-NOT-READ and names gh pr list", line && /COULD-NOT-READ/.test(line) && /gh pr list/.test(line), line || r.stdout + r.stderr);
  }
  // 9. State schema: a pass records it, and a clock older than the recorded schema refuses and writes nothing.
  {
    const metaP = path.join(autodev, "brain-clock", "state-meta.json");
    const meta = (() => { try { return JSON.parse(fs.readFileSync(metaP, "utf8")); } catch { return null; } })();
    check("a pass records the state schema", meta && meta.schema === 1 && meta.writtenBy === "unpinned", JSON.stringify(meta));
    w(metaP, { schema: 2, writtenBy: "9.9.9" });
    const snapP = path.join(autodev, "brain-clock", "snapshot.json");
    const before = [readOr(snapP), readOr(path.join(autodev, "events.jsonl")), readOr(path.join(autodev, "brain-clock", "passes.jsonl")), readOr(metaP)];
    const r = run(["tick", "--observe", "--now", "2026-09-22T12:45:00Z"]);
    const after = [readOr(snapP), readOr(path.join(autodev, "events.jsonl")), readOr(path.join(autodev, "brain-clock", "passes.jsonl")), readOr(metaP)];
    check("a newer state schema is refused, and nothing is written", r.code !== 0 && r.json && r.json.refused === "state-schema" && r.json.stateSchema === 2 && JSON.stringify(before) === JSON.stringify(after) && !fs.existsSync(path.join(autodev, "brain-clock", "lock.json")), r.out);
    w(metaP, "{ not json");
    const u = run(["tick", "--observe", "--now", "2026-09-22T12:46:00Z"]);
    check("an unreadable state schema is refused, never guessed", u.code !== 0 && u.json && u.json.refused === "state-schema", u.out);
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { passed: counter.n, fails };
}

// ---------- the lock: identity, never age ----------
// The clock takes ledger-lock.js beside it. The identity checks use gate-identity.js beside it too.
function lockSuite(script) {
  const fails = [];
  const counter = { n: 0 };
  const notes = [];
  const check = checker(fails, counter);
  const modes = [["ledger-lock", path.join(path.dirname(script), "ledger-lock.js")]];
  const ownStart = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [mode, lib] of modes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-clock-lock-"));
    const claude = path.join(root, "claude");
    const ghFixture = path.join(root, "gh.json");
    w(ghFixture, { open: {}, view: {} });
    const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, BRAIN_CLOCK_DESKTOP_DIR: path.join(root, "desktop"), BRAIN_CLOCK_ROLE_CHECKER: "off", BRAIN_CLOCK_GH_FIXTURE: ghFixture, BRAIN_CLOCK_WORKER_RECONCILE: "off", BRAIN_CLOCK_BRAIN_JUDGE: "off" };
    const lockP = path.join(claude, "autodev", "brain-clock", "lock.json");
    const tick = () => { const r = spawnSync(process.execPath, [script, "tick", "--observe"], { env, encoding: "utf8" }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* null */ } return { json, out: r.stdout + r.stderr }; };
    const plant = (body, mtime) => { w(lockP, typeof body === "string" ? body : JSON.stringify(body)); if (mtime) fs.utimesSync(lockP, mtime, mtime); return fs.readFileSync(lockP, "utf8"); };
    try {
      let bytes = plant({ pid: process.pid, start: ownStart, at: hourAgo.toISOString().replace(/\.\d{3}Z$/, "Z") }, hourAgo);
      let r = tick();
      check(`lock (${mode}): a live owner an hour old keeps the lock`, r.json && r.json.skipped === true && String(r.json.reason).includes(`lock held by pid ${process.pid}`) && fs.readFileSync(lockP, "utf8") === bytes, r.out);
      plant({ pid: DEAD_PID, at: "2026-09-22T11:00:00Z" });
      r = tick();
      check(`lock (${mode}): a dead owner's lock is taken and dropped`, r.json && r.json.ok && !r.json.skipped && !fs.existsSync(lockP), r.out);
      bytes = plant("");
      r = tick();
      check(`lock (${mode}): a fresh ownerless lock is respected`, r.json && r.json.skipped === true && fs.readFileSync(lockP, "utf8") === bytes, r.out);
      plant("", new Date(Date.now() - 11 * 60 * 1000));
      r = tick();
      check(`lock (${mode}): an ownerless lock past its limit is taken`, r.json && r.json.ok && !r.json.skipped && !fs.existsSync(lockP), r.out);
      bytes = plant({ pid: DEAD_PID, at: "2026-09-22T11:00:00Z", token: "someone else" });
      const d = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(script)}).dropLock()))`], { env, encoding: "utf8" });
      let dj = null; try { dj = JSON.parse(d.stdout); } catch { /* null */ }
      check(`lock (${mode}): a process that does not hold the lock cannot drop it`, dj && dj.released === false && fs.readFileSync(lockP, "utf8") === bytes, d.stdout + d.stderr);
      fs.rmSync(lockP, { force: true });
      if (mode === "ledger-lock") {
        const sleeper = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore", windowsHide: true });
        try {
          spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
          const g = require(path.join(path.dirname(lib), "gate-identity.js"));
          const snap = g.snapshot();
          const real = snap.ok && snap.procs.get(sleeper.pid);
          bytes = plant({ pid: sleeper.pid, start: real ? new Date(Date.parse(real.startUtc)).toISOString() : "unknown", at: "2026-09-22T11:00:00Z" }, hourAgo);
          r = tick();
          check(`lock (${mode}): the owner's own process at its pid keeps the lock`, real && r.json && r.json.skipped === true && fs.readFileSync(lockP, "utf8") === bytes, r.out);
          plant({ pid: sleeper.pid, start: "2000-01-01T00:00:00.000Z", at: "2026-09-22T11:00:00Z" }, hourAgo);
          r = tick();
          check(`lock (${mode}): a later process at a reused pid does not`, r.json && r.json.ok && !r.json.skipped && !fs.existsSync(lockP), r.out);
        } finally { sleeper.kill(); }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  return { passed: counter.n, fails, notes };
}

// ---------- part two: act ----------
// A stand-in for headless-worker.js: records its argv, answers --help and settle, writes no ledger.
const FAKE_WRITER = `"use strict";
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HW_LOG, JSON.stringify(argv) + "\\n");
if (argv.includes("--help")) {
  process.stdout.write(process.env.FAKE_HW_KEYED === "1"
    ? "       node headless-worker.js settle --code <CODE> --started-at <iso> [--lost] [--unreported] [--ledger <file>] [--json]\\n"
    : "       node headless-worker.js settle --code <CODE> [--lost] [--unreported] [--ledger <file>] [--json]\\n");
} else if (argv[0] === "settle") {
  const code = argv[argv.indexOf("--code") + 1];
  process.stdout.write(JSON.stringify({ ok: true, value: { code, state: argv.includes("--lost") ? "lost" : "done" } }) + "\\n");
}
`;
// A stand-in for Git's MSYS ps, shaped like the real one: exit 0 with a row for a pid it knows,
// else the header and exit 1.
const FAKE_PS = `"use strict";
const known = String(process.env.FAKE_PS_KNOWN || "").split(",").filter(Boolean).map(Number);
const pid = Number(process.argv[process.argv.indexOf("-p") + 1]);
process.stdout.write("      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\\n");
if (known.includes(pid)) process.stdout.write("   " + pid + "       1  " + pid + "      12345  ?         197609 10:56:24 /usr/bin/bash\\n");
process.exitCode = known.includes(pid) ? 0 : 1;
`;
// A stand-in for unattended-worker.js: records its argv, answers --help and settle, writes no ledger.
const FAKE_UW = `"use strict";
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_UW_LOG, JSON.stringify(argv) + "\\n");
if (argv.includes("--help")) {
  process.stdout.write(process.env.FAKE_UW_OLD === "1"
    ? "Usage: node unattended-worker.js settle --task-id <id> [--ledger <file>]\\n"
    : "       node unattended-worker.js settle --task-id <id> --run-status running|succeeded|failed [--report-read] [--ledger <file>]\\n");
} else if (argv[0] === "settle") {
  const id = argv[argv.indexOf("--task-id") + 1];
  process.stdout.write(JSON.stringify({ ok: true, value: { record: { taskId: id, state: "settled" }, decision: { deleteSafe: true, reason: "read" } } }, null, 2) + "\\n");
}
`;
// A stand-in for brain-judge.js: records its argv, answers as the mode file says.
const FAKE_BJ = `"use strict";
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_BJ_LOG, JSON.stringify(argv) + "\\n");
fs.appendFileSync(process.env.FAKE_ORDER_LOG, "judge\\n");
let mode = "ok";
try { mode = fs.readFileSync(process.env.FAKE_BJ_MODE, "utf8").trim(); } catch { mode = "ok"; }
if (mode === "garbage") process.stdout.write("not json\\n");
else if (mode === "error") { process.stdout.write(JSON.stringify({ ok: false, error: { code: "ledger-locked", message: "held" } }) + "\\n"); process.exitCode = 1; }
else process.stdout.write(JSON.stringify({ ok: true, value: { lines: ["mode: judge dry, start dry"], events: [{ type: "judge.would-start", key: "worker-q", detail: { taskId: "worker-q" } }] } }, null, 2) + "\\n");
`;
// A stand-in for worker-reconcile.js: records its argv and the order it ran in, answers as the mode file says.
const FAKE_WR = `"use strict";
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_WR_LOG, JSON.stringify(argv) + "\\n");
fs.appendFileSync(process.env.FAKE_ORDER_LOG, "reconcile\\n");
let mode = "quiet";
try { mode = fs.readFileSync(process.env.FAKE_WR_MODE, "utf8").trim(); } catch { mode = "quiet"; }
const live = argv.includes("--live");
if (mode === "garbage") process.stdout.write("not json\\n");
else if (mode === "crash") { process.stderr.write("boom\\n"); process.exitCode = 3; }
else if (mode === "error") { process.stdout.write(JSON.stringify({ ok: false, error: { code: "ledger-locked", message: "held" } }) + "\\n"); process.exitCode = 1; }
else if (mode === "badshape") process.stdout.write(JSON.stringify({ ok: true, value: { live, outcomes: 5, released: [], line: "bad shape" } }) + "\\n");
else if (mode === "skipped") process.stdout.write(JSON.stringify({ ok: true, value: { skipped: "kill switch", outcomes: [], line: "reconcile: skipped, kill switch" } }) + "\\n");
else {
  const outcomes = mode === "outcomes" ? [
    { taskId: "worker-p", outcome: "PENDING", why: "running" },
    { taskId: "worker-s", outcome: "SETTLED", why: "exit 0", runStatus: "succeeded", action: "settle" },
    { taskId: "worker-o", outcome: "ORPHAN", why: "no run" },
  ] : [];
  const released = mode === "outcomes" ? [{ taskId: "worker-h", outcome: "RELEASE", why: "lease over" }, { taskId: "worker-k", outcome: "HELD", why: "lease live" }] : [];
  process.stdout.write("progress line\\n" + JSON.stringify({ ok: true, value: { live, outcomes, released, verify: null, line: \`\${outcomes.length} attempts\` } }) + "\\n");
}
`;
const T = (hhmm) => `2026-09-22T${hhmm}:00Z`;

function actSuite(script) {
  const fails = [];
  const counter = { n: 0 };
  const check = checker(fails, counter);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-clock-act-"));
  const fakeWr = path.join(root, "fake-worker-reconcile.js");
  w(fakeWr, FAKE_WR);
  const fakeWriter = path.join(root, "fake-headless-worker.js");
  const fakePs = path.join(root, "fake-ps.js");
  const fakeUw = path.join(root, "fake-unattended-worker.js");
  w(fakeUw, FAKE_UW);
  const fakeBj = path.join(root, "fake-brain-judge.js");
  w(fakeBj, FAKE_BJ);
  w(fakeWriter, FAKE_WRITER);
  w(fakePs, FAKE_PS);
  let worlds = 0;
  // One fake ~/.claude where every source reads, plus helpers. Pids are odd or 2 mod 4, so no
  // Windows process can hold one. 999998 stands for an MSYS pid: only the fake ps knows it.
  const world = ({ keyed = true, ps = true, uwOld = false, bj = true, wr = true } = {}) => {
    const dir = path.join(root, `w${++worlds}`);
    const claude = path.join(dir, "claude");
    const autodev = path.join(claude, "autodev");
    const desktop = path.join(dir, "desktop");
    const ghFixture = path.join(dir, "gh.json");
    const writerLog = path.join(dir, "writer-calls.jsonl");
    const uwLog = path.join(dir, "uw-calls.jsonl");
    const bjLog = path.join(dir, "bj-calls.jsonl");
    const bjMode = path.join(dir, "bj-mode.txt");
    const wrLog = path.join(dir, "wr-calls.jsonl");
    const wrMode = path.join(dir, "wr-mode.txt");
    const orderLog = path.join(dir, "order.txt");
    const uledger = path.join(claude, "autodev", "unattended-workers.json");
    const sessDir = path.join(desktop, "claude-code-sessions", "acct", "org");
    const ledger = path.join(autodev, "headless-workers.json");
    const env = {
      ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, BRAIN_CLOCK_DESKTOP_DIR: desktop, BRAIN_CLOCK_ROLE_CHECKER: "off", BRAIN_CLOCK_GH_FIXTURE: ghFixture,
      BRAIN_CLOCK_HEADLESS_WORKER: fakeWriter, BRAIN_CLOCK_PS: ps ? fakePs : "off", FAKE_PS_KNOWN: "999998", FAKE_HW_LOG: writerLog, FAKE_HW_KEYED: keyed ? "1" : "0",
      BRAIN_CLOCK_UNATTENDED_WORKER: fakeUw, FAKE_UW_LOG: uwLog, FAKE_UW_OLD: uwOld ? "1" : "0",
      BRAIN_CLOCK_BRAIN_JUDGE: bj ? fakeBj : "off", FAKE_BJ_LOG: bjLog, FAKE_BJ_MODE: bjMode,
      BRAIN_CLOCK_WORKER_RECONCILE: wr === true ? fakeWr : wr === false ? "off" : wr, FAKE_WR_LOG: wrLog, FAKE_WR_MODE: wrMode, FAKE_ORDER_LOG: orderLog,
    };
    w(path.join(autodev, "unattended-workers.json"), { version: 1, records: [] });
    w(path.join(autodev, "bg-runner.json"), { version: 1, workers: [] });
    fs.mkdirSync(path.join(autodev, "runs"), { recursive: true });
    fs.mkdirSync(path.join(autodev, "inbox"), { recursive: true });
    w(ghFixture, { open: {}, view: {} });
    w(path.join(desktop, "claude-code-sessions", "acct", "org", "scheduled-tasks.json"), { scheduledTasks: [] });
    // A ledger record plus its log and report, each file's mtime set to when the worker last wrote it.
    const rec = (code, startedAt, o = {}) => {
      const stem = path.join(dir, "logs", `${code}-${startedAt.replace(/:/g, "")}`);
      const log = `${stem}.log`; const report = `${stem}.report.md`;
      w(log, `{"type":"system"}\n${o.exit !== undefined ? `CLAUDE_EXIT=${o.exit}\n` : ""}`);
      fs.utimesSync(log, new Date(o.logAt || startedAt), new Date(o.logAt || startedAt));
      if (o.report) { w(report, `# ${code}\n\n${o.report}\n`); fs.utimesSync(report, new Date(o.reportAt || startedAt), new Date(o.reportAt || startedAt)); }
      return { code, pid: o.pid, startedAt, state: o.state || "running", log, report, ...(o.result ? { result: o.result } : {}) };
    };
    // An unattended record, its report (mtime when last written) and its Desktop session record.
    // A session whose turn ended carries a post-turn summary for its last assistant message.
    const urec = (slug, startedAt, o = {}) => {
      const report = path.join(dir, "ureports", slug, "REPORT.md");
      if (o.report !== undefined) { w(report, o.report); fs.utimesSync(report, new Date(o.reportAt || startedAt), new Date(o.reportAt || startedAt)); }
      const sessionId = `local_${slug}`;
      if (o.session) {
        w(path.join(sessDir, `${sessionId}.json`), {
          sessionId, title: slug, isArchived: !!o.session.archived, scheduledTaskId: `worker-${slug}`,
          lastActivityAt: Date.parse(o.session.at), lastAssistantUuid: o.session.turnEnded ? "a-1" : "a-2",
          postTurnSummaryFor: "a-1", postTurnSummary: { status_detail: o.session.summary || "done" },
        });
      }
      return { taskId: `worker-${slug}`, slug, state: o.state || "started", report, sessionId, startedAt };
    };
    return {
      urec, uledger,
      setUnattended: (records) => w(uledger, { version: 1, records }),
      uBytes: () => fs.readFileSync(uledger),
      uSettles: () => readJsonl(uwLog).filter((argv) => argv[0] === "settle"),
      bjCalls: () => readJsonl(bjLog),
      bjSet: (mode) => fs.writeFileSync(bjMode, mode),
      wrCalls: () => readJsonl(wrLog),
      wrSet: (mode) => fs.writeFileSync(wrMode, mode),
      order: () => readOr(orderLog).split("\n").filter((l) => l && l !== "<absent>"),
      autodev, ledger, rec,
      setRecords: (records) => w(ledger, { version: 1, records }),
      run: (argv) => {
        const r = spawnSync(process.execPath, [script, ...argv], { env, encoding: "utf8" });
        let json = null; try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
        return { code: r.status, json, out: r.stdout + r.stderr };
      },
      events: () => readJsonl(path.join(autodev, "events.jsonl")),
      settles: () => readJsonl(writerLog).filter((argv) => argv[0] === "settle"),
      ledgerBytes: () => fs.readFileSync(ledger),
    };
  };
  const acts = (list) => list.filter((e) => typeof e.type === "string" && e.type.startsWith("act."));
  const keysOf = (list, type) => list.filter((e) => e.type === type).map((e) => e.key).sort();
  const lines = (r) => (r.json && Array.isArray(r.json.act) ? r.json.act : []);

  // A. Dry runs, one capability at a time, then a pass that must not repeat itself.
  {
    const W = world();
    const R1a = W.rec("R1", T("11:00"), { pid: 999989, logAt: T("11:10") });
    const base = [
      W.rec("D1", T("11:00"), { pid: 999999, logAt: T("11:10") }), // no probe finds its pid
      W.rec("M1", T("11:00"), { pid: 999998, logAt: T("11:10") }), // only ps finds its pid
      W.rec("Y1", T("11:58"), { pid: 999997 }), // younger than the grace
      W.rec("Q1", T("11:00"), { pid: 999995, logAt: T("11:59") }), // wrote within the grace
      W.rec("F1", T("11:00"), { pid: 999993, exit: 0, logAt: T("11:20"), report: "RESULT F1 done: shipped", reportAt: T("11:20") }),
      W.rec("U1", T("11:00"), { pid: 999991, exit: 0, logAt: T("11:20") }), // exited without a report
      { code: "R1", pid: 999985, startedAt: T("09:00"), state: "settled", result: "done" },
      R1a, // a second record of code R1
    ];
    W.setRecords(base);
    const ledger0 = W.ledgerBytes();

    const r1 = W.run(["tick", "--act", "mark-dead", "--now", T("12:00")]);
    const ev1 = W.events();
    const a1 = acts(ev1);
    check("act pass exit 0", r1.code === 0 && r1.json && r1.json.ok, r1.out);
    check("--act runs the observe pass too", ev1.some((e) => e.type === "clock.baseline") && r1.json && r1.json.sources.length === 11 && r1.json.sources.includes("missions: 0 stalled, idle 60+ min"), r1.out);
    check("mark-dead dry run: would-mark-dead for D1 and R1", JSON.stringify(keysOf(a1, "act.would-mark-dead")) === JSON.stringify([`D1@${T("11:00")}`, `R1@${T("11:00")}`]), JSON.stringify(a1));
    check("mark-dead dry run writes only would-mark-dead events", a1.length === 2 && a1.every((e) => e.type === "act.would-mark-dead"), JSON.stringify(a1.map((e) => e.type)));
    const d1 = a1.find((e) => e.key.startsWith("D1@"));
    check("a dead verdict names every probe", d1 && /kill=dead/.test(d1.detail.probes) && /ps=dead/.test(d1.detail.probes) && (process.platform !== "win32" || /tasklist=dead/.test(d1.detail.probes)), d1 && d1.detail.probes);
    check("an MSYS-style pid that ps knows is alive", !a1.some((e) => e.key.startsWith("M1@")) && lines(r1).some((l) => /1 pid alive/.test(l)), JSON.stringify(lines(r1)));
    check("a young record is untouched", !a1.some((e) => e.key.startsWith("Y1@")) && lines(r1).some((l) => /1 younger than the grace/.test(l)), JSON.stringify(lines(r1)));
    check("a record that wrote within the grace is untouched", !a1.some((e) => e.key.startsWith("Q1@")) && lines(r1).some((l) => /1 active within the grace/.test(l)), JSON.stringify(lines(r1)));
    check("mark-dead dry run leaves the ledger byte-identical", W.ledgerBytes().equals(ledger0));
    check("mark-dead dry run spawns no settle", W.settles().length === 0, JSON.stringify(W.settles()));
    check("act lines count the pass", lines(r1).some((l) => /^mark-dead: 2 ready, 2 new, 0 acted on before$/.test(l)), JSON.stringify(lines(r1)));

    const n2 = W.events().length;
    const r2 = W.run(["tick", "--act", "settle-finished", "--now", T("12:05")]);
    const a2 = acts(W.events().slice(n2));
    check("settle-finished dry run exit 0", r2.code === 0, r2.out);
    check("settle-finished dry run: would-settle for F1 only", a2.length === 1 && JSON.stringify(keysOf(a2, "act.would-settle")) === JSON.stringify([`F1@${T("11:00")}`]), JSON.stringify(a2));
    check("would-settle carries the result the report derives", a2[0] && a2[0].detail.result === "done" && a2[0].detail.exit === 0, JSON.stringify(a2[0]));
    check("an exited record without a report is not settled", lines(r2).some((l) => /1 exited without a report/.test(l)), JSON.stringify(lines(r2)));
    check("settle-finished dry run leaves the ledger byte-identical", W.ledgerBytes().equals(ledger0));
    check("settle-finished dry run spawns no settle", W.settles().length === 0);

    // R1's first run is settled now, and a second run of R1 died.
    W.setRecords([...base.filter((r) => r !== R1a), { ...R1a, state: "settled", result: "lost" }, W.rec("R1", T("11:30"), { pid: 999987, logAt: T("11:40") })]);
    const n3 = W.events().length;
    const r3 = W.run(["tick", "--act", "mark-dead,settle-finished", "--now", T("12:10")]);
    const a3 = acts(W.events().slice(n3));
    check("third pass exit 0", r3.code === 0, r3.out);
    check("a second pass does not act again", !a3.some((e) => /^(D1|F1)@/.test(e.key)) && lines(r3).some((l) => /^mark-dead: 2 ready, 1 new, 1 acted on before$/.test(l)), JSON.stringify(a3) + JSON.stringify(lines(r3)));
    check("acts key on code plus startedAt", JSON.stringify(a3.map((e) => `${e.type} ${e.key}`)) === JSON.stringify([`act.would-mark-dead R1@${T("11:30")}`]), JSON.stringify(a3));
  }
  // B. Live: the writer is spawned with the record's key, once, and the clock writes no ledger.
  {
    const W = world();
    W.setRecords([
      W.rec("D1", T("11:00"), { pid: 999999, logAt: T("11:10") }),
      W.rec("F1", T("11:00"), { pid: 999993, exit: 0, logAt: T("11:20"), report: "RESULT F1 done: shipped", reportAt: T("11:20") }),
    ]);
    const ledger0 = W.ledgerBytes();
    W.run(["tick", "--act", "mark-dead,settle-finished", "--now", T("12:00")]);
    check("a dry run before live spawns no settle", W.settles().length === 0);
    const n = W.events().length;
    const r = W.run(["tick", "--act", "mark-dead,settle-finished", "--live", "--now", T("12:05")]);
    const a = acts(W.events().slice(n));
    const calls = W.settles();
    const want = (code, lost) => JSON.stringify(["settle", "--code", code, "--started-at", T("11:00"), ...(lost ? ["--lost"] : []), "--ledger", W.ledger]);
    check("live exit 0", r.code === 0, r.out);
    check("live spawns the writer once per record, after a dry run", calls.length === 2, JSON.stringify(calls));
    check("live mark-dead spawns settle --lost keyed on code and startedAt", calls.some((c) => JSON.stringify(c) === want("D1", true)), JSON.stringify(calls));
    check("live settle-finished spawns plain settle keyed on code and startedAt", calls.some((c) => JSON.stringify(c) === want("F1", false)), JSON.stringify(calls));
    check("live events carry the writer's result", a.some((e) => e.type === "act.marked-dead" && e.key === `D1@${T("11:00")}` && e.detail.result === "lost")
      && a.some((e) => e.type === "act.settled" && e.key === `F1@${T("11:00")}` && e.detail.result === "done"), JSON.stringify(a));
    check("the clock itself never writes the ledger", W.ledgerBytes().equals(ledger0));
    W.run(["tick", "--act", "mark-dead,settle-finished", "--live", "--now", T("12:10")]);
    check("a second live pass does not act again", W.settles().length === 2, JSON.stringify(W.settles()));
    // The lock is G8's too: a live holder skips an act pass exactly as it skips an observe pass.
    const lockP = path.join(W.autodev, "brain-clock", "lock.json");
    const lockBody = JSON.stringify({ pid: process.pid, at: T("12:14") });
    w(lockP, lockBody);
    const n4 = W.events().length;
    const held = W.run(["tick", "--act", "mark-dead,settle-finished", "--live", "--now", T("12:15")]);
    check("a held lock skips an act pass and is left as it was", held.code === 0 && held.json && held.json.skipped === true && W.events().length === n4 && fs.readFileSync(lockP, "utf8") === lockBody, held.out);
    fs.rmSync(lockP, { force: true });
  }
  // C. A writer that cannot take the key: COULD-NOT-ACT, nothing spawned, and no event every pass.
  {
    const W = world({ keyed: false });
    W.setRecords([
      W.rec("D1", T("11:00"), { pid: 999999, logAt: T("11:10") }),
      W.rec("F1", T("11:00"), { pid: 999993, exit: 0, logAt: T("11:20"), report: "RESULT F1 done: shipped", reportAt: T("11:20") }),
    ]);
    const r = W.run(["tick", "--act", "mark-dead,settle-finished", "--live", "--now", T("12:00")]);
    const a = acts(W.events());
    check("an unkeyed writer is never spawned to settle", W.settles().length === 0, JSON.stringify(W.settles()));
    check("an unkeyed writer reports COULD-NOT-ACT", lines(r).filter((l) => /COULD-NOT-ACT: .*--started-at/.test(l)).length === 2, JSON.stringify(lines(r)));
    check("an unkeyed writer gets one could-not-act event per capability", a.length === 2 && a.every((e) => e.type === "act.could-not-act"), JSON.stringify(a));
    const n = W.events().length;
    W.run(["tick", "--act", "mark-dead,settle-finished", "--live", "--now", T("12:05")]);
    check("could-not-act is not repeated every pass", acts(W.events().slice(n)).length === 0 && W.settles().length === 0);
    const dry = W.run(["tick", "--act", "settle-finished", "--now", T("12:10")]);
    check("a dry run says live would be COULD-NOT-ACT", lines(dry).some((l) => /^settle-finished: live would be COULD-NOT-ACT/.test(l)), JSON.stringify(lines(dry)));
  }
  // D. An unreadable source in this pass acts on nothing, even live.
  {
    const W = world();
    fs.mkdirSync(path.dirname(W.ledger), { recursive: true });
    fs.writeFileSync(W.ledger, "{ not json");
    const r = W.run(["tick", "--act", "mark-dead,settle-finished", "--live", "--now", T("12:00")]);
    check("an unreadable ledger acts on nothing", r.code === 0 && acts(W.events()).length === 0 && W.settles().length === 0, r.out);
    check("an unreadable ledger reports COULD-NOT-ACT", lines(r).some((l) => /^COULD-NOT-ACT: unreadable this pass: headless$/.test(l)), JSON.stringify(lines(r)));
  }
  {
    const W = world();
    W.setRecords([W.rec("D1", T("11:00"), { pid: 999999, logAt: T("11:10") })]);
    fs.writeFileSync(path.join(W.autodev, "bg-runner.json"), "{ not json");
    const r = W.run(["tick", "--act", "mark-dead,settle-finished", "--live", "--now", T("12:00")]);
    check("any unreadable source stops acting", acts(W.events()).length === 0 && W.settles().length === 0 && lines(r).some((l) => /unreadable this pass: bg-runner/.test(l)), r.out);
  }
  // E. No ps: a pid that kill and tasklist cannot find could still be an MSYS pid, so it reads cannot tell.
  {
    const W = world({ ps: false });
    W.setRecords([W.rec("D1", T("11:00"), { pid: 999999, logAt: T("11:10") })]);
    const r = W.run(["tick", "--act", "mark-dead", "--now", T("12:00")]);
    check("with no ps an unfound pid reads cannot tell", acts(W.events()).length === 0 && lines(r).some((l) => /1 pid cannot tell/.test(l)), JSON.stringify(lines(r)));
  }
  // F. Usage refusals write nothing.
  {
    const W = world();
    W.setRecords([]);
    const r1 = W.run(["tick", "--live", "--now", T("12:00")]);
    check("--live without --act refuses", r1.code === 2 && r1.json && /--act/.test(r1.json.error) && W.events().length === 0, r1.out);
    const r2 = W.run(["tick", "--act", "mark-dead,relaunch", "--now", T("12:00")]);
    check("an unknown capability refuses", r2.code === 2 && r2.json && /relaunch/.test(r2.json.error) && W.events().length === 0, r2.out);
  }
  // G. settle-unattended: a started record settles only when its report's LAST line is a RESULT
  //    line for its own slug AND its session is no longer running. A quiet session without one
  //    is reported once as stranded.
  {
    const W = world();
    W.setRecords([]);
    W.setUnattended([
      W.urec("u-ok", T("11:00"), { report: "# r\n\nRESULT u-ok done: shipped\n", reportAt: T("11:30"), session: { turnEnded: true, at: T("11:30") } }),
      W.urec("u-arch", T("11:00"), { report: "RESULT u-arch failed: gate red\n", reportAt: T("11:50"), session: { archived: true, turnEnded: false, at: T("11:58") } }),
      W.urec("u-run", T("11:00"), { report: "RESULT u-run done: early\n", reportAt: T("11:30"), session: { turnEnded: false, at: T("11:59") } }),
      W.urec("u-young", T("11:00"), { report: "RESULT u-young done: x\n", reportAt: T("11:58"), session: { turnEnded: true, at: T("11:58") } }),
      W.urec("u-nores", T("11:00"), { report: "RESULT u-nores done: shipped\nP.S. one more thing\n", reportAt: T("11:10"), session: { turnEnded: true, at: T("11:10") } }),
      W.urec("u-other", T("11:00"), { report: "RESULT someone-else done: x\n", reportAt: T("11:50"), session: { turnEnded: true, at: T("11:50") } }),
      W.urec("u-old", T("11:00"), { report: "RESULT u-old done: from the last run\n", reportAt: T("10:00"), session: { turnEnded: true, at: T("11:50") } }),
      W.urec("u-ask", T("11:00"), { session: { turnEnded: true, at: T("11:20"), summary: "Should I carry on?" } }),
      W.urec("u-nosess", T("11:00"), { report: "RESULT u-nosess done: x\n", reportAt: T("11:10") }),
      W.urec("u-comp", T("11:00"), { state: "composed", report: "RESULT u-comp done: x\n", reportAt: T("11:10"), session: { turnEnded: true, at: T("11:10") } }),
      W.urec("u-interim", T("11:00"), { report: "RESULT u-interim stopped: interim, full gate waiting on the lock\n", reportAt: T("11:10"), session: { turnEnded: true, at: T("11:10") } }),
    ]);
    const u0 = W.uBytes();
    const key = (slug) => `unattended:worker-${slug}@${T("11:00")}`;
    const mine = (list) => list.filter((e) => e.source === "unattended" && (e.type.startsWith("act.") || e.type === "unattended-stranded"));
    const r1 = W.run(["tick", "--act", "settle-unattended", "--now", T("12:00")]);
    const a1 = mine(W.events());
    const typed = JSON.stringify(a1.map((e) => `${e.type} ${e.key}`));
    check("settle-unattended dry run exit 0", r1.code === 0 && r1.json && r1.json.ok, r1.out);
    check("settle-unattended dry run: would-settle-unattended for u-ok and u-arch only",
      JSON.stringify(keysOf(a1, "act.would-settle-unattended")) === JSON.stringify([key("u-arch"), key("u-ok")]), typed);
    check("a report whose last line is not its RESULT line is never settled", !a1.some((e) => e.type.startsWith("act.") && e.key === key("u-nores")), typed);
    check("a RESULT line for another slug is never settled", !a1.some((e) => e.type.startsWith("act.") && e.key === key("u-other")), typed);
    check("an interim stopped line is progress: a worker waiting its gate turn is never settled", !a1.some((e) => e.type.startsWith("act.") && e.key === key("u-interim")), typed);
    check("a RESULT line from an earlier run is never settled", !a1.some((e) => e.type.startsWith("act.") && e.key === key("u-old")), typed);
    check("a session still running, or quiet less than the grace, is never settled", !a1.some((e) => e.key === key("u-run") || e.key === key("u-young")), typed);
    check("a record whose session is not in the store, or that is composed, is never settled", !a1.some((e) => e.key === key("u-nosess") || e.key === key("u-comp")), typed);
    const ok = a1.find((e) => e.key === key("u-ok")); const arch = a1.find((e) => e.key === key("u-arch"));
    check("would-settle-unattended carries the run status its RESULT line maps to", ok && ok.detail.runStatus === "succeeded" && ok.detail.result === "done" && arch && arch.detail.runStatus === "failed", JSON.stringify([ok, arch]));
    check("unattended-stranded for each quiet session whose report has no RESULT last line", JSON.stringify(keysOf(a1, "unattended-stranded")) === JSON.stringify([key("u-ask"), key("u-nores")]), typed);
    const ask = a1.find((e) => e.type === "unattended-stranded" && e.key === key("u-ask"));
    check("unattended-stranded carries the session's last summary", ask && ask.detail.summary === "Should I carry on?" && ask.detail.quietMin === 40 && ask.detail.why === "no report", JSON.stringify(ask));
    check("settle-unattended dry run leaves the unattended ledger byte-identical", W.uBytes().equals(u0));
    check("settle-unattended dry run spawns no settle", W.uSettles().length === 0, JSON.stringify(W.uSettles()));
    check("settle-unattended lines count the pass", lines(r1).some((l) => /^settle-unattended: 2 ready, 2 new, 0 acted on before, 2 stranded$/.test(l)), JSON.stringify(lines(r1)));

    const n2 = W.events().length;
    W.run(["tick", "--act", "settle-unattended", "--now", T("12:05")]);
    const a2 = mine(W.events().slice(n2));
    check("a second dry pass repeats neither a would-settle nor a stranded event", a2.length === 0, JSON.stringify(a2));

    const n3 = W.events().length;
    const r3 = W.run(["tick", "--act", "settle-unattended", "--live", "--now", T("12:10")]);
    const a3 = mine(W.events().slice(n3));
    const calls = W.uSettles();
    const want = (slug, st) => JSON.stringify(["settle", "--task-id", `worker-${slug}`, "--run-status", st, "--report-read", "--ledger", W.uledger]);
    check("live settle-unattended exit 0", r3.code === 0, r3.out);
    check("live spawns unattended-worker.js settle once per ready record", calls.length === 2 && calls.some((c) => JSON.stringify(c) === want("u-ok", "succeeded")) && calls.some((c) => JSON.stringify(c) === want("u-arch", "failed")), JSON.stringify(calls));
    check("live appends act.settled-unattended per record", JSON.stringify(keysOf(a3, "act.settled-unattended")) === JSON.stringify([key("u-arch"), key("u-ok")]), JSON.stringify(a3));
    check("live names each scheduled task to delete", JSON.stringify(keysOf(a3, "act.delete-scheduled-task")) === JSON.stringify(["worker-u-arch", "worker-u-ok"]), JSON.stringify(a3));
    check("the clock itself never writes the unattended ledger", W.uBytes().equals(u0));
    W.run(["tick", "--act", "settle-unattended", "--live", "--now", T("12:11")]);
    check("a second live pass does not settle again", W.uSettles().length === 2, JSON.stringify(W.uSettles()));
  }
  // H. Any unreadable source stops settle-unattended too, even live.
  {
    const W = world();
    W.setRecords([]);
    W.setUnattended([W.urec("u-ok", T("11:00"), { report: "RESULT u-ok done: shipped\n", reportAt: T("11:30"), session: { turnEnded: true, at: T("11:30") } })]);
    fs.writeFileSync(path.join(W.autodev, "bg-runner.json"), "{ not json");
    const r = W.run(["tick", "--act", "settle-unattended", "--live", "--now", T("12:00")]);
    check("an unreadable source stops settle-unattended", W.uSettles().length === 0 && !W.events().some((e) => e.source === "unattended" && e.type.startsWith("act.")) && lines(r).some((l) => /unreadable this pass: bg-runner/.test(l)), r.out);
  }
  // I. A writer without --report-read is never spawned to settle: COULD-NOT-ACT, once.
  {
    const W = world({ uwOld: true });
    W.setRecords([]);
    W.setUnattended([W.urec("u-ok", T("11:00"), { report: "RESULT u-ok done: shipped\n", reportAt: T("11:30"), session: { turnEnded: true, at: T("11:30") } })]);
    const r = W.run(["tick", "--act", "settle-unattended", "--live", "--now", T("12:00")]);
    W.run(["tick", "--act", "settle-unattended", "--live", "--now", T("12:05")]);
    const cna = W.events().filter((e) => e.type === "act.could-not-act");
    check("an old unattended writer is never spawned and says COULD-NOT-ACT once", W.uSettles().length === 0 && cna.length === 1 && cna[0].key === "settle-unattended" && lines(r).some((l) => /^settle-unattended: COULD-NOT-ACT/.test(l)), JSON.stringify(cna) + JSON.stringify(lines(r)));
  }
  // J. The judge cap: one brain-judge tick per pass, relayed, its --live following the pass.
  {
    const W = world();
    W.setRecords([]);
    const r = W.run(["tick", "--act", "judge", "--now", T("12:00")]);
    const calls = W.bjCalls();
    check("--act judge is accepted and runs one brain-judge tick", r.code === 0 && calls.length === 1 && calls[0][0] === "tick" && /^\d+$/.test(calls[0][calls[0].indexOf("--budget-sec") + 1]), r.out + JSON.stringify(calls));
    check("a dry pass runs the judge tick without --live", calls.length === 1 && !calls[0].includes("--live"), JSON.stringify(calls));
    const rel = W.events().filter((e) => e.source === "brain-judge");
    check("the judge's events land in events.jsonl with source brain-judge", rel.length === 1 && rel[0].type === "judge.would-start" && rel[0].key === "worker-q" && rel[0].detail.taskId === "worker-q", JSON.stringify(rel));
    check("the judge's lines are relayed in the pass", r.json && (r.json.act || []).includes("judge: mode: judge dry, start dry"), r.out);
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:05")]);
    check("a live pass passes --live to the judge tick", W.bjCalls().length === 2 && W.bjCalls()[1].includes("--live"), JSON.stringify(W.bjCalls()));
    W.bjSet("error");
    const e1 = W.run(["tick", "--act", "judge", "--live", "--now", T("12:10")]);
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:15")]);
    const failed = W.events().filter((e) => e.type === "judge.tick-failed");
    check("a failing judge tick is one judge.tick-failed, not one per pass", failed.length === 1 && failed[0].detail.error === "ledger-locked" && e1.json && e1.json.status === "ok" && (e1.json.act || []).some((l) => /^judge: COULD-NOT-ACT: ledger-locked/.test(l)), JSON.stringify(failed) + e1.out);
    W.bjSet("garbage");
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:20")]);
    check("a different failure is reported again", W.events().filter((e) => e.type === "judge.tick-failed").length === 2);
    W.bjSet("ok");
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:25")]);
    check("a recovered judge tick says so once", W.events().filter((e) => e.type === "judge.tick-recovered").length === 1);
  }
  // K. The judge runs when a clock source is unreadable: it reads none of them.
  {
    const W = world();
    W.setRecords([]);
    fs.writeFileSync(path.join(W.autodev, "bg-runner.json"), "{ not json");
    W.run(["tick", "--act", "settle-unattended,judge", "--live", "--now", T("12:00")]);
    check("an unreadable clock source does not stop the judge tick", W.bjCalls().length === 1, JSON.stringify(W.bjCalls()));
  }
  // L. No brain-judge.js: COULD-NOT-ACT once, and the pass is still ok.
  {
    const W = world({ bj: false });
    W.setRecords([]);
    const r = W.run(["tick", "--act", "judge", "--now", T("12:00")]);
    check("a missing brain-judge is COULD-NOT-ACT, and the pass is ok", r.json && r.json.status === "ok" && (r.json.act || []).some((l) => /^judge: COULD-NOT-ACT: no brain-judge\.js/.test(l)) && W.events().filter((e) => e.type === "judge.tick-failed").length === 1, r.out);
  }
  // M. A headless-channel unattended record is never settled by the clock: brain-judge closes it.
  {
    const W = world();
    W.setRecords([]);
    const hrec = { ...W.urec("u-hl", T("11:00"), { report: "RESULT u-hl done: shipped\n", reportAt: T("11:30"), session: { turnEnded: true, at: T("11:30") } }), channel: "headless" };
    const ctrl = W.urec("u-desk", T("11:00"), { report: "RESULT u-desk done: shipped\n", reportAt: T("11:30"), session: { turnEnded: true, at: T("11:30") } });
    W.setUnattended([hrec, ctrl]);
    const r = W.run(["tick", "--act", "settle-unattended", "--live", "--now", T("12:00")]);
    const ids = W.uSettles().map((argv) => argv[argv.indexOf("--task-id") + 1]);
    check("a headless-channel record is skipped, and the Desktop one beside it settles", ids.length === 1 && ids[0] === "worker-u-desk" && r.json && (r.json.act || []).some((l) => /1 headless channel, closed by brain-judge/.test(l)), JSON.stringify(ids) + r.out);
  }
  // N. G4: worker-reconcile.js tick runs before brain-judge.js tick, once each per pass, --live following the pass.
  {
    const W = world();
    W.setRecords([]);
    const r = W.run(["tick", "--act", "judge", "--now", T("12:00")]);
    check("reconcile: the reconcile tick runs before the judge tick", r.code === 0 && JSON.stringify(W.order()) === JSON.stringify(["reconcile", "judge"]), JSON.stringify(W.order()) + r.out);
    check("reconcile: a dry pass runs it without --live", W.wrCalls().length === 1 && W.wrCalls()[0][0] === "tick" && !W.wrCalls()[0].includes("--live"), JSON.stringify(W.wrCalls()));
    check("reconcile: its line is relayed in the pass, before the judge's", r.json && (r.json.act || []).indexOf("reconcile: 0 attempts") >= 0 && (r.json.act || []).indexOf("reconcile: 0 attempts") < (r.json.act || []).indexOf("judge: mode: judge dry, start dry"), r.out);
    W.wrSet("outcomes");
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:05")]);
    check("reconcile: a live pass runs it with --live, still before the judge", W.wrCalls().length === 2 && W.wrCalls()[1].includes("--live") && JSON.stringify(W.order().slice(2)) === JSON.stringify(["reconcile", "judge"]), JSON.stringify(W.wrCalls()) + JSON.stringify(W.order()));
    const rel = () => W.events().filter((e) => e.source === "worker-reconcile");
    const keys = rel().map((e) => `${e.type} ${e.key}`).sort();
    check("reconcile: outcomes are relayed with source worker-reconcile, PENDING and HELD are not", JSON.stringify(keys) === JSON.stringify(["reconcile.orphan worker-o", "reconcile.release worker-h", "reconcile.settled worker-s"]), JSON.stringify(rel()));
    const s = rel().find((e) => e.key === "worker-s");
    check("reconcile: a relayed outcome carries its detail", s && s.detail.live === true && s.detail.why === "exit 0" && s.detail.runStatus === "succeeded" && s.detail.action === "settle", JSON.stringify(s));
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:10")]);
    check("reconcile: a repeated outcome is relayed once, not every pass", rel().length === 3, JSON.stringify(rel()));
    W.wrSet("quiet");
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:15")]);
    W.wrSet("outcomes");
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:20")]);
    check("reconcile: an outcome that went away and came back is relayed again", rel().length === 6, JSON.stringify(rel().map((e) => e.key)));
  }
  // O. G4: a reconcile failure is one event, never a crash, and the judge still runs.
  {
    const W = world();
    W.setRecords([]);
    W.wrSet("crash");
    const r1 = W.run(["tick", "--act", "judge", "--live", "--now", T("12:00")]);
    const r2 = W.run(["tick", "--act", "judge", "--live", "--now", T("12:05")]);
    const failed = () => W.events().filter((e) => e.type === "reconcile.tick-failed");
    check("reconcile failure: the pass is ok and says COULD-NOT-ACT", r1.code === 0 && r1.json && r1.json.status === "ok" && (r1.json.act || []).some((l) => /^reconcile: COULD-NOT-ACT: unparseable-exit-3/.test(l)), r1.out);
    check("reconcile failure: the judge still runs after it", W.bjCalls().length === 2 && JSON.stringify(W.order()) === JSON.stringify(["reconcile", "judge", "reconcile", "judge"]), JSON.stringify(W.order()));
    check("reconcile failure: one reconcile.tick-failed, not one per pass", failed().length === 1 && failed()[0].source === "worker-reconcile" && failed()[0].detail.error === "unparseable-exit-3" && r2.code === 0, JSON.stringify(failed()));
    W.wrSet("error");
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:10")]);
    check("reconcile failure: a different failure is reported again", failed().length === 2 && failed()[1].detail.error === "ledger-locked", JSON.stringify(failed()));
    W.wrSet("quiet");
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:15")]);
    W.run(["tick", "--act", "judge", "--live", "--now", T("12:20")]);
    check("reconcile failure: recovery is said once", W.events().filter((e) => e.type === "reconcile.tick-recovered").length === 1, JSON.stringify(W.events().map((e) => e.type)));
  }
  // P. G4: no worker-reconcile.js is COULD-NOT-ACT once, and a skipped tick relays its line only.
  {
    const W = world({ wr: path.join(root, "no-such-reconcile.js") });
    W.setRecords([]);
    const r = W.run(["tick", "--act", "judge", "--now", T("12:00")]);
    check("reconcile: a missing script is one tick-failed, the pass is ok, the judge runs", r.code === 0 && r.json && r.json.status === "ok" && W.events().filter((e) => e.type === "reconcile.tick-failed").length === 1 && W.bjCalls().length === 1, r.out);
    const W2 = world({ wr: false });
    W2.setRecords([]);
    const r2 = W2.run(["tick", "--act", "judge", "--now", T("12:00")]);
    check("reconcile: off is COULD-NOT-ACT with no beside-the-clock script", r2.json && (r2.json.act || []).some((l) => /^reconcile: COULD-NOT-ACT: no worker-reconcile\.js beside the clock/.test(l)), r2.out);
    const W3 = world();
    W3.setRecords([]);
    W3.wrSet("skipped");
    const r3 = W3.run(["tick", "--act", "judge", "--live", "--now", T("12:00")]);
    const W4 = world();
    W4.setRecords([]);
    W4.wrSet("badshape");
    const r4 = W4.run(["tick", "--act", "judge", "--live", "--now", T("12:00")]);
    check("reconcile: a reply that breaks the relay is one ERROR line, the pass is ok and the judge runs", r4.code === 0 && r4.json && r4.json.status === "ok" && (r4.json.act || []).some((l) => /^reconcile: ERROR /.test(l)) && W4.bjCalls().length === 1, r4.out);
    check("reconcile: a skipped tick relays its line and no outcome", r3.json && (r3.json.act || []).includes("reconcile: reconcile: skipped, kill switch") && W3.events().filter((e) => e.source === "worker-reconcile").length === 0, r3.out);
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { passed: counter.n, fails };
}

// ---------- stalled missions: observe only, relayed once ----------
// A mission-queue.js file with pending work and no activity for the threshold is one
// mission.stalled event, once while it repeats, and one mission.recovered when it clears.
function stallSuite(script) {
  const fails = [];
  const counter = { n: 0 };
  const check = checker(fails, counter);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-clock-stall-"));
  const claude = path.join(root, "claude");
  const missions = path.join(root, "missions");
  const ghFixture = path.join(root, "gh.json");
  w(ghFixture, { open: {}, view: {} });
  const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, BRAIN_CLOCK_DESKTOP_DIR: path.join(root, "desktop"), BRAIN_CLOCK_ROLE_CHECKER: "off", BRAIN_CLOCK_GH_FIXTURE: ghFixture, BRAIN_CLOCK_WORKER_RECONCILE: "off", BRAIN_CLOCK_BRAIN_JUDGE: "off", AUTODEV_MISSIONS_DIR: missions };
  delete env.BRAIN_CLOCK_STALL_MIN;
  const run = (at, extra) => {
    const r = spawnSync(process.execPath, [script, "tick", "--observe", "--now", at], { env: { ...env, ...(extra || {}) }, encoding: "utf8" });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
    return { code: r.status, json, out: r.stdout + r.stderr };
  };
  const events = () => readJsonl(path.join(claude, "autodev", "events.jsonl"));
  const mission = (id, updatedAt, items) => w(path.join(missions, `${id}.json`), { version: 1, cwd: `/repo/${id}`, owner: "s1", mission: `mission ${id}`, items, updatedAt, lastStopAt: updatedAt, lastDecision: "approve" });
  const delta = (fn) => { const before = events().length; const r = fn(); return { r, ev: events().slice(before).filter((e) => e.type.startsWith("mission.")) }; };
  const show = (ev) => JSON.stringify(ev.map((e) => `${e.type} ${e.key}`));
  try {
    // 61 minutes idle with a pending item, one with only inflight and blocked items, one 59 minutes idle.
    mission("aaa111", "2026-09-22T10:59:00Z", [{ id: "pr", state: "pending" }, { id: "w", state: "inflight" }]);
    mission("bbb222", "2026-09-22T09:00:00Z", [{ id: "x", state: "inflight" }, { id: "y", state: "blocked" }, { id: "z", state: "done" }]);
    mission("ccc333", "2026-09-22T11:01:00Z", [{ id: "q", state: "pending" }]);
    let d = delta(() => run(NOW));
    check("stall: pass 1 exit 0", d.r.code === 0 && d.r.json && d.r.json.ok, d.r.out);
    const st = d.ev.filter((e) => e.type === "mission.stalled");
    check("stall: one mission.stalled on pass 1", st.length === 1 && st[0].key === "aaa111" && st[0].source === "mission-queue", show(d.ev));
    check("stall: the event names the pending items and idle minutes", st[0] && JSON.stringify(st[0].detail.pending) === "[\"pr\"]" && st[0].detail.idleMinutes === 61, st[0] && JSON.stringify(st[0].detail));
    check("stall: only inflight and blocked items raise nothing", !d.ev.some((e) => e.key === "bbb222"), show(d.ev));
    check("stall: 59 minutes idle is under the default threshold", !d.ev.some((e) => e.key === "ccc333"), show(d.ev));
    check("stall: a population line for missions", d.r.json && d.r.json.sources.some((l) => /^missions: 1 stalled/.test(l)), d.r.json && d.r.json.sources.join(" | "));
    d = delta(() => run(LATER));
    check("stall: pass 2 relays nothing new", d.r.code === 0 && d.ev.filter((e) => e.key === "aaa111").length === 0, show(d.ev));
    check("stall: ccc333 crosses the threshold on pass 2", d.ev.filter((e) => e.type === "mission.stalled" && e.key === "ccc333").length === 1, show(d.ev));
    // An unreadable missions directory: one COULD-NOT-CHECK line, one event per distinct error, no recovery flood.
    const aside = missions + ".aside";
    fs.renameSync(missions, aside);
    w(missions, "not a directory");
    d = delta(() => run("2026-09-22T12:10:00Z"));
    check("stall: unreadable missions still exits 0", d.r.code === 0 && d.r.json && d.r.json.ok, d.r.out);
    check("stall: unreadable missions is one COULD-NOT-CHECK line", d.r.json && d.r.json.sources.filter((l) => /^missions: COULD-NOT-CHECK/.test(l)).length === 1, d.r.json && d.r.json.sources.join(" | "));
    check("stall: unreadable missions is one check-failed event", d.ev.length === 1 && d.ev[0].type === "mission.check-failed", show(d.ev));
    d = delta(() => run("2026-09-22T12:15:00Z"));
    check("stall: the same error is not relayed twice", d.r.code === 0 && d.ev.length === 0, show(d.ev));
    fs.rmSync(missions, { force: true });
    fs.renameSync(aside, missions);
    // The pending item is done: one mission.recovered, and ccc333 stays relayed once.
    mission("aaa111", "2026-09-22T12:18:00Z", [{ id: "pr", state: "done" }, { id: "w", state: "inflight" }]);
    d = delta(() => run("2026-09-22T12:20:00Z"));
    const rec = d.ev.filter((e) => e.type === "mission.recovered");
    check("stall: the item set to done yields one mission.recovered", rec.length === 1 && rec[0].key === "aaa111", show(d.ev));
    check("stall: the check recovers once", d.ev.filter((e) => e.type === "mission.check-recovered").length === 1, show(d.ev));
    check("stall: a still-stalled mission is not relayed again", !d.ev.some((e) => e.key === "ccc333"), show(d.ev));
    d = delta(() => run("2026-09-22T12:25:00Z"));
    check("stall: recovered is relayed once", d.ev.length === 0, show(d.ev));
    // The threshold is a knob.
    mission("ddd444", "2026-09-22T12:00:00Z", [{ id: "n", state: "pending" }]);
    d = delta(() => run("2026-09-22T12:30:00Z", { BRAIN_CLOCK_STALL_MIN: "30" }));
    check("stall: BRAIN_CLOCK_STALL_MIN sets the threshold", d.ev.filter((e) => e.type === "mission.stalled" && e.key === "ddd444").length === 1, show(d.ev));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  return { passed: counter.n, fails };
}

// ---------- the suite and its plants ----------
function suite(script) {
  const o = observeSuite(script);
  const a = actSuite(script);
  const l = lockSuite(script);
  const s = stallSuite(script);
  return { passed: o.passed + a.passed + l.passed + s.passed, fails: [...o.fails, ...a.fails, ...l.fails, ...s.fails], notes: l.notes };
}

// The planted defects, each derived from the subject: the suite must go red on every one.
const PLANTS = [
  { name: "unreadable source drops its entries", from: "nextSources[name] = { ok: false, entries: prevEntries };", to: "nextSources[name] = { ok: false, entries: {} };" },
  { name: "a vanished PR is never classified", from: "const v = ctx.gh.view(repo, n);", to: "const v = {};" },
  { name: "health ignores the failure streak", from: "const failing = errorStreak >= FAIL_STREAK_UNHEALTHY;", to: "const failing = false;" },
  { name: "baseline floods started events", from: "if (hadPrevious && prevSources[name]) events.push", to: "if (prevSources[name] || true) events.push" },
  { name: "the MSIX package copy is never tried", from: "if (fs.existsSync(path.join(d, \"claude-code-sessions\"))) return d;", to: "if (false) return d;" },
  // G7: acting.
  { name: "the ps probe is ignored", from: "[\"ps\", () => psProbe(pid, ps)]", to: "[\"ps\", () => \"dead\"]" },
  { name: "a probe that cannot tell reads as dead", from: "if (all.some((p) => p === \"unknown\" || p === \"absent\")) return { verdict: \"unknown\", probes };", to: "" },
  { name: "the grace is ignored", from: "if (quietMs < graceMs) return", to: "if (false) return" },
  { name: "acts are keyed on code alone", from: "const key = `${rec.code}@${rec.startedAt}`;", to: "const key = String(rec.code);" },
  { name: "an unreadable source does not stop acting", from: "if (unreadable.length) { out.lines.push", to: "if (false) { out.lines.push" },
  { name: "a dry run spawns the writer", from: "if (!a.live) {\n      for (const c of todo) {\n        ev(c.cap", to: "if (false) {\n      for (const c of todo) {\n        ev(c.cap" },
  { name: "a writer that cannot take the key is spawned anyway", from: "if (support.missing[c.cap]) continue;", to: "" },
  // G7 step 2: settle-unattended.
  { name: "an unattended report without its RESULT last line is settled", from: "const res = fresh ? lastLineResult(report.text, rec.slug) : null;", to: "const res = fresh ? (lastLineResult(report.text, rec.slug) || { result: \"done\", sentence: \"\" }) : null;" },
  { name: "a RESULT line anywhere in the report counts", from: ".exec(lines[lines.length - 1]);", to: ".exec(lines.find((l) => l.startsWith(\"RESULT \")) || \"\");" },
  { name: "an interim stopped line settles its worker", from: "if (res.result === \"stopped\" && /^interim(?![a-z])/i.test(res.sentence)) return", to: "if (false) return" },
  { name: "a running session is settled", from: "if (!ended) return", to: "if (false) return" },
  { name: "an earlier run's report counts", from: "const fresh = report.text !== null && report.mtime >= started - 1000;", to: "const fresh = report.text !== null;" },
  { name: "an unreadable source does not stop settle-unattended", from: "if (unreadable.length) { out.lines.push(", to: "if (unreadable.length && !a.caps.includes(\"settle-unattended\")) { out.lines.push(" },
  { name: "a dry settle-unattended spawns the writer", from: "if (!a.live) {\n    for (const c of todo) {\n      ev(\"act.would-settle-unattended\"", to: "if (false) {\n    for (const c of todo) {\n      ev(\"act.would-settle-unattended\"" },
  { name: "an unattended record is settled twice", from: "if (acted.live[key] || (!a.live && acted.dry[key])) { before++; continue; }", to: "" },
  { name: "stranded is reported every pass", from: "if (!acted.stranded[key]) {", to: "if (true) {" },
  { name: "an old unattended writer is spawned anyway", from: "  if (support.missing) {\n", to: "  if (false) {\n" },
  // A9: the judge cap.
  { name: "the judge cap is refused", from: "\"settle-unattended\", \"judge\"];", to: "\"settle-unattended\"];" },
  { name: "a live pass runs the judge dry", from: "String(Math.floor(budgetMs / 1000))];\n    if (a.live) argv.push(\"--live\");", to: "String(Math.floor(budgetMs / 1000))];" },
  { name: "a judge failure is reported every pass", from: "if (state.lastError !== error) out.events.push({ type: \"judge.tick-failed\"", to: "if (true) out.events.push({ type: \"judge.tick-failed\"" },
  { name: "relayed judge events lose their source", from: "source: \"brain-judge\", key: String(e.key)", to: "source: String(e.source || \"unknown\"), key: String(e.key)" },
  { name: "a headless-channel record is settled by the clock", from: "  if (rec.channel === \"headless\") return { skip: \"headless channel, closed by brain-judge\" };\n", to: "" },
  // U2: the lock.
  { name: "a held lock does not skip the pass", from: "if (!lock.acquired) return { ok: true, skipped: true,", to: "if (false) return { ok: true, skipped: true," },
  { name: "a process drops a lock it does not hold", from: "  return { released: false, why: \"this process holds no lock\" };", to: "  try { fs.unlinkSync(LOCK_PATH); } catch { /* none */ } return { released: true };" },
  { name: "the clock ignores ledger-lock.js", from: "const h = ledgerLock.acquireLock(LOCK_PATH, { waitMs, meta });", to: "fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, ...meta })); const h = { acquired: true, release: () => { fs.unlinkSync(LOCK_PATH); return { released: true }; } };" },
  // G4: reconcile before judge.
  { name: "the judge runs before reconcile", from: "        let rc;\n        try { rc = actReconcile(a); }", to: "        try { actJudge(a, started); } catch { /* planted */ }\n        let rc;\n        try { rc = actReconcile(a); }" },
  { name: "a live pass runs reconcile dry", from: "    const argv = [script, \"tick\"];\n    if (a.live) argv.push(\"--live\");", to: "    const argv = [script, \"tick\"];" },
  { name: "a reconcile failure is reported every pass", from: "if (state.lastError !== error) out.events.push({ type: \"reconcile.tick-failed\"", to: "if (true) out.events.push({ type: \"reconcile.tick-failed\"" },
  { name: "a repeated reconcile outcome is relayed every pass", from: "          if (seen.has(k)) continue;\n", to: "" },
  { name: "a reconcile throw fails the pass", from: "        try { rc = actReconcile(a); } catch (e) {", to: "        try { rc = actReconcile(a); } catch (e) { throw e;" },
  { name: "reconcile PENDING outcomes flood the events", from: "if (o && o.outcome && o.outcome !== \"PENDING\") rows.push(o);", to: "if (o && o.outcome) rows.push(o);" },
  // Stalled missions.
  { name: "the clock never calls stalled", from: "list = require(path.join(__dirname, \"mission-queue.js\")).stalled(minutes, now, { dir: missionsDir(), strict: true });", to: "list = [];" },
  { name: "a stalled mission is relayed every pass", from: "      if (seen.has(key)) continue;\n      ev(\"mission.stalled\"", to: "      ev(\"mission.stalled\"" },
  { name: "an unreadable missions directory reads as none stalled", from: "{ dir: missionsDir(), strict: true }", to: "{ dir: missionsDir(), strict: false }" },
  // The state schema.
  { name: "a newer state schema is written over", from: "  if (meta.error || meta.schema > STATE_SCHEMA) {", to: "  if (false) {" },
  { name: "the state schema is never recorded", from: "    if (!meta.recorded || meta.schema !== STATE_SCHEMA) writeJson(STATE_META,", to: "    if (false) writeJson(STATE_META," },
  { name: "the judge runs only when every source reads", from: "      if (a.caps.includes(\"judge\")) {\n", to: "      if (a.caps.includes(\"judge\") && !Object.values(results).some((x) => !x.ok)) {\n" },
];

function main() {
  const t0 = Date.now();
  const real = suite(SUBJECT);
  for (const n of OKS) console.log(`ok ${n}`);
  for (const n of real.notes || []) console.log(n);
  for (const f of real.fails) console.log(`FAIL ${f}`);
  console.log(`brain-clock: ${real.passed} passed, ${real.fails.length} failed`);
  let plantFailures = 0;
  const only = process.argv.includes("--plant") ? process.argv[process.argv.indexOf("--plant") + 1] : null;
  if (process.argv.includes("--plants") || only) {
    const src = fs.readFileSync(SUBJECT, "utf8");
    // A copy of the whole scripts folder, so the mutant loads the real ledger-lock.js beside it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-clock-plant-"));
    for (const f of fs.readdirSync(SCRIPTS)) if (f.endsWith(".js")) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, f));
    const chosen = PLANTS.filter((p) => !only || p.name === only);
    for (const p of chosen) {
      const hits = src.split(p.from).length - 1;
      if (hits !== 1) { console.log(`PLANT-BROKEN ${p.name}: anchor matched ${hits} times`); plantFailures++; continue; }
      const mutant = path.join(dir, "brain-clock.js");
      fs.writeFileSync(mutant, src.replace(p.from, () => p.to));
      // A mutant that crashes the suite is caught too: the crash is its red check.
      let r;
      try { r = suite(mutant); } catch (e) { r = { fails: [`the suite crashed: ${String(e && e.message || e).slice(0, 200)}`] }; }
      if (r.fails.length === 0) { console.log(`PLANT-SURVIVED ${p.name}`); plantFailures++; } else console.log(`plant caught: ${p.name} (${r.fails.length} checks red, first: ${r.fails[0]})`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`plants: ${chosen.length - plantFailures}/${chosen.length} caught`);
  }
  console.log(`took ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exitCode = real.fails.length || plantFailures ? 1 : 0;
}
main();
