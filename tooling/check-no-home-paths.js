#!/usr/bin/env node
'use strict';
/**
 * No tracked file may carry anyone's home directory.
 *
 * This repo is PUBLIC. `check-no-private-names.js` protects project NAMES and
 * stores them as digests — right for names, and blind to paths by construction:
 * a home directory is neither a project name nor a secret, so nothing was
 * looking at it.
 *
 * `[measured 2026-08-25]` a generator added that same day wrote an absolute
 * `C:/Users/<name>/...` into a committed RESUME.md — twice in the header table
 * and again inside an embedded `git worktree list`. It was the only personal
 * path in 246 tracked files, it survived the entire suite, and it was found by
 * grepping by hand rather than by any gate, because every existing check was
 * asking a different question.
 *
 * Matches the SHAPE, not a name, so it fires for any user on any machine —
 * including a CI runner whose home nobody here has ever seen. That matters more
 * than it sounds: a check keyed to one operator's username passes for everyone
 * else while the leak is identical.
 *
 * Run it directly, or let `validate` spawn it:
 *   node tooling/check-no-home-paths.js
 *   node tooling/check-no-home-paths.js --selftest
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Windows `C:\Users\x` or `C:/Users/x`, plus POSIX /home/x and /Users/x.
const HOME_RE = /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/home\/|\/Users\/)[A-Za-z0-9._-]+/;

const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|zip|gz|pdf|mp4|webm)$/i;

// This file contains the pattern, because describing the thing requires writing
// it. A detector that reports itself gets muted, and a muted detector is worse
// than none.
const SELF = new Set([
    'tooling/check-no-home-paths.js',
]);

// PLACEHOLDERS — and yes, this is an exception list, which is usually the wrong
// answer. Here is why it is the right one, and what it costs.
//
// The first run of this check reported 24 hits and ALL 24 were placeholders:
// `/Users/...`, `C:/Users/x`, `/Users/CHANGEME`, `C:\Users\RUNNER`,
// `/home/my-project`. Zero true positives — precision 0%. Documentation about
// home paths has to be able to SHOW a home path, and a rule-windows skill that
// cannot print `C:\Users\...` cannot teach the rule it exists for.
//
// The usual objection to an exception list is that it hides a real omission.
// Weigh it here: the thing this list could hide is a real person whose username
// is literally `x`, `CHANGEME` or `runneradmin`. That is not a risk worth
// keeping a 0%-precision check for, and a check at 0% precision gets silenced
// within a day — which is the failure that actually loses a leak.
//
// What it does NOT excuse: a short real username. `abc` is three characters and
// not on this list, so it still fires.
const PLACEHOLDER = new Set([
    'x', 'y', 'me', 'user', 'username', 'USERNAME', 'name', 'NAME',
    'changeme', 'CHANGEME', 'runner', 'RUNNER', 'runneradmin',
    'my-project', 'someone', 'yourname', 'you', 'foo', 'bar', 'test',
]);

// A trailing ellipsis is the other documentation form: `C:\Users\...`.
const ELLIPSIS = /^[.]{2,}$/;

function isPlaceholder(seg) {
    return PLACEHOLDER.has(seg) || PLACEHOLDER.has(seg.toLowerCase()) || ELLIPSIS.test(seg);
}

function tracked() {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function scan(files) {
    let scanned = 0;
    const hits = [];
    for (const rel of files) {
        if (BINARY.test(rel)) continue;
        if (SELF.has(rel.split(path.sep).join('/'))) continue;
        let body;
        try { body = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
        scanned++;
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(HOME_RE);
            if (!m) continue;
            const seg = m[0].split(/[\\/]/).filter(Boolean).pop();
            if (isPlaceholder(seg)) continue;
            hits.push({ rel, line: i + 1, text: m[0] });
        }
    }
    return { scanned, hits };
}

// --- selftest ---------------------------------------------------------------
//
// A detector that has only ever run against a clean tree cannot be trusted to
// FIRE. Both directions are planted: paths it must catch, and near-misses it
// must not, because a check that flags `/home` in prose is one somebody
// silences.
if (process.argv.includes('--selftest')) {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-paths-'));
    let pass = 0, fail = 0;
    const t = (label, ok, detail) => {
        if (ok) { pass++; console.log('PASS  ' + label); }
        else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
    };
    const must = [
        ['windows backslash', 'see C:\\Users\\someone\\code'],
        ['windows forward', 'see C:/Users/someone/code'],
        ['posix home', 'path /home/someone/src'],
        ['macos users', 'path /Users/someone/src'],
    ];
    for (const [label, text] of must) t('catches ' + label, HOME_RE.test(text), text);

    const mustNot = [
        ['a bare word', 'there is no place like home'],
        ['a tilde path', 'wrote ~/Downloads/code/autodev'],
        ['Users with no name', 'the C:/Users/ directory'],
    ];
    for (const [label, text] of mustNot) t('ignores ' + label, !HOME_RE.test(text), text);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
}

const files = tracked();
const { scanned, hits } = scan(files);

if (hits.length) {
    console.log('[no-home-paths] ' + hits.length + ' home path(s) in tracked files of a PUBLIC repo:');
    for (const h of hits.slice(0, 12)) console.log('  ' + h.rel + ':' + h.line + '  ' + h.text);
    if (hits.length > 12) console.log('  ... and ' + (hits.length - 12) + ' more');
    console.log('');
    console.log('  Replace with a ~-relative path. A reader still needs to know WHICH');
    console.log('  directory is meant; they do not need to know whose it is.');
    process.exit(1);
}

console.log('[no-home-paths] ' + files.length + ' tracked file(s), ' + scanned
    + ' read as text, 0 home paths — clean');
