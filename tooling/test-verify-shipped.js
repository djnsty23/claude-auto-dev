#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/verify-shipped.js.
// Run: node tooling/test-verify-shipped.js
// Exits 1 on any failure, 0 when all pass.
//
// THE SUBJECT RUNS AS A SUBPROCESS and every verdict below is read from its
// printed line and its exit status, the two things a caller consumes. Network
// checks hit a local server written here. GitHub is a fake gh that answers from
// a table written here. The browser is a fake driver by default, because CI has
// no Chromium. Set VERIFY_SHIPPED_PLAYWRIGHT to a directory holding playwright
// and the same browser cases run through real headless Chromium instead.
//
// Every expected status and value is a literal in this file, so narrowing a
// pattern list in the subject cannot narrow a fixture with it.

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'verify-shipped.js');
const lib = require(SUBJECT);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++;
    else { fail++; failures.push(label); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyshipped'));
// Removed on every way out, a throw outside main() included.
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* nothing left to report to */ } });
const SHA_GOOD = 'a'.repeat(40);
const SHA_OLD = 'b'.repeat(40);
const SHA_WRONG = 'c'.repeat(40);
const SHA_SKIPPED = 'd'.repeat(40);
const SHA_GHOST = 'f'.repeat(40);
const LONG = `<h1>Shipped</h1><p>${'real page text '.repeat(60)}</p>`;
const page = (body, title = 'Real page') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

let hangHits = 0;
let otherAuthSeen = 0;
const otherServer = http.createServer((req, res) => {
    if (req.headers.authorization) otherAuthSeen++;
    res.writeHead(200);
    res.end('ok');
});

const server = http.createServer((req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(body); };
    const base = `http://127.0.0.1:${server.address().port}`;
    switch (req.url.split('?')[0]) {
    case '/ok': return send(200, page(LONG));
    case '/console-error': return send(200, page(`${LONG}<script>console.error('planted')</script>`));
    case '/no-string': return send(200, page(LONG));
    case '/protected-open': return send(200, page('admin table'));
    case '/protected': return send(401, 'no');
    case '/protected-403-challenge': return send(403, page('x'), { 'x-vercel-mitigated': 'challenge' });
    case '/to-login': return send(307, '', { location: '/login?next=1' });
    case '/login': return send(200, 'sign in');
    case '/to-elsewhere': return send(307, '', { location: '/somewhere' });
    case '/challenge': return send(429, page('x', 'Vercel Security Checkpoint'), { 'x-vercel-mitigated': 'challenge' });
    case '/plain-429': return send(429, 'slow down');
    case '/checkpoint-200': return send(200, page('x', 'Vercel Security Checkpoint'));
    case '/boom': return send(500, 'boom');
    case '/slow': return setTimeout(() => send(200, page(LONG)), 500) && undefined;
    case '/slower': return setTimeout(() => send(200, page(LONG)), 3000) && undefined;
    case '/sitemap-slower': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>${base}/slower?${n}</loc>`).join('')}</urlset>`);
    case '/hang': hangHits++; return undefined;
    case '/version-short': return send(200, JSON.stringify({ sha: 'a' }));
    case '/long-forbidden': return send(200, page(`${LONG}${'x '.repeat(110000)}ZZMARKER`));
    case '/sitemap-other': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>http://127.0.0.1:${otherServer.address().port}/p${n}</loc>`).join('')}</urlset>`);
    case '/sitemap-same': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>${base}/needs-token?${n}</loc>`).join('')}</urlset>`);
    case '/needs-token': return req.headers.authorization === 'Bearer TOK' ? send(200, 'ok') : send(500, 'no token');
    case '/sitemap-checkpoints': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>${base}/checkpoint-200?${n}</loc>`).join('')}</urlset>`);
    case '/version': return send(200, JSON.stringify({ sha: SHA_GOOD }));
    case '/sitemap': return send(200, `<urlset>${[1, 2, 3, 4, 5, 6].map((n) => `<loc>${base}/ok?${n}</loc>`).join('')}</urlset>`);
    case '/sitemap-redirect': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>${base}/to-login?${n}</loc>`).join('')}</urlset>`);
    case '/sitemap-short': return send(200, `<urlset><loc>${base}/ok</loc></urlset>`);
    case '/sitemap-empty': return send(200, '<urlset></urlset>');
    case '/sitemap-bad': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>${base}/${n === 3 ? 'boom' : 'ok'}?${n}</loc>`).join('')}</urlset>`);
    case '/thin': return send(200, page('<h1>Thin</h1><p>short</p>'));
    case '/no-h1': return send(200, page(`<p>${'real page text '.repeat(60)}</p>`));
    case '/wide': return send(200, page(`${LONG}<div style="width:600px">wide</div>`));
    case '/sitemap-relative': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>/ok?${n}</loc>`).join('')}</urlset>`);
    case '/sitemap-cf': return send(403, page('x'), { 'cf-mitigated': 'challenge' });
    case '/sitemap-challenged': return send(200, `<urlset>${[1, 2, 3, 4, 5].map((n) => `<loc>${base}/challenge?${n}</loc>`).join('')}</urlset>`);
    default: return send(404, 'missing');
    }
});

