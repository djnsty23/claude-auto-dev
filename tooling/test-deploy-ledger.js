'use strict';
// Acceptance suite for deploy-ledger.js, and its known-positive control. The
// live run against autodev reports 0 user-facing files, which is correct and
// indistinguishable from a broken pipeline. This builds a throwaway repo that
// DOES have UI and walks the whole path a promotion takes:
//
//   derive -> write -> verify (unmarked project, 2) -> mark -> verify (stale, 1)
//   -> write -> verify (incomplete, 1) -> fill -> verify (complete, 0, ZERO BYTES)
//   -> ineligible by path (3) -> eligible DROP POLICY control (1)
//   -> ineligible by each SQL clause (3) -> default-branch containment (1)
//
// Every verify in that walk-through passes --promotion. Plain --verify, the
// surface record the ship skill's Step 5b runs, is driven by the fixtures below.
//
// Every refusal is asserted by its exit code AND the line that names the reason,
// because 1, 2 and 3 are three different instructions to the reader and a suite
// that only read "non-zero" could not tell an unmarked project from a red gate.
//
// Everything runs the real script as a subprocess in the fixture's cwd. Nothing
// here imports it, so the exit codes under test are the ones a shell chain sees.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Named as a path literal so check-suites-can-fail derives this suite's
// subject without an override entry.
const LEDGER_JS = path.resolve(__dirname, '..', 'plugins/autodev-core/scripts/deploy-ledger.js');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-control-'));
const git = (...a) => execFileSync('git', ['-C', T, ...a], { encoding: 'utf8' }).trim();
const run = (...a) => {
    const r = spawnSync(process.execPath, [LEDGER_JS, ...a], { cwd: T, encoding: 'utf8' });
    return { out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
};
const w = (rel, body) => {
    const p = path.join(T, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
};
const read = (rel) => fs.readFileSync(path.join(T, rel), 'utf8');
const LEDGER = 'DEPLOY-LEDGER.md';

let failed = 0;
let assertions = 0;
const check = (label, ok, detail) => {
    assertions++;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  -> ' + String(detail).trim().split('\n').slice(0, 4).join(' | ')}`);
};

// The gate commit is the one field a fill cannot hard-code: it must name the
// candidate, so it is copied from the commit line the script derived. A literal
// override replaces it, for the cases that plant a wrong one.
function bindGateCommit(text, override) {
    const derived = (text.match(/^- commit: ([0-9a-f]*)\r?$/m) || [])[1] || '';
    return text.replace(/^- gate commit: .*$/m, '- gate commit: ' + (override === undefined ? derived : override));
}

// The gate script every fixture's package.json declares. `gate:ci` is there so
// a fixture can name a real, runnable subset of the gate and be refused.
const PACKAGE_JSON = JSON.stringify({ scripts: { gate: 'npm test && npm run lint', 'gate:ci': 'npm test', test: 'node -e 0' } }, null, 2) + '\n';

// Fills every promotion field in the ledger on disk with values that validate.
// Written by hand here, not derived from the script, so the two cannot drift
// together. `commit` is left as the script wrote it: that is the field under test
// for staleness.
function fillRecord(overrides = {}) {
    let text = read(LEDGER);
    const v = Object.assign({
        gate: 'npm run gate', 'gate exit': '0', evidence: '.claude/evidence/promo',
        rollback: 'vercel rollback', authorised: '[stated 2026-09-08] Form B, pre-authorised on a green gate with the ledger',
    }, overrides);
    for (const [k, val] of Object.entries(v)) text = text.replace(new RegExp(`^- ${k}: .*$`, 'm'), `- ${k}: ${val}`);
    text = text.replace('- gate tail:\n\n```text\n```', '- gate tail:\n\n```text\nvalidate: 19 PASS / 0 FAIL\nALL 61 SUITES PASSED\n```');
    text = bindGateCommit(text, overrides['gate commit']);
    text = text.replace(/\[ \]/g, '[x]').replace(
        '- [x] metrics recorded or waived:',
        '- [x] metrics recorded or waived: WAIVED, no user-visible metric moves'
    );
    w(LEDGER, text);
}

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

    // ---- derivation, unchanged from the first version of this suite ----
    const listed = run('--since', 'deploy-1');
    check('derives the two routes and the wide file',
        /\/\s+<-/.test(listed.out) && /\/settings/.test(listed.out) && /WIDE\s+app\/globals\.css/.test(listed.out),
        listed.out);
    check('counts only user-facing files, not lib/helper.ts',
        /4 file\(s\) changed, 3 user-facing/.test(listed.out), listed.out.split('\n')[0]);

    const written = run('--since', 'deploy-1', '--write');
    let ledger = read(LEDGER);
    check('writes a ledger with a row per surface',
        /\| `\/` \|/.test(ledger) && /\| `\/settings` \|/.test(ledger) && /WIDE \(every surface\)/.test(ledger), written.out);
    const head1 = git('rev-parse', 'HEAD');
    check('writes a promotion record with the commit derived and every other field empty',
        new RegExp(`^- commit: ${head1}$`, 'm').test(ledger) && /^- gate: $/m.test(ledger) && /^- authorised: $/m.test(ledger),
        ledger.split('## Promotion record')[1]);

    // ---- UNMARKED PROJECT: refuses with the instruction, decides nothing ----
    const unmarked = run('--since', 'deploy-1', '--verify', '--promotion');
    check('unmarked project: exit 2, not 1 and not 0', unmarked.status === 2, 'status=' + unmarked.status);
    check('unmarked project: names the heading to add and the `none` escape',
        /Deploy-sensitive paths/.test(unmarked.out) && /- none/.test(unmarked.out), unmarked.out);

    // ---- mark it, through an @-import, the way one real repo is laid out ----
    w('CLAUDE.md', '@AGENTS.md\n');
    w('AGENTS.md', '# Project\n\n## Deploy-sensitive paths\n\n- `supabase/migrations/**`\n- `src/billing/**`\n\n## Next heading\n\n- `not/a/glob`\n');
    w('package.json', PACKAGE_JSON);
    git('add', '-A'); git('commit', '-qm', 'mark sensitive paths');

    // ---- STALE: HEAD moved after --write, the ledger still names the old commit ----
    const stale = run('--since', 'deploy-1', '--verify', '--promotion');
    check('stale ledger: exit 1 naming STALE with both shas',
        stale.status === 1 && new RegExp(`STALE: the ledger names ${head1.slice(0, 7)}`).test(stale.out), stale.out);

    // ---- INCOMPLETE: regenerated, nothing filled ----
    run('--since', 'deploy-1', '--write');
    const incomplete = run('--since', 'deploy-1', '--verify', '--promotion');
    check('incomplete: exit 1', incomplete.status === 1, 'status=' + incomplete.status);
    check('incomplete: names unchecked surfaces and metrics',
        /UNCHECKED\s+`\/settings`/.test(incomplete.out) && /UNCHECKED\s+metrics/.test(incomplete.out), incomplete.out);
    for (const f of ['gate', 'gate exit', 'gate tail', 'evidence', 'rollback', 'authorised']) {
        check(`incomplete: names the empty field "${f}"`, new RegExp(`MISSING\\s+${f}:`).test(incomplete.out), incomplete.out);
    }
    check('incomplete: does NOT name the commit, which --write derived and HEAD has not moved',
        !/MISSING\s+commit:/.test(incomplete.out), incomplete.out);

    // ---- COMPLETE: every box, every field, the prove pair on disk ----
    w('.claude/evidence/promo/before.txt', 'preview: 404 on /settings\n');
    w('.claude/evidence/promo/after.txt', 'preview: 200 on /settings\n');
    fillRecord();
    const complete = run('--since', 'deploy-1', '--verify', '--promotion');
    check('complete: exit 0', complete.status === 0, 'status=' + complete.status + ' ' + complete.out);
    check('complete: ZERO BYTES on stdout', complete.stdout === '', JSON.stringify(complete.stdout));
    check('complete: ZERO BYTES on stderr', complete.stderr === '', JSON.stringify(complete.stderr));
    const verbose = run('--since', 'deploy-1', '--verify', '--promotion', '--verbose');
    check('complete --verbose: exit 0 and says the record is complete, with the population',
        verbose.status === 0 && /promotion record for [0-9a-f]{7} is complete/.test(verbose.out) && /\[population\]/.test(verbose.out), verbose.out);

    // Each single defect must turn the pass red on ITS OWN field, so the pass
    // above is known to depend on every one of them (a pass that survives a
    // missing after.png is a pass that never looked).
    fs.rmSync(path.join(T, '.claude/evidence/promo/after.txt'));
    const noAfter = run('--since', 'deploy-1', '--verify', '--promotion');
    check('missing after.* fails on the evidence field', noAfter.status === 1 && /MISSING\s+evidence: .*lacks after\.\*/.test(noAfter.out), noAfter.out);
    w('.claude/evidence/promo/after.txt', 'preview: 200 on /settings\n');

    fillRecord({ 'gate exit': '1' });
    const redGate = run('--since', 'deploy-1', '--verify', '--promotion');
    check('a red gate fails on the gate exit field', redGate.status === 1 && /MISSING\s+gate exit: "1" is not 0/.test(redGate.out), redGate.out);

    fillRecord({ rollback: 'git checkout [prev-commit] -- supabase/functions/' });
    const placeholder = run('--since', 'deploy-1', '--verify', '--promotion');
    check('a placeholder rollback fails on the rollback field', placeholder.status === 1 && /MISSING\s+rollback: .*placeholder/.test(placeholder.out), placeholder.out);

    fillRecord({ authorised: 'the Brain said it was fine' });
    const relayed = run('--since', 'deploy-1', '--verify', '--promotion');
    check('an authorisation without [stated date] fails on the authorised field',
        relayed.status === 1 && /MISSING\s+authorised: .*\[stated YYYY-MM-DD\]/.test(relayed.out), relayed.out);

    fillRecord();
    check('restored: passes again', run('--since', 'deploy-1', '--verify', '--promotion').status === 0, '');

    // Filled fields must survive a regenerate, or nobody will regenerate.
    run('--since', 'deploy-1', '--write');
    const after = read(LEDGER);
    check('preserves ticks, metrics and filled fields across a rewrite',
        /^- gate: npm run gate$/m.test(after) && /^- authorised: \[stated 2026-09-08\]/m.test(after)
        && /ALL 61 SUITES PASSED/.test(after) && /WAIVED, no user-visible metric moves/.test(after)
        && (after.match(/\[x\]/g) || []).length >= 16,
        after);
    check('rewrite still verifies', run('--since', 'deploy-1', '--verify', '--promotion').status === 0, '');

    const head2 = git('rev-parse', 'HEAD');

    // ---- INELIGIBLE BY PATH: fields are irrelevant, the window itself is refused ----
    w('src/billing/plans.ts', 'export const PRO = 10;\n');
    git('add', '-A'); git('commit', '-qm', 'touch billing');
    run('--since', head2, '--write');
    const byPath = run('--since', head2, '--verify', '--promotion');
    check('ineligible by path: exit 3', byPath.status === 3, 'status=' + byPath.status + ' ' + byPath.out);
    check('ineligible by path: names the file and the glob and its source',
        /INELIGIBLE\s+src\/billing\/plans\.ts\s+matches deploy-sensitive `src\/billing\/\*\*` \(AGENTS\.md\)/.test(byPath.out), byPath.out);
    check('ineligible by path: says no field fixes it', /No field fixes this/.test(byPath.out), byPath.out);
    check('ineligible by path: prints the population it judged',
        /\[ineligible\] 1 reason\(s\).*2 deploy-sensitive glob\(s\).*\d+ file\(s\) in the window/.test(byPath.out), byPath.out);
    const billingSha = git('rev-parse', 'HEAD');

    // ---- CONTROL: SQL that is genuinely eligible ----
    // The rule set must be able to say YES about SQL, or "ineligible" below
    // proves only that it fires on everything. Additive DDL and the comment that
    // once matched the word "truncated" are the control.
    w('db/0003_index.sql', 'CREATE INDEX idx_scans_id ON scans (id);\nALTER TABLE scans ADD COLUMN note text;\n-- Yesterday truncated to the same clock time\n');
    git('add', '-A'); git('commit', '-qm', 'additive ddl');
    const rewrite = run('--since', billingSha, '--write');
    // A new window must start blank. The first version of the script carried the
    // filled fields of the PROMOTED window into this one and passed it.
    check('a --write for a new window starts blank and says so',
        /ticks and fields reset/.test(rewrite.out) && /^- gate: $/m.test(read(LEDGER)) && /^- authorised: $/m.test(read(LEDGER)), rewrite.out);
    const additive = run('--since', billingSha, '--verify', '--promotion');
    check('additive DDL and a "truncated" comment are NOT ineligible (exit 1 for the unfilled record, not 3)',
        additive.status === 1 && !/INELIGIBLE/.test(additive.out), 'status=' + additive.status + ' ' + additive.out);
    let prevSha = git('rev-parse', 'HEAD');

    // ---- INELIGIBLE BY EACH SQL CLAUSE of the operator's list ----
    // One commit per clause, each asserted by the RULE ID it must fire, so a
    // case cannot pass because some other rule happened to match the line.
    const clauses = [
        ['schema-drop', 'db/c1.sql', '-- tidy up\nDROP TABLE legacy_scans;\n', 'DROP TABLE legacy_scans;'],
        ['rename', 'db/c2.sql', 'ALTER TABLE scans RENAME COLUMN slug TO code;\n', 'RENAME COLUMN'],
        ['grant', 'db/c3.sql', 'GRANT SELECT ON scans TO anon;\n', 'GRANT SELECT'],
        ['rls', 'db/c4.sql', 'DROP POLICY IF EXISTS "owner reads" ON scans;\nCREATE POLICY "owner reads" ON scans FOR SELECT USING (true);\n', 'DROP POLICY'],
        ['security-definer', 'db/c5.sql', 'CREATE FUNCTION f() RETURNS void SECURITY DEFINER AS $$ SELECT 1 $$;\n', 'SECURITY DEFINER'],
        ['live-rows', 'db/c6.sql', 'UPDATE scans SET n = 0;\n', 'UPDATE scans SET'],
    ];
    for (const [id, file, body, fragment] of clauses) {
        w(file, body);
        git('add', '-A'); git('commit', '-qm', 'clause ' + id);
        run('--since', prevSha, '--write');
        const r = run('--since', prevSha, '--verify', '--promotion');
        check(`ineligible by ${id}: exit 3, naming the rule, the file and the statement`,
            r.status === 3 && new RegExp(`INELIGIBLE\\s+${file.replace('.', '\\.')}\\s+${id}:`).test(r.out) && r.out.includes(fragment),
            'status=' + r.status + ' ' + r.out);
        prevSha = git('rev-parse', 'HEAD');
    }
    // DROP POLICY is the case an earlier draft of the script pinned as ELIGIBLE,
    // on a corpus measurement that showed every policy drop was recreated in the
    // same file. The operator's list says an RLS change escalates regardless, so
    // this assertion is deliberately the reverse of what the first suite asserted.
    w('db/c7.sql', 'DROP POLICY IF EXISTS "owner reads" ON scans;\nCREATE POLICY "owner reads" ON scans FOR SELECT USING (true);\n');
    git('add', '-A'); git('commit', '-qm', 'policy recreate');
    run('--since', prevSha, '--write');
    const recreate = run('--since', prevSha, '--verify', '--promotion');
    check('a policy DROP followed by its own CREATE is still ineligible (the recreate is where RLS mistakes hide)',
        recreate.status === 3 && /rls:/.test(recreate.out), 'status=' + recreate.status + ' ' + recreate.out);
    const policySha = git('rev-parse', 'HEAD');

    // ---- THE COMMIT MUST BE ON THE DEFAULT BRANCH ----
    const home = git('rev-parse', '--abbrev-ref', 'HEAD');
    git('checkout', '-q', '-b', 'side');
    w('app/side.tsx', 'export default () => null;\n');
    git('add', '-A'); git('commit', '-qm', 'work on a side branch');
    run('--since', policySha, '--write');
    const offBranch = run('--since', policySha, '--verify', '--promotion');
    check('a commit not on the default branch is refused (exit 1) and the message names the branch',
        offBranch.status === 1 && new RegExp(`MISSING\\s+default branch: .*is not on ${home}`).test(offBranch.out),
        'status=' + offBranch.status + ' ' + offBranch.out);
    // -f because the fixture's `git add -A` tracked DEPLOY-LEDGER.md, so the
    // working copy differs from the branch being returned to. It is regenerated
    // below anyway.
    git('checkout', '-q', '-f', home);
    git('branch', '-qD', 'side');
    // The control: back on the default branch the same window stops reporting it,
    // so the refusal above was about containment and not about something else.
    run('--since', policySha, '--write');
    check('back on the default branch, containment is no longer reported',
        !/default branch:/.test(run('--since', policySha, '--verify', '--promotion').out), '');

    const bySql = run('--since', prevSha, '--verify', '--promotion');
    check('an ineligible window stays ineligible on re-run', bySql.status === 3, 'status=' + bySql.status);

    // ---- BLIND: no ref determinable must REFUSE, never report "nothing changed" ----
    fs.rmSync(path.join(T, '.claude', 'last-deploy'), { force: true });
    fs.rmSync(path.join(T, '.git', 'refs', 'tags', 'deploy-1'), { force: true });
    const blind = run();
    check('refuses when the last deploy cannot be determined',
        blind.status === 2 && /COULD NOT DETERMINE/.test(blind.out), 'status=' + blind.status + ' ' + blind.out);

    // ---- --help returns, for check-entrypoints and for humans ----
    const help = run('--help');
    check('--help prints usage and exits 0', help.status === 0 && /--verify/.test(help.out) && /--promotion/.test(help.out), help.out);

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
    // A fixture ledger counts as complete only when it satisfies EVERY
    // precondition --verify has, not just the surface rows. The promotion record
    // is part of the authorisation, so ticking boxes alone would assert exit 0
    // against a ledger no promotion could actually run behind.
    const tick = () => {
        let text = read().replace(/\[ \]/g, '[x]').replace(
            '- [x] metrics recorded or waived:', '- [x] metrics recorded or waived: WAIVED fixture layout-only change');
        for (const [k, val] of Object.entries({
            gate: 'npm run gate', 'gate exit': '0', evidence: '.claude/evidence/promo',
            rollback: 'vercel rollback',
            authorised: '[stated 2026-09-08] Form B, pre-authorised on a green gate with the ledger',
        })) text = text.replace(new RegExp(`^- ${k}: .*$`, 'm'), `- ${k}: ${val}`);
        text = text.replace('- gate tail:\n\n```text\n```',
            '- gate tail:\n\n```text\nvalidate: 19 PASS / 0 FAIL\nALL 61 SUITES PASSED\n```');
        save(bindGateCommit(text));
    };
    try {
        // -b main so defaultBranch() resolves: the rule requires the promoted
        // commit to be ON the default branch, and an unnamed branch cannot be.
        g('init', '-q', '-b', 'main'); g('config', 'user.name', 'Fixture'); g('config', 'user.email', 'fixture@example.invalid');
        write('README.md', 'base\n');
        // Two preconditions of --verify that are not what these controls
        // measure, set up once in the base commit so they stay out of every
        // window: the project must declare its deploy-sensitive paths (`none`
        // is the honest answer for a synthetic fixture), and the evidence field
        // must name a directory holding a before/after pair.
        write('CLAUDE.md', '# Fixture\n\n## Deploy-sensitive paths\n\n- none\n');
        write('package.json', PACKAGE_JSON);
        write('.claude/evidence/promo/before.txt', 'fixture before\n');
        write('.claude/evidence/promo/after.txt', 'fixture after\n');
        const base = commit(['README.md', 'CLAUDE.md', 'package.json'], 'base');
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
    // Plain --verify is the surface record the ship skill's Step 5b runs after a
    // deploy. Promotion preconditions must not leak into it: blank every promotion
    // field and it still passes, while --promotion on the same ledger does not.
    save(read().replace(/^- (gate|gate exit|evidence|rollback|authorised): .*$/gm, '- $1: '));
    v = cli('--since', base, '--verify');
    check('plain --verify ignores the promotion record (Step 5b contract unchanged)', v.status === 0 && /every surface in this window has been checked/.test(v.out), v.out);
    v = cli('--since', base, '--verify', '--promotion');
    check('the control: --promotion on the same ledger names the blanked fields', v.status === 1 && /MISSING\s+rollback:/.test(v.out), v.out);
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
    // --verbose, because a PASSING --verify prints zero bytes on purpose: it runs
    // as `--verify && <promote>` and text on the pass path is skimmed, never read.
    // The population is still asserted, just on the path that offers it.
    const v = cli('--since', base, '--verify', '--promotion', '--verbose');
    check('genuine zero-surface docs-only population can still pass with recorded metrics', v.status === 0 && /2 file\(s\) changed, 0 user-facing/.test(v.out), v.out);
    const quiet = cli('--since', base, '--verify', '--promotion');
    check('and the same pass without --verbose is silent, so the chain reads the code', quiet.status === 0 && quiet.out === '', JSON.stringify(quiet.out));
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
    v = cli('--since', base, '--candidate', candidate, '--verify', '--verbose');
    check('tracked archival commit does not invalidate explicit frozen-candidate verification', v.status === 0, v.out);
    check('explicit historical verdict prints candidate and current checkout separately',
        v.out.includes('candidate ' + candidate) && v.out.includes('checkout HEAD ' + evidenceCommit) && /only.*candidate/i.test(v.out), v.out);
    cli('--since', base, '--candidate', candidate, '--write');
    check('regenerating archived frozen-candidate evidence is byte-stable', g('diff', '--numstat', '--', 'DEPLOY-LEDGER.md') === '', read());
    write('app/page.tsx', 'different unverified source\n'); const newer = commit(['app/page.tsx'], 'new source');
    v = cli('--since', base, '--candidate', candidate, '--verify', '--verbose');
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

// ---- F3: the SQL rules must read the CANDIDATE, not the checkout ----
// [measured 2026-09-13, #208 review P1] a candidate carrying DROP TABLE verified
// with no ineligible line from a checkout that lacked it, because the SQL diff
// ran over since..HEAD while every other diff used the candidate. Both
// directions are planted: SQL only on the candidate must be found, and SQL only
// on the checkout must not be charged to a clean candidate.
fixture(({ g, write, commit, cli, tick, base }) => {
    g('checkout', '-q', '-b', 'candidate-branch');
    write('db/001.sql', 'DROP TABLE users;\n');
    const dropping = commit(['db/001.sql'], 'candidate drops a table');
    g('checkout', '-q', 'main');
    check('F3 precondition: the drop is in base..candidate and absent from base..HEAD',
        g('diff', '--name-only', `${base}..${dropping}`) === 'db/001.sql' && g('diff', '--name-only', `${base}..HEAD`) === '',
        'fixture did not separate checkout from candidate');
    cli('--since', base, '--candidate', dropping, '--write'); tick();
    let v = cli('--since', base, '--candidate', dropping, '--verify', '--promotion');
    check('F3: a DROP TABLE carried only by the candidate is ineligible from a checkout that lacks it',
        v.status === 3 && /INELIGIBLE\s+db\/001\.sql\s+schema-drop:/.test(v.out), 'status=' + v.status + ' ' + v.out);

    // The reverse. main gains a drop; the candidate branched before it and is clean.
    g('checkout', '-q', '-b', 'clean-candidate', base);
    write('app/page.tsx', 'clean\n');
    const clean = commit(['app/page.tsx'], 'clean candidate');
    g('checkout', '-q', 'main');
    write('db/002.sql', 'DROP TABLE orders;\n');
    commit(['db/002.sql'], 'checkout-only drop');
    cli('--since', base, '--candidate', clean, '--write'); tick();
    v = cli('--since', base, '--candidate', clean, '--verify', '--promotion');
    check('F3 control: a drop only on the checkout is not charged to a clean candidate',
        v.status !== 3 && !/INELIGIBLE/.test(v.out), 'status=' + v.status + ' ' + v.out);
});

// ---- F2: the gate record must be about THIS candidate and THIS repo's gate ----
// The review: the record accepted any gate name, the string 0 and any tail, and
// nothing tied it to the candidate or to package.json. A loop that ran gate:ci,
// or nothing, could write three lines and pass.
fixture(({ g, write, commit, cli, read, save, tick, base }) => {
    write('app/page.tsx', 'home\n');
    const candidate = commit(['app/page.tsx'], 'candidate');
    cli('--since', base, '--write'); tick();
    const valid = read();
    const field = (text, k, val) => text.replace(new RegExp(`^- ${k}: .*$`, 'm'), `- ${k}: ${val}`);
    let v = cli('--since', base, '--verify', '--promotion');
    check('F2 positive control: npm run gate, bound to the candidate, passes', v.status === 0 && v.out === '', 'status=' + v.status + ' ' + v.out);
    check('F2 precondition: the ledger carries a gate commit naming the candidate',
        new RegExp(`^- gate commit: ${candidate}\\r?$`, 'm').test(valid), valid.split('## Promotion record')[1]);

    save(field(valid, 'gate', 'npm run gate:ci'));
    v = cli('--since', base, '--verify', '--promotion');
    check('F2: gate:ci is refused while package.json at the candidate defines gate',
        v.status === 1 && /MISSING\s+gate: .*"gate:ci".*variant of "gate"/.test(v.out), 'status=' + v.status + ' ' + v.out);

    save(field(valid, 'gate', 'echo ok'));
    v = cli('--since', base, '--verify', '--promotion');
    check('F2: a gate field that runs no package script is refused',
        v.status === 1 && /MISSING\s+gate: "echo ok"/.test(v.out), 'status=' + v.status + ' ' + v.out);

    save(field(valid, 'gate commit', ''));
    v = cli('--since', base, '--verify', '--promotion');
    check('F2: a record with no gate commit is refused', v.status === 1 && /MISSING\s+gate commit:/.test(v.out), 'status=' + v.status + ' ' + v.out);

    save(field(valid, 'gate commit', base));
    v = cli('--since', base, '--verify', '--promotion');
    check('F2: a gate that ran on another commit is refused, naming both',
        v.status === 1 && new RegExp(`MISSING\\s+gate commit: .*${base.slice(0, 7)}.*${candidate.slice(0, 7)}`).test(v.out),
        'status=' + v.status + ' ' + v.out);

    // The script name is read from package.json AT THE CANDIDATE. The working
    // tree keeps a gate script; the committed candidate does not.
    save(valid);
    write('package.json', JSON.stringify({ scripts: { test: 'node -e 0' } }, null, 2) + '\n');
    const noGate = commit(['package.json'], 'candidate drops its gate script');
    write('package.json', PACKAGE_JSON);
    cli('--since', base, '--write'); tick();
    v = cli('--since', base, '--verify', '--promotion');
    check('F2: the gate script is read at the candidate SHA, not the working tree (exit 2, blind)',
        v.status === 2 && new RegExp(`no "gate" or "preflight" script.*${noGate.slice(0, 7)}`).test(v.out), 'status=' + v.status + ' ' + v.out);
});

// ---- F1: a deploy-on-merge repo must be verifiable BEFORE the merge ----
// Containment in the default branch can only hold after the merge, and on a
// repo where the merge is the deploy that made a pre-merge pass impossible.
// --pre-merge instead requires the candidate to contain the tip it merges onto,
// so the tree the gate ran on is the tree the merge produces.
fixture(({ g, write, commit, cli, tick, base }) => {
    g('checkout', '-q', '-b', 'feature');
    write('app/page.tsx', 'feature\n');
    commit(['app/page.tsx'], 'feature work');
    cli('--since', base, '--write'); tick();
    let v = cli('--since', base, '--verify', '--promotion');
    check('F1 control: without --pre-merge a branch candidate is still refused as not on main',
        v.status === 1 && /MISSING\s+default branch: .*is not on main/.test(v.out), 'status=' + v.status + ' ' + v.out);
    v = cli('--since', base, '--verify', '--promotion', '--pre-merge');
    check('F1: --pre-merge passes a candidate that contains the tip of main, and says it is pre-merge',
        v.status === 0 && /\[pre-merge\]/.test(v.out) && /main/.test(v.out) && /before the merge/i.test(v.out),
        'status=' + v.status + ' ' + v.out);
    v = cli('--since', base, '--verify', '--promotion', '--pre-merge', '--onto', 'main');
    check('F1: --onto names the base explicitly', v.status === 0 && /\[pre-merge\].*main/.test(v.out), 'status=' + v.status + ' ' + v.out);

    // main moves on. The merge would now produce a tree nobody gated.
    g('checkout', '-q', 'main');
    write('README.md', 'main moved\n');
    const moved = commit(['README.md'], 'main moves');
    g('checkout', '-q', 'feature');
    v = cli('--since', base, '--verify', '--promotion', '--pre-merge');
    check('F1: --pre-merge refuses a candidate that does not contain the current tip of main',
        v.status === 1 && new RegExp(`MISSING\\s+merge base: .*does not contain main at ${moved.slice(0, 7)}`).test(v.out),
        'status=' + v.status + ' ' + v.out);
    v = cli('--since', base, '--verify', '--promotion', '--pre-merge', '--onto', 'no-such-ref');
    check('F1: an unresolvable --onto is blind (exit 2), not a pass', v.status === 2 && /--onto/.test(v.out), 'status=' + v.status + ' ' + v.out);
});

console.log(`[control] ${assertions} assertion(s), ${assertions - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
