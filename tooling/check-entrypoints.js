#!/usr/bin/env node
/**
 * check-entrypoints.js - every shipped script must RETURN when asked for help.
 *
 * WHY. `[measured 2026-09-02]` three scripts in this plugin entered their watch
 * loop on `--help` and never returned: watch-panels.js, fleet-stop-watch.js,
 * quota-tripwire.js. An auditor following the repo's own convention (probe
 * `--help` first) blocked on each one, and a coordinator that wraps nothing in
 * a timeout hangs its turn. F8 of the 2026-08-30 codex audit fixed the same
 * class in fleet-board.js and gated that one file. This gates the population.
 *
 * WHAT IT PROVES. For every script in the population, `node <script> --help`
 * with stdin closed exits within the budget. The exit CODE is reported and not
 * judged: a script that prints usage and exits 2 has answered. Only a script
 * that is still running when the budget ends is a finding.
 *
 * WHAT IT REFUSES TO RISK. Some scripts here mutate the tree when run without
 * a flag they recognise (check-suites-can-fail.js rewrites sources; the vacuity
 * sweep plants mutants). A script that ignores --help and does its default
 * action, killed at the budget, would leave the working tree mutated. So every
 * probe runs against a SCRATCH COPY of the repo under a scratch HOME, never the
 * source tree, and the selftest proves that isolation with a script that writes
 * a marker beside itself: the marker must land in the copy and nowhere else.
 *
 * POPULATION. plugins/<name>/scripts/*.js, plugins/<name>/hooks/*.js, and
 * tooling/*.js excluding tooling/test-*.js (suites run on invocation and do not
 * take --help). Printed on every run, so a quiet result is distinguishable from
 * an empty scan.
 *
 *   node tooling/check-entrypoints.js                # probe the repo, exit 1 on any hang
 *   node tooling/check-entrypoints.js --budget-ms 5000
 *   node tooling/check-entrypoints.js --root <dir>   # probe another tree of the same shape
 *   node tooling/check-entrypoints.js --json
 *   node tooling/check-entrypoints.js --selftest
 *
 * Exit: 0 clean, 1 at least one script hung, 2 could not run (no population).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const BUDGET_MS = Math.max(500, Number(val('--budget-ms', 10000)) || 10000);

/** Relative paths of every entry point in `root`, sorted. */
function population(root) {
    const out = [];
    const pluginsDir = path.join(root, 'plugins');
    if (fs.existsSync(pluginsDir)) {
        for (const plugin of fs.readdirSync(pluginsDir)) {
            for (const sub of ['scripts', 'hooks']) {
                const dir = path.join(pluginsDir, plugin, sub);
                if (!fs.existsSync(dir)) continue;
                for (const f of fs.readdirSync(dir)) {
                    if (f.endsWith('.js')) out.push(path.join('plugins', plugin, sub, f));
                }
            }
        }
    }
    const tooling = path.join(root, 'tooling');
    if (fs.existsSync(tooling)) {
        for (const f of fs.readdirSync(tooling)) {
            if (f.endsWith('.js') && !/^test-/.test(f)) out.push(path.join('tooling', f));
        }
    }
    return out.sort();
}

/**
 * Copy `root` to a scratch directory. .git, .claude and node_modules are left
 * out: the first two are state the probes must not touch, the third is absent
 * in this repo and would only add time elsewhere.
 */
function scratchCopy(root) {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'check-entrypoints-'));
    const copyRoot = path.join(dest, 'repo');
    fs.cpSync(root, copyRoot, {
        recursive: true,
        filter: (src) => {
            const base = path.basename(src);
            return !(base === '.git' || base === '.claude' || base === 'node_modules');
        },
    });
    return { dest, copyRoot };
}

/** Probe one script. Returns { rel, status: RETURNED|HUNG, code, signal, ms, tail }. */
function probe(copyRoot, rel, env, budgetMs) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.join(copyRoot, rel), '--help'], {
        cwd: copyRoot,
        env,
        input: '',            // stdin closed: a hook that waits for JSON must not wait forever
        encoding: 'utf8',
        timeout: budgetMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    const hung = r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM');
    const text = ((r.stdout || '') + (r.stderr || '')).trim();
    return {
        rel,
        status: hung ? 'HUNG' : 'RETURNED',
        code: r.status,
        signal: r.signal,
        ms,
        tail: text.split('\n').slice(-2).join(' | ').slice(0, 160),
    };
}

