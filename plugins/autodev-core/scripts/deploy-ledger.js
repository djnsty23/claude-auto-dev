#!/usr/bin/env node
'use strict';

// deploy-ledger.js — what changed since the last production push, which user
// -facing surfaces it touches, whether each was actually checked, and, under
// --promotion, whether a promotion record is complete and bound to the candidate.
//
// The problem this exists for: the verification discipline is written down in
// several skills and enforced by nothing. "Screenshot at 390 and 414" is prose,
// a human decides which screens were affected, and a deploy can be called
// verified with no record of what was looked at. A rule with no gate is a rule
// that gets skipped, and the surface most likely to be skipped is the one
// nobody remembered was touched.
//
// WHAT --promotion DOES NOT DO: decide that a promotion is allowed. Whether a
// window may be promoted, and by whom, is the ship skill's policy, not this
// file's. `--verify --promotion` answers a narrower question: are the recorded
// preconditions present, well formed and about THIS candidate. Exit 0 means that
// and nothing more. The review that closed #208 is the reason for the split: a
// record check that calls itself an authorisation lets a loop authorise itself
// by writing three lines.
//
// Plain `--verify`, without --promotion, is the surface record only, unchanged,
// because the ship skill's Step 5b runs it after a deploy and none of the
// promotion preconditions apply there.
//
// THE GATE'S OUTPUT IS RECORDED, NOT QUERIED. This file never asks a forge
// whether CI was green, and that is deliberate rather than unfinished.
// `[measured 2026-09-08]` one commit carried nine check-run entries across three
// rounds — one complete green round plus in-progress duplicates from re-runs —
// and a count of "conclusion != success" returned 1, which reads as a failure
// and was an unfinished re-run. Any future CI reader here must group by job name
// and require at least one `status=completed, conclusion=success` per required
// platform, and must never read the run rollup, which reports success while a
// job is still in_progress. Until something does that correctly, the gate's exit
// code and last lines are pasted into the ledger by whoever ran it.
//
// Commands, deliberately separate:
//
//   --since <ref>      set the previous deployed commit
//   --candidate <ref>  freeze the checked candidate (defaults to current HEAD)
//   --write            create or refresh the ledger, preserving what was filled
//                      only for the same resolved base and candidate
//   --verify           exit 1 for missing, invalid, unchecked or stale surface records
//   --verify --promotion   the surface record AND the promotion record, below
//
// --verify --promotion EXIT CODES, each a different instruction to the reader:
//   0  the record is complete for this candidate. Zero bytes on stdout and
//      stderr, because this runs in a `&&` chain and text on the pass path is
//      skimmed, never read. The one exception is --pre-merge, whose pass prints
//      one [pre-merge] line, because it is a verdict about an unmerged commit.
//   1  a precondition is unmet and the message names it: a surface unchecked,
//      a surface row missing, duplicated or malformed, the ledger's recorded
//      window stale against the base/candidate pair, metrics missing, a
//      promotion field empty or wrong, a gate that is not this repo's gate
//      script or did not run on the candidate, the commit not on the default
//      branch, or under --pre-merge a candidate that lacks the base tip.
//      All of these are yours to fix; re-run after.
//   2  blind: not a repo, no deploy ref, no ledger, an unreadable --candidate,
//      an unresolvable base or candidate, a path this ledger's table cannot
//      represent, no resolvable default branch or --onto, no package.json or no
//      gate/preflight script at the candidate, or the project has not marked
//      its deploy-sensitive paths. Nothing was decided.
//   3  INELIGIBLE: the window touches something on the ineligible list. No
//      amount of filling fixes this; it needs the operator's yes in that turn.
//
// It derives the surface list from the diff. It does NOT decide whether a check
// passed: a human or a browser-driving agent fills the boxes, and --verify only
// checks their membership, shape and commit window, not whether they are true.
// A checker that both generates and satisfies its
// own checklist proves nothing, which is the failure mode this repo has spent a
// lot of rounds on. The same holds for every promotion field: --write leaves
// them empty except the commit, which is a fact and not a verdict.
//
// DEPLOY-SENSITIVE PATHS are declared by the PROJECT, in its CLAUDE.md, under a
// heading containing "Deploy-sensitive", one glob per bullet in backticks, or
// the single bullet `none` when a project has genuinely nothing to protect:
//
//   ## Deploy-sensitive paths
//   - `supabase/migrations/**`
//   - `src/app/api/stripe-webhook/**`
//   - `src/app/auth/**`
//
// A `@file` import line in CLAUDE.md is followed one level, because a project
// whose CLAUDE.md is the single line `@AGENTS.md` keeps its instructions there.
// A project with no marking gets exit 2 and the instruction to add one, never a
// pass: an unmarked project is one nobody has asked the question of.
//
// THE SQL HALF OF THE INELIGIBLE LIST is hard-coded on every project, marked or
// not, because it is a property of the world rather than of one repo. Six rules,
// one per clause of the operator's list: schema drops, renames, grants, RLS
// policies, SECURITY DEFINER, and writes to live rows.
//
// ONE OF THOSE RULES REVERSES A DECISION AN EARLIER DRAFT OF THIS FILE MADE, and
// the reversal is the useful part to record. That draft measured a product
// repo's 33 migrations, found 41 DROP statements of which 12 were DROP POLICY
// always followed by a CREATE POLICY in the same file, and concluded that a
// policy drop is a recreate pattern rather than a risk — so it pinned DROP
// POLICY as an ELIGIBLE case in its own selftest. The operator's list says the
// opposite: *"migrations that drop or rename a column, change a grant, an RLS
// policy or a SECURITY DEFINER function"* escalate regardless, and the incident
// behind that line is a real RLS leak. The measurement was right about the
// syntax and wrong about the question: "does this file put the policy back" is
// not "is the policy it puts back the same policy". A recreate is exactly where
// an RLS mistake hides, so the rule now fires.
//
// The cost of that reversal, measured rather than estimated: the same 33-file,
// 4,427-line corpus scores 0 ineligible lines under the narrow schema-drop rule
// and 195 under the six — grant 98, rls 37, security-definer 35, live-rows 25,
// schema-drop 0, rename 0. Nearly every migration in that repo is now ineligible,
// which is the intended reading of the operator's list rather than a defect in
// it: migrations are the class he named first. The practical effect is that a
// window containing any migration escalates, and a project marking
// `supabase/migrations/**` deploy-sensitive is belt-and-braces rather than the
// load-bearing part.
//
// The first probe also matched the word "truncated" inside four comments, which
// is why comments are stripped before any pattern runs and why `TRUNCATE` must
// be followed by a name.
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
//   * The SQL rule reads ADDED LINES one at a time. `ALTER TABLE t` on one line
//     and a bare `DROP col` (no COLUMN keyword) on the next is not seen. Mark
//     the migrations directory as sensitive if that shape occurs in your repo.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const LEDGER = path.join(ROOT, 'DEPLOY-LEDGER.md');

