#!/usr/bin/env node
// push-guard.js: the local half of release protection, run by the pre-push hook.
//
// A version is a cache key, so a published release must never change. GitHub
// rulesets refuse that on the server (docs/release-rulesets/). This refuses it
// one step earlier, on this machine, so the mistake fails before it leaves:
//
//   - a force-push (non-fast-forward update) or deletion of main or stable
//   - any update or deletion of an existing release tag (refs/tags/v*)
//
// Creating a new tag and moving main or stable forward stay allowed: that is
// the release path (tooling/publish-release.js).
//
// git feeds the hook one line per ref on stdin:
//   <local ref> <local sha> <remote ref> <remote sha>
// A remote sha of all zeros means the ref is new, a local sha of all zeros
// means a deletion. When the old remote commit is not in this clone, a
// fast-forward cannot be proved, so the push is refused (fail closed): fetch
// first. Bypass, when you mean it: git push --no-verify.
//
// Run: node tooling/push-guard.js < refs   (exit 1 refuses, with the reasons)

const { spawnSync } = require('child_process');

const ZERO = /^0{40}$/;
const BRANCHES = new Set(['refs/heads/main', 'refs/heads/stable']);
const RELEASE_TAG = /^refs\/tags\/v[^/]*$/;

function isAncestor(older, newer, cwd) {
    const r = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd, encoding: 'utf8', windowsHide: true });
    return r.status === 0;
}

/** Pure apart from the ancestry probe: the refusal reasons for git's stdin lines. */
function refusals(input, { cwd = process.cwd(), ancestor = isAncestor } = {}) {
    const out = [];
    for (const raw of String(input).split(/\r?\n/)) {
        const parts = raw.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const [, localSha, remoteRef, remoteSha] = parts;
        if (ZERO.test(remoteSha)) continue; // a new ref: creation is the release path
        if (RELEASE_TAG.test(remoteRef)) {
            out.push(`${remoteRef} already exists on the remote: a release tag is never ${ZERO.test(localSha) ? 'deleted' : 'moved'}`);
        } else if (BRANCHES.has(remoteRef)) {
            if (ZERO.test(localSha)) out.push(`${remoteRef} is never deleted`);
            else if (!ancestor(remoteSha, localSha, cwd)) {
                out.push(`${remoteRef}: ${localSha.slice(0, 12)} does not contain the remote ${remoteSha.slice(0, 12)}, so this is a force-push (or the remote commit is not fetched)`);
            }
        }
    }
    return out;
}

module.exports = { refusals };

if (require.main === module) {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
        const reasons = refusals(Buffer.concat(chunks).toString('utf8'));
        if (reasons.length) {
            for (const r of reasons) console.error(`push-guard: ${r}`);
            console.error('push-guard: not pushing. A release ref only moves forward. Bypass deliberately with: git push --no-verify');
            process.exitCode = 1;
        }
    });
}
