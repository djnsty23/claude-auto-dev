#!/usr/bin/env node
'use strict';

// deploy-ledger.js — what changed since the last production push, which user
// -facing surfaces it touches, whether each was actually checked, and since
// 2026-09-08 the RECORD a production promotion must carry before it is allowed.
//
// The problem this exists for: the verification discipline is written down in
// several skills and enforced by nothing. "Screenshot at 390 and 414" is prose,
// a human decides which screens were affected, and a deploy can be called
// verified with no record of what was looked at. A rule with no gate is a rule
// that gets skipped, and the surface most likely to be skipped is the one
// nobody remembered was touched.
//
// THE STANDING RULE THIS ENFORCES. `[stated 2026-09-08]` the operator chose Form
// B, and the sentence he selected is:
//
//   A session may promote to production when the repo's named gate exits 0 on
//   the exact commit being deployed, that commit is on the default branch, the
//   deploy ledger records the commit, the gate's output and the post-deploy
//   verification, and the rollback command for this deploy is written into the
//   ledger before the promotion. A deploy that touches anything on the
//   ineligible list is escalated whatever the gate says.
//
// So a production promotion needs no panel and no message to a coordinator WHEN
// this file's --verify exits 0, and it is not authorised by anything else: not a
// green CI badge, not a preview that looked fine, not a coordinator relaying a
// yes. The four exit codes below are the whole policy.
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
//   --since <ref>   list the commits and touched surfaces since a ref
//   --write         create or refresh the ledger file, preserving what was filled
//   --verify        the promotion gate. exit 0 = promote; anything else = do not
//   --record        after the promotion: file the ledger and move the deploy marker
//   --audit         list every recorded promotion and whether its record is complete
//
// --verify EXIT CODES, each a different instruction to the reader:
//   0  pre-authorised. Zero bytes on stdout and stderr, because this runs as
//      `--verify && <promote>` and text on the pass path is skimmed, never read.
//   1  a precondition is unmet and the message names it: a surface unchecked,
//      metrics missing, a promotion field empty or wrong, or the commit not on
//      the default branch. All of these are yours to fix; re-run after.
//   2  blind: not a repo, no deploy ref, no ledger, no resolvable default
//      branch, or the project has not marked its deploy-sensitive paths.
//      Nothing was decided.
//   3  INELIGIBLE: the window touches something on the ineligible list. No
//      amount of filling fixes this; it needs the operator's yes in that turn.
//
// It derives the surface list from the diff. It does NOT decide whether a check
// passed: a human or a browser-driving agent fills the boxes, and --verify only
// asks whether they are filled. A checker that both generates and satisfies its
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
const DEFAULT_LEDGER_DIR = 'deploy-ledgers';

