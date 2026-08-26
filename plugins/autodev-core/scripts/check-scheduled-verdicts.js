#!/usr/bin/env node
/**
 * check-scheduled-verdicts - find scheduled jobs that write a gating value, and
 * report whether anything bounds how long that value stays authoritative.
 *
 * THE DEFECT THIS EXISTS FOR, in full, because the shape is the whole point.
 *
 * A five-minute cron measured save health, decided the state was bad, and wrote
 * `{enabled: true, severity: "outage"}` into a settings row. Another file read
 * that row and refused to run the product's primary action while it was set. The
 * measurement was taken in a window with ZERO traffic, on four records that a
 * backfill queue drained normally minutes later. Nothing was broken. The verdict
 * outlived its evidence by 9.7 hours and could not clear itself, because the
 * cron's own low-sample guard returned before it re-read the row: outage blocked
 * the action, so no traffic was recorded, so the sample stayed empty, so the
 * guard kept returning. Self-reinforcing.
 *
 * A scheduled job that writes a verdict needs the same two things a production
 * scheduler gives a CronJob, and for the same reasons:
 *
 *   A STALENESS BOUND, so an old verdict stops being authoritative. This is the
 *   scheduler's "skip runs older than N", moved from the run to the decision.
 *
 *   A STARTUP ALLOWANCE, so a young state is not judged before its evidence
 *   exists. This is the startup probe that stops a liveness check killing a pod
 *   which is merely still booting. In the incident above, four records that were
 *   not yet backfilled were read as permanently lost.
 *
 * Those are the same idea from opposite ends, and the incident was missing both.
 *
 * WHY THE OUTPUT IS NOT A BINARY. The offending file DID contain a TTL constant
 * and an expiry function. They applied to a different class of row than the one
 * the job itself wrote. So "does this file have an expiry" answers yes and is
 * useless. This check cannot prove an expiry COVERS a write without a real
 * parser and a call graph, so it does not claim to: a job with both a gating
 * write and an expiry is reported UNVERIFIED, with both line sets printed, and
 * UNVERIFIED is counted as not-passing. A reassuring label on an unexamined case
 * converts absent coverage into reported coverage, which is worse than no
 * opinion at all.
 *
 * A JOB WHOSE HANDLER CANNOT BE RESOLVED IS A FAILURE, NOT A SKIP, for the same
 * reason. Silence about a job is not evidence about it.
 *
 * Usage:
 *   node check-scheduled-verdicts.js [repoPath]     default: cwd
 *   node check-scheduled-verdicts.js --json
 *   node check-scheduled-verdicts.js --selftest     prove each finding can fire
 *
 * Exit codes: 0 when every job resolved and none is UNBOUNDED. 1 when a handler
 * could not be resolved or an UNBOUNDED verdict exists. UNVERIFIED alone does
 * not fail the build; it prints loudly and is excluded from the pass count.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* A value another code path is likely to gate behaviour on. Deliberately narrow:
 * a wide list turns every write into a finding and the check gets muted. */
const GATING_FIELD = /\b(enabled|disabled|severity|status|active|inactive|paused|blocked|suspended|halted|healthy|unhealthy|degraded|outage|maintenance|kill_?switch|locked|frozen)\b/;

/* A write that lands somewhere another process reads. */
const WRITE_CALL = /\.(upsert|insert|update|set|put|writeFile|writeFileSync)\s*\(/;

/* Something that bounds a value's age. A bare timestamp is not one: writing
 * `created_at` proves nothing about whether anyone reads it back. */
const EXPIRY = [
    [/\b[A-Z_]*(TTL|MAX_AGE|EXPIR|STALE|DEADLINE|TIMEOUT)[A-Z_]*\s*=/, 'age constant'],
    [/\bexpires?_?at\b/i, 'expires_at field'],
    [/\bage(Hours|Minutes|Ms|Seconds)\b/, 'computed age'],
    [/Date\.(parse|now)\s*\([^)]*\)\s*[-<>]/, 'age comparison'],
    [/\b(isStale|hasExpired|expired|outOfDate)\b/i, 'staleness predicate'],
];

