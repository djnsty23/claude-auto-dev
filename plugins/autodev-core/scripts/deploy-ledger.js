#!/usr/bin/env node
'use strict';

// deploy-ledger.js — what changed since the last production push, which user
// -facing surfaces it touches, and whether each was actually checked.
//
// The problem this exists for: the verification discipline is written down in
// several skills and enforced by nothing. "Screenshot at 390 and 414" is prose,
// a human decides which screens were affected, and a deploy can be called
// verified with no record of what was looked at. A rule with no gate is a rule
// that gets skipped, and the surface most likely to be skipped is the one
// nobody remembered was touched.
//
// Three commands, and they are deliberately separate:
//
//   --since <ref>   list the commits and touched surfaces since a ref
//   --write         create or refresh the ledger file, preserving ticks
//   --verify        exit 1 if any surface has an unchecked box
//
// It derives the surface list from the diff. It does NOT decide whether a check
// passed: a human or a browser-driving agent fills the boxes, and --verify only
// asks whether they are filled. A checker that both generates and satisfies its
// own checklist proves nothing, which is the failure mode this repo has spent a
// lot of rounds on.
//
// KNOWN LIMITS, printed on every run:
//   * Route derivation is convention-based (app/, pages/, src/routes/, and a
//     components heuristic). A project that routes some other way gets its
//     files listed without a route, which is honest rather than wrong.
//   * A file can affect a surface it does not name — a shared token file, a
//     global stylesheet, a layout. Those are reported as WIDE, meaning every
//     surface is potentially affected, because guessing narrower would be a
//     false all-clear.
//   * Metrics are not derived. There is a metrics section and it must be
//     filled or explicitly waived; nothing here knows which metrics matter.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const LEDGER = path.join(ROOT, 'DEPLOY-LEDGER.md');

