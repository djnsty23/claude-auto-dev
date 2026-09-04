#!/usr/bin/env node
// test-hooks-module.js — drives plugins/autodev-core/hooks/fn/autodev-fn.mjs,
// the plugin's hooks module, with a fake `on` and a fake `$`.
//
// The module needs no Claude Code to test: `register(on)` is a plain function
// and every `$` it touches is a call on a frozen object, so a recording stub
// stands in for the engine. What this suite cannot see is the loader: whether
// the host accepts the module is `claude plugin validate`'s job, run by
// tooling/validate.js when the CLI is on PATH.
//
// Population lines are printed beside every count, per the gate-integrity
// rule: a suite that prints only verdicts is indistinguishable from one that
// scanned nothing.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// A throw here is a VERDICT, exit 1, not infrastructure. This suite has no
// sandbox or fixture tree of its own: every code path calls a subject, so a
// subject that throws (or a stubbed one, under check:suites, whose exports
// are gone) is the suite failing to pass, which is exactly what the sweep
// needs to see. Exit 2 would read as "indeterminate" and hide the verdict.
process.on('uncaughtException', (e) => {
    console.error('FAIL (uncaught): ' + ((e && (e.stack || e.message)) || e));
    process.exit(1);
});
process.on('unhandledRejection', (e) => {
    console.error('FAIL (rejection): ' + ((e && (e.stack || e.message)) || e));
    process.exit(1);
});

const ROOT = path.resolve(__dirname, '..');
const FN_DIR = path.join(ROOT, 'plugins', 'autodev-core', 'hooks', 'fn');
const ENTRY = path.join(ROOT, 'plugins', 'autodev-core', 'hooks', 'fn', 'autodev-fn.mjs');
const prdStates = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'prd-states.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

// --- the fake engine -------------------------------------------------------

function fakeOn() {
    const regs = [];
    const on = (event, a, b) => regs.push(b === undefined ? { event, hook: a } : { event, matcher: a, hook: b });
    on.regs = regs;
    on.find = (event, matcherKey, matcherValue) => regs.find((r) =>
        r.event === event && (matcherKey === undefined || (r.matcher && r.matcher[matcherKey] === matcherValue)));
    return on;
}

function fakeDollar({ cwd = '/srv/proj', repo = null, files = {}, failFs = false } = {}) {
    const log = [];
    const status = [];
    const $ = Object.freeze({
        plugin: { name: 'autodev-core', root: '/plugins/autodev-core' },
        ui: {
            log: (t) => log.push(t),
            status: (t) => status.push(t),
            toast: () => {},
            notice: () => {},
        },
        session: {
            cwd: async () => cwd,
            repo: async () => repo,
        },
        fs: {
            exists: async (p) => { if (failFs) throw new Error('fs down'); return Object.prototype.hasOwnProperty.call(files, p); },
            readFile: async (p) => { if (failFs) throw new Error('fs down'); if (!(p in files)) throw new Error('missing ' + p); return files[p]; },
        },
    });
    return { $, log, status };
}

const AUTODEV_REPO = { root: 'D:\\work\\claude-auto-dev', remote: 'https://github.com/someone/claude-auto-dev.git', internal: false, name: null };
const OTHER_REPO = { root: '/srv/project-b', remote: 'git@github.com:someone/project-b.git', internal: false, name: null };