// stderr is PIPED, not inherited. execFileSync sends a child's stderr to the
// parent's by default, and resolving the default branch probes refs that are
// legitimately absent (`origin/main` in a repo with no remote), so the default
// leaked two `fatal: Needed a single revision` lines onto a run that must print
// zero bytes. Caught by the suite's own zero-bytes assertion.
const git = (...args) => {
    try {
        // -z output is returned untrimmed: a trailing NUL is a record separator,
        // and trimming it merges the last two paths into one.
        const output = execFileSync('git', ['-C', ROOT, ...args],
            { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
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

// ------------------------------------------------------ deploy-sensitive paths

// Minimal glob: `**` crosses directories, `*` and `?` do not, a trailing `/`
// means everything beneath. Matched against the path from the repo root.
function globToRegExp(glob) {
    let g = glob.trim();
    if (g.endsWith('/')) g += '**';
    let re = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') {
                // `**/` may match zero directories; a bare `**` matches anything.
                if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
            } else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
}

// Reads CLAUDE.md (following `@file` imports one level) for the marking. Returns
//   { globs, none, source }   when a marking exists
//   null                       when none exists — the caller refuses, never passes
function sensitiveGlobsFrom(root) {
    const main = path.join(root, 'CLAUDE.md');
    if (!fs.existsSync(main)) return null;
    const texts = [{ file: 'CLAUDE.md', text: fs.readFileSync(main, 'utf8') }];
    for (const line of texts[0].text.split('\n')) {
        const m = line.match(/^@(\S+)\s*$/);
        if (!m) continue;
        const p = path.join(root, m[1]);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) texts.push({ file: m[1], text: fs.readFileSync(p, 'utf8') });
    }
    for (const { file, text } of texts) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const h = lines[i].match(/^(#{1,6})\s+(.*deploy-sensitive.*)$/i);
            if (!h) continue;
            const level = h[1].length;
            const globs = [];
            let none = false;
            for (let j = i + 1; j < lines.length; j++) {
                const hh = lines[j].match(/^(#{1,6})\s/);
                if (hh && hh[1].length <= level) break;
                const item = lines[j].match(/^\s*[-*]\s+(.*)$/);
                if (!item) continue;
                if (/^none\b/i.test(item[1])) { none = true; continue; }
                const code = item[1].match(/`([^`]+)`/);
                if (code) globs.push(code[1]);
            }
            if (!globs.length && !none) return null;   // a heading with no bullets marks nothing
            return { globs, none, source: file };
        }
    }
    return null;
}

// The SQL half of the ineligible list, one rule per clause of the operator's
// sentence, each named in the output so a refusal says WHICH clause it hit.
// Comments must be stripped before any of them run (see header).
//
// Every rule errs toward escalation where it cannot be sure. That direction is
// deliberate: a false ineligible costs one message to the operator, a false
// eligible costs an unreviewed production write.
const SQL_RULES = [
    {
        id: 'schema-drop',
        why: 'drops a table, column or schema',
        // The ALTER branch excludes the column-level and constraint drops
        // Postgres spells with the same keyword: DROP CONSTRAINT, DROP DEFAULT,
        // DROP NOT NULL, DROP IDENTITY, DROP EXPRESSION are not schema drops,
        // and one product repo has 8 of the first.
        re: /\bDROP\s+(?:TABLE|COLUMN|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?["\w.]+|\bALTER\s+TABLE\b[^;]*\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b|IF\s+EXISTS\s+CONSTRAINT\b)(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?["\w]+/i,
    },
    {
        id: 'rename',
        why: 'renames a column or table',
        // A table rename is caught too, though the sentence names only columns:
        // it breaks readers exactly as a column rename does, and narrowing to
        // COLUMN would let `RENAME TO` through on the same reasoning.
        re: /\bALTER\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\b[^;]*\bRENAME\b/i,
    },
    {
        id: 'grant',
        why: 'changes a grant',
        re: /\b(?:GRANT|REVOKE)\s+(?!.*\bON\s+CONFLICT\b)/i,
    },
    {
        id: 'rls',
        why: 'changes an RLS policy or row-level security',
        // This is the rule that reverses a decision an earlier draft of this
        // file made. See the header note on DROP POLICY.
        re: /\b(?:CREATE|ALTER|DROP)\s+POLICY\b|\bROW\s+LEVEL\s+SECURITY\b/i,
    },
    {
        id: 'security-definer',
        why: 'defines or changes a SECURITY DEFINER function',
        re: /\bSECURITY\s+DEFINER\b/i,
    },
    {
        id: 'live-rows',
        why: 'writes live rows',
        // Anchored forms only. A bare UPDATE/DELETE keyword appears inside
        // `FOR UPDATE`, `ON DELETE CASCADE` and `CREATE POLICY ... FOR DELETE`,
        // none of which write a row.
        re: /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+(?:ONLY\s+)?["\w.]+\s+SET\b/i,
    },
];

const stripSqlComments = (line) => line.replace(/--.*$/, '');

// Kept as a named export because the corpus measurement in the evidence doc runs
// this exact expression rather than a paraphrase of it.
const SCHEMA_DROP = SQL_RULES[0].re;

// Every reason this window is ineligible. Empty array = eligible.
//
// The SQL diff reads `since..candidate`, the same window as every other diff.
// It read `since..HEAD` until 2026-09-13, so with --candidate the six rules
// judged whatever was checked out: a candidate carrying DROP TABLE passed from a
// checkout that lacked it, and a clean candidate was refused for SQL only the
// checkout carried. `[measured]` in the #208 review, and pinned both ways by the
// F3 cases in tooling/test-deploy-ledger.js.
function ineligibility(sinceRef, candidate, files, marking) {
    const hits = [];
    const matchers = marking.globs.map((g) => ({ g, re: globToRegExp(g) }));
    for (const f of files) {
        for (const { g, re } of matchers) {
            if (re.test(f)) { hits.push({ kind: 'path', file: f, why: `matches deploy-sensitive \`${g}\` (${marking.source})` }); break; }
        }
    }
    const diff = git('diff', '--unified=0', `${sinceRef}..${candidate}`, '--', '*.sql', '**/*.sql');
    if (diff) {
        let file = null;
        for (const line of diff.split('\n')) {
            const fm = line.match(/^\+\+\+ b\/(.*)$/);
            if (fm) { file = fm[1]; continue; }
            if (!line.startsWith('+') || line.startsWith('+++')) continue;
            const body = stripSqlComments(line.slice(1));
            for (const rule of SQL_RULES) {
                if (rule.re.test(body)) { hits.push({ kind: 'sql', file, why: `${rule.id}: ${rule.why} — ${body.trim()}` }); break; }
            }
        }
    }
    return hits;
}

// ------------------------------------------------------- the default branch

// "that commit is on the default branch" is a clause of the rule, so it is
// resolved rather than assumed, and a repo where it cannot be resolved is blind
// rather than eligible.
function defaultBranch() {
    const sym = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
    if (sym) return { ref: sym, how: 'origin/HEAD' };
    for (const c of ['origin/main', 'origin/master', 'main', 'master']) {
        if (git('rev-parse', '--verify', c + '^{commit}')) return { ref: c, how: 'conventional name; origin/HEAD is not set' };
    }
    return null;
}

// git() returns '' for a command that succeeds silently and null for one that
// fails, and '' is falsy — so containment needs its own boolean helper rather
// than a truthiness test on the output.
const gitOk = (...args) => {
    try {
        execFileSync('git', ['-C', ROOT, ...args], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

// ------------------------------------------------------- the promotion record

const FIELDS = ['commit', 'gate', 'gate commit', 'gate exit', 'gate tail', 'evidence', 'rollback', 'authorised'];

// ------------------------------------------------------- the gate binding
//
// Every field but `commit` is typed by hand, so without a binding the record
// could name any gate, run on any commit. Two things are now checked against
// the repository rather than the prose: `gate commit` must be the candidate,
// and `gate` must invoke exactly the repo's own gate script as package.json
// defines it AT THE CANDIDATE. A subset such as `gate:ci`, which in one product
// repo skips every browser spec, is refused by name while `gate` exists.
//
// This binds what was WRITTEN to the candidate and the repo. It cannot prove
// the gate ran; the exit and the tail are still pasted by whoever ran it.
const GATE_SCRIPT_NAMES = ['gate', 'preflight'];

function gateScriptName(scripts) {
    if (!scripts || typeof scripts !== 'object') return null;
    return GATE_SCRIPT_NAMES.find((n) => typeof scripts[n] === 'string') || null;
}

// null when the field invokes `expected`; otherwise the reason it does not.
function gateNameProblem(gateField, expected, at) {
    const m = String(gateField).trim().match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(\S+)$/);
    if (!m) return `"${gateField}" runs no package script; the gate defined at ${at} is \`npm run ${expected}\``;
    if (m[1] === expected) return null;
    const variant = m[1].startsWith(expected + ':') ? `; "${m[1]}" is a variant of "${expected}", and a variant is not the gate` : '';
    return `"${gateField}" runs "${m[1]}", not the gate script "${expected}" defined at ${at}${variant}`;
}
const STATED = /\[stated \d{4}-\d{2}-\d{2}\]/;
const PLACEHOLDER = /<[^>]+>|\[[^\]]*\]|\bTODO\b|\bTBD\b/i;

// Parses `- field: value` lines and the fenced block after `- gate tail:`.
// Tolerant of `authorized`. Missing fields come back as ''.
function parseRecord(text) {
    const rec = {};
    for (const f of FIELDS) rec[f] = '';
    // CRLF is normalised FIRST, the way ledgerRows() does it. `.` does not match
    // \r in JavaScript — it is a line terminator — so `(.*)$` fails on exactly
    // the CRLF lines that carry a value, while a valueless line like
    // `- gate tail:` still matches because `\s*` absorbs the \r. The result was
    // a ledger whose fields are visibly filled and which --verify reports as six
    // missing fields, on any editor that writes CRLF.
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const start = lines.findIndex((l) => /^##\s+Promotion record/i.test(l));
    if (start < 0) return { rec, present: false };
    for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) break;
        const m = lines[i].match(/^- (commit|gate commit|gate exit|gate tail|gate|evidence|rollback|authori[sz]ed):\s*(.*)$/i);
        if (!m) continue;
        const key = m[1].toLowerCase().replace('authorized', 'authorised');
        if (key === 'gate tail') {
            const tail = [];
            let j = i + 1;
            while (j < lines.length && !/^```/.test(lines[j]) && !/^- /.test(lines[j]) && !/^##\s/.test(lines[j])) j++;
            if (j < lines.length && /^```/.test(lines[j])) {
                for (j++; j < lines.length && !/^```/.test(lines[j]); j++) tail.push(lines[j]);
            }
            rec[key] = tail.join('\n');
            continue;
        }
        rec[key] = m[2].trim();
    }
    return { rec, present: true };
}

// One problem per field at most, in FIELDS order, so the reader fixes them top
// to bottom. `ctx.head` enables the staleness check; `ctx.root` the evidence one.
function validateRecord(rec, ctx = {}) {
    const problems = [];
    const commit = rec.commit;
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) problems.push({ field: 'commit', why: 'missing or not a commit sha' });
    else if (ctx.head && !(ctx.head.startsWith(commit.toLowerCase()) || commit.toLowerCase().startsWith(ctx.head))) {
        problems.push({ field: 'commit', why: `STALE: the ledger names ${commit.slice(0, 7)}, HEAD is ${ctx.head.slice(0, 7)}. Re-run --write and re-verify` });
    }
    if (!rec.gate) problems.push({ field: 'gate', why: 'missing: name the gate command you ran (e.g. npm run gate)' });
    const gateCommit = (rec['gate commit'] || '').toLowerCase();
    const target = (ctx.head || commit || '').toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(gateCommit)) problems.push({ field: 'gate commit', why: 'missing: the sha of the commit the gate ran on' });
    else if (/^[0-9a-f]{7,40}$/.test(target) && !(target.startsWith(gateCommit) || gateCommit.startsWith(target))) {
        problems.push({ field: 'gate commit', why: `the gate ran on ${gateCommit.slice(0, 7)}, the candidate is ${target.slice(0, 7)}. Run the gate on the candidate` });
    }
    if (rec['gate exit'] === '') problems.push({ field: 'gate exit', why: 'missing' });
    else if (rec['gate exit'] !== '0') problems.push({ field: 'gate exit', why: `"${rec['gate exit']}" is not 0: the gate was not green` });
    if (!rec['gate tail'].split('\n').some((l) => l.trim())) problems.push({ field: 'gate tail', why: 'missing: paste the last 20 lines of the gate run inside the fence' });
    if (!rec.evidence) problems.push({ field: 'evidence', why: 'missing: the .claude/evidence/<slug>/ directory per the prove skill' });
    else if (ctx.root) {
        const dir = path.resolve(ctx.root, rec.evidence);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) problems.push({ field: 'evidence', why: `${rec.evidence} is not a directory` });
        else {
            const names = fs.readdirSync(dir);
            const has = (p) => names.some((n) => n.startsWith(p + '.'));
            if (!has('before') || !has('after')) problems.push({ field: 'evidence', why: `${rec.evidence} lacks ${!has('before') ? 'before.*' : 'after.*'}: prove wants the pair` });
        }
    }
    if (!rec.rollback) problems.push({ field: 'rollback', why: 'missing: the exact command that undoes THIS promotion' });
    else if (PLACEHOLDER.test(rec.rollback)) problems.push({ field: 'rollback', why: `"${rec.rollback}" still holds a placeholder` });
    if (!rec.authorised) problems.push({ field: 'authorised', why: 'missing: cite the standing rule by date, e.g. [stated 2026-09-08] Form B' });
    else if (!STATED.test(rec.authorised)) problems.push({ field: 'authorised', why: 'must cite the standing rule by date as [stated YYYY-MM-DD]' });
    else if (!rec.authorised.replace(STATED, '').trim()) problems.push({ field: 'authorised', why: 'the date alone is not a rule; say which one' });
    return problems;
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

// Returns { text, reset }. `reset` is true when the previous ledger belonged to
// a DIFFERENT window and nothing from it was kept.
function render(sinceRef, how, s, commits, previous, window, head) {
    // Preserve ticks a human already made, and the promotion fields they filled.
    // A regenerate that silently unchecks everything trains people to regenerate
    // less often, and a stale ledger is worse than a noisy one.
    //
    // BUT ONLY WITHIN ONE WINDOW. `[measured 2026-09-08]` the first version kept
    // fields by name regardless, so after a promotion was filed the next window's
    // --write inherited the previous gate tail, evidence and authorisation and
    // --verify passed a window nobody had run a gate on.
    //
    // Window identity is the structured record sameWindow() reads, which pins
    // BOTH resolved commits. Keying on the base alone was this branch's earlier
    // version and is weaker in exactly the case --candidate creates: the base
    // holds still while the promoted commit moves, and a gate tail inherited
    // across that is the "gate nobody ran" case above with no base change to
    // notice it. Names alone are not evidence identity either, so a kept row
    // must still match the expected shape below.
    const reset = !!previous && !sameWindow(previous, window);
    if (reset) previous = null;
    const kept = ledgerRows(previous || '');
    const row = (label, detail) => {
        const found = kept.filter((cells) => cells[0] === label);
        if (found.length !== 1 || found[0].length !== 7 || found[0][1] !== detail
            || !found[0].slice(2).every((cell) => /^\[[ xX]\]$/.test(cell))) return ROW(label, detail);
        return `| ${label} | ${detail} | ${found[0].slice(2).join(' | ')} |`;
    };
    const prev = previous ? parseRecord(previous).rec : null;
    const keep = (f, fallback) => (prev && prev[f] ? prev[f] : fallback);

    const lines = [];
    lines.push('# Deploy ledger');
    lines.push('');
    lines.push(`<!-- deploy-ledger-window: ${JSON.stringify({ version: 1, ...window })} -->`);
    lines.push(`Generated from \`${window.base}..${window.candidate}\` (${how}). Regenerate with`);
    lines.push('`deploy-ledger.js --write --since <previous-deployed-commit> --candidate <checked-commit>`; ticks, metrics and filled promotion fields are kept only for the same resolved base and candidate.');
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
    // A recorded-or-waived metrics line survives a regenerate for the same
    // reason ticks do. Anchored at line start so a quotation of the line inside
    // prose cannot satisfy it.
    const prevMetrics = (previous || '').split('\n').find((l) => /^- \[[xX]\] metrics recorded or waived:[^\S\n]*\S/.test(l));
    lines.push(prevMetrics || '- [ ] metrics recorded or waived:');
    lines.push('');
    lines.push('## Promotion record');
    lines.push('');
    lines.push('Read only by `--verify --promotion`, which exits 1 while a field below is empty');
    lines.push('or wrong, 3 while the window touches a deploy-sensitive path or SQL rule, and 0');
    lines.push('with no output when the record is complete for this candidate. Exit 0 is a');
    lines.push('record check, not permission to promote. Fill every field by hand; only the');
    lines.push('commit is derived, and it is re-checked.');
    lines.push('');
    // The commit is DERIVED, never kept: keeping it is how the first run of the
    // suite produced a ledger that regenerated itself stale.
    lines.push(`- commit: ${head || ''}`);
    lines.push(`- gate: ${keep('gate', '')}`);
    lines.push(`- gate commit: ${keep('gate commit', '')}`);
    lines.push(`- gate exit: ${keep('gate exit', '')}`);
    lines.push('- gate tail:');
    lines.push('');
    lines.push('```text');
    if (prev && prev['gate tail']) lines.push(prev['gate tail']);
    lines.push('```');
    lines.push('');
    lines.push(`- evidence: ${keep('evidence', '')}`);
    lines.push(`- rollback: ${keep('rollback', '')}`);
    lines.push(`- authorised: ${keep('authorised', '')}`);
    lines.push('');
    lines.push('## Commits in this window');
    lines.push('');
    for (const c of commits) lines.push(`- ${c}`);
    lines.push('');
    return { text: lines.join('\n'), reset };
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

function usage() {
    console.log([
        'deploy-ledger.js — which surfaces a deploy window touches, and whether each was checked',
        '',
        '  --since <ref>            list commits and touched surfaces since a ref',
        '  --candidate <ref>        the commit being checked (default HEAD)',
        '  --write [--since <ref>]  create or refresh DEPLOY-LEDGER.md, keeping filled fields',
        '  --verify                 the surface record: 0 checked / 1 incomplete / 2 blind',
        '  --verify --promotion     also the promotion record: 0 complete / 1 incomplete / 2 blind / 3 ineligible',
        '  --verify --promotion --verbose   same, but print the population on the pass path too',
        '  --verify --promotion --pre-merge [--onto <ref>]',
        '                           before a merge that deploys: the candidate must CONTAIN the base tip',
        '                           (default branch unless --onto), instead of being on it',
        '  --selftest               prove the derivations and the record validator can fire',
        '',
        'Deploy-sensitive paths come from the project CLAUDE.md, under a heading containing',
        '"Deploy-sensitive", one backticked glob per bullet, or the bullet `none`.',
    ].join('\n'));
}

// The whole promotion verification. Returns { code, lines } and prints nothing
// itself, so --verify --promotion can be silent on 0.
function verify(ref, how, s, headFull, window, opts = {}) {
    const out = [];
    if (!fs.existsSync(LEDGER)) {
        return { code: 2, err: ['COULD NOT VERIFY: no DEPLOY-LEDGER.md. Run --write first.'] };
    }
    const marking = sensitiveGlobsFrom(ROOT);
    if (!marking) {
        return {
            code: 2, err: [
                'COULD NOT VERIFY: this project has not marked its deploy-sensitive paths.',
                'Add to CLAUDE.md (or a file it @-imports) a section such as:',
                '',
                '  ## Deploy-sensitive paths',
                '  - `supabase/migrations/**`',
                '  - `src/app/api/stripe-webhook/**`',
                '',
                'or the single bullet `- none` if there is genuinely nothing to protect.',
                'An unmarked project is one nobody has asked the question of, so it is not a pass.',
            ],
        };
    }
    const hits = ineligibility(ref, headFull, s.files, marking);
    if (hits.length) {
        out.push(`[ineligible] ${hits.length} reason(s) this window is ineligible `
            + `(${marking.globs.length} deploy-sensitive glob(s) from ${marking.source}, ${s.files.length} file(s) in the window):`);
        for (const h of hits) out.push(`  INELIGIBLE  ${h.file}  ${h.why}`);
        out.push('Promotion of this window needs the operator\'s yes in that turn. No field fixes this.');
        return { code: 3, lines: out };
    }
    // The gate script is read from the CANDIDATE's package.json, never the
    // working tree's: a checkout can define a gate the candidate does not.
    const at = headFull.slice(0, 7);
    const pkgRaw = git('show', `${headFull}:package.json`);
    if (pkgRaw === null) {
        return { code: 2, err: [`COULD NOT VERIFY: no package.json at ${at}, so the recorded gate cannot be checked against the repo's own gate script.`] };
    }
    let scripts;
    try {
        scripts = JSON.parse(pkgRaw).scripts;
    } catch {
        return { code: 2, err: [`COULD NOT VERIFY: package.json at ${at} does not parse, so the repo's gate script cannot be read.`] };
    }
    const expectedGate = gateScriptName(scripts);
    if (!expectedGate) {
        return {
            code: 2, err: [
                `COULD NOT VERIFY: no "gate" or "preflight" script in package.json at ${at}.`,
                'A recorded gate is only checkable against a gate the repo defines, so nothing was decided.',
            ],
        };
    }

    const text = fs.readFileSync(LEDGER, 'utf8');
    const unchecked = text.split('\n').filter((l) => /^\|/.test(l) && /\[ \]/.test(l));
    const metrics = /^- \[[xX]\] metrics recorded or waived:[^\S\n]*\S/m.test(text);
    const { rec, present } = parseRecord(text);
    const problems = present ? validateRecord(rec, { head: headFull, root: ROOT })
        : [{ field: 'promotion record', why: 'section missing: re-run --write' }];
    if (present && rec.gate) {
        const why = gateNameProblem(rec.gate, expectedGate, at);
        if (why) problems.push({ field: 'gate', why });
    }

    // An unchecked-box scan alone passes on a ledger that simply lacks the row:
    // a surface nobody listed has no `[ ]` to find. These ask the complementary
    // question — is every expected row PRESENT, unique and correctly shaped —
    // and whether the file's recorded window is still this base/candidate pair.
    // Both are exit 1: the fix is to re-run --write and check the surfaces.
    const rows = rowProblems(text, s);
    if (!sameWindow(text, window)) {
        rows.unshift('STALE      base/candidate provenance is missing or differs; re-run --write and record fresh checks');
    }

    // "that commit is on the default branch". Remediable by landing the branch,
    // so it is exit 1 beside the fields rather than exit 3: nothing here needs
    // the operator, it needs the commit to be somewhere everyone can see.
    //
    // PRE-MERGE. On a repo where the merge to the default branch IS the deploy,
    // containment can only hold after the act it is meant to precede, so the
    // check was red before the merge and green only after it. --pre-merge asks
    // the question that CAN be answered first: does the candidate contain the
    // current tip of the branch it merges onto? If it does, the merge produces
    // the candidate's tree, which is the tree the gate ran on. The tip is the
    // LOCAL ref, and the pass line says so, because a stale ref reads current.
    const db = opts.onto ? { ref: opts.onto, how: 'given with --onto' } : defaultBranch();
    if (!db) {
        return {
            code: 2, err: [
                'COULD NOT VERIFY: no default branch resolvable (no origin/HEAD, no origin/main, origin/master, main or master).',
                'The rule requires the promoted commit to be ON the default branch, and that cannot be checked here.',
                'Set it with: git remote set-head origin -a, or name the base with --pre-merge --onto <ref>',
            ],
        };
    }
    let premerge = null;
    if (opts.preMerge) {
        const tip = git('rev-parse', '--verify', db.ref + '^{commit}');
        if (!tip) {
            return { code: 2, err: [`COULD NOT VERIFY: --onto "${db.ref}" does not resolve to a commit. Nothing was decided.`] };
        }
        premerge = { ref: db.ref, how: db.how, tip };
        if (!gitOk('merge-base', '--is-ancestor', tip, headFull)) {
            problems.push({
                field: 'merge base',
                why: `${at} does not contain ${db.ref} at ${tip.slice(0, 7)}: the merge would produce a tree the gate never ran on. `
                    + `Bring the branch up to date with ${db.ref}, re-run the gate on the new candidate, and re-verify`,
            });
        }
    } else if (!gitOk('merge-base', '--is-ancestor', headFull, db.ref)) {
        problems.push({
            field: 'default branch',
            why: `${at} is not on ${db.ref} (${db.how}). Land it there first, or, where the merge itself deploys, verify before it with --pre-merge`,
        });
    }

    if (unchecked.length || !metrics || problems.length || rows.length) {
        out.push(`[verify] ${unchecked.length} row(s) with an unchecked box; metrics ${metrics ? 'recorded' : 'NOT recorded'}; `
            + `${rows.length} missing, invalid or stale surface record(s); `
            + `${problems.length} promotion field(s) missing or wrong`);
        for (const l of unchecked) out.push('  UNCHECKED  ' + l.split('|')[1].trim());
        if (!metrics) out.push('  UNCHECKED  metrics');
        for (const r of rows) out.push('  ' + r);
        for (const p of problems) out.push(`  MISSING    ${p.field}: ${p.why}`);
        return { code: 1, lines: out };
    }
    return { code: 0, lines: [], marking, rec, db, premerge };
}

function main() {
    const argv = process.argv.slice(2);
    const sinceIdx = argv.indexOf('--since');
    const explicit = sinceIdx >= 0 ? argv[sinceIdx + 1] : null;

    if (argv.includes('--help') || argv.includes('-h')) return usage();

    const candidateIdx = argv.indexOf('--candidate');
    const candidateRef = candidateIdx >= 0 ? argv[candidateIdx + 1] : 'HEAD';
    if (candidateIdx >= 0 && (!candidateRef || candidateRef.startsWith('-')
        || argv.filter((arg) => arg === '--candidate').length !== 1)) {
        console.error('COULD NOT READ --candidate: provide exactly one commit/ref value.');
        process.exitCode = 2;
        return;
    }

    if (argv.includes('--selftest')) return selftest();

    const ontoIdx = argv.indexOf('--onto');
    const onto = ontoIdx >= 0 ? argv[ontoIdx + 1] : null;
    if (ontoIdx >= 0 && (!onto || onto.startsWith('-'))) {
        console.error('COULD NOT READ --onto: provide the ref the candidate will merge onto.');
        process.exitCode = 2;
        return;
    }
    // --onto names a merge base, so it only means anything before a merge.
    const preMerge = argv.includes('--pre-merge') || ontoIdx >= 0;

    if (!git('rev-parse', '--git-dir')) {
        console.error('COULD NOT READ: not a git repository. The probe is blind, not the deploy clean.');
        process.exitCode = 2;
        return;
    }

    const { ref, how } = resolveSince(explicit);
    if (!ref) {
        console.error(`COULD NOT DETERMINE the last deploy (${how}).`);
        console.error('This is NOT "nothing changed". Pass --since <ref>, or write one to');
        console.error('.claude/last-deploy, or tag your deploys.');
        process.exitCode = 2;
        return;
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
        process.exitCode = 2;
        return;
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
    // The commit this authorises is the CANDIDATE, not the checkout HEAD. They
    // are the same without --candidate; with it, promoting the checkout would
    // authorise a commit nobody froze.
    const headFull = window.candidate.toLowerCase();

    if (argv.includes('--verify') && argv.includes('--promotion')) {
        const v = verify(ref, how, s, headFull, window, { preMerge, onto });
        if (v.code === 2) {
            for (const l of v.err) console.error(l);
            process.exitCode = 2;
            return;
        }
        if (v.code !== 0) {
            population(s, window, how, candidateIdx >= 0, checkoutHead);
            for (const l of v.lines) console.log(l);
            process.exitCode = v.code;
            return;
        }
        if (argv.includes('--verbose')) {
            population(s, window, how, candidateIdx >= 0, checkoutHead);
            console.log(`[verify] eligible (${v.marking.globs.length} deploy-sensitive glob(s) + ${SQL_RULES.length} SQL rule(s), 0 hits), `
                + `${v.premerge ? `contains ${v.premerge.ref}` : `on ${v.db.ref}`}, every surface checked and recorded for this window, every promotion field present. `
                + `The promotion record for ${headFull.slice(0, 7)} is complete; that is not itself permission to promote.`);
        }
        // A pre-merge pass is NOT silent. It is a different verdict from the
        // default one, about a commit that is not on the base yet, and a reader
        // who cannot tell the two apart will treat it as the post-merge answer.
        if (v.premerge) {
            console.log(`[pre-merge] ${headFull.slice(0, 7)} contains ${v.premerge.ref} at ${v.premerge.tip.slice(0, 7)} `
                + `(${v.premerge.how}; the local ref, so fetch first). Verified BEFORE the merge: the candidate is not `
                + `required to be on ${v.premerge.ref} yet, and a base that moves after this line needs a fresh gate and verify.`);
        }
        return;   // default mode: exit 0 with zero bytes, the chain reads the code, not the text
    }

    if (argv.includes('--verify')) {
        if (!fs.existsSync(LEDGER)) {
            console.error('COULD NOT VERIFY: no DEPLOY-LEDGER.md. Run --write first.');
            process.exitCode = 2;
            return;
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
        const { text, reset } = render(ref, how, s, commits, previous, window, headFull);
        fs.writeFileSync(LEDGER, text, 'utf8');
        console.log(`[write] ${path.relative(ROOT, LEDGER)} updated`
            + (reset ? ' (changed or missing commit window; ticks and fields reset)'
                : previous ? ' (same-window ticks and filled fields preserved)' : ''));
        return;
    }
    for (const [r, files] of s.routed) console.log(`  ${r}  <- ${files.join(', ')}`);
    for (const f of s.unrouted) console.log(`  (no route)  ${f}`);
    for (const f of s.wide) console.log(`  WIDE  ${f}`);
}

// ------------------------------------------------------------- the selftest

function selftest() {
    let failed = 0;
    let total = 0;
    const check = (label, ok, detail) => {
        total++;
        if (!ok) failed++;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (${detail})`}`);
    };

    const cases = [
        ['app/page.tsx', '/'],
        ['app/settings/page.tsx', '/settings'],
        ['src/routes/+page.svelte', '/'],
        ['pages/about.tsx', '/about'],
        ['app/(marketing)/pricing/page.tsx', '/pricing'],
        ['lib/util.ts', null],
        ['components/Button.tsx', null],
    ];
    for (const [file, want] of cases) check(`${file} -> ${want}`, routeFor(file) === want, `got ${routeFor(file)}`);
    // A negative that is impossible by construction rather than merely absent:
    // a file under no routing directory can never yield a route.
    const wideCases = [['tailwind.config.js', true], ['app/globals.css', true], ['app/page.tsx', false]];
    for (const [file, want] of wideCases) check(`WIDE(${file}) === ${want}`, WIDE.test(file) === want, '');

    // Globs, each against a hit and a miss written by hand.
    const globCases = [
        ['supabase/migrations/**', 'supabase/migrations/0001_x.sql', true],
        ['supabase/migrations/**', 'supabase/functions/x/index.ts', false],
        ['src/app/api/stripe-webhook/**', 'src/app/api/stripe-webhook/route.ts', true],
        ['src/app/api/stripe-webhook/**', 'src/app/api/checkout/route.ts', false],
        ['**/billing.ts', 'src/lib/billing.ts', true],
        ['**/billing.ts', 'billing.ts', true],
        ['src/app/auth/', 'src/app/auth/callback/route.ts', true],
        ['*.sql', 'supabase/migrations/0001_x.sql', false],   // `*` does not cross a slash
    ];
    for (const [g, f, want] of globCases) check(`glob ${g} ~ ${f} === ${want}`, globToRegExp(g).test(f) === want, '');

    // The SQL rules: for each line, WHICH rule should fire, or null for none.
    // Naming the rule rather than asserting a boolean is what keeps a case from
    // passing for the wrong reason — an earlier draft had `DROP POLICY` passing
    // as eligible, and a boolean assertion could not have shown that the clause
    // it belonged to was simply absent.
    const fired = (sql) => {
        const body = stripSqlComments(sql);
        const r = SQL_RULES.find((x) => x.re.test(body));
        return r ? r.id : null;
    };
    const sqlCases = [
        ['DROP TABLE public.scans;', 'schema-drop'],
        ['drop table if exists old_stats cascade;', 'schema-drop'],
        ['ALTER TABLE qr_codes DROP COLUMN legacy_slug;', 'schema-drop'],
        ['alter table t drop if exists c;', 'schema-drop'],
        ['TRUNCATE TABLE scans;', 'schema-drop'],
        ['truncate scans, visits;', 'schema-drop'],
        ['DROP SCHEMA staging CASCADE;', 'schema-drop'],
        ['ALTER TABLE scans RENAME COLUMN slug TO code;', 'rename'],
        ['alter table scans rename to scans_old;', 'rename'],
        ['GRANT SELECT ON scans TO anon;', 'grant'],
        ['REVOKE ALL ON scans FROM public;', 'grant'],
        ['DROP POLICY IF EXISTS "owner reads" ON scans;', 'rls'],
        ['CREATE POLICY "owner reads" ON scans FOR SELECT USING (true);', 'rls'],
        ['ALTER TABLE scans ENABLE ROW LEVEL SECURITY;', 'rls'],
        ['CREATE FUNCTION f() RETURNS void SECURITY DEFINER AS $$ $$;', 'security-definer'],
        ['INSERT INTO plans (id) VALUES (1);', 'live-rows'],
        ['DELETE FROM scans WHERE id = 1;', 'live-rows'],
        ['UPDATE scans SET n = 0;', 'live-rows'],
        ['update only public.scans set n = 0;', 'live-rows'],
        // Negatives. Each is a shape the corpus actually contains, or a keyword
        // that appears inside a clause which writes nothing.
        ['DROP TRIGGER IF EXISTS trg ON scans;', null],
        ['ALTER TABLE scans DROP CONSTRAINT scans_pkey;', null],
        ['ALTER TABLE scans ALTER COLUMN n DROP DEFAULT;', null],
        ['ALTER TABLE scans ALTER COLUMN n DROP NOT NULL;', null],
        ['DROP FUNCTION IF EXISTS f();', null],
        ['DROP INDEX IF EXISTS i;', null],
        ['CREATE INDEX idx ON scans (id);', null],
        ['ALTER TABLE scans ADD COLUMN note text;', null],
        ['SELECT * FROM scans FOR UPDATE;', null],
        ['ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES b(id) ON DELETE CASCADE;', null],
        ['INSERT ... ON CONFLICT is not a grant', null],
        ["-- Yesterday truncated to the same clock time, so the comparison is", null],
        ['select 1; -- DROP TABLE in a trailing comment', null],
    ];
    for (const [sql, want] of sqlCases) {
        check(`SQL ${want || 'eligible'}: ${sql}`, fired(sql) === want, `fired ${fired(sql)}`);
    }
    check('every SQL rule has at least one positive case in this selftest',
        SQL_RULES.every((r) => sqlCases.some(([, want]) => want === r.id)),
        SQL_RULES.filter((r) => !sqlCases.some(([, w]) => w === r.id)).map((r) => r.id).join(','));

    // The record validator, against literals written by hand rather than by
    // render(), so a change to render() cannot weaken these in the same motion.
    const complete = [
        '## Promotion record', '',
        '- commit: 0123abc', '- gate: npm run gate', '- gate commit: 0123abc', '- gate exit: 0', '- gate tail:', '', '```text', 'ALL 61 SUITES PASSED', '```', '',
        '- evidence: .claude/evidence/x', '- rollback: vercel rollback', '- authorised: [stated 2026-09-08] Form B, green gate with the ledger', '',
    ].join('\n');
    const okRec = parseRecord(complete);
    check('parses a complete record', okRec.present && okRec.rec.commit === '0123abc' && okRec.rec['gate tail'] === 'ALL 61 SUITES PASSED', JSON.stringify(okRec.rec));
    check('complete record has no problems (no fs context)', validateRecord(okRec.rec).length === 0, JSON.stringify(validateRecord(okRec.rec)));
    check('stale commit is a problem', validateRecord(okRec.rec, { head: 'fedcba9876543210fedcba9876543210fedcba98' }).some((p) => /STALE/.test(p.why)), '');
    check('matching head is not', validateRecord(okRec.rec, { head: '0123abcdef0123456789abcdef0123456789abcd' }).length === 0, '');
    const red = parseRecord(complete.replace('- gate exit: 0', '- gate exit: 1')).rec;
    check('gate exit 1 is a problem naming the gate', validateRecord(red).some((p) => p.field === 'gate exit' && /not green/.test(p.why)), '');
    const placeholder = parseRecord(complete.replace('vercel rollback', 'git checkout [prev-commit] -- x')).rec;
    check('a placeholder rollback is a problem', validateRecord(placeholder).some((p) => p.field === 'rollback'), '');
    const undated = parseRecord(complete.replace('[stated 2026-09-08] ', '')).rec;
    check('an authorisation without a [stated date] is a problem', validateRecord(undated).some((p) => p.field === 'authorised'), '');
    const emptyTail = parseRecord(complete.replace('ALL 61 SUITES PASSED\n', '')).rec;
    check('an empty gate tail is a problem', validateRecord(emptyTail).some((p) => p.field === 'gate tail'), '');
    const empty = parseRecord('# Deploy ledger\n\n## Promotion record\n\n- commit: \n- gate: \n- gate exit: \n- gate tail:\n\n```text\n```\n\n- evidence: \n- rollback: \n- authorised: \n').rec;
    check('an empty record reports every field', validateRecord(empty).length === FIELDS.length, `${validateRecord(empty).length} of ${FIELDS.length}`);
    check('no section is not present', parseRecord('# Deploy ledger\n').present === false, '');
    const otherGate = parseRecord(complete.replace('- gate commit: 0123abc', '- gate commit: fedcba9')).rec;
    check('a gate commit that is not the record commit is a problem',
        validateRecord(otherGate).some((p) => p.field === 'gate commit' && /fedcba9.*0123abc/.test(p.why)), '');

    // The gate binding, against names written by hand.
    check('gateScriptName prefers gate', gateScriptName({ gate: 'a', 'gate:ci': 'b', preflight: 'c' }) === 'gate', '');
    check('gateScriptName falls back to preflight', gateScriptName({ preflight: 'c', test: 'd' }) === 'preflight', '');
    check('gateScriptName is null with neither', gateScriptName({ test: 'd' }) === null && gateScriptName(undefined) === null, '');
    const gateNames = [
        ['npm run gate', 'gate', null],
        ['pnpm gate', 'gate', null],
        ['bun run preflight', 'preflight', null],
        ['npm run gate:ci', 'gate', /variant of "gate"/],
        ['npm test', 'gate', /runs "test", not the gate script "gate"/],
        ['echo ok', 'gate', /runs no package script/],
        ['npm run gate && echo', 'gate', /runs no package script/],
    ];
    for (const [field, expected, want] of gateNames) {
        const got = gateNameProblem(field, expected, '0123abc');
        check(`gate "${field}" against "${expected}" -> ${want ? 'refused' : 'accepted'}`,
            want ? want.test(got || '') : got === null, `got ${got}`);
    }

    console.log(`[selftest] ${total} case(s) run, ${total - failed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
}

if (require.main === module) main();
else module.exports = { routeFor, WIDE, globToRegExp, sensitiveGlobsFrom, SCHEMA_DROP, SQL_RULES, stripSqlComments, parseRecord, validateRecord, FIELDS, gateScriptName, gateNameProblem };
