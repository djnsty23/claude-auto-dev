#!/usr/bin/env node
// Tests for knowledge AUTO-INJECTION in hooks/post-tool-typecheck.js (roadmap §3.2).
// Drives the REAL hook as a subprocess (like test-telemetry-hook.js / test-pre-tool-filter.js):
//   spawnSync(node, [hookPath], { input: JSON.stringify(event), env, cwd }).
//
// The hook resolves memory-db from ${CLAUDE_PLUGIN_ROOT}/scripts/, so a fake plugin
// root is built in a temp dir with memory-db.js + semantic-search.js copied in, and
// HOME is redirected too because memory-db puts the DB under HOME/.claude.
// observation-classifier.js is DELIBERATELY NOT copied: without it the hook's
// capture block is skipped, so the ONLY observations in the DB are the ones this
// test seeds — which makes the injection/throttle/empty assertions deterministic.
//
// Run: node scripts/test-knowledge-injection.js  (exit 1 on any failure)

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-memory', 'hooks', 'memory-capture.js');
const REPO_SCRIPTS = path.resolve(__dirname, "..", "plugins", "autodev-memory", "scripts");

// realpathSync matters on macOS: os.tmpdir() hands back /var/folders/... while a
// child process reports cwd as the resolved /private/var/folders/..., so an
// unresolved path makes every path.relative() in the hook look outside the project.
const TMP_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'knowinject-home-')));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

// Install the pieces the hook needs into ~/.claude/scripts (NOT the classifier —
// see header note: omitting it disables capture so seeded rows are the only rows).
const PLUGIN_ROOT = path.join(TMP_HOME, "fake-plugin");
const HOME_SCRIPTS = path.join(PLUGIN_ROOT, "scripts");
fs.mkdirSync(HOME_SCRIPTS, { recursive: true });
for (const f of ['memory-db.js', 'semantic-search.js', 'session-carrier.js']) {
  fs.copyFileSync(path.join(REPO_SCRIPTS, f), path.join(HOME_SCRIPTS, f));
}

// Require the (HOME-redirected) memory-db to seed the shared DB. It derives its
// DB path from HOME at load time, so it points at the same file the hook opens.
const memDB = require(path.join(HOME_SCRIPTS, 'memory-db.js'));

const cases = [];