function run(root, opts = {}) {
    const budgetMs = opts.budgetMs || BUDGET_MS;
    const pop = population(root);
    if (pop.length === 0) return { ok: false, reason: 'no population', results: [], root };
    const { dest, copyRoot } = scratchCopy(root);
    const home = path.join(dest, 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        AUTODEV_FLEET_DIR: path.join(home, 'fleet'),
        AUTODEV_FLEET_PUBLISH_DIR: path.join(home, 'published'),
        CLAUDE_PLUGIN_ROOT: path.join(copyRoot, 'plugins', 'autodev-core'),
        AUTODEV_PANEL_CHECK: 'off',
    };
    const results = [];
    try {
        for (const rel of pop) results.push(probe(copyRoot, rel, env, budgetMs));
    } finally {
        if (!opts.keepScratch) fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    return { ok: true, results, root, copyRoot: opts.keepScratch ? copyRoot : null, dest: opts.keepScratch ? dest : null, budgetMs };
}

function report(out, json) {
    if (!out.ok) {
        console.log(`[entrypoints] COULD NOT RUN: ${out.reason} under ${out.root}`);
        return 2;
    }
    const hung = out.results.filter((r) => r.status === 'HUNG');
    const returned = out.results.length - hung.length;
    if (json) {
        console.log(JSON.stringify({ population: out.results.length, returned, hung: hung.map((h) => h.rel), budgetMs: out.budgetMs }, null, 2));
        return hung.length ? 1 : 0;
    }
    console.log(`[entrypoints] ${out.results.length} script(s) probed with --help under a ${out.budgetMs}ms budget, ${returned} returned, ${hung.length} hung`);
    for (const h of hung) console.log(`  HUNG      ${h.rel}  (${h.ms}ms, killed)${h.tail ? '  last: ' + h.tail : ''}`);
    const nonzero = out.results.filter((r) => r.status === 'RETURNED' && r.code !== 0);
    if (nonzero.length) {
        console.log(`  note: ${nonzero.length} returned non-zero on --help; reported, not judged:`);
        for (const n of nonzero) console.log(`    exit ${n.code}  ${n.rel}`);
    }
    return hung.length ? 1 : 0;
}

// ---------------------------------------------------------------- selftest --

function selftest() {
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok, detail });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-entrypoints-selftest-'));
    try {
        const root = path.join(tmp, 'root');
        const scripts = path.join(root, 'plugins', 'demo', 'scripts');
        const hooks = path.join(root, 'plugins', 'demo', 'hooks');
        const tooling = path.join(root, 'tooling');
        for (const d of [scripts, hooks, tooling]) fs.mkdirSync(d, { recursive: true });

        // Planted hang: the exact shape of the three real defects, an armed timer.
        fs.writeFileSync(path.join(scripts, 'hang.js'), "setInterval(() => {}, 1000);\n");
        // Control: returns at once.
        fs.writeFileSync(path.join(scripts, 'ok.js'), "console.log('usage: ok'); process.exit(0);\n");
        // A hook that reads stdin to EOF must return when stdin is closed.
        fs.writeFileSync(path.join(hooks, 'stdin-hook.js'),
            "let s=''; process.stdin.on('data', d => s += d).on('end', () => process.exit(0));\n");
        // Non-zero on --help is an answer, not a hang.
        fs.writeFileSync(path.join(tooling, 'usage-exit2.js'), "console.error('usage'); process.exit(2);\n");
        // A suite must be excluded from the population.
        fs.writeFileSync(path.join(tooling, 'test-excluded.js'), "setInterval(() => {}, 1000);\n");
        // The isolation control: writes a marker beside ITSELF. Must land in the copy.
        fs.writeFileSync(path.join(scripts, 'marker.js'),
            "require('fs').writeFileSync(require('path').join(__dirname, 'MARKER.txt'), 'x'); process.exit(0);\n");

        const pop = population(root);
        check('population excludes tooling/test-*.js', !pop.some((p) => /test-excluded/.test(p)) && pop.length === 5, pop.join(','));

        const out = run(root, { budgetMs: 1500, keepScratch: true });
        const by = Object.fromEntries(out.results.map((r) => [path.basename(r.rel), r]));
        check('planted setInterval is classified HUNG', by['hang.js'] && by['hang.js'].status === 'HUNG', JSON.stringify(by['hang.js']));
        check('control script is classified RETURNED', by['ok.js'] && by['ok.js'].status === 'RETURNED' && by['ok.js'].code === 0, JSON.stringify(by['ok.js']));
        check('stdin-reading hook returns with stdin closed', by['stdin-hook.js'] && by['stdin-hook.js'].status === 'RETURNED', JSON.stringify(by['stdin-hook.js']));
        check('exit 2 on --help is RETURNED, not HUNG', by['usage-exit2.js'] && by['usage-exit2.js'].status === 'RETURNED' && by['usage-exit2.js'].code === 2, JSON.stringify(by['usage-exit2.js']));
        const markerInCopy = fs.existsSync(path.join(out.copyRoot, 'plugins', 'demo', 'scripts', 'MARKER.txt'));
        const markerInSource = fs.existsSync(path.join(scripts, 'MARKER.txt'));
        check('a probe that writes beside itself writes into the scratch copy', markerInCopy, out.copyRoot);
        check('and never into the source tree', !markerInSource, scripts);
        fs.rmSync(out.dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

        // Verdict: one hang makes the run exit 1; removing it makes it exit 0.
        const quiet = { write: () => {} };
        const origLog = console.log; console.log = () => {};
        let code1, code0;
        try {
            code1 = report(out, false);
            fs.rmSync(path.join(scripts, 'hang.js'));
            code0 = report(run(root, { budgetMs: 1500 }), false);
        } finally { console.log = origLog; void quiet; }
        check('verdict is exit 1 with a hang in the population', code1 === 1, String(code1));
        check('verdict is exit 0 once the hang is removed', code0 === 0, String(code0));
        console.log = () => {};
        let code2;
        try { code2 = report({ ok: false, reason: 'no population', root: tmp }, false); } finally { console.log = origLog; }
        check('empty population is exit 2, never a pass', code2 === 2, String(code2));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    const failed = results.filter((r) => !r.ok);
    for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '\n        ' + r.detail));
    console.log(`population: ${results.length} assertions run, ${results.length - failed.length} passed, ${failed.length} failed`);
    process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
    if (has('--help') || has('-h')) {
        console.log('usage: node tooling/check-entrypoints.js [--budget-ms N] [--root DIR] [--json] [--selftest]');
        process.exit(0);
    }
    if (has('--selftest')) selftest();
    else process.exit(report(run(path.resolve(val('--root', DEFAULT_ROOT))), has('--json')));
}

module.exports = { population, run, probe, report };
