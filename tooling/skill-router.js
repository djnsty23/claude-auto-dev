#!/usr/bin/env node
'use strict';
/**
 * skill-router.js - a deterministic model of DESCRIPTION routing.
 *
 * What it models: the phrases a skill's description and when_to_use promise to
 * answer to. A scenario routes to every skill whose promised phrase it contains.
 * What it does NOT model: the live model's choice. The model reads the same
 * text, but it weighs it with judgement this file does not have. So a pass here
 * says the descriptions are unambiguous on paper, and a fail says they are not.
 * Live selection is measured by analyze-skill-invocations.js over transcripts.
 *
 * A skill's triggers are:
 *   1. every quoted phrase in its description or when_to_use,
 *   2. every word in an "on the words a, b or c" clause,
 *   3. its own name, with hyphens read as spaces (the slash-command form).
 * A trigger matches a scenario when it appears in it as whole words,
 * ignoring case.
 *
 *   node tooling/skill-router.js "<scenario text>"   print the skills it routes to
 */
const fs = require('fs');
const path = require('path');

const PLUGINS = path.resolve(__dirname, '..', 'plugins');

/** A YAML scalar as the host reads it: double quotes are JSON-like, single quotes double their quote. */
function unquote(v) {
    const s = String(v || '').trim();
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
        try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
    return s;
}

function frontmatter(text) {
    const t = String(text).replace(/\r\n/g, '\n');
    if (!t.startsWith('---')) return null;
    const end = t.indexOf('\n---', 3);
    if (end === -1) return null;
    const out = {};
    let key = null;
    for (const line of t.slice(3, end).split('\n')) {
        if (/^\s*#/.test(line)) continue;
        const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
        if (m) { key = m[1]; out[key] = m[2].trim(); } else if (key && line.trim()) out[key] += ' ' + line.trim();
    }
    for (const k of Object.keys(out)) out[k] = unquote(out[k]);
    return out;
}

function triggersOf(name, description, whenToUse) {
    const text = `${description || ''} ${whenToUse || ''}`;
    const out = new Set();
    for (const m of text.matchAll(/["“]([^"”]{2,60})["”]/g)) out.add(m[1].trim().toLowerCase());
    for (const m of text.matchAll(/\bon the words ([^.;]+)/gi)) {
        for (const w of m[1].split(/,|\bor\b|\band\b/)) if (w.trim()) out.add(w.trim().toLowerCase());
    }
    out.add(String(name).replace(/-/g, ' ').toLowerCase());
    return [...out].filter((t) => t.length >= 2).sort();
}

/** Every SKILL.md under plugins/<plugin>/skills/<name>/, with its triggers. */
function readCorpus(pluginsDir = PLUGINS) {
    const rows = [];
    for (const plugin of fs.readdirSync(pluginsDir).sort()) {
        const dir = path.join(pluginsDir, plugin, 'skills');
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).sort()) {
            const file = path.join(dir, name, 'SKILL.md');
            if (!fs.existsSync(file)) continue;
            const fm = frontmatter(fs.readFileSync(file, 'utf8')) || {};
            rows.push({ plugin, name, invocable: !/^false$/i.test(String(fm['user-invocable'] || '')),
                triggers: triggersOf(name, fm.description, fm.when_to_use) });
        }
    }
    return rows;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function phraseIn(phrase, text) {
    return new RegExp(`(?:^|[^a-z0-9])${esc(phrase).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i').test(text);
}

/** The skills a scenario routes to, sorted by name, each with the trigger that matched. */
function route(corpus, prompt) {
    const hits = [];
    for (const s of corpus) {
        const t = s.triggers.find((p) => phraseIn(p, prompt));
        if (t) hits.push({ name: s.name, trigger: t });
    }
    return hits.sort((a, b) => a.name.localeCompare(b.name));
}

function sameSet(a, b) {
    const x = [...a].sort();
    const y = [...b].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Grade a scenario file against a corpus.
 *   critical: the route set must be exactly [target].
 *   ambiguous: every scenario routing to two or more skills is declared, with the
 *     exact contestant set and a winner inside it. A declaration whose route is
 *     no longer ambiguous is stale, and stale is not explicit.
 *   none: a scenario that must route to nothing.
 */
function grade(corpus, fixture) {
    const declared = new Map((fixture.ambiguous || []).map((a) => [a.id, a]));
    const out = { critical: [], ambiguous: [], none: [], undeclared: [], stale: [] };
    for (const sc of fixture.scenarios || []) {
        const got = route(corpus, sc.prompt).map((h) => h.name);
        const amb = declared.get(sc.id);
        if (amb) {
            const ok = got.length >= 2 && sameSet(got, amb.contestants) && amb.contestants.includes(amb.winner) && !!amb.reason;
            (ok ? out.ambiguous : out.stale).push({ id: sc.id, got, want: amb.contestants, winner: amb.winner, ok });
            continue;
        }
        if (got.length >= 2) out.undeclared.push({ id: sc.id, got });
        if (sc.critical) out.critical.push({ id: sc.id, target: sc.target, got, ok: got.length === 1 && got[0] === sc.target });
        else if (sc.target === null) out.none.push({ id: sc.id, got, ok: got.length === 0 });
    }
    for (const id of declared.keys()) {
        if (!(fixture.scenarios || []).some((s) => s.id === id)) out.stale.push({ id, got: [], ok: false, missing: true });
    }
    const passed = out.critical.filter((c) => c.ok).length;
    out.criticalRate = out.critical.length ? passed / out.critical.length : null;
    out.explicit = out.ambiguous.length > 0 && out.undeclared.length === 0 && out.stale.length === 0;
    return out;
}

/**
 * The negative control: drop each critical scenario's target from the corpus
 * and grade again. Every one of those scenarios must fail. A scenario that
 * still passes with its skill gone proves the grader cannot see a missing skill.
 */
function missingSkillControl(corpus, fixture) {
    const results = [];
    for (const sc of (fixture.scenarios || []).filter((s) => s.critical)) {
        const without = corpus.filter((s) => s.name !== sc.target);
        const g = grade(without, { scenarios: [sc], ambiguous: [] });
        const row = g.critical[0];
        results.push({ id: sc.id, target: sc.target, removed: without.length < corpus.length, stillPasses: !!(row && row.ok) });
    }
    const failedAll = results.length > 0 && results.every((r) => r.removed && !r.stillPasses);
    return { results, verdict: failedAll ? 'FAIL' : 'PASS' };
}

function main(argv) {
    const prompt = argv.filter((a) => !a.startsWith('--')).join(' ');
    if (!prompt || argv.includes('--help')) {
        process.stdout.write('Usage: node tooling/skill-router.js "<scenario text>"\n  Prints the skills whose description triggers the text matches. Description routing only, not live model selection.\n');
        return 0;
    }
    const corpus = readCorpus();
    const hits = route(corpus, prompt);
    process.stdout.write(`${corpus.length} skill(s) read, ${hits.length} matched\n`);
    for (const h of hits) process.stdout.write(`  ${h.name}  (trigger "${h.trigger}")\n`);
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { unquote, frontmatter, triggersOf, readCorpus, route, grade, missingSkillControl, phraseIn, sameSet };
