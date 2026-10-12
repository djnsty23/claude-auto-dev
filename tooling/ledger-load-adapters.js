'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CORE = 'plugins/autodev-core/';
const keyed = require('../plugins/autodev-core/scripts/keyed-ledger.js');
const files = new Set([
    'hooks/peer-send-ledger.js', 'hooks/stop-brain-report.js', 'hooks/stop-intent-record.js',
    'hooks/stop-workflow-wall-note.js', 'scripts/headless-worker.js', 'scripts/keyed-ledger.js',
    'scripts/production-signals.js', 'scripts/radar-learning.js', 'scripts/unattended-worker.js',
    'scripts/watch-panels.js',
].map((f) => CORE + f).concat('tooling/frontier/run.js'));
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ids = (count) => Array.from({ length: count }, (_, i) => String(i));

function git(cwd, argv) {
    return cp.execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim();
}

function prepare(writer, cwd, count) {
    const file = path.join(cwd, 'ledger.json');
    const fixture = { writer, cwd: fs.realpathSync(cwd), file, count, repos: [], keys: [], transcripts: [] };
    json(file, {});
    const name = path.basename(writer);
    if (name === 'unattended-worker.js') json(file, { version: 1, records: ids(count).map((id) => ({ taskId: id, state: 'queued' })) });
    if (name === 'headless-worker.js') {
        const log = path.join(cwd, 'worker.log');
        fs.writeFileSync(log, 'CLAUDE_EXIT=0\n');
        json(file, { version: 1, records: ids(count).map((id) => {
            const report = path.join(cwd, `report-${id}.md`);
            fs.writeFileSync(report, `RESULT Probe${id} done: fixture\n`);
            return { code: 'Probe' + id, state: 'running', startedAt: new Date(Date.now() - 60000).toISOString(), log, report };
        }) });
    }
    if (name === 'peer-send-ledger.js') {
        // Cross the pruning threshold so the shared rewrite is actually reached.
        const row = JSON.stringify({ at: '2000-01-01T00:00:00Z', probe: 'x'.repeat(2048) }) + '\n';
        fs.writeFileSync(file, row.repeat(600));
    }
    if (name === 'stop-brain-report.js') json(path.join(cwd, 'role.json'), { session_id: 'coordinator' });
    if (name === 'stop-workflow-wall-note.js') {
        const { makeRun } = require('./fixtures/workflow-runs.js');
        for (const id of ids(count)) {
            const f = makeRun(cwd, { sessionId: 's' + id, runId: 'wf_aaaa0000-001', agents: [
                { id: 'a1000000000000001', journaled: true, secs: 1, tools: 1 },
            ] });
            fixture.transcripts.push(f.transcriptPath);
            fixture.keys.push('s' + id + ':wf_aaaa0000-001');
        }
    }
    if (name === 'stop-intent-record.js') {
        const intent = require('../plugins/autodev-core/scripts/fleet-intent.js');
        const records = path.join(cwd, 'records');
        const head = git(ROOT, ['rev-parse', 'HEAD']);
        fs.mkdirSync(records);
        for (const id of ids(count)) {
            const repo = path.join(cwd, 'repo' + id);
            git(cwd, ['clone', '--shared', '--no-checkout', '-q', ROOT, repo]);
            git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/probe']);
            // A clone has no origin/HEAD when ROOT has no local branches, which is how
            // actions/checkout leaves a pull request. ROOT's own HEAD always resolves.
            git(repo, ['update-ref', 'refs/heads/probe', head]);
            json(intent.recordPath('repo' + id, 'probe', records), { branch: 'collision-control' });
            fixture.repos.push(repo);
            fixture.keys.push(intent.keyFor('repo' + id, 'probe'));
        }
    }
    if (name === 'radar-learning.js') json(path.join(cwd, 'learning-ledger.json'), {
        lifecycle: Object.fromEntries(ids(count).map((id) => [id, { status: 'candidate', history: [] }])),
    });
    if (name === 'production-signals.js') {
        json(path.join(cwd, 'config.json'), { sources: [{ id: 'probe', kind: 'sentry-issues' }] });
        json(path.join(cwd, 'probe.json'), []);
    }
    if (name === 'watch-panels.js') json(path.join(cwd, 'watch-panels-seen.json'), []);
    return fixture;
}

function cli(f, argv = [], env = {}, input) {
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, f.writer), ...argv], {
        cwd: f.cwd, env: { ...process.env, ...env }, input, encoding: 'utf8', windowsHide: true,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error || r.status !== 0) throw Object.assign(
        new Error(`writer exit=${r.status}: ${r.error ? r.error.message : r.stdout + r.stderr}`), { writerExit: r.status });
}

