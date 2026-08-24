#!/usr/bin/env node
'use strict';
/**
 * Find functions that build the SAME record and disagree about its fields.
 *
 * The incident: fleet-status.js's scanFleet() was extracted from main() so the
 * board server could call it in-process. Heartbeats were added to the
 * EXTRACTION only. main() kept scanning transcripts and never learned about
 * them, so endedCleanly stayed undefined on the CLI path while both stalled
 * branches test === false and === null. `fleet-status --stalled` could not
 * report a stalled session at all — not a check that failed, a check
 * structurally unable to fire.
 *
 * Nothing caught it. The classifier had 121 passing assertions, every one
 * calling it directly with a synthetic object, so no test exercised the wiring
 * that populates those inputs. A classifier test cannot see a feeder that never
 * calls it.
 *
 * The mechanical signature, and the only thing this script looks for: two
 * functions in one file assign to the same record-shaped local, their field
 * sets OVERLAP, and one is a STRICT SUBSET of the other. That is what an
 * extraction looks like after one side has grown a feature the other has not.
 *
 * Deliberately syntactic and deliberately noisy-on-the-side-of-reporting. It
 * cannot know whether a subset is intentional, so it prints the difference and
 * asks a human. Read the list; a hit is a question, not a verdict.
 *
 *   node tooling/find-record-drift.js            scan plugins/
 *   node tooling/find-record-drift.js <file>     scan one file (or a git blob
 *                                                written to a temp path)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIN_OVERLAP = 2;   // one shared field is a coincidence, not a shape

// Backslash-free on purpose: this file has been rewritten by generated patch
// scripts, and escapes do not survive every shell on the way in.
const FN_RE = /^(?:async )?function ([A-Za-z_][A-Za-z0-9_]*)/;
const ASSIGN_RE = /([A-Za-z_][A-Za-z0-9_]*)[.]([A-Za-z_][A-Za-z0-9_]*) *=[^=]/g;

// A local built FROM Object.assign(defaults(), x) or from a spread has a field
// set this parser cannot enumerate, so its `s.f =` lines are a floor, not a
// census, and every comparison against it is a false subset. quota-tripwire's
// loadState is exactly that: `Object.assign(emptyState(), o)` restores armed
// and firedAt without ever writing `s.armed =`.
//
// This must NOT become a blanket skip for Object.assign. fleet-status's main()
// calls Object.assign(rec, index.get(id) || {...}) to MUTATE an existing rec,
// and main() is the known positive this whole script exists to catch. The
// discriminator is whether the variable is DECLARED FROM the merge or merely
// mutated by it.
const OPAQUE_RE = /(?:const|let|var) +([A-Za-z_][A-Za-z0-9_]*) *= *(?:Object[.]assign *[(]|[{] *[.][.][.])/;

function parse(src) {
    const lines = src.split('\n');
    const fns = [];
    let cur = null;
    let depth = 0;
    for (const line of lines) {
        const m = cur ? null : line.match(FN_RE);
        if (m) { cur = { name: m[1], targets: new Map(), opaque: new Set() }; depth = 0; }
        if (!cur) continue;
        const op = line.match(OPAQUE_RE);
        if (op) cur.opaque.add(op[1]);
        let hit;
        ASSIGN_RE.lastIndex = 0;
        while ((hit = ASSIGN_RE.exec(line)) !== null) {
            const [, obj, field] = hit;
            if (obj === 'module' || obj === 'exports' || obj === 'process') continue;
            if (!cur.targets.has(obj)) cur.targets.set(obj, new Set());
            cur.targets.get(obj).add(field);
        }
        for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        if (depth <= 0 && /[}]/.test(line)) { fns.push(cur); cur = null; }
    }
    // Drop opaque locals entirely rather than comparing an incomplete set.
    for (const f of fns) for (const o of f.opaque) f.targets.delete(o);
    if (cur) { for (const o of cur.opaque) cur.targets.delete(o); fns.push(cur); }
    return fns;
}

function findings(file, src) {
    const fns = parse(src);
    const out = [];
    for (let i = 0; i < fns.length; i++) {
        for (let j = 0; j < fns.length; j++) {
            if (i === j) continue;
            for (const [objA, setA] of fns[i].targets) {
                for (const [objB, setB] of fns[j].targets) {
                    const shared = [...setA].filter((f) => setB.has(f));
                    if (shared.length < MIN_OVERLAP) continue;
                    const missing = [...setA].filter((f) => !setB.has(f));
                    if (!missing.length) continue;                       // not a subset
                    if ([...setB].some((f) => !setA.has(f))) continue;   // each has its own: not a subset
                    out.push({
                        file, rich: fns[i].name, poor: fns[j].name,
                        objRich: objA, objPoor: objB,
                        shared: shared.sort(), missing: missing.sort(),
                    });
                }
            }
        }
    }
    return out;
}

const arg = process.argv[2];
const files = [];
if (arg) files.push(path.resolve(arg));
else (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/[.](js|mjs|cjs)$/.test(e.name)) files.push(full);
    }
})(path.join(ROOT, 'plugins'));

const all = [];
let fnCount = 0;
for (const f of files) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    fnCount += parse(src).length;
    all.push(...findings(path.relative(ROOT, f), src));
}

console.log('\n' + files.length + ' file(s) scanned, ' + fnCount + ' named function(s), '
    + all.length + ' subset pair(s) at overlap >= ' + MIN_OVERLAP + '\n');

if (!all.length) {
    console.log('No function in the scanned population builds a strict subset of another.');
    console.log('That is a real zero only if the scan saw your file: pass a path to check one.\n');
    process.exit(0);
}

for (const f of all) {
    console.log('  ' + f.file);
    console.log('      ' + f.rich + '() sets ' + f.objRich + '.{' + f.shared.concat(f.missing).join(', ') + '}');
    console.log('      ' + f.poor + '() sets ' + f.objPoor + '.{' + f.shared.join(', ') + '}');
    console.log('      MISSING from ' + f.poor + '(): ' + f.missing.join(', '));
    console.log('');
}
console.log('A hit is a QUESTION, not a verdict: a subset can be deliberate.');
console.log('Ask whether the poorer function SHOULD set the missing fields, and');
console.log('whether anything downstream tests them for a value it can never see.\n');
process.exit(all.length ? 1 : 0);