function arg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i === -1 ? fallback : process.argv[i + 1];
}
const has = (flag) => process.argv.indexOf(flag) !== -1;

function readIf(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/* ---------- discovery: every scheduled job the repo declares ---------- */

function fromVercel(repo) {
    const raw = readIf(path.join(repo, 'vercel.json'));
    if (!raw) return [];
    let cfg;
    try { cfg = JSON.parse(raw); } catch { return [{ kind: 'vercel', id: 'vercel.json', schedule: null, handlerHint: null, unparsable: true }]; }
    return (cfg.crons || []).map((c) => ({
        kind: 'vercel',
        id: String(c.path || ''),
        schedule: String(c.schedule || ''),
        handlerHint: String(c.path || '').replace(/^\//, ''),
        /* Vercel exposes no per-cron overlap or lifetime field, so absence here
         * is a platform fact rather than an omission by the author. Say which. */
        lifetime: 'no per-cron field on this platform',
        overlap: 'no per-cron field on this platform',
    }));
}

function fromWorkflows(repo) {
    const dir = path.join(repo, '.github', 'workflows');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); } catch { return []; }
    const jobs = [];
    for (const f of files) {
        const src = readIf(path.join(dir, f)) || '';
        if (!/^\s*schedule:/m.test(src)) continue;
        const cron = (src.match(/cron:\s*['"]([^'"]+)['"]/) || [])[1] || null;
        jobs.push({
            kind: 'workflow',
            id: '.github/workflows/' + f,
            schedule: cron,
            handlerHint: path.join('.github', 'workflows', f),
            lifetime: /timeout-minutes:/.test(src) ? 'timeout-minutes declared' : 'NONE DECLARED',
            overlap: /concurrency:/.test(src) ? 'concurrency declared' : 'NONE DECLARED',
        });
    }
    return jobs;
}

function walk(dir, out, depth) {
    if (depth > 6) return out;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out, depth + 1);
        else out.push(full);
    }
    return out;
}

function fromKubernetes(repo) {
    const jobs = [];
    for (const f of walk(repo, [], 0)) {
        if (!/\.ya?ml$/.test(f)) continue;
        const src = readIf(f);
        if (!src || !/^\s*kind:\s*CronJob\b/m.test(src)) continue;
        jobs.push({
            kind: 'k8s',
            id: path.relative(repo, f),
            schedule: (src.match(/schedule:\s*(.+)/) || [])[1] || null,
            handlerHint: null,
            lifetime: /activeDeadlineSeconds:/.test(src) ? 'activeDeadlineSeconds declared' : 'NONE DECLARED',
            overlap: /concurrencyPolicy:/.test(src) ? 'concurrencyPolicy declared' : 'NONE DECLARED',
            startWindow: /startingDeadlineSeconds:/.test(src) ? 'startingDeadlineSeconds declared' : 'NONE DECLARED',
        });
    }
    return jobs;
}

function fromPgCron(repo) {
    const jobs = [];
    for (const f of walk(repo, [], 0)) {
        if (!/\.sql$/.test(f)) continue;
        const src = readIf(f);
        if (!src) continue;
        const re = /cron\.schedule\s*\(\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(src))) {
            jobs.push({
                kind: 'pg_cron',
                id: path.relative(repo, f) + ' :: ' + m[1],
                schedule: null,
                handlerHint: null,
                lifetime: 'no per-job field in pg_cron',
                overlap: 'no per-job field in pg_cron',
            });
        }
    }
    return jobs;
}

/* ---------- resolve a job to the source that runs ---------- */

const EXTS = ['.ts', '.js', '.mjs', '.tsx', '.mts'];

function resolveHandler(repo, hint) {
    if (!hint) return null;
    const base = path.join(repo, hint);
    for (const e of EXTS) {
        if (fs.existsSync(base + e)) return base + e;
        const idx = path.join(base, 'index' + e);
        if (fs.existsSync(idx)) return idx;
    }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    return null;
}

/* ---------- the finding ---------- */

