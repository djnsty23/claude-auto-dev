#!/usr/bin/env node
// Tests for memory-audit.js.
//
// Written 2026-08-19 because the file had NO suite at all. That was found the
// hard way: decodeProjectDir carried the same drive-relative path bug as
// drift-audit's slug reversal, and fixing it was a blind edit — nothing in the
// repo could have told me whether the corrected function returned a usable
// path. `npm run check:hooks` reports untested hooks; nothing reported this.
//
// Built on real directories in a temp dir rather than mocks, for the same
// reason the drift-audit suite is: every signal here is defined in terms of
// what is actually on disk — does the project path resolve, is MEMORY.md
// present, do its links point at files that exist. A mock filesystem would let
// decodeProjectDir be wrong while every assertion still passed, which is
// precisely the failure this suite exists to prevent.
//
// The slug fixtures deliberately use the REAL production encoding, drive letter
// and all. A drive-less slug round-trips on a developer machine (cwd and %TEMP%
// share a drive) and resolves nowhere on a D: workspace, so a fixture that
// strips the drive tests a shape that only exists in the test file.
//
// Run: node tooling/test-memory-audit.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIT = path.resolve(__dirname, '..', 'plugins', 'autodev-memory', 'scripts', 'memory-audit.js');

// No dashes in the prefix: the slug encoding replaces separators with '-', so a
// dash anywhere in the temp path reverses wrong and the project reads as gone.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memaudit')));
const CONFIG = path.join(TMP, 'claudeconfig');
fs.mkdirSync(path.join(CONFIG, 'projects'), { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

const DAY = 86400000;

// Encode a path exactly as Claude Code does: ':' and every separator become
// '-'. `C:\Users\x` -> `C--Users-x`, `/tmp/x` -> `-tmp-x`.
const slugFor = (p) => p.replace(/^([A-Za-z]):/, '$1-').replace(/[\\/]/g, '-');

// A project directory on disk plus its memory store under CONFIG/projects.
function makeProject(name, memories, index) {
    const projectDir = path.join(TMP, name);
    fs.mkdirSync(projectDir, { recursive: true });
    const memDir = path.join(CONFIG, 'projects', slugFor(projectDir), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    for (const [file, body] of Object.entries(memories)) {
        fs.writeFileSync(path.join(memDir, file), body);
    }
    if (index !== undefined) fs.writeFileSync(path.join(memDir, 'MEMORY.md'), index);
    return { projectDir, memDir };
}

// A memory store whose project path does NOT exist on disk.
function makeOrphanStore(fakeName, memories) {
    const fake = path.join(TMP, fakeName);
    const memDir = path.join(CONFIG, 'projects', slugFor(fake), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    for (const [file, body] of Object.entries(memories)) {
        fs.writeFileSync(path.join(memDir, file), body);
    }
    return fake;
}

const mem = (name, description, body) =>
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`;

function run(extraArgs = []) {
    const r = spawnSync(process.execPath, [AUDIT, '--json', ...extraArgs], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
        maxBuffer: 32 * 1024 * 1024,
    });
    try { return JSON.parse(r.stdout).projects; }
    catch { return null; }
}

const forProject = (projects, dirName) =>
    (projects || []).find((p) => p.slug.endsWith(slugFor(path.join(TMP, dirName)).replace(/^[A-Za-z]-/, '')));

const kinds = (p) => (p ? p.findings.map((f) => f.kind) : []);

// ───────────────────────────── 1. THE DRIVE LETTER — the reason this file exists
//
// A project registered under its real slug must resolve back to a directory
// that exists. Before the fix this returned a rooted path with no drive, which
// on Windows is drive-relative: correct from a C: cwd, nonexistent from a D:
// one. The audit then reported every project as gone.
{
    const { projectDir } = makeProject(
        'clean',
        { 'a.md': mem('alpha', 'the alpha fact', 'Alpha body about pipelines.') },
        '- [Alpha](a.md) — the alpha fact\n',
    );
    const p = forProject(run(), 'clean');
    check('project registered under its real slug is found', !!p);
    check('  its path resolves to a directory that exists', !!p && p.projectExists === true);
    check('  so it is NOT reported as gone', !kinds(p).includes('project-gone'));
    check('  and a well-formed store has no findings at all', !!p && p.findings.length === 0);
    check('  the decoded path is the real project dir',
        !!p && path.resolve(p.projectPath).toLowerCase() === path.resolve(projectDir).toLowerCase());
}

// ─────────────────────── 2. the negative half: a store whose project really is gone
//
// Without this, case 1 could pass because projectExists is hardcoded true.
{
    makeOrphanStore('deletedproject', { 'a.md': mem('gonefact', 'a fact', 'Body about vanished repositories.') });
    const p = forProject(run(), 'deletedproject');
    check('a store whose project no longer exists IS reported gone', kinds(p).includes('project-gone'));
}

// ───────────────────────────────────────────── 3. index health
{
    makeProject('noindex', {
        'a.md': mem('one', 'first', 'Body about compilers and linkers.'),
        'b.md': mem('two', 'second', 'Body about kettles and teapots.'),
    });
    check('two memories with no MEMORY.md → index-missing',
        kinds(forProject(run(), 'noindex')).includes('index-missing'));
}

{
    const long = Array.from({ length: 210 }, (_, i) => `- [Item ${i}](m${i}.md) — filler`).join('\n');
    makeProject('longindex', { 'a.md': mem('solo', 'only one', 'Body about turbines.') }, long);
    check('a MEMORY.md over 200 lines → index-too-long',
        kinds(forProject(run(), 'longindex')).includes('index-too-long'));
}

// ─────────────────────────────────────────── 4. frontmatter completeness
{
    makeProject('nofrontmatter', { 'a.md': 'no frontmatter at all, just prose about anchors.\n' },
        '- [A](a.md) — x\n');
    const k = kinds(forProject(run(), 'nofrontmatter'));
    check('a memory with no name:/description: → missing-frontmatter',
        k.filter((x) => x === 'missing-frontmatter').length === 2);
}

// ───────────────────────────────────────────────── 5. duplicate names
{
    makeProject('dupname', {
        'a.md': mem('samename', 'first', 'Body about hydrology and rivers.'),
        'b.md': mem('samename', 'second', 'Body about pastry and baking.'),
    }, '- [A](a.md) — x\n- [B](b.md) — y\n');
    check('two memories sharing a name: → duplicate-name',
        kinds(forProject(run(), 'dupname')).includes('duplicate-name'));
}

// ──────────────────────────────────────────────── 6. near-duplicates
{
    const body = 'This memory describes deployment rollback procedure timing across staging clusters.';
    makeProject('neardup', {
        'a.md': mem('first', 'x', body),
        'b.md': mem('second', 'y', body + ' Slightly extended.'),
    }, '- [A](a.md) — x\n- [B](b.md) — y\n');
    check('two memories with ≥70% shared vocabulary → near-duplicate',
        kinds(forProject(run(), 'neardup')).includes('near-duplicate'));
}

// ─────────────────────────────────── 7. index/file drift, both directions
{
    makeProject('deadlink', { 'a.md': mem('present', 'x', 'Body about surveying.') },
        '- [A](a.md) — x\n- [Missing](gone.md) — y\n');
    check('MEMORY.md linking a file that does not exist → dead-index-link',
        kinds(forProject(run(), 'deadlink')).includes('dead-index-link'));
}

{
    makeProject('unindexed', {
        'a.md': mem('listed', 'x', 'Body about cartography.'),
        'b.md': mem('unlisted', 'y', 'Body about zoology and beetles.'),
    }, '- [A](a.md) — x\n');
    check('a memory absent from MEMORY.md → unindexed',
        kinds(forProject(run(), 'unindexed')).includes('unindexed'));
}

// ──────────────────────────────────────────────── 8. dangling wiki links
{
    makeProject('dangling', { 'a.md': mem('solo', 'x', 'Body referencing [[nonexistent-memory]] here.') },
        '- [A](a.md) — x\n');
    check('a [[link]] with no matching memory → dangling-link',
        kinds(forProject(run(), 'dangling')).includes('dangling-link'));
}

{
    makeProject('goodlink', {
        'a.md': mem('alpha', 'x', 'Body pointing at [[beta]] which exists.'),
        'b.md': mem('beta', 'y', 'Body about entirely separate subject matter, namely glassblowing.'),
    }, '- [A](a.md) — x\n- [B](b.md) — y\n');
    check('  a [[link]] that DOES resolve is not flagged',
        !kinds(forProject(run(), 'goodlink')).includes('dangling-link'));
}

// ───────────────────────────────── 9. the active/stale filter and --all
//
// Both halves, because one alone cannot tell "filtered correctly" from
// "never discovered at all".
{
    const { memDir } = makeProject('stalestore',
        { 'a.md': mem('old', 'x', 'Body about archived material.') }, '- [A](a.md) — x\n');
    const old = (Date.now() - 200 * DAY) / 1000;
    for (const f of fs.readdirSync(memDir)) fs.utimesSync(path.join(memDir, f), old, old);

    check('a store idle 200d is excluded by default', !forProject(run(), 'stalestore'));
    check('  and included with --all', !!forProject(run(['--all']), 'stalestore'));
    check('  --stale-days raises the threshold instead',
        !!forProject(run(['--stale-days=365']), 'stalestore'));
}

// ────────────────────────────── 10. no projects directory at all → clean exit
{
    const empty = path.join(TMP, 'emptyconfig');
    fs.mkdirSync(empty, { recursive: true });
    const r = spawnSync(process.execPath, [AUDIT, '--json'], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: empty },
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* leave null */ }
    check('a config dir with no projects/ exits 0 and reports nothing',
        r.status === 0 && !!parsed && Array.isArray(parsed.projects) && parsed.projects.length === 0);
}

// ─────────────────────────────────────────────────────────── report
let failed = 0;
for (const [label, ok] of cases) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed ? 1 : 0);
