#!/usr/bin/env node
// check-superseded.js — find skills still teaching a convention the harness
// outgrew.
//
// Read-only. The failure this catches is a documentation cascade: one skill gets
// updated to a new harness capability and its siblings do not, so the plugin
// ships two or three mutually exclusive instructions for the same job and the
// model follows whichever it loaded. Observed 2026-08-17: `rule-windows` forbade
// `npm run dev` and prescribed `start cmd /k`, `browser` had already moved to
// `preview_start`, and `auto`/`test`/`scan` still instructed a detached Bash.
// Three live conventions, and nothing surfaced the contradiction.
//
// WHY A CLOSED DENYLIST, NOT AN ALLOWLIST OF GOOD PHRASING
// An allowlist over prose is an open set: a sibling checker written this month
// allowlisted "good" acceptance-criterion verbs and rejected its own reference
// example. Every entry below names one concrete superseded string, so the check
// is falsifiable and a miss is a missing row rather than a judgement call.
//
// WHY EVERY ENTRY CARRIES FIXTURES
// A staleness sweep run this month reported 2 hits across 51 skills; three of
// its five regexes fired zero times against known-stale input, so most of that
// "2" was the probe failing quietly. Here every entry must produce a finding
// from its `positive` fixture and must NOT produce one from its `negative`
// fixture, and the self-test runs those through `scanLines` — the same function
// that scans the tree. A self-test that reimplements the matching proves nothing
// about the scanner.
//
// Usage:
//   node check-superseded.js [--json] [--ref <git-ref>]
//
// --ref scans a historical revision instead of the working tree, which is how
// you mutation-test the table: point it at a commit from before a fix and
// confirm the finding reappears.

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
    // Print this file's own header block. A probe asking what this script is
    // must never cause it to DO what this script does: several entry points
    // here reach the network, and one made 21 registry calls from a --help
    // probe before this branch existed.
    const lines = require('fs').readFileSync(__filename, 'utf8').split('\n');
    const head = [];
    for (const line of lines.slice(1)) {
        if (line.trim() === "'use strict';") continue;
        if (/^\s*(\/\/|\/\*|\*|$)/.test(line)) head.push(line);
        else break;
    }
    console.log(head.join('\n').trim());
    process.exit(0);
}

const fs = require('fs');
const path = require('path');
// execFileSync, never execSync, for anything carrying a git ref.
//
// On Windows execSync runs the command through `cmd.exe /d /s /c`, where `^` is
// the escape character — so `git rev-parse HEAD^` returns HEAD's own sha instead
// of its parent's, silently and with exit 0. Measured 2026-08-17 in this repo:
// execSync gave af3bd7b (HEAD) where execFileSync gave faa3c21 (the real parent).
// That is fatal for --ref, whose entire purpose is pointing at an earlier commit:
// you ask for HEAD^, get HEAD's tree, see no findings, and conclude the detector
// is broken or the fix was never needed. It also removes a shell-metacharacter
// injection surface and handles refs containing spaces.
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const refIdx = argv.indexOf('--ref');
const REF = refIdx !== -1 ? argv[refIdx + 1] : null;

// SUPERSEDED_REPO_ROOT lets the check run from outside the repo while it is
// being developed. Sitting in tooling/, the default is correct.
const REPO = process.env.SUPERSEDED_REPO_ROOT || path.resolve(__dirname, '..');
const SKILL_GLOB_ROOT = path.join(REPO, 'plugins');

// ─────────────────── prohibition vs prescription ───────────────────────
//
// Rules used to carry a per-rule `exempt` regex tested against the whole line.
// Two independent adversarial reviews proved it swallowed the single
// highest-value violation shape — a stale sibling that forbids the NEW path
// while prescribing the OLD one:
//
//     "Don't use preview_start for Vite; run `start cmd /k` in a second window."
//
// `don't` appeared, so the line was exempt. That is exempt-by-construction for
// precisely the prose a stale skill actually writes, and the header still
// reported the rule as healthy. It leaked the other way too: the register real
// docs use for prohibitions — "`start cmd /k` was removed", "is deprecated",
// "is gone" — contains none of the keywords, so genuine prohibitions fired.
//
// The test is now positional and ORDERED, not keyword-soup:
//
//   1. Deprecation AFTER the match       -> exempt. "X was removed", "X is gone".
//      First, because such lines often also say "rather than", which step 2
//      would otherwise read as prescription.
//   2. Prescription AFTER the match      -> VIOLATION, unrescuable. "use X
//      instead of Y" teaches X no matter what else the line says.
//   3. Prohibition ADJACENT before       -> exempt. "Never `X`", "Don't use `X`".
//      Adjacency is the point: "Never skip auth — `curl -H ...`" prohibits
//      something else and must still fire.
//   4. Prohibition anywhere AFTER        -> exempt. "`X` hangs — never use it."
//
// Steps 1 and 4 read the following line too, and a wrapped prohibition
// ("- Never do this:" then the command) is handled by its own narrow rule,
// because loosening step 3 enough to span lines re-admits the "prohibits
// something else" false negative.

