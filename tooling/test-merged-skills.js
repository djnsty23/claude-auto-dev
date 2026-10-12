#!/usr/bin/env node
// test-merged-skills: zero-fire skills folded into a fired host stay folded.
//
// `[measured 2026-10-11]` 26 of 49 user-invocable skills never fired over 30
// days and 2,835 transcripts (analyze-skill-invocations.js --days 30). Seven of
// them were merged into a fired skill's references/, so each one leaves the
// skill listing every session pays for. This suite pins three things:
//
//   1. The skill directory is gone, so the inventory no longer counts it.
//   2. Its content survives in the host's references/, and the host SKILL.md
//      points at that file. A merge that drops the pointer is a silent retire.
//   3. Nothing in the shipped tree still names the old skill as a skill: no
//      `skills/<name>/` path, no backticked or slash-command name, no plugin
//      prefix, no Skill('<name>') call. History (CHANGELOG.md, docs/,
//      .claude/) is excluded on purpose: it records what was true then.
//
// The MERGED table is a hand-written literal, not read from the tree, so
// re-adding a skill or deleting a reference cannot shrink the check with it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');

const MERGED = [
    { name: 'iterate', plugin: 'autodev-core', host: 'auto', ref: 'iterate.md' },
    { name: 'wizard', plugin: 'autodev-core', host: 'auto', ref: 'handback.md' },
    { name: 'sprint', plugin: 'autodev-core', host: 'auto', ref: 'sprint.md' },
    { name: 'show-your-work', plugin: 'autodev-core', host: 'prove', ref: 'show-your-work.md' },
    { name: 'mem-dashboard', plugin: 'autodev-memory', host: 'mem-search', ref: 'dashboard.md' },
    { name: 'knowledge-agent', plugin: 'autodev-memory', host: 'mem-search', ref: 'knowledge-brief.md' },
    { name: 'memory-maintenance', plugin: 'autodev-memory', host: 'mem-search', ref: 'maintenance.md' },
    // `[measured 2026-10-12]` the second pass (K1-K8 of .claude/reports/a7-skill-triage.md).
    { name: 'archive-prd', plugin: 'autodev-core', host: 'auto', ref: 'archive-prd.md' },
    { name: 'status', plugin: 'autodev-core', host: 'auto', ref: 'progress.md', generic: true },
    { name: 'test', plugin: 'autodev-core', host: 'prove', ref: 'run-tests.md', generic: true },
    { name: 'scan', plugin: 'autodev-core', host: 'prove', ref: 'live-scan.md' },
    { name: 'fleet', plugin: 'autodev-core', host: 'sessions', ref: 'fleet.md' },
    { name: 'autodev-init', plugin: 'autodev-core', host: 'setup-project', ref: 'conventions.md' },
    { name: 'preflight', plugin: 'autodev-core', host: 'setup-project', ref: 'preflight.md' },
];

// Retired outright: no host, so only the first and third checks apply.
// memory-backup is owned by the backup protocol's own script; remotion had no video work in 30 days.
const RETIRED = [
    { name: 'memory-backup', plugin: 'autodev-memory' },
    { name: 'remotion', plugin: 'autodev-stack' },
];

// Paths that record history rather than describe the shipped tree.
// docs/commands.md is the live command list, so it is scanned like source.
const HISTORY = [/^CHANGELOG\.md$/, /^docs\/(?!commands\.md$)/, /^\.claude\//, /^tooling\/test-merged-skills\.js$/];

// A name that is also a prd.json field. Each entry is file, name and reason.
const EXEMPT = [
    ['tooling/test-brain-panels.js', 'scan', 'a regex literal /scan:/ over panel output'],
    ['tooling/test-superseded.js', 'scan', 'regex literals over the scan header the script prints'],
    ['tooling/test-stop-intent-record.js', 'fleet', 'a regex literal /fleet-intent\\.js/, a script name'],
    ['tooling/test-preflight-template.js', 'preflight', 'a regex literal /preflight: PASS/, the template output'],
    ['plugins/autodev-core/scripts/pr-path-filters.js', 'preflight', 'names the CI workflow called preflight, not the skill'],
    ['plugins/autodev-core/skills/rule-local-first/references/history-2026-09-09.md', 'preflight', 'dated history, true when written'],
    ['tooling/test-prd-container-class.js', 'sprint', 'names the prd.json `sprint` field, not the skill'],
    ['tooling/test-stop-failure-note.js', 'sprint', 'a regex literal /sprint still active/, not a slash command'],
];

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: !!ok, detail });

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A generic name (status, test) is also a CLI verb, a built-in slash command and
// a commit type, so a bare backtick or slash form says nothing about the skill.
// Only the forms that can name nothing else count for those.
function skillRefPattern(name, generic) {
    const n = esc(name);
    return new RegExp([
        'skills/' + n + '/',
        ...(generic ? [] : ['`/?' + n + '`', '(?:^|[\\s|])/' + n + '\\b']),
        'autodev-(?:core|memory|stack):' + n + '\\b',
        'Skill\\(\\s*[\'"]' + n + '[\'"]',
        '\\bthe ' + n + ' skill\\b',
    ].join('|'), 'm');
}