const git = (...args) => {
    try {
        return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------- the ref

// A deploy ref must be DETERMINED, never assumed. If it cannot be, this refuses
// rather than silently diffing against something arbitrary and reporting a
// surface list that describes the wrong window.
function resolveSince(explicit) {
    if (explicit) {
        if (git('rev-parse', '--verify', explicit + '^{commit}')) return { ref: explicit, how: 'given on the command line' };
        return { ref: null, how: `COULD NOT RESOLVE the ref "${explicit}"` };
    }
    const marker = path.join(ROOT, '.claude', 'last-deploy');
    if (fs.existsSync(marker)) {
        const ref = fs.readFileSync(marker, 'utf8').trim();
        if (ref && git('rev-parse', '--verify', ref + '^{commit}')) {
            return { ref, how: 'read from .claude/last-deploy' };
        }
    }
    const tag = git('describe', '--tags', '--abbrev=0');
    if (tag) return { ref: tag, how: 'most recent tag' };
    return { ref: null, how: 'no --since, no .claude/last-deploy, no tags' };
}

// ------------------------------------------------------------- the surfaces

const UI_EXT = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|astro)$/i;
// A change here can move any screen, so narrowing it would be a false
// all-clear. Named WIDE in the output for exactly that reason.
const WIDE = /(^|\/)(tailwind\.config|globals?\.css|theme|tokens?|layout|_app|_document|providers?)\b/i;

function routeFor(file) {
    const m = file.match(/(?:^|\/)(?:app|pages|src\/routes|routes)\/(.+)$/);
    if (!m) return null;
    let r = '/' + m[1]
        .replace(/\.(tsx|jsx|ts|js|vue|svelte|astro)$/i, '')
        // (?:^|\/) because these replacements run on the segment BEFORE the
        // leading slash is prepended. Requiring the slash meant `page` never
        // matched, so app/page.tsx resolved to `/page` instead of `/` -- caught
        // by the selftest on its first run, which is what it is for.
        .replace(/(?:^|\/)(page|index|route|\+page|\+layout)$/i, '')
        .replace(/\(([^)]+)\)\//g, '');           // route groups are not path segments
    r = r.replace(/\/+/g, '/');
    return r === '/' ? '/' : r.replace(/\/$/, '');
}

function surfaces(sinceRef) {
    const raw = git('diff', '--name-only', `${sinceRef}..HEAD`);
    if (raw === null) return null;
    const files = raw.split('\n').filter(Boolean);
    const ui = files.filter((f) => UI_EXT.test(f));
    const wide = ui.filter((f) => WIDE.test(f));
    const routed = new Map();
    for (const f of ui) {
        const r = routeFor(f);
        if (!r) continue;
        if (!routed.has(r)) routed.set(r, []);
        routed.get(r).push(f);
    }
    const unrouted = ui.filter((f) => !routeFor(f) && !WIDE.test(f));
    return { files, ui, wide, routed, unrouted };
}

// ------------------------------------------------------------- the ledger

const ROW = (label, detail) =>
    `| ${label} | ${detail} | [ ] | [ ] | [ ] | [ ] | [ ] |`;

function render(sinceRef, how, s, commits, previous) {
    // Preserve ticks a human already made, keyed on the row label. A regenerate
    // that silently unchecks everything trains people to regenerate less often,
    // and a stale ledger is worse than a noisy one.
    const kept = new Map();
    for (const line of (previous || '').split('\n')) {
        const m = line.match(/^\| (`[^`]+`|WIDE[^|]*|[^|]+?) \|[^|]*\|(.*)$/);
        if (m && /\[[xX]\]/.test(m[2])) kept.set(m[1].trim(), line);
    }
    const row = (label, detail) => kept.get(label) || ROW(label, detail);

    const lines = [];
    lines.push('# Deploy ledger');
    lines.push('');
    lines.push(`Generated from \`${sinceRef}..HEAD\` (${how}). Regenerate with`);
    lines.push('`node plugins/autodev-core/scripts/deploy-ledger.js --write`; existing ticks are kept.');
    lines.push('');
    lines.push(`**${commits.length} commit(s)** touching **${s.files.length} file(s)**, of which `
        + `**${s.ui.length}** can change what a user sees.`);
    lines.push('');
    lines.push('## Surfaces to check before this deploy is verified');
    lines.push('');
    lines.push('Each row needs a REAL run, not a reading of the diff. Console and network');
    lines.push('are read on the same visit as the viewport checks.');
    lines.push('');
    lines.push('| surface | changed files | desktop | 390 | 414 | console clean | network clean |');
    lines.push('|---|---|---|---|---|---|---|');
    if (s.wide.length) {
        lines.push(row('WIDE (every surface)', s.wide.map((f) => `\`${f}\``).join('<br>')));
    }
    for (const [r, files] of [...s.routed].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(row('`' + r + '`', files.map((f) => `\`${f}\``).join('<br>')));
    }
    for (const f of s.unrouted) {
        lines.push(row('`' + f + '`', 'no route derived — check wherever it renders'));
    }
    if (!s.ui.length) lines.push('| _none_ | no user-facing file changed in this window | n/a | n/a | n/a | n/a | n/a |');
    lines.push('');
    lines.push('## Metrics');
    lines.push('');
    lines.push('Nothing here derives metrics. Name the ones this deploy could move, with a');
    lines.push('before value and an after value, or write WAIVED and why. An empty section');
    lines.push('fails `--verify`.');
    lines.push('');
    lines.push('- [ ] metrics recorded or waived:');
    lines.push('');
    lines.push('## Commits in this window');
    lines.push('');
    for (const c of commits) lines.push(`- ${c}`);
    lines.push('');
    return lines.join('\n');
}

// ------------------------------------------------------------- the commands

function population(s, sinceRef, how) {
    console.log(`[population] ${sinceRef}..HEAD (${how}): ${s.files.length} file(s) changed, `
        + `${s.ui.length} user-facing, ${s.routed.size} route(s) derived, `
        + `${s.wide.length} wide-effect, ${s.unrouted.length} without a route`);
    console.log('[scope] routes are derived by convention (app/, pages/, src/routes/); a project '
        + 'routing otherwise lists files without a route. A wide-effect file marks EVERY surface '
        + 'affected rather than guessing narrower. Metrics are never derived.');
}

function main() {
    const argv = process.argv.slice(2);
    const sinceIdx = argv.indexOf('--since');
    const explicit = sinceIdx >= 0 ? argv[sinceIdx + 1] : null;

    if (argv.includes('--selftest')) return selftest();

    if (!git('rev-parse', '--git-dir')) {
        console.error('COULD NOT READ: not a git repository. The probe is blind, not the deploy clean.');
        process.exit(2);
    }

    const { ref, how } = resolveSince(explicit);
    if (!ref) {
        console.error(`COULD NOT DETERMINE the last deploy (${how}).`);
        console.error('This is NOT "nothing changed". Pass --since <ref>, or write one to');
        console.error('.claude/last-deploy, or tag your deploys.');
        process.exit(2);
    }

    const s = surfaces(ref);
    if (!s) {
        console.error(`COULD NOT DIFF ${ref}..HEAD. The probe is blind, not the tree clean.`);
        process.exit(2);
    }
    const commits = (git('log', '--oneline', `${ref}..HEAD`) || '').split('\n').filter(Boolean);

    if (argv.includes('--verify')) {
        if (!fs.existsSync(LEDGER)) {
            console.error('COULD NOT VERIFY: no DEPLOY-LEDGER.md. Run --write first.');
            process.exit(2);
        }
        const text = fs.readFileSync(LEDGER, 'utf8');
        const unchecked = text.split('\n').filter((l) => /^\|/.test(l) && /\[ \]/.test(l));
        const metrics = /- \[[xX]\] metrics recorded or waived:\s*\S/.test(text);
        population(s, ref, how);
        console.log(`[verify] ${unchecked.length} row(s) with an unchecked box; `
            + `metrics ${metrics ? 'recorded' : 'NOT recorded'}`);
        if (unchecked.length || !metrics) {
            for (const l of unchecked) console.log('  UNCHECKED  ' + l.split('|')[1].trim());
            if (!metrics) console.log('  UNCHECKED  metrics');
            process.exit(1);
        }
        console.log('[verify] every surface in this window has been checked');
        return;
    }

    population(s, ref, how);
    if (argv.includes('--write')) {
        const previous = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : null;
        fs.writeFileSync(LEDGER, render(ref, how, s, commits, previous), 'utf8');
        console.log(`[write] ${path.relative(ROOT, LEDGER)} updated`
            + (previous ? ' (existing ticks preserved)' : ''));
        return;
    }
    for (const [r, files] of s.routed) console.log(`  ${r}  <- ${files.join(', ')}`);
    for (const f of s.unrouted) console.log(`  (no route)  ${f}`);
    for (const f of s.wide) console.log(`  WIDE  ${f}`);
}

// ------------------------------------------------------------- the selftest

function selftest() {
    const cases = [
        ['app/page.tsx', '/'],
        ['app/settings/page.tsx', '/settings'],
        ['src/routes/+page.svelte', '/'],
        ['pages/about.tsx', '/about'],
        ['app/(marketing)/pricing/page.tsx', '/pricing'],
        ['lib/util.ts', null],
        ['components/Button.tsx', null],
    ];
    let failed = 0;
    for (const [file, want] of cases) {
        const got = routeFor(file);
        const ok = got === want;
        if (!ok) failed++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${file} -> ${got}${ok ? '' : ` (want ${want})`}`);
    }
    // A negative that is impossible by construction rather than merely absent:
    // a file under no routing directory can never yield a route.
    const wideCases = [['tailwind.config.js', true], ['app/globals.css', true], ['app/page.tsx', false]];
    for (const [file, want] of wideCases) {
        const ok = WIDE.test(file) === want;
        if (!ok) failed++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  WIDE(${file}) === ${want}`);
    }
    const total = cases.length + wideCases.length;
    console.log(`[selftest] ${total} case(s) run, ${total - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main();