// `dropped` added 8.80.0. The banner written for the agent-browser migration said
// "the `agent-browser` steps were dropped in 8.79.0" — a plain deprecation notice
// in the register docs actually use — and all 8 copies fired. That is the same
// failure this vocabulary exists to prevent, one synonym further out; the fix is
// the synonym, not rewording the doc to suit the regex.
const DEPRECATED_AFTER = /^[^.;!?]{0,60}\b(?:is|was|are|were|has been|have been)?\s*(?:deprecated|removed|dropped|gone|obsolete|superseded|retired|banned|forbidden|no longer\b)/i;
const PRESCRIBED_AFTER = /^[^.;!?]{0,80}\b(?:instead|rather than|in place of)\b/i;
// Adjacent: an optional verb, then optionally an opening quote/bracket, then the match.
const FORBIDS_ADJACENT = /\b(?:never|don['’]t|do not|does not|avoid|not)\s+(?:ever\s+)?(?:use|run|write|call|invoke|pass|reach for)?\s*[`'"([]*$/i;
// A prohibition on its own preceding line, ending in a colon.
const FORBIDS_PREV_LINE = /\b(?:never|don['’]t|do not|avoid)\b[^.]{0,30}:\s*$/i;
// `reach for` added 8.80.0 alongside `dropped`: "do not reach for that CLI here"
// is a prohibition, and the vocabulary only knew the literal verb `use`.
const FORBIDS_AFTER = /\b(?:never (?:use|reach for)|don['’]t (?:use|reach for)|do not (?:use|reach for)|never\s+do\s+this|is banned|is forbidden|is prohibited|must not be used)\b/i;

// lines[i] is the matched line; m is the RegExp match on it.
function isExempt(lines, i, m) {
    const line = lines[i];
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + m[0].length);
    const next = lines[i + 1] || '';
    const prev = lines[i - 1] || '';

    if (DEPRECATED_AFTER.test(after) || DEPRECATED_AFTER.test(' ' + next.trim())) return true;
    if (PRESCRIBED_AFTER.test(after)) return false;          // prescribing the old way

    // A prohibition attaches to the whole `...` construct, but a rule's regex may
    // anchor deep inside it — rule 2 anchors on the package manager, which sits
    // well inside `Bash({ command: "npm run dev", run_in_background: true })`. So
    // adjacency is measured both against the raw prefix and against the text
    // before the code span opened.
    const spanStart = before.lastIndexOf('`');
    const beforeSpan = spanStart === -1 ? before : before.slice(0, spanStart);
    if (FORBIDS_ADJACENT.test(before) || FORBIDS_ADJACENT.test(beforeSpan)) return true;
    if (FORBIDS_PREV_LINE.test(prev)) return true;
    if (FORBIDS_AFTER.test(after) || FORBIDS_AFTER.test(next)) return true;
    return false;
}

// --------------------------------------------------------------- the table
//
// re              the superseded string, as it appears in an instruction
// requiresNearby  the line is only a finding when this marker is ABSENT within
//                 `within` lines either side. For half-finished migrations.
// fence           only flag inside a fenced block of these languages, or in a
//                 file matching `fileScope`. Keeps a bash `curl` from being read
//                 as a PowerShell mistake.
// positive        fixture lines that MUST yield a finding.
// negative        fixture lines that must NOT yield one. Catches a
//                 `requiresNearby` or an exemption so loose the rule can never
//                 fire. Both carry several shapes on purpose — a single-shape
//                 fixture is why the old exempt survived review for so long.
const SUPERSEDED = [
    {
        id: 'dev-server-external-terminal',
        re: /start\s+cmd\s+\/k/i,
        why: 'preview_start supervises the dev server and exposes preview_logs; an external terminal opens a window no tool can read, so a failed compile looks like a slow one',
        replacement: 'preview_start with a .claude/launch.json entry',
        positive: [
            '- Use external terminal: `start cmd /k "cd /d %CD% && npm run dev"`',
            "- Don't use preview_start for Vite; run `start cmd /k \"npm run dev\"` in a window.",
            '- Use `start cmd /k "npm run dev"` instead of a detached Bash.',
            '- Never skip the port check — `start cmd /k "npm run dev"` after netstat.',
        ],
        negative: [
            '- Never `start cmd /k`. It opens a window no tool can read.',
            '- Do not use `start cmd /k` for dev servers.',
            '- `start cmd /k` was removed in 8.72.0.',
            '- `start cmd /k` is gone rather than demoted to a fallback.',
            "- Don’t use `start cmd /k`.",
            '- Never do this:',
            '  `start cmd /k "npm run dev"`',
        ],
    },
    {
        id: 'dev-server-without-preview-start',
        // The half-migrated shape: a detached dev server with no mention of the
        // supervised path anywhere near it. This is the exact drift that left
        // auto/test/scan contradicting rule-windows for as long as both existed.
        // `\bdev\b` alone matched the `dev` in `/dev/null`, so
        // `Bash({ command: "npm run build > /dev/null", run_in_background: true })`
        // fired as a half-migrated dev server. Require `run dev` or `dev --`, and
        // exclude a following slash.
        re: /(?:npm|pnpm|yarn|bun|npx|vite|next)[^\n]*\b(?:run\s+dev|dev\b(?![/\\]))[^\n]*run_in_background/,
        requiresNearby: { re: /preview_start/, within: 6 },
        why: 'a detached dev server with no reference to preview_start is the half-migrated shape; preview_start supervises the process and exposes preview_logs, and skills that omit it drift out of step with the ones that name it',
        replacement: 'name preview_start as the preferred path and keep detached Bash as the stated fallback',
        positive: ['Bash({ command: "npm run dev", run_in_background: true })'],
        negative: [
            '# Prefer preview_start with a .claude/launch.json entry.',
            'Bash({ command: "npm run dev", run_in_background: true })',
            '',
            // `requiresNearby` was doing double duty as the migration test AND the
            // prohibition escape hatch, and they are not the same predicate: a line
            // banning the detached form fired whenever preview_start was absent.
            // The shared positional exemption now covers it.
            'Never use `Bash({ command: "npm run dev", run_in_background: true })` here.',
        ],
    },
    {
        id: 'bare-curl-on-windows',
        re: /(?:^|[^.\w-])curl\s+(?:-[A-Za-z]|'|")/,
        why: "in Windows PowerShell 5.1 `curl` is an alias for Invoke-WebRequest, which rejects -H/-d/-X with a parameter-binding error that never mentions curl (verified 2026-08-17: Get-Command curl -> CommandType: Alias)",
        replacement: 'curl.exe',
        fence: ['powershell', 'ps1', 'pwsh'],
        fileScope: /windows/i,
        positive: [
            "  - Read: `curl 'https://x.supabase.co/rest/v1/t?select=*' -H 'apikey: k'`",
            "  - Never skip auth — `curl -H 'apikey: k' https://x`",
            "  - Use `curl -H 'apikey: k' https://x` instead of Invoke-WebRequest.",
        ],
        negative: [
            "  - Read: `curl.exe 'https://x.supabase.co/rest/v1/t?select=*' -H 'apikey: k'`",
            "  - Never use `curl -H 'apikey: k' https://x` on PowerShell.",
            "  - `curl -H 'apikey: k' https://x` is deprecated here.",
        ],
        // The fixture has no fence, so it only fires via fileScope. Self-test
        // supplies a filename that matches.
        fixtureFile: 'plugins/autodev-core/skills/rule-windows/SKILL.md',
    },
    {
        id: 'collapsed-env-var-path',
        // Fires when a known env var is followed straight by a letter, digit or
        // dot. A correct path has a separator, quote, space or line end there.
        re: /\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|CLAUDE_PLUGIN_ROOT|TMPDIR|TEMP)(?=[A-Za-z0-9.])/,
        why: 'the path separators were eaten in transit, so PowerShell reads the whole run-together string as ONE variable name, which is empty; the command then globs nothing and returns silently, and an empty result reads exactly like a real negative (measured 2026-09-05, brain SKILL.md step 4b shipped this way)',
        replacement: 'the same path with its separators restored',
        fence: ['powershell', 'ps1', 'pwsh'],
        // The fixture arrays are scanned AS DOCUMENT LINES, so a fenced rule
        // needs its own fence opener here or it can never fire and the CLI
        // refuses to report at all. That refusal is correct and it caught this.
        positive: [
            '```powershell',
            'Get-ChildItem "$env:USERPROFILEclaude-memoryDECISIONS-*.md"',
            'node "$env:USERPROFILE.claudescriptsprobe.js"',
            '```',
        ],
        negative: [
            '```powershell',
            'Get-ChildItem "$env:USERPROFILE\\claude-memory\\DECISIONS-*.md"',
            '$B = "$env:USERPROFILE\\.claude\\plugins\\marketplaces"',
            'echo $env:CLAUDE_PLUGIN_ROOT',
            '```',
        ],
    },
    {
        id: 'supabase-db-query-linked',
        re: /supabase\s+db\s+query\s+--linked/,
        why: 'it triggers a Windows Firewall prompt and times out; the REST endpoint is the automatable path',
        replacement: 'curl.exe against <ref>.supabase.co/rest/v1/',
        positive: [
            'Run `supabase db query --linked` to read the table.',
            'Query the REST API instead: `supabase db query --linked` is simpler.',
            'To avoid the SDK, run `supabase db query --linked` directly.',
        ],
        negative: [
            '`supabase db query --linked` hangs behind the firewall — never use it.',
            'Never use `supabase db query --linked`.',
            '`supabase db query --linked` is no longer supported here.',
        ],
    },
    {
        id: 'outfile-dev-null',
        // NODE-SIDE path resolution only. Do not re-broaden this to `-o
        // /dev/null`: the first version did, and it flagged
        // `curl -s -o /dev/null -w "%{http_code}"` in auto and deploy as
        // defects. Measured 2026-08-17 against a control that wrote 92 bytes to
        // a real file: `curl.exe -o /dev/null` creates nothing and exits 0,
        // because curl is a native binary that handles the name itself. The trap
        // is specifically a tool that resolves the path in JS — bun, esbuild —
        // where the shell understands /dev/null and the tool does not.
        re: /--outfile[= ]"?\/dev\/null/,
        why: 'bun/esbuild resolve the path in JS and create a real file called `nul` in the repo; the reserved device name then makes it hard to delete',
        replacement: 'build into the session scratchpad instead',
        positive: [
            'bun build src/index.ts --outfile=/dev/null',
            'Build to `--outfile=/dev/null` rather than the scratchpad.',
            'bun build src/index.ts --outfile="/dev/null"',
        ],
        negative: [
            'Never use `--outfile=/dev/null` — it writes a real file called nul.',
            '`--outfile=/dev/null` is deprecated; build to the scratchpad.',
        ],
    },
    {
        id: 'agent-browser-cli',
        // The completion gate for the 8.79.0 migration. 249 references across 22
        // files were rewritten to the built-in browser tools; the risk is not the
        // ones that were fixed but a new skill copying the old shape from an older
        // sibling, which is exactly how the dev-server contradiction spread.
        //
        // Scoped to plugins/ by the scanner, so the historical mentions in
        // CHANGELOG.md, MIGRATION.md and README.md stay legal — a changelog that
        // cannot name what it removed is useless.
        re: /\bagent-browser\b/,
        why: 'the agent-browser CLI and its cleanup hook were removed in 8.79.0; the built-in browser tools (navigate/read_page/computer/resize_window) and chrome-devtools emulate replace it, and a skill still prescribing the CLI instructs a binary that is not installed',
        replacement: 'mcp__Claude_Browser__* tools, or chrome-devtools emulate for mobile device gates',
        positive: [
            'agent-browser open http://localhost:3000',
            '| UX/UI | agent-browser screenshots (desktop + mobile) |',
            'Use agent-browser (preferred — token efficient) or Playwright.',
            '- Run `agent-browser snapshot -i` instead of read_page.',
        ],
        negative: [
            'The `agent-browser` CLI was removed in 8.79.0 — both predate these tools.',
            'Never use `agent-browser` — it was replaced by the built-in tools.',
            '`agent-browser` is deprecated; use navigate + read_page.',
        ],
    },
];

// --------------------------------------------------------------- the scan
//
// One function, used by both the self-test and the tree walk. If these were two
// implementations the self-test would be testing the wrong one.
function scanLines(lines, rel) {
    const out = [];
    let fenceLang = null;
    let fenceOpen = null;   // { char, len } of the open fence's marker, or null

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track the fenced-block language so a bash `curl` is not read as a
        // PowerShell one. A ``` with no language opens or closes an unlabelled block.
        // Fence tracking must match the MARKER TYPE and LENGTH, not just toggle.
        //
        // A bare toggle gets three shapes wrong, all measured: `~~~powershell`
        // (valid CommonMark) is invisible; a ````markdown wrapper containing a
        // ```powershell opener reads the inner opener as a closer and inverts the
        // state for the rest of the file; and an unclosed fence leaks its language
        // to EOF, so prose 20 lines later is scanned as PowerShell.
        //
        // CommonMark: a fence closes only on the same character, at least as long
        // as the opener, with no info string. So remember both.
        const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+{}.-]*)\s*$/.exec(line);
        if (fence) {
            const marker = fence[1], info = (fence[2] || '').toLowerCase();
            if (fenceOpen === null) {
                fenceOpen = { char: marker[0], len: marker.length };
                // Strip an Rmd-style info string: ```{powershell} -> powershell
                fenceLang = info.replace(/^\{|\}$/g, '');
            } else if (marker[0] === fenceOpen.char && marker.length >= fenceOpen.len && !info) {
                fenceOpen = null;
                fenceLang = null;
            }
            // A longer/other-type marker inside an open fence is content, not a
            // delimiter — fall through and leave the state alone.
            continue;
        }

        for (const s of SUPERSEDED) {
            const m = s.re.exec(line);
            if (!m) continue;
            // Positional prohibition/prescription test — see isExempt above. This
            // replaced a per-rule whole-line keyword regex that exempted the
            // highest-value violation shape by construction.
            if (isExempt(lines, i, m)) continue;

            if (s.fence) {
                const inLang = fenceLang !== null && s.fence.includes(fenceLang);
                // fileScope must not override the fence for shell languages.
                //
                // `if (!inLang && !inFile)` meant any file whose PATH matched
                // fileScope ignored the fence entirely — so a ```bash block inside
                // rule-windows/SKILL.md fired, which is the exact false positive
                // the fence exists to prevent (rules/windows.md explicitly blesses
                // bash examples there: "open Git Bash — these assume bash").
                const shellFence = ['bash', 'sh', 'zsh', 'shell', 'console'].includes(fenceLang);
                const inFile = !shellFence && s.fileScope && s.fileScope.test(rel);
                if (!inLang && !inFile) continue;
            }

            // Half-migration check: present nearby means already migrated.
            if (s.requiresNearby) {
                const lo = Math.max(0, i - s.requiresNearby.within);
                const hi = Math.min(lines.length, i + s.requiresNearby.within + 1);
                if (s.requiresNearby.re.test(lines.slice(lo, hi).join('\n'))) continue;
            }

            out.push({
                id: s.id, file: rel, line: i + 1,
                text: line.trim().slice(0, 160),
                why: s.why, replacement: s.replacement,
            });
        }
    }
    return out;
}

// ------------------------------------------------------------- self-test
//
// Two-sided, through scanLines. A rule must fire on its positive and stay quiet
// on its negative. One-sided testing is how a rule whose `exempt` swallows
// everything ships looking healthy.
function selfTest() {
    const broken = [];
    for (const s of SUPERSEDED) {
        const file = s.fixtureFile || 'plugins/fixture/SKILL.md';

        const hitsPos = scanLines(s.positive, file).filter((f) => f.id === s.id);
        if (!hitsPos.length) {
            broken.push(`${s.id}: positive fixture produced no finding — the rule cannot fire`);
        }

        if (s.negative) {
            // Deliberately UNFILTERED. This used to read `.filter((f) => f.id === s.id)`,
            // and the 2026-08-17 mutation sweep flipped that `===` to `!==` without the
            // suite noticing: the mutant counted every OTHER rule's findings instead of
            // this one's, which is also zero, so it passed. Asserting that a corrected
            // form trips NO rule is both stronger than the filtered version and leaves
            // no comparison to mutate. Measured the same day across all 5 rules: every
            // negative fixture produces zero findings from any rule, so nothing is lost.
            const hitsNeg = scanLines(s.negative, file);
            if (hitsNeg.length) {
                const ids = [...new Set(hitsNeg.map((f) => f.id))].join(', ');
                broken.push(`${s.id}: negative fixture produced a finding (${ids}) — a corrected form must trip no rule`);
            }
        }
    }
    return broken;
}

// ------------------------------------------------------------- collection
function skillFiles() {
    if (REF) {
        const out = execFileSync('git', ['ls-tree', '-r', '--name-only', REF, '--', 'plugins'], {
            cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24,
        });
        return out.split('\n').filter((f) => f.endsWith('.md'));
    }
    const found = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.md')) found.push(path.relative(REPO, full).replace(/\\/g, '/'));
        }
    })(SKILL_GLOB_ROOT);
    return found;
}