if (!memDB.isAvailable()) {
  console.log('[skip] node:sqlite unavailable — skipping knowledge auto-injection tests');
} else {
  const PROJ = path.join(TMP_HOME, 'proj');
  fs.mkdirSync(PROJ, { recursive: true });
  const SESSION = 'test-sess-1';

  // Seed accumulated knowledge for area src/auth (three types).
  const sid = memDB.startSession(PROJ);
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'decision',
    title: 'chose JWT for sessions',
    concept: 'stateless tokens avoid a server-side session store',
    sourceFiles: ['src/auth/jwt.js']
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'bugfix',
    title: 'fixed token refresh race',
    concept: 'two refreshes could both mint tokens',
    sourceFiles: ['src/auth/refresh.js']
  });
  memDB.saveObservation({
    sessionId: sid, projectPath: PROJ, type: 'discovery',
    title: 'rate limiter is per-node not global',
    concept: 'each instance keeps its own counter',
    sourceFiles: ['src/auth/limiter.js']
  });

  // Drive the hook as a subprocess with a fixed session id (deterministic throttle key).
  function edit(relFile) {
    const event = {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(PROJ, relFile) },
      tool_output: 'ok',
      session_id: SESSION,
      cwd: PROJ
    };
    return spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      cwd: PROJ,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP_HOME, USERPROFILE: TMP_HOME }
    });
  }

  const surfacedFile = path.join(PROJ, '.claude', 'knowledge-surfaced');

  // 1) First edit in src/auth → injection fires on stderr.
  const r1 = edit('src/auth/login.js');
  cases.push(['first edit exits 0', r1.status === 0]);
  cases.push(['first edit emits the domain-knowledge header for src/auth',
    /\[Memory\] Domain knowledge for src\/auth \(3 notes\):/.test(r1.stderr || '')]);
  cases.push(['injection surfaces a seeded item (JWT decision)',
    (r1.stderr || '').includes('chose JWT for sessions')]);
  cases.push(['throttle state file records the (session, area) marker',
    fs.existsSync(surfacedFile) &&
    fs.readFileSync(surfacedFile, 'utf8').split('\n').includes(`${SESSION}\tsrc/auth`)]);

  // 2) Second edit in the SAME area + session → throttled, no re-emit.
  const r2 = edit('src/auth/logout.js');
  cases.push(['second edit exits 0', r2.status === 0]);
  cases.push(['second edit in same area/session does NOT re-emit (throttle works)',
    !/Domain knowledge for src\/auth/.test(r2.stderr || '')]);

  // 3) Edit in an area with NO accumulated knowledge → emits nothing, no crash.
  const r3 = edit('src/billing/invoice.js');
  cases.push(['edit in empty area exits 0', r3.status === 0]);
  cases.push(['edit in area with no knowledge emits no domain-knowledge line',
    !/Domain knowledge/.test(r3.stderr || '')]);
  cases.push(['empty area is still recorded as surfaced (no recompute next edit)',
    fs.readFileSync(surfacedFile, 'utf8').split('\n').includes(`${SESSION}\tsrc/billing`)]);

  // 4) A root-level file (no area) is skipped entirely — no injection, no crash.
  const r4 = edit('README.md');
  cases.push(['root-level file edit exits 0', r4.status === 0]);
  cases.push(['root-level file edit emits no domain-knowledge line',
    !/Domain knowledge/.test(r4.stderr || '')]);

  // 5) A DIFFERENT session sees the same area fresh (throttle is session-scoped).
  const r5 = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(PROJ, 'src/auth/token.js') }, tool_output: 'ok', session_id: 'test-sess-2', cwd: PROJ }),
    encoding: 'utf8',
    cwd: PROJ,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP_HOME, USERPROFILE: TMP_HOME }
  });
  cases.push(['new session re-surfaces the same area (session-scoped throttle)',
    /Domain knowledge for src\/auth/.test(r5.stderr || '')]);

  // 6) CAPTURE-ACTIVE: unlike the rest of this suite, KEEP observation-classifier.js
  //    installed so the hook's capture block runs BEFORE injection (as in production).
  //    Uses its own temp HOME/DB so it can't perturb the deterministic cases above.
  //    With capture live the exact note count is nondeterministic, so we assert the
  //    invariants that must always hold: exit 0, no crash, at most ONE injection
  //    header for the area (capture→inject ordering doesn't double-handle), and the
  //    throttle marker written exactly once.
  {
    const CAP_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'knowinject-cap-')));
    const CAP_PLUGIN_ROOT = path.join(CAP_HOME, "fake-plugin");
    const CAP_SCRIPTS = path.join(CAP_PLUGIN_ROOT, "scripts");
    fs.mkdirSync(CAP_SCRIPTS, { recursive: true });
    for (const f of ['memory-db.js', 'semantic-search.js', 'observation-classifier.js', 'session-carrier.js']) {
      fs.copyFileSync(path.join(REPO_SCRIPTS, f), path.join(CAP_SCRIPTS, f));
    }

    // Seed src/auth knowledge into CAP_HOME's DB (memory-db binds DB_PATH from HOME
    // at load time, so temporarily point HOME at CAP_HOME while requiring/seeding).
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = CAP_HOME;
    process.env.USERPROFILE = CAP_HOME;
    const capDB = require(path.join(CAP_SCRIPTS, 'memory-db.js'));
    const CAP_PROJ = path.join(CAP_HOME, 'proj');
    fs.mkdirSync(CAP_PROJ, { recursive: true });
    const capSid = capDB.startSession(CAP_PROJ);
    capDB.saveObservation({
      sessionId: capSid, projectPath: CAP_PROJ, type: 'decision',
      title: 'chose bcrypt for password hashing',
      concept: 'adaptive cost factor resists brute-force attacks',
      sourceFiles: ['src/auth/hash.js']
    });
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;

    const CAP_SESSION = 'cap-sess-1';

    // Seed the session carrier so the capture block has a memory session to
    // write into — capture is keyed on the carrier, not on an env var.
    require(path.join(CAP_SCRIPTS, 'session-carrier.js')).write(CAP_PROJ, CAP_SESSION, capSid);

    const capRun = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: path.join(CAP_PROJ, 'src/auth/login.js') },
        tool_output: 'ok',
        session_id: CAP_SESSION,
        cwd: CAP_PROJ
      }),
      encoding: 'utf8',
      cwd: CAP_PROJ,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: CAP_PLUGIN_ROOT, HOME: CAP_HOME, USERPROFILE: CAP_HOME }
    });

    const capErr = capRun.stderr || '';
    const headerCount = (capErr.match(/Domain knowledge for src\/auth/g) || []).length;
    cases.push(['capture-active: hook exits 0 with capture block running', capRun.status === 0]);
    cases.push(['capture-active: no hook crash / uncaught error',
      !/post-tool-typecheck error:/.test(capErr) && !/\[Memory\] capture error:/.test(capErr)]);
    cases.push(['capture-active: at most one injection header for the area (no double-handle)',
      headerCount <= 1]);
    cases.push(['capture-active: throttle marker recorded exactly once for (session, area)', (() => {
      const sf = path.join(CAP_PROJ, '.claude', 'knowledge-surfaced');
      if (!fs.existsSync(sf)) return false;
      const lines = fs.readFileSync(sf, 'utf8').split('\n').filter(Boolean);
      return lines.filter((l) => l === `${CAP_SESSION}\tsrc/auth`).length === 1;
    })()]);

    try { fs.rmSync(CAP_HOME, { recursive: true, force: true }); } catch {}
  }
}

// --- Report ---
let pass = 0, fail = 0;
cases.forEach(([label, ok]) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  ok ? pass++ : fail++;
});
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
