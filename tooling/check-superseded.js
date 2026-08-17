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

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const refIdx = argv.indexOf('--ref');
const REF = refIdx !== -1 ? argv[refIdx + 1] : null;

// SUPERSEDED_REPO_ROOT lets the check run from outside the repo while it is
// being developed. Sitting in tooling/, the default is correct.
const REPO = process.env.SUPERSEDED_REPO_ROOT || path.resolve(__dirname, '..');
const SKILL_GLOB_ROOT = path.join(REPO, 'plugins');

// --------------------------------------------------------------- the table
//
// re              the superseded string, as it appears in an instruction
// exempt          same line, but talking ABOUT the convention (a prohibition, a
//                 "superseded" note). Not a violation.
// requiresNearby  the line is only a finding when this marker is ABSENT within
//                 `within` lines either side. For half-finished migrations.
// fence           only flag inside a fenced block of these languages, or in a
//                 file matching `fileScope`. Keeps a bash `curl` from being read
//                 as a PowerShell mistake.
// positive        fixture lines that MUST yield a finding.
// negative        fixture lines that must NOT yield one. Catches an `exempt` or
//                 a `requiresNearby` so loose the rule can never fire.
const SUPERSEDED = [
    {
        id: 'dev-server-external-terminal',
        re: /start\s+cmd\s+\/k/i,
        exempt: /never|don't|do not|instead of|superseded|no tool can read|avoid/i,
        why: 'preview_start supervises the dev server and exposes preview_logs; an external terminal opens a window no tool can read, so a failed compile looks like a slow one',
        replacement: 'preview_start with a .claude/launch.json entry',
        positive: ['- Use external terminal: `start cmd /k "cd /d %CD% && npm run dev"`'],
        negative: ['- Never `start cmd /k`. It opens a window no tool can read.'],
    },
    {
        id: 'dev-server-without-preview-start',
        // The half-migrated shape: a detached dev server with no mention of the
        // supervised path anywhere near it. This is the exact drift that left
        // auto/test/scan contradicting rule-windows for as long as both existed.
        re: /(?:npm|pnpm|yarn|bun)[^\n]*\bdev\b[^\n]*run_in_background/,
        requiresNearby: { re: /preview_start/, within: 6 },
        why: 'a detached dev server with no reference to preview_start is the half-migrated shape; preview_start supervises the process and exposes preview_logs, and skills that omit it drift out of step with the ones that name it',
        replacement: 'name preview_start as the preferred path and keep detached Bash as the stated fallback',
        positive: ['Bash({ command: "npm run dev", run_in_background: true })'],
        negative: [
            '# Prefer preview_start with a .claude/launch.json entry.',
            'Bash({ command: "npm run dev", run_in_background: true })',
        ],
    },
    {
        id: 'bare-curl-on-windows',
        re: /(?:^|[^.\w-])curl\s+(?:-[A-Za-z]|'|")/,
        exempt: /curl\.exe|never|don't|do not|alias|superseded|instead/i,
        why: "in Windows PowerShell 5.1 `curl` is an alias for Invoke-WebRequest, which rejects -H/-d/-X with a parameter-binding error that never mentions curl (verified 2026-08-17: Get-Command curl -> CommandType: Alias)",
        replacement: 'curl.exe',
        fence: ['powershell', 'ps1', 'pwsh'],
        fileScope: /windows/i,
        positive: ["  - Read: `curl 'https://x.supabase.co/rest/v1/t?select=*' -H 'apikey: k'`"],
        negative: ["  - Read: `curl.exe 'https://x.supabase.co/rest/v1/t?select=*' -H 'apikey: k'`"],
        // The fixture has no fence, so it only fires via fileScope. Self-test
        // supplies a filename that matches.
        fixtureFile: 'plugins/autodev-core/skills/rule-windows/SKILL.md',
    },
    {
        id: 'supabase-db-query-linked',
        re: /supabase\s+db\s+query\s+--linked/,
        exempt: /never|don't|do not|hangs|times out|instead|superseded|avoid|firewall/i,
        why: 'it triggers a Windows Firewall prompt and times out; the REST endpoint is the automatable path',
        replacement: 'curl.exe against <ref>.supabase.co/rest/v1/',
        positive: ['Run `supabase db query --linked` to read the table.'],
        negative: ['`supabase db query --linked` hangs behind the firewall — never use it.'],
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
        re: /--outfile[= ]\/dev\/null/,
        exempt: /never|don't|do not|writes a real|superseded|instead|scratchpad/i,
        why: 'bun/esbuild resolve the path in JS and create a real file called `nul` in the repo; the reserved device name then makes it hard to delete',
        replacement: 'build into the session scratchpad instead',
        positive: ['bun build src/index.ts --outfile=/dev/null'],
        negative: ['Never use `--outfile=/dev/null` — it writes a real file called nul.'],
    },
];

// --------------------------------------------------------------- the scan
//
// One function, used by both the self-test and the tree walk. If these were two
// implementations the self-test would be testing the wrong one.
function scanLines(lines, rel) {
    const out = [];
    let fenceLang = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track the fenced-block language so a bash `curl` is not read as a
        // PowerShell one. A ``` with no language opens or closes an unlabelled block.
        const fence = /^\s*```+\s*([A-Za-z0-9_+-]*)/.exec(line);
        if (fence) {
            fenceLang = fenceLang === null ? (fence[1] || '').toLowerCase() : null;
            continue;
        }

        for (const s of SUPERSEDED) {
            if (!s.re.test(line)) continue;
            if (s.exempt && s.exempt.test(line)) continue;

            if (s.fence) {
                const inLang = fenceLang !== null && s.fence.includes(fenceLang);
                const inFile = s.fileScope && s.fileScope.test(rel);
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
            const hitsNeg = scanLines(s.negative, file).filter((f) => f.id === s.id);
            if (hitsNeg.length) {
                broken.push(`${s.id}: negative fixture produced a finding — the rule flags its own corrected form`);
            }
        }
    }
    return broken;
}

// ------------------------------------------------------------- collection
function skillFiles() {
    if (REF) {
        const out = execSync(`git ls-tree -r --name-only ${REF} -- plugins`, {
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
            return execSync(`git show ${REF}:${rel}`, {
                cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch { return null; }
    }
    try { return fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { return null; }
};

// ------------------------------------------------------------------- run
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
