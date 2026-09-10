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
let assertions = 0;
const check = (label, ok, detail) => {
    assertions++;
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

// The controls below drive the real CLI in independent repositories. Expected
// routes, populations and verdicts come from the fixture, not the renderer.
function fixture(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger regression with spaces-'));
    const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
    };
    const commit = (files, message) => {
        g('add', '--', ...files);
        write('commit-message.txt', message + '\n');
        g('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-F', path.join(dir, 'commit-message.txt'));
        return g('rev-parse', 'HEAD');
    };
    const cli = (...args) => {
        const p = require('child_process').spawnSync(process.execPath, [LEDGER_JS, ...args], { cwd: dir, encoding: 'utf8' });
        return { status: p.status, out: (p.stdout || '') + (p.stderr || '') };
    };
    const read = () => fs.readFileSync(path.join(dir, 'DEPLOY-LEDGER.md'), 'utf8');
    const save = (text) => write('DEPLOY-LEDGER.md', text);
    const tick = () => save(read().replace(/\[ \]/g, '[x]').replace(
        '- [x] metrics recorded or waived:', '- [x] metrics recorded or waived: WAIVED fixture layout-only change'));
    try {
        g('init', '-q'); g('config', 'user.name', 'Fixture'); g('config', 'user.email', 'fixture@example.invalid');
        write('README.md', 'base\n');
        const base = commit(['README.md'], 'base');
        body({ g, write, commit, cli, read, save, tick, base });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

fixture(({ write, commit, cli, read, tick, base }) => {
    for (const file of ['tailwind.config.js', 'src/theme.ts', 'src/tokens.json', 'app/globals.css', 'lib/helper.ts', 'docs/theme.md']) write(file, 'changed\n');
    commit(['tailwind.config.js', 'src/theme.ts', 'src/tokens.json', 'app/globals.css', 'lib/helper.ts', 'docs/theme.md'], 'wide runtime fixtures');
    const listed = cli('--since', base);
    check('WIDE discovery includes runtime config/data before filtering by UI extension',
        listed.status === 0 && /6 file\(s\) changed, 4 user-facing, 1 route\(s\) derived, 4 wide-effect/.test(listed.out), listed.out);
    check('WIDE positive control is CSS; ordinary helper and Markdown remain excluded',
        /WIDE\s+app\/globals\.css/.test(listed.out) && !/WIDE\s+(lib\/helper\.ts|docs\/theme\.md)/.test(listed.out), listed.out);
    cli('--since', base, '--write');
    check('WIDE-only change cannot be rendered as no user-facing changes',
        read().includes('`tailwind.config.js`') && read().includes('WIDE (every surface)') && !read().includes('| _none_ |'), read());
    tick();
    check('properly checked WIDE-only ledger can pass', cli('--since', base, '--verify').status === 0, 'WIDE control refused');
});

fixture(({ write, commit, cli, read, save, tick, base }) => {
    write('app/page.tsx', 'home\n'); write('app/settings/page.tsx', 'settings\n');
    commit(['app/page.tsx', 'app/settings/page.tsx'], 'two routes');
    cli('--since', base, '--write'); tick(); const valid = read();
    check('complete two-route ledger passes positive control', cli('--since', base, '--verify').status === 0, 'valid ledger refused');
    save(valid.replace(/\n/g, '\r\n'));
    check('valid checks survive ordinary CRLF Markdown editing', cli('--since', base, '--verify').status === 0, 'CRLF ledger refused');
    save(valid);
    const home = valid.split('\n').find((line) => line.startsWith('| `/` |'));
    save(valid.split('\n').filter((line) => !line.startsWith('| `/` |')).join('\n'));
    let v = cli('--since', base, '--verify');
    check('deleting one expected route fails and names the missing route', v.status === 1 && /MISSING[^\n]*`\/`/.test(v.out), v.out);
    save(valid.split('\n').filter((line) => !/^\| `/.test(line)).join('\n'));
    v = cli('--since', base, '--verify');
    check('deleting every expected route cannot become empty success', v.status === 1, v.out);
    save(valid.replace(home, home.replace('| [x] |', '| n/a |')));
    v = cli('--since', base, '--verify');
    check('partial cells cannot satisfy a route despite no literal unchecked box', v.status === 1 && /INVALID[^\n]*`\/`/.test(v.out), v.out);
    save(valid.replace(home, home + '\n' + home));
    v = cli('--since', base, '--verify');
    check('duplicate checked route rows are rejected', v.status === 1 && /DUPLICATE[^\n]*`\/`/.test(v.out), v.out);
    save(valid.replace(home, home.replace('`app/page.tsx`', '`app/wrong.tsx`')));
    v = cli('--since', base, '--verify');
    check('checked row with wrong changed-file details cannot substitute for expected row', v.status === 1, v.out);
    save(valid); cli('--since', base, '--write');
    v = cli('--since', base, '--verify');
    check('same-window regeneration preserves valid route evidence and metrics', v.status === 0, v.out);
});

fixture(({ g, write, commit, cli, read, save, tick, base }) => {
    write('README.md', 'intermediate baseline\n'); const alternateBase = commit(['README.md'], 'other baseline');
    write('app/page.tsx', 'first candidate\n'); commit(['app/page.tsx'], 'candidate');
    cli('--since', base, '--write'); tick(); const original = read();
    let v = cli('--since', alternateBase, '--verify');
    check('verification refuses a ledger generated for another base even with the same route set', v.status === 1 && /STALE/.test(v.out), v.out);
    cli('--since', alternateBase, '--write');
    check('base change resets route checks and metrics', !read().includes('[x]'), read());
    tick(); g('tag', 'same-base-alias', alternateBase); cli('--since', 'same-base-alias', '--write');
    v = cli('--since', alternateBase, '--verify');
    check('equivalent base refs preserve same-window evidence by resolved SHA', v.status === 0, v.out);
    save(original); write('app/page.tsx', 'second candidate\n'); commit(['app/page.tsx'], 'new HEAD same route');
    v = cli('--since', base, '--verify');
    check('same-base new-HEAD verification rejects stale ticks before regeneration', v.status === 1 && /STALE/.test(v.out), v.out);
    cli('--since', base, '--write');
    check('same-base new-HEAD regeneration resets route checks and metrics', !read().includes('[x]'), read());
    tick(); v = cli('--since', base, '--verify');
    check('new candidate passes only after recording fresh checks', v.status === 0, v.out);
    save(read().split('\n').filter((line) => !line.startsWith('<!-- deploy-ledger-window:')).join('\n'));
    v = cli('--since', base, '--verify');
    check('legacy or removed provenance is unresolved, not a verified current window', v.status === 1 && /STALE/.test(v.out), v.out);
    cli('--since', base, '--write');
    check('legacy ledger regeneration resets unsupported inherited claims', !read().includes('[x]'), read());
});

// NTFS cannot hold '|', '\n' or '\t' in a filename, so on win32 the odd-named
// docs file gets a backtick instead (legal there, still needs Markdown care)
// and the unrepresentable-path cases below shrink to the one it can create.
// Both are printed, never silent. [measured 2026-09-09] Windows CI: ENOENT on
// 'docs/with|pipe.md' took the whole suite down.
const WIN32 = process.platform === 'win32';
const ODD_DOC = WIN32 ? 'docs/with`tick.md' : 'docs/with|pipe.md';
if (WIN32) console.log('  win32: odd-named docs fixture is ' + JSON.stringify(ODD_DOC) + ' (NTFS refuses |)');
fixture(({ write, commit, cli, tick, base }) => {
    write('docs/guide.md', 'documentation only\n'); write(ODD_DOC, 'not a surface\n');
    commit(['docs/guide.md', ODD_DOC], 'docs');
    cli('--since', base, '--write'); tick();
    const v = cli('--since', base, '--verify');
    check('genuine zero-surface docs-only population can still pass with recorded metrics', v.status === 0 && /2 file\(s\) changed, 0 user-facing/.test(v.out), v.out);
});

fixture(({ write, commit, cli, read, tick, base }) => {
    write(' app/page.tsx', 'leading space is part of the filename\n'); commit([' app/page.tsx'], 'space identity');
    cli('--since', base, '--write');
    check('leading-space path retains its exact identity instead of becoming an app route',
        read().includes('| ` app/page.tsx` |') && !read().includes('| `/` |'), read());
    tick(); const v = cli('--since', base, '--verify');
    check('leading-space surface can pass after its actual row is checked', v.status === 0, v.out);
});

const UNREPRESENTABLE = ['app/with|pipe/page.tsx', 'app/with`tick/page.tsx', 'app/with\nnewline/page.tsx', '\tapp/page.tsx'];
const RUNNABLE = WIN32 ? UNREPRESENTABLE.filter((f) => !/[|\n\t]/.test(f)) : UNREPRESENTABLE;
if (RUNNABLE.length !== UNREPRESENTABLE.length) console.log(`  win32: ${UNREPRESENTABLE.length - RUNNABLE.length} of ${UNREPRESENTABLE.length} unrepresentable-path cases not run: NTFS cannot hold | \\n or \\t in a filename`);
for (const file of RUNNABLE) {
    fixture(({ write, commit, cli, base }) => {
        write(file, 'ambiguous markdown path\n'); commit([file], 'unrepresentable surface');
        const v = cli('--since', base, '--write');
        check('unsupported Markdown/control path is reported instead of producing an ambiguous ledger: ' + JSON.stringify(file),
            v.status === 2 && /unsupported.*path/i.test(v.out), v.out);
    });
}

fixture(({ g, write, commit, cli, read, tick, base }) => {
    write('app/page.tsx', 'frozen deployed candidate\n');
    const candidate = commit(['app/page.tsx'], 'candidate');
    cli('--since', base, '--candidate', candidate, '--write'); tick();
    let v = cli('--since', base, '--candidate', candidate, '--verify');
    check('explicit candidate accepts fresh valid evidence', v.status === 0, v.out);
    const evidenceCommit = commit(['DEPLOY-LEDGER.md'], 'archive checked candidate evidence');
    check('ledger is actually tracked in a later evidence commit', evidenceCommit !== candidate && g('ls-files', '--', 'DEPLOY-LEDGER.md') === 'DEPLOY-LEDGER.md', evidenceCommit);
    v = cli('--since', base, '--verify');
    check('default HEAD verification still rejects evidence from the earlier candidate after archival', v.status === 1 && /STALE/.test(v.out), v.out);
    v = cli('--since', base, '--candidate', candidate, '--verify');
    check('tracked archival commit does not invalidate explicit frozen-candidate verification', v.status === 0, v.out);
    check('explicit historical verdict prints candidate and current checkout separately',
        v.out.includes('candidate ' + candidate) && v.out.includes('checkout HEAD ' + evidenceCommit) && /only.*candidate/i.test(v.out), v.out);
    cli('--since', base, '--candidate', candidate, '--write');
    check('regenerating archived frozen-candidate evidence is byte-stable', g('diff', '--numstat', '--', 'DEPLOY-LEDGER.md') === '', read());
    write('app/page.tsx', 'different unverified source\n'); const newer = commit(['app/page.tsx'], 'new source');
    v = cli('--since', base, '--candidate', candidate, '--verify');
    check('old candidate remains verifiable as explicitly historical after later source edits', v.status === 0 && v.out.includes('checkout HEAD ' + newer), v.out);
    v = cli('--since', base, '--candidate', newer, '--verify');
    check('requesting the newer candidate does not inherit old candidate checks', v.status === 1 && /STALE/.test(v.out), v.out);
    v = cli('--since', base, '--verify');
    check('default HEAD cannot turn historical candidate success into current-source success', v.status === 1, v.out);
    for (const args of [['--candidate'], ['--candidate', '--verify'], ['--candidate', 'not-a-real-ref'], ['--candidate', candidate, '--candidate', newer]]) {
        v = cli('--since', base, ...args);
        check('malformed candidate option refuses: ' + JSON.stringify(args), v.status === 2 && /candidate/i.test(v.out), v.out);
    }
});

console.log(`[control] ${assertions} assertion(s), ${assertions - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
