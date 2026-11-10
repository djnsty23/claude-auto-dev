#!/usr/bin/env node
/**
 * verify-shipped.js - answer "did it ship and does it work" at zero model tokens.
 *
 * A model session walking a checklist pays tokens for facts: an HTTP status, a
 * deploy state on a sha, a string on a page, a console error count, a refused
 * request. This script reads those facts directly and leaves only the failures
 * for a model to think about.
 *
 *   node verify-shipped.js run --config FILE [--repo OWNER/NAME --sha SHA] [--out receipt.json]
 *                              [--deadline-ms N] [--playwright DIR]
 *   node verify-shipped.js --help
 *
 * OUTPUT. One line per check, in config order:
 *   CHECK <id>: PASS|FAIL|INDETERMINATE | <value>
 * then one POPULATION line. Page text and response bodies are never printed.
 *
 * EXIT. 0 only when every check passed and at least one ran. 1 on any FAIL.
 * 2 when nothing failed but something is INDETERMINATE, and on a refused config
 * or command line. A FAIL outranks an INDETERMINATE because it is an answer.
 *
 * INDETERMINATE means the question was not answered: a bot challenge, a 429, a
 * timeout, a browser that would not start, a gh call that could not be made, or
 * a status that is still pending. It is never scored as a pass. The mitigation
 * header is read BEFORE the status, because a challenge served as 403 would
 * otherwise read as a correctly refused request.
 *
 * A BOT CHALLENGE IS RECORDED, NEVER DEFEATED. The browser is plain headless
 * Chromium: no stealth plugin, no changed user agent, no patched navigator. It
 * waits a bounded time for a page to finish loading on its own.
 *
 * --repo with --sha narrows the population to checks carrying that repo and
 * grades them against that sha. A narrowing that selects nothing is refused.
 * Without them, a check expects the head of its repo's default branch.
 *
 * CONFIG is JSON and lives outside this public repo, normally at
 * ~/.claude/autodev/shipped-checks.json:
 *   { "expectCount": 2, "deadlineMs": 600000, "timeoutMs": 20000, "playwright": "<dir>",
 *     "checks": [ { "id": "A1", "type": "http", "url": "https://..." } ] }
 * expectCount, when present, must equal the number of checks, so a check that
 * was deleted by accident is a refusal and not a smaller green run.
 *
 * Check types and their fields (repo is optional on all but those marked *):
 *   commit-status   repo*, context="Vercel", sha
 *   deployed-sha    repo* with environment="Production", or url with pattern (capture group 1 is the sha); sha
 *   http            url, method, headers, body, expectStatus=200, bodyPattern, bodyAbsent
 *   refused         url, method, headers, body, statuses=[401,403], redirect (a regex on Location)
 *   sitemap         url, minLocs=5, sample=5, sampleStatus (exact, default any under 400),
 *                   via="http"|"browser", origin (page loaded first when via browser)
 *   browser         url, widths=[390,414], requiredText[], forbiddenText[], forbiddenSelector,
 *                   finalUrlPattern, minTextLen=500, minH1=1, maxOverflowPx=0, maxConsoleErrors=0, ignoreConsole[], settleMs=3000
 *   plugin-version  pluginRoot, minVersion, versionRepo, versionPath="VERSION", requiredFiles[]
 *   release-tag     repo*, versionPath="VERSION"
 *   pr-merged       repo*, number or head
 *
 * LIMITS. Headless only, and no config field can change that. At most two
 * attempts per check, and a challenge is not retried. Every network call has
 * its own timeout and the whole run has a deadline.
 *
 * ENV. VERIFY_SHIPPED_GH replaces the gh executable (a .js path runs with node).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PASS = 'PASS';
const FAIL = 'FAIL';
const INDET = 'INDETERMINATE';
const MAX_ATTEMPTS = 2;
const DEFAULT_DEADLINE_MS = 600000;
const DEFAULT_TIMEOUT_MS = 20000;
const BROWSER_TIMEOUT_MS = 45000;
const CHALLENGE_WAIT_MS = 12000;
const MAX_SKIPPED_WALK = 10;
const HTTP_POOL = 6;
const BROWSER_POOL = 2;
const USER_AGENT = 'autodev-verify-shipped';
const ID_RE = /^[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const IGNORED_BUILD_RE = /ignored build step/i;
const CHALLENGE_TITLE_RE = /^\s*(vercel security checkpoint|just a moment\b|attention required)/i;
const BROWSER_TYPES = new Set(['browser']);

const TYPES = {
    'commit-status': { required: ['repo'] },
    'deployed-sha': { required: [] },
    http: { required: ['url'] },
    refused: { required: ['url'] },
    sitemap: { required: ['url'] },
    browser: { required: ['url'] },
    'plugin-version': { required: [] },
    'release-tag': { required: ['repo'] },
    'pr-merged': { required: ['repo'] },
};

class Refusal extends Error {}

const result = (status, value, extra) => ({ status, value, ...extra });
const pass = (value) => result(PASS, value);
const failed = (value) => result(FAIL, value);
const indeterminate = (value, extra) => result(INDET, value, extra);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortSha = (sha) => String(sha || '').slice(0, 8);
const shaMatches = (a, b) => Boolean(a && b) && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

/** Races a promise against a limit and clears the timer, so a settled race keeps nothing alive. */
function timed(promise, ms) {
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** A driver's error can quote the URL it failed on: first line only, URLs reduced to origin and path. */
function scrubError(message) {
    // eslint-disable-next-line no-control-regex
    const plain = String(message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0];
    return cleanValue(plain.replace(/https?:\/\/[^\s"'<>]+/g, (url) => safeUrl(url))).slice(0, 160);
}

/** A printed value stays on one line and cannot forge the line's own separator. */
function cleanValue(value) {
    return String(value == null ? '' : value).replace(/[\r\n|]+/g, ' ').trim().slice(0, 400);
}

/** Origin and path only: a query string can carry a token. */
function safeUrl(raw) {
    try { const u = new URL(raw); return `${u.origin}${u.pathname}`; } catch { return '(unparsable url)'; }
}

function expandHome(p) {
    return typeof p === 'string' && (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p;
}

function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

function compileRegex(check, field, source) {
    try { return new RegExp(source, 'i'); } catch (e) { throw new Refusal(`check ${check.id}: ${field} is not a valid regex: ${e.message}`); }
}

/** Refuses a config that could only produce an empty or meaningless run. Nothing runs when this throws. */
function validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Refusal('config must be a JSON object');
    if (!Array.isArray(config.checks)) throw new Refusal('config has no checks array');
    if (config.checks.length === 0) throw new Refusal('empty config: 0 checks, so nothing would be verified');
    if (config.expectCount !== undefined && config.expectCount !== config.checks.length) {
        throw new Refusal(`config declares expectCount ${config.expectCount} but holds ${config.checks.length} checks`);
    }
    const seen = new Set();
    for (const check of config.checks) {
        if (!check || typeof check !== 'object') throw new Refusal('every check must be an object');
        if (typeof check.id !== 'string' || !ID_RE.test(check.id)) throw new Refusal(`invalid check id: ${JSON.stringify(check.id)}`);
        if (seen.has(check.id)) throw new Refusal(`duplicate check id: ${check.id}`);
        seen.add(check.id);
        const spec = TYPES[check.type];
        if (!spec) throw new Refusal(`check ${check.id}: unknown type ${JSON.stringify(check.type)}`);
        for (const field of spec.required) if (!check[field]) throw new Refusal(`check ${check.id}: ${check.type} needs ${field}`);
        if (check.repo !== undefined && !REPO_RE.test(check.repo)) throw new Refusal(`check ${check.id}: repo must be OWNER/NAME`);
        validateTypeFields(check);
    }
}

function validateTypeFields(check) {
    if (check.type === 'deployed-sha') {
        if (!check.repo && !(check.url && check.pattern)) throw new Refusal(`check ${check.id}: deployed-sha needs repo, or url with pattern`);
        if (check.url && !check.sha && !check.repo) throw new Refusal(`check ${check.id}: deployed-sha by url needs sha or repo to say what is expected`);
        if (check.pattern) compileRegex(check, 'pattern', check.pattern);
    }
    if (check.type === 'pr-merged' && !check.number && !check.head) throw new Refusal(`check ${check.id}: pr-merged needs number or head`);
    if (check.type === 'plugin-version' && !check.minVersion && !check.versionRepo) throw new Refusal(`check ${check.id}: plugin-version needs minVersion or versionRepo`);
    if (check.minVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(check.minVersion)) throw new Refusal(`check ${check.id}: minVersion must be N.N.N`);
    if (check.sha !== undefined && !SHA_RE.test(check.sha)) throw new Refusal(`check ${check.id}: sha is not a commit sha`);
    for (const field of ['bodyPattern', 'bodyAbsent', 'redirect', 'finalUrlPattern']) if (check[field]) compileRegex(check, field, check[field]);
    for (const field of ['requiredText', 'forbiddenText', 'ignoreConsole']) {
        if (check[field] === undefined) continue;
        if (!Array.isArray(check[field])) throw new Refusal(`check ${check.id}: ${field} must be an array`);
        check[field].forEach((source) => compileRegex(check, field, source));
    }
    if (check.type === 'browser' && check.widths !== undefined && (!Array.isArray(check.widths) || !check.widths.length)) {
        throw new Refusal(`check ${check.id}: widths must be a non-empty array`);
    }
}

/** A deadline plus a per-probe timeout, as one signal. dispose() must run when the probe ends. */
function probeSignal(run, ms) {
    const controller = new AbortController();
    const remaining = Math.max(1, Math.min(ms, run.deadlineAt - Date.now()));
    const timer = setTimeout(() => controller.abort(new Error('timeout')), remaining);
    const onDeadline = () => controller.abort(new Error('run deadline'));
    run.deadline.signal.addEventListener('abort', onDeadline, { once: true });
    return {
        signal: controller.signal,
        remaining,
        dispose() { clearTimeout(timer); run.deadline.signal.removeEventListener('abort', onDeadline); },
    };
}

function ghCall(run, args, timeoutMs) {
    const override = process.env.VERIFY_SHIPPED_GH;
    const command = override && /\.(c|m)?js$/i.test(override) ? process.execPath : override || 'gh';
    const argv = override && command === process.execPath ? [override, ...args] : args;
    const probe = probeSignal(run, timeoutMs || run.timeoutMs);
    return new Promise((resolve) => {
        execFile(command, argv, { signal: probe.signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
            probe.dispose();
            const text = String(stderr || '');
            if (!error) { resolve({ ok: true, stdout: String(stdout) }); return; }
            if (probe.signal.aborted) { resolve({ ok: false, unavailable: 'gh call timed out' }); return; }
            if (error.code === 'ENOENT') { resolve({ ok: false, unavailable: 'gh is not installed' }); return; }
            if (/HTTP 404/.test(text)) { resolve({ ok: false, notFound: true }); return; }
            const http = /HTTP (\d{3})/.exec(text);
            resolve({ ok: false, unavailable: `gh api failed${http ? ` (HTTP ${http[1]})` : ''}` });
        });
    });
}

async function ghJson(run, endpoint) {
    const res = await ghCall(run, ['api', endpoint]);
    if (!res.ok) return res;
    try { return { ok: true, data: JSON.parse(res.stdout) }; } catch { return { ok: false, unavailable: 'gh returned unparsable JSON' }; }
}

/** The sha a check grades: --sha for the narrowed repo, the check's own, else the default branch head. */
async function expectedSha(run, check) {
    if (run.sha && check.repo === run.repo) return { sha: run.sha };
    if (check.sha) return { sha: check.sha };
    if (!check.repo) return { error: 'no repo to resolve an expected sha from' };
    if (!run.heads.has(check.repo)) run.heads.set(check.repo, ghJson(run, `repos/${check.repo}/commits/HEAD`));
    const head = await run.heads.get(check.repo);
    if (!head.ok || !head.data || !head.data.sha) return { error: `could not read the head of ${check.repo}` };
    return { sha: head.data.sha };
}

/** One fetch with its own timeout. Network failure comes back as { error }, never a throw. */
async function httpProbe(run, check, url, timeoutMs) {
    const probe = probeSignal(run, timeoutMs || check.timeoutMs || run.timeoutMs);
    try {
        const headers = { 'user-agent': USER_AGENT, ...(check.headers || {}) };
        const res = await fetch(url, { method: check.method || 'GET', headers, body: check.body, redirect: 'manual', signal: probe.signal });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text };
    } catch (e) {
        return { error: probe.signal.aborted ? `timeout after ${probe.remaining}ms` : `network error: ${(e.cause && e.cause.code) || e.name}` };
    } finally {
        probe.dispose();
    }
}

/** Why a response says nothing about the app, or null when it does. Runs before any status comparison. */
function challengeReason(status, getHeader, text) {
    for (const name of ['x-vercel-mitigated', 'cf-mitigated']) {
        const value = getHeader(name);
        if (value) return `bot mitigation (${name}: ${value}, HTTP ${status})`;
    }
    if (status === 429) return 'rate limited (HTTP 429)';
    const title = /<title[^>]*>([^<]*)/i.exec(String(text || '').slice(0, 8192));
    if (title && CHALLENGE_TITLE_RE.test(title[1])) return `challenge page (HTTP ${status})`;
    return null;
}

function unanswered(res) {
    if (res.error) return indeterminate(res.error);
    const why = challengeReason(res.status, (name) => res.headers.get(name), res.text);
    return why ? indeterminate(why, { noRetry: true }) : null;
}

async function checkHttp(run, check) {
    const res = await httpProbe(run, check, check.url);
    const stop = unanswered(res);
    if (stop) return stop;
    const expected = check.expectStatus || 200;
    if (res.status !== expected) return failed(`HTTP ${res.status}, expected ${expected}`);
    if (check.bodyPattern && !new RegExp(check.bodyPattern, 'i').test(res.text)) return failed(`HTTP ${res.status} but body lacks /${check.bodyPattern}/`);
    if (check.bodyAbsent && new RegExp(check.bodyAbsent, 'i').test(res.text)) return failed(`HTTP ${res.status} but body holds /${check.bodyAbsent}/`);
    return pass(`HTTP ${res.status}${check.bodyPattern ? `, body matches /${check.bodyPattern}/` : ''}`);
}

async function checkRefused(run, check) {
    const res = await httpProbe(run, check, check.url);
    const stop = unanswered(res);
    if (stop) return stop;
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400) {
        if (!check.redirect) return failed(`HTTP ${res.status} redirect, but no redirect is named as a refusal`);
        if (location && new RegExp(check.redirect, 'i').test(location)) return pass(`refused: HTTP ${res.status} to the named redirect`);
        return failed(`HTTP ${res.status} to a redirect not matching /${check.redirect}/`);
    }
    const statuses = check.statuses || [401, 403];
    if (statuses.includes(res.status)) return pass(`refused: HTTP ${res.status}`);
    return failed(`not refused: HTTP ${res.status}, expected ${statuses.join(' or ')}${check.redirect ? ' or the named redirect' : ''}`);
}

function parseLocs(xml) {
    return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

function scoreSitemap(check, count, statuses) {
    const minLocs = check.minLocs === undefined ? 5 : check.minLocs;
    if (count < minLocs) return failed(`${count} locations, expected at least ${minLocs}`);
    const unknown = statuses.filter((s) => typeof s !== 'number');
    const bad = statuses.filter((s) => typeof s === 'number' && (check.sampleStatus ? s !== check.sampleStatus : s >= 400));
    if (bad.length) return failed(`${count} locations, ${bad.length} of ${statuses.length} sampled answered ${bad.join(',')}`);
    if (unknown.length || !statuses.length) return indeterminate(`${count} locations, ${unknown.length} of ${statuses.length} sampled could not be read`);
    return pass(`${count} locations, ${statuses.length} of ${statuses.length} sampled ${check.sampleStatus ? `answered ${check.sampleStatus}` : 'under 400'}`);
}

async function checkSitemapHttp(run, check) {
    const res = await httpProbe(run, check, check.url);
    const stop = unanswered(res);
    if (stop) return stop;
    if (res.status !== 200) return failed(`sitemap HTTP ${res.status}`);
    const locs = parseLocs(res.text);
    const sample = locs.slice(0, check.sample === undefined ? 5 : check.sample);
    const statuses = await Promise.all(sample.map(async (url) => {
        const sameOrigin = new URL(url).origin === new URL(check.url).origin;
        const r = await httpProbe(run, { headers: sameOrigin ? check.headers : undefined }, url);
        if (r.error || challengeReason(r.status, (n) => r.headers.get(n), r.text)) return 'unreadable';
        return r.status;
    }));
    return scoreSitemap(check, locs.length, statuses);
}

async function checkSitemapBrowser(run, check) {
    return withPage(run, check, 800, async ({ page, timeoutMs }) => {
        await page.goto(check.origin || new URL(check.url).origin, { waitUntil: 'load', timeout: timeoutMs });
        const state = await settle(page, check.settleMs === undefined ? 1000 : check.settleMs);
        if (state.challenged) return indeterminate('challenge page in the browser', { noRetry: true });
        const data = await page.evaluate(async ({ url, sample, perFetchMs }) => {
            const read = async (u) => {
                const r = await fetch(u, { signal: AbortSignal.timeout(perFetchMs) });
                const text = await r.text();
                return { status: r.status, mitigated: r.headers.get('x-vercel-mitigated') || r.headers.get('cf-mitigated'), text };
            };
            const map = await read(url);
            const locs = [...map.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
            const samples = await Promise.all(locs.slice(0, sample).map((u) => read(u).then((r) => ({ status: r.status, mitigated: r.mitigated, head: r.text.slice(0, 8192) }), () => null)));
            return { status: map.status, mitigated: map.mitigated, head: map.text.slice(0, 8192), count: locs.length, samples };
        }, { url: check.url, sample: check.sample === undefined ? 5 : check.sample, perFetchMs: run.timeoutMs });
        const reasonFor = (r) => challengeReason(r.status, (name) => (name === 'x-vercel-mitigated' ? r.mitigated : null), r.head);
        const blocked = reasonFor(data);
        if (blocked) return indeterminate(blocked, { noRetry: true });
        if (data.status !== 200) return failed(`sitemap HTTP ${data.status} in the browser`);
        return scoreSitemap(check, data.count, data.samples.map((s) => (!s || reasonFor(s) ? 'unreadable' : s.status)));
    });
}

function checkSitemap(run, check) {
    return check.via === 'browser' ? checkSitemapBrowser(run, check) : checkSitemapHttp(run, check);
}

async function checkCommitStatus(run, check) {
    const expected = await expectedSha(run, check);
    if (expected.error) return indeterminate(expected.error);
    const context = String(check.context || 'Vercel').toLowerCase();
    const combined = await ghJson(run, `repos/${check.repo}/commits/${expected.sha}/status`);
    if (!combined.ok) return combined.notFound ? failed(`commit ${shortSha(expected.sha)} not found in ${check.repo}`) : indeterminate(combined.unavailable);
    const statuses = (combined.data.statuses || []).filter((s) => String(s.context).toLowerCase().includes(context));
    if (!statuses.length) return indeterminate(`no status matching "${check.context || 'Vercel'}" on ${shortSha(expected.sha)}`);
    const states = statuses.map((s) => s.state);
    const label = `${shortSha(expected.sha)} ${statuses.map((s) => `${s.context}=${s.state}`).join(', ')}`;
    if (states.some((s) => s === 'failure' || s === 'error')) return failed(label);
    if (states.some((s) => s !== 'success')) return indeterminate(`${label} (still pending)`);
    const skipped = statuses.some((s) => IGNORED_BUILD_RE.test(s.description || ''));
    return pass(`${label}${skipped ? ' (build skipped by the project, nothing deployed)' : ''}`);
}

async function deploymentState(run, repo, id) {
    const statuses = await ghJson(run, `repos/${repo}/deployments/${id}/statuses?per_page=1`);
    if (!statuses.ok) return { error: statuses.unavailable || 'deployment has no readable status' };
    const latest = Array.isArray(statuses.data) ? statuses.data[0] : null;
    return latest ? { state: latest.state } : { error: 'deployment has no status yet' };
}

/** True when every commit between production and the expected sha skipped its build on purpose. */
async function allSkippedSince(run, check, productionSha, expected) {
    const repo = check.repo;
    const context = String(check.context || 'Vercel').toLowerCase();
    const compare = await ghJson(run, `repos/${repo}/compare/${productionSha}...${expected}`);
    if (!compare.ok) return { error: compare.unavailable || 'could not compare production with the expected sha' };
    if (compare.data.status !== 'ahead') return { skipped: false };
    const commits = compare.data.commits || [];
    if (!commits.length || commits.length > MAX_SKIPPED_WALK) return { skipped: false };
    for (const commit of commits) {
        const combined = await ghJson(run, `repos/${repo}/commits/${commit.sha}/status`);
        if (!combined.ok) return { error: combined.unavailable || 'could not read a commit status' };
        const statuses = (combined.data.statuses || []).filter((s) => String(s.context).toLowerCase().includes(context));
        if (!statuses.length || !statuses.every((s) => s.state === 'success' && IGNORED_BUILD_RE.test(s.description || ''))) return { skipped: false };
    }
    return { skipped: true, count: commits.length };
}

/** The newest deployment that actually went live. A failed or building one never held production. */
async function newestLive(run, repo, environment, deployments) {
    for (const deployment of deployments.slice(0, MAX_SKIPPED_WALK)) {
        const state = await deploymentState(run, repo, deployment.id);
        if (state.error) return { error: state.error };
        if (state.state === 'success') return { deployment };
    }
    return { error: `no successful "${environment}" deployment among the newest ${MAX_SKIPPED_WALK}` };
}

async function checkDeployedShaUrl(run, check, expected) {
    const res = await httpProbe(run, check, check.url);
    const stop = unanswered(res);
    if (stop) return stop;
    if (res.status !== 200) return failed(`version endpoint HTTP ${res.status}`);
    const match = new RegExp(check.pattern, 'i').exec(res.text);
    if (!match || !match[1]) return failed(`no sha matching /${check.pattern}/ in the response`);
    if (!SHA_RE.test(match[1])) return failed('the version endpoint answered something that is not a commit sha');
    return shaMatches(match[1], expected) ? pass(`deployed ${shortSha(match[1])} matches`) : failed(`deployed ${shortSha(match[1])}, expected ${shortSha(expected)}`);
}

async function checkDeployedSha(run, check) {
    const expected = await expectedSha(run, check);
    if (expected.error) return indeterminate(expected.error);
    if (check.url) return checkDeployedShaUrl(run, check, expected.sha);
    const environment = check.environment || 'Production';
    const list = await ghJson(run, `repos/${check.repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=30`);
    if (!list.ok) return indeterminate(list.unavailable || `no deployments readable for ${check.repo}`);
    if (!Array.isArray(list.data) || !list.data.length) return indeterminate(`no "${environment}" deployments recorded for ${check.repo}`);
    const match = list.data.find((d) => shaMatches(d.sha, expected.sha));
    if (match) return scoreDeployment(run, check, environment, match, expected.sha);
    const live = await newestLive(run, check.repo, environment, list.data);
    if (live.error) return indeterminate(live.error);
    const liveSha = live.deployment.sha;
    const walk = await allSkippedSince(run, check, liveSha, expected.sha);
    if (walk.error) return indeterminate(walk.error);
    if (walk.skipped) return pass(`${environment} is at ${shortSha(liveSha)}; the ${walk.count} newer commit(s) up to ${shortSha(expected.sha)} skipped their build`);
    return failed(`${environment} is at ${shortSha(liveSha)}, expected ${shortSha(expected.sha)}`);
}

async function scoreDeployment(run, check, environment, deployment, expected) {
    const state = await deploymentState(run, check.repo, deployment.id);
    if (state.error) return indeterminate(state.error);
    const label = `${environment} ${shortSha(expected)} ${state.state}`;
    if (state.state === 'success') return pass(label);
    if (['pending', 'queued', 'in_progress'].includes(state.state)) return indeterminate(`${label} (still deploying)`);
    return failed(label);
}

function installedVersions(root) {
    return fs.readdirSync(root).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort(compareVersions);
}

async function readRepoVersion(run, repo, versionPath) {
    const file = await ghJson(run, `repos/${repo}/contents/${versionPath || 'VERSION'}`);
    if (!file.ok || !file.data || !file.data.content) return { error: file.unavailable || `could not read the version file of ${repo}` };
    const version = Buffer.from(file.data.content, 'base64').toString('utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? { version } : { error: `version file of ${repo} holds no version` };
}

async function checkPluginVersion(run, check) {
    const root = expandHome(check.pluginRoot || '~/.claude/plugins/cache/autodev/autodev-core');
    if (!fs.existsSync(root)) return indeterminate('plugin root not found on this machine');
    const installed = installedVersions(root);
    let target = installed[installed.length - 1];
    if (check.versionRepo) {
        const remote = await readRepoVersion(run, check.versionRepo, check.versionPath);
        if (remote.error) return indeterminate(remote.error);
        target = remote.version;
        if (!installed.includes(target)) return failed(`${target} is released but not installed (newest installed ${installed[installed.length - 1] || 'none'})`);
    }
    if (!target) return failed('no plugin version is installed');
    if (check.minVersion && compareVersions(target, check.minVersion) < 0) return failed(`${target} is below the required ${check.minVersion}`);
    const missing = (check.requiredFiles || []).filter((file) => !fs.existsSync(path.join(root, target, file)));
    if (missing.length) return failed(`${target} installed but missing ${missing.join(', ')}`);
    return pass(`${target} installed, ${(check.requiredFiles || []).length} required file(s) present`);
}

async function checkReleaseTag(run, check) {
    const remote = await readRepoVersion(run, check.repo, check.versionPath);
    if (remote.error) return indeterminate(remote.error);
    const tag = await ghJson(run, `repos/${check.repo}/git/ref/tags/v${remote.version}`);
    if (tag.ok) return pass(`tag v${remote.version} exists`);
    return tag.notFound ? failed(`tag v${remote.version} is absent`) : indeterminate(tag.unavailable);
}

async function checkPrMerged(run, check) {
    if (check.number) {
        const pr = await ghJson(run, `repos/${check.repo}/pulls/${check.number}`);
        if (!pr.ok) return pr.notFound ? failed(`PR ${check.number} not found`) : indeterminate(pr.unavailable);
        return pr.data.merged ? pass(`PR ${check.number} merged`) : failed(`PR ${check.number} state ${pr.data.state}, not merged`);
    }
    const owner = check.repo.split('/')[0];
    const list = await ghJson(run, `repos/${check.repo}/pulls?state=closed&per_page=30&head=${encodeURIComponent(`${owner}:${check.head}`)}`);
    if (!list.ok) return indeterminate(list.unavailable || 'could not list pull requests');
    const merged = list.data.filter((pr) => pr.merged_at);
    return merged.length ? pass(`${merged.length} merged PR(s) from ${check.head}`) : failed(`0 merged PRs from ${check.head}`);
}

function loadBrowserDriver(run) {
    const usable = (driver) => (driver && driver.chromium ? driver : null);
    for (const root of [run.playwright, process.cwd()].filter(Boolean)) {
        for (const name of ['playwright', 'playwright-core']) {
            try { return usable(require(require.resolve(name, { paths: [root] }))); } catch { /* try the next location */ }
        }
    }
    // A bare path is loaded only when it was named explicitly: requiring the cwd would run its entry point.
    if (run.playwright) {
        try { return usable(require(path.resolve(run.playwright))); } catch { /* reported as no driver */ }
    }
    return null;
}

async function killBrowserServer(run) {
    const server = run.browserServer;
    run.browserServer = null;
    if (server) await timed(Promise.resolve().then(() => server.kill()).catch(() => {}), 5000);
}

/** The shared headless browser, started once. Rejected starts are forgotten so the second attempt can retry. */
function browserFor(run) {
    if (run.browser) return run.browser;
    run.browser = (async () => {
        await killBrowserServer(run);
        const driver = loadBrowserDriver(run);
        if (!driver) throw new Error('no playwright resolves; set "playwright" in the config or pass --playwright');
        // Playwright's inspector mode turns headless off, so it must not reach this launch.
        delete process.env.PWDEBUG;
        const timeout = Math.min(BROWSER_TIMEOUT_MS, Math.max(1000, run.deadlineAt - Date.now()));
        run.browserServer = await driver.chromium.launchServer({ headless: true, timeout });
        if (run.closing) throw new Error('run ended during browser start');
        return driver.chromium.connect(run.browserServer.wsEndpoint(), { timeout });
    })().catch(async (error) => {
        run.browser = null;
        await killBrowserServer(run);
        throw error;
    });
    return run.browser;
}

/** Waits for the page's own load to settle and reports whether it is still a challenge page. */
async function settle(page, settleMs) {
    await sleep(settleMs);
    const until = Date.now() + CHALLENGE_WAIT_MS;
    for (;;) {
        const state = await page.evaluate(() => ({ title: document.title, text: (document.body && document.body.innerText) || '' })).catch(() => null);
        const challenged = !state || CHALLENGE_TITLE_RE.test(state.title) || (state.text.length < 800 && /security checkpoint/i.test(state.text));
        if (!challenged) return { challenged: false };
        if (Date.now() >= until) return { challenged: true };
        await sleep(1000);
    }
}

/** Runs body against a fresh page in a fresh context, so no cookie survives between probes. */
async function withPage(run, check, height, body, width) {
    let browser;
    try { browser = await browserFor(run); } catch (e) { return indeterminate(`browser would not start: ${scrubError(e.message)}`); }
    let context;
    const probe = probeSignal(run, check.timeoutMs || BROWSER_TIMEOUT_MS);
    try {
        const aborted = new Promise((resolve) => probe.signal.addEventListener('abort', () => resolve(indeterminate(`browser probe timed out after ${probe.remaining}ms`)), { once: true }));
        const work = (async () => {
            context = await browser.newContext({ viewport: { width: width || 1280, height } });
            const page = await context.newPage();
            return body({ page, timeoutMs: probe.remaining });
        })();
        return await Promise.race([work, aborted]);
    } catch (e) {
        return indeterminate(`browser probe failed: ${scrubError(e.message)}`);
    } finally {
        probe.dispose();
        if (context) await timed(context.close().catch(() => {}), 5000);
    }
}

function browserFindings(check, metrics, errors) {
    const findings = [];
    if (metrics.textLen < (check.minTextLen === undefined ? 500 : check.minTextLen)) findings.push(`text ${metrics.textLen} chars`);
    if (metrics.h1 < (check.minH1 === undefined ? 1 : check.minH1)) findings.push(`${metrics.h1} h1`);
    if (metrics.overflowPx > (check.maxOverflowPx === undefined ? 0 : check.maxOverflowPx)) findings.push(`overflow ${metrics.overflowPx}px`);
    if (errors > (check.maxConsoleErrors || 0)) findings.push(`${errors} console error(s)`);
    for (const source of check.requiredText || []) if (!new RegExp(source, 'i').test(metrics.text)) findings.push(`missing required text /${source}/`);
    for (const source of check.forbiddenText || []) if (new RegExp(source, 'i').test(metrics.text)) findings.push(`forbidden text /${source}/ visible`);
    if (check.forbiddenSelector && metrics.forbidden > 0) findings.push(`${metrics.forbidden} element(s) match ${check.forbiddenSelector}`);
    if (check.finalUrlPattern && !new RegExp(check.finalUrlPattern, 'i').test(metrics.url)) findings.push(`ended at ${safeUrl(metrics.url)}`);
    return findings;
}

/** One width of one browser check. Console errors count only on the final document. */
async function browserWidth(run, check, width) {
    return withPage(run, check, 844, async ({ page, timeoutMs }) => {
        const ignore = (check.ignoreConsole || []).map((source) => new RegExp(source, 'i'));
        let errors = 0;
        let ignored = 0;
        let navigation = null;
        const countError = (text) => { if (ignore.some((re) => re.test(text))) ignored++; else errors++; };
        page.on('console', (message) => { if (message.type() === 'error') countError(message.text()); });
        page.on('pageerror', (error) => countError(String(error)));
        page.on('response', (response) => {
            if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) { navigation = response; errors = 0; ignored = 0; }
        });
        await page.goto(check.url, { waitUntil: 'load', timeout: timeoutMs });
        const state = await settle(page, check.settleMs === undefined ? 3000 : check.settleMs);
        if (state.challenged) return indeterminate(`width ${width}: challenge page in the browser`, { noRetry: true });
        const status = navigation ? navigation.status() : null;
        if (navigation) {
            const why = challengeReason(status, (name) => navigation.headers()[name], '');
            if (why) return indeterminate(`width ${width}: ${why}`, { noRetry: true });
        }
        if (status !== null && status >= 400) return failed(`width ${width}: HTTP ${status}`);
        const metrics = await page.evaluate((selector) => ({
            url: location.href,
            text: document.body.innerText,
            textLen: document.body.innerText.length,
            h1: document.querySelectorAll('h1').length,
            overflowPx: document.documentElement.scrollWidth - window.innerWidth,
            forbidden: selector ? document.querySelectorAll(selector).length : 0,
        }), check.forbiddenSelector || null);
        const findings = browserFindings(check, metrics, errors);
        if (findings.length) return failed(`width ${width}: ${findings.join(', ')}`);
        return pass(`w${width} ${status === null ? 'status unknown' : `HTTP ${status}`}, ${metrics.textLen} chars, ${metrics.h1} h1, overflow ${metrics.overflowPx}px, ${errors} console error(s)${ignored ? `, ${ignored} ignored by config` : ''}, at ${safeUrl(metrics.url)}`);
    }, width);
}

async function checkBrowser(run, check) {
    const widths = check.widths || [390, 414];
    const results = [];
    for (const width of widths) results.push(await browserWidth(run, check, width));
    const failure = results.find((r) => r.status === FAIL);
    if (failure) return failure;
    const open = results.find((r) => r.status === INDET);
    if (open) return open;
    return pass(`${widths.length} of ${widths.length} widths: ${results.map((r) => r.value).join('; ')}`);
}

const HANDLERS = {
    'commit-status': checkCommitStatus,
    'deployed-sha': checkDeployedSha,
    http: checkHttp,
    refused: checkRefused,
    sitemap: checkSitemap,
    browser: checkBrowser,
    'plugin-version': checkPluginVersion,
    'release-tag': checkReleaseTag,
    'pr-merged': checkPrMerged,
};

/** At most two attempts, and only an unanswered probe is retried. A deadline always wins the race. */
async function runCheck(run, check) {
    const startedAt = Date.now();
    let outcome = indeterminate('not started');
    let attempts = 0;
    const deadlineHit = new Promise((resolve) => {
        if (run.deadline.signal.aborted) resolve(true);
        else run.deadline.signal.addEventListener('abort', () => resolve(true), { once: true });
    });
    while (attempts < MAX_ATTEMPTS) {
        if (run.deadline.signal.aborted) { outcome = indeterminate('run deadline reached before this check finished'); break; }
        attempts++;
        const attempt = Promise.resolve().then(() => HANDLERS[check.type](run, check)).catch((e) => indeterminate(`probe error: ${scrubError(e.message)}`));
        outcome = await Promise.race([attempt, deadlineHit.then(() => indeterminate('run deadline reached before this check finished'))]);
        if (outcome.status !== INDET || outcome.noRetry) break;
        if (attempts < MAX_ATTEMPTS) await Promise.race([sleep(1000), deadlineHit]);
    }
    return { id: check.id, type: check.type, status: outcome.status, value: cleanValue(outcome.value), attempts, ms: Date.now() - startedAt };
}

/** Runs tasks with a fixed number of workers. */
async function pool(items, limit, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) { const item = items[next++]; await worker(item); }
    });
    await Promise.all(runners);
}

function needsBrowser(check) {
    return BROWSER_TYPES.has(check.type) || (check.type === 'sitemap' && check.via === 'browser');
}

async function shutdownBrowser(run) {
    run.closing = true;
    if (run.browser) {
        const browser = await timed(run.browser.catch(() => null), 5000);
        if (browser) await timed(browser.close().catch(() => {}), 5000);
    }
    await killBrowserServer(run);
}

function exitCodeFor(counts) {
    if (counts.total === 0) return 2;
    if (counts[FAIL] > 0) return 1;
    return counts[INDET] > 0 ? 2 : 0;
}

function writeReceipt(file, receipt) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}

