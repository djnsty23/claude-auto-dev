#!/usr/bin/env node
// Does GitHub itself stop a release from being changed after the fact?
//
// A version number is a cache key: an install of v8.191.0 must always get the
// same tree. Today that holds only because every session cooperates. This
// reads the repository's rulesets and classic branch protection, read-only,
// and says for the acting account whether each change is refused:
//
//   direct_write        a push to main or stable outside a pull request
//   tag_replace         moving an existing release tag (refs/tags/v*)
//   tag_delete          deleting one
//   authorized_publish  the release path still works: a new v* tag can be
//                       created, and main and stable can still move forward
//
// It never writes a rule and never pushes. A rule the acting account can
// bypass always does not protect anything against that account, so it counts
// as ALLOWED. When GitHub cannot be read, every field is UNKNOWN.
//
// Run: node tooling/release-protection.js [--repo owner/name] [--json] [--observe]
//
// --observe also appends the reading, with its time, to
// <config dir>/autodev/windows/release-protection.jsonl. The scorecard's
// release-window (tooling/window-specs.js) grades 14 days of those lines, so a
// scheduled --observe is what turns point samples into an observation. An
// UNKNOWN reading is appended too: a day GitHub could not be read is a gap.

const { spawnSync } = require('child_process');

const BRANCHES = ['refs/heads/main', 'refs/heads/stable'];
const TAG = 'refs/tags/v0.0.0-probe';

// GitHub ruleset ref patterns are fnmatch globs with two special names.
function globToRegex(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
        } else if (ch === '?') re += '[^/]';
        else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
}

function matches(pattern, ref, defaultBranch) {
    if (pattern === '~ALL') return true;
    if (pattern === '~DEFAULT_BRANCH') return ref === 'refs/heads/' + defaultBranch;
    return globToRegex(pattern).test(ref);
}

function covers(ruleset, ref, defaultBranch) {
    const target = ruleset.target || 'branch';
    if (target === 'branch' && !ref.startsWith('refs/heads/')) return false;
    if (target === 'tag' && !ref.startsWith('refs/tags/')) return false;
    const cond = (ruleset.conditions && ruleset.conditions.ref_name) || {};
    const inc = cond.include || [];
    const exc = cond.exclude || [];
    return inc.some((p) => matches(p, ref, defaultBranch)) && !exc.some((p) => matches(p, ref, defaultBranch));
}

// A ruleset binds the acting account only when it is enforced and the account
// cannot always bypass it. "pull_requests_only" still refuses a direct push.
function binds(ruleset) {
    return ruleset.enforcement === 'active' && ruleset.current_user_can_bypass !== 'always';
}

function ruleTypesFor(state, ref) {
    const types = new Set();
    for (const rs of state.rulesets || []) {
        if (binds(rs) && covers(rs, ref, state.defaultBranch || 'main')) for (const r of rs.rules || []) types.add(r.type);
    }
    return types;
}

/** The rule types that refuse a force-push to `branch` for the acting account. */
function forcePushBlockers(state, branch) {
    const types = ruleTypesFor(state, 'refs/heads/' + branch);
    return ['non_fast_forward', 'pull_request', 'update'].filter((t) => types.has(t));
}

function classicBlocksDirect(p) {
    if (!p) return false;
    const enforced = p.enforce_admins && p.enforce_admins.enabled;
    return Boolean(enforced && (p.required_pull_request_reviews || p.restrictions));
}

/** Pure: the four fields from a state read from GitHub (or a fixture). */
function classify(state) {
    const direct = BRANCHES.every((ref) => {
        const t = ruleTypesFor(state, ref);
        const name = ref.slice('refs/heads/'.length);
        return t.has('pull_request') || t.has('update') || classicBlocksDirect((state.classic || {})[name]);
    });
    const tagTypes = ruleTypesFor(state, TAG);
    const branchesMove = BRANCHES.every((ref) => !ruleTypesFor(state, ref).has('update'));
    return {
        direct_write: direct ? 'DENIED' : 'ALLOWED',
        tag_replace: tagTypes.has('update') || tagTypes.has('non_fast_forward') ? 'DENIED' : 'ALLOWED',
        tag_delete: tagTypes.has('deletion') ? 'DENIED' : 'ALLOWED',
        authorized_publish: !tagTypes.has('creation') && branchesMove ? 'PASS' : 'FAIL',
    };
}

const UNKNOWN = { direct_write: 'UNKNOWN', tag_replace: 'UNKNOWN', tag_delete: 'UNKNOWN', authorized_publish: 'UNKNOWN' };

function gh(args) {
    const r = spawnSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function repoFromRemote() {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true });
    const m = /github\.com[:/]([^/]+\/[^/.\s]+?)(?:\.git)?\s*$/.exec(r.stdout || '');
    return m ? m[1] : null;
}

/** Live and read-only. Returns { state } or { error }. */
function readLive(repo) {
    if (!repo) return { error: 'no GitHub origin' };
    const meta = gh([`repos/${repo}`]);
    if (meta.code !== 0) return { error: `repo read failed: ${meta.err.trim().slice(0, 120)}` };
    const defaultBranch = JSON.parse(meta.out).default_branch;
    const list = gh([`repos/${repo}/rulesets?includes_parents=true`]);
    if (list.code !== 0) return { error: `ruleset list failed: ${list.err.trim().slice(0, 120)}` };
    const rulesets = [];
    for (const { id } of JSON.parse(list.out)) {
        const one = gh([`repos/${repo}/rulesets/${id}`]);
        if (one.code !== 0) return { error: `ruleset ${id} read failed` };
        rulesets.push(JSON.parse(one.out));
    }
    const classic = {};
    for (const name of ['main', 'stable']) {
        const p = gh([`repos/${repo}/branches/${name}/protection`]);
        if (p.code === 0) classic[name] = JSON.parse(p.out);
        else if (/Branch not protected|Not Found|404/.test(p.err + p.out)) classic[name] = null;
        else return { error: `protection read for ${name} failed` };
    }
    return { state: { defaultBranch, rulesets, classic } };
}

const line = (f) => `direct_write=${f.direct_write} tag_replace=${f.tag_replace} tag_delete=${f.tag_delete} authorized_publish=${f.authorized_publish}`;

module.exports = { classify, readLive, repoFromRemote, line, globToRegex, forcePushBlockers, UNKNOWN };

if (require.main === module) {
    const args = process.argv.slice(2);
    const i = args.indexOf('--repo');
    const repo = i >= 0 ? args[i + 1] : repoFromRemote();
    const live = readLive(repo);
    const fields = live.state ? classify(live.state) : UNKNOWN;
    if (args.includes('--observe')) {
        let base = null;
        try { base = require('../plugins/autodev-core/scripts/claude-paths.js').configDir(); } catch { /* reported below */ }
        if (!base) { console.error('release-protection: no config dir resolved, so the observation was not written'); process.exitCode = 2; } else {
            const fs = require('fs');
            const dir = require('path').join(base, 'autodev', 'windows');
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(require('path').join(dir, 'release-protection.jsonl'),
                `${JSON.stringify({ at: new Date().toISOString(), repo, fields, error: live.error || null })}\n`);
        }
    }
    if (args.includes('--json')) console.log(JSON.stringify({ repo, fields, error: live.error || null }));
    else {
        if (live.error) console.error(`release-protection: ${live.error}`);
        console.log(line(fields));
    }
}
