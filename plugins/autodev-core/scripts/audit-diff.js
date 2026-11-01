#!/usr/bin/env node
'use strict';

// audit-diff.js - compare two audit findings files and say what is new, what is
// still open and what is resolved.
//
// WHY. An audit that prints a fresh list every run cannot say whether the last
// run's findings were fixed, so a reader counts the same defect as new each
// time and a resolved one is never confirmed. Doing the comparison in prose
// lets a model skip a finding it does not recognise. This script makes the
// comparison deterministic and refuses a findings file that breaks the audit
// skill's evidence rules, so a number without a probe or a finding without
// evidence cannot reach the report.
//
// FILE SHAPE (`.claude/reports/audit-<YYYY-MM-DD>.json`):
//   { "schema": 1, "date": "YYYY-MM-DD", "revision": "<sha or ref>",
//     "findings": [ { "id": optional stable id, "severity": "P0"|"P1"|"P2",
//                     "file": "path", "line": integer|null,
//                     "title": "short defect", "evidence": "path, URL or command" } ],
//     "checked_clean": [ "what was looked at and found clean" ],
//     "metrics": [ { "name": "...", "value": <any>, "probe": "the command that measured it" } ] }
//
// IDENTITY. A finding is the same finding when its `id` matches, or, without an
// id, when `file` plus the lower-cased `title` match. The line number is not
// part of the key because lines drift between runs. A severity change keeps the
// finding "still open" and is reported as a change.
//
// Usage:
//   node audit-diff.js --curr FILE [--prev FILE | --dir DIR] [--json]
//   node audit-diff.js --selftest
//
// With --dir, the previous run is the newest `audit-*.json` in DIR that sorts
// before the current file's name. No previous run is a first run: every
// finding is new and the output says so. A previous file that exists and does
// not parse is an error, never an empty baseline.
//
// Exit codes: 0 diff produced; 1 the current file breaks the evidence rules;
// 2 usage error, unreadable or unparseable input (indeterminate, never clean).

const fs = require('fs');
const path = require('path');

const SEVERITIES = ['P0', 'P1', 'P2'];

/** Usage text. */
function usage() {
    return [
        'audit-diff.js: new / still open / resolved between two audit findings files.',
        '',
        'Usage: node audit-diff.js --curr FILE [--prev FILE | --dir DIR] [--json]',
        '       node audit-diff.js --selftest',
        '',
        '  --curr FILE  this run\'s findings (.claude/reports/audit-<date>.json)',
        '  --prev FILE  the previous run\'s findings',
        '  --dir DIR    pick the newest audit-*.json in DIR sorting before --curr',
        '  --json       print the diff as JSON',
        '',
        'Exit: 0 diff produced, 1 current file breaks the evidence rules, 2 indeterminate.',
    ].join('\n');
}

/** Stable key for a finding: its id, else file plus normalised title. */
function keyOf(f) {
    if (typeof f.id === 'string' && f.id.trim()) return 'id:' + f.id.trim();
    return 'ft:' + String(f.file).trim() + '|' + String(f.title).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Problems with a parsed findings document, as strings. Empty means valid. */
function validateFindings(doc) {
    const out = [];
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['document is not an object'];
    if (doc.schema !== 1) out.push('schema must be 1');
    if (!Array.isArray(doc.findings)) return out.concat('findings must be an array');
    if (!Array.isArray(doc.checked_clean)) out.push('checked_clean must be an array (an empty list is a claim: say what was checked)');
    const seen = new Set();
    doc.findings.forEach((f, i) => {
        const at = 'findings[' + i + ']';
        if (!f || typeof f !== 'object') { out.push(at + ' is not an object'); return; }
        if (!SEVERITIES.includes(f.severity)) out.push(at + ' severity must be P0, P1 or P2');
        if (typeof f.file !== 'string' || !f.file.trim()) out.push(at + ' needs a file');
        if (!(f.line === null || Number.isInteger(f.line))) out.push(at + ' line must be an integer or null');
        if (typeof f.title !== 'string' || !f.title.trim()) out.push(at + ' needs a title');
        if (typeof f.evidence !== 'string' || !f.evidence.trim()) out.push(at + ' needs evidence (a path, URL or command)');
        if (typeof f.file === 'string' && typeof f.title === 'string' && f.file.trim() && f.title.trim()) {
            const k = keyOf(f);
            if (seen.has(k)) out.push(at + ' duplicates an earlier finding (' + k + ')');
            seen.add(k);
        }
    });
    if (doc.metrics !== undefined) {
        if (!Array.isArray(doc.metrics)) out.push('metrics must be an array');
        else doc.metrics.forEach((m, i) => {
            if (!m || typeof m.name !== 'string' || !m.name.trim()) out.push('metrics[' + i + '] needs a name');
            else if (typeof m.probe !== 'string' || !m.probe.trim()) out.push('metrics[' + i + '] (' + m.name + ') names no probe: a number without a probe is invented');
        });
    }
    return out;
}

/**
 * Diff two valid documents. `prev` null means a first run.
 * Returns { previous, new, still_open, resolved, changed, counts }.
 */
function diffFindings(prev, curr) {
    const before = new Map();
    if (prev) for (const f of prev.findings) before.set(keyOf(f), f);
    const out = { previous: prev ? (prev.date || null) : null, new: [], still_open: [], resolved: [], changed: [] };
    const matched = new Set();
    for (const f of curr.findings) {
        const k = keyOf(f);
        const old = before.get(k);
        if (!old) { out.new.push(f); continue; }
        matched.add(k);
        out.still_open.push(f);
        if (old.severity !== f.severity) out.changed.push({ key: k, title: f.title, from: old.severity, to: f.severity });
    }
    for (const [k, f] of before) if (!matched.has(k)) out.resolved.push(f);
    const bySev = (list) => SEVERITIES.map((s) => s + ':' + list.filter((f) => f.severity === s).length).join(' ');
    out.counts = { new: bySev(out.new), still_open: bySev(out.still_open), resolved: bySev(out.resolved) };
    return out;
}

/** Newest `audit-*.json` in dir whose name sorts before currName, or null. */
function findPrevious(dir, currName) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return null; }
    const older = names.filter((n) => /^audit-.*\.json$/.test(n) && n < currName).sort();
    return older.length ? path.join(dir, older[older.length - 1]) : null;
}

