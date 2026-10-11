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
];

// Paths that record history rather than describe the shipped tree.
// docs/commands.md is the live command list, so it is scanned like source.
const HISTORY = [/^CHANGELOG\.md$/, /^docs\/(?!commands\.md$)/, /^\.claude\//, /^tooling\/test-merged-skills\.js$/];

// A name that is also a prd.json field. Each entry is file, name and reason.
const EXEMPT = [
    ['tooling/test-prd-container-class.js', 'sprint', 'names the prd.json `sprint` field, not the skill'],
    ['tooling/test-stop-failure-note.js', 'sprint', 'a regex literal /sprint still active/, not a slash command'],
];

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: !!ok, detail });

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function skillRefPattern(name) {
    const n = esc(name);
    return new RegExp([
        'skills/' + n + '/',
        '`/?' + n + '`',
        'autodev-(?:core|memory|stack):' + n + '\\b',
        '(?:^|[\\s|])/' + n + '\\b',
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
};
for (const m of MERGED) {
    check('control: pattern fires on a planted reference to ' + m.name, skillRefPattern(m.name).test(positives[m.name]));
}
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

const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
const files = ls.status === 0 ? ls.stdout.split('\0').filter(Boolean) : [];
const scanned = files.filter((f) => !HISTORY.some((re) => re.test(f)) && /\.(md|js|mjs|cjs|json|ya?ml|sh|ps1|txt)$/.test(f));
check('population: git ls-files listed tracked files', ls.status === 0 && files.length > 0, files.length + ' tracked');
check('population: at least 300 shipped text files scanned', scanned.length >= 300, scanned.length + ' scanned');
const hits = {};
for (const f of scanned) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const m of MERGED) {
        const re = skillRefPattern(m.name);
        if (!re.test(text)) continue;
        text.split(/\r?\n/).forEach((line, i) => {
            if (EXEMPT.some(([ef, en]) => ef === f && en === m.name)) return;
            if (re.test(line)) (hits[m.name] = hits[m.name] || []).push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 140));
        });
    }
}
for (const m of MERGED) {
    const h = hits[m.name] || [];
    check(m.name + ': no surviving reference as a skill', h.length === 0, h.length + ' hit(s)' + (h.length ? '\n      ' + h.slice(0, 8).join('\n      ') : ''));
}

let failed = 0;
for (const r of results) {
    if (!r.ok) failed++;
    console.log((r.ok ? '  ok   ' : '  FAIL ') + r.label + (r.detail !== undefined ? ' (' + r.detail + ')' : ''));
}
console.log('\npopulation: ' + inv.length + ' user-invocable skill(s), ' + MERGED.length + ' merged name(s), '
    + scanned.length + ' shipped file(s) scanned for references');
console.log(failed ? failed + ' of ' + results.length + ' check(s) failed' : 'all ' + results.length + ' checks passed');
process.exitCode = failed ? 1 : 0;
