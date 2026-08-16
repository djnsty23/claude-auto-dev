#!/usr/bin/env node
// find-untested-hooks.js — a hook wired into hooks.json that no suite drives.
//
// This is a class find-orphan-checks.js structurally cannot see. That tool asks
// "is this assertion script referenced by a runner?" — it is about scripts that
// CONTAIN checks. This asks the opposite question: "is this production hook the
// SUBJECT of any check?" A hook can be wired, run on every turn, and have no
// test at all, and nothing in this repo noticed until a silence sweep tripped
// over it by accident.
//
// Measured when it was written: 3 of 13 wired hooks had no suite —
// post-tool-typecheck.js (107 lines, PostToolUse, blocks on typecheck failure),
// pre-compact.js, post-compact.js. All 3 confirmed by hand. No false positives:
// every other hook is spawned or path-resolved by a named suite.
//
// A hook is COVERED if some tooling/test-*.js mentions its filename in a way
// that resolves to it — a path.join/resolve segment, or a bare filename passed
// to a spawn helper. Mentions inside comments do not count, and that distinction
// is the whole precision of this check: post-tool-typecheck.js LOOKED covered
// because a suite's stale header comment named it.
//
// Usage: node tooling/find-untested-hooks.js [--json]

const fs = require('fs');
const path = require('path');

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
                const cmd = h.command || '';
                const hit = cmd.match(/([\w-]+\.js)/);
                if (!hit) continue;
                const file = path.join(ROOT, 'plugins', plugin, 'hooks', hit[1]);
                if (fs.existsSync(file)) wired.push({ plugin, event, name: hit[1], file });
            }
        }
    }
}

// --- strip comments, so a stale header cannot pass for coverage ---
//
// Now REDUNDANT with the resolution-context matcher below, and knowingly kept.
// Mutation confirms it: disabling this stripping changes no assertion, because a
// header comment cannot match `path.join(...'x.js')` in the first place. The
// behaviour it was added for IS tested — loosening the matcher to any quoted
// mention turns that assertion red. This is belt-and-braces against a future
// looser matcher, not the thing currently doing the work; do not read its
// presence as coverage.
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

// Coverage means the suite RESOLVES or RUNS the hook — a path.join/resolve
// segment, or the filename handed to a run/spawn helper. A bare quoted mention
// is not enough, and that distinction was learned the hard way twice over:
//
//   1. post-tool-typecheck.js looked covered because a suite's stale HEADER
//      COMMENT named it. Comments are stripped above.
//   2. Then it looked covered again because tooling/test-validate.js asserts
//      `names.includes('post-tool-typecheck.js')` — a test ABOUT this detector,
//      quoting the filename, counted as a test OF the hook. A detector that its
//      own test can silence is worse than no detector.
const rows = wired.map((h) => {
    const n = h.name.replace(/\./g, '\\.');
    const re = new RegExp(
        `(?:path\\.(?:join|resolve)\\([^)]*|\\w*(?:un|pawn)\\w*\\(\\s*(?:[^)]*,\\s*)?\\[?\\s*)['"\`]${n}['"\`]`
    );
    const covering = suites.filter((s) => re.test(s.code)).map((s) => s.name);
    return { ...h, covering };
});

const untested = rows.filter((r) => r.covering.length === 0);

if (asJson) {
    // `wiredRows` carries the covering suites per hook, so a caller can assert
    // WHICH suite covers a hook rather than only how many are uncovered. Without
    // it, any assertion about coverage attribution passes vacuously.
    console.log(JSON.stringify({ wired: rows.length, wiredRows: rows, untested }, null, 2));
    process.exit(untested.length ? 1 : 0);
}

console.log(`\n${rows.length} wired hook(s) · ${rows.length - untested.length} driven by a suite · ${untested.length} with NO suite\n`);

if (!untested.length) {
    console.log('Every wired hook is the subject of at least one suite.\n');
    process.exit(0);
}

console.log('Wired into production, tested by nothing:\n');
for (const r of untested) {
    const lines = fs.readFileSync(r.file, 'utf8').split('\n').length;
    console.log(`  ✗ ${r.plugin}/hooks/${r.name}  (${lines} lines, ${r.event})`);
}
console.log('\nThese run on real sessions. A hook with no test is not a gap in coverage —');
console.log('it is production code nobody has ever asserted anything about.\n');
process.exit(1);
