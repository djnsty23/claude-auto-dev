#!/usr/bin/env node
'use strict';
// Pre-publish genericness probe. Runs the pinned `impeccable detect` (a
// deterministic, no-LLM anti-pattern scanner) and turns its JSON into a report
// and, optionally, a design-review measurement artifact for `generic-tells`.
//
// Exit 0: scan ran over at least one file (or a URL) and found nothing primary.
// Exit 1: scan ran and reported primary findings.
// Exit 2: indeterminate. npx missing, impeccable failed, output unparseable or
//         contradictory, or a local target held no scannable file. Never a pass.
//
// Measured on impeccable 4.5.2: exit 0 clean, 1 target unscannable, 2 findings.
// An empty directory exits 0 with [], so the file population is counted here,
// independently of the tool, before a clean result is believed.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const IMPECCABLE_VERSION = '4.5.2';
const SCANNABLE = /\.(html?|css|jsx|tsx|vue|svelte)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.vercel', '.turbo', 'coverage']);
const CRITERION = 'generic-tells';
const CHECK_NAME = 'impeccable slop findings';

function countScannable(target) {
    let stat;
    try { stat = fs.statSync(target); } catch { return { exists: false, files: 0 }; }
    if (stat.isFile()) return { exists: true, files: SCANNABLE.test(target) ? 1 : 0 };
    let files = 0;
    const stack = [target];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name)); }
            else if (e.isFile() && SCANNABLE.test(e.name)) files++;
        }
    }
    return { exists: true, files };
}

function invocation(target) {
    return ['-y', `impeccable@${IMPECCABLE_VERSION}`, 'detect', '--json', target];
}

function runNpx(args) {
    // npx is a .cmd shim on Windows, which Node only spawns through a shell.
    if (process.platform !== 'win32') return spawnSync('npx', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
    if (args.some(a => a.includes('"'))) return { error: new Error('target contains a double quote') };
    const line = ['npx', ...args.map(a => `"${a}"`)].join(' ');
    return spawnSync(line, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000, windowsHide: true });
}

function interpret(run) {
    const indeterminate = reason => ({ status: 'indeterminate', reason, exitCode: run.status ?? null, stderr: String(run.stderr || '').slice(-2000) });
    if (run.error) return indeterminate(`could not run npx: ${run.error.message}`);
    if (run.status !== 0 && run.status !== 2) return indeterminate(`impeccable exited ${run.status}: target unscannable, npx missing or engine failed`);
    let findings;
    try { findings = JSON.parse(String(run.stdout || '').trim()); } catch { return indeterminate('impeccable stdout is not JSON'); }
    if (!Array.isArray(findings)) return indeterminate('impeccable JSON is not a findings array');
    if (!findings.every(f => f && typeof f.antipattern === 'string' && f.antipattern.length > 0)) return indeterminate('a finding has no antipattern id: output shape changed');
    if (run.status === 2 && findings.length === 0) return indeterminate('impeccable exited 2 with no findings: contradictory output');
    // Exit 0 can still list advisories; they never count as failures.
    const primary = run.status === 2 ? findings : [];
    const byRule = {};
    for (const f of primary) byRule[f.antipattern] = (byRule[f.antipattern] || 0) + 1;
    return {
        status: primary.length ? 'findings' : 'clean', exitCode: run.status,
        primary: primary.length, slop: primary.filter(f => f.category === 'slop').length,
        advisories: run.status === 0 ? findings.length : 0, byRule,
        findings: primary.map(f => ({ rule: f.antipattern, category: f.category ?? null, severity: f.severity ?? null, line: f.line ?? null, snippet: f.snippet ?? null })),
    };
}

function probe(target) {
    const isUrl = /^https?:\/\//i.test(target);
    const population = isUrl ? { url: true } : countScannable(target);
    const base = { tool: 'impeccable', version: IMPECCABLE_VERSION, target, command: ['npx', ...invocation(target)].join(' '), population };
    if (!isUrl && !population.exists) return { ...base, status: 'indeterminate', reason: 'target does not exist' };
    if (!isUrl && population.files === 0) return { ...base, status: 'indeterminate', reason: 'read 0 scannable files, so nothing was checked' };
    return { ...base, ...interpret(runNpx(invocation(target))) };
}

function artifact(report, caseId, revision) {
    return { criterion: CRITERION, caseId, revision, collector: report.command, target: report.target,
        checks: [{ name: CHECK_NAME, operator: 'lte', expected: 0, observed: report.slop }],
        primary: report.primary, byRule: report.byRule, findings: report.findings };
}

function main(argv) {
    if (!argv.length || argv.includes('--help')) {
        console.log(`impeccable-probe <file|dir|url> [--case <id> --revision <id> --out <artifact.json>]\nRuns npx impeccable@${IMPECCABLE_VERSION} detect --json. Exit 0 clean, 1 findings, 2 indeterminate.\nWith --out, a scan that ran writes a design-review measurement artifact for "${CRITERION}"; an indeterminate scan writes nothing, so the ledger row stays unknown.`);
        return 0;
    }
    const opts = {};
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (['--case', '--revision', '--out'].includes(argv[i])) { if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`); opts[argv[i].slice(2)] = argv[++i]; }
        else rest.push(argv[i]);
    }
    if (rest.length !== 1) throw new Error('give exactly one target');
    if (opts.out && !(opts.case && opts.revision)) throw new Error('--out needs --case and --revision');
    const report = probe(rest[0]);
    if (opts.out && report.status !== 'indeterminate') fs.writeFileSync(opts.out, JSON.stringify(artifact(report, opts.case, opts.revision), null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    return report.status === 'clean' ? 0 : report.status === 'findings' ? 1 : 2;
}

module.exports = { IMPECCABLE_VERSION, CRITERION, CHECK_NAME, interpret, countScannable, invocation };
if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('impeccable-probe: ' + e.message); process.exitCode = 2; } }
