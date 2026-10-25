#!/usr/bin/env node
'use strict';
/**
 * skill-trigger-eval.js - does a live session reach for the right skill on its first turn?
 *
 * skill-router.js models description routing on paper. This measures the live
 * model: each case's prompt goes to a headless `claude -p` with one plugin tree
 * loaded by --plugin-dir and the installed autodev plugins disabled, so two arms
 * differ only in the tree. A run HITS when a Skill call in the first assistant
 * turn names the expected skill or one the case accepts. Every other skill that
 * turn loads is recorded, which is what the confusion table and the stealing
 * column are built from.
 *
 * Nothing the model calls runs. A PreToolUse hook (the `hook` subcommand) denies
 * every tool except Skill, because the user's own settings may grant
 * bypassPermissions and a held-out prompt can say "merge it". The run is one
 * turn, so a denial never steers a later choice.
 *
 * Arm identity is checked per run, not assumed: the init event lists the plugin
 * paths the session loaded, and a run whose autodev plugins did not all come
 * from --plugins is kept but marked armOk:false and left out of the report.
 *
 * Cases are JSON: [{ "id", "expected": "ship", "accept": ["unslop"], "prompt", "source" }].
 * Keep real prompts outside this public repo; the results carry ids, not text.
 *
 *   node tooling/skill-trigger-eval.js run --cases <json> --arm <label> --plugins <dir> --out <jsonl>
 *        [--samples 3] [--model claude-opus-5-5] [--effort high] [--concurrency 4] [--only id,id]
 *        [--config-dir <dir>] [--timeout-ms 300000] [--max-turns 1] [--keep-stream <dir>]
 *   node tooling/skill-trigger-eval.js archive --ref <commit> --to <dir>   plugins/ of a commit, for a before arm
 *   node tooling/skill-trigger-eval.js report <jsonl>... [--base <arm>] [--json]
 *        per-skill rates and the confusion table; --base adds a one-sided Fisher
 *        exact test per skill against that arm and exits 3 on a drop with p < 0.05
 *   node tooling/skill-trigger-eval.js hook                                 the PreToolUse guard (reads stdin)
 *   node tooling/skill-trigger-eval.js --selftest
 *
 * A run appends to --out and skips (arm, id, sample) rows already there, so an
 * interrupted run resumes. Exit 0 when every run finished, 1 when any errored.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const PLUGINS = ['autodev-core', 'autodev-memory', 'autodev-stack'];
const DENY_REASON = 'skill-trigger-eval: tools do not run in a trigger eval';

const HELP = `skill-trigger-eval.js - first-turn skill trigger eval over two plugin trees

  run --cases <json> --arm <label> --plugins <dir> --out <jsonl> [--samples 3]
      [--model claude-opus-5-5] [--effort high] [--concurrency 4] [--only id,id]
      [--config-dir <dir>] [--timeout-ms 300000] [--max-turns 1] [--keep-stream <dir>]
  archive --ref <commit> --to <dir>
  report <jsonl>... [--base <arm>] [--json]   exit 3: a skill fell significantly below --base
  hook
  --selftest
`;

/** Value after a flag, or the default. */
function opt(args, name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}

/** Skill names as the listing prints them, without the plugin prefix. */
function bareSkill(name) {
    return String(name || '').replace(/^[^:]+:/, '');
}

/** Skill names a plugin tree ships, from its directory layout. */
function treeSkills(pluginsDir) {
    const out = [];
    for (const p of PLUGINS) {
        const dir = path.join(pluginsDir, p, 'skills');
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) if (fs.existsSync(path.join(dir, n, 'SKILL.md'))) out.push(n);
    }
    return out.sort();
}

/** Digest of every SKILL.md in a tree, so a report can tell two arms apart. */
function treeDigest(pluginsDir) {
    const h = crypto.createHash('sha256');
    for (const p of PLUGINS) {
        const dir = path.join(pluginsDir, p, 'skills');
        let names = [];
        try { names = fs.readdirSync(dir).sort(); } catch { continue; }
        for (const n of names) {
            const f = path.join(dir, n, 'SKILL.md');
            if (fs.existsSync(f)) h.update(`${p}/${n}\0`).update(fs.readFileSync(f));
        }
    }
    return h.digest('hex').slice(0, 12);
}

