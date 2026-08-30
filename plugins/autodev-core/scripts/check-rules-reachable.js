#!/usr/bin/env node
/**
 * check-rules-reachable - find instruction files that exist and never load.
 *
 * THE DEFECT. This repo shipped 8.103.0 "the rules that could never load" and
 * 8.104.0 "nine always-on rules with nothing to load them". A rule that never
 * reaches context is invisible from the inside: the file exists, its frontmatter
 * parses, its content is good, and it contributes nothing. No error, no diff, no
 * failing test. Nothing in a rules system observes its own absence.
 *
 * The `instructions-loaded` hook supplies the missing observable by recording
 * every file that DID load. This reads that log back and subtracts it from what
 * is on disk.
 *
 * THE THING THAT MAKES THIS HARD, AND WHY THE OUTPUT HAS THREE CLASSES.
 *
 * "Not in the log" has two completely different meanings and reporting them
 * together would make the check useless in both directions:
 *
 *   UNREACHABLE   an UNCONDITIONAL rule, one with no `paths:` frontmatter, that
 *                 has never been seen loading. Those load at session start by
 *                 definition, so if the log covers any session at all and the
 *                 file is absent, something is wrong with it. This is the 8.103
 *                 defect and it is a real finding.
 *
 *   UNEXERCISED   a PATH-SCOPED rule that has never been seen. Correct and
 *                 expected: it loads only when a matching file is read, and
 *                 nobody may have touched those paths yet. Reporting it as a
 *                 fault trains the reader to skim, and a skimmed detector misses
 *                 the real one. Counted separately and never as a failure.
 *
 *   NO EVIDENCE   the log is empty or too young to have covered a session start.
 *                 Reported as its own state rather than as "everything is
 *                 unreachable", which is what a naive subtraction would say on a
 *                 fresh machine. An absence of observations is a fact about the
 *                 log, not about the rules.
 *
 * Usage:
 *   node check-rules-reachable.js [repoPath]   default: cwd
 *   node check-rules-reachable.js --json
 *   node check-rules-reachable.js --selftest   (npm run test:reachable)
 *
 * Exit 1 only on UNREACHABLE - in BOTH renderers. Never on UNEXERCISED, never
 * on NO EVIDENCE. The codex audit (2026-08-30, F2) found the two public live
 * entrypoints hard-coding success: `npm run check:reachable` always diverted
 * into the selftest and never read a repository, and --json printed a computed
 * `unreachable` array and then exited 0 unconditionally. Both now carry the
 * same verdict the text renderer computes.
 *
 * F3, same audit: evidence is scoped to the repository that produced it. The
 * hook records `cwd`; a session_start in repo A used to make repo B's unseen
 * unconditional rule read as proven unreachable. Rows are filtered to the
 * target repo before sawStart/seen/session counts are computed.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const has = (f) => process.argv.indexOf(f) !== -1;

function logPath() {
    const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(home, 'logs', 'instructions-loaded.jsonl');
}

/** Every instruction file a repo declares, with whether it is path-scoped. */
function onDisk(repo) {
    const out = [];
    const add = (p) => {
        let src = '';
        try { src = fs.readFileSync(p, 'utf8'); } catch { return; }
        out.push({
            file: path.resolve(p),
            scoped: /^---[\s\S]*?^\s*paths:/m.test(src.slice(0, 2000)),
        });
    };

    for (const n of ['CLAUDE.md', 'CLAUDE.local.md']) {
        const p = path.join(repo, n);
        if (fs.existsSync(p)) add(p);
    }
    const nested = path.join(repo, '.claude', 'CLAUDE.md');
    if (fs.existsSync(nested)) add(nested);

    const walk = (dir, depth) => {
        if (depth > 5) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (e.name.endsWith('.md')) add(full);
        }
    };
    const rules = path.join(repo, '.claude', 'rules');
    if (fs.existsSync(rules)) walk(rules, 0);

    return out;
}

function readLog(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const rows = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* a torn line is not a finding */ }
    }
    return rows;
}

function analyse(disk, rows, repo) {
    // F3: evidence belongs to the repository that produced it. A row is in
    // scope when its recorded cwd sits inside the target repo, or - for legacy
    // rows written before cwd was recorded - when the loaded file does. With
    // no repo given (the selftest's synthetic fixtures) behaviour is unchanged.
    if (repo) {
        const base = path.resolve(repo).toLowerCase();
        const within = (p) => {
            if (!p) return false;
            const r = path.resolve(String(p)).toLowerCase();
            return r === base || r.startsWith(base + path.sep);
        };
        rows = (rows || []).filter((r) => r && (within(r.cwd) || within(r.file)));
    }
    // NO EVIDENCE is decided by whether the log ever saw a session_start, not by
    // whether it has any lines. A log full of path_glob_match rows proves the
    // hook works and proves nothing about what loads at startup, which is
    // exactly the question an unconditional rule is judged on.
    const sawStart = (rows || []).some((r) => r && r.reason === 'session_start');
    const seen = new Set((rows || []).map((r) => r && r.file
        ? path.resolve(r.file).toLowerCase() : null).filter(Boolean));

    const unreachable = [];
    const unexercised = [];
    let reached = 0;

    for (const d of disk) {
        if (seen.has(d.file.toLowerCase())) { reached += 1; continue; }
        if (d.scoped) unexercised.push(d);
        else unreachable.push(d);
    }

    const sessions = new Set((rows || [])
        .filter((r) => r && r.reason === 'session_start' && r.at)
        .map((r) => String(r.at).slice(0, 16)));

    return {
        sawStart,
        rows: (rows || []).length,
        sessions: sessions.size,
        onDisk: disk.length,
        reached,
        unreachable,
        unexercised,
    };
}

