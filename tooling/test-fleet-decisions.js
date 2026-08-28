#!/usr/bin/env node
'use strict';
// Suite for fleet-decisions.js.
//
// The case it exists for: a SECOND session recording on a subject a FIRST one
// already decided must be refused and shown the prior entry. A log that accepts
// both and lets a reader notice later is the per-repo DECISIONS.md failure again
// with extra steps — [measured 2026-08-28] two sessions wrote opposite pricing
// decisions into one file on two unpushed branches and neither saw the other.
//
// CLAUDE_CONFIG_DIR is the seam; the developer's own fleet log is never touched.
//
// Run: node tooling/test-fleet-decisions.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-decisions.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-decisions-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 300) : ''));
}

let n = 0;
function freshCfg() {
    const c = path.join(ROOT, 'cfg-' + (n++));
    fs.mkdirSync(c, { recursive: true });
    return c;
}

function run(cfg, argv) {
    return spawnSync(process.execPath, [SUBJECT].concat(argv), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cfg }),
    });
}

const rec = (cfg, extra) => run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
    '--decision', 'd', '--author', 'a'].concat(extra || []));

// ------------------------------------------------------------- the refusals

{
    const cfg = freshCfg();
    check('--record without --repo refused',
        run(cfg, ['--record', '--subject', 's', '--decision', 'd', '--author', 'a']).status === 2);
    check('--record without --subject refused',
        run(cfg, ['--record', '--repo', 'r', '--decision', 'd', '--author', 'a']).status === 2);
    check('--record without --decision refused',
        run(cfg, ['--record', '--repo', 'r', '--subject', 's', '--author', 'a']).status === 2);
    // Author is the one that makes a decision arguable. Unsigned decisions are
    // what nobody can push back on, which is how a collision becomes permanent.
    const r = run(cfg, ['--record', '--repo', 'r', '--subject', 's', '--decision', 'd']);
    check('--record without --author refused', r.status === 2);
    check('and it says why an author matters', /argued with/.test(r.stderr || ''), r.stderr);
    check('--check without --subject refused', run(cfg, ['--check', '--repo', 'r']).status === 2);
    check('no verb at all is refused', run(cfg, []).status === 2);
}

// ------------------------------------------------- THE CASE THIS EXISTS FOR

{
    const cfg = freshCfg();
    check('first record succeeds', rec(cfg).status === 0);

    const r = run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
        '--decision', 'the opposite', '--author', 'other-session']);
    check('a SECOND author on the same subject is REFUSED', r.status === 3, 'status ' + r.status);
    check('and is shown the prior decision, not just told one exists',
        /by a\b/.test(r.stderr || '') && /\bd\b/.test(r.stderr || ''), r.stderr);
    // Whitespace-normalised: the message wraps, so "owns the product" spans a
    // newline and a line-oriented regex returns 0 against text that is plainly
    // there. This suite hit that on its first run; it is the same trap the brain
    // rules record for prose in rules files.
    const flat = (r.stderr || '').replace(/\s+/g, ' ');
    check('and is told not to settle it by writing a later line',
        /owns the product/.test(flat), flat);

    // The SAME author revising their own decision is not a collision.
    check('the same author may record again', rec(cfg).status === 0);

    // --force is the deliberate override, for a peer that agrees.
    const f = run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
        '--decision', 'agreeing', '--author', 'other-session', '--force']);
    check('--force lets a second author record deliberately', f.status === 0, f.stderr);
}

{
    // Scoping: a different REPO is not a collision, or every repo sharing a topic
    // name would block the others.
    const cfg = freshCfg();
    rec(cfg);
    const r = run(cfg, ['--record', '--repo', 'other-repo', '--subject', 'ai-pricing',
        '--decision', 'x', '--author', 'b']);
    check('the same subject in a DIFFERENT repo is not a collision', r.status === 0, r.stderr);
}

{
    // Normalisation. A key that is easy to miss by punctuation detects nothing —
    // two sessions will never type the same casing.
    const cfg = freshCfg();
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'AI Pricing', '--decision', 'd', '--author', 'a']);
    const r = run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
        '--decision', 'opposite', '--author', 'b']);
    check('"AI Pricing" and "ai-pricing" collide', r.status === 3, r.stderr);
    const c = run(cfg, ['--check', '--repo', 'qr', '--subject', 'ai   pricing']);
    check('and --check normalises the same way', /1 prior decision/.test(c.stdout || ''), c.stdout);
}

// ------------------------------------------------------- check / list / absence

{
    const cfg = freshCfg();
    const r = run(cfg, ['--check', '--repo', 'qr', '--subject', 'anything']);
    check('--check on an empty log exits 0', r.status === 0);
    check('--check says the absence is real, not an unread file',
        /real absence/.test(r.stdout || ''), r.stdout);
}

{
    const cfg = freshCfg();
    rec(cfg);
    const r = run(cfg, ['--check', '--repo', 'qr', '--subject', 'something-else']);
    // The honest caveat: this only knows what was RECORDED. Absence here is
    // weaker evidence than presence, and saying so stops a reader treating a
    // clean --check as proof nobody is working on it.
    check('--check on an unseen subject warns that absence is weak evidence',
        /weaker evidence/.test(r.stdout || ''), r.stdout);
}

{
    // --list must surface contested subjects rather than leave them to be spotted
    // in a wall of entries. That surfacing IS the product.
    const cfg = freshCfg();
    rec(cfg);
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing', '--decision', 'z', '--author', 'b', '--force']);
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'quiet-topic', '--decision', 'q', '--author', 'a']);
    const r = run(cfg, ['--list']);
    check('--list flags subjects with more than one author',
        /decided by MORE THAN ONE session/.test(r.stdout || ''), r.stdout);
    check('--list names the contested subject', /qr\/ai-pricing/.test(r.stdout || ''), r.stdout);
    check('--list does NOT flag the single-author subject as contested',
        !/quiet-topic\s+\(\d+ authors\)/.test(r.stdout || ''), r.stdout);
    check('--list prints the population it scanned', /population: 3/.test(r.stdout || ''), r.stdout);
}

{
    // One malformed line must not blind the rest — a log is append-only from
    // several writers, so a torn write is a question of when, not if.
    const cfg = freshCfg();
    rec(cfg);
    const log = path.join(cfg, 'fleet', 'DECISIONS.jsonl');
    fs.appendFileSync(log, '{ torn write\n', 'utf8');
    run(cfg, ['--record', '--repo', 'qr', '--subject', 'later', '--decision', 'l', '--author', 'a']);
    const r = run(cfg, ['--list']);
    check('a torn line is skipped and the rest still read',
        /population: 2/.test(r.stdout || ''), r.stdout);
    check('and the collision check still works past it',
        run(cfg, ['--record', '--repo', 'qr', '--subject', 'ai-pricing',
            '--decision', 'x', '--author', 'zz']).status === 3);
}

// -------------------------------------------------------------------- report

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`fleet-decisions: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exit(1);
}
console.log(`fleet-decisions: ${passed}/${total} passed — the collision refusal, scoping, normalisation, and a torn log`);
