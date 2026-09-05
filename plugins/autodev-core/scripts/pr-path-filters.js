'use strict';
/**
 * pr-path-filters.js - would this repo's PR-triggered workflows have RUN on
 * these files? Answers WHY a check rollup is empty.
 *
 * `[measured 2026-09-05]` a docs-only PR sat MERGEABLE/CLEAN with an empty
 * rollup. check-pr-ready refused it, correctly: an empty rollup looks identical
 * to a clean one and is not. But the reason it was empty was benign, both
 * files fell under `preflight`'s `paths-ignore` and outside `browser-gates`'
 * `paths`, and establishing that took a hand-written script against the
 * workflow files at the trunk. This is that script, so the checker can say
 * "zero runs is the filter working" or "a run was due and none exists" itself.
 *
 * Reads workflows at the TRUNK REF, never the working copy: a checkout may be
 * on any branch, and the filter that decides whether CI fires is the one on
 * the base the PR targets.
 *
 * A workflow with a `pull_request:` trigger and no path filter always runs.
 * `paths:` runs ONLY on matches. `paths-ignore:` runs on everything EXCEPT
 * matches. `branches:` is honoured too: a workflow filtered to a branch the PR
 * does not target does not fire, and that is the other way a rollup is empty
 * for a benign reason.
 */

const { execFileSync } = require('child_process');

function git(args, cwd) {
    try {
        return execFileSync('git', args, {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }),
        });
    } catch (e) { return null; }
}

/** Minimal glob-to-RegExp for the subset GitHub uses in path filters. */
function globToRe(g) {
    let s = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*' && g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++; }
        else if (c === '*') s += '[^/]*';
        else if (c === '?') s += '[^/]';
        else if ('.+^${}()|[]\\'.indexOf(c) !== -1) s += '\\' + c;
        else s += c;
    }
    return new RegExp('^' + s + '$');
}

/** The YAML list under `key:` inside a block of text, or null when absent. */
function listUnder(block, key) {
    const m = block.match(new RegExp('(?:^|\\n)\\s*' + key + ':\\s*\\n((?:\\s+-\\s+.*\\n?)+)'));
    if (!m) return null;
    return m[1].split('\n')
        .map((s) => s.replace(/^\s*-\s*/, '').replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim())
        .filter(Boolean);
}

/** The text of the `pull_request:` trigger block, or null if the workflow has none. */
function pullRequestBlock(yaml) {
    // No comment stripping on purpose: every key match below requires the key
    // after whitespace alone, so a `# paths:` line cannot match. A stripping
    // pass here survived mutation testing unchanged, which is the definition
    // of dead code.
    const on = yaml.match(/(?:^|\n)on:\s*\n([\s\S]*?)(?=\njobs:|\n\w+:)/);
    if (!on) return null;
    const pr = on[1].match(/(?:^|\n)\s*pull_request:\s*\n((?:\s{4,}.*\n?)*)/);
    if (!pr) return (/pull_request\s*$/m.test(on[1]) ? '' : null);
    return pr[1];
}

/**
 * @param {string} cwd  a checkout of the repo
 * @param {string} trunk  e.g. 'origin/main'; workflows are read at this ref
 * @param {string[]} files  paths the PR changes, repo-relative
 * @param {string} [base]  the PR's base branch name, for `branches:` filters
 * @returns {{workflows:Array<{name, hasPullRequest, wouldRun, why}>, anyDue:boolean, population:number}}
 */
function explainEmptyRollup(cwd, trunk, files, base) {
    const names = (git(['ls-tree', '--name-only', trunk, '.github/workflows/'], cwd) || '')
        .split('\n').map((s) => s.trim()).filter((s) => /\.ya?ml$/.test(s));
    const out = [];
    for (const p of names) {
        const yaml = git(['show', trunk + ':' + p], cwd);
        const name = p.replace(/^.*\//, '');
        if (yaml === null) { out.push({ name, hasPullRequest: null, wouldRun: null, why: 'unreadable at ' + trunk }); continue; }
        const block = pullRequestBlock(yaml);
        if (block === null) { out.push({ name, hasPullRequest: false, wouldRun: false, why: 'no pull_request trigger' }); continue; }

        const branches = listUnder(block, 'branches');
        if (branches && base && !branches.some((b) => globToRe(b).test(base))) {
            out.push({ name, hasPullRequest: true, wouldRun: false, why: 'branches filter excludes base ' + base });
            continue;
        }
        const only = listUnder(block, 'paths');
        const ignore = listUnder(block, 'paths-ignore');
        let wouldRun, why;
        if (only) {
            const hit = files.find((f) => only.some((g) => globToRe(g).test(f)));
            wouldRun = !!hit; why = hit ? hit + ' matches paths' : 'no changed file matches paths';
        } else if (ignore) {
            const miss = files.find((f) => !ignore.some((g) => globToRe(g).test(f)));
            wouldRun = !!miss; why = miss ? miss + ' is not under paths-ignore' : 'every changed file is under paths-ignore';
        } else { wouldRun = true; why = 'no path filter'; }
        out.push({ name, hasPullRequest: true, wouldRun, why });
    }
    return { workflows: out, anyDue: out.some((w) => w.wouldRun === true), population: out.length };
}

module.exports = { explainEmptyRollup, globToRe, listUnder, pullRequestBlock };

if (require.main === module) {
    const [cwd, trunk, base, ...files] = process.argv.slice(2);
    if (!cwd || !trunk || !files.length) {
        console.log('pr-path-filters.js <repo> <trunk> <base-branch> <file>...'); process.exit(0);
    }
    const r = explainEmptyRollup(cwd, trunk, files, base === '-' ? undefined : base);
    for (const w of r.workflows) console.log('  ' + w.name.padEnd(28) + (w.wouldRun ? 'WOULD RUN  ' : 'would not  ') + w.why);
    console.log(r.anyDue ? 'a run was due and none exists' : 'every workflow excluded these files; zero runs is the filter working');
    process.exit(r.anyDue ? 2 : 0);
}
