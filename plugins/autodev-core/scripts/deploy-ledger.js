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
//   --since <ref>   set the previous deployed commit
//   --candidate <ref>  freeze the checked candidate (defaults to current HEAD)
//   --write         refresh the ledger, preserving checks only for the same base and candidate
//   --verify        exit 1 for missing, invalid, unchecked or stale surface records
//
// It derives the surface list from the diff. It does NOT decide whether a check
// passed: a human or a browser-driving agent fills the boxes, and --verify only
// checks their membership, shape and commit window, not whether they are true.
// A checker that both generates and satisfies its
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
        const output = execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
        return args.includes('-z') ? output : output.trim();
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
const RUNTIME_EXT = /\.(?:[cm]?[jt]s|json)$/i;
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

function surfaces(sinceRef, headRef) {
    // NUL separation preserves names containing newlines so they can be reported
    // as unsupported instead of disappearing behind Git's quoted-path display.
    const raw = git('diff', '--name-only', '-z', `${sinceRef}..${headRef}`);
    if (raw === null) return null;
    const files = raw.split('\0').filter(Boolean);
    const ui = files.filter((f) => UI_EXT.test(f) || (RUNTIME_EXT.test(f) && WIDE.test(f)));
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

function expectedRows(s) {
    const rows = [];
    if (s.wide.length) rows.push(['WIDE (every surface)', s.wide.map((f) => `\`${f}\``).join('<br>')]);
    for (const [route, files] of [...s.routed].sort((a, b) => a[0].localeCompare(b[0]))) {
        rows.push(['`' + route + '`', files.map((f) => `\`${f}\``).join('<br>')]);
    }
    for (const file of s.unrouted) rows.push(['`' + file + '`', 'no route derived — check wherever it renders']);
    return rows;
}

function ledgerRows(text) {
    text = text.replace(/\r\n/g, '\n');
    const start = text.indexOf('## Surfaces to check before this deploy is verified\n');
    if (start < 0) return [];
    const end = text.indexOf('\n## ', start + 1);
    return text.slice(start, end < 0 ? undefined : end).split('\n')
        .filter((line) => line.startsWith('|'))
        .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function sameWindow(text, window) {
    const records = [...text.matchAll(/^<!-- deploy-ledger-window: (.+) -->\r?$/gm)];
    if (records.length !== 1) return false;
    try {
        const previous = JSON.parse(records[0][1]);
        return previous.version === 1 && previous.base === window.base && previous.candidate === window.candidate;
    } catch {
        return false;
    }
}

function rowProblems(text, s) {
    const rows = ledgerRows(text);
    const problems = [];
    for (const [label, detail] of expectedRows(s)) {
        const found = rows.filter((cells) => cells[0] === label);
        if (!found.length) problems.push(`MISSING    ${label}`);
        else if (found.length !== 1) problems.push(`DUPLICATE  ${label}`);
        else if (found[0].length !== 7 || found[0][1] !== detail
            || !found[0].slice(2).every((cell) => /^\[[xX]\]$/.test(cell))) {
            problems.push(`INVALID    ${label}: expected changed files and five checked cells`);
        }
    }
    return problems;
}

function render(sinceRef, how, s, commits, previous, window) {
    // Names alone are not evidence identity. Preserve partial checks and metrics
    // only while both resolved commits and the complete row shape stay the same.
    if (!previous || !sameWindow(previous, window)) previous = '';
    const kept = ledgerRows(previous);
    const row = (label, detail) => {
        const found = kept.filter((cells) => cells[0] === label);
        if (found.length !== 1 || found[0].length !== 7 || found[0][1] !== detail
            || !found[0].slice(2).every((cell) => /^\[[ xX]\]$/.test(cell))) return ROW(label, detail);
        return `| ${label} | ${detail} | ${found[0].slice(2).join(' | ')} |`;
    };

    const lines = [];
    lines.push('# Deploy ledger');
    lines.push('');
    lines.push(`<!-- deploy-ledger-window: ${JSON.stringify({ version: 1, ...window })} -->`);
    lines.push(`Generated from \`${window.base}..${window.candidate}\` (${how}). Regenerate with`);
    lines.push('`deploy-ledger.js --write --since <previous-deployed-commit> --candidate <checked-commit>`; checks are kept only for the same resolved base and candidate.');
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
    for (const [label, detail] of expectedRows(s)) lines.push(row(label, detail));
    if (!s.ui.length) lines.push('| _none_ | no user-facing file changed in this window | n/a | n/a | n/a | n/a | n/a |');
    lines.push('');
    lines.push('## Metrics');
    lines.push('');
    lines.push('Nothing here derives metrics. Name the ones this deploy could move, with a');
    lines.push('before value and an after value, or write WAIVED and why. An empty section');
    lines.push('fails `--verify`.');
    lines.push('');
    const metrics = previous.split('\n').find((line) => /^- \[[xX]\] metrics recorded or waived:[^\S\n]*\S/.test(line));
    lines.push(metrics || '- [ ] metrics recorded or waived:');
    lines.push('');
    lines.push('## Commits in this window');
    lines.push('');
    for (const c of commits) lines.push(`- ${c}`);
    lines.push('');
    return lines.join('\n');
}

// ------------------------------------------------------------- the commands

function population(s, window, how, explicitCandidate, checkoutHead) {
    console.log(`[population] ${window.base}..${window.candidate} (${how}): ${s.files.length} file(s) changed, `
        + `${s.ui.length} user-facing, ${s.routed.size} route(s) derived, `
        + `${s.wide.length} wide-effect, ${s.unrouted.length} without a route`);
    console.log(`[window] candidate ${window.candidate} (${explicitCandidate ? 'explicit --candidate' : 'default HEAD'}); checkout HEAD ${checkoutHead}. Checks apply only to candidate ${window.candidate}.`);
    console.log('[scope] routes are derived by convention (app/, pages/, src/routes/); a project '
        + 'routing otherwise lists files without a route. A wide-effect file marks EVERY surface '
        + 'affected rather than guessing narrower. Metrics are never derived.');
}

function main() {
    const argv = process.argv.slice(2);
    const sinceIdx = argv.indexOf('--since');
    const explicit = sinceIdx >= 0 ? argv[sinceIdx + 1] : null;

    const candidateIdx = argv.indexOf('--candidate');
    const candidateRef = candidateIdx >= 0 ? argv[candidateIdx + 1] : 'HEAD';
    if (candidateIdx >= 0 && (!candidateRef || candidateRef.startsWith('-')
        || argv.filter((arg) => arg === '--candidate').length !== 1)) {
        console.error('COULD NOT READ --candidate: provide exactly one commit/ref value.');
        process.exitCode = 2;
        return;
    }

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

    const checkoutHead = git('rev-parse', '--verify', 'HEAD^{commit}');
    const window = {
        base: git('rev-parse', '--verify', ref + '^{commit}'),
        candidate: candidateIdx >= 0 ? git('rev-parse', '--verify', candidateRef + '^{commit}') : checkoutHead,
    };
    if (!window.base || !window.candidate) {
        console.error('COULD NOT RESOLVE the base or candidate commit. No ledger verification is possible.');
        process.exitCode = 2;
        return;
    }
    const s = surfaces(window.base, window.candidate);
    if (!s) {
        console.error(`COULD NOT DIFF ${window.base}..${window.candidate}. The probe is blind, not the tree clean.`);
        process.exit(2);
    }
    // Markdown delimiters/control characters cannot be represented by this
    // ledger's simple table format. Refuse rather than emit a row verify can
    // silently misparse. This does not prohibit those filenames in a project.
    const unsupported = s.ui.filter((file) => /[|`\r\n\t]/.test(file));
    if (unsupported.length) {
        console.error(`COULD NOT CHECK unsupported ledger path(s): ${unsupported.map((file) => JSON.stringify(file)).join(', ')}`);
        process.exitCode = 2;
        return;
    }
    const commits = (git('log', '--oneline', `${window.base}..${window.candidate}`) || '').split('\n').filter(Boolean);

    if (argv.includes('--verify')) {
        if (!fs.existsSync(LEDGER)) {
            console.error('COULD NOT VERIFY: no DEPLOY-LEDGER.md. Run --write first.');
            process.exit(2);
        }
        const text = fs.readFileSync(LEDGER, 'utf8');
        const unchecked = text.split('\n').filter((l) => /^\|/.test(l) && /\[ \]/.test(l));
        const metrics = /^- \[[xX]\] metrics recorded or waived:[^\S\n]*\S/m.test(text);
        const problems = rowProblems(text, s);
        if (!sameWindow(text, window)) problems.unshift('STALE      base/candidate provenance is missing or differs; re-run --write and record fresh checks');
        population(s, window, how, candidateIdx >= 0, checkoutHead);
        console.log(`[verify] ${unchecked.length} row(s) with an unchecked box; `
            + `metrics ${metrics ? 'recorded' : 'NOT recorded'}; ${problems.length} missing, invalid or stale record(s)`);
        if (unchecked.length || !metrics || problems.length) {
            for (const l of unchecked) console.log('  UNCHECKED  ' + l.split('|')[1].trim());
            if (!metrics) console.log('  UNCHECKED  metrics');
            for (const problem of problems) console.log('  ' + problem);
            process.exitCode = 1;
            return;
        }
        console.log('[verify] every surface in this window has been checked');
        return;
    }

    population(s, window, how, candidateIdx >= 0, checkoutHead);
    if (argv.includes('--write')) {
        const previous = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : null;
        fs.writeFileSync(LEDGER, render(ref, how, s, commits, previous, window), 'utf8');
        console.log(`[write] ${path.relative(ROOT, LEDGER)} updated`
            + (previous ? sameWindow(previous, window) ? ' (same-window checks preserved)' : ' (changed or missing commit window; checks reset)' : ''));
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