function selectPopulation(config, options) {
    if (!options.repo) return config.checks;
    const selected = config.checks.filter((check) => check.repo === options.repo);
    if (!selected.length) throw new Refusal(`--repo ${options.repo} selects 0 of ${config.checks.length} checks, so nothing would be verified`);
    return selected;
}

function loadConfig(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Refusal(`cannot read config: ${e.code || e.message}`); }
    try { return JSON.parse(raw); } catch (e) { throw new Refusal(`config is not JSON: ${e.message}`); }
}

function parseArgs(argv) {
    const options = { command: null };
    const flags = { '--config': 'config', '--repo': 'repo', '--sha': 'sha', '--out': 'out', '--deadline-ms': 'deadlineMs', '--playwright': 'playwright' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { options.help = true; continue; }
        if (flags[arg]) {
            if (argv[i + 1] === undefined) throw new Refusal(`${arg} needs a value`);
            options[flags[arg]] = argv[++i];
            continue;
        }
        if (arg.startsWith('-') || options.command) throw new Refusal(`unknown argument: ${arg}`);
        options.command = arg;
    }
    return options;
}

function validateOptions(options) {
    if (options.command !== 'run') throw new Refusal('expected the run command; see --help');
    if (!options.config) throw new Refusal('--config FILE is required');
    if (Boolean(options.repo) !== Boolean(options.sha)) throw new Refusal('--repo and --sha go together');
    if (options.repo && !REPO_RE.test(options.repo)) throw new Refusal('--repo must be OWNER/NAME');
    if (options.sha && !SHA_RE.test(options.sha)) throw new Refusal('--sha is not a commit sha');
    if (options.deadlineMs !== undefined && !(Number(options.deadlineMs) > 0)) throw new Refusal('--deadline-ms must be a positive number');
}