// A fake gh: reads routes.json, prints the body for the endpoint, or an HTTP error like the real one.
// A pull request list (route "repos/O/N/pulls#O:HEAD") is served the way the query asks: the state filter
// applied (open when absent, as GitHub does), newest first only for sort=created&direction=desc and oldest
// first otherwise, cut to per_page. So a reader that drops the order or the state grades the wrong PR.
const FAKE_GH = path.join(root, 'fake-gh.js');
const ROUTES = path.join(root, 'routes.json');
const GH_LOG = path.join(root, 'gh.log');
fs.writeFileSync(FAKE_GH, `
const fs = require('fs');
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(ROUTES)}, 'utf8'));
const endpoint = process.argv[3];
fs.appendFileSync(${JSON.stringify(GH_LOG)}, endpoint + '\\n');
const list = /^(repos\\/[^/]+\\/[^/]+)\\/pulls\\?(.*)$/.exec(endpoint);
let value;
if (list) {
    const q = new URLSearchParams(list[2]);
    const prs = routes[list[1] + '/pulls#' + q.get('head')];
    if (prs) {
        const state = q.get('state') || 'open';
        const newestFirst = q.get('sort') === 'created' && q.get('direction') === 'desc';
        const kept = prs.filter((pr) => state === 'all' || pr.state === state).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        if (newestFirst) kept.reverse();
        value = kept.slice(0, Number(q.get('per_page') || 30));
    }
} else if (Object.prototype.hasOwnProperty.call(routes, endpoint)) value = routes[endpoint];
if (value === undefined) { process.stderr.write('gh: HTTP 404\\n'); process.exitCode = 1; }
else if (typeof value === 'number') { process.stderr.write('gh: HTTP ' + value + '\\n'); process.exitCode = 1; }
else process.stdout.write(JSON.stringify(value));
`);
const prAt = (number, state, merged, day, base = 'main') => ({ number, state, merged_at: merged ? `2026-11-${day}T00:00:00Z` : null, created_at: `2026-11-${day}T00:00:00Z`, base: { ref: base } });
const b64 = (s) => Buffer.from(s).toString('base64');
fs.writeFileSync(ROUTES, JSON.stringify({
    // The repo reads, so a 404 inside it is an answer. o/private has no route at all: GitHub hides a repo the token cannot see.
    'repos/o/app': { full_name: 'o/app', default_branch: 'main' },
    'repos/o/app/commits/HEAD': { sha: SHA_GOOD },
    [`repos/o/app/commits/${SHA_GOOD}`]: { sha: SHA_GOOD },
    [`repos/o/app/commits/${SHA_GOOD}/status`]: { statuses: [{ context: 'Vercel', state: 'success', description: 'Deployment has completed' }] },
    [`repos/o/app/commits/${SHA_OLD}/status`]: { statuses: [{ context: 'Vercel', state: 'failure', description: 'Deployment failed' }] },
    [`repos/o/app/commits/${SHA_SKIPPED}/status`]: { statuses: [{ context: 'Vercel', state: 'success', description: 'Canceled by Ignored Build Step' }] },
    [`repos/o/app/commits/${SHA_WRONG}/status`]: { statuses: [{ context: 'Vercel', state: 'pending', description: 'Building' }] },
    'repos/o/app/deployments?environment=Production&per_page=30': [{ id: 1, sha: SHA_GOOD }],
    'repos/o/app/deployments/1/statuses?per_page=1': [{ state: 'success' }],
    [`repos/o/app/compare/${SHA_GOOD}...${SHA_SKIPPED}`]: { status: 'ahead', commits: [{ sha: SHA_SKIPPED }] },
    [`repos/o/app/compare/${SHA_GOOD}...${SHA_WRONG}`]: { status: 'ahead', commits: [{ sha: SHA_WRONG }] },
    'repos/o/app/contents/VERSION': { content: b64('8.5.0\n') },
    'repos/o/app/git/ref/tags/v8.5.0': { ref: 'refs/tags/v8.5.0' },
    'repos/o/app/pulls/7': { merged: true, state: 'closed', base: { ref: 'main' } },
    'repos/o/app/pulls/8': { merged: false, state: 'open', base: { ref: 'main' } },
    // A stacked PR merged into another feature branch, not the default branch.
    'repos/o/app/pulls/21': { merged: true, state: 'closed', base: { ref: 'feat-a' } },
    'repos/o/app/pulls#o:stacked': [prAt(21, 'closed', true, '09', 'feat-a')],
    // The default branch cannot be read (gh answers 503), so a merge cannot be placed.
    'repos/o/nobase': 503,
    'repos/o/nobase/pulls/7': { merged: true, state: 'closed', base: { ref: 'main' } },
    'repos/o/nobase/pulls#o:feature': [prAt(7, 'closed', true, '01')],
    'repos/o/app/pulls#o:feature': [prAt(12, 'closed', true, '01')],
    'repos/o/app/pulls#o:abandoned': [prAt(13, 'closed', false, '01')],
    // A reused branch name: the old PR merged, a newer one from the same branch is open.
    'repos/o/app/pulls#o:reused': [prAt(12, 'closed', true, '01'), prAt(15, 'open', false, '05')],
    'repos/o/app/pulls#o:fresh': [prAt(16, 'open', false, '05')],
    'repos/o/app/pulls#o:never-opened': [],
    // The newest PR from the branch closed without merging, over an older merge: the branch's last word is "not shipped".
    'repos/o/app/pulls#o:reused2': [prAt(12, 'closed', true, '01'), prAt(20, 'closed', false, '09')],
    // The newest merged, over an older one closed unmerged.
    'repos/o/app/pulls#o:second-try': [prAt(14, 'closed', false, '01'), prAt(22, 'closed', true, '09')],
    'repos/o/denied/commits/HEAD': 401,
    'repos/o/notag/contents/VERSION': { content: b64('8.5.0\n') },
    'repos/o/failedtop/deployments?environment=Production&per_page=30': [{ id: 2, sha: SHA_OLD }, { id: 1, sha: SHA_GOOD }],
    'repos/o/failedtop/deployments/2/statuses?per_page=1': [{ state: 'failure' }],
    'repos/o/failedtop/deployments/1/statuses?per_page=1': [{ state: 'success' }],
    [`repos/o/failedtop/compare/${SHA_GOOD}...${SHA_SKIPPED}`]: { status: 'ahead', commits: [{ sha: SHA_SKIPPED }] },
    [`repos/o/failedtop/compare/${SHA_OLD}...${SHA_SKIPPED}`]: { status: 'ahead', commits: [{ sha: SHA_SKIPPED }] },
    [`repos/o/failedtop/commits/${SHA_SKIPPED}/status`]: { statuses: [{ context: 'Vercel', state: 'success', description: 'Canceled by Ignored Build Step' }] },
    'repos/o/mixed/deployments?environment=Production&per_page=30': [{ id: 5, sha: SHA_GOOD }],
    'repos/o/mixed/deployments/5/statuses?per_page=1': [{ state: 'success' }],
    [`repos/o/mixed/compare/${SHA_GOOD}...${SHA_WRONG}`]: { status: 'ahead', commits: [{ sha: SHA_WRONG }] },
    [`repos/o/mixed/commits/${SHA_WRONG}/status`]: { statuses: [{ context: 'Vercel', state: 'failure', description: 'Build failed' }, { context: 'ci/e2e', state: 'success', description: 'Canceled by Ignored Build Step' }] },
    [`repos/o/mixed/compare/${SHA_GOOD}...${SHA_OLD}`]: { status: 'ahead', commits: [{ sha: SHA_OLD }] },
    [`repos/o/mixed/commits/${SHA_OLD}/status`]: { statuses: [{ context: 'Vercel', state: 'failure', description: 'Ignored Build Step crashed' }] },
    // Two Production successes: GitHub leaves the older one at success after the newer one went live.
    'repos/o/superseded/deployments?environment=Production&per_page=30': [{ id: 30, sha: SHA_GOOD }, { id: 31, sha: SHA_OLD }],
    'repos/o/superseded/deployments/30/statuses?per_page=1': [{ state: 'success' }],
    'repos/o/superseded/deployments/31/statuses?per_page=1': [{ state: 'success' }],
    // The expected sha's own deployment, newer than the live one, in each state that is not live.
    'repos/o/states/deployments?environment=Production&per_page=30': [{ id: 40, sha: SHA_WRONG }, { id: 41, sha: SHA_OLD }, { id: 42, sha: SHA_SKIPPED }, { id: 43, sha: SHA_GOOD }],
    'repos/o/states/deployments/40/statuses?per_page=1': [{ state: 'in_progress' }],
    'repos/o/states/deployments/41/statuses?per_page=1': [{ state: 'failure' }],
    'repos/o/states/deployments/42/statuses?per_page=1': [{ state: 'inactive' }],
    'repos/o/states/deployments/43/statuses?per_page=1': [{ state: 'success' }],
    // Production runs a sha the repo does not hold, while the expected sha is in the repo: the compare 404 blames production.
    'repos/o/ghost/deployments?environment=Production&per_page=30': [{ id: 50, sha: SHA_GHOST }],
    'repos/o/ghost/deployments/50/statuses?per_page=1': [{ state: 'success' }],
    [`repos/o/ghost/commits/${SHA_GOOD}`]: { sha: SHA_GOOD },
}));

// A fake playwright driver. It fetches the real local page, and treats the page's own script text as what ran.
const FAKE_DRIVER = path.join(root, 'fake-driver.js');
const LAUNCH_LOG = path.join(root, 'launch.log');
fs.writeFileSync(FAKE_DRIVER, `
const fs = require('fs');
// Playwright reads PWDEBUG when its module loads, so the fake must too.
const PWDEBUG_AT_LOAD = process.env.PWDEBUG || null;
// The viewport width comes from newContext, and the page is as wide as its widest inline width:NNNpx, as in Chromium.
function newPage(width) {
    const handlers = {};
    const frame = {};
    let state = { title: '', text: '', html: '', url: '', errors: 0 };
    return {
        on(name, fn) { handlers[name] = fn; },
        mainFrame() { return frame; },
        async goto(url) {
            if (url.includes(':1/')) throw new Error('page.goto: net::ERR_UNSAFE_PORT at ' + url + '\\nCall log: more');
            const res = await fetch(url);
            const html = await res.text();
            state = { title: (/<title>([^<]*)/.exec(html) || [])[1] || '', html, text: html.replace(/<script[\\\\s\\\\S]*?<\\/script>|<[^>]+>/g, ''), url };
            const headers = Object.fromEntries(res.headers.entries());
            if (handlers.response) handlers.response({ status: () => res.status, headers: () => headers, frame: () => frame, request: () => ({ isNavigationRequest: () => true }) });
            if (/console\\.error/.test(html) && handlers.console) handlers.console({ type: () => 'error', text: () => 'planted' });
            return { status: () => res.status };
        },
        async evaluate(fn, arg) {
            const body = { innerText: state.text };
            const inline = [...state.html.matchAll(/width:(\\d+)px/g)].map((m) => Number(m[1]));
            const doc = { title: state.title, body, documentElement: { scrollWidth: Math.max(width, ...inline) }, querySelectorAll: (s) => ({ length: (state.html.match(new RegExp('<' + s + '[ >]', 'g')) || []).length }) };
            global.document = doc; global.location = { href: state.url }; global.window = { innerWidth: width };
            return fn(arg);
        },
    };
}
module.exports = { chromium: {
    async launchServer(options) {
        fs.appendFileSync(${JSON.stringify(LAUNCH_LOG)}, JSON.stringify({ event: 'launch', ...options, pwdebug: PWDEBUG_AT_LOAD }) + '\\n');
        if (process.env.FAKE_DRIVER_NO_START) throw new Error('browser failed to start');
        if (process.env.FAKE_DRIVER_SLOW_LAUNCH) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DRIVER_SLOW_LAUNCH)));
        return { wsEndpoint: () => 'ws://fake', kill: async () => { fs.appendFileSync(${JSON.stringify(LAUNCH_LOG)}, JSON.stringify({ event: 'kill' }) + '\\n'); } };
    },
    async connect() {
        if (process.env.FAKE_DRIVER_NO_CONNECT) throw new Error('connect failed');
        return { newContext: (options) => (process.env.FAKE_DRIVER_HANG_CONTEXT ? new Promise(() => {}) : Promise.resolve({ newPage: async () => newPage(options.viewport.width), close: async () => {} })), close: async () => {} };
    },
} };
`);

// Runs that must find no driver are pointed at an empty folder inside this suite's own temp directory,
// so they never search the temp folder or the home folder for whatever playwright happens to be there.
const NO_DRIVER = path.join(root, 'no-driver');
fs.mkdirSync(NO_DRIVER);

const REAL_PLAYWRIGHT = process.env.VERIFY_SHIPPED_PLAYWRIGHT || null;
const DRIVER = REAL_PLAYWRIGHT || FAKE_DRIVER;

// 0xC0000409, a Windows native fast-fail. 4 of 4500 subject runs died this way with no output, 0 of 5000
// bare node and fetch children did, and its cause is not known. It never reads as a pass, but about 120
// children per suite would turn that into a flaky gate. So it alone is re-spawned, at most 3 times, and printed.
const NATIVE_CRASH = 3221226505;
const MAX_NATIVE_CRASHES = 3;
let nativeCrashes = 0;

let configCount = 0;
async function run(config, options = {}) {
    const file = path.join(root, `config-${++configCount}.json`);
    fs.writeFileSync(file, options.raw ? config : JSON.stringify(config));
    let result = await runOnce(file, options);
    while (result.status === NATIVE_CRASH && result.stdout === '' && nativeCrashes < MAX_NATIVE_CRASHES) {
        nativeCrashes++;
        result = await runOnce(file, options);
    }
    return result;
}

function runOnce(file, { args = [], env = {}, timeoutMs = 90000 }) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SUBJECT, 'run', '--config', file, '--playwright', DRIVER, ...args], {
            env: { ...process.env, VERIFY_SHIPPED_GH: FAKE_GH, ...env }, windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const startedAt = Date.now();
        const killer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => { clearTimeout(killer); resolve({ status, stdout, stderr, ms: Date.now() - startedAt }); });
    });
}