/**
 * Read a stream-json transcript. The first turn is every tool_use before the
 * first tool_result: that is what the model chose with only the prompt in hand.
 */
function parseStream(text) {
    const firstTools = [];
    let init = null;
    let result = null;
    let sawResult = false;
    for (const line of String(text || '').split('\n')) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (!j || typeof j !== 'object') continue;
        if (j.type === 'system' && j.subtype === 'init') init = j;
        if (j.type === 'result') result = j;
        if (j.type === 'user' && Array.isArray(j.message && j.message.content)
            && j.message.content.some((p) => p && p.type === 'tool_result')) sawResult = true;
        if (j.type === 'assistant' && !sawResult) {
            for (const p of (j.message && j.message.content) || []) {
                if (p && p.type === 'tool_use') {
                    firstTools.push(p.name === 'Skill' ? `Skill:${p.input && p.input.skill}` : p.name);
                }
            }
        }
    }
    const skillCalls = firstTools.filter((t) => t.startsWith('Skill:')).map((t) => t.slice(6));
    return { init, result, firstTools, skillCalls };
}

/**
 * Did the session load each autodev plugin from the arm's tree, and nothing
 * autodev from anywhere else? Returns { ok, why }.
 */
function checkArm(init, pluginsDir) {
    if (!init) return { ok: false, why: 'no init event' };
    const plugins = Array.isArray(init.plugins) ? init.plugins : [];
    const norm = (p) => path.resolve(String(p || '')).toLowerCase();
    const want = new Set(PLUGINS.map((p) => norm(path.join(pluginsDir, p))));
    const autodev = plugins.filter((p) => PLUGINS.includes(p && p.name));
    const foreign = autodev.filter((p) => !want.has(norm(p.path)));
    if (foreign.length) return { ok: false, why: `autodev plugin from outside the arm: ${foreign.map((p) => p.path).join(', ')}` };
    const missing = PLUGINS.filter((p) => !autodev.some((a) => a.name === p));
    if (missing.length) return { ok: false, why: `arm plugin not loaded: ${missing.join(', ')}` };
    return { ok: true, why: '' };
}

/**
 * Did the run fail rather than choose? No result event on a non-zero exit, or a
 * result flagged is_error for any reason but the one-turn cap (an expired login,
 * a usage limit, an API error). Those rows carry `err` and the report drops them,
 * so a rerun fills them instead of counting them as misses.
 */
function runError(parsed, status) {
    const res = parsed.result;
    if (!res) return status !== 0;
    return Boolean(res.is_error) && res.subtype !== 'error_max_turns';
}

/** Grade one run against its case. */
function grade(kase, parsed, autodevSkills) {
    const want = [kase.expected].concat(kase.accept || []);
    const loaded = parsed.skillCalls.map(bareSkill);
    const own = new Set(autodevSkills);
    return {
        hit: loaded.some((s) => want.includes(s)),
        skills: loaded.filter((s) => own.has(s)),
        otherSkills: parsed.skillCalls.filter((s) => !own.has(bareSkill(s))),
    };
}

/** The PreToolUse guard: Skill passes silently, everything else is denied. */
function hook(stdinText) {
    let j = {};
    try { j = JSON.parse(stdinText); } catch { /* an unparseable event is denied below */ }
    if (j && j.tool_name === 'Skill') return '';
    return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
    });
}

function quote(a) {
    return WIN ? `"${String(a).replace(/"/g, '\\"')}"` : a;
}

/** One headless session. Resolves to { stdout, stderr, status, ms }. */
function runClaude(args, input, cwd, env, timeoutMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn('claude', WIN ? args.map(quote) : args, { cwd, env, shell: WIN, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
            else child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, status: timedOut ? 'timeout' : status, ms: Date.now() - t0 });
        });
        child.stdin.end(input);
    });
}

function readRows(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}