// The inventory rule analyze-skill-invocations.js applies: a SKILL.md whose
// frontmatter does not say `user-invocable: false`.
function inventory() {
    const out = [];
    for (const plugin of fs.readdirSync(PLUGINS)) {
        const dir = path.join(PLUGINS, plugin, 'skills');
        if (!fs.existsSync(dir)) continue;
        for (const skill of fs.readdirSync(dir)) {
            const f = path.join(dir, skill, 'SKILL.md');
            if (!fs.existsSync(f)) continue;
            const fm = (fs.readFileSync(f, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
            if (!/^user-invocable:\s*false/m.test(fm)) out.push(skill);
        }
    }
    return out;
}

// Controls first: the pattern must fire on hand-written references, and must
// not fire on ordinary prose that only uses the word.
const positives = {
    iterate: 'run `iterate` until clean', wizard: 'load `wizard` first',
    sprint: 'see plugins/autodev-core/skills/sprint/SKILL.md',
    'show-your-work': 'type /show-your-work', 'mem-dashboard': 'autodev-memory:mem-dashboard',
    'knowledge-agent': "Skill('knowledge-agent')", 'memory-maintenance': 'the memory-maintenance skill',
    'archive-prd': 'run `archive-prd` first', status: 'autodev-core:status', test: "Skill('test')",
    scan: 'type /scan', fleet: 'plugins/autodev-core/skills/fleet/SKILL.md', 'autodev-init': 'start with `/autodev-init`',
    preflight: 'the preflight skill', 'memory-backup': 'autodev-memory:memory-backup', remotion: 'load `remotion`',
};
for (const m of [...MERGED, ...RETIRED]) {
    check('control: pattern fires on a planted reference to ' + m.name, skillRefPattern(m.name, m.generic).test(positives[m.name]));
}
check('control: a generic name ignores the CLI verb and the built-in', !skillRefPattern('status', true).test('`status` reconstructs it; type /status'));
check('control: pattern ignores prose use of a word', !skillRefPattern('iterate').test('we iterate freely on design'));

const inv = inventory();
check('population: inventory read at least 20 user-invocable skills', inv.length >= 20, inv.length + ' read');
for (const m of MERGED) {
    const gone = !fs.existsSync(path.join(PLUGINS, m.plugin, 'skills', m.name));
    check(m.name + ': skill directory removed', gone);
    check(m.name + ': not in the user-invocable inventory', !inv.includes(m.name));
    const ref = path.join(PLUGINS, m.plugin, 'skills', m.host, 'references', m.ref);
    const body = fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8') : '';
    check(m.name + ': content lives in ' + m.host + '/references/' + m.ref, body.length > 500, body.length + ' bytes');
    const hostMd = path.join(PLUGINS, m.plugin, 'skills', m.host, 'SKILL.md');
    const host = fs.existsSync(hostMd) ? fs.readFileSync(hostMd, 'utf8') : '';
    check(m.name + ': ' + m.host + '/SKILL.md links references/' + m.ref, host.includes('references/' + m.ref));
}
for (const m of RETIRED) {
    check(m.name + ': retired skill directory removed', !fs.existsSync(path.join(PLUGINS, m.plugin, 'skills', m.name)));
    check(m.name + ': not in the user-invocable inventory', !inv.includes(m.name));
}

const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
const files = ls.status === 0 ? ls.stdout.split('\0').filter(Boolean) : [];
const scanned = files.filter((f) => !HISTORY.some((re) => re.test(f)) && /\.(md|js|mjs|cjs|json|ya?ml|sh|ps1|txt)$/.test(f));
check('population: git ls-files listed tracked files', ls.status === 0 && files.length > 0, files.length + ' tracked');
check('population: at least 300 shipped text files scanned', scanned.length >= 300, scanned.length + ' scanned');
const hits = {};
for (const f of scanned) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const m of [...MERGED, ...RETIRED]) {
        const re = skillRefPattern(m.name, m.generic);
        if (!re.test(text)) continue;
        text.split(/\r?\n/).forEach((line, i) => {
            if (EXEMPT.some(([ef, en]) => ef === f && en === m.name)) return;
            if (re.test(line)) (hits[m.name] = hits[m.name] || []).push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 140));
        });
    }
}
for (const m of [...MERGED, ...RETIRED]) {
    const h = hits[m.name] || [];
    check(m.name + ': no surviving reference as a skill', h.length === 0, h.length + ' hit(s)' + (h.length ? '\n      ' + h.slice(0, 8).join('\n      ') : ''));
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.label + (r.detail !== undefined ? ' (' + r.detail + ')' : ''));
}
console.log('\npopulation: ' + inv.length + ' user-invocable skill(s), ' + MERGED.length + ' merged and '
    + RETIRED.length + ' retired name(s), '
    + scanned.length + ' shipped file(s) scanned for references');
console.log(failed ? failed + ' of ' + results.length + ' check(s) failed' : 'all ' + results.length + ' checks passed');
process.exitCode = failed ? 1 : 0;