const HELP = `usage: node verify-shipped.js run --config FILE [--repo OWNER/NAME --sha SHA] [--out receipt.json]
                                 [--deadline-ms N] [--playwright DIR]
       node verify-shipped.js --help

Reads shipped facts at zero model tokens and prints one line per check:
  CHECK <id>: PASS|FAIL|INDETERMINATE | <value>

--repo with --sha narrows the run to that repo's checks and grades them against that sha.
--out writes a JSON receipt with the sha, timestamps and the population of checks run.
Exit 0: every check passed and at least one ran. Exit 1: any FAIL.
Exit 2: anything INDETERMINATE, or a refused config or command line (an empty config is refused).
Check types: ${Object.keys(TYPES).join(', ')}. The config format is in this script's header.
`;

async function execute(options) {
    const config = loadConfig(options.config);
    validateConfig(config);
    const population = selectPopulation(config, options);
    const deadlineMs = Number(options.deadlineMs || config.deadlineMs || DEFAULT_DEADLINE_MS);
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(new Error('run deadline')), deadlineMs);
    const run = {
        deadline,
        deadlineAt: Date.now() + deadlineMs,
        timeoutMs: Number(config.timeoutMs || DEFAULT_TIMEOUT_MS),
        repo: options.repo || null,
        sha: options.sha || null,
        playwright: expandHome(options.playwright || config.playwright),
        heads: new Map(),
        browser: null,
        browserServer: null,
        closing: false,
    };
    const startedAt = new Date();
    const results = new Array(population.length);
    let printed = 0;
    const flush = () => {
        while (printed < population.length && results[printed]) {
            const r = results[printed++];
            process.stdout.write(`CHECK ${r.id}: ${r.status} | ${r.value}\n`);
        }
    };
    const index = new Map(population.map((check, i) => [check, i]));
    const worker = async (check) => { results[index.get(check)] = await runCheck(run, check); flush(); };
    await Promise.all([
        pool(population.filter(needsBrowser), BROWSER_POOL, worker),
        pool(population.filter((check) => !needsBrowser(check)), HTTP_POOL, worker),
    ]);
    clearTimeout(deadlineTimer);
    await shutdownBrowser(run);
    const finishedAt = new Date();
    const counts = { total: results.length, [PASS]: 0, [FAIL]: 0, [INDET]: 0 };
    for (const r of results) counts[r.status]++;
    const exit = exitCodeFor(counts);
    const durationMs = finishedAt - startedAt;
    // The receipt goes first: a failed write must not follow a printed verdict it contradicts.
    if (options.out) {
        writeReceipt(options.out, {
            tool: 'verify-shipped', schema: 1, repo: run.repo, sha: run.sha,
            startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs, modelTokens: 0,
            population: { count: counts.total, ids: results.map((r) => r.id) },
            counts: { pass: counts[PASS], fail: counts[FAIL], indeterminate: counts[INDET] }, exit, results,
        });
    }
    process.stdout.write(`POPULATION ${counts.total} | PASS ${counts[PASS]} FAIL ${counts[FAIL]} INDETERMINATE ${counts[INDET]} | ${durationMs}ms | exit ${exit}\n`);
    return exit;
}

async function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
        if (options.help) { process.stdout.write(HELP); return; }
        validateOptions(options);
        // An older receipt must not outlive a run that could not write a new one.
        if (options.out) fs.rmSync(options.out, { force: true });
        process.exitCode = await execute(options);
    } catch (e) {
        process.stderr.write(`verify-shipped: ${e instanceof Refusal ? 'refused: ' : 'error: '}${e.message}\n`);
        process.exitCode = 2;
    }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { challengeReason, cleanValue, compareVersions, exitCodeFor, parseLocs, safeUrl, shaMatches, validateConfig };
