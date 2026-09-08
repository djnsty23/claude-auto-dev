'use strict';
// Acceptance suite for deploy-ledger.js, and its known-positive control. The
// live run against autodev reports 0 user-facing files, which is correct and
// indistinguishable from a broken pipeline. This builds a throwaway repo that
// DOES have UI and walks the whole path a promotion takes:
//
//   derive -> write -> verify (unmarked project, 2) -> mark -> verify (stale, 1)
//   -> write -> verify (incomplete, 1) -> fill -> verify (complete, 0, ZERO BYTES)
//   -> record -> ineligible by path (3) -> eligible DROP POLICY control (1)
//   -> ineligible by schema drop (3) -> audit (complete, incomplete, empty, missing)
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
let total = 0;
const check = (label, ok, detail) => {
    total++;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  -> ' + String(detail).trim().split('\n').slice(0, 4).join(' | ')}`);
};

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
    const unmarked = run('--since', 'deploy-1', '--verify');
    check('unmarked project: exit 2, not 1 and not 0', unmarked.status === 2, 'status=' + unmarked.status);
    check('unmarked project: names the heading to add and the `none` escape',
        /Deploy-sensitive paths/.test(unmarked.out) && /- none/.test(unmarked.out), unmarked.out);

    // ---- mark it, through an @-import, the way one real repo is laid out ----
    w('CLAUDE.md', '@AGENTS.md\n');
    w('AGENTS.md', '# Project\n\n## Deploy-sensitive paths\n\n- `supabase/migrations/**`\n- `src/billing/**`\n\n## Next heading\n\n- `not/a/glob`\n');
    git('add', '-A'); git('commit', '-qm', 'mark sensitive paths');

    // ---- STALE: HEAD moved after --write, the ledger still names the old commit ----
    const stale = run('--since', 'deploy-1', '--verify');
    check('stale ledger: exit 1 naming STALE with both shas',
        stale.status === 1 && new RegExp(`STALE: the ledger names ${head1.slice(0, 7)}`).test(stale.out), stale.out);

    // ---- INCOMPLETE: regenerated, nothing filled ----
    run('--since', 'deploy-1', '--write');
    const incomplete = run('--since', 'deploy-1', '--verify');
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
    const complete = run('--since', 'deploy-1', '--verify');
    check('complete: exit 0', complete.status === 0, 'status=' + complete.status + ' ' + complete.out);
    check('complete: ZERO BYTES on stdout', complete.stdout === '', JSON.stringify(complete.stdout));
    check('complete: ZERO BYTES on stderr', complete.stderr === '', JSON.stringify(complete.stderr));
    const verbose = run('--since', 'deploy-1', '--verify', '--verbose');
    check('complete --verbose: exit 0 and says pre-authorised with the population',
        verbose.status === 0 && /pre-authorised/.test(verbose.out) && /\[population\]/.test(verbose.out), verbose.out);

    // Each single defect must turn the pass red on ITS OWN field, so the pass
    // above is known to depend on every one of them (a pass that survives a
    // missing after.png is a pass that never looked).
    fs.rmSync(path.join(T, '.claude/evidence/promo/after.txt'));
    const noAfter = run('--since', 'deploy-1', '--verify');
    check('missing after.* fails on the evidence field', noAfter.status === 1 && /MISSING\s+evidence: .*lacks after\.\*/.test(noAfter.out), noAfter.out);
    w('.claude/evidence/promo/after.txt', 'preview: 200 on /settings\n');

    fillRecord({ 'gate exit': '1' });
    const redGate = run('--since', 'deploy-1', '--verify');
    check('a red gate fails on the gate exit field', redGate.status === 1 && /MISSING\s+gate exit: "1" is not 0/.test(redGate.out), redGate.out);

    fillRecord({ rollback: 'git checkout [prev-commit] -- supabase/functions/' });
    const placeholder = run('--since', 'deploy-1', '--verify');
    check('a placeholder rollback fails on the rollback field', placeholder.status === 1 && /MISSING\s+rollback: .*placeholder/.test(placeholder.out), placeholder.out);

    fillRecord({ authorised: 'the Brain said it was fine' });
    const relayed = run('--since', 'deploy-1', '--verify');
    check('an authorisation without [stated date] fails on the authorised field',
        relayed.status === 1 && /MISSING\s+authorised: .*\[stated YYYY-MM-DD\]/.test(relayed.out), relayed.out);

    fillRecord();
    check('restored: passes again', run('--since', 'deploy-1', '--verify').status === 0, '');

    // Filled fields must survive a regenerate, or nobody will regenerate.
    run('--since', 'deploy-1', '--write');
    const after = read(LEDGER);
    check('preserves ticks, metrics and filled fields across a rewrite',
        /^- gate: npm run gate$/m.test(after) && /^- authorised: \[stated 2026-09-08\]/m.test(after)
        && /ALL 61 SUITES PASSED/.test(after) && /WAIVED, no user-visible metric moves/.test(after)
        && (after.match(/\[x\]/g) || []).length >= 16,
        after);
    check('rewrite still verifies', run('--since', 'deploy-1', '--verify').status === 0, '');

    // ---- RECORD: files the ledger, moves the marker ----
    const rec = run('--since', 'deploy-1', '--record');
    const head2 = git('rev-parse', 'HEAD');
    const filed = fs.existsSync(path.join(T, 'deploy-ledgers'))
        ? fs.readdirSync(path.join(T, 'deploy-ledgers')) : [];
    check('record: exit 0 and one file named by time and commit',
        rec.status === 0 && filed.length === 1 && new RegExp(`^\\d{8}T\\d{6}Z-${head2.slice(0, 7)}\\.md$`).test(filed[0]),
        rec.out + ' files=' + filed.join(','));
    check('record: .claude/last-deploy now names HEAD', read('.claude/last-deploy').trim() === head2, read('.claude/last-deploy'));
    // [\\/] because this line is the only assertion here reading a
    // `path.relative` result, which is platform-native: Windows printed
    // `deploy-ledgers\...` and a hard-coded `/` failed 1 of 54 there while macOS
    // and Linux stayed green. The other path assertions in this file read `git
    // diff --name-only` output or a literal `/` in the script's format string,
    // both of which are forward slashes on every platform.
    check('record: says where it filed', /\[record\] deploy-ledgers[\\/]/.test(rec.out), rec.out);

    // ---- INELIGIBLE BY PATH: fields are irrelevant, the window itself is refused ----
    w('src/billing/plans.ts', 'export const PRO = 10;\n');
    git('add', '-A'); git('commit', '-qm', 'touch billing');
    run('--write');                           // window now read from .claude/last-deploy
    const byPath = run('--verify');
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
        /started blank/.test(rewrite.out) && /^- gate: $/m.test(read(LEDGER)) && /^- authorised: $/m.test(read(LEDGER)), rewrite.out);
    const additive = run('--since', billingSha, '--verify');
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
        const r = run('--since', prevSha, '--verify');
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
    const recreate = run('--since', prevSha, '--verify');
    check('a policy DROP followed by its own CREATE is still ineligible (the recreate is where RLS mistakes hide)',
        recreate.status === 3 && /rls:/.test(recreate.out), 'status=' + recreate.status + ' ' + recreate.out);
    const policySha = git('rev-parse', 'HEAD');

    // ---- THE COMMIT MUST BE ON THE DEFAULT BRANCH ----
    const home = git('rev-parse', '--abbrev-ref', 'HEAD');
    git('checkout', '-q', '-b', 'side');
    w('app/side.tsx', 'export default () => null;\n');
    git('add', '-A'); git('commit', '-qm', 'work on a side branch');
    run('--since', policySha, '--write');
    const offBranch = run('--since', policySha, '--verify');
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
        !/default branch:/.test(run('--since', policySha, '--verify').out), '');

    const bySql = run('--since', prevSha, '--verify');
    check('an ineligible window stays ineligible on re-run', bySql.status === 3, 'status=' + bySql.status);

    // ---- AUDIT ----
    const auditOk = run('--audit');
    check('audit: one complete promotion, exit 0, population line',
        auditOk.status === 0 && /COMPLETE\s+\d{8}T\d{6}Z-/.test(auditOk.out) && /\[audit\] 1 promotion\(s\) in deploy-ledgers\/, 1 complete, 0 incomplete/.test(auditOk.out),
        auditOk.out);
    // Plant an incomplete record whose filename also disagrees with its commit.
    const planted = read(path.join('deploy-ledgers', filed[0]))
        .replace('- gate exit: 0', '- gate exit: 1')
        .replace(/^- rollback: .*$/m, '- rollback: ');
    w('deploy-ledgers/20260101T000000Z-abcdef0.md', planted);
    const auditBad = run('--audit');
    check('audit: an incomplete record turns the exit to 1 and is named with its fields',
        auditBad.status === 1 && /INCOMPLETE\s+20260101T000000Z-abcdef0\.md\s+.*gate exit: "1" is not 0.*rollback: missing/.test(auditBad.out),
        auditBad.out);
    check('audit: catches a filename that names a different commit than the record',
        /file is named for abcdef0 but the record says/.test(auditBad.out), auditBad.out);
    check('audit: the complete one is still listed complete', /COMPLETE\s+\d{8}T\d{6}Z-/.test(auditBad.out) && /2 promotion\(s\).*1 complete, 1 incomplete/.test(auditBad.out), auditBad.out);
    fs.mkdirSync(path.join(T, 'empty-dir'));
    const auditEmpty = run('--audit', '--ledger-dir', 'empty-dir');
    check('audit: an empty directory says 0 audited rather than passing quietly',
        auditEmpty.status === 0 && /0 promotion\(s\) in empty-dir\/; nothing was audited/.test(auditEmpty.out), auditEmpty.out);
    const auditMissing = run('--audit', '--ledger-dir', 'nowhere');
    check('audit: a missing directory is exit 2, not an empty pass', auditMissing.status === 2 && /COULD NOT AUDIT/.test(auditMissing.out), auditMissing.out);

    // ---- BLIND: no ref determinable must REFUSE, never report "nothing changed" ----
    fs.rmSync(path.join(T, '.claude', 'last-deploy'));
    fs.rmSync(path.join(T, '.git', 'refs', 'tags', 'deploy-1'), { force: true });
    const blind = run();
    check('refuses when the last deploy cannot be determined',
        blind.status === 2 && /COULD NOT DETERMINE/.test(blind.out), 'status=' + blind.status + ' ' + blind.out);

    // ---- --help returns, for check-entrypoints and for humans ----
    const help = run('--help');
    check('--help prints usage and exits 0', help.status === 0 && /--verify/.test(help.out) && /--audit/.test(help.out), help.out);
} finally {
    fs.rmSync(T, { recursive: true, force: true });
}

console.log(`[control] ${total} assertion(s), ${total - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
