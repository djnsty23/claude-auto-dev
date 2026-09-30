#!/usr/bin/env node
'use strict';
/**
 * T2's endpoint: every script named answers --help with a usage line and exit
 * 0 in under the budget, without doing its real work.
 *   node tooling/frontier/checks/help-fast.js <script.js>... [--budget-ms 1000]
 * Exit 0 all fast, 1 any slow, failing or silent, 2 usage.
 */
const { spawnSync } = require('child_process');

function probe(script, budgetMs) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: budgetMs * 10, windowsHide: true });
    const ms = Date.now() - t0;
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    const usage = /usage/i.test(text);
    const ok = r.status === 0 && ms < budgetMs && usage;
    return { script, exit: r.status, ms, usage, ok };
}

function main(argv) {
    if (argv.includes('--help')) {
        process.stdout.write('Usage: node help-fast.js <script.js>... [--budget-ms 1000]\nExit 0 when every script answers --help with a usage line, exit 0, in under the budget.\n');
        return 0;
    }
    const i = argv.indexOf('--budget-ms');
    const budgetMs = i >= 0 ? Number(argv[i + 1]) : 1000;
    const scripts = argv.filter((a, j) => !a.startsWith('--') && !(i >= 0 && j === i + 1));
    if (!scripts.length || !(budgetMs > 0)) { process.stderr.write('help-fast: name at least one script and a positive --budget-ms\n'); return 2; }
    const results = scripts.map((s) => probe(s, budgetMs));
    for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.script} exit ${r.exit} in ${r.ms} ms, usage line ${r.usage ? 'yes' : 'no'}\n`);
    process.stdout.write(`help-fast: ${results.filter((r) => r.ok).length} of ${results.length} fast\n`);
    return results.every((r) => r.ok) ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
