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

function main(argv) {
    if (argv.includes('--help')) {
        process.stdout.write('Usage: node tooling/skill-dispositions.js [--json]\n  Reads docs/skill-dispositions.json against plugins/*/skills and prints the classification.\n');
        return 0;
    }
    const inv = inventory();
    const manifest = readManifest();
    const c = classify(inv, manifest);
    const counts = {};
    for (const e of manifest.skills) counts[e.disposition] = (counts[e.disposition] || 0) + 1;
    if (argv.includes('--json')) process.stdout.write(JSON.stringify({ inventory: c, counts }) + '\n');
    else process.stdout.write(`${c.onDisk} skill(s) on disk, ${c.classified} classified ${JSON.stringify(counts)}, ${c.problems.length} problem(s)\n${c.problems.map((p) => `  ${p}\n`).join('')}`);
    return c.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { inventory, agents, readManifest, classify, orphanReferences, drillsRetained, trackedFiles, MANIFEST };
