#!/usr/bin/env node
// SessionStart hook — surface the version, the active sprint, and the working
// tree state at the top of a session.
//
// Output is structured deliberately:
//   systemMessage     → the one-line banner the user sees
//   additionalContext → the sprint state Claude should actually reason about
// Plain stdout is not a reliable channel for the second one.
//
// Updates are handled by Claude Code: /plugin marketplace update autodev

const fs = require('fs');
const path = require('path');
// execFileSync, not execSync: execSync routes through cmd.exe on Windows, which
// (a) creates a console window unless windowsHide is set — Node defaults it to
// false, and Claude Desktop has no console to inherit — and (b) treats `^` as an
// escape character, silently corrupting any git ref that contains one. This call
// needs no shell features, so the shell is pure downside.
const { execFileSync } = require('child_process');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

// Hooks are always piped JSON in production; the TTY guard keeps a manual
// `node session-start.js` from blocking forever on an interactive stdin.
function readPayload() {
    try {
        if (process.stdin.isTTY) return {};
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return {};
    }
}

const payload = readPayload();
const cwd = payload.cwd || process.cwd();

const context = [];
let banner = '';

try {
    // ---- Version (single source of truth: our own plugin.json) ----
    let version = '?';
    try {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
        );
        if (manifest.version) version = manifest.version;
    } catch { /* banner degrades to v? — never worth failing over */ }
    banner = `Auto-Dev v${version}`;

    // ---- Sprint state from prd.json ----
    const prdPath = path.join(cwd, 'prd.json');
    if (fs.existsSync(prdPath)) {
        try {
            const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
            const stories = prd.stories || {};
            const entries = Object.entries(stories);
            const done = entries.filter(([, s]) => s.passes === true);
            const deferred = entries.filter(([, s]) => s.passes === 'deferred');
            const pending = entries.filter(([, s]) => s.passes !== true && s.passes !== 'deferred');

            const summary = `Sprint ${prd.sprint || '(unnamed)'}: ${done.length} done, ` +
                `${pending.length} pending, ${deferred.length} deferred.`;
            banner += ` | ${summary}`;

            context.push(`This project uses autodev's prd.json task system. ${summary}`);
            if (pending.length > 0) {
                const next = pending.slice(0, 3).map(([id, s]) => `${id} (${s.title || 'untitled'})`);
                context.push(`Next pending stories: ${next.join(', ')}${pending.length > 3 ? `, +${pending.length - 3} more` : ''}.`);
            }
        } catch (parseErr) {
            context.push(`prd.json exists but failed to parse: ${parseErr.message}. Fix it before running sprint commands.`);
        }
    }

    // ---- Plugin drift (the 2026-08-18 failure class) ----
    // Installed core ran 62 minor versions behind for two days while every
    // layer reported healthy: the marketplace auto-pull had silently stopped,
    // and an interrupted /plugin update wrote the cache but never flipped the
    // manifest. The nightly drift audit filed both as `warn`, which its policy
    // leaves alone — so nothing the user actually looks at ever said a word.
    //
    // Two local checks, no network, no subprocess (a session-start hook must
    // not block on DNS). Zero added bytes when clean.
    if (version !== '?') {
        try {
            const cfgDir = process.env.CLAUDE_CONFIG_DIR
                || path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
            const marketsDir = path.join(cfgDir, 'plugins', 'marketplaces');
            const selfName = JSON.parse(
                fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
            ).name;
            // Find the marketplace whose catalog carries us. Iterating beats
            // parsing our own install path: a dev checkout is not under
            // plugins/cache/<market>/... and must degrade to silence.
            for (const market of fs.existsSync(marketsDir) ? fs.readdirSync(marketsDir) : []) {
                const catPath = path.join(marketsDir, market, '.claude-plugin', 'marketplace.json');
                let cat;
                try { cat = JSON.parse(fs.readFileSync(catPath, 'utf8')); } catch { continue; }
                const entry = (cat.plugins || []).find((p) => p && p.name === selfName);
                if (!entry || !entry.version) continue;

                // 1. Installed vs catalog. Strictly newer only — a catalog
                //    BEHIND the install (mid-publish, rolled back) is not an
                //    update and must stay silent.
                const parse = (v) => String(v).split('.').map(Number);
                const [a, b] = [parse(entry.version), parse(version)];
                const newer = a.length === 3 && b.length === 3 && a.every(Number.isFinite) && b.every(Number.isFinite)
                    && (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;
                if (newer) {
                    banner += ` | update available: ${entry.version}`;
                    context.push(
                        `${selfName} v${version} is running but the local marketplace offers v${entry.version}. `
                        + `Suggest the user run: /plugin update ${selfName} (then restart to apply). `
                        + `Verify afterwards that the installed version actually changed — one update `
                        + `has silently no-oped before.`
                    );
                }

                // 2. Catalog freshness. FETCH_HEAD's mtime is the last time the
                //    clone talked to the remote; a quiet week means the
                //    per-session auto-pull has stopped and versions above are
                //    being compared against a stale ceiling.
                try {
                    const fetchHead = path.join(marketsDir, market, '.git', 'FETCH_HEAD');
                    const ageDays = Math.floor((Date.now() - fs.statSync(fetchHead).mtimeMs) / 86400000);
                    if (ageDays > 7) {
                        context.push(
                            `The "${market}" marketplace clone last refreshed ${ageDays} days ago — its catalog `
                            + `is a stale ceiling, so "up to date" above may be false. Suggest: `
                            + `/plugin marketplace update ${market}`
                        );
                    }
                } catch { /* no FETCH_HEAD: never-fetched local clone — nothing to measure */ }
                break;
            }
        } catch { /* drift check is best-effort; the banner must survive it */ }
    }

    // ---- Working tree ----
    try {
        const gitStatus = execFileSync('git', ['status', '--short'], {
            cwd,
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }).toString().trim();

        if (gitStatus) {
            const changes = gitStatus.split('\n').length;
            context.push(`Working tree has ${changes} uncommitted change${changes === 1 ? '' : 's'} at session start.`);
        }
    } catch { /* not a git repo, or git unavailable */ }

    // ---- Parallel work on this repo ----
    //
    // Sessions cannot see each other, so two agents routinely edit the same
    // lines in different worktrees and neither learns until a cleanup PR
    // deletes one of them. A peer's assessment of a coordinating overseer,
    // `[measured 2026-08-24]`: "Three sessions still independently fixed the
    // same vi.mock lines; preventing that is the whole premise, and you had no
    // more visibility than I did."
    //
    // LOCAL REFS ONLY, deliberately. `git ls-remote` and `gh pr list` are the
    // authoritative registries, and they are network calls — this runs on every
    // session start, so it reads remote-tracking refs from disk instead. The
    // cost is that they are only as fresh as the last fetch, which the output
    // states rather than glosses: a stale count read as current is worse than
    // no count. The commands that ARE authoritative are named so the reader can
    // run them when the answer matters.
    try {
        const git = (args) => execFileSync('git', args, {
            cwd,
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        }).toString();

        // Compare worktree ROOTS, not cwd — a session's shell is often deeper
        // in the tree. realpathSync because macOS reports /var and
        // /private/var for the same directory and they must compare equal.
        let here = null;
        try { here = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim()); } catch { /* not a worktree */ }

        const others = [];
        for (const block of git(['worktree', 'list', '--porcelain']).split(/\n\s*\n/)) {
            const wt = /^worktree (.+)$/m.exec(block);
            if (!wt) continue;
            let root = wt[1].trim();
            try { root = fs.realpathSync(root); } catch { /* pruned or unreachable */ }
            if (here && root === here) continue;
            const br = /^branch refs\/heads\/(.+)$/m.exec(block);
            others.push(br ? br[1].trim() : '(detached)');
        }

        // Branches on the remote that main has not absorbed. Errors when there
        // is no origin/main at all, which is a normal state for a fresh clone.
        let unmerged = [];
        try {
            unmerged = git(['branch', '-r', '--no-merged', 'origin/main', '--format=%(refname:short)'])
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => s && !s.includes('->') && s !== 'origin/main');
        } catch { /* no origin/main — nothing to compare against */ }

        if (others.length > 0 || unmerged.length > 0) {
            const parts = [];
            if (others.length > 0) {
                const shown = others.slice(0, 5).join(', ');
                const more = others.length > 5 ? `, +${others.length - 5} more` : '';
                parts.push(`${others.length} other worktree${others.length === 1 ? '' : 's'} (${shown}${more})`);
            }
            if (unmerged.length > 0) {
                parts.push(`${unmerged.length} origin branch${unmerged.length === 1 ? '' : 'es'} not merged into main`);
            }
            context.push(
                `Parallel work, from local refs as of the last fetch: ${parts.join('; ')}. `
                + 'Someone may already be on what you are about to start — the authoritative check is '
                + '`git ls-remote --heads origin` and `gh pr list --state all`.',
            );
        }
    } catch { /* not a git repo, git unavailable, or an unparseable worktree list */ }

    // NOTE: two things used to happen here and no longer do.
    //
    // 1. `.env.local` was parsed into process.env. A hook runs in its own
    //    process, so those variables died with it — SessionStart hooks cannot
    //    set environment variables for the session (they must come from your
    //    shell profile or settings.json). It read a secrets file and printed
    //    "[Env] .env.local loaded" for no effect whatsoever.
    //
    // 2. The version number inside ~/.claude/projects/<slug>/memory/MEMORY.md
    //    was rewritten in place, using a guessed encoding of the project path.
    //    A dev tool has no business silently editing the user's memory files.
} catch (err) {
    process.stderr.write(`session-start error: ${err.message}\n`);
}

const out = {
    systemMessage: `[${banner}]`,
};
if (context.length > 0) {
    out.hookSpecificOutput = {
        hookEventName: 'SessionStart',
        additionalContext: context.join('\n'),
    };
}

process.stdout.write(JSON.stringify(out));

// Always exit 0 — SessionStart hooks inform, never block
process.exit(0);
