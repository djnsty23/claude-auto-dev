#!/usr/bin/env node
// Tests for tooling/release-protection.js, then its live, read-only verdict.
//
// The fixture half grades the classifier against hand-written GitHub states,
// and its result is this suite's exit code. The live half reads this
// repository's real rules and prints the summary line the scorecard grades:
//
//   direct_write=DENIED tag_replace=DENIED tag_delete=DENIED authorized_publish=PASS
//
// The live line is the truth about the remote, so it may read ALLOWED (no
// protection yet) or UNKNOWN (GitHub unreachable) while every fixture passes.
// A missing protection is a fact about the repository, not a defect in this code.
//
// Run: node tooling/test-release-protection.js [--offline]

const rp = require('./release-protection.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log(`ok ${name}`); } else { failed++; console.log(`FAIL ${name}${detail ? ' | ' + detail : ''}`); }
}

const rs = (target, include, rules, extra = {}) => ({
    target, enforcement: 'active', current_user_can_bypass: 'never',
    conditions: { ref_name: { include, exclude: extra.exclude || [] } },
    rules: rules.map((type) => ({ type })), ...extra,
});
const TAGS = rs('tag', ['refs/tags/v*'], ['update', 'deletion', 'non_fast_forward']);
const BRANCHES = rs('branch', ['~DEFAULT_BRANCH', 'refs/heads/stable'], ['pull_request', 'deletion', 'non_fast_forward']);
const state = (rulesets, classic = { main: null, stable: null }) => ({ defaultBranch: 'main', rulesets, classic });
const eq = (f, want) => JSON.stringify(f) === JSON.stringify(want);

// Globs and special names.
check('v* matches a release tag', rp.globToRegex('refs/tags/v*').test('refs/tags/v8.191.0'));
check('* stops at a slash', !rp.globToRegex('refs/heads/*').test('refs/heads/a/b'));
check('** crosses slashes', rp.globToRegex('refs/heads/**').test('refs/heads/a/b'));

// No protection at all: everything allowed, and the release path works.
check('unprotected repo allows every change', eq(rp.classify(state([])),
    { direct_write: 'ALLOWED', tag_replace: 'ALLOWED', tag_delete: 'ALLOWED', authorized_publish: 'PASS' }));

// The target state.
check('tag and branch rulesets deny all three', eq(rp.classify(state([TAGS, BRANCHES])),
    { direct_write: 'DENIED', tag_replace: 'DENIED', tag_delete: 'DENIED', authorized_publish: 'PASS' }));

// A rule the account can always bypass protects nothing against it.
check('bypass always counts as allowed', rp.classify(state([{ ...TAGS, current_user_can_bypass: 'always' }])).tag_replace === 'ALLOWED');
check('pull_requests_only still denies a direct push', rp.classify(state([{ ...BRANCHES, current_user_can_bypass: 'pull_requests_only' }])).direct_write === 'DENIED');
check('an evaluate-only ruleset enforces nothing', rp.classify(state([{ ...TAGS, enforcement: 'evaluate' }])).tag_delete === 'ALLOWED');

// Both branches must be covered.
check('main alone leaves stable open', rp.classify(state([rs('branch', ['~DEFAULT_BRANCH'], ['pull_request'])])).direct_write === 'ALLOWED');
check('an exclude reopens stable', rp.classify(state([{ ...BRANCHES, conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/stable'] } } }])).direct_write === 'ALLOWED');
check('a tag ruleset never covers a branch', rp.classify(state([rs('tag', ['~ALL'], ['pull_request'])])).direct_write === 'ALLOWED');

// Classic branch protection binds an admin only when enforced for admins.
const classic = { required_pull_request_reviews: {}, enforce_admins: { enabled: false } };
check('classic protection without enforce_admins allows the admin', rp.classify(state([], { main: classic, stable: classic })).direct_write === 'ALLOWED');
const enforced = { ...classic, enforce_admins: { enabled: true } };
check('classic protection enforced for admins denies', rp.classify(state([], { main: enforced, stable: enforced })).direct_write === 'DENIED');

// Over-protection breaks the release path, and the probe says so.
check('a creation rule on tags blocks publishing', rp.classify(state([rs('tag', ['refs/tags/v*'], ['creation'])])).authorized_publish === 'FAIL');
check('an update rule on stable blocks publishing', rp.classify(state([rs('branch', ['refs/heads/stable'], ['update'])])).authorized_publish === 'FAIL');

check('UNKNOWN covers every field', Object.values(rp.UNKNOWN).every((v) => v === 'UNKNOWN'));

console.log(`${passed} passed, ${failed} failed`);

// The live verdict: read-only, never a reason for this suite to fail.
let fields = rp.UNKNOWN;
if (!process.argv.includes('--offline')) {
    try {
        const live = rp.readLive(rp.repoFromRemote());
        if (live.state) fields = rp.classify(live.state);
        else console.log(`live read: ${live.error}`);
    } catch (e) { console.log(`live read threw: ${e.message}`); }
}
console.log(rp.line(fields));
process.exitCode = failed ? 1 : 0;