const lineOf = (r, id) => (r.stdout.split('\n').find((l) => l.startsWith(`CHECK ${id}: `)) || '');
const statusOf = (r, id) => (/^CHECK \S+: (\S+) \|/.exec(lineOf(r, id)) || [])[1] || null;
const browserFast = { settleMs: 200 };

async function single(label, c, expectedStatus, expectedExit, valuePattern, opts) {
    const r = await run({ checks: [{ id: 'X1', ...c }] }, opts);
    const line = lineOf(r, 'X1');
    const ok = statusOf(r, 'X1') === expectedStatus && r.status === expectedExit && (!valuePattern || valuePattern.test(line));
    check(label, ok, `exit=${r.status} line=${line} stderr=${r.stderr.slice(0, 200)}`);
    return r;
}

async function main() {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
    const u = (p) => `http://127.0.0.1:${server.address().port}${p}`;
    const appCheck = { repo: 'o/app' };

    // Section A: the population and the refusals. Nothing may run on a refused config.
    {
        const r = await run({ checks: [] });
        check('empty config refused with exit 2', r.status === 2 && /empty config/.test(r.stderr), `exit=${r.status} ${r.stderr}`);
        check('empty config prints no CHECK line and no verdict', !/^CHECK /m.test(r.stdout) && !/POPULATION/.test(r.stdout), r.stdout);
        const missing = await run({});
        check('config without a checks array refused', missing.status === 2 && /no checks array/.test(missing.stderr), missing.stderr);
        const notJson = await run('{nope', { raw: true });
        check('unparsable config refused', notJson.status === 2 && /not JSON/.test(notJson.stderr), notJson.stderr);
        const dup = await run({ checks: [{ id: 'a', type: 'http', url: u('/ok') }, { id: 'a', type: 'http', url: u('/ok') }] });
        check('duplicate id refused', dup.status === 2 && /duplicate check id/.test(dup.stderr), dup.stderr);
        const unknown = await run({ checks: [{ id: 'a', type: 'telepathy' }] });
        check('unknown type refused', unknown.status === 2 && /unknown type/.test(unknown.stderr), unknown.stderr);
        const noUrl = await run({ checks: [{ id: 'a', type: 'http' }] });
        check('http without url refused', noUrl.status === 2 && /needs url/.test(noUrl.stderr), noUrl.stderr);
        const badRe = await run({ checks: [{ id: 'a', type: 'http', url: u('/ok'), bodyPattern: '(' }] });
        check('invalid regex refused before running', badRe.status === 2 && /not a valid regex/.test(badRe.stderr) && !/^CHECK/m.test(badRe.stdout), badRe.stderr);
        const expectCount = await run({ expectCount: 2, checks: [{ id: 'a', type: 'http', url: u('/ok') }] });
        check('expectCount mismatch refused', expectCount.status === 2 && /expectCount 2/.test(expectCount.stderr), expectCount.stderr);
        const sel = await run({ checks: [{ id: 'a', type: 'http', url: u('/ok'), repo: 'o/app' }] }, { args: ['--repo', 'o/other', '--sha', SHA_GOOD] });
        check('--repo selecting nothing refused', sel.status === 2 && /selects 0 of 1/.test(sel.stderr), sel.stderr);
        const half = await run({ checks: [{ id: 'a', type: 'http', url: u('/ok') }] }, { args: ['--repo', 'o/app'] });
        check('--repo without --sha refused', half.status === 2 && /go together/.test(half.stderr), half.stderr);
        const dots = await run({ checks: [{ id: 'a', type: 'http', url: u('/ok'), repo: 'o/app' }] }, { args: ['--repo', '../app', '--sha', SHA_GOOD] });
        check('--repo made of dots is refused', dots.status === 2 && /--repo must be OWNER\/NAME/.test(dots.stderr), dots.stderr);
        // Each value below reached a probe or a gh endpoint before it was refused. Nothing may run.
        const refusals = [
            ['deployed-sha by url without a pattern', { type: 'deployed-sha', repo: 'o/app', url: u('/version') }, /deployed-sha by url needs pattern/],
            ['statuses given as a string', { type: 'refused', url: u('/ok'), statuses: '1200' }, /statuses must be an array of whole numbers from 400 to 599/],
            ['statuses holding a success status', { type: 'refused', url: u('/ok'), statuses: [200] }, /statuses must be an array/],
            ['a fractional expectStatus', { type: 'http', url: u('/ok'), expectStatus: 200.5 }, /expectStatus must be a whole number/],
            ['a fractional sample', { type: 'sitemap', url: u('/sitemap'), sample: 2.5 }, /sample must be a whole number/],
            ['minLocs given as a string', { type: 'sitemap', url: u('/sitemap'), minLocs: '5' }, /minLocs must be a whole number/],
            ['a zero sample, which can never pass', { type: 'sitemap', url: u('/sitemap'), sample: 0 }, /check a: sample must be a whole number of 1 or more/],
            ['a zero minLocs', { type: 'sitemap', url: u('/sitemap-empty'), minLocs: 0 }, /check a: minLocs must be a whole number of 1 or more/],
            ['a zero width', { type: 'browser', url: u('/ok'), widths: [0] }, /widths must be a non-empty array of positive whole numbers/],
            ['a PR number carrying a query', { type: 'pr-merged', repo: 'o/app', number: '7?x=1' }, /number must be a positive whole number/],
            ['a versionPath climbing out', { type: 'release-tag', repo: 'o/app', versionPath: '../secrets' }, /versionPath must be a file path/],
            ['a versionPath carrying a query', { type: 'release-tag', repo: 'o/app', versionPath: 'VERSION?ref=x' }, /versionPath must be a file path/],
            ['a versionPath carrying a fragment', { type: 'plugin-version', versionRepo: 'o/app', versionPath: 'VERSION#x' }, /versionPath must be a file path/],
            ['allowSkipped given as a string', { type: 'commit-status', repo: 'o/app', allowSkipped: 'yes' }, /allowSkipped must be true or false/],
            // A guard value of the wrong type compared as false and dropped the guard: "0px" let 210px of overflow pass.
            ['minTextLen given as a string', { type: 'browser', url: u('/thin'), widths: [390], minTextLen: '500' }, /check a: minTextLen must be a whole number of 0 or more/],
            ['minH1 carrying a unit', { type: 'browser', url: u('/no-h1'), widths: [390], minH1: '1x' }, /check a: minH1 must be a whole number of 0 or more/],
            ['maxOverflowPx carrying a unit', { type: 'browser', url: u('/wide'), widths: [390], maxOverflowPx: '0px' }, /check a: maxOverflowPx must be a whole number of 0 or more/],
            ['a fractional maxConsoleErrors', { type: 'browser', url: u('/console-error'), widths: [390], maxConsoleErrors: 0.5 }, /check a: maxConsoleErrors must be a whole number of 0 or more/],
            ['sampleStatus given as a string', { type: 'sitemap', url: u('/sitemap-redirect'), sampleStatus: '200' }, /check a: sampleStatus must be a whole number from 100 to 599/],
            ['a negative settleMs', { type: 'browser', url: u('/ok'), widths: [390], settleMs: -1 }, /check a: settleMs must be a whole number of 0 or more/],
            ['a zero timeoutMs', { type: 'http', url: u('/ok'), timeoutMs: 0 }, /check a: timeoutMs must be a positive whole number/],
            ['a url that is not absolute http(s)', { type: 'http', url: 'file:///etc/passwd' }, /check a: url must be an absolute http\(s\) URL/],
            // A misspelt key used to be ignored, so the guard it meant was silently absent.
            ['a misspelt requiredText on a browser check', { type: 'browser', url: u('/ok'), widths: [390], requiredTxt: ['Checkout'] }, /check a: unknown key "requiredTxt" for type browser/],
            ['a misspelt forbiddenText on a browser check', { type: 'browser', url: u('/ok'), widths: [390], forbidenText: ['real page'] }, /check a: unknown key "forbidenText" for type browser/],
            ['a misspelt bodyPattern on an http check', { type: 'http', url: u('/ok'), bodyPatern: 'Checkout' }, /check a: unknown key "bodyPatern" for type http/],
            ['a key of another type', { type: 'http', url: u('/ok'), minH1: 1 }, /check a: unknown key "minH1" for type http/],
            ['headless on a check', { type: 'browser', url: u('/ok'), widths: [390], headless: false }, /check a: unknown key "headless" for type browser/],
            // A flag outside the type or mode where it works did nothing and read as if it had.
            ['allowRedirects with sampleStatus', { type: 'sitemap', url: u('/sitemap-redirect'), sampleStatus: 200, allowRedirects: true }, /check a: allowRedirects does nothing with sampleStatus/],
            ['allowSkipped on deployed-sha by url', { type: 'deployed-sha', url: u('/version'), pattern: '"sha":"([0-9a-f]+)"', sha: SHA_GOOD, allowSkipped: true }, /check a: allowSkipped does nothing for deployed-sha by url/],
            ['allowSkipped on an http check', { type: 'http', url: u('/ok'), allowSkipped: true }, /check a: unknown key "allowSkipped" for type http/],
            ['allowRedirects on a browser check', { type: 'browser', url: u('/ok'), widths: [390], allowRedirects: true }, /check a: unknown key "allowRedirects" for type browser/],
            ['environment on deployed-sha by url', { type: 'deployed-sha', url: u('/version'), pattern: '"sha":"([0-9a-f]+)"', sha: SHA_GOOD, environment: 'Preview' }, /check a: environment does nothing for deployed-sha by url/],
            ['pattern on deployed-sha by repo', { type: 'deployed-sha', repo: 'o/app', pattern: '(x)' }, /check a: pattern does nothing for deployed-sha by repo/],
            ['settleMs on a sitemap read via http', { type: 'sitemap', url: u('/sitemap'), settleMs: 100 }, /check a: settleMs does nothing for a sitemap read via http/],
            ['headers on a sitemap read via browser', { type: 'sitemap', via: 'browser', url: u('/sitemap'), headers: { authorization: 'Bearer TOK' } }, /check a: headers does nothing for a sitemap read via browser/],
            ['a PR number and head together', { type: 'pr-merged', repo: 'o/app', number: 7, head: 'feature' }, /check a: pr-merged takes number or head, not both/],
            ['a base given as a number', { type: 'pr-merged', repo: 'o/app', number: 7, base: 5 }, /check a: base must be a non-empty branch name/],
            ['an empty base', { type: 'pr-merged', repo: 'o/app', number: 7, base: '' }, /check a: base must be a non-empty branch name/],
            ['a repo climbing out with ..', { type: 'commit-status', repo: '../x', sha: SHA_GOOD }, /check a: repo must be OWNER\/NAME/],
            ['a repo name made only of dots', { type: 'release-tag', repo: 'o/...' }, /check a: repo must be OWNER\/NAME/],
            ['a versionRepo climbing out with ..', { type: 'plugin-version', versionRepo: '../x' }, /check a: versionRepo must be OWNER\/NAME/],
            ['versionPath without versionRepo',{ type: 'plugin-version', minVersion: '1.0.0', versionPath: 'VERSION' }, /check a: versionPath does nothing without versionRepo/],
        ];
        for (const [label, c, pattern] of refusals) {
            fs.writeFileSync(GH_LOG, '');
            const r = await run({ checks: [{ id: 'a', ...c }] });
            check(`refused before running: ${label}`, r.status === 2 && pattern.test(r.stderr) && !/^CHECK /m.test(r.stdout) && fs.readFileSync(GH_LOG, 'utf8') === '', `exit=${r.status} ${r.stderr} ${r.stdout}`);
        }
        const marker = path.join(root, 'config-driver-ran.txt');
        const evil = path.join(root, 'config-driver.js');
        fs.writeFileSync(evil, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`);
        const named = await run({ playwright: evil, checks: [{ id: 'a', type: 'browser', url: u('/ok'), widths: [390] }] });
        check('a config naming the driver is refused and its code never runs', named.status === 2 && /--playwright DIR/.test(named.stderr) && !fs.existsSync(marker), `exit=${named.status} ran=${fs.existsSync(marker)} ${named.stderr}`);
        fs.writeFileSync(GH_LOG, '');
        const topTypo = await run({ expectcount: 1, checks: [{ id: 'a', type: 'commit-status', repo: 'o/app' }] });
        check('a misspelt top-level key is refused before running', topTypo.status === 2 && /unknown top-level key "expectcount"/.test(topTypo.stderr) && !/^CHECK /m.test(topTypo.stdout) && fs.readFileSync(GH_LOG, 'utf8') === '', `exit=${topTypo.status} ${topTypo.stderr}`);
    }

    // The documented key list is the contract: read it from the header, so a documented key cannot be refused by accident.
    {
        const lines = fs.readFileSync(SUBJECT, 'utf8').split('\n');
        const start = lines.findIndex((l) => /Keys each type accepts/.test(l));
        const common = ((/every type also takes ([^)]+)\)/.exec(lines[start] || '') || [])[1] || '').split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
        const documented = {};
        let current = null;
        for (const line of lines.slice(start + 1)) {
            const head = /^ \* {3}([a-z-]+):\s+(.+)$/.exec(line);
            const more = /^ \* {10,}(\S.*)$/.exec(line);
            if (head) { current = head[1]; documented[current] = head[2]; } else if (more && current) documented[current] += `, ${more[1]}`; else break;
        }
        for (const type of Object.keys(documented)) documented[type] = documented[type].split(',').map((s) => s.trim()).filter(Boolean);
        const sorted = (a) => [...a].sort().join(',');
        // A subject that exports no key lists fails these checks instead of crashing the suite, so the tests after them still report.
        const KEYS = lib.KEYS || {};
        const COMMON = lib.COMMON_KEYS || [];
        check('the subject exports its key lists', Boolean(lib.KEYS && lib.COMMON_KEYS), `KEYS ${typeof lib.KEYS}, COMMON_KEYS ${typeof lib.COMMON_KEYS}`);
        check('the header documents every check type and the common keys', start > 0 && sorted(Object.keys(documented)) === sorted(Object.keys(KEYS)) && sorted(common) === sorted(COMMON), `${Object.keys(documented)} | ${common}`);
        const drift = Object.keys(KEYS).filter((type) => sorted(documented[type] || []) !== sorted(KEYS[type]));
        check('the header lists exactly the keys each type accepts', drift.length === 0, drift.map((t) => `${t}: header ${documented[t]} vs code ${KEYS[t]}`).join('; '));
        const base = {
            'commit-status': { repo: 'o/app' }, 'deployed-sha': { repo: 'o/app' }, http: { url: 'https://x.test/a' }, refused: { url: 'https://x.test/a' },
            sitemap: { url: 'https://x.test/sitemap.xml' }, browser: { url: 'https://x.test/a' }, 'plugin-version': { minVersion: '1.0.0' },
            'release-tag': { repo: 'o/app' }, 'pr-merged': { repo: 'o/app', number: 7 },
        };
        const byUrl = { url: 'https://x.test/version', pattern: '"sha":"(\\w+)"', sha: SHA_GOOD };
        // A literal value per key, with type.key where one type needs its mode set. undefined removes a base key.
        const samples = {
            id: {}, type: {}, repo: { repo: 'o/app' }, sha: { sha: SHA_GOOD }, context: { context: 'Vercel' }, allowSkipped: { allowSkipped: true },
            environment: { environment: 'Preview' }, 'deployed-sha.url': byUrl, 'deployed-sha.pattern': byUrl, 'deployed-sha.timeoutMs': { ...byUrl, timeoutMs: 1000 },
            url: { url: 'https://x.test/b' }, method: { method: 'POST' }, headers: { headers: { authorization: 'Bearer t' } }, body: { body: 'x' },
            expectStatus: { expectStatus: 204 }, bodyPattern: { bodyPattern: 'ok' }, bodyAbsent: { bodyAbsent: 'error' }, timeoutMs: { timeoutMs: 1000 },
            statuses: { statuses: [404] }, redirect: { redirect: '^/login' }, minLocs: { minLocs: 1 }, sample: { sample: 2 }, sampleStatus: { sampleStatus: 200 },
            allowRedirects: { allowRedirects: true }, via: { via: 'browser' }, origin: { via: 'browser', origin: 'https://x.test/' }, 'sitemap.settleMs': { via: 'browser', settleMs: 100 },
            widths: { widths: [390] }, requiredText: { requiredText: ['a'] }, forbiddenText: { forbiddenText: ['b'] }, forbiddenSelector: { forbiddenSelector: 'h1' },
            finalUrlPattern: { finalUrlPattern: '/a' }, minTextLen: { minTextLen: 10 }, minH1: { minH1: 0 }, maxOverflowPx: { maxOverflowPx: 5 },
            maxConsoleErrors: { maxConsoleErrors: 1 }, ignoreConsole: { ignoreConsole: ['x'] }, settleMs: { settleMs: 100 },
            pluginRoot: { pluginRoot: '~/plugin' }, minVersion: { minVersion: '1.2.3' }, versionRepo: { versionRepo: 'o/app' },
            'plugin-version.versionPath': { versionRepo: 'o/app', versionPath: 'VERSION' }, versionPath: { versionPath: 'VERSION' }, requiredFiles: { requiredFiles: ['a.js'] },
            number: { number: 8 }, head: { number: undefined, head: 'feature' }, base: { base: 'main' },
        };
        const refusedKeys = [];
        let tried = 0;
        for (const type of Object.keys(documented)) {
            for (const key of [...common, ...documented[type]]) {
                tried++;
                const sample = samples[`${type}.${key}`] || samples[key];
                if (!sample) { refusedKeys.push(`${type}.${key}: no sample value in this suite`); continue; }
                const c = { id: 'k', type, ...base[type], ...sample };
                for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
                try { lib.validateConfig({ checks: [c] }); } catch (e) { refusedKeys.push(`${type}.${key}: ${e.message}`); }
            }
        }
        check(`every documented key is accepted on its type (${tried} type and key pairs)`, tried >= 60 && refusedKeys.length === 0, refusedKeys.join('; '));
    }

    // Section B: help and output shape.
    {
        const help = await new Promise((resolve) => {
            const child = spawn(process.execPath, [SUBJECT, '--help'], { windowsHide: true });
            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.on('close', (status) => resolve({ status, out }));
        });
        check('help prints the run usage and exits 0', help.status === 0 && /verify-shipped\.js run --config/.test(help.out), help.out);
    }

    // Section C: planted defects. Each one must go red for its own named reason.
    await single('plant: wrong expected sha, version endpoint', { type: 'deployed-sha', url: u('/version'), pattern: '"sha":"([0-9a-f]+)"', sha: SHA_WRONG }, 'FAIL', 1, /deployed aaaaaaaa, expected cccccccc/);
    await single('plant: wrong expected sha, deployment record', { type: 'deployed-sha', ...appCheck, sha: SHA_WRONG }, 'FAIL', 1, /Production is at aaaaaaaa, expected cccccccc/);
    await single('plant: console error in the page', { type: 'browser', url: u('/console-error'), widths: [390], ...browserFast }, 'FAIL', 1, /1 console error/);
    await single('plant: required string missing', { type: 'browser', url: u('/no-string'), widths: [390], requiredText: ['this text is not on the page'], ...browserFast }, 'FAIL', 1, /missing required text/);
    await single('plant: protected path answers 200', { type: 'refused', url: u('/protected-open') }, 'FAIL', 1, /not refused: HTTP 200/);
    await single('plant: 429 challenge is INDETERMINATE on http', { type: 'http', url: u('/challenge') }, 'INDETERMINATE', 2, /x-vercel-mitigated: challenge, HTTP 429/);
    await single('plant: 429 challenge is INDETERMINATE on refused', { type: 'refused', url: u('/challenge') }, 'INDETERMINATE', 2, /x-vercel-mitigated/);
    await single('plant: 429 challenge is INDETERMINATE in the browser', { type: 'browser', url: u('/challenge'), widths: [390], ...browserFast }, 'INDETERMINATE', 2, /challenge/, { timeoutMs: 60000 });

    // Section D: the http and refused verdicts, positive and negative.
    await single('http 200 passes with its status in the value', { type: 'http', url: u('/ok') }, 'PASS', 0, /HTTP 200/);
    await single('http body regex passes', { type: 'http', url: u('/ok'), bodyPattern: 'real page text' }, 'PASS', 0, /body matches/);
    await single('http body regex missing fails', { type: 'http', url: u('/ok'), bodyPattern: 'absent words' }, 'FAIL', 1, /body lacks/);
    await single('http forbidden body fails', { type: 'http', url: u('/ok'), bodyAbsent: 'real page text' }, 'FAIL', 1, /body holds/);
    await single('http wrong status fails', { type: 'http', url: u('/boom') }, 'FAIL', 1, /HTTP 500, expected 200/);
    await single('plain 429 without a mitigation header is INDETERMINATE', { type: 'http', url: u('/plain-429') }, 'INDETERMINATE', 2, /rate limited/);
    await single('a 200 checkpoint page is INDETERMINATE', { type: 'http', url: u('/checkpoint-200') }, 'INDETERMINATE', 2, /challenge page/);
    await single('refused 401 passes', { type: 'refused', url: u('/protected') }, 'PASS', 0, /refused: HTTP 401/);
    await single('a 403 carrying a mitigation header is not a refusal', { type: 'refused', url: u('/protected-403-challenge') }, 'INDETERMINATE', 2, /x-vercel-mitigated/);
    await single('named redirect passes', { type: 'refused', url: u('/to-login'), redirect: '^/login' }, 'PASS', 0, /named redirect/);
    await single('a redirect elsewhere fails', { type: 'refused', url: u('/to-elsewhere'), redirect: '^/login' }, 'FAIL', 1, /not matching/);
    await single('a redirect with none named fails', { type: 'refused', url: u('/to-login') }, 'FAIL', 1, /no redirect is named/);
    await single('a 500 is not a refusal', { type: 'refused', url: u('/boom') }, 'FAIL', 1, /not refused: HTTP 500/);

    // Section E: timeouts, attempts and the run deadline.
    {
        hangHits = 0;
        await single('per-probe timeout is INDETERMINATE', { type: 'http', url: u('/hang'), timeoutMs: 300 }, 'INDETERMINATE', 2, /timeout after 300ms/);
        check('a timed-out probe reached the server exactly twice', hangHits === 2, `${hangHits} hits`);
        const file = path.join(root, 'attempts.json');
        const a = await run({ checks: [{ id: 'X1', type: 'http', url: u('/hang'), timeoutMs: 200 }] }, { args: ['--out', file] });
        const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        check('a timeout is retried exactly once', a.status === 2 && receipt.results[0].attempts === 2, JSON.stringify(receipt.results[0]));
        const c = await run({ checks: [{ id: 'X1', type: 'http', url: u('/challenge') }] }, { args: ['--out', file] });
        check('a challenge is not retried', c.status === 2 && JSON.parse(fs.readFileSync(file, 'utf8')).results[0].attempts === 1, fs.readFileSync(file, 'utf8'));
        const d = await run({ checks: [
            { id: 'D1', type: 'http', url: u('/hang'), timeoutMs: 60000 },
            { id: 'D2', type: 'http', url: u('/ok') },
        ] }, { args: ['--deadline-ms', '500'] });
        check('run deadline turns a hung check INDETERMINATE and the run still ends', d.status === 2 && statusOf(d, 'D1') === 'INDETERMINATE' && d.ms < 10000, `${d.ms}ms ${d.stdout}`);
        const closed = await run({ checks: [{ id: 'X1', type: 'http', url: 'http://127.0.0.1:1/x', timeoutMs: 500 }] });
        check('connection refused is INDETERMINATE', closed.status === 2 && statusOf(closed, 'X1') === 'INDETERMINATE', closed.stdout);
    }

    // Section F: sitemaps. The floor is on the location count.
    await single('sitemap with enough locations passes', { type: 'sitemap', url: u('/sitemap') }, 'PASS', 0, /6 locations, 5 of 5 sampled under 300/);
    await single('sitemap exact sample status passes on 200', { type: 'sitemap', url: u('/sitemap'), sampleStatus: 200 }, 'PASS', 0, /5 of 5 sampled answered 200/);
    await single('sitemap exact sample status fails on a redirect', { type: 'sitemap', url: u('/sitemap-redirect'), sampleStatus: 200 }, 'FAIL', 1, /5 of 5 sampled answered 307/);
    await single('sitemap redirects fail by default', { type: 'sitemap', url: u('/sitemap-redirect') }, 'FAIL', 1, /5 of 5 sampled answered 307,307,307,307,307/);
    await single('sitemap redirects pass with allowRedirects', { type: 'sitemap', url: u('/sitemap-redirect'), allowRedirects: true }, 'PASS', 0, /under 400 \(redirects allowed\)/);
    await single('a relative sitemap location fails over http', { type: 'sitemap', url: u('/sitemap-relative') }, 'FAIL', 1, /5 of 5 locations are not absolute http\(s\) URLs, first \/ok$/);
    await single('sitemap below the floor fails', { type: 'sitemap', url: u('/sitemap-short') }, 'FAIL', 1, /1 locations, expected at least 5/);
    await single('empty sitemap fails', { type: 'sitemap', url: u('/sitemap-empty') }, 'FAIL', 1, /0 locations/);
    await single('sitemap with a broken page fails', { type: 'sitemap', url: u('/sitemap-bad') }, 'FAIL', 1, /1 of 5 sampled answered 500/);
    await single('sitemap whose pages are challenged is INDETERMINATE', { type: 'sitemap', url: u('/sitemap-challenged') }, 'INDETERMINATE', 2, /5 of 5 sampled could not be read/);

    // Section G: GitHub facts through the fake gh.
    await single('commit status success passes on the default branch head', { type: 'commit-status', ...appCheck }, 'PASS', 0, /aaaaaaaa Vercel=success/);
    await single('commit status failure fails', { type: 'commit-status', ...appCheck, sha: SHA_OLD }, 'FAIL', 1, /bbbbbbbb Vercel=failure/);
    await single('commit status pending is INDETERMINATE', { type: 'commit-status', ...appCheck, sha: SHA_WRONG }, 'INDETERMINATE', 2, /still pending/);
    await single('an unknown status context is INDETERMINATE', { type: 'commit-status', ...appCheck, context: 'Nonesuch' }, 'INDETERMINATE', 2, /no status matching/);
    await single('a skipped build fails commit status by default', { type: 'commit-status', ...appCheck, sha: SHA_SKIPPED }, 'FAIL', 1, /build skipped by the project, nothing deployed; allowSkipped not set/);
    await single('commit status passes a skipped build only with allowSkipped', { type: 'commit-status', ...appCheck, sha: SHA_SKIPPED, allowSkipped: true }, 'PASS', 0, /build skipped by the project, nothing deployed\)$/);
    fs.writeFileSync(GH_LOG, '');
    await single('gh auth failure is INDETERMINATE', { type: 'commit-status', repo: 'o/denied' }, 'INDETERMINATE', 2, /could not read the head/);
    {
        const lookups = fs.readFileSync(GH_LOG, 'utf8').split('\n').filter((l) => l === 'repos/o/denied/commits/HEAD').length;
        check('a failed head lookup is not cached: the retry asks gh again', lookups === 2, `${lookups} lookups`);
    }
    await single('deployed sha matches production', { type: 'deployed-sha', ...appCheck }, 'PASS', 0, /Production aaaaaaaa success, the newest live deployment/);
    await single('an older success under a newer live deployment fails with both shas', { type: 'deployed-sha', repo: 'o/superseded', sha: SHA_OLD }, 'FAIL', 1, /Production is at aaaaaaaa, a newer live deployment than the expected bbbbbbbb/);
    await single('the expected deployment still in progress is INDETERMINATE', { type: 'deployed-sha', repo: 'o/states', sha: SHA_WRONG }, 'INDETERMINATE', 2, /Production cccccccc in_progress \(still deploying\)/);
    await single('the expected deployment that failed fails', { type: 'deployed-sha', repo: 'o/states', sha: SHA_OLD }, 'FAIL', 1, /Production bbbbbbbb failure/);
    await single('the expected deployment that is inactive fails', { type: 'deployed-sha', repo: 'o/states', sha: SHA_SKIPPED }, 'FAIL', 1, /Production dddddddd inactive/);
    await single('a skipped build ahead of production fails by default', { type: 'deployed-sha', ...appCheck, sha: SHA_SKIPPED }, 'FAIL', 1, /skipped their build, nothing deployed \(allowSkipped not set\)/);
    await single('a skipped build ahead of production passes with allowSkipped and says so', { type: 'deployed-sha', ...appCheck, sha: SHA_SKIPPED, allowSkipped: true }, 'PASS', 0, /skipped their build, nothing deployed$/);
    await single('an expected sha the repo does not have fails, as commit status does', { type: 'deployed-sha', ...appCheck, sha: 'e'.repeat(40) }, 'FAIL', 1, /commit eeeeeeee not found in o\/app/);
    await single('commit status on a sha the repo does not have fails', { type: 'commit-status', ...appCheck, sha: 'e'.repeat(40) }, 'FAIL', 1, /commit eeeeeeee not found in o\/app/);
    // A 404 from a repo the token cannot see says nothing about the sha or the PR.
    await single('commit status in a repo gh cannot see is INDETERMINATE', { type: 'commit-status', repo: 'o/private', sha: SHA_GOOD }, 'INDETERMINATE', 2, /cannot see the repo o\/private \(gh answers 404\), so commit aaaaaaaa not found in o\/private is not an answer/);
    await single('a PR number the repo does not have fails', { type: 'pr-merged', ...appCheck, number: 9 }, 'FAIL', 1, /PR 9 not found$/);
    await single('a PR number in a repo gh cannot see is INDETERMINATE', { type: 'pr-merged', repo: 'o/private', number: 7 }, 'INDETERMINATE', 2, /cannot see the repo o\/private \(gh answers 404\), so PR 7 not found is not an answer/);
    await single('a compare 404 with the expected sha in the repo blames production, as INDETERMINATE', { type: 'deployed-sha', repo: 'o/ghost', sha: SHA_GOOD }, 'INDETERMINATE', 2, /Production is at ffffffff, which o\/ghost does not hold, so it cannot be compared with aaaaaaaa/);
    {
        const r = await run({ checks: [{ id: 'X1', type: 'commit-status', ...appCheck }] }, { args: ['--repo', 'o/app', '--sha', SHA_OLD] });
        check('--sha overrides the expected sha for its repo', statusOf(r, 'X1') === 'FAIL' && /bbbbbbbb/.test(lineOf(r, 'X1')), r.stdout);
        const narrow = await run({ checks: [
            { id: 'IN', type: 'http', url: u('/ok'), repo: 'o/app' },
            { id: 'OUT', type: 'http', url: u('/boom'), repo: 'o/zzz' },
        ] }, { args: ['--repo', 'o/app', '--sha', SHA_GOOD] });
        check('--repo narrows the population', narrow.status === 0 && statusOf(narrow, 'IN') === 'PASS' && lineOf(narrow, 'OUT') === '', narrow.stdout);
    }
    await single('release tag present passes', { type: 'release-tag', ...appCheck }, 'PASS', 0, /tag v8\.5\.0 exists/);
    await single('release tag absent fails', { type: 'release-tag', repo: 'o/notag' }, 'FAIL', 1, /tag v8\.5\.0 is absent/);
    await single('merged PR passes', { type: 'pr-merged', ...appCheck, number: 7 }, 'PASS', 0, /PR 7 merged/);
    await single('open PR fails', { type: 'pr-merged', ...appCheck, number: 8 }, 'FAIL', 1, /state open/);
    await single('merged PR by head branch passes and names the PR', { type: 'pr-merged', ...appCheck, head: 'feature' }, 'PASS', 0, /\| PR 12 merged from feature$/);
    await single('closed unmerged PR by head branch fails', { type: 'pr-merged', ...appCheck, head: 'abandoned' }, 'FAIL', 1, /PR 13 from abandoned was closed without merging \(state closed\)/);
    await single('a branch with no PR fails', { type: 'pr-merged', ...appCheck, head: 'never-opened' }, 'FAIL', 1, /0 merged PRs from never-opened$/);
    await single('a merged PR plus an open one from the same head fails, naming the open PR', { type: 'pr-merged', ...appCheck, head: 'reused' }, 'FAIL', 1, /PR 15 from reused is still open, so the branch has not shipped/);
    await single('an open PR alone by head branch fails', { type: 'pr-merged', ...appCheck, head: 'fresh' }, 'FAIL', 1, /PR 16 from fresh is still open/);
    await single('the newest PR closed unmerged over an older merge fails, naming the newest', { type: 'pr-merged', ...appCheck, head: 'reused2' }, 'FAIL', 1, /PR 20 from reused2 was closed without merging \(state closed\), and it is the newest PR from that branch/);
    await single('the newest PR merged over an older one closed unmerged passes, naming the newest', { type: 'pr-merged', ...appCheck, head: 'second-try' }, 'PASS', 0, /\| PR 22 merged from second-try$/);
    await single('a PR number merged into a non-default base fails, naming the base', { type: 'pr-merged', ...appCheck, number: 21 }, 'FAIL', 1, /PR 21 merged into feat-a, not main$/);
    await single('a head whose newest PR merged into a non-default base fails, naming the base', { type: 'pr-merged', ...appCheck, head: 'stacked' }, 'FAIL', 1, /PR 21 merged into feat-a, not main$/);
    await single('a PR number merged into the base the check names passes', { type: 'pr-merged', ...appCheck, number: 21, base: 'feat-a' }, 'PASS', 0, /\| PR 21 merged$/);
    await single('a merge into main fails when the check names another base', { type: 'pr-merged', ...appCheck, number: 7, base: 'release' }, 'FAIL', 1, /PR 7 merged into main, not release$/);
    for (const [mode, extra] of [['number', { number: 7 }], ['head', { head: 'feature' }]]) {
        fs.writeFileSync(GH_LOG, '');
        await single(`by ${mode}, a default branch gh cannot read is INDETERMINATE`, { type: 'pr-merged', repo: 'o/nobase', ...extra }, 'INDETERMINATE', 2, /could not read the default branch of o\/nobase$/);
        const reads = fs.readFileSync(GH_LOG, 'utf8').split('\n').filter((l) => l === 'repos/o/nobase').length;
        check(`by ${mode}, the second attempt asks gh for the default branch again`, reads === 2, `${reads} reads of repos/o/nobase`);
    }
    {
        // The fake serves oldest first unless the query asks for newest first, so the order must be asked for.
        fs.writeFileSync(GH_LOG, '');
        await single('the list read asks gh for all states, newest first', { type: 'pr-merged', ...appCheck, head: 'second-try' }, 'PASS', 0, /PR 22/);
        const asked = fs.readFileSync(GH_LOG, 'utf8').split('\n').find((l) => /\/pulls\?/.test(l)) || '';
        const q = new URLSearchParams(asked.split('?')[1] || '');
        check('the list query names state=all, sort=created and direction=desc', q.get('state') === 'all' && q.get('sort') === 'created' && q.get('direction') === 'desc', asked);
    }

    // Section H: the installed plugin version.
    {
        const plugin = path.join(root, 'plugin');
        fs.mkdirSync(path.join(plugin, '8.5.0', 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(plugin, '8.5.0', 'scripts', 'wanted.js'), '');
        await single('installed version with its file passes', { type: 'plugin-version', pluginRoot: plugin, versionRepo: 'o/app', minVersion: '8.5.0', requiredFiles: ['scripts/wanted.js'] }, 'PASS', 0, /8\.5\.0 installed, 1 required/);
        await single('missing required file fails', { type: 'plugin-version', pluginRoot: plugin, versionRepo: 'o/app', requiredFiles: ['scripts/absent.js'] }, 'FAIL', 1, /missing scripts\/absent\.js/);
        await single('version below the minimum fails', { type: 'plugin-version', pluginRoot: plugin, minVersion: '8.10.0' }, 'FAIL', 1, /below the required 8\.10\.0/);
        await single('missing plugin root is INDETERMINATE', { type: 'plugin-version', pluginRoot: path.join(root, 'nope'), minVersion: '1.0.0' }, 'INDETERMINATE', 2, /plugin root not found/);
        const empty = path.join(root, 'empty-plugin');
        fs.mkdirSync(empty);
        await single('plugin root with no version fails', { type: 'plugin-version', pluginRoot: empty, minVersion: '1.0.0' }, 'FAIL', 1, /no plugin version/);
    }

    // Section I: browser verdicts and the headless rule.
    {
        await single('browser passes both widths with values', { type: 'browser', url: u('/ok'), ...browserFast }, 'PASS', 0, /2 of 2 widths: w390 HTTP 200/);
        await single('browser HTTP 500 fails', { type: 'browser', url: u('/boom'), widths: [390], ...browserFast }, 'FAIL', 1, /HTTP 500/);
        await single('browser final url mismatch fails', { type: 'browser', url: u('/ok'), widths: [390], finalUrlPattern: '/login', ...browserFast }, 'FAIL', 1, /ended at/);
        await single('browser ignoreConsole suppressor is visible in the value', { type: 'browser', url: u('/console-error'), widths: [390], ignoreConsole: ['planted'], ...browserFast }, 'PASS', 0, /1 ignored by config/);
        await single('browser forbidden selector fails', { type: 'browser', url: u('/ok'), widths: [390], forbiddenSelector: 'h1', ...browserFast }, 'FAIL', 1, /match h1/);
        // One page per guard, each tripping only its own finding, so a removed guard turns exactly one of these green.
        await single('browser text below minTextLen fails', { type: 'browser', url: u('/thin'), widths: [390], ...browserFast }, 'FAIL', 1, /width 390: text \d+ chars$/);
        await single('browser page with fewer h1 than minH1 fails', { type: 'browser', url: u('/no-h1'), widths: [390], ...browserFast }, 'FAIL', 1, /width 390: 0 h1$/);
        await single('browser page wider than the viewport fails maxOverflowPx', { type: 'browser', url: u('/wide'), widths: [390], ...browserFast }, 'FAIL', 1, /width 390: overflow \d+px$/);
        await single('browser overflow within maxOverflowPx passes', { type: 'browser', url: u('/wide'), widths: [390], maxOverflowPx: 400, ...browserFast }, 'PASS', 0, /w390 HTTP 200/);
        if (!REAL_PLAYWRIGHT) {
            fs.rmSync(LAUNCH_LOG, { force: true });
            const offTop = await run({ headless: false, checks: [{ id: 'X1', type: 'browser', url: u('/ok'), widths: [390], ...browserFast }] });
            const offCheck = await run({ checks: [{ id: 'X1', type: 'browser', headless: false, url: u('/ok'), widths: [390], ...browserFast }] });
            check('config cannot turn headless off: both keys are refused and nothing launches', offTop.status === 2 && /unknown top-level key "headless"/.test(offTop.stderr)
                && offCheck.status === 2 && /unknown key "headless"/.test(offCheck.stderr) && !fs.existsSync(LAUNCH_LOG), `${offTop.stderr} ${offCheck.stderr} launched=${fs.existsSync(LAUNCH_LOG)}`);
            await run({ checks: [{ id: 'X1', type: 'browser', url: u('/ok'), widths: [390], ...browserFast }] });
            const launches = fs.readFileSync(LAUNCH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.event === 'launch');
            check('a browser run launches headless', launches.length === 1 && launches[0].headless === true, JSON.stringify(launches));
            await single('a browser that will not start is INDETERMINATE', { type: 'browser', url: u('/ok'), widths: [390] }, 'INDETERMINATE', 2, /browser would not start/, { env: { FAKE_DRIVER_NO_START: '1' } });
        }
        const r = await run({ checks: [{ id: 'X1', type: 'browser', url: u('/ok'), widths: [390], ...browserFast }] });
        check('browser value carries no page text', !/real page text/.test(r.stdout), r.stdout);
        const noDriver = await new Promise((resolve) => {
            const file = path.join(root, 'nodriver.json');
            fs.writeFileSync(file, JSON.stringify({ checks: [{ id: 'X1', type: 'browser', url: u('/ok'), widths: [390] }] }));
            const child = spawn(process.execPath, [SUBJECT, 'run', '--config', file, '--playwright', NO_DRIVER], { cwd: root, windowsHide: true, env: { ...process.env, NODE_PATH: '' } });
            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.on('close', (status) => resolve({ status, out }));
        });
        check('no playwright is INDETERMINATE, not PASS', noDriver.status === 2 && /no playwright resolves/.test(noDriver.out), noDriver.out);
        // --playwright names one place. A driver in its PARENT's node_modules must not load, as require.resolve would.
        const parentMarker = path.join(root, 'parent-driver-ran.txt');
        const parentDir = path.join(root, 'parent');
        fs.mkdirSync(path.join(parentDir, 'node_modules', 'playwright'), { recursive: true });
        fs.mkdirSync(path.join(parentDir, 'child'));
        fs.writeFileSync(path.join(parentDir, 'node_modules', 'playwright', 'index.js'), `require('fs').writeFileSync(${JSON.stringify(parentMarker)}, 'ran'); module.exports = {};`);
        const parentRun = await run({ checks: [{ id: 'X1', type: 'browser', url: u('/ok'), widths: [390], ...browserFast }] }, { args: ['--playwright', path.join(parentDir, 'child')] });
        check('a driver in the parent of the named folder is never loaded', parentRun.status === 2 && /no playwright resolves/.test(lineOf(parentRun, 'X1')) && !fs.existsSync(parentMarker), `ran=${fs.existsSync(parentMarker)} ${parentRun.stdout}`);
        if (!REAL_PLAYWRIGHT) {
            const named = path.join(root, 'named');
            fs.mkdirSync(path.join(named, 'node_modules', 'playwright'), { recursive: true });
            fs.writeFileSync(path.join(named, 'node_modules', 'playwright', 'index.js'), `module.exports = require(${JSON.stringify(FAKE_DRIVER)});`);
            await single('a driver in the named folder\'s node_modules is loaded', { type: 'browser', url: u('/ok'), widths: [390], ...browserFast }, 'PASS', 0, /w390 HTTP 200/, { args: ['--playwright', named] });
        }
    }

    // Section J: the exit reflects every printed finding, and the receipt names the population.
    {
        const failAndOpen = await run({ checks: [{ id: 'P', type: 'http', url: u('/ok') }, { id: 'F', type: 'http', url: u('/boom') }, { id: 'I', type: 'http', url: u('/challenge') }] });
        check('FAIL outranks INDETERMINATE in the exit', failAndOpen.status === 1, failAndOpen.stdout);
        const openOnly = await run({ checks: [{ id: 'P', type: 'http', url: u('/ok') }, { id: 'I', type: 'http', url: u('/challenge') }] });
        check('one INDETERMINATE among passes exits 2', openOnly.status === 2, openOnly.stdout);
        const receiptFile = path.join(root, 'receipt.json');
        const ok = await run({ checks: [{ id: 'Z', type: 'http', url: u('/slow') }, { id: 'A', type: 'http', url: u('/ok') }] }, { args: ['--out', receiptFile] });
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        check('all green exits 0', ok.status === 0, ok.stdout);
        check('lines print in config order', ok.stdout.indexOf('CHECK Z:') < ok.stdout.indexOf('CHECK A:') && ok.stdout.indexOf('CHECK Z:') >= 0, ok.stdout);
        check('receipt holds the population, timestamps and zero tokens', receipt.population.count === 2 && receipt.population.ids.join(',') === 'Z,A' && receipt.startedAt && receipt.finishedAt && receipt.modelTokens === 0 && receipt.exit === 0, JSON.stringify(receipt));
        check('POPULATION line reports what ran', /^POPULATION 2 \| PASS 2 FAIL 0 INDETERMINATE 0 \| \d+ms \| exit 0$/m.test(ok.stdout), ok.stdout);
        fs.writeFileSync(receiptFile, '{"stale":true}');
        const refused = await run({ checks: [] }, { args: ['--out', receiptFile] });
        check('a refused run removes an older receipt', refused.status === 2 && !fs.existsSync(receiptFile), String(fs.existsSync(receiptFile)));
    }

    // Section L: each defect the escalation review reproduced, pinned to its own input.
    await single('skipped-build walk starts from the newest live deployment', { type: 'deployed-sha', repo: 'o/failedtop', sha: SHA_SKIPPED, allowSkipped: true }, 'PASS', 0, /Production is at aaaaaaaa; the 1 newer/);
    await single('a failed deploy with a skipped status in another context fails', { type: 'deployed-sha', repo: 'o/mixed', sha: SHA_WRONG }, 'FAIL', 1, /Production is at aaaaaaaa, expected cccccccc/);
    await single('a failed deploy mentioning the skip text fails', { type: 'deployed-sha', repo: 'o/mixed', sha: SHA_OLD }, 'FAIL', 1, /Production is at aaaaaaaa, expected bbbbbbbb/);
    {
        const bad = await run({ checks: [{ id: 'X1', type: 'plugin-version', pluginRoot: root, minVersion: 'v9.0.0' }] });
        check('a malformed minVersion is refused', bad.status === 2 && /minVersion must be N\.N\.N/.test(bad.stderr), bad.stderr);
    }
    {
        // The samples answer after 3000ms. The check's timeoutMs, not the run's, must bound each sampled fetch.
        const viaHttp = await run({ timeoutMs: 10000, checks: [{ id: 'X1', type: 'sitemap', url: u('/sitemap-slower'), timeoutMs: 300 }] });
        check('a sitemap read via http gives up on a sample at the check timeoutMs, not the run one', statusOf(viaHttp, 'X1') === 'INDETERMINATE' && viaHttp.status === 2 && /5 of 5 sampled could not be read/.test(lineOf(viaHttp, 'X1')) && viaHttp.ms < 3000, `exit=${viaHttp.status} ${lineOf(viaHttp, 'X1')} ${viaHttp.ms}ms`);
        const viaBrowser = await run({ timeoutMs: 300, checks: [{ id: 'X1', type: 'sitemap', via: 'browser', url: u('/sitemap-slower'), timeoutMs: 10000, settleMs: 100 }] });
        check('a sitemap read via browser waits for a sample up to the check timeoutMs, not the run one', statusOf(viaBrowser, 'X1') === 'PASS' && viaBrowser.status === 0 && viaBrowser.ms >= 3000, `exit=${viaBrowser.status} ${lineOf(viaBrowser, 'X1')} ${viaBrowser.ms}ms`);
    }
    await single('browser sitemap treats challenge pages as unreadable', { type: 'sitemap', via: 'browser', url: u('/sitemap-checkpoints'), settleMs: 100 }, 'INDETERMINATE', 2, /5 of 5 sampled could not be read/);
    await single('browser sitemap treats mitigated 429s as unreadable', { type: 'sitemap', via: 'browser', url: u('/sitemap-challenged'), settleMs: 100 }, 'INDETERMINATE', 2, /5 of 5 sampled could not be read/);
    await single('browser sitemap exact status passes on real 200s', { type: 'sitemap', via: 'browser', url: u('/sitemap'), sampleStatus: 200, settleMs: 100 }, 'PASS', 0, /5 of 5 sampled answered 200/);
    await single('browser sitemap exact status fails on a followed redirect', { type: 'sitemap', via: 'browser', url: u('/sitemap-redirect'), sampleStatus: 200, settleMs: 100 }, 'FAIL', 1, /5 of 5 sampled answered redirected/);
    await single('browser sitemap cannot grade an exact 3xx', { type: 'sitemap', via: 'browser', url: u('/sitemap-redirect'), sampleStatus: 307, settleMs: 100 }, 'INDETERMINATE', 2, /5 of 5 sampled could not be read/);
    await single('browser sitemap redirects fail by default', { type: 'sitemap', via: 'browser', url: u('/sitemap-redirect'), settleMs: 100 }, 'FAIL', 1, /5 of 5 sampled answered redirected/);
    await single('browser sitemap redirects pass with allowRedirects', { type: 'sitemap', via: 'browser', url: u('/sitemap-redirect'), allowRedirects: true, settleMs: 100 }, 'PASS', 0, /under 400 \(redirects allowed\)/);
    await single('a relative sitemap location fails in the browser', { type: 'sitemap', via: 'browser', url: u('/sitemap-relative'), settleMs: 100 }, 'FAIL', 1, /5 of 5 locations are not absolute http\(s\) URLs, first \/ok$/);
    await single('browser sitemap names the cf-mitigated header it read', { type: 'sitemap', via: 'browser', url: u('/sitemap-cf'), settleMs: 100 }, 'INDETERMINATE', 2, /bot mitigation \(cf-mitigated: challenge, HTTP 403\)/);
    {
        const file = path.join(root, 'sample-attempts.json');
        for (const [name, via] of [['http', {}], ['browser', { via: 'browser', settleMs: 100 }]]) {
            const r = await run({ checks: [{ id: 'X1', type: 'sitemap', url: u('/sitemap-challenged'), ...via }] }, { args: ['--out', file] });
            const body = fs.readFileSync(file, 'utf8');
            check(`a challenged sitemap sample is not retried (${name})`, r.status === 2 && JSON.parse(body).results[0].attempts === 1, body);
        }
        const slow = await run({ checks: [{ id: 'X1', type: 'browser', url: u('/checkpoint-200'), widths: [390], ...browserFast }] }, { args: ['--deadline-ms', '2000'] });
        check('a challenge page stops waiting at the run deadline', slow.status === 2 && slow.ms < 8000, `${slow.status} ${slow.ms}ms`);
    }
    {
        const r = await run({ checks: [{ id: 'X1', type: 'browser', url: 'http://127.0.0.1:1/x?token=SECRETVALUE123', widths: [390], ...browserFast }] });
        check('a driver error does not leak the query string', statusOf(r, 'X1') === 'INDETERMINATE' && !/SECRETVALUE123/.test(r.stdout) && /127\.0\.0\.1:1\/x/.test(r.stdout), r.stdout);
    }
    await single('a version endpoint answering a stub is not a sha', { type: 'deployed-sha', url: u('/version-short'), pattern: '"sha":"([0-9a-f]+)"', sha: SHA_GOOD }, 'FAIL', 1, /not a commit sha/);
    await single('forbidden text is found past 200000 characters', { type: 'browser', url: u('/long-forbidden'), widths: [390], forbiddenText: ['ZZMARKER'], maxOverflowPx: 100000, ...browserFast }, 'FAIL', 1, /forbidden text/);
    {
        const r = await run({ checks: [{ id: 'X1', type: 'http', url: u('/ok') }] }, { args: ['--out', path.join(root, 'no-such-dir', 'r.json')] });
        check('a failed receipt write prints no verdict line', r.status === 2 && !/POPULATION/.test(r.stdout) && lineOf(r, 'X1') !== '', `${r.status} ${r.stdout}`);
        otherAuthSeen = 0;
        const cross = await run({ checks: [{ id: 'X1', type: 'sitemap', url: u('/sitemap-other'), headers: { authorization: 'Bearer TOK' } }] });
        check('check headers do not reach another origin', cross.status === 0 && otherAuthSeen === 0, `${otherAuthSeen} leaks ${cross.stdout}`);
        const same = await run({ checks: [{ id: 'X1', type: 'sitemap', url: u('/sitemap-same'), headers: { authorization: 'Bearer TOK' } }] });
        check('check headers still reach the same origin', same.status === 0, same.stdout);
        const marker = path.join(root, 'cwd-ran.txt');
        const cwd = path.join(root, 'hostile-cwd');
        fs.mkdirSync(cwd);
        fs.writeFileSync(path.join(cwd, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
        const file = path.join(root, 'hostile.json');
        fs.writeFileSync(file, JSON.stringify({ checks: [{ id: 'X1', type: 'browser', url: u('/ok'), widths: [390] }] }));
        const hostile = await new Promise((resolve) => {
            const child = spawn(process.execPath, [SUBJECT, 'run', '--config', file, '--playwright', NO_DRIVER], { cwd, windowsHide: true });
            child.on('close', (status) => resolve({ status }));
        });
        check('the working directory entry point is never executed', hostile.status === 2 && !fs.existsSync(marker), String(fs.existsSync(marker)));
    }
    if (!REAL_PLAYWRIGHT) {
        const fake = (extra) => ({ type: 'browser', url: u('/ok'), widths: [390], ...browserFast, ...extra });
        const events = () => fs.readFileSync(LAUNCH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        fs.rmSync(LAUNCH_LOG, { force: true });
        const noConnect = await run({ checks: [{ id: 'X1', ...fake() }] }, { env: { FAKE_DRIVER_NO_CONNECT: '1' } });
        const connectEvents = events();
        check('a failed connect kills every launched server', noConnect.status === 2 && connectEvents.filter((e) => e.event === 'launch').length === 2 && connectEvents.filter((e) => e.event === 'kill').length === 2, JSON.stringify(connectEvents));
        fs.rmSync(LAUNCH_LOG, { force: true });
        const late = await run({ checks: [{ id: 'X1', ...fake() }] }, { args: ['--deadline-ms', '300'], env: { FAKE_DRIVER_SLOW_LAUNCH: '1500' } });
        check('a launch finishing after the deadline is killed', late.status === 2 && events().some((e) => e.event === 'kill'), JSON.stringify(events()));
        // Shutdown waits 5s for the launch. This one outlives that wait, so only the closing guard can kill it.
        fs.rmSync(LAUNCH_LOG, { force: true });
        const later = await run({ checks: [{ id: 'X1', ...fake() }] }, { args: ['--deadline-ms', '300'], env: { FAKE_DRIVER_SLOW_LAUNCH: '6500' } });
        check('a launch outliving the shutdown wait is still killed', later.status === 2 && events().some((e) => e.event === 'kill'), JSON.stringify(events()));
        const prompt = await run({ checks: [{ id: 'X1', ...fake() }] });
        check('a browser run exits without waiting on idle timers', prompt.status === 0 && prompt.ms < 4500, `${prompt.ms}ms`);
        const hung = await run({ checks: [{ id: 'X1', ...fake({ timeoutMs: 300 }) }] }, { args: ['--deadline-ms', '20000'], env: { FAKE_DRIVER_HANG_CONTEXT: '1' } });
        check('the probe timeout covers a hung newContext', hung.status === 2 && /timed out after 300ms/.test(lineOf(hung, 'X1')) && hung.ms < 8000, `${hung.ms}ms ${hung.stdout}`);
        fs.rmSync(LAUNCH_LOG, { force: true });
        await run({ checks: [{ id: 'X1', ...fake() }] }, { env: { PWDEBUG: '1' } });
        check('PWDEBUG never reaches the browser launch', events().every((e) => e.event !== 'launch' || (e.pwdebug === null && e.headless === true)), JSON.stringify(events()));
    }

    // Section K: the small pure pieces, with literals.
    check('cleanValue keeps a value on one line and strips the separator', lib.cleanValue('a\nb|c') === 'a b c', lib.cleanValue('a\nb|c'));
    check('cleanValue strips every control character and the Unicode line separators',
        lib.cleanValue('a\u0007b\u2028c\td\u001b[31mE\u2029f\u0085g\u007fh') === 'a b c d [31mE f g h', JSON.stringify(lib.cleanValue('a\u0007b\u2028c\td\u001b[31mE\u2029f\u0085g\u007fh')));
    check('safeUrl drops the query string', lib.safeUrl('https://x.test/a?token=secret') === 'https://x.test/a', lib.safeUrl('https://x.test/a?token=secret'));
    check('compareVersions orders numerically', lib.compareVersions('8.10.0', '8.9.0') > 0 && lib.compareVersions('8.9.0', '8.9.0') === 0);
    check('shaMatches accepts a prefix and rejects another sha', lib.shaMatches('abcdef12', 'abcdef1234') && !lib.shaMatches('abcdef12', 'bbcdef1234'));
    check('parseLocs reads the literal locations', lib.parseLocs('<loc>https://a</loc><loc> https://b </loc>').join(',') === 'https://a,https://b');
    check('exitCodeFor refuses an empty population', lib.exitCodeFor({ total: 0, PASS: 0, FAIL: 0, INDETERMINATE: 0 }) === 2);

    server.closeAllConnections();
    server.close();
    otherServer.closeAllConnections();
    otherServer.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (nativeCrashes) console.log(`native crashes re-run: ${nativeCrashes}`);
    console.log(`\n${pass} passed, ${fail} failed${REAL_PLAYWRIGHT ? ' (browser: real Chromium)' : ' (browser: fake driver)'}`);
    if (fail) { console.log(`failed: ${failures.join('; ')}`); process.exitCode = 1; }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
    server.closeAllConnections();
    server.close();
    otherServer.closeAllConnections();
    otherServer.close();
    fs.rmSync(root, { recursive: true, force: true });
});
