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

// ─────────────── 7b. a sub-index linked from MEMORY.md is part of the index
//
// Stores past the 200-line budget move old pointers into MEMORY-archive.md.
// On the real autodev store, 285 of 286 "unindexed" findings were memories
// listed there. The negative half keeps the hop honest: a MEMORY-*.md that
// MEMORY.md does NOT link is an ordinary memory and indexes nothing.
{
    const p = forProject((() => {
        makeProject('subindex', {
            'a.md': mem('current', 'x', 'Body about lighthouses.'),
            'b.md': mem('archived', 'y', 'Body about orchards and grafting.'),
            'MEMORY-archive.md': '# Archived memory index\n\n- [B](b.md) — y\n- [Gone](gone.md) — z\n',
        }, '- [A](a.md) — x\n- [Older memories](MEMORY-archive.md) — aged out\n');
        return run();
    })(), 'subindex');
    const details = (kind) => (p ? p.findings.filter((f) => f.kind === kind).map((f) => f.detail) : []);
    check('a memory listed only in a linked MEMORY-archive.md is NOT unindexed',
        !!p && !details('unindexed').some((d) => d.startsWith('b.md')));
    check('  the sub-index itself is not audited as a memory',
        !!p && p.memoryCount === 2 && !details('missing-frontmatter').length);
    check('  a dead link inside the sub-index is still reported, naming the page',
        details('dead-index-link').some((d) => d.includes('gone.md') && d.includes('MEMORY-archive.md')));
    check('  and the sub-index is listed in the report', !!p && (p.subIndexes || []).includes('MEMORY-archive.md'));
}

{
    const p = forProject((() => {
        makeProject('unlinkedsub', {
            'a.md': mem('current', 'x', 'Body about lighthouses.'),
            'b.md': mem('stray', 'y', 'Body about orchards and grafting.'),
            'MEMORY-notes.md': mem('notes', 'z', 'Mentions [B](b.md) in passing.'),
        }, '- [A](a.md) — x\n');
        return run();
    })(), 'unlinkedsub');
    check('  a MEMORY-*.md that MEMORY.md does not link indexes nothing',
        !!p && p.findings.some((f) => f.kind === 'unindexed' && f.detail.startsWith('b.md')));
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

// ──────────── 8b. links into the global store resolve; the rest rank as gaps
//
// A project memory may link a global one (<config>/memory). The audit never
// read that store, so those links were reported dangling. What does not
// resolve anywhere is a gap, ranked by how many memories cite it.
{
    const globalDir = path.join(CONFIG, 'memory');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'credentials-map.md'),
        mem('credentials-map', 'where secrets live', 'Body about vaults.'));
    makeProject('gaps', {
        'a.md': mem('one', 'x', 'See [[credentials-map]] and [[write-me]] and [[later]].'),
        'b.md': mem('two', 'y', 'Also [[write-me]], twice: [[write-me]].'),
        'c.md': mem('three', 'z', 'Again [[write-me]].'),
    }, '- [A](a.md) — x\n- [B](b.md) — y\n- [C](c.md) — z\n');
    const p = forProject(run(), 'gaps');
    const dangling = p ? p.findings.filter((f) => f.kind === 'dangling-link').map((f) => f.detail) : [];
    check('a [[link]] to a GLOBAL memory is not dangling',
        !!p && !dangling.some((d) => d.includes('credentials-map')));
    check('  a link that resolves nowhere is still dangling', dangling.some((d) => d.includes('[[later]]')));
    check('  gaps rank by citing memories, most first, each memory counted once',
        !!p && Array.isArray(p.gaps) && p.gaps.length === 2 &&
        p.gaps[0].name === 'write-me' && p.gaps[0].refs === 3 &&
        p.gaps[1].name === 'later' && p.gaps[1].refs === 1);
}

