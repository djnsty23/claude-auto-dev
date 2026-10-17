#!/usr/bin/env node
// publish-release.js: the only path that moves `stable`, bound to a gate receipt.
//
// Installs pin to the stable branch, so moving it is what ships a version, and
// stable must equal the release tag's commit. A GitHub ruleset refuses every
// direct push to stable, including the operator's (docs/release-rulesets/).
// Its one bypass actor is a repository deploy key, held only on the operator's
// machine and used only here. So the server lets stable move only through this
// script, and this script moves it only when:
//
//   1. v<version> is an annotated tag in this clone, and VERSION at its commit
//      says <version>
//   2. that commit is on origin/main (it landed through a pull request)
//   3. origin/stable is an ancestor of it (stable only moves forward)
//   4. the gate receipt proves that commit's tree: it passes merge-lock's
//      receiptProblem() with full for --head (default the tag commit), so a
//      wrapped gate:fast run is refused here, and --head has the
//      same tree as the tag commit. A rebase merge rewrites the SHA, never the
//      tree, so the full gate on the release PR's frozen candidate (bump.js
//      step 3) binds the release.
//   5. the tag is absent on the remote, or already this exact tag object
//
// Then one atomic push over SSH with the deploy key creates the tag and moves
// stable, and a read-back over the normal origin asserts both name the commit.
//
// The private key is never read, printed or passed on argv: git's ssh opens it
// by path. GitHub's host keys come from `gh api meta` over HTTPS, so there is no
// trust-on-first-use prompt.
//
// Run:
//   node tooling/publish-release.js --version 8.193.0 --gate-receipt FILE [--head SHA] [--dry-run]
//   options: --key PATH (default ~/.ssh/claude-auto-dev-publish, or AUTODEV_PUBLISH_KEY)
//            --repo owner/name (default from package.json)
// Exit: 0 published or already published · 1 refused · 2 could not tell (network, gh)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000, ...opts });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const git = (...args) => run('git', args);

function parseArgs(argv) {
    const a = { dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--dry-run') a.dryRun = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else if (['--version', '--gate-receipt', '--head', '--key', '--repo'].includes(k)) a[k.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = argv[++i];
        else a.unknown = k;
    }
    return a;
}

function repoSlug() {
    try {
        const url = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository.url;
        const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(String(url));
        return m ? `${m[1]}/${m[2]}` : null;
    } catch { return null; }
}

/**
 * Pure: the refusal reasons for the facts gathered from git and the receipt.
 * An empty list means publish. `already` means the remote already holds it.
 */
function judge(f) {
    const no = [];
    if (f.tagType !== 'tag') no.push(`v${f.version} is ${f.tagType ? `a ${f.tagType}, not an annotated tag` : 'not a tag in this clone'}: git tag -a v${f.version} -m "v${f.version}" <commit>`);
    if (f.tagType === 'tag') {
        if (f.versionAtCommit !== f.version) no.push(`VERSION at ${f.commit} says ${f.versionAtCommit || 'nothing'}, not ${f.version}`);
        if (!f.onMain) no.push(`${f.commit} is not on origin/main: merge the release PR first, then tag the merged commit`);
        if (!f.stableIsAncestor) no.push(`origin/stable ${f.stable || '(unread)'} is not an ancestor of ${f.commit}: stable only moves forward`);
        if (f.receiptProblem) no.push(f.receiptProblem);
        else if (!f.headTree || f.headTree !== f.commitTree) no.push(`the receipt proves ${f.head} with tree ${f.headTree || '(unknown)'}, but ${f.commit} has tree ${f.commitTree}`);
        if (f.remoteTag && f.remoteTag !== f.tagObject) no.push(`the remote already has v${f.version} as ${f.remoteTag}, not this tag ${f.tagObject}: a release tag is never replaced`);
    }
    const already = no.length === 0 && f.remoteTag === f.tagObject && f.stable === f.commit;
    return { refusals: no, already };
}

/** Live and read-only: everything judge() needs. Returns { facts } or { error }. */
function gather({ version, gateReceipt, head }) {
    const fetch = git('fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/stable:refs/remotes/origin/stable');
    if (fetch.code !== 0) return { error: `git fetch origin failed: ${fetch.err.split('\n').pop()}` };
    const tagRef = `refs/tags/v${version}`;
    const f = { version };
    const type = git('cat-file', '-t', tagRef);
    f.tagType = type.code === 0 ? type.out : null;
    if (f.tagType !== 'tag') return { facts: f };
    f.tagObject = git('rev-parse', tagRef).out;
    f.commit = git('rev-parse', `${tagRef}^{commit}`).out;
    f.commitTree = git('rev-parse', `${f.commit}^{tree}`).out;
    const v = git('show', `${f.commit}:VERSION`);
    f.versionAtCommit = v.code === 0 ? v.out : null;
    f.onMain = git('merge-base', '--is-ancestor', f.commit, 'refs/remotes/origin/main').code === 0;
    const ls = git('ls-remote', 'origin', 'refs/heads/stable', tagRef);
    if (ls.code !== 0) return { error: `git ls-remote origin failed: ${ls.err.split('\n').pop()}` };
    for (const row of ls.out.split('\n').filter(Boolean)) {
        const [sha, ref] = row.split('\t');
        if (ref === 'refs/heads/stable') f.stable = sha;
        if (ref === tagRef) f.remoteTag = sha;
    }
    f.stableIsAncestor = Boolean(f.stable) && git('merge-base', '--is-ancestor', f.stable, f.commit).code === 0;
    f.head = String(head || f.commit).toLowerCase();
    f.receiptProblem = releaseReceiptProblem(gateReceipt, f.head);
    const ht = git('rev-parse', '--verify', '--quiet', `${f.head}^{tree}`);
    f.headTree = ht.code === 0 ? ht.out : null;
    return { facts: f };
}