// stderr is PIPED, not inherited. execFileSync sends a child's stderr to the
// parent's by default, and resolving the default branch probes refs that are
// legitimately absent (`origin/main` in a repo with no remote), so the default
// leaked two `fatal: Needed a single revision` lines onto a run that must print
// zero bytes. Caught by the suite's own zero-bytes assertion.
const git = (...args) => {
    try {
        return execFileSync('git', ['-C', ROOT, ...args],
            { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

// Every reason this window cannot be pre-authorised. Empty array = eligible.
function ineligibility(sinceRef, files, marking) {
    const hits = [];
    const matchers = marking.globs.map((g) => ({ g, re: globToRegExp(g) }));
    for (const f of files) {
        for (const { g, re } of matchers) {
            if (re.test(f)) { hits.push({ kind: 'path', file: f, why: `matches deploy-sensitive \`${g}\` (${marking.source})` }); break; }
        }
    }
    const diff = git('diff', '--unified=0', `${sinceRef}..HEAD`, '--', '*.sql', '**/*.sql');
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

const FIELDS = ['commit', 'gate', 'gate exit', 'gate tail', 'evidence', 'rollback', 'authorised'];
const STATED = /\[stated \d{4}-\d{2}-\d{2}\]/;
const PLACEHOLDER = /<[^>]+>|\[[^\]]*\]|\bTODO\b|\bTBD\b/i;

// Parses `- field: value` lines and the fenced block after `- gate tail:`.
// Tolerant of `authorized`. Missing fields come back as ''.
function parseRecord(text) {
    const rec = {};
    for (const f of FIELDS) rec[f] = '';
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^##\s+Promotion record/i.test(l));
    if (start < 0) return { rec, present: false };
    for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) break;
        const m = lines[i].match(/^- (commit|gate exit|gate tail|gate|evidence|rollback|authori[sz]ed):\s*(.*)$/i);
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

// Returns { text, reset }. `reset` is true when the previous ledger belonged to
// a DIFFERENT window and nothing from it was kept.
function render(sinceRef, how, s, commits, previous, head, baseSha) {
    // Preserve ticks a human already made, keyed on the row label. A regenerate
    // that silently unchecks everything trains people to regenerate less often,
    // and a stale ledger is worse than a noisy one.
    //
    // BUT ONLY WITHIN ONE WINDOW. `[measured 2026-09-08]` the first version kept
    // fields by name regardless, so after a promotion was filed the next window's
    // --write inherited the previous gate tail, evidence and authorisation and
    // --verify passed a window nobody had run a gate on. The base commit in the
    // header is what makes "same window" decidable.
    const prevBase = (previous || '').match(/window base ([0-9a-f]{7,40})/);
    const reset = !!previous && !(prevBase && baseSha && baseSha.startsWith(prevBase[1]));
    if (reset) previous = null;
    const kept = new Map();
    for (const line of (previous || '').split('\n')) {
        const m = line.match(/^\| (`[^`]+`|WIDE[^|]*|[^|]+?) \|[^|]*\|(.*)$/);
        if (m && /\[[xX]\]/.test(m[2])) kept.set(m[1].trim(), line);
    }
    const row = (label, detail) => kept.get(label) || ROW(label, detail);
    const prev = previous ? parseRecord(previous).rec : null;
    const keep = (f, fallback) => (prev && prev[f] ? prev[f] : fallback);

    const lines = [];
    lines.push('# Deploy ledger');
    lines.push('');
    lines.push(`Generated from \`${sinceRef}..HEAD\` (${how}; window base ${baseSha || 'unknown'}). Regenerate with`);
    lines.push('`deploy-ledger.js --write`; ticks and filled fields are kept while the window base is the same.');
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
    // A recorded-or-waived metrics line survives a regenerate for the same
    // reason ticks do.
    const prevMetrics = (previous || '').split('\n').find((l) => /- \[[xX]\] metrics recorded or waived:\s*\S/.test(l));
    lines.push(prevMetrics || '- [ ] metrics recorded or waived:');
    lines.push('');
    lines.push('## Promotion record');
    lines.push('');
    lines.push('Production promotion is pre-authorised on a green gate with this ledger, and');
    lines.push('on nothing else (`[stated 2026-09-08]`, ship skill Step 5b). `--verify` exits 1');
    lines.push('while a field below is empty or wrong, 3 while the window touches a');
    lines.push('deploy-sensitive path, and 0 with no output when the promotion may proceed.');
    lines.push('Fill every field by hand; only the commit is derived, and it is re-checked.');
    lines.push('');
    // The commit is DERIVED, never kept: keeping it is how the first run of the
    // suite produced a ledger that regenerated itself stale.
    lines.push(`- commit: ${head || ''}`);
    lines.push(`- gate: ${keep('gate', '')}`);
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

function population(s, sinceRef, how) {
    console.log(`[population] ${sinceRef}..HEAD (${how}): ${s.files.length} file(s) changed, `
        + `${s.ui.length} user-facing, ${s.routed.size} route(s) derived, `
        + `${s.wide.length} wide-effect, ${s.unrouted.length} without a route`);
    console.log('[scope] routes are derived by convention (app/, pages/, src/routes/); a project '
        + 'routing otherwise lists files without a route. A wide-effect file marks EVERY surface '
        + 'affected rather than guessing narrower. Metrics are never derived.');
}

function usage() {
    console.log([
        'deploy-ledger.js — the record a production promotion must carry',
        '',
        '  --since <ref>            list commits and touched surfaces since a ref',
        '  --write [--since <ref>]  create or refresh DEPLOY-LEDGER.md, keeping filled fields',
        '  --verify                 the promotion gate: 0 promote / 1 incomplete / 2 blind / 3 ineligible',
        '  --verify --verbose       same, but print the population on the pass path too',
        '  --record                 after promoting: file the ledger under deploy-ledgers/ and move .claude/last-deploy',
        '  --audit [--ledger-dir d] list every recorded promotion and whether its record is complete',
        '  --selftest               prove the derivations and the record validator can fire',
        '',
        'Deploy-sensitive paths come from the project CLAUDE.md, under a heading containing',
        '"Deploy-sensitive", one backticked glob per bullet, or the bullet `none`.',
    ].join('\n'));
}

// The whole verification, shared by --verify and --record. Returns
// { code, lines } and prints nothing itself, so --verify can be silent on 0.
function verify(ref, how, s, headFull) {
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
    const hits = ineligibility(ref, s.files, marking);
    if (hits.length) {
        out.push(`[ineligible] ${hits.length} reason(s) this window cannot be pre-authorised `
            + `(${marking.globs.length} deploy-sensitive glob(s) from ${marking.source}, ${s.files.length} file(s) in the window):`);
        for (const h of hits) out.push(`  INELIGIBLE  ${h.file}  ${h.why}`);
        out.push('Promotion of this window needs the operator\'s yes in that turn. No field fixes this.');
        return { code: 3, lines: out };
    }
    const text = fs.readFileSync(LEDGER, 'utf8');
    const unchecked = text.split('\n').filter((l) => /^\|/.test(l) && /\[ \]/.test(l));
    const metrics = /- \[[xX]\] metrics recorded or waived:\s*\S/.test(text);
    const { rec, present } = parseRecord(text);
    const problems = present ? validateRecord(rec, { head: headFull, root: ROOT })
        : [{ field: 'promotion record', why: 'section missing: re-run --write' }];

    // "that commit is on the default branch". Remediable by landing the branch,
    // so it is exit 1 beside the fields rather than exit 3: nothing here needs
    // the operator, it needs the commit to be somewhere everyone can see.
    const db = defaultBranch();
    if (!db) {
        return {
            code: 2, err: [
                'COULD NOT VERIFY: no default branch resolvable (no origin/HEAD, no origin/main, origin/master, main or master).',
                'The rule requires the promoted commit to be ON the default branch, and that cannot be checked here.',
                'Set it with: git remote set-head origin -a',
            ],
        };
    }
    if (!gitOk('merge-base', '--is-ancestor', headFull, db.ref)) {
        problems.push({
            field: 'default branch',
            why: `${headFull.slice(0, 7)} is not on ${db.ref} (${db.how}). Land it there before promoting`,
        });
    }

    if (unchecked.length || !metrics || problems.length) {
        out.push(`[verify] ${unchecked.length} row(s) with an unchecked box; metrics ${metrics ? 'recorded' : 'NOT recorded'}; `
            + `${problems.length} promotion field(s) missing or wrong`);
        for (const l of unchecked) out.push('  UNCHECKED  ' + l.split('|')[1].trim());
        if (!metrics) out.push('  UNCHECKED  metrics');
        for (const p of problems) out.push(`  MISSING    ${p.field}: ${p.why}`);
        return { code: 1, lines: out };
    }
    return { code: 0, lines: [], marking, rec, db };
}

function main() {
    const argv = process.argv.slice(2);
    const sinceIdx = argv.indexOf('--since');
    const explicit = sinceIdx >= 0 ? argv[sinceIdx + 1] : null;
    const dirIdx = argv.indexOf('--ledger-dir');
    const ledgerDir = path.resolve(ROOT, dirIdx >= 0 ? argv[dirIdx + 1] : DEFAULT_LEDGER_DIR);

    if (argv.includes('--help') || argv.includes('-h')) return usage();
    if (argv.includes('--selftest')) return selftest();
    if (argv.includes('--audit')) return audit(ledgerDir);

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
    const headFull = (git('rev-parse', 'HEAD') || '').toLowerCase();

    if (argv.includes('--verify') || argv.includes('--record')) {
        const v = verify(ref, how, s, headFull);
        if (v.code === 2) { for (const l of v.err) console.error(l); process.exit(2); }
        if (v.code !== 0) {
            population(s, ref, how);
            for (const l of v.lines) console.log(l);
            if (argv.includes('--record')) console.log('[record] refusing to record a promotion the ledger does not authorise');
            process.exit(v.code);
        }
        if (argv.includes('--record')) return record(ledgerDir, headFull, s, ref, how);
        if (argv.includes('--verbose')) {
            population(s, ref, how);
            console.log(`[verify] eligible (${v.marking.globs.length} deploy-sensitive glob(s) + ${SQL_RULES.length} SQL rule(s), 0 hits), `
                + `on ${v.db.ref}, every surface checked, every promotion field present. `
                + `Promotion of ${headFull.slice(0, 7)} is pre-authorised.`);
        }
        return;   // exit 0 with zero bytes: the chain reads the code, not the text
    }

    population(s, ref, how);
    if (argv.includes('--write')) {
        const previous = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : null;
        const baseSha = (git('rev-parse', ref + '^{commit}') || '').toLowerCase();
        const { text, reset } = render(ref, how, s, commits, previous, headFull, baseSha);
        fs.writeFileSync(LEDGER, text, 'utf8');
        console.log(`[write] ${path.relative(ROOT, LEDGER)} updated`
            + (reset ? ' (previous ledger was for a different window; started blank)'
                : previous ? ' (existing ticks and filled fields preserved)' : ''));
        return;
    }
    for (const [r, files] of s.routed) console.log(`  ${r}  <- ${files.join(', ')}`);
    for (const f of s.unrouted) console.log(`  (no route)  ${f}`);
    for (const f of s.wide) console.log(`  WIDE  ${f}`);
}

// Files the ledger the promotion ran under, named by time and commit so the
// audit can read both without opening it, and moves the deploy marker so the
// next window starts here. Warns when the directory is gitignored: a ledger
// only this machine can read is invisible to the session that audits next.
function record(ledgerDir, headFull, s, ref, how) {
    fs.mkdirSync(ledgerDir, { recursive: true });
    // 20260908T061530Z: compact so it sorts as text and the audit can read the
    // commit off the name without opening the file.
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/\d{3}Z$/, 'Z');
    const dest = path.join(ledgerDir, `${stamp}-${headFull.slice(0, 7)}.md`);
    fs.copyFileSync(LEDGER, dest);
    const markerDir = path.join(ROOT, '.claude');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'last-deploy'), headFull + '\n', 'utf8');
    population(s, ref, how);
    console.log(`[record] ${path.relative(ROOT, dest)} filed; .claude/last-deploy -> ${headFull.slice(0, 7)}`);
    const ignored = git('check-ignore', '-q', path.relative(ROOT, dest));
    if (ignored !== null) {
        console.log(`[record] WARNING ${path.relative(ROOT, ledgerDir)}/ is gitignored, so this record never leaves this machine. `
            + 'Track it, or pass --ledger-dir <tracked dir>.');
    }
}

// Every recorded promotion, and whether its record is complete. Reads what is on
// disk and nothing else: the diff that made a window eligible is gone, so the
// audit answers "was each promotion recorded properly", not "was it eligible".
function audit(ledgerDir) {
    const rel = path.relative(ROOT, ledgerDir) || '.';
    if (!fs.existsSync(ledgerDir) || !fs.statSync(ledgerDir).isDirectory()) {
        console.error(`COULD NOT AUDIT: ${rel}/ does not exist. No promotion has been recorded with --record, `
            + 'or they were recorded elsewhere (pass --ledger-dir).');
        process.exit(2);
    }
    const files = fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.md')).sort();
    if (!files.length) {
        console.log(`[audit] 0 promotion(s) in ${rel}/; nothing was audited`);
        return;
    }
    let incomplete = 0;
    for (const f of files) {
        const text = fs.readFileSync(path.join(ledgerDir, f), 'utf8');
        const { rec, present } = parseRecord(text);
        const problems = present ? validateRecord(rec, { root: ROOT }) : [{ field: 'promotion record', why: 'section missing' }];
        const named = f.match(/-([0-9a-f]{7})\.md$/i);
        if (named && rec.commit && !rec.commit.toLowerCase().startsWith(named[1].toLowerCase())) {
            problems.push({ field: 'commit', why: `file is named for ${named[1]} but the record says ${rec.commit.slice(0, 7)}` });
        }
        const unchecked = text.split('\n').filter((l) => /^\|/.test(l) && /\[ \]/.test(l)).length;
        if (unchecked) problems.push({ field: 'surfaces', why: `${unchecked} row(s) unchecked` });
        if (problems.length) {
            incomplete++;
            console.log(`  INCOMPLETE  ${f}  ${problems.map((p) => `${p.field}: ${p.why}`).join('; ')}`);
        } else {
            console.log(`  COMPLETE    ${f}  commit ${rec.commit.slice(0, 7)}  gate ${rec.gate}  ${rec.authorised.match(STATED)[0]}`);
        }
    }
    console.log(`[audit] ${files.length} promotion(s) in ${rel}/, ${files.length - incomplete} complete, ${incomplete} incomplete`);
    process.exit(incomplete ? 1 : 0);
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
        '- commit: 0123abc', '- gate: npm run gate', '- gate exit: 0', '- gate tail:', '', '```text', 'ALL 61 SUITES PASSED', '```', '',
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

    console.log(`[selftest] ${total} case(s) run, ${total - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
else module.exports = { routeFor, WIDE, globToRegExp, sensitiveGlobsFrom, SCHEMA_DROP, SQL_RULES, stripSqlComments, parseRecord, validateRecord, FIELDS };