// ──────── 8c. the global store is audited too, and rule names resolve
//
// <config>/memory loads in every session and was never audited. A memory that
// cites a rule file (<config>/rules/x.md) by name is not dangling, and an
// index link that leaves the store is live when its file exists.
{
    const rulesDir = path.join(CONFIG, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'backup-protocol.md'), '# Backup protocol\n');
    const globalDir = path.join(CONFIG, 'memory');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'stray.md'), mem('stray', 'not indexed', 'Body about kilns.'));
    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'),
        '- [Map](credentials-map.md) — x\n- [Backup](../rules/backup-protocol.md) — rule\n- [Gone](../rules/nope.md) — dead\n');
    makeProject('rulelink', { 'a.md': mem('cites', 'x', 'Follow [[backup-protocol]] and [[no-such-rule]].') },
        '- [A](a.md) — x\n');
    const r = spawnSync(process.execPath, [AUDIT, '--json'], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG }, maxBuffer: 32 * 1024 * 1024,
    });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* leave null */ }
    const g = j && j.global;
    const gd = (kind) => (g ? g.findings.filter((f) => f.kind === kind).map((f) => f.detail) : []);
    check('the global store is audited', !!g && g.memoryCount === 2);
    check('  an unindexed global memory is reported', gd('unindexed').some((d) => d.startsWith('stray.md')));
    check('  an index link out of the store to an existing file is not dead',
        !gd('dead-index-link').some((d) => d.includes('backup-protocol')));
    check('  one to a missing file still is', gd('dead-index-link').some((d) => d.includes('nope.md')));
    const p = j && forProject(j.projects, 'rulelink');
    const dangling = p ? p.findings.filter((f) => f.kind === 'dangling-link').map((f) => f.detail) : [];
    check('a [[link]] naming a rule file is not dangling', !!p && !dangling.some((d) => d.includes('backup-protocol')));
    check('  a [[link]] naming no rule still is', dangling.some((d) => d.includes('no-such-rule')));
}

// ──────── 8d. a renamed memory keeps its old name as an alias
//
// `aliases: old-name, older` in a memory's frontmatter makes [[old-name]]
// resolve, in its own store and from a project store citing a global memory.
// An alias that is another memory's name is reported: one name, two files.
{
    const globalDir = path.join(CONFIG, 'memory');
    fs.writeFileSync(path.join(globalDir, 'renamed-global.md'),
        '---\nname: renamed-global\ndescription: x\naliases: [old-global]\n---\n\nBody about glazes.\n');
    makeProject('aliases', {
        'new.md': '---\nname: new-name\ndescription: x\naliases: old-name, "older-name"\n---\n\nBody about wheels.\n',
        'b.md': mem('cites-old', 'x', 'See [[old-name]], [[older-name]], [[old-global]] and [[never-was]].'),
        'c.md': '---\nname: clash\ndescription: x\naliases: cites-old\n---\n\nBody about clay.\n',
    }, '- [N](new.md) — x\n- [B](b.md) — x\n- [C](c.md) — x\n');
    const p = forProject(run(), 'aliases');
    const of = (kind) => (p ? p.findings.filter((f) => f.kind === kind).map((f) => f.detail) : []);
    check('an alias resolves a [[link]] to the old name', !!p && !of('dangling-link').some((d) => d.includes('[[old-name]]')));
    check('  a quoted alias in the list resolves too', !!p && !of('dangling-link').some((d) => d.includes('[[older-name]]')));
    check('  a global memory\'s alias resolves from a project', !!p && !of('dangling-link').some((d) => d.includes('[[old-global]]')));
    check('  a name nobody carries is still dangling', of('dangling-link').some((d) => d.includes('[[never-was]]')));
    check('  an alias that is another memory\'s name is reported',
        of('alias-collision').some((d) => d.includes('cites-old') && d.includes('c.md')));
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

// ─────────────────────────────── 11. the human report, which --json never reaches
{
    const textConfig = path.join(TMP, 'textconfig');
    const dirtyDir = path.join(TMP, 'textdirty');
    const cleanDir = path.join(TMP, 'textclean');
    fs.mkdirSync(dirtyDir, { recursive: true });
    fs.mkdirSync(cleanDir, { recursive: true });
    const store = (dir, files) => {
        const memDir = path.join(textConfig, 'projects', slugFor(dir), 'memory');
        fs.mkdirSync(memDir, { recursive: true });
        for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(memDir, file), body);
    };
    store(dirtyDir, {
        'MEMORY.md': '- [a](a.md) — a\n',
        'a.md': mem('a', 'a memory', 'Links [[gap-one]], [[gap-two]], [[gap-three]], [[gap-four]], [[gap-five]], [[gap-six]].'),
        'b.md': mem('b', 'a memory missing from the index', 'Body.'),
    });
    store(cleanDir, { 'MEMORY.md': '- [c](c.md) — c\n', 'c.md': mem('c', 'a clean memory', 'Body.') });
    const r = spawnSync(process.execPath, [AUDIT], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: textConfig } });
    check('the text report exits 0', r.status === 0);
    check('  and groups findings under their kind, with a count', /^ {4}\S.* \(\d+\)$/m.test(r.stdout));
    check('  and caps a long kind at four details', /· …and 2 more/.test(r.stdout));
    check('  and caps the gap list, most cited first', /gaps to write, most cited first: \[\[gap-\w+\]\] ×1,.*…1 more/.test(r.stdout));
    check('  and marks the clean store clean', /✓ clean/.test(r.stdout));
    check('  and says how many stores need attention', /1 store\(s\) need attention/.test(r.stdout));
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
