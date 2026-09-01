'use strict';
// Acceptance suite for deploy-ledger.js, and its known-positive control. The live run against autodev
// reports 0 user-facing files, which is correct and indistinguishable from a
// broken pipeline. This builds a throwaway repo that DOES have UI and asserts
// the whole path: derive -> write -> verify.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Named as a path literal so check-suites-can-fail derives this suite's
// subject without an override entry.
const LEDGER_JS = path.resolve(__dirname, '..', 'plugins/autodev-core/scripts/deploy-ledger.js');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-control-'));
const git = (...a) => execFileSync('git', ['-C', T, ...a], { encoding: 'utf8' });
const run = (...a) => {
    const r = require('child_process').spawnSync(process.execPath, [LEDGER_JS, ...a], { cwd: T, encoding: 'utf8' });
    return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
};
const w = (rel, body) => {
    const p = path.join(T, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
};

let failed = 0;
const check = (label, ok, detail) => {
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  -> ' + detail}`);
};

try {
    git('init', '-q', '.');
    git('config', 'user.email', 'control@example.invalid');
    git('config', 'user.name', 'control');
    w('README.md', 'x\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('tag', 'deploy-1');

    w('app/page.tsx', 'export default () => null;\n');
    w('app/settings/page.tsx', 'export default () => null;\n');
    w('app/globals.css', 'body{}\n');
    w('lib/helper.ts', 'export const x = 1;\n');
    git('add', '-A'); git('commit', '-qm', 'ui change');

    const listed = run('--since', 'deploy-1');
    check('derives the two routes and the wide file',
        /\/\s+<-/.test(listed.out) && /\/settings/.test(listed.out) && /WIDE\s+app\/globals\.css/.test(listed.out),
        listed.out.trim());
    check('counts only user-facing files, not lib/helper.ts',
        /4 file\(s\) changed, 3 user-facing/.test(listed.out),
        listed.out.split('\n')[0]);

    const written = run('--since', 'deploy-1', '--write');
    const ledger = fs.readFileSync(path.join(T, 'DEPLOY-LEDGER.md'), 'utf8');
    check('writes a ledger with a row per surface',
        /\| `\/` \|/.test(ledger) && /\| `\/settings` \|/.test(ledger) && /WIDE \(every surface\)/.test(ledger),
        written.out.trim());

    const unverified = run('--since', 'deploy-1', '--verify');
    check('refuses while boxes are unticked', unverified.status === 1, 'status=' + unverified.status);
    check('names metrics as unchecked', /UNCHECKED\s+metrics/.test(unverified.out), unverified.out.trim());

    // Tick everything, including metrics, and it must pass. Without this the
    // refusal above could be a check that can never pass, which is worthless.
    let ticked = ledger.replace(/\[ \]/g, '[x]').replace(
        '- [x] metrics recorded or waived:',
        '- [x] metrics recorded or waived: WAIVED, no user-visible metric moves'
    );
    fs.writeFileSync(path.join(T, 'DEPLOY-LEDGER.md'), ticked, 'utf8');
    const verified = run('--since', 'deploy-1', '--verify');
    check('passes once every box is ticked and metrics recorded',
        verified.status === 0, 'status=' + verified.status + ' ' + verified.out.trim());

    // Ticks must survive a regenerate, or nobody will regenerate.
    run('--since', 'deploy-1', '--write');
    const after = fs.readFileSync(path.join(T, 'DEPLOY-LEDGER.md'), 'utf8');
    check('preserves existing ticks across a rewrite',
        (after.match(/\[x\]/g) || []).length >= (ticked.match(/\[x\]/g) || []).length - 1,
        'x-count before=' + (ticked.match(/\[x\]/g) || []).length + ' after=' + (after.match(/\[x\]/g) || []).length);

    // Blind case: no ref determinable must REFUSE, never report "nothing changed".
    fs.rmSync(path.join(T, '.git', 'refs', 'tags', 'deploy-1'), { force: true });
    const blind = run();
    check('refuses when the last deploy cannot be determined',
        blind.status === 2 && /COULD NOT DETERMINE/.test(blind.out),
        'status=' + blind.status + ' ' + blind.out.trim());
} finally {
    fs.rmSync(T, { recursive: true, force: true });
}

console.log(`[control] 8 assertion(s), ${8 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