async function cmdRun(args) {
    const casesFile = opt(args, '--cases');
    const arm = opt(args, '--arm');
    const pluginsDir = opt(args, '--plugins') && path.resolve(opt(args, '--plugins'));
    const out = opt(args, '--out');
    if (!casesFile || !arm || !pluginsDir || !out) { process.stderr.write(HELP); return 2; }
    const samples = Number(opt(args, '--samples', 3));
    const model = opt(args, '--model', 'claude-opus-5-5');
    const effort = opt(args, '--effort', 'high');
    const concurrency = Number(opt(args, '--concurrency', 4));
    const timeoutMs = Number(opt(args, '--timeout-ms', 300000));
    const maxTurns = String(opt(args, '--max-turns', 1));
    const keep = opt(args, '--keep-stream', null);
    if (keep) fs.mkdirSync(keep, { recursive: true });
    const only = opt(args, '--only', null);
    const skills = treeSkills(pluginsDir);
    if (!skills.length) { process.stderr.write(`no skills under ${pluginsDir}\n`); return 2; }
    const digest = treeDigest(pluginsDir);
    const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'))
        .filter((c) => !only || only.split(',').includes(c.id));

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-trigger-eval-'));
    const settings = path.join(cwd, 'eval-settings.json');
    const hookCmd = `node "${path.resolve(__filename).replace(/\\/g, '/')}" hook`;
    fs.writeFileSync(settings, JSON.stringify({
        enabledPlugins: Object.fromEntries(PLUGINS.map((p) => [`${p}@autodev`, false])),
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd }] }] },
    }));
    const env = { ...process.env };
    if (opt(args, '--config-dir')) env.CLAUDE_CONFIG_DIR = opt(args, '--config-dir');
    const base = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', maxTurns,
        '--model', model, '--effort', effort, '--permission-prompts', 'none', '--settings', settings];
    for (const p of PLUGINS) base.push('--plugin-dir', path.join(pluginsDir, p));

    const done = new Set(readRows(out).map((r) => `${r.arm}\0${r.id}\0${r.sample}`));
    const queue = [];
    for (const c of cases) for (let s = 0; s < samples; s++) {
        if (!done.has(`${arm}\0${c.id}\0${s}`)) queue.push([c, s]);
    }
    process.stdout.write(`population: ${cases.length} case(s) x ${samples} sample(s), ${queue.length} to run, `
        + `arm ${arm} (${digest}, ${skills.length} skills), model ${model}, effort ${effort}\n`);
    let errors = 0;
    let hits = 0;
    let ran = 0;
    const worker = async () => {
        while (queue.length) {
            const [c, s] = queue.shift();
            const r = await runClaude(base, c.prompt, cwd, env, timeoutMs);
            if (keep) fs.writeFileSync(path.join(keep, `${arm}-${c.id}-s${s}.jsonl`), r.stdout);
            const parsed = parseStream(r.stdout);
            const armCheck = checkArm(parsed.init, pluginsDir);
            const g = grade(c, parsed, skills);
            const errored = runError(parsed, r.status);
            if (errored) errors++;
            if (g.hit) hits++;
            ran++;
            const row = {
                arm, digest, model, effort, id: c.id, expected: c.expected, accept: c.accept || [], sample: s,
                hit: g.hit, skills: g.skills, otherSkills: g.otherSkills, firstTools: parsed.firstTools.slice(0, 6),
                armOk: armCheck.ok, armWhy: armCheck.why || undefined, status: r.status, ms: r.ms,
                err: errored ? String((parsed.result && parsed.result.result) || r.stderr).slice(-300) : undefined,
            };
            fs.appendFileSync(out, JSON.stringify(row) + '\n');
            process.stdout.write(`${arm} ${c.id} s${s} ${g.hit ? 'HIT ' : 'miss'} `
                + `${parsed.firstTools.slice(0, 4).join(',') || '(no tool)'}${armCheck.ok ? '' : ' ARM? ' + armCheck.why}`
                + `${errored ? ' ERROR ' + r.status : ''}\n`);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    process.stdout.write(`${arm}: ${hits}/${ran} hits, ${errors} errored\n`);
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* a held handle leaves a temp dir */ }
    return errors ? 1 : 0;
}

