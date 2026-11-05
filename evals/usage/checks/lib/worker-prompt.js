'use strict';
// The prompt a headless worker would follow, composed by the REAL
// unattended-worker.js of the tree under test: enqueue a paraphrased brief in a
// scratch HOME, then `launch --dry-run`, which writes PROMPT.md and starts
// nothing. Shared by the cases that grade what that prompt tells a worker to do.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

/**
 * Calls fn({ prompt, home, scratch }) with the composed prompt, and cleans the
 * scratch dir after. Returns fn's verdict, or an indeterminate one when setup fails.
 */
function withWorkerPrompt(repo, fn) {
    const subject = path.join(repo, 'plugins', 'autodev-core', 'scripts', 'unattended-worker.js');
    if (!fs.existsSync(subject)) return { pass: false, indeterminate: true, detail: `no unattended-worker.js under ${repo}` };
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-eval-worker-')));
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0', AUTODEV_CAPACITY: 'off',
        AUTODEV_WORKER_OUTBOX: path.join(scratch, 'outbox'), AUTODEV_LEDGER_LOCK_WAIT_MS: '300' };
    delete env.CLAUDE_CONFIG_DIR;
    const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...a], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        const origin = path.join(scratch, 'origin.git');
        const work = path.join(scratch, 'repo');
        g(scratch, 'init', '-q', '--bare', origin);
        g(scratch, 'init', '-q', work);
        fs.writeFileSync(path.join(work, 'README.md'), 'x\n');
        g(work, 'add', 'README.md');
        g(work, 'commit', '-q', '-m', 'init');
        g(work, 'branch', '-M', 'main');
        g(work, 'remote', 'add', 'origin', origin);
        g(work, 'push', '-q', 'origin', 'main');
        g(work, 'fetch', '-q', 'origin');
        // A paraphrase of the 2026-11-05 smoke brief: trivial work, one runnable criterion.
        const brief = path.join(scratch, 'brief.md');
        fs.writeFileSync(brief, 'Record the node version in your report. Change no file.\n\n## Acceptance criteria\n- AC1: the report names the node version\n  check: node -e "process.exit(0)"\n');
        const ledger = path.join(scratch, 'ledger.json');
        const fake = path.join(scratch, 'fake-claude.js');
        fs.writeFileSync(fake, 'process.exit(0)\n');
        const cli = (args) => spawnSync(process.execPath, [subject, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
        const q = cli(['enqueue', '--slug', 'smoke-a', '--repo', work, '--brief-file', brief, '--return', 'coordinator', '--ledger', ledger]);
        let rec = null;
        try { rec = JSON.parse(q.stdout).value.record; } catch { /* reported below */ }
        if (q.status !== 0 || !rec) return { pass: false, indeterminate: true, detail: `enqueue failed: ${(q.stdout + q.stderr).slice(0, 300)}` };
        const l = cli(['launch', '--task-id', rec.taskId, '--dry-run', '--dev', '--claude-bin', fake, '--ledger', ledger]);
        const promptFile = path.join(path.dirname(rec.report), 'PROMPT.md');
        if (!fs.existsSync(promptFile)) return { pass: false, indeterminate: true, detail: `launch wrote no PROMPT.md (exit ${l.status}): ${(l.stdout + l.stderr).slice(0, 300)}` };
        return fn({ prompt: fs.readFileSync(promptFile, 'utf8'), home, scratch });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

module.exports = { withWorkerPrompt };