/** GitHub's SSH host keys, read over authenticated HTTPS, as a known_hosts file. */
function knownHosts(dir) {
    const r = run('gh', ['api', 'meta', '--jq', '.ssh_keys[]']);
    if (r.code !== 0 || !r.out) return null;
    const file = path.join(dir, 'known_hosts');
    fs.writeFileSync(file, r.out.split('\n').filter(Boolean).map((k) => `github.com ${k.trim()}`).join('\n') + '\n');
    return file;
}

function sshEnv(key, hosts) {
    const fwd = (p) => p.replace(/\\/g, '/');
    return {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -i "${fwd(key)}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${fwd(hosts)}"`,
    };
}

function main() {
    const a = parseArgs(process.argv.slice(2));
    if (a.help) {
        const head = fs.readFileSync(__filename, 'utf8').split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, ''));
        console.log(head.join('\n'));
        return 0;
    }
    if (a.unknown) { console.error(`publish-release: unknown argument ${a.unknown}`); return 1; }
    if (!VERSION_RE.test(a.version || '')) { console.error('publish-release: --version X.Y.Z is required'); return 1; }
    if (!a.gateReceipt) { console.error('publish-release: --gate-receipt FILE is required: the gate log of the release candidate'); return 1; }
    const repo = a.repo || repoSlug();
    const key = a.key || process.env.AUTODEV_PUBLISH_KEY || path.join(os.homedir(), '.ssh', 'claude-auto-dev-publish');

    const g = gather(a);
    if (g.error) { console.error(`publish-release: ${g.error}`); return 2; }
    const f = g.facts;
    const verdict = judge(f);
    if (verdict.refusals.length) {
        for (const r of verdict.refusals) console.error(`publish-release: refused: ${r}`);
        return 1;
    }
    if (verdict.already) { console.log(`publish-release: v${a.version} is already published, stable = ${f.commit}`); return 0; }
    if (!fs.existsSync(key)) { console.error(`publish-release: no deploy key at ${key}. See docs/release-rulesets/README.md`); return 1; }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-release-'));
    try {
        const hosts = knownHosts(tmp);
        if (!hosts) { console.error('publish-release: could not read GitHub SSH host keys with gh api meta'); return 2; }
        const env = sshEnv(key, hosts);
        const url = `git@github.com:${repo}.git`;
        // The key must reach the repository before anything is pushed.
        const probe = run('git', ['ls-remote', url, 'refs/heads/stable'], { env });
        if (probe.code !== 0) { console.error(`publish-release: the deploy key cannot read ${repo}: ${probe.err.split('\n').pop()}`); return 2; }
        const refspecs = [`refs/tags/v${a.version}:refs/tags/v${a.version}`, `${f.commit}:refs/heads/stable`];
        console.log(`publish-release: v${a.version} = ${f.commit} (tree ${f.commitTree}), stable ${f.stable} -> ${f.commit}`);
        if (a.dryRun) {
            console.log(`publish-release: dry run, would push --atomic ${url} ${refspecs.join(' ')}`);
            return 0;
        }
        const push = run('git', ['push', '--atomic', url, ...refspecs], { env, timeout: 120000 });
        if (push.code !== 0) { console.error(`publish-release: push failed:\n${push.err}`); return 1; }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    const back = git('ls-remote', 'origin', 'refs/heads/stable', `refs/tags/v${a.version}^{}`);
    const rows = Object.fromEntries(back.out.split('\n').filter(Boolean).map((r) => r.split('\t').reverse()));
    const stableNow = rows['refs/heads/stable'];
    const tagNow = rows[`refs/tags/v${a.version}^{}`];
    console.log(`publish-release: read back stable=${stableNow} v${a.version}^{}=${tagNow}`);
    if (stableNow !== f.commit || tagNow !== f.commit) { console.error('publish-release: the read-back does not match the release commit'); return 2; }
    console.log(`publish-release: v${a.version} published`);
    return 0;
}

/** The release bar: a full gate receipt for a 40-hex head, never a wrapped gate:fast run. */
function releaseReceiptProblem(gateReceipt, head) {
    if (!SHA_RE.test(head)) return `--head ${head} is not a 40-hex sha`;
    const { receiptProblem } = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'merge-lock.js'));
    return receiptProblem(gateReceipt, head, { full: true });
}

module.exports = { judge, parseArgs, releaseReceiptProblem };

if (require.main === module) process.exitCode = main();