function report(repo, r, logFile) {
    console.log('RULES REACHABLE  ' + repo);
    if (r.rows === null) {
        console.log('  NO EVIDENCE: no log at ' + logFile);
        console.log('  The instructions-loaded hook has never written here. That is a fact');
        console.log('  about the log, not about the rules. Nothing is reported as unreachable.');
        return 0;
    }
    console.log('  population: ' + r.onDisk + ' instruction file(s) on disk, '
        + r.rows + ' load record(s), ~' + r.sessions + ' distinct session start(s)');

    if (!r.sawStart) {
        console.log('');
        console.log('  NO EVIDENCE: the log holds no session_start record.');
        console.log('  An unconditional rule is judged on whether it loads at startup, and');
        console.log('  nothing here has observed a startup yet. Reporting these as unreachable');
        console.log('  would be a claim about the log. Re-run after a fresh session.');
        console.log('  (' + r.unreachable.length + ' unconditional file(s) unseen, withheld)');
        return 0;
    }

    console.log('');
    console.log('  reached      ' + r.reached);
    console.log('  UNREACHABLE  ' + r.unreachable.length
        + '  unconditional, never observed loading');
    console.log('  unexercised  ' + r.unexercised.length
        + '  path-scoped, correctly absent until a matching file is read');

    for (const u of r.unreachable) {
        console.log('');
        console.log('  [UNREACHABLE] ' + path.relative(repo, u.file));
        console.log('      No `paths:` frontmatter, so it should load at every session start,');
        console.log('      and ' + r.sessions + ' start(s) have been observed without it.');
    }

    if (r.unexercised.length) {
        console.log('');
        console.log('  unexercised (not a fault, listed so the number is not mistaken for coverage):');
        for (const u of r.unexercised) console.log('    ' + path.relative(repo, u.file));
    }

    return r.unreachable.length ? 1 : 0;
}

function selftest() {
    const fails = [];
    const check = (n, c) => { if (!c) fails.push(n); };
    const F = (p, scoped) => ({ file: path.resolve(p), scoped });

    // 1. An unconditional rule absent from a log that HAS seen a start fires.
    let r = analyse([F('/r/.claude/rules/a.md', false)],
        [{ reason: 'session_start', at: '2026-08-26T00:00:00Z', file: '/r/CLAUDE.md' }]);
    check('unconditional + unseen + start observed = UNREACHABLE', r.unreachable.length === 1);

    // 2. ...and does NOT fire when the same log HAS seen it. The negative half.
    r = analyse([F('/r/.claude/rules/a.md', false)],
        [{ reason: 'session_start', at: '2026-08-26T00:00:00Z', file: '/r/.claude/rules/a.md' }]);
    check('a rule present in the log is reached', r.reached === 1 && r.unreachable.length === 0);

    // 3. A path-scoped rule unseen is UNEXERCISED, never UNREACHABLE.
    r = analyse([F('/r/.claude/rules/b.md', true)],
        [{ reason: 'session_start', at: '2026-08-26T00:00:00Z', file: '/r/CLAUDE.md' }]);
    check('path-scoped + unseen = unexercised, not a fault',
        r.unexercised.length === 1 && r.unreachable.length === 0);

    // 4. THE GUARD THAT MATTERS. With no session_start in the log, an unseen
    //    unconditional rule must NOT be reported. A naive subtraction calls
    //    every rule unreachable on a fresh machine, which is a claim about the
    //    log wearing a finding's clothes.
    r = analyse([F('/r/.claude/rules/a.md', false)],
        [{ reason: 'path_glob_match', at: '2026-08-26T00:00:00Z', file: '/r/other.md' }]);
    check('a log with no session_start yields NO EVIDENCE', r.sawStart === false);

    // 5. An empty log is not a pile of findings either.
    r = analyse([F('/r/.claude/rules/a.md', false)], []);
    check('an empty log yields no evidence', r.sawStart === false && r.rows === 0);

    // 6. Case-insensitive path matching, because Windows records both forms.
    r = analyse([F('/R/.claude/RULES/a.md', false)],
        [{ reason: 'session_start', at: '2026-08-26T00:00:00Z', file: '/r/.claude/rules/A.MD' }]);
    check('paths match case-insensitively', r.reached === 1);

    // 7. MUTATION: fold unexercised into unreachable and prove the count moves.
    r = analyse([F('/r/a.md', true), F('/r/b.md', false)],
        [{ reason: 'session_start', at: '2026-08-26T00:00:00Z', file: '/r/CLAUDE.md' }]);
    check('MUTATION: merging the classes would change the failure count',
        r.unreachable.length === 1 && r.unexercised.length === 1
        && (r.unreachable.length + r.unexercised.length) !== r.unreachable.length);

    if (fails.length) {
        console.error('SELFTEST FAILED: ' + fails.join('; '));
        process.exit(1);
    }
    console.log('selftest ok: 7 cases, including the no-evidence guard and one mutation');
    process.exit(0);
}

function main() {
    if (has('--selftest')) return selftest();
    const repo = path.resolve(
        process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd());
    const lf = logPath();
    const rows = readLog(lf);
    const r = rows === null
        ? { rows: null, unreachable: [], unexercised: [] }
        : analyse(onDisk(repo), rows, repo);
    if (has('--json')) {
        console.log(JSON.stringify({ repo, log: lf, ...r }, null, 2));
        // F2: the JSON verdict mirrors the text renderer. Exit 1 only when a
        // startup was observed AND an unconditional rule was never seen; a
        // payload that lists unreachable rules while exiting 0 is a verdict
        // the caller's shell never receives.
        process.exit(r.rows !== null && r.sawStart && r.unreachable.length ? 1 : 0);
    }
    process.exit(report(repo, r, lf));
}

if (require.main === module) main();
module.exports = { analyse, onDisk, readLog };
