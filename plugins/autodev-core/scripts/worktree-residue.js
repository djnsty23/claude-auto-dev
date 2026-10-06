/**
 * worktree-residue.js - what a removed worktree takes with it, and whether a
 * session has written in it lately. Shared by session-sweep.js (which decides
 * whether archive_session may remove a session's worktree) and
 * worktree-reap.js (which removes merged worktrees itself), so the two cannot
 * disagree about what counts as loss.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const claudePaths = require('./claude-paths.js');

// Gitignored paths a build, an install or this harness writes back. Anything
// ignored and NOT on this list exists only in that worktree, and removing the
// worktree deletes it. Matched against the path `git status --ignored` prints,
// which ends in '/' for a directory and may sit under a package directory
// (`site/.next/`). Keep this list narrow: a miss here is clutter (a worktree
// kept a little longer), a false entry is loss.
//
// The harness entries are its own throttle, flag and scratch files, rewritten
// on the next run. `.claude/reports/`, `.claude/archives/`, `.claude/handoffs/`
// and the rest of `.claude/` are deliberately NOT here: a report or a prd
// archive in a worktree is the only copy, and naming it is the point.
// [measured 2026-09-16] over 30 live session records, the unfiltered list
// flagged five, three of them for hundreds of `.claude/COMMIT_MSG_v*.txt`
// scratch files beside the one `.claude/archives/` that was the real finding.
const REGENERABLE = [
    /(^|\/)node_modules\//, /(^|\/)\.next\//, /(^|\/)dist\//, /(^|\/)build\//, /^out\//,
    /(^|\/)coverage\//, /(^|\/)\.turbo\//, /(^|\/)\.vercel\//, /(^|\/)\.cache\//,
    /(^|\/)__pycache__\//, /\.pyc$/, /(^|\/)\.pytest_cache\//, /(^|\/)\.venv\//,
    /(^|\/)target\//, /(^|\/)\.parcel-cache\//, /(^|\/)playwright-report\//,
    /(^|\/)test-results\//, /(^|\/)tsconfig\.tsbuildinfo$/, /(^|\/)next-env\.d\.ts$/,
    /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/,
    /^\.claude\/memory-sessions\//, /^\.claude\/\.claude\//, /^\.claude\/types\//,
    /^\.claude\/knowledge-surfaced$/, /^\.claude\/panel-deny\.json$/,
    /^\.claude\/settings\.local\.json$/, /^\.claude\/pre-compact-state\.json$/,
    /^\.claude\/auto-(active|exit|idle-triggered)$/, /^\.claude\/\.typecheck-pending(\.\d+\.claim)?$/,
    /^\.claude\/memory-session-id$/, /^\.claude\/commit-msg\.txt$/, /^\.claude\/COMMIT_MSG_[^/]*\.txt$/,
];

const isRegenerable = (p) => REGENERABLE.some((re) => re.test(p));

/**
 * Every profile's transcript directory for a worktree. A transcript lives in
 * `<config dir>/projects/<slug>/`, the slug being the cwd with each separator,
 * dot and drive colon replaced by '-'. A machine can run more than one profile
 * (CLAUDE_CONFIG_DIR, or a second `.claude-<name>` dir under the same home),
 * and a session in any of them makes the worktree live, so all are read.
 * AUTODEV_REAP_PROJECTS_DIRS (path-delimited) replaces the list in a suite.
 */
function transcriptDirs(worktree, env = process.env) {
    const slug = String(worktree).replace(/[/.:\\]/g, '-');
    let roots;
    if (env.AUTODEV_REAP_PROJECTS_DIRS) roots = env.AUTODEV_REAP_PROJECTS_DIRS.split(path.delimiter).filter(Boolean);
    else {
        const set = new Set([path.join(claudePaths.configDir(env), 'projects')]);
        const home = claudePaths.homeDir(env);
        try {
            for (const n of fs.readdirSync(home)) if (/^\.claude(-[A-Za-z0-9_]+)?$/.test(n)) set.add(path.join(home, n, 'projects'));
        } catch { /* the home cannot be listed: the config dir alone */ }
        roots = [...set];
    }
    return roots.map((r) => path.join(r, slug));
}

/** The newest transcript write for a worktree in ms, 0 when none exists. */
function newestTranscriptMs(worktree, env = process.env) {
    let newest = 0;
    for (const dir of transcriptDirs(worktree, env)) {
        let names;
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) {
            if (!n.endsWith('.jsonl')) continue;
            try { newest = Math.max(newest, fs.statSync(path.join(dir, n)).mtimeMs); } catch { /* gone */ }
        }
    }
    return newest;
}

module.exports = { REGENERABLE, isRegenerable, transcriptDirs, newestTranscriptMs };