async function write(f, id) {
    const name = path.basename(f.writer);
    if (name === 'keyed-ledger.js') {
        if (!keyed.write(f.file, id, { id })) throw new Error('keyed write returned false');
    } else if (name === 'unattended-worker.js') {
        cli(f, ['retire', '--ledger', f.file, '--task-id', id, '--reason', id]);
    } else if (name === 'headless-worker.js') {
        cli(f, ['settle', '--ledger', f.file, '--code', 'Probe' + id]);
    } else if (name === 'peer-send-ledger.js') {
        cli(f, [], { AUTODEV_PEER_LEDGER: f.file }, JSON.stringify({
            tool_name: 'mcp__ccd_session_mgmt__send_message', tool_input: { session_id: 'target', message: 'fixture' },
            tool_response: `(delivery: queued; message_id: ${id})`,
        }));
    } else if (name === 'stop-brain-report.js') {
        cli(f, [], { AUTODEV_BRAIN_ROLE_FILE: path.join(f.cwd, 'role.json'), AUTODEV_BRAIN_REPORT_STATE: f.file },
            JSON.stringify({ session_id: id, cwd: ROOT }));
    } else if (name === 'stop-intent-record.js') {
        cli(f, [], { AUTODEV_FLEET_INTENT_DIR: path.join(f.cwd, 'records'), AUTODEV_INTENT_NUDGE_STATE: f.file },
            JSON.stringify({ session_id: id, cwd: f.repos[Number(id)] }));
    } else if (name === 'stop-workflow-wall-note.js') {
        cli(f, [], { AUTODEV_WORKFLOW_WALL_STATE: f.file, AUTODEV_WORKFLOW_WALL: '' },
            JSON.stringify({ session_id: 's' + id, transcript_path: f.transcripts[Number(id)] }));
    } else if (name === 'radar-learning.js') {
        cli(f, ['--state-dir', f.cwd, '--transition', id, '--to', 'shadow', '--evidence', 'fixture']);
    } else if (name === 'production-signals.js') {
        cli(f, ['--config', path.join(f.cwd, 'config.json'), '--fixture-dir', f.cwd, '--ledger', f.file,
            '--now', new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id))).toISOString()]);
    } else if (name === 'watch-panels.js') {
        // Only the fleet data source is substituted. The real scan and persistence run.
        process.env.AUTODEV_FLEET_DIR = f.cwd;
        const original = cp.execFileSync;
        cp.execFileSync = () => JSON.stringify([{ sessionId: id, state: 'blocked', pending: { askedAt: 'now' } }]);
        try {
            if (!require(path.join(ROOT, f.writer)).scan()) throw new Error('watch scan failed');
        } finally { cp.execFileSync = original; }
    } else if (f.writer === 'tooling/frontier/run.js') {
        // Missing tasks exercise the real error-record write without launching a worker.
        cli(f, ['plant', '--task', id, '--src', ROOT, '--tasks-dir', f.cwd, '--data', f.cwd, '--work', f.cwd]);
    } else throw new Error('unexercised writer: ' + f.writer);
}

function read(f) {
    const name = path.basename(f.writer);
    if (name === 'keyed-ledger.js' || name.startsWith('stop-')) {
        const all = keyed.readAll(f.file);
        return ids(f.count).filter((id) => all[f.keys[Number(id)] || id]);
    }
    if (name === 'unattended-worker.js') return readJson(f.file).records.filter((r) => r.state === 'retired').map((r) => r.taskId);
    if (name === 'headless-worker.js') return readJson(f.file).records.filter((r) => r.state === 'settled').map((r) => r.code.slice(5));
    if (name === 'peer-send-ledger.js') return fs.readFileSync(f.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).messageId).filter(Boolean);
    if (name === 'radar-learning.js') return Object.entries(readJson(path.join(f.cwd, 'learning-ledger.json')).lifecycle).filter(([, e]) => e.status === 'shadow').map(([id]) => id);
    if (name === 'production-signals.js') return readJson(f.file).runs.map((r) => String(new Date(r.at).getUTCSeconds()));
    if (name === 'watch-panels.js') return readJson(path.join(f.cwd, 'watch-panels-seen.json')).map((key) => key.split('|')[0]);
    if (f.writer === 'tooling/frontier/run.js') return Object.keys(readJson(path.join(f.cwd, 'plant.json')).tasks);
    throw new Error('no readback for ' + f.writer);
}
module.exports = { supports: (file) => files.has(file), prepare, write, read };