function cmdArchive(args) {
    const ref = opt(args, '--ref');
    const to = opt(args, '--to');
    if (!ref || !to) { process.stderr.write(HELP); return 2; }
    fs.mkdirSync(to, { recursive: true });
    const tar = path.join(to, '.plugins.tar');
    const a = spawnSync('git', ['archive', '--format=tar', '-o', tar, ref, 'plugins'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    if (a.status !== 0) { process.stderr.write(a.stderr); return 1; }
    const x = spawnSync('tar', ['-xf', path.basename(tar)], { cwd: to, encoding: 'utf8' });
    fs.rmSync(tar, { force: true });
    if (x.status !== 0) { process.stderr.write(x.stderr); return 1; }
    const dir = path.join(to, 'plugins');
    process.stdout.write(`${ref} -> ${dir}: ${treeSkills(dir).length} skills, digest ${treeDigest(dir)}\n`);
    return 0;
}

/**
 * Per-skill rates per arm, the confusion table and the stealing count.
 * Rows with armOk false or an error are counted and left out.
 */
function summarise(rows) {
    const arms = [...new Set(rows.map((r) => r.arm))];
    const kept = rows.filter((r) => r.armOk && !r.err);
    const excluded = rows.length - kept.length;
    const expected = [...new Set(kept.map((r) => r.expected))].sort();
    const perSkill = {};
    const confusion = {};
    const stolen = {};
    for (const a of arms) { confusion[a] = {}; stolen[a] = {}; }
    for (const r of kept) {
        const k = perSkill[r.expected] || (perSkill[r.expected] = {});
        const cell = k[r.arm] || (k[r.arm] = { hits: 0, runs: 0 });
        cell.runs++;
        if (r.hit) cell.hits++;
        const row = confusion[r.arm][r.expected] || (confusion[r.arm][r.expected] = {});
        const loaded = r.skills.length ? r.skills : (r.otherSkills.length ? ['(other)'] : ['(none)']);
        for (const s of loaded) row[s] = (row[s] || 0) + 1;
        const want = [r.expected].concat(r.accept || []);
        for (const s of r.skills) {
            if (!want.includes(s)) stolen[r.arm][s] = (stolen[r.arm][s] || 0) + 1;
        }
    }
    const totals = {};
    for (const a of arms) {
        const mine = kept.filter((r) => r.arm === a);
        totals[a] = { hits: mine.filter((r) => r.hit).length, runs: mine.length };
    }
    return { arms, expected, perSkill, confusion, stolen, totals, rows: rows.length, excluded };
}

/**
 * One-sided Fisher exact p that arm B's rate is this low or lower when both
 * arms share one true rate: P(X <= bHits), X hypergeometric. A drop at n=3 is
 * mostly noise, and this is what tells the two apart.
 */
function fisherLower(aHits, aRuns, bHits, bRuns) {
    const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
    const lc = (n, k) => lf(n) - lf(k) - lf(n - k);
    const K = aHits + bHits;
    const N = aRuns + bRuns;
    let p = 0;
    for (let x = Math.max(0, K - aRuns); x <= Math.min(bHits, K); x++) {
        p += Math.exp(lc(K, x) + lc(N - K, bRuns - x) - lc(N, bRuns));
    }
    return Math.min(1, p);
}

/** Skills whose rate in an arm is below the base arm's, with the one-sided p. */
function drops(s, base, alpha) {
    const out = [];
    for (const k of s.expected) {
        const b = s.perSkill[k][base];
        if (!b || !b.runs) continue;
        for (const a of s.arms) {
            const c = s.perSkill[k][a];
            if (a === base || !c || !c.runs || c.hits / c.runs >= b.hits / b.runs) continue;
            const p = fisherLower(b.hits, b.runs, c.hits, c.runs);
            out.push({ skill: k, arm: a, base: `${b.hits}/${b.runs}`, got: `${c.hits}/${c.runs}`, p, significant: p < alpha });
        }
    }
    return out;
}

function renderReport(s, base, alpha = 0.05) {
    const lines = [];
    const frac = (c) => (c ? `${c.hits}/${c.runs}` : '-');
    lines.push(`population: ${s.rows} run(s), ${s.excluded} excluded (arm mismatch or error), `
        + `${s.expected.length} expected skill(s), arms ${s.arms.join(', ')}`);
    lines.push('');
    lines.push(`| Skill | ${s.arms.join(' | ')} | stolen by others (${s.arms.join(' / ')}) |`);
    lines.push(`|---|${s.arms.map(() => '---:').join('|')}|---|`);
    for (const k of s.expected) {
        const steals = s.arms.map((a) => {
            const row = s.confusion[a][k] || {};
            return Object.entries(row).filter(([n]) => n !== k && !n.startsWith('('))
                .sort((x, y) => y[1] - x[1]).map(([n, c]) => `${n} ${c}`).join(', ') || '-';
        });
        lines.push(`| ${k} | ${s.arms.map((a) => frac(s.perSkill[k][a])).join(' | ')} | ${steals.join(' / ')} |`);
    }
    lines.push(`| **all** | ${s.arms.map((a) => frac(s.totals[a])).join(' | ')} | |`);
    if (base) {
        const d = drops(s, base, alpha);
        lines.push('');
        lines.push(`Below base arm ${base} (one-sided Fisher exact, alpha ${alpha}): `
            + (d.map((x) => `${x.skill} in ${x.arm} ${x.got} vs ${x.base}, p=${x.p.toFixed(3)}${x.significant ? ' SIGNIFICANT' : ''}`).join('; ') || 'none'));
    }
    for (const a of s.arms) {
        lines.push('');
        lines.push(`Confusion, arm ${a}: expected skill (row) against what the first turn loaded.`);
        lines.push('');
        lines.push('| Expected | Loaded |');
        lines.push('|---|---|');
        for (const k of s.expected) {
            const row = s.confusion[a][k] || {};
            const cells = Object.entries(row).sort((x, y) => y[1] - x[1]).map(([n, c]) => (n === k ? `**${n} ${c}**` : `${n} ${c}`));
            lines.push(`| ${k} | ${cells.join(', ') || '-'} |`);
        }
        const st = Object.entries(s.stolen[a]).sort((x, y) => y[1] - x[1]);
        lines.push('');
        lines.push(`Loaded where another skill was expected, arm ${a}: ${st.map(([n, c]) => `${n} ${c}`).join(', ') || 'none'}`);
    }
    return lines.join('\n') + '\n';
}

function cmdReport(args) {
    const base = opt(args, '--base', null);
    const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base');
    if (!files.length) { process.stderr.write(HELP); return 2; }
    const rows = files.flatMap(readRows);
    const s = summarise(rows);
    if (base && !s.arms.includes(base)) { process.stderr.write(`report: no rows for base arm ${base}\n`); return 2; }
    if (base) s.drops = drops(s, base, 0.05);
    process.stdout.write(args.includes('--json') ? JSON.stringify(s, null, 2) + '\n' : renderReport(s, base));
    if (!rows.length) return 1;
    return s.drops && s.drops.some((x) => x.significant) ? 3 : 0;
}

function selftest() {
    let failed = 0;
    let passed = 0;
    const t = (label, ok) => { if (ok) passed++; else { failed++; process.stdout.write(`FAIL ${label}\n`); } };
    const stream = [
        JSON.stringify({ type: 'system', subtype: 'init', plugins: [{ name: 'autodev-core', path: '/arm/autodev-core' }] }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'autodev-core:ship' } }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'denied' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'prove' } }] } }),
        'not json',
    ].join('\n');
    const p = parseStream(stream);
    t('first turn stops at the first tool_result', p.firstTools.join() === 'Skill:autodev-core:ship,Bash');
    t('skill calls keep their prefix until graded', p.skillCalls.join() === 'autodev-core:ship');
    const g = grade({ expected: 'prove' }, p, ['ship', 'prove']);
    t('a skill loaded for another expectation is a miss', g.hit === false && g.skills.join() === 'ship');
    t('accept widens the hit', grade({ expected: 'prove', accept: ['ship'] }, p, ['ship', 'prove']).hit === true);
    const ended = (r) => parseStream(JSON.stringify({ type: 'result', ...r }));
    t('the one-turn cap is a normal end', runError(ended({ is_error: true, subtype: 'error_max_turns' }), 1) === false);
    t('an expired login is an error, not a miss', runError(ended({ is_error: true, subtype: 'success', result: 'Failed to authenticate' }), 1) === true);
    t('no result on a non-zero exit is an error', runError(parseStream(''), 1) === true);
    t('a clean text answer is not an error', runError(ended({ is_error: false, subtype: 'success' }), 0) === false);
    t('hook lets Skill through silently', hook(JSON.stringify({ tool_name: 'Skill' })) === '');
    t('hook denies Bash', /"deny"/.test(hook(JSON.stringify({ tool_name: 'Bash' }))));
    t('hook denies an unparseable event', /"deny"/.test(hook('{')));
    const arm = path.resolve('/arm');
    const init = (paths) => ({ plugins: paths.map(([n, q]) => ({ name: n, path: q })) });
    const all = PLUGINS.map((n) => [n, path.join(arm, n)]);
    t('arm check passes on the arm tree', checkArm(init(all), arm).ok);
    t('arm check fails on an installed copy', !checkArm(init([...all.slice(1), ['autodev-core', '/cache/autodev-core']]), arm).ok);
    t('arm check fails with no init', !checkArm(null, arm).ok);
    const rows = [
        { arm: 'a', id: '1', expected: 'prove', sample: 0, hit: false, skills: ['ship'], otherSkills: [], armOk: true },
        { arm: 'a', id: '1', expected: 'prove', sample: 1, hit: true, skills: ['prove'], otherSkills: [], armOk: true },
        { arm: 'b', id: '1', expected: 'prove', sample: 0, hit: false, skills: [], otherSkills: [], armOk: true },
        { arm: 'b', id: '1', expected: 'prove', sample: 1, hit: false, skills: [], otherSkills: [], armOk: false },
    ];
    const s = summarise(rows);
    t('rates per arm', s.perSkill.prove.a.hits === 1 && s.perSkill.prove.a.runs === 2 && s.perSkill.prove.b.runs === 1);
    t('a mismatched arm row is excluded and counted', s.excluded === 1);
    t('stealing is attributed to the loaded skill', s.stolen.a.ship === 1 && !s.stolen.b.ship);
    t('a turn that loads nothing is (none)', s.confusion.b.prove['(none)'] === 1);
    t('the report prints its population', /^population: 4 run\(s\), 1 excluded/.test(renderReport(s)));
    t('fisher: 3/3 against 0/3 is p=0.05', Math.abs(fisherLower(3, 3, 0, 3) - 0.05) < 1e-9);
    t('fisher: an equal rate is not a drop', fisherLower(2, 4, 2, 4) > 0.5);
    t('fisher: 5/6 against 3/6 is noise', fisherLower(5, 6, 3, 6) > 0.2);
    t('fisher: 30/30 against 10/30 is significant', fisherLower(30, 30, 10, 30) < 1e-6);
    t('a drop below the base arm is listed, not significant at n=1', drops(s, 'a', 0.05).length === 1 && drops(s, 'a', 0.05)[0].significant === false);
    process.stdout.write(`selftest: ${passed} passed, ${failed} failed\n`);
    return failed ? 1 : 0;
}

async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];
    if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(HELP); return 0; }
    if (cmd === '--selftest') return selftest();
    if (cmd === 'hook') {
        let s = '';
        for await (const d of process.stdin) s += d;
        const out = hook(s);
        if (out) process.stdout.write(out);
        return 0;
    }
    if (cmd === 'run') return cmdRun(args.slice(1));
    if (cmd === 'archive') return cmdArchive(args.slice(1));
    if (cmd === 'report') return cmdReport(args.slice(1));
    process.stderr.write(HELP);
    return 2;
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }, (e) => {
        process.stderr.write(`${e && e.stack || e}\n`);
        process.exitCode = 1;
    });
}

module.exports = { parseStream, checkArm, runError, grade, hook, summarise, renderReport, fisherLower, drops, treeSkills, treeDigest };