(async () => {
    const fn = await import(pathToFileURL(ENTRY).href);
    const redact = await import(pathToFileURL(path.join(FN_DIR, 'redact.mjs')).href);
    const rules = await import(pathToFileURL(path.join(FN_DIR, 'bash-rules.mjs')).href);
    const status = await import(pathToFileURL(path.join(FN_DIR, 'sprint-status.mjs')).href);

    // --- 1. registration -----------------------------------------------------
    console.log('\n== registration');
    const on = fakeOn();
    await fn.register(on, {});
    const events = on.regs.map((r) => r.event + (r.matcher ? JSON.stringify(r.matcher) : ''));
    console.log(`  population: ${on.regs.length} registrations: ${events.join(', ')}`);
    check('hooks session.start', !!on.find('session.start'));
    check('hooks prompt.submit', !!on.find('prompt.submit'));
    check('hooks tool.call matched on Bash only', !!on.find('tool.call', 'tool', 'Bash') && on.regs.filter((r) => r.event === 'tool.call').length === 1);
    check('hooks attribution.text matched on commit only', !!on.find('attribution.text', 'kind', 'commit') && on.regs.filter((r) => r.event === 'attribution.text').length === 1);
    check('hooks turn.complete', !!on.find('turn.complete'));

    // --- 2. patterns: one known-positive and the negatives --------------------
    console.log('\n== redactText patterns');
    let positives = 0;
    for (const p of redact.PATTERNS) {
        const sample = p.sample();
        // The named patterns are line-anchored on purpose (an env line, a table
        // row), so every sample sits on a line of its own between two others.
        const r = redact.redactText(`before\n${sample}\nafter`);
        // A global regex's .match() drops capture groups; exec on a non-global
        // copy is what actually yields the secret group.
        const once = new RegExp(p.re.source, p.re.flags.replace('g', ''));
        const m = once.exec(sample);
        const secret = p.group ? (m && m[p.group]) : sample;
        const ok = r.count >= 1 && typeof secret === 'string' && secret.length > 0 && !r.text.includes(secret) && r.text.includes('[REDACTED:' + p.name);
        if (ok) positives++;
        check(`pattern ${p.name} redacts its known-positive`, ok, ok ? '' : `count=${r.count} secret=${secret === undefined ? 'undefined' : secret.length + ' chars'} text=${r.text.slice(0, 80)}`);
    }
    console.log(`  population: ${redact.PATTERNS.length} patterns, ${positives} known-positives redacted`);

    const negatives = [
        ['a 40-hex git sha', 'commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 (HEAD -> main)'],
        ['a 64-hex digest', 'sha256:' + 'ab'.repeat(32)],
        ['a supabase anon jwt', (() => {
            const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
            return 'SUPABASE_ANON_KEY=' + b64({ alg: 'HS256' }) + '.' + b64({ role: 'anon', iss: 'supabase' }) + '.' + 'Z'.repeat(43);
        })()],
        ['an env reference', 'OPENAI_API_KEY=${OPENAI_API_KEY}'],
        ['a masked value', 'DATABASE_PASSWORD=************'],
        ['a template slot', 'STRIPE_SECRET_KEY=<your-key-here>'],
        ['a plain url without credentials', 'https://example.com/path?x=1'],
        ['an already-redacted token', 'run with [REDACTED:anthropic-key#3] set'],
        ['a short assignment', 'API_KEY=short'],
        ['prose with the word token', 'the token budget for this turn is 8000 tokens'],
    ];
    let clean = 0;
    for (const [name, text] of negatives) {
        const r = redact.redactText(text);
        const ok = r.count === 0 && r.text === text;
        if (ok) clean++;
        check(`negative: ${name} is left alone`, ok, ok ? '' : `count=${r.count} kinds=${JSON.stringify(r.kinds)}`);
    }
    console.log(`  population: ${negatives.length} negatives, ${clean} untouched`);

    const grouped = redact.redactText('postgresql://app:' + 'N'.repeat(24) + '@db.internal:5432/app');
    check('url-password keeps host and database, replaces only the password',
        grouped.text.startsWith('postgresql://app:[REDACTED:url-password#') && grouped.text.endsWith('@db.internal:5432/app'), grouped.text);

    // --- 3. the vault round trip ---------------------------------------------
    console.log('\n== vault round trip through the hooks');
    {
        const on2 = fakeOn();
        await fn.register(on2, {});
        const secret = 'sk-ant-' + 'R'.repeat(40);
        const { $, log } = fakeDollar({ repo: OTHER_REPO });

        // prompt.submit: the pasted key becomes a placeholder before next()
        let submitted = null;
        const ps = on2.find('prompt.submit').hook;
        await ps($, { text: `use ${secret} to call the api`, wait: false, origin: { kind: 'composer' } }, async (e2) => { submitted = e2; return { text: e2.text }; });
        check('prompt.submit passes a redacted prompt to next', !!submitted && !submitted.text.includes(secret) && /\[REDACTED:anthropic-key#\d+\]/.test(submitted.text), submitted && submitted.text);
        check('prompt.submit logs a count and kind, never the value', log.length === 1 && /redacted 1 pasted secret/.test(log[0]) && !log[0].includes(secret), log[0]);
        const placeholder = submitted.text.match(/\[REDACTED:anthropic-key#\d+\]/)[0];

        // prompt.submit with nothing to redact passes the same object through
        let passthrough = null;
        const e0 = { text: 'plain prompt', wait: false, origin: { kind: 'composer' } };
        await ps($, e0, async (e2) => { passthrough = e2; return { text: e2.text }; });
        check('prompt.submit with no secret hands next the identical object', passthrough === e0);

        // tool.call Bash: the placeholder is restored for the run, the output scrubbed
        const tc = on2.find('tool.call', 'tool', 'Bash').hook;
        let ran = null;
        const out = await tc($, { tool: 'Bash', tool_use_id: 't1', command: `curl -H "x-api-key: ${placeholder}" https://api.example.com` }, async (e2) => {
            ran = e2.command;
            return { ref: 7, result: { stdout: `ok key=${secret} done`, stderr: '', interrupted: false, isImage: false }, text: 'ok' };
        });
        check('tool.call restores the real value into the command that runs', ran !== null && ran.includes(secret) && !ran.includes('[REDACTED'), ran);
        check('tool.call scrubs the value back out of stdout', out.result && out.result.stdout === `ok key=${placeholder} done`, JSON.stringify(out.result));
        check('a scrubbed result drops core\'s ref and carries a context note', out.ref === undefined && Array.isArray(out.context) && out.context.some((c) => /redacted 1 credential/.test(c)), JSON.stringify(out));
        check('nothing logged contains the value', log.every((l) => !l.includes(secret)));

        // tool.call Bash with nothing to do returns the object it got (ref survives)
        const untouched = { ref: 9, result: { stdout: 'hello\n', stderr: '', interrupted: false, isImage: false }, text: 'hello' };
        const same = await tc($, { tool: 'Bash', tool_use_id: 't2', command: 'echo hello' }, async () => untouched);
        check('tool.call with nothing to do returns the exact next() object', same === untouched);

        // a deny from beneath passes through unchanged
        const denied = { deny: 'permission refused' };
        const d = await tc($, { tool: 'Bash', tool_use_id: 't3', command: 'echo hi' }, async () => denied);
        check('a deny from beneath is returned as is', d === denied);

        // pattern-based scrub with no vault entry
        const out2 = await tc($, { tool: 'Bash', tool_use_id: 't4', command: 'doppler secrets --plain' }, async () => ({
            ref: 1, result: { stdout: 'GITHUB_TOKEN=ghp_' + 'S'.repeat(36) + '\n', stderr: '', interrupted: false, isImage: false }, text: '',
        }));
        check('tool.call scrubs credential-shaped stdout it never saw pasted', out2.result.stdout.includes('[REDACTED:') && !out2.result.stdout.includes('S'.repeat(36)), out2.result.stdout);
        check('the tally moved', log.some((l) => /redacted 1 secret\(s\) from Bash output/.test(l)), log.join(' | '));
    }

    // --- 4. bash rules --------------------------------------------------------
    console.log('\n== decideBash');
    const win = 'D:\\work\\claude-auto-dev';
    const posix = '/srv/claude-auto-dev';
    const denyCases = [
        ['git commit -m "x"', 'git-commit-m'],
        ['git commit -am "x"', 'git-commit-m'],
        ['git commit --message="x"', 'git-commit-m'],
        ['cd sub && git commit -sm "x"', 'git-commit-m'],
        ['GIT_AUTHOR_NAME=x git -C /tmp/w commit -m "x"', 'git-commit-m'],
        ['git commit --amend --no-edit', 'git-commit-amend'],
        ['git add -A && git commit -F msg.txt', 'git-add-all'],
        ['git add --all', 'git-add-all'],
    ];
    let denies = 0;
    for (const [cmd, rule] of denyCases) {
        const d = rules.decideBash({ command: cmd, cwd: posix, repo: AUTODEV_REPO });
        const ok = d.deny && d.rule === rule;
        if (ok) denies++;
        check(`deny in repo: ${cmd}`, ok, JSON.stringify(d).slice(0, 120));
        const elsewhere = rules.decideBash({ command: cmd, cwd: posix, repo: OTHER_REPO });
        check(`  ...and allowed outside the repo`, !elsewhere.deny && elsewhere.command === cmd, JSON.stringify(elsewhere).slice(0, 120));
    }
    console.log(`  population: ${denyCases.length} deny shapes, ${denies} denied in repo`);

    const allowCases = [
        'git commit -F .claude/commit-msg.txt',
        'git commit --file msg.txt',
        'grep -n "git commit -m" CLAUDE.md',
        'echo "never git add -A" >> notes.md',
        'git log --oneline -5',
        'git add plugins/autodev-core/hooks/fn/redact.mjs tooling/test-hooks-module.js',
        'git commit -F - <<\'EOF\'\nfix: stop using git commit -m\n\nthe rule says git add -A is banned\nEOF',
        'node -e "console.log(1)"',
    ];
    let allows = 0;
    for (const cmd of allowCases) {
        const d = rules.decideBash({ command: cmd, cwd: posix, repo: AUTODEV_REPO });
        const ok = !d.deny && d.command === cmd;
        if (ok) allows++;
        check(`allow: ${cmd.split('\n')[0]}`, ok, JSON.stringify(d).slice(0, 160));
    }
    console.log(`  population: ${allowCases.length} allow shapes, ${allows} untouched`);

    const dop = rules.decideBash({ command: 'doppler secrets delete OLD_KEY --project app-x --config prd --yes | tail -3', cwd: posix, repo: OTHER_REPO });
    check('doppler delete gains --silent inside its own segment', dop.command === 'doppler secrets delete --silent OLD_KEY --project app-x --config prd --yes | tail -3' && dop.rules.includes('doppler-silent'), dop.command);
    const dop2 = rules.decideBash({ command: 'doppler secrets set K=v --silent --project p --config prd', cwd: posix, repo: OTHER_REPO });
    check('doppler set already silent is untouched', dop2.command === 'doppler secrets set K=v --silent --project p --config prd' && dop2.rules.length === 0);
    const dop3 = rules.decideBash({ command: 'doppler secrets --project p --config prd --only-names', cwd: posix, repo: OTHER_REPO });
    check('doppler read is untouched', dop3.rules.length === 0);

    const rev = rules.decideBash({ command: 'git cat-file -p origin/main:.github/workflows/ci.yml', cwd: win, repo: OTHER_REPO });
    check('dot-leading rev:path on Windows gains MSYS_NO_PATHCONV=1', rev.command === 'MSYS_NO_PATHCONV=1 git cat-file -p origin/main:.github/workflows/ci.yml' && rev.rules.includes('msys-pathconv'), rev.command);
    const rev2 = rules.decideBash({ command: 'git show origin/main:.gitignore | head -3', cwd: win, repo: OTHER_REPO });
    check('git show rev:.file on Windows gains the prefix in its own segment', rev2.command === 'MSYS_NO_PATHCONV=1 git show origin/main:.gitignore | head -3', rev2.command);
    const rev3 = rules.decideBash({ command: 'git show origin/main:scripts/preflight.js', cwd: win, repo: OTHER_REPO });
    check('rev:path without a leading dot is untouched', rev3.rules.length === 0);
    const rev4 = rules.decideBash({ command: 'git show origin/main:./prd.json', cwd: win, repo: OTHER_REPO });
    check('rev:./path is untouched', rev4.rules.length === 0);
    const rev5 = rules.decideBash({ command: 'git cat-file -p origin/main:.gitignore', cwd: posix, repo: OTHER_REPO });
    check('the same read on a posix cwd is untouched', rev5.rules.length === 0);
    const rev6 = rules.decideBash({ command: 'MSYS_NO_PATHCONV=1 git show origin/main:.gitignore', cwd: win, repo: OTHER_REPO });
    check('an already-prefixed read is untouched', rev6.rules.length === 0);

    check('isAutodevRepo matches the remote path', rules.isAutodevRepo({ root: '/x/y', remote: 'git@github.com:o/claude-auto-dev.git' }));
    check('isAutodevRepo matches the tree name without a remote', rules.isAutodevRepo({ root: '/x/claude-auto-dev', remote: null }));
    check('isAutodevRepo rejects a null repo', !rules.isAutodevRepo(null));
    check('isAutodevRepo rejects another repo', !rules.isAutodevRepo(OTHER_REPO));

    // the hook threads the decision: a deny returns { deny }, a rewrite hands
    // next the rewritten command and adds a context note without dropping ref
    {
        const on3 = fakeOn();
        await fn.register(on3, {});
        const tc = on3.find('tool.call', 'tool', 'Bash').hook;
        const { $: $repo, log } = fakeDollar({ cwd: posix, repo: AUTODEV_REPO });
        let nextCalled = false;
        const d = await tc($repo, { tool: 'Bash', tool_use_id: 't5', command: 'git commit -m "x"' }, async () => { nextCalled = true; return { ref: 1, result: {} }; });
        check('hook denies git commit -m in this repo without calling next', !nextCalled && typeof d.deny === 'string' && d.deny.includes('git-commit-m'), JSON.stringify(d));
        check('the deny is logged by rule id only', log.some((l) => /denied a Bash call \(git-commit-m\)/.test(l)), log.join(' | '));

        const { $: $win } = fakeDollar({ cwd: win, repo: OTHER_REPO });
        let ranWith = null;
        const r = await tc($win, { tool: 'Bash', tool_use_id: 't6', command: 'git show HEAD:.gitignore' }, async (e2) => { ranWith = e2.command; return { ref: 3, result: { stdout: 'node_modules\n', stderr: '', interrupted: false, isImage: false }, text: 'node_modules' }; });
        check('hook hands next the rewritten command', ranWith === 'MSYS_NO_PATHCONV=1 git show HEAD:.gitignore', ranWith);
        check('a rewrite keeps core\'s ref and adds one context note', r.ref === 3 && Array.isArray(r.context) && r.context.length === 1 && /MSYS_NO_PATHCONV/.test(r.context[0]), JSON.stringify(r));
    }

    // --- 5. attribution --------------------------------------------------------
    console.log('\n== attribution.text');
    {
        const on4 = fakeOn();
        await fn.register(on4, {});
        const at = on4.find('attribution.text', 'kind', 'commit').hook;
        const { $ } = fakeDollar();
        const r = await at($, { kind: 'commit', text: 'Co-Authored-By: Claude <noreply@example.com>' }, async () => ({ text: 'unused' }));
        check('the commit trailer becomes empty text', r && r.text === '', JSON.stringify(r));
        check('no hook is registered for the pr footer', !on4.find('attribution.text', 'kind', 'pr'));
    }

    // --- 6. sprint status: parity with prd-states.js, then the line ----------
    console.log('\n== sprint status');
    const fixtures = {
        flatAllStates: { stories: {
            a: { passes: true }, b: { passes: null }, c: { passes: false }, d: { passes: 'deferred' },
            e: { passes: 'needs-setup' }, f: {}, g: { passes: 'maybe' }, h: null,
        } },
        nested: { sprints: [
            { id: 1, stories: { 'S1-001': { passes: true }, 'S1-002': { passes: null } } },
            { id: 2, stories: { 'S1-002': { passes: true }, 'S2-001': { passes: false } } },
        ], stories: { legacy: { passes: null } } },
        nestedWithoutStories: { sprints: [{ id: 1 }], stories: { x: { passes: null } } },
        empty: {},
        nullFile: null,
        wrongType: 'not an object',
        arrayStories: { stories: [{ passes: true }, { passes: null }] },
    };
    let parity = 0;
    for (const [name, prd] of Object.entries(fixtures)) {
        const mine = JSON.stringify(status.summarise(status.storiesOf(prd)));
        const theirs = JSON.stringify(prdStates.summarise(prdStates.storiesOf(prd)));
        const ok = mine === theirs;
        if (ok) parity++;
        check(`parity with prd-states.js: ${name}`, ok, `mine=${mine}\n       theirs=${theirs}`);
    }
    console.log(`  population: ${Object.keys(fixtures).length} fixtures, ${parity} identical`);

    const tally = { redacted: 2, denied: 1, rewritten: 0 };
    const line = status.formatStatus({ counts: status.summarise(status.storiesOf(fixtures.flatAllStates)), tally });
    // 3 pending: `b` (null), `f` (no passes key) and `h` (a null story), which
    // is what prd-states.js counts too; the parity check above is the authority.
    check('status names every non-zero state', /3 pending/.test(line) && /1 failed/.test(line) && /1 needs-setup/.test(line) && /1 deferred/.test(line) && /1 UNRECOGNISED/.test(line) && /1\/8 done/.test(line), line);
    check('status carries the tally', /redacted 2 · denied 1 · rewrote 0/.test(line), line);
    check('status without prd.json says so', /no prd\.json/.test(status.formatStatus({ counts: null, tally })));
    check('status with an empty prd says no stories found', /no stories found/.test(status.formatStatus({ counts: status.summarise({}), tally })));

    {
        const on5 = fakeOn();
        await fn.register(on5, {});
        const ss = on5.find('session.start').hook;
        const files = { 'prd.json': JSON.stringify({ stories: { a: { passes: null }, b: { passes: null }, c: { passes: false } } }) };
        const { $, status: pinned } = fakeDollar({ files });
        let nexted = false;
        const r = await ss($, { cwd: '/x' }, async (e2) => { nexted = true; return { cwd: e2.cwd }; });
        check('session.start pins a status line from prd.json and calls next', nexted && r.cwd === '/x' && pinned.length === 1 && /2 pending · 1 failed/.test(pinned[0]), pinned[0]);

        const { $: $nofile, status: pinned2 } = fakeDollar({ files: {} });
        await ss($nofile, { cwd: '/x' }, async (e2) => ({ cwd: e2.cwd }));
        check('session.start without prd.json still pins a line', pinned2.length === 1 && /no prd\.json/.test(pinned2[0]), pinned2[0]);

        const { $: $broken, status: pinned3 } = fakeDollar({ failFs: true });
        let nexted3 = false;
        await ss($broken, { cwd: '/x' }, async (e2) => { nexted3 = true; return { cwd: e2.cwd }; });
        check('a failing $.fs never stops next from running', nexted3 && pinned3.length === 1, pinned3[0]);

        const tcmp = on5.find('turn.complete').hook;
        const { $: $t, status: pinned4 } = fakeDollar({ files });
        const rt = await tcmp($t, { answer: 'done', durationMs: 10, aborted: false, turnId: 'x', reason: 'answer' }, async () => ({ text: 'done' }));
        check('turn.complete refreshes the status and returns next\'s text', rt.text === 'done' && pinned4.length === 1 && /2 pending/.test(pinned4[0]), JSON.stringify(rt));
    }

    // --- 7. the scanner's rule: `$` is never a value ---------------------------
    console.log('\n== source discipline');
    // Comments are stripped first: the entry's own header explains the rule
    // by quoting `$`, and a stale comment must not select or excuse anything.
    const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const src = code(fs.readFileSync(ENTRY, 'utf8'));
    // `$` followed by anything but `.noun` is `$` as a value: passed, returned,
    // bound. The legal shapes are `$.noun.event(`, the hook parameter
    // `($, e, next)`, and a template literal's `${`.
    const dollarUses = src.match(/(?<![\w$])\$(?![\w${])[^\n]{0,12}/g) || [];
    const illegal = dollarUses.filter((u) => !/^\$\./.test(u) && !/^\$,\s*e,\s*next\)/.test(u));
    check('the entry never uses $ except as $.noun.event(...) or the hook parameter', illegal.length === 0, JSON.stringify(illegal));
    const helpers = ['redact.mjs', 'bash-rules.mjs', 'sprint-status.mjs'];
    let pure = 0;
    for (const h of helpers) {
        const s = code(fs.readFileSync(path.join(FN_DIR, h), 'utf8'));
        const ok = !/\$\.(ui|fs|session|store|model|http|tool|mcp|agent|clock|audio|prompt|turn)\./.test(s);
        if (ok) pure++;
        check(`helper ${h} makes no $ call`, ok);
    }
    console.log(`  population: ${helpers.length} helpers, ${pure} pure`);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
