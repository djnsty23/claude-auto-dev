#!/usr/bin/env node
// find-untested-hooks.js — a hook wired into hooks.json that no suite EXECUTES.
//
// This is a class find-orphan-checks.js structurally cannot see. That tool asks
// "is this assertion script referenced by a runner?" — it is about scripts that
// CONTAIN checks. This asks the opposite question: "is this production hook the
// SUBJECT of any check?" A hook can be wired, run on every turn, and have no
// test at all, and nothing in this repo noticed until a silence sweep tripped
// over it by accident.
//
// THE AUDIT CORRECTION (codex adversarial audit 2026-08-30, F5). Coverage used
// to be a regex over suite source: a `path.resolve(..., 'hook.js')` literal was
// enough. The audit's mutation replaced a hook's only suite with one that kept
// the literal and exited BEFORE require(HOOK) — the vacuous suite passed, and
// this checker still printed "driven by a suite". A path literal is a REFERENCE;
// only execution is evidence.
//
// So the verdict is execution-based now. Each suite that statically references
// a hook is run once under NODE_V8_COVERAGE, and a hook counts as covered only
// when some suite's run actually LOADED the hook file — in-process or in a
// spawned child, since the env var propagates to children. The static matcher
// survives as the SELECTOR of which suites to execute, never as the verdict:
// that scoping is also what makes this checker non-recursive, because the
// acceptance test that drives it keeps hook basenames out of its own source and
// therefore is never selected.
//
// Known limit, inherited from V8: coverage is written on normal exit, never on
// SIGTERM. A suite that KILLS the process driving a hook contributes no
// evidence, and its hook lands in `untested`. Today no hook suite does that
// (hooks are run-to-completion scripts, unlike watch-panels/fleet-board); if
// one ever does, the fix is an execution manifest, not a looser matcher.
//
// Usage: node tooling/find-untested-hooks.js [--json]

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TOOLING = path.join(ROOT, 'tooling');
const asJson = process.argv.includes('--json');

// --- every hook wired in every plugin's hooks.json ---
const wired = [];
for (const plugin of fs.readdirSync(path.join(ROOT, 'plugins'))) {
    const cfg = path.join(ROOT, 'plugins', plugin, 'hooks', 'hooks.json');
    if (!fs.existsSync(cfg)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { continue; }
    for (const [event, matchers] of Object.entries(json.hooks || {})) {
        for (const m of matchers || []) {
            for (const h of m.hooks || []) {
                // Exec form keeps the script path in `args`, shell form keeps it
                // in `command`. Join both so the .js matcher below sees either.
                const cmd = [h.command || '', ...(h.args || [])].join(' ');
                const hit = cmd.match(/([\w-]+\.js)/);
                if (!hit) continue;
                const file = path.join(ROOT, 'plugins', plugin, 'hooks', hit[1]);
                if (fs.existsSync(file)) wired.push({ plugin, event, name: hit[1], file });
            }
        }
    }
}

// --- strip comments, so a stale header cannot select a suite for execution ---
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
}

const suites = fs.readdirSync(TOOLING)
    .filter((f) => /^test-.*\.js$/.test(f))
    .map((f) => ({ name: f, code: code(fs.readFileSync(path.join(TOOLING, f), 'utf8')) }));

// A suite is a CANDIDATE when it resolves or runs the hook — a path.join/resolve
// segment, or the filename handed to a run/spawn helper. A bare quoted mention
// is not enough (a test ABOUT this detector quotes hook names; counting it
// would let the detector's own test silence it).
const refRe = (name) => {
    const n = name.replace(/\./g, '\\.');
    return new RegExp(
        `(?:path\\.(?:join|resolve)\\([^)]*|\\w*(?:un|pawn)\\w*\\(\\s*(?:[^)]*,\\s*)?\\[?\\s*)['"\`]${n}['"\`]`
    );
};
const referenced = new Map();   // suite name -> Set of hook names it references
for (const h of wired) {
    const re = refRe(h.name);
    for (const s of suites) {
        if (!re.test(s.code)) continue;
        if (!referenced.has(s.name)) referenced.set(s.name, new Set());
        referenced.get(s.name).add(h.name);
    }
}

