#!/usr/bin/env node
'use strict';
/**
 * skill-dispositions.js - is every skill on disk given a deliberate disposition?
 *
 * docs/skill-dispositions.json holds one entry per skill in plugins/<plugin>/skills:
 * retain, merge or retire, with the measured evidence and a reason. Every
 * entry is proposed until Andy decides the batch. This module reads the
 * manifest against the tree and answers three questions:
 *
 *   1. Inventory: is every skill on disk classified, and does every entry
 *      name a skill that exists? A merge names its host (mergeInto) and a
 *      retire names what covers its job (coveredBy), because a zero fire
 *      count alone never decides.
 *   2. Orphans: does any shipped file, or the manifest itself, point at a
 *      skill that is not on disk?
 *   3. Drills: are the emergency and rare-by-design skills retained?
 *
 *   node tooling/skill-dispositions.js [--json]   print the classification
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readCorpus } = require('./skill-router.js');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'docs', 'skill-dispositions.json');
const DISPOSITIONS = new Set(['retain', 'merge', 'retire']);
const STATUSES = new Set(['proposed', 'decided']);
// Shipped-tree files that may name a skill. tooling/ is left out on purpose:
// its suites plant names of skills that do not exist, as controls.
const SCANNED = [/^plugins\//, /^(README|AGENTS|CLAUDE|MIGRATION)\.md$/, /^docs\/commands\.md$/];
const TEXT = /\.(md|js|mjs|cjs|json|ya?ml|sh|ps1|txt)$/;
const NAME = '([a-z0-9][a-z0-9-]*[a-z0-9])(?![\\w*-])';

/** Skills on disk, as plugin/name rows. */
function inventory(pluginsDir = path.join(ROOT, 'plugins')) {
    return readCorpus(pluginsDir).map((s) => ({ plugin: s.plugin, name: s.name, invocable: s.invocable }));
}

/** Agent names per plugin: an autodev-core:<name> reference may name an agent. */
function agents(pluginsDir = path.join(ROOT, 'plugins')) {
    const out = [];
    for (const plugin of fs.readdirSync(pluginsDir)) {
        const dir = path.join(pluginsDir, plugin, 'agents');
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) out.push({ plugin, name: f.slice(0, -3) });
    }
    return out;
}

function readManifest(file = MANIFEST) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every reason an entry or the inventory is not fully classified. */
function classify(inv, manifest) {
    const problems = [];
    const entries = Array.isArray(manifest.skills) ? manifest.skills : [];
    const key = (p, n) => `${p}/${n}`;
    const onDisk = new Set(inv.map((s) => key(s.plugin, s.name)));
    const names = new Set(inv.map((s) => s.name));
    const seen = new Set();
    for (const e of entries) {
        const k = key(e.plugin, e.name);
        if (seen.has(k)) problems.push(`${k}: listed twice`);
        seen.add(k);
        if (!onDisk.has(k)) problems.push(`${k}: no such skill on disk`);
        if (!DISPOSITIONS.has(e.disposition)) problems.push(`${k}: disposition ${JSON.stringify(e.disposition)} is not retain, merge or retire`);
        if (!STATUSES.has(e.status)) problems.push(`${k}: status ${JSON.stringify(e.status)} is not proposed or decided`);
        if (e.status === 'decided' && !e.decidedAt) problems.push(`${k}: a decided entry carries its decidedAt date`);
        if (!e.reason || String(e.reason).trim().length < 20) problems.push(`${k}: no reason`);
        const f = e.evidence && e.evidence.fires30d;
        if (!f || ![f.model, f.typed, f.preload].every((n) => Number.isInteger(n) && n >= 0)) problems.push(`${k}: no measured fire counts`);
        if (e.disposition === 'merge' && (!e.mergeInto || e.mergeInto === e.name || !names.has(e.mergeInto))) problems.push(`${k}: a merge names an existing host other than itself`);
        if (e.disposition === 'retire' && (!e.coveredBy || !String(e.coveredBy).trim())) problems.push(`${k}: a retire names what covers its job`);
    }
    for (const s of inv) if (!seen.has(key(s.plugin, s.name))) problems.push(`${key(s.plugin, s.name)}: on disk and not classified`);
    return { classified: entries.length, onDisk: inv.length, problems };
}

function trackedFiles(root) {
    const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    if (r.status !== 0) throw new Error(`git ls-files exited ${r.status}`);
    return r.stdout.split('\0').filter(Boolean);
}