/**
 * Follow a payload that was built somewhere other than the write call.
 *
 * The first version of this looked FORWARD 12 lines from `.upsert(` and matched
 * a gating field literally. That misses the shape most real code uses, and it
 * missed the very file this check was written for: the payload was assembled
 * into `const newValue = { enabled, severity, ... }` and the write, fifteen
 * lines later, said only `value: newValue`. A gate that cannot fire on its own
 * motivating defect is the failure this repo already documents twice, so the
 * window looks both directions AND resolves identifiers to their declarations.
 */
function declarationBody(lines, ident) {
    const decl = new RegExp('\\b(const|let|var)\\s+' + ident + '\\b');
    for (let i = 0; i < lines.length; i += 1) {
        if (!decl.test(lines[i])) continue;
        /* Take until braces balance, capped so a malformed file cannot run away. */
        let depth = 0, started = false, out = [];
        for (let k = i; k < Math.min(lines.length, i + 40); k += 1) {
            out.push(lines[k]);
            for (const ch of lines[k]) {
                if (ch === '{') { depth += 1; started = true; }
                else if (ch === '}') depth -= 1;
            }
            if (started && depth <= 0) break;
        }
        return out.join('\n');
    }
    return '';
}

const IDENT = /(?:^|[,({\s])(?:value|body|payload|row|record|data|update|set)\s*:\s*([A-Za-z_$][\w$]*)/g;

function inspectHandler(src) {
    const lines = src.split('\n');
    const strip = (t) => t.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    const writes = [];

    for (let i = 0; i < lines.length; i += 1) {
        if (!WRITE_CALL.test(lines[i])) continue;

        /* Both directions: a payload is as often assembled above the call as
         * inlined below it. 30 back covers a const built just above. */
        const near = strip(lines.slice(Math.max(0, i - 30), i + 15).join('\n'));
        let m = near.match(GATING_FIELD);

        /* Still nothing: resolve any identifier handed to the write and read
         * ITS declaration. This is the case the first version missed. */
        if (!m) {
            const after = lines.slice(i, i + 15).join('\n');
            const idents = new Set();
            let g;
            IDENT.lastIndex = 0;
            while ((g = IDENT.exec(after))) idents.add(g[1]);
            for (const id of idents) {
                const body = strip(declarationBody(lines, id));
                const hit = body.match(GATING_FIELD);
                if (hit) { m = hit; break; }
            }
        }

        if (m) writes.push({ line: i + 1, field: m[1] });
    }

    const bounds = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const [re, name] of EXPIRY) {
            if (re.test(line)) { bounds.push({ line: i + 1, kind: name }); break; }
        }
    }

    return { writes, bounds };
}

function classify(job) {
    if (job.handlerHint && !job.handler) return 'UNRESOLVED';
    if (!job.handler) return 'NO-HANDLER-TO-READ';
    if (!job.writes.length) return 'NO-VERDICT';
    if (!job.bounds.length) return 'UNBOUNDED';
    return 'UNVERIFIED';
}

function run(repo) {
    const jobs = [
        ...fromVercel(repo), ...fromWorkflows(repo),
        ...fromKubernetes(repo), ...fromPgCron(repo),
    ];

    for (const j of jobs) {
        j.handler = resolveHandler(repo, j.handlerHint);
        j.writes = [];
        j.bounds = [];
        if (j.handler) {
            const src = readIf(j.handler);
            if (src) Object.assign(j, inspectHandler(src));
        }
        j.verdict = classify(j);
    }
    return jobs;
}

