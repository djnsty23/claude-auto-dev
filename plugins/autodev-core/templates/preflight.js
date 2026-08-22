#!/usr/bin/env node
/* preflight — the rigidity gate that runs before every deploy.
 *
 * Scaffolded by autodev's `preflight` skill. Add gates for the bug families
 * THIS project actually ships (run `/learn-from-fixes` to rank them). Delete
 * the examples once you have real ones.
 *
 * Four laws, each learned by a production repo the hard way. Do not soften them.
 *
 * 1. A GATE THAT COULD NOT RUN IS NOT A PASS.
 *    Every gate sits in try/catch so one broken gate cannot take out the run —
 *    but routing that catch to a warning lets a gate switch ITSELF off and still
 *    exit 0. That shipped: renaming one file turned a parity gate into
 *    "check skipped" and preflight printed PASS. skipped() counts as HARD.
 *
 * 2. SNAPSHOT BEFORE YOU REGENERATE.
 *    If a gate compares a generated artifact against its source, read the
 *    artifact from disk BEFORE any step regenerates it. Otherwise the gate
 *    compares the generator against its own output and is green forever. That
 *    shipped two consecutive stale releases with preflight passing.
 *
 * 3. A KNOWN-RED EXCUSE THAT NOW PASSES IS A FAILURE.
 *    Tracked failures need an owner and an open work item, and the run must fail
 *    when a known-red check starts passing — a stale excuse is how a real
 *    failure gets waved through.
 *
 * 4. A GATE NEVER SEEN TO FAIL IS NOT KNOWN TO WORK.
 *    When you add a gate, reintroduce the original defect and watch it go red
 *    before you trust it.
 *
 * Exit 1 on any hard failure. Warnings never fail the run.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.relative(ROOT, p) || p;

let hard = 0;
let warn = 0;

const fail = (m) => { console.error('  ✗ ' + m); hard++; };
const soft = (m) => { console.warn('  ⚠ ' + m); warn++; };
const ok = (m) => console.log('  · ' + m);

// Law 1: a gate that could not run is a HARD failure, never a warning.
const skipped = (m) => { console.error('  ✗ GATE DID NOT RUN — ' + m); hard++; };

/**
 * Register a gate. `id` names the bug family it prevents, not the mechanism —
 * "[parity]" and "[action-reach]" tell a future reader why the gate exists.
 */
function gate(id, why, fn) {
    process.stdout.write(`\n[${id}] ${why}\n`);
    try {
        fn();
    } catch (e) {
        skipped(`[${id}] ${String(e && e.message).split('\n')[0]}`);
    }
}

// ---------------------------------------------------------------------------
// Law 3: tracked failures. Key = gate id, value = why + the open work item.
// The run fails on a NEW red, and equally on a tracked red that now passes.
// ---------------------------------------------------------------------------
// Keys are BARE gate ids — the same string passed to gate() and trackedFail(),
// with no brackets. A mismatch here silently disables tracking.
const KNOWN_RED = {
    // 'example': 'blocked on S4-012 — vendor fix landing next week',
};
const redSeen = new Set();

function trackedFail(id, message) {
    redSeen.add(id);
    if (KNOWN_RED[id]) {
        console.warn(`  ⚠ known red [${id}]: ${KNOWN_RED[id]}`);
    } else {
        fail(`[${id}] ${message}`);
    }
}

// ---------------------------------------------------------------------------
// Gates. Replace these with the classes /learn-from-fixes ranks for this repo.
// ---------------------------------------------------------------------------

gate('syntax', 'every shipped script parses', () => {
    const dirs = ['src', 'app', 'lib', 'scripts', 'api'].filter((d) => fs.existsSync(path.join(ROOT, d)));
    if (!dirs.length) return soft('no source directories found — nothing to parse-check');
    let n = 0;
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.(js|mjs|cjs)$/.test(e.name)) {
                n++;
                try {
                    // execFileSync, not execSync: `full` comes from readdirSync and a
                    // double quote is legal in a POSIX filename, so shell quoting here is
                    // decorative. argv form never reaches a shell.
                    cp.execFileSync('node', ['--check', full], { stdio: ['ignore', 'ignore', 'pipe'] });
                } catch (e2) {
                    fail(`${rel(full)} does not parse: ${String(e2.stderr).split('\n')[0]}`);
                }
            }
        }
    };
    dirs.forEach((d) => walk(path.join(ROOT, d)));
    ok(`${n} scripts parse`);
});