/**
 * References to a skill that is not on disk. Four forms can only name a skill:
 * plugins/<plugin>/skills/<name>, ${CLAUDE_PLUGIN_ROOT}/skills/<name> (resolved
 * in the referring file's own plugin), <plugin>:<name> (a skill or an agent),
 * and Skill('<name>'). The manifest's own mergeInto and coveredBy count too.
 */
function orphanReferences(root, inv, agentRows, manifest, files = null) {
    const has = (plugin, name) => inv.some((s) => s.name === name && (!plugin || s.plugin === plugin));
    const hasAgent = (plugin, name) => agentRows.some((a) => a.plugin === plugin && a.name === name);
    const list = (files || trackedFiles(root)).filter((f) => SCANNED.some((re) => re.test(f)) && TEXT.test(f));
    const hits = [];
    for (const f of list) {
        let text;
        try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
        const own = (f.match(/^plugins\/([^/]+)\//) || [])[1] || null;
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
            const at = `${f}:${i + 1}`;
            for (const m of line.matchAll(new RegExp(`plugins/(autodev-[a-z]+)/skills/${NAME}`, 'g'))) if (!has(m[1], m[2])) hits.push({ at, ref: `${m[1]}/${m[2]}` });
            for (const m of line.matchAll(new RegExp(`\\$\\{CLAUDE_PLUGIN_ROOT\\}/skills/${NAME}`, 'g'))) if (!has(own, m[1])) hits.push({ at, ref: `${own || '*'}/${m[1]}` });
            for (const m of line.matchAll(new RegExp(`\\b(autodev-(?:core|memory|stack)):${NAME}`, 'g'))) if (!has(m[1], m[2]) && !hasAgent(m[1], m[2])) hits.push({ at, ref: `${m[1]}:${m[2]}` });
            for (const m of line.matchAll(/Skill\(\s*['"]([a-z0-9:-]+)['"]/g)) {
                const parts = m[1].split(':');
                const name = parts.pop();
                if (!has(parts[0] || null, name)) hits.push({ at, ref: `Skill(${m[1]})` });
            }
        });
    }
    for (const e of (manifest && manifest.skills) || []) {
        // coveredBy is prose (it may name a built-in), so only a merge host is a reference.
        if (e.mergeInto && !has(e.plugin, e.mergeInto)) hits.push({ at: `manifest:${e.name}.mergeInto`, ref: e.mergeInto });
    }
    return { scanned: list.length, hits };
}

/** Every required drill exists, is flagged as a drill, and is retained. */
function drillsRetained(inv, manifest, required) {
    const byName = new Map(((manifest && manifest.skills) || []).map((e) => [e.name, e]));
    const problems = [];
    for (const name of required) {
        const e = byName.get(name);
        if (!inv.some((s) => s.name === name)) problems.push(`${name}: drill not on disk`);
        else if (!e) problems.push(`${name}: drill not in the manifest`);
        else if (e.disposition !== 'retain') problems.push(`${name}: drill proposed for ${e.disposition}`);
        else if (e.drill !== true) problems.push(`${name}: not flagged as a drill`);
    }
    for (const e of (manifest && manifest.skills) || []) {
        if (e.drill === true && e.disposition !== 'retain') problems.push(`${e.name}: flagged drill but proposed for ${e.disposition}`);
    }
    return { required: required.length, problems, verdict: required.length && !problems.length ? 'PASS' : 'FAIL' };
}

// ---------- hooks and rules: why each one exists ----------
// Every harness piece names the model weakness or the harness gap it exists
// for, so a model upgrade can ask whether that reason still holds. A "model"
// reason carries a retest: what to observe on the new model. A "harness"
// reason (a Claude Code or OS gap) does not change with the model. The retest
// report lists them. It retires nothing: a retire is Andy's decision.
const KINDS = new Set(['model', 'harness']);
const BECAUSE_MIN = 20;
const BECAUSE_MAX = 200;

/** Hook files wired in plugins/<plugin>/hooks/hooks.json, with their events. */
function wiredHooks(pluginsDir = path.join(ROOT, 'plugins')) {
    const byKey = new Map();
    for (const plugin of fs.readdirSync(pluginsDir).sort()) {
        const hj = path.join(pluginsDir, plugin, 'hooks', 'hooks.json');
        if (!fs.existsSync(hj)) continue;
        const hooks = JSON.parse(fs.readFileSync(hj, 'utf8')).hooks || {};
        for (const [event, groups] of Object.entries(hooks)) {
            for (const g of groups || []) {
                for (const h of g.hooks || []) {
                    const m = /hooks[\\/]+([A-Za-z0-9_.-]+\.(?:js|mjs|cjs))/.exec([h.command, ...(h.args || [])].join(' '));
                    if (!m) continue;
                    const key = `${plugin}/${m[1]}`;
                    if (!byKey.has(key)) byKey.set(key, { plugin, file: m[1], events: [] });
                    const ev = g.matcher ? `${event}(${g.matcher})` : event;
                    if (!byKey.get(key).events.includes(ev)) byKey.get(key).events.push(ev);
                }
            }
        }
    }
    return [...byKey.values()];
}

function becauseFault(text) {
    const s = String(text || '').trim();
    if (s.length < BECAUSE_MIN) return 'no because';
    if (s.length > BECAUSE_MAX) return `because is ${s.length} characters, over ${BECAUSE_MAX}`;
    return null;
}

/** Every reason a wired hook has no usable because entry. */
function classifyHooks(wired, manifest) {
    const problems = [];
    const entries = Array.isArray(manifest.hooks) ? manifest.hooks : [];
    const key = (p, f) => `${p}/${f}`;
    const onDisk = new Set(wired.map((h) => key(h.plugin, h.file)));
    const seen = new Set();
    for (const e of entries) {
        const k = key(e.plugin, e.file);
        if (seen.has(k)) problems.push(`${k}: listed twice`);
        seen.add(k);
        if (!onDisk.has(k)) problems.push(`${k}: not wired in any hooks.json`);
        if (!KINDS.has(e.kind)) problems.push(`${k}: kind ${JSON.stringify(e.kind)} is not model or harness`);
        const bf = becauseFault(e.because);
        if (bf) problems.push(`${k}: ${bf}`);
        if (e.kind === 'model' && String(e.retest || '').trim().length < BECAUSE_MIN) problems.push(`${k}: a model reason names its retest`);
    }
    for (const h of wired) if (!seen.has(key(h.plugin, h.file))) problems.push(`${key(h.plugin, h.file)}: wired and has no because`);
    return { wired: wired.length, listed: entries.length, problems };
}

// A rule's reason lives in a sidecar, not in the rule: every byte of an
// always-on rule loads in every session, and that set has a budget. One line
// per rule file: `- <file>.md | model|harness | <because>`.
const SIDECAR_LINE = /^- ([A-Za-z0-9_.-]+\.md) \| (model|harness) \| (.+?)\s*$/;

function readSidecar(file) {
    if (!file || !fs.existsSync(file)) return null;
    const out = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = SIDECAR_LINE.exec(line);
        if (m) out.set(m[1], { kind: m[2], because: m[3] });
    }
    return out;
}

/** Each rules/*.md with its scope and its reason from the sidecar, or null when it has none. */
function rulesBecause(rulesDir, sidecarFile) {
    if (!rulesDir || !fs.existsSync(rulesDir)) return null;
    const side = readSidecar(sidecarFile) || new Map();
    const rows = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort().map((file) => {
        const text = fs.readFileSync(path.join(rulesDir, file), 'utf8');
        // A paths: key in the leading frontmatter makes the rule load only for matching files.
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        const scoped = !!fm && /^paths:/m.test(fm[1]);
        const s = side.get(file);
        return { file, scoped, bytes: Buffer.byteLength(text), kind: s ? s.kind : null, because: s && !becauseFault(s.because) ? s.because : null };
    });
    const stale = [...side.keys()].filter((f) => !rows.some((r) => r.file === f));
    return Object.assign(rows, { stale });
}

/**
 * The retest report for a model bump. `model` is the model now in use. The
 * manifest's `retested` block records the model the reasons were last checked
 * against, so a different model makes the retest due.
 */
function retestReport({ manifest, rulesDir, sidecarFile, model }) {
    const hooks = Array.isArray(manifest.hooks) ? manifest.hooks : [];
    const last = manifest.retested || {};
    const due = !!model && model !== last.model;
    const rules = rulesBecause(rulesDir, sidecarFile);
    const out = [];
    out.push(`Harness retest for ${model || '(model not given)'}: last checked against ${last.model || 'nothing'}${last.at ? ` on ${last.at}` : ''}. ${due ? 'DUE.' : model ? 'Current.' : 'Pass --model to decide.'}`);
    const model_ = hooks.filter((h) => h.kind === 'model');
    out.push('', `Hooks with a model reason (${model_.length}): does the new model still do this?`);
    for (const h of model_) out.push(`  ${h.plugin}/${h.file}: ${h.because}`, `    retest: ${h.retest}`);
    const harness = hooks.filter((h) => h.kind === 'harness');
    out.push('', `Hooks with a harness reason (${harness.length}): unchanged by a model bump.`);
    for (const h of harness) out.push(`  ${h.plugin}/${h.file}: ${h.because}`);
    const missingRules = [];
    if (!rules) out.push('', 'Rules: no rules directory found.');
    else {
        const always = rules.filter((r) => !r.scoped);
        const bytes = always.reduce((n, r) => n + r.bytes, 0);
        out.push('', `Rules (${rules.length}, ${always.length} always-on at ${bytes} bytes): does the new model still need this?`);
        for (const r of rules) {
            if (!r.because) missingRules.push(r.file);
            out.push(`  ${r.file}${r.scoped ? ' (scoped)' : ''}${r.kind ? ` [${r.kind}]` : ''}: ${r.because || 'NO BECAUSE LINE'}`);
        }
        for (const f of rules.stale) out.push(`  ${f}: in the because file, no such rule`);
    }
    out.push('', 'This report retires nothing. Propose a retire with its retest evidence, and apply it only on Andy\'s yes.');
    if (due) out.push(`After the review, set retested.model to ${model} and retested.at to the review date in docs/skill-dispositions.json.`);
    return { text: out.join('\n') + '\n', due, missingRules };
}

function argValue(argv, flag) {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function configDirOrNull() {
    try { return require('../plugins/autodev-core/scripts/claude-paths.js').configDir(); } catch { return null; }
}
function defaultRulesDir() { const c = configDirOrNull(); return c ? path.join(c, 'rules') : null; }
// The lessons skill already holds each rule's incidents and is mirrored with the rules.
function defaultSidecar() { const c = configDirOrNull(); return c ? path.join(c, 'skills', 'lessons', 'references', 'rules-because.md') : null; }

function main(argv) {
    if (argv.includes('--help')) {
        process.stdout.write('Usage: node tooling/skill-dispositions.js [--json]\n'
            + '  Reads docs/skill-dispositions.json against plugins/*/skills and the wired hooks, and prints the classification.\n'
            + '       node tooling/skill-dispositions.js --retest --model <id> [--rules <dir>] [--because-file <file>]\n'
            + '  After a model bump: lists every hook and rule with the reason it exists. Exit 1 when one has no reason.\n'
            + '  Rule reasons are read from <config>/skills/lessons/references/rules-because.md by default.\n');
        return 0;
    }
    const manifest = readManifest();
    if (argv.includes('--retest')) {
        const hc = classifyHooks(wiredHooks(), manifest);
        const r = retestReport({ manifest, rulesDir: argValue(argv, '--rules') || defaultRulesDir(),
            sidecarFile: argValue(argv, '--because-file') || defaultSidecar(), model: argValue(argv, '--model') });
        process.stdout.write(r.text);
        for (const p of hc.problems) process.stdout.write(`  hook problem: ${p}\n`);
        for (const f of r.missingRules) process.stdout.write(`  rule problem: ${f} has no Because: line\n`);
        return hc.problems.length || r.missingRules.length ? 1 : 0;
    }
    const inv = inventory();
    const c = classify(inv, manifest);
    const hc = classifyHooks(wiredHooks(), manifest);
    const counts = {};
    for (const e of manifest.skills) counts[e.disposition] = (counts[e.disposition] || 0) + 1;
    if (argv.includes('--json')) process.stdout.write(JSON.stringify({ inventory: c, hooks: hc, counts }) + '\n');
    else {
        process.stdout.write(`${c.onDisk} skill(s) on disk, ${c.classified} classified ${JSON.stringify(counts)}, ${c.problems.length} problem(s)\n${c.problems.map((p) => `  ${p}\n`).join('')}`);
        process.stdout.write(`${hc.wired} wired hook(s), ${hc.listed} with a because, ${hc.problems.length} problem(s)\n${hc.problems.map((p) => `  ${p}\n`).join('')}`);
    }
    return c.problems.length || hc.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { inventory, agents, readManifest, classify, orphanReferences, drillsRetained, trackedFiles, wiredHooks, classifyHooks, rulesBecause, retestReport, MANIFEST };