function report(repo, jobs) {
    const by = (v) => jobs.filter((j) => j.verdict === v);
    const unresolved = by('UNRESOLVED');
    const unbounded = by('UNBOUNDED');
    const unverified = by('UNVERIFIED');
    const clean = by('NO-VERDICT');
    const noRead = by('NO-HANDLER-TO-READ');

    console.log('SCHEDULED VERDICTS  ' + repo);
    console.log('  population: ' + jobs.length + ' scheduled job(s) found - '
        + ['vercel', 'workflow', 'k8s', 'pg_cron']
            .map((k) => jobs.filter((j) => j.kind === k).length + ' ' + k)
            .join(', '));
    console.log('');
    console.log('  UNBOUNDED   ' + unbounded.length + '  writes a gating value, no age bound anywhere in the handler');
    console.log('  UNVERIFIED  ' + unverified.length + '  writes a gating value AND has an age bound; coverage NOT proven here');
    console.log('  UNRESOLVED  ' + unresolved.length + '  handler could not be found, so nothing about it was checked');
    console.log('  no verdict  ' + clean.length + '  writes nothing another path gates on');
    console.log('  not source  ' + noRead.length + '  declared where no handler file applies (k8s, pg_cron)');
    console.log('');

    for (const j of [...unbounded, ...unverified, ...unresolved]) {
        console.log('  [' + j.verdict + '] ' + j.id + (j.schedule ? '  (' + j.schedule + ')' : ''));
        if (j.handler) console.log('      handler: ' + path.relative(repo, j.handler));
        else if (j.handlerHint) console.log('      handler: NOT FOUND from hint ' + j.handlerHint);
        if (j.writes.length) {
            console.log('      writes:  ' + j.writes.map((w) => w.field + ' @' + w.line).join(', '));
        }
        if (j.bounds.length) {
            console.log('      bounds:  ' + j.bounds.slice(0, 4).map((b) => b.kind + ' @' + b.line).join(', ')
                + (j.bounds.length > 4 ? ' (+' + (j.bounds.length - 4) + ' more)' : ''));
            console.log('      ^ an age bound EXISTS. This check cannot prove it covers the write above.');
            console.log('        Read both. A bound that applies to a different class of row than the one');
            console.log('        this job writes is the exact shape that caused the incident in the header.');
        }
        if (j.lifetime) console.log('      lifetime: ' + j.lifetime);
        if (j.overlap) console.log('      overlap:  ' + j.overlap);
        if (j.startWindow) console.log('      start:    ' + j.startWindow);
        console.log('');
    }

    console.log('  UNVERIFIED is counted as NOT passing and is printed in full. A skip worded as a');
    console.log('  category converts absent coverage into reported coverage, which reads as an');
    console.log('  all-clear and closes the question instead of opening it.');

    return (unresolved.length || unbounded.length) ? 1 : 0;
}

/* ---------- selftest: every finding paired with the negative it must not fire on ---------- */