/** Plain-text rendering of a diff. */
function render(d) {
    const line = (f) => '  [' + f.severity + '] ' + f.file + (f.line === null ? '' : ':' + f.line) + ' ' + f.title + ' (evidence: ' + f.evidence + ')';
    const out = [];
    out.push('previous run: ' + (d.previous === null ? 'none (first run, every finding is new)' : d.previous));
    for (const [label, list] of [['NEW', d.new], ['STILL OPEN', d.still_open], ['RESOLVED', d.resolved]]) {
        out.push(label + ' (' + list.length + ')');
        for (const f of list) out.push(line(f));
    }
    for (const c of d.changed) out.push('severity changed: ' + c.title + ' ' + c.from + ' -> ' + c.to);
    out.push('counts: new ' + d.counts.new + ' | still open ' + d.counts.still_open + ' | resolved ' + d.counts.resolved);
    return out.join('\n');
}

/** Read and parse a JSON file; throws an Error whose message names the file. */
function readJson(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error('cannot read ' + file + ' (' + e.code + ')'); }
    try { return JSON.parse(text); } catch (e) { throw new Error(file + ' is not valid JSON'); }
}

/** Parse argv into options; unknown flags and missing values set `error`. */
function parseArgs(argv) {
    const o = { json: false, selftest: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') o.json = true;
        else if (a === '--selftest') o.selftest = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--curr' || a === '--prev' || a === '--dir') {
            if (i + 1 >= argv.length) return { error: a + ' needs a value' };
            o[a.slice(2)] = argv[++i];
        } else return { error: 'unknown argument ' + a };
    }
    return o;
}

/** Run the planted positive and negative; returns an array of failure strings. */
function selftest() {
    const base = (findings) => ({ schema: 1, date: 'x', findings, checked_clean: ['c'] });
    const f = (over) => Object.assign({ severity: 'P1', file: 'a.js', line: 1, title: 'bug', evidence: 'cmd' }, over);
    const fails = [];
    const d = diffFindings(base([f({}), f({ file: 'b.js' })]), base([f({ line: 9 }), f({ file: 'c.js' })]));
    if (d.new.length !== 1 || d.still_open.length !== 1 || d.resolved.length !== 1) fails.push('classification');
    if (validateFindings(base([f({ evidence: '' })])).length !== 1) fails.push('missing evidence not caught');
    if (validateFindings(base([f({})])).length !== 0) fails.push('valid file refused');
    return fails;
}

/** CLI entry. Returns the exit code. */
function main(argv) {
    const o = parseArgs(argv);
    if (o.error) { process.stderr.write('audit-diff: ' + o.error + '\n' + usage() + '\n'); return 2; }
    if (o.help) { process.stdout.write(usage() + '\n'); return 0; }
    if (o.selftest) {
        const fails = selftest();
        process.stdout.write(fails.length ? 'selftest FAIL: ' + fails.join(', ') + '\n' : 'selftest ok\n');
        return fails.length ? 1 : 0;
    }
    if (!o.curr) { process.stderr.write('audit-diff: --curr is required\n' + usage() + '\n'); return 2; }
    let curr;
    let prev = null;
    try {
        curr = readJson(o.curr);
        const prevFile = o.prev || (o.dir ? findPrevious(o.dir, path.basename(o.curr)) : null);
        if (prevFile) prev = readJson(prevFile);
    } catch (e) {
        process.stderr.write('audit-diff: ' + e.message + '\n');
        return 2;
    }
    const problems = validateFindings(curr);
    if (problems.length) {
        process.stderr.write('audit-diff: current file breaks the evidence rules:\n  ' + problems.join('\n  ') + '\n');
        return 1;
    }
    if (prev) {
        const pp = validateFindings(prev);
        if (pp.length) {
            process.stderr.write('audit-diff: previous file is invalid, so it is not a baseline:\n  ' + pp.join('\n  ') + '\n');
            return 2;
        }
    }
    const d = diffFindings(prev, curr);
    process.stdout.write((o.json ? JSON.stringify(d, null, 2) : render(d)) + '\n');
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = { keyOf, validateFindings, diffFindings, findPrevious, render, readJson, parseArgs, main, SEVERITIES };