gate('gates-ran', 'this file is wired into something that runs it', () => {
    // A gate file nobody runs is decoration. Assert it is reachable from CI and
    // from a package script, so preflight cannot quietly stop being enforced.
    const pkgPath = path.join(ROOT, 'package.json');
    if (!fs.existsSync(pkgPath)) return soft('no package.json — wire preflight into your build another way');
    const scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts) || {};
    const wired = Object.values(scripts).some((s) => String(s).includes('preflight'));
    if (!wired) fail('no package.json script runs preflight — add one, or this file is decoration');
    else ok('reachable from a package script');

    const ciDir = path.join(ROOT, '.github', 'workflows');
    if (fs.existsSync(ciDir)) {
        const inCI = fs.readdirSync(ciDir)
            .some((f) => fs.readFileSync(path.join(ciDir, f), 'utf8').includes('preflight'));
        if (!inCI) soft('no CI workflow references preflight — it only guards local runs');
        else ok('referenced by CI');
    }
});

gate('workflow-valid', 'CI workflow files are ones GitHub will actually accept', () => {
    // A workflow GitHub REJECTS fails in 0 seconds with zero jobs and NO LOG, because it is
    // refused before a job is created or the triggers are even evaluated. Nothing readable tells
    // you. Measured in one product repo 2026-08-20: ios-simshots.yml carried two top-level
    // `concurrency:` blocks for three days — a second added with its rationale, the first not
    // removed — and every push produced a 0s red that also marked every open PR UNSTABLE. Sixty
    // gates in that repo, and none of them looked at the files that RUN the gates.
    //
    // A LINE SCAN, NOT A PARSE, deliberately. YAML parsers ACCEPT duplicate keys and keep the
    // last, so they call a rejected file valid — a yaml.safe_load check printed "YAML OK" on that
    // exact dead file. Node has no YAML in its builtins either, and this template must stay
    // dependency-free. Top-level keys are the only thing at column 0 in these files (a block
    // scalar must indent past its key), so the scan is exact for the class it covers.
    //
    // Scope is that class and should stay there: this is not a workflow linter.
    const dir = path.join(ROOT, '.github', 'workflows');
    if (!fs.existsSync(dir)) return soft('no .github/workflows — nothing to validate');
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    if (!files.length) return soft('.github/workflows holds no .yml files');
    let keys = 0;
    let dups = 0;
    files.forEach((f) => {
        const at = new Map();
        fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):/);
            if (!m) return;
            keys++;
            if (at.has(m[1])) {
                dups++;
                fail(`${f} declares top-level "${m[1]}" twice, at lines ${at.get(m[1])} and ${i + 1}. `
                    + 'GitHub REJECTS the file — the run fails in 0s with no jobs and no log, so nothing '
                    + 'tells you. Delete one; keep whichever carries the reasoning.');
            } else at.set(m[1], i + 1);
        });
        if (!at.has('jobs')) fail(`${f} has no top-level "jobs" — GitHub rejects it the same silent way`);
        // `on:` is YAML 1.1's boolean true, which is why a parser-based check would look for both.
        // This scan reads raw text, so `on` is the literal; `true` covers a quoted variant.
        if (!at.has('on') && !at.has('true')) fail(`${f} has no trigger ("on") — same silent rejection`);
    });
    // The population, so a scan that matched nothing is not mistakable for a clean repo — and it
    // must AGREE with the findings above it. The first draft printed "no duplicates" unconditionally,
    // so a run that had just named a duplicate contradicted itself one line later. A summary that
    // can disagree with its own findings is worse than no summary.
    ok(`${files.length} workflow file(s), ${keys} top-level key(s), `
        + (dups ? `${dups} DUPLICATE(S) — see above` : 'no duplicates'));
});

// EXAMPLE — delete once you have real gates.
//
// gate('parity', 'every surface that shows day total imports the one function', () => {
//     const offenders = [];
//     for (const f of sourceFiles()) {
//         const src = fs.readFileSync(f, 'utf8');
//         if (/dayTotal\s*=/.test(src) && !/from ['"].*\/totals['"]/.test(src)) offenders.push(rel(f));
//     }
//     if (offenders.length) {
//         trackedFail('parity', 'these compute dayTotal locally instead of importing it — '
//             + 'four local calculations WILL drift: ' + offenders.join(', '));
//     } else ok('one source of truth for dayTotal');
// });

// ---------------------------------------------------------------------------
// Law 3, second half: a tracked failure that now passes is itself a failure.
// ---------------------------------------------------------------------------
const healed = Object.keys(KNOWN_RED).filter((id) => !redSeen.has(id));
if (healed.length) {
    console.error('\nSTALE KNOWN_RED — these pass now. Remove them from the list:');
    healed.forEach((id) => console.error('  ! ' + id + ' — ' + KNOWN_RED[id]));
    hard += healed.length;
}

console.log(`\npreflight: ${hard ? `FAIL (${hard} hard)` : 'PASS'}${warn ? ` · ${warn} warning${warn === 1 ? '' : 's'}` : ''}`);
process.exit(hard ? 1 : 0);