function selftest() {
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
    const fails = [];
    const check = (n, c) => { if (!c) fails.push(n); };

    const mk = (rel, body) => {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body, 'utf8');
    };

    mk('vercel.json', JSON.stringify({
        crons: [
            { path: '/api/cron/unbounded', schedule: '*/5 * * * *' },
            { path: '/api/cron/bounded', schedule: '0 * * * *' },
            { path: '/api/cron/harmless', schedule: '0 3 * * *' },
            { path: '/api/cron/missing', schedule: '0 4 * * *' },
        ],
    }));

    /* Fires: writes a gating field, nothing bounds its age. */
    mk('api/cron/unbounded.ts',
        'export default async function h() {\n'
        + '  await db.from("app_settings").upsert({\n'
        + '    key: "banner",\n'
        + '    value: { enabled: true, severity: "outage" },\n'
        + '  });\n}\n');

    /* Must NOT fire as UNBOUNDED: the same write with an age bound present. */
    mk('api/cron/bounded.ts',
        'const MAX_AGE_HOURS = 2;\n'
        + 'export default async function h() {\n'
        + '  const ageHours = (Date.now() - Date.parse(row.set_at)) / 3600000;\n'
        + '  if (ageHours > MAX_AGE_HOURS) return;\n'
        + '  await db.from("app_settings").upsert({ value: { enabled: false } });\n}\n');

    /* Must NOT fire at all: writes nothing anyone gates on. */
    mk('api/cron/harmless.ts',
        'export default async function h() {\n'
        + '  await db.from("metrics").insert({ count: 1, recorded_at: new Date() });\n}\n');

    let jobs = run(root);
    const v = (id) => (jobs.find((j) => j.id === id) || {}).verdict;

    check('unbounded fires', v('/api/cron/unbounded') === 'UNBOUNDED');
    check('a present age bound downgrades to UNVERIFIED', v('/api/cron/bounded') === 'UNVERIFIED');
    check('a non-gating write is NO-VERDICT', v('/api/cron/harmless') === 'NO-VERDICT');
    check('a missing handler is UNRESOLVED, not a skip', v('/api/cron/missing') === 'UNRESOLVED');

    /* A comment naming a gating word must not be read as a write. This is the
     * false positive that would make the check noisy enough to be muted. */
    mk('api/cron/harmless.ts',
        'export default async function h() {\n'
        + '  // sets enabled: true when severity is outage, one day\n'
        + '  await db.from("metrics").insert({ count: 1 });\n}\n');
    jobs = run(root);
    check('a comment mentioning a gating field is not a write',
        (jobs.find((j) => j.id === '/api/cron/harmless') || {}).verdict === 'NO-VERDICT');

    /* REGRESSION, and the reason this check was rewritten. The payload is built
     * into a named const and the write, lines later, passes only the identifier.
     * The first version looked forward from the write and saw nothing, so it
     * missed the exact production file it exists for. */
    mk('vercel.json', JSON.stringify({
        crons: [
            { path: '/api/cron/unbounded', schedule: '*/5 * * * *' },
            { path: '/api/cron/bounded', schedule: '0 * * * *' },
            { path: '/api/cron/harmless', schedule: '0 3 * * *' },
            { path: '/api/cron/missing', schedule: '0 4 * * *' },
            { path: '/api/cron/indirect', schedule: '0 5 * * *' },
        ],
    }));
    mk('api/cron/indirect.ts',
        'export default async function h() {\n'
        + '  const newValue = {\n'
        + '    enabled: nextEnabled,\n'
        + '    version: tag,\n'
        + '    severity: nextSeverity,\n'
        + '  };\n'
        + '  const other = 1;\n'
        + '  const more = 2;\n'
        + '  await db.from("app_settings").upsert({ key: K, value: newValue });\n}\n');
    jobs = run(root);
    check('a payload built in a named const is still seen',
        (jobs.find((j) => j.id === '/api/cron/indirect') || {}).verdict === 'UNBOUNDED');

    /* MUTATION: remove the bound from the bounded fixture and assert THIS check
     * flips it to UNBOUNDED. A mutation caught by some other gate proves nothing
     * about the one under test. */
    mk('api/cron/bounded.ts',
        'export default async function h() {\n'
        + '  await db.from("app_settings").upsert({ value: { enabled: false } });\n}\n');
    jobs = run(root);
    check('MUTATION: deleting the bound flips UNVERIFIED to UNBOUNDED',
        (jobs.find((j) => j.id === '/api/cron/bounded') || {}).verdict === 'UNBOUNDED');

    /* Exit code must reflect the findings, not merely print them. */
    mk('api/cron/bounded.ts', 'const MAX_AGE_HOURS = 2;\n'
        + 'export default async function h() {\n'
        + '  await db.from("app_settings").upsert({ value: { enabled: false } });\n}\n');
    mk('api/cron/unbounded.ts', 'export default async function h() {\n'
        + '  await db.from("metrics").insert({ count: 1 });\n}\n');
    mk('api/cron/missing.ts', 'export default async function h() { return 1; }\n');
    mk('api/cron/indirect.ts', 'export default async function h() { return 1; }\n');
    jobs = run(root);
    const anyBad = jobs.some((j) => j.verdict === 'UNBOUNDED' || j.verdict === 'UNRESOLVED');
    check('with nothing unbounded or unresolved, nothing fails the build', anyBad === false);

    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* tmp */ }

    if (fails.length) {
        console.error('SELFTEST FAILED: ' + fails.join('; '));
        process.exit(1);
    }
    console.log('selftest ok: 8 cases including one mutation, one regression and two false-positive guards');
    process.exit(0);
}

function main() {
    if (has('--selftest')) return selftest();
    const repo = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('--')
        && process.argv[i - 1] !== '--json') || process.cwd());
    const jobs = run(repo);
    if (has('--json')) {
        console.log(JSON.stringify({ repo, jobs }, null, 2));
        process.exit(0);
    }
    process.exit(report(repo, jobs));
}

if (require.main === module) main();
module.exports = { run, inspectHandler, classify, GATING_FIELD, EXPIRY };