const readFile = (rel) => {
    if (REF) {
        try {
            return execFileSync('git', ['show', REF + ':' + rel], {
                cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch { return null; }
    }
    try { return fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { return null; }
};

// ------------------------------------------------------------------- run
//
// Exported so the suite can drive the REAL matcher instead of a copy. A suite
// that reimplements scanLines proves its reimplementation correct and says
// nothing about this file.
module.exports = { SUPERSEDED, scanLines, selfTest };

// Node wraps a CommonJS module in a function, so a top-level return is legal and
// skips the CLI when this file is required. Keeps the scan below unindented.
if (require.main !== module) return;

const broken = selfTest();
if (broken.length) {
    console.error('\nDETECTOR BROKEN — refusing to report on the tree:\n');
    for (const b of broken) console.error(`  ✗ ${b}`);
    console.error('\nFix the rule or the fixture. A green run from a rule that cannot fire is\nindistinguishable from a clean repo.\n');
    process.exit(2);
}

const findings = [];
let filesScanned = 0;
let linesScanned = 0;

for (const rel of skillFiles()) {
    const text = readFile(rel);
    if (text === null) continue;
    filesScanned++;
    const lines = text.split('\n');
    linesScanned += lines.length;
    findings.push(...scanLines(lines, rel));
}

// A scan of zero files is a broken probe, not a clean repo.
//
// `git ls-tree` exits 0 with EMPTY output when the pathspec matches nothing, so
// `--ref <commit-before-plugins/-existed>` used to print "0 markdown file(s)"
// followed by a green tick and exit 0 — the disk path at least throws ENOENT.
// Printing the population is not enough if nothing acts on it.
if (!filesScanned) {
    console.error(`\nREFUSING TO REPORT: scanned 0 files under ${path.relative(REPO, SKILL_GLOB_ROOT) || 'plugins'}`
        + (REF ? ` at ref ${REF}.` : '.'));
    console.error('');
    console.error('A zero-file population is a broken probe, not a clean tree — the path may not');
    console.error('exist at this ref (plugins/ arrived with the v8 restructure), or the directory');
    console.error('layout moved. Check with:');
    console.error(`  git ls-tree -r --name-only ${REF || 'HEAD'} -- plugins | head`);
    console.error('');
    process.exit(2);
}

// --------------------------------------------------------------- reporting
if (asJson) {
    console.log(JSON.stringify({
        ref: REF || 'working tree',
        population: { filesScanned, linesScanned, patterns: SUPERSEDED.length },
        findings,
    }, null, 2));
    process.exit(findings.length ? 1 : 0);
}

// Population first, always. A verdict with no population is indistinguishable
// from a finder that returned nothing.
console.log(`\nSuperseded-convention scan — ${REF || 'working tree'}`);
console.log(`  scanned : ${filesScanned} markdown file(s), ${linesScanned} lines`);
console.log(`  patterns: ${SUPERSEDED.length} active, each proved against a positive and a negative fixture`);
console.log(`  scoped  : ${SUPERSEDED.filter((s) => s.fence).map((s) => s.id).join(', ') || 'none'} fire only in a matching fenced block or filename\n`);

if (!findings.length) {
    console.log('  ✓ no superseded convention found in the population above\n');
    process.exit(0);
}

findings.sort((a, b) => (a.id + a.file).localeCompare(b.id + b.file));
let lastId = '';
for (const f of findings) {
    if (f.id !== lastId) {
        console.log(`  [${f.id}]`);
        console.log(`    why: ${f.why}`);
        console.log(`    use: ${f.replacement}`);
        lastId = f.id;
    }
    console.log(`    → ${f.file}:${f.line}`);
    console.log(`      ${f.text}`);
}
console.log(`\n${findings.length} finding(s) across ${filesScanned} file(s). Nothing was modified.\n`);
process.exit(1);
