#!/usr/bin/env node
// Stop hook — typecheck and lint ONCE per response, over the files it edited.
//
// hooks/post-tool-typecheck.js appends every edited JS/TS path to
// .claude/.typecheck-pending. This hook consumes that list at Stop, runs the
// project's `typecheck` script and its linter once, and when either fails
// answers `decision: block` with the errors as the reason, so the model fixes
// them before the turn ends. Ported from ECC's stop-format-typecheck on
// 2026-09-07 with two differences recorded in
// docs/evidence-ecc-comparison-2026-09-07.md: ECC writes its findings to
// stderr, which a Stop hook's exit 0 never puts in front of the model, and ECC
// also reformats the files, which this repo's hooks do not do to a user's tree.
//
// ONE RETRY, NEVER A LOOP. The block makes the model continue; its next Stop
// arrives with `stop_hook_active: true`. If the check still fails then, this
// hook reports to the operator as a `systemMessage` (no decision key, so it
// cannot hold the turn) and lets the stop through. A type error the model
// cannot fix in one attempt is the operator's to see, not a reason to spin.
//
// Every quiet path is zero bytes on both streams: no pending list, no
// package.json, no scripts, or a green run. Always exits 0.
//
// The `typecheck` switch (plugin userConfig, reaching hooks as
// CLAUDE_PLUGIN_OPTION_TYPECHECK="false") skips this hook: it advises, it never
// guards. tooling/test-hooks-profile.js holds the list of hooks that may.
if (process.env.CLAUDE_PLUGIN_OPTION_TYPECHECK === 'false') process.exit(0);

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Lines of tool output carried into the reason. Typecheck output is the whole
// point of the block, so it gets the larger budget; a linter that fails with
// 400 lines is context the model pays for and mostly cannot use.
const TYPECHECK_LINES = 80;
const LINT_LINES = 30;

function trimmed(output, limit) {
    const lines = output.trim().split('\n');
    if (lines.length <= limit) return lines.join('\n');
    return lines.slice(0, limit).join('\n') + `\n... and ${lines.length - limit} more lines`;
}

// 25 s each, so typecheck and lint back to back fit one 60 s hook budget.
const RUN_TIMEOUT_MS = 25000;

/**
 * Run a check quietly. Returns null when it passed, otherwise
 * `{ timedOut, out }`.
 *
 * A TIMEOUT IS NOT A FAILURE, and conflating the two produced a false red that
 * fired on the first edit of a session and passed on every edit after.
 *
 * execSync SIGTERMs the child when the budget runs out and then throws with
 * whatever was buffered. For `npm run <script>` that buffer is the two banner
 * lines npm prints before the tool underneath has produced anything:
 *
 *     > proj@0.1.0 lint
 *     > eslint
 *
 * The previous version returned that banner, and both callers treated any
 * non-empty string as a failure. So the hook blocked with
 * `[LINT FAILED] Fix these before finishing:` above output containing no error.
 *
 * Measured 2026-09-20 in a Next app: COLD eslint over the tree exceeded 25 s,
 * warm took 13 s. Cold is exactly the state of the first edit of a session, so
 * the bug reads as flakiness rather than as a bug.
 *
 * `e.status` is null and `e.signal` is 'SIGTERM' on a timeout kill, so status
 * alone cannot separate the two cases. Check killed/signal first.
 */
function runQuiet(cmd) {
    try {
        execSync(cmd, {
            timeout: RUN_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],
            // execSync routes through cmd.exe on Windows and would flash a console
            // window under the desktop app without this (reported 2026-08-17).
            windowsHide: true,
        });
        return null;
    } catch (e) {
        if (e.killed || e.signal || e.code === 'ETIMEDOUT') return { timedOut: true, out: '' };
        const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
        return {
            timedOut: false,
            out: out.trim() ? out : `(exit ${e.status === undefined ? 'unknown' : e.status}, no output)`,
        };
    }
}

try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch { data = {}; }

    const pending = path.join(process.cwd(), '.claude', '.typecheck-pending');
    let raw;
    try { raw = fs.readFileSync(pending, 'utf8'); } catch { process.exit(0); }
    // Consumed on read, whatever happens next: a list that survives a failed
    // run would re-run the same check on a Stop that edited nothing.
    try { fs.unlinkSync(pending); } catch { /* best effort */ }

    const files = [...new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))];
    if (files.length === 0) process.exit(0);
    if (!fs.existsSync('package.json')) process.exit(0);

    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) || {}; } catch { pkg = {}; }
    const scripts = pkg.scripts || {};
    const pm = fs.existsSync('pnpm-lock.yaml') ? 'pnpm' :
               fs.existsSync('yarn.lock') ? 'yarn' :
               fs.existsSync('bun.lockb') ? 'bun' : 'npm';

    const findings = [];
    // A check that ran out of budget is INCONCLUSIVE, not passing and not
    // failing. It never blocks, because blocking on it is the bug above, and it
    // is never silent either, because a check nobody ran must not read as green.
    const skipped = [];
    if (scripts.typecheck) {
        const r = runQuiet(`${pm} run typecheck`);
        if (r && r.timedOut) skipped.push('typecheck');
        else if (r) findings.push('[TYPECHECK FAILED] Fix these errors before finishing:\n' + trimmed(r.out, TYPECHECK_LINES));
    }

    // Biome preferred, ESLint fallback, nothing when neither is configured:
    // zero config, zero noise.
    const hasBiome = fs.existsSync('biome.json') || fs.existsSync('biome.jsonc');
    const hasEslint = ['.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs']
        .some((f) => fs.existsSync(f));
    let lintCmd = null;
    if (scripts.lint) lintCmd = `${pm} run lint`;
    else if (hasBiome) lintCmd = 'npx biome check .';
    else if (hasEslint) lintCmd = `${pm} run lint || npx eslint .`;
    if (lintCmd) {
        const r = runQuiet(lintCmd);
        if (r && r.timedOut) skipped.push('lint');
        else if (r) findings.push('[LINT FAILED] Fix these before finishing:\n' + trimmed(r.out, LINT_LINES));
    }

    if (findings.length === 0) {
        if (skipped.length) {
            console.log(JSON.stringify({
                systemMessage:
                    `[Typecheck] ${skipped.join(' and ')} did not finish within ` +
                    `${RUN_TIMEOUT_MS / 1000}s and was not checked. Run it yourself before claiming green.`,
            }));
        }
        process.exit(0);
    }

    const edited = `${files.length} file(s) edited this response: ${files.map((f) => path.basename(f)).join(', ')}`;
    const reason = findings.join('\n\n') + '\n\n' + edited;
    if (data.stop_hook_active) {
        const first = findings.map((f) => f.split('\n')[0]).join(' · ');
        console.log(JSON.stringify({
            systemMessage: `[Typecheck] still failing after the retry, not blocking again: ${first}`,
        }));
        process.exit(0);
    }
    console.log(JSON.stringify({ decision: 'block', reason }));
} catch (err) {
    process.stderr.write(`stop-typecheck error: ${err.message}\n`);
}
process.exit(0);