// POPULATION FLOOR. Zero wired hooks means hooks.json was not found or not
// parsed — not that every hook is tested. This is a hard gate in validate, so
// that distinction is the difference between a green run and a green LIE.
if (!wired.length) {
    const msg = 'REFUSING: found 0 wired hooks. hooks.json is missing, unparseable, or moved — '
        + 'this cannot report coverage for a population it never found.';
    if (asJson) console.log(JSON.stringify({ error: msg, wired: 0 }, null, 2));
    else console.error('\n' + msg + '\n');
    process.exit(1);
}

// --- execution evidence -----------------------------------------------------
// Each candidate suite runs once with V8 coverage on. The env flag stops a
// pathological candidate that spawned this checker from re-entering the
// execution phase; no current candidate does, and the flag keeps it that way.
const hookByLower = new Map(wired.map((h) => [h.file.toLowerCase(), h]));
const executedBy = new Map();   // hook name -> Set of suite names whose RUN loaded it
const suiteProblems = [];

if (!process.env.AUTODEV_HOOKCHECK_CHILD) {
    for (const [suiteName] of referenced) {
        const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcov-'));
        let r;
        try {
            r = cp.spawnSync(process.execPath, [path.join(TOOLING, suiteName)], {
                cwd: ROOT,
                encoding: 'utf8',
                windowsHide: true,
                timeout: 120000,
                env: { ...process.env, NODE_V8_COVERAGE: covDir, AUTODEV_HOOKCHECK_CHILD: '1' },
            });
            if (r.error || r.status !== 0) {
                suiteProblems.push(suiteName + ' exited '
                    + (r.error ? String(r.error.code || r.error.message) : r.status)
                    + ' — its coverage still counts, its verdict does not');
            }
            let dumps = [];
            try { dumps = fs.readdirSync(covDir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
            for (const d of dumps) {
                let cov;
                try { cov = JSON.parse(fs.readFileSync(path.join(covDir, d), 'utf8')); } catch { continue; }
                for (const script of cov.result || []) {
                    if (!script.url || !script.url.startsWith('file://')) continue;
                    let p;
                    try { p = path.resolve(fileURLToPath(script.url)).toLowerCase(); } catch { continue; }
                    const hook = hookByLower.get(p);
                    if (!hook) continue;
                    if (!executedBy.has(hook.name)) executedBy.set(hook.name, new Set());
                    executedBy.get(hook.name).add(suiteName);
                }
            }
        } finally {
            fs.rmSync(covDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }
}

const rows = wired.map((h) => ({
    ...h,
    // `covering` is EXECUTION evidence. `referencedBy` is the static candidate
    // list, reported so a reader can see the two disagree — a referenced-but-
    // never-executed hook is precisely the audit's vacuous-suite case.
    covering: [...(executedBy.get(h.name) || [])].sort(),
    referencedBy: [...referenced.entries()]
        .filter(([, hooks]) => hooks.has(h.name)).map(([s]) => s).sort(),
}));

const untested = rows.filter((r) => r.covering.length === 0);

if (asJson) {
    console.log(JSON.stringify({
        wired: rows.length,
        suitesExecuted: process.env.AUTODEV_HOOKCHECK_CHILD ? 0 : referenced.size,
        suiteProblems,
        wiredRows: rows,
        untested,
    }, null, 2));
    process.exit(untested.length ? 1 : 0);
}

console.log(`\n${rows.length} wired hook(s) · ${referenced.size} candidate suite(s) executed under coverage · `
    + `${rows.length - untested.length} EXECUTED by a suite · ${untested.length} with no execution evidence\n`);
for (const w of suiteProblems) console.log('  [warn] ' + w);

if (!untested.length) {
    console.log('Every wired hook was actually loaded by at least one suite run.\n');
    process.exit(0);
}

console.log('Wired into production, executed by nothing:\n');
for (const r of untested) {
    const lines = fs.readFileSync(r.file, 'utf8').split('\n').length;
    const ref = r.referencedBy.length
        ? `referenced by ${r.referencedBy.join(', ')} without ever loading it — a path literal is not a test`
        : 'referenced by nothing';
    console.log(`  ✗ ${r.plugin}/hooks/${r.name}  (${lines} lines, ${r.event}) — ${ref}`);
}
console.log('\nThese run on real sessions. A hook with no execution evidence is not a gap in');
console.log('coverage — it is production code nobody has ever asserted anything about.\n');
process.exit(1);
