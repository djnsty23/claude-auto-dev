#!/usr/bin/env node
'use strict';
// test-config-dir-isolation.js: a second Claude profile (CLAUDE_CONFIG_DIR set
// to a directory other than ~/.claude) must never read or write the default
// profile's state, and the default profile must behave as it always did.
//
// Every hook is driven as a SUBPROCESS with HOME and USERPROFILE at a fake
// home and CLAUDE_CONFIG_DIR at a second temp dir. The fake home is seeded as
// an ARMED default profile: a brain-role.json naming a coordinator, an
// artifact schema, and a claude-memory/fleet-intent directory that opts the
// fleet hooks in. A hook that still resolves `<home>/.claude` or
// `<home>/claude-memory` under the work profile either writes there (caught by
// a content snapshot of the whole fake home) or acts on the armed state
// (caught by its output).
//
// EVERY CASE CARRIES ITS OWN CONTROL. The same payload is run again with
// CLAUDE_CONFIG_DIR unset, and must reach the default profile: write the file
// there, block, or speak. Without that, "the fake home did not change" would
// also pass for a hook that never reached its state path at all, or for a
// fixture that no longer arms anything.
//
// Every env override (AUTODEV_*) and every inherited CLAUDE_* variable is
// scrubbed from the child env, so the suite answers the same question when it
// runs inside a session that is itself under a second profile.
//
// Run: node tooling/test-config-dir-isolation.js

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'plugins', 'autodev-core');
const MEM = path.join(ROOT, 'plugins', 'autodev-memory');
const hook = (plugin, name) => path.join(plugin, 'hooks', name);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfgdir-iso-')));
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work-profile');
const DEFAULT_CFG = path.join(HOME, '.claude');
const SCRATCH = path.join(TMP, 'scratch');
for (const d of [HOME, WORK, SCRATCH]) fs.mkdirSync(d, { recursive: true });

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

// ── the armed default profile ─────────────────────────────────────────────────
const COORD_SESSION = 'SESSION-A';
const HARNESS = path.join(TMP, 'harness');           // the coordinator's home repo; never created
const ARTIFACT_ID = 'ART_ISO_1';
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); }
writeJson(path.join(DEFAULT_CFG, 'brain-role.json'), { session_id: COORD_SESSION, peer_name: 'coord', home_repos: [HARNESS] });
writeJson(path.join(DEFAULT_CFG, 'autodev', 'artifact-schemas', ARTIFACT_ID + '.json'), {
    collections: { tasks: { fields: { status: { type: 'string', enum: ['todo', 'done'] } } } },
});
fs.mkdirSync(path.join(HOME, 'claude-memory', 'fleet-intent'), { recursive: true });

// ── child env ─────────────────────────────────────────────────────────────────
/** profile: 'work' (CLAUDE_CONFIG_DIR=WORK), 'default' (unset), 'named-default' (=<home>/.claude). */
function envFor(profile, extra) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(AUTODEV_|CLAUDE_|AI_AGENT$|HOME$|USERPROFILE$)/i.test(k)) continue;
        env[k] = v;
    }
    env.HOME = HOME;
    env.USERPROFILE = HOME;
    // Pinned so the coordinator guard answers as an attended session would.
    env.AI_AGENT = 'claude-code_suite_agent';
    env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    // Keep the desktop session store out of it: liveness checks read null, not this machine.
    env.CLAUDE_SESSION_STORE = path.join(TMP, 'no-such-store');
    if (profile === 'work') env.CLAUDE_CONFIG_DIR = WORK;
    if (profile === 'named-default') env.CLAUDE_CONFIG_DIR = DEFAULT_CFG;
    return Object.assign(env, extra || {});
}

function run(hookPath, payload, profile, extra) {
    const r = spawnSync(process.execPath, [hookPath], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env: envFor(profile, extra),
        timeout: 60000,
    });
    return { status: r.status, out: r.stdout || '', err: r.stderr || '', error: r.error ? String(r.error.code || r.error) : null };
}
const said = (r) => `exit ${r.status}, stdout ${r.out.length}B, stderr ${r.err.length}B${r.error ? ', ' + r.error : ''}${r.err ? ' ' + JSON.stringify(r.err.slice(0, 120)) : ''}`;
const silentOk = (r) => r.status === 0 && r.out === '' && r.err === '';

// ── the fake home, by content ─────────────────────────────────────────────────
function snapshot(dir) {
    const m = new Map();
    (function walk(d, rel) {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const abs = path.join(d, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { m.set(r + '/', 'dir'); walk(abs, r); }
            else {
                let h = 'unreadable';
                try { h = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch { /* recorded as unreadable */ }
                m.set(r, h);
            }
        }
    })(dir, '');
    return m;
}
function changes(before, after) {
    const out = [];
    for (const [k, v] of after) if (before.get(k) !== v) out.push((before.has(k) ? 'modified ' : 'created ') + k);
    for (const k of before.keys()) if (!after.has(k)) out.push('deleted ' + k);
    return out;
}
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

/**
 * One isolation case. `work` runs the hook under the work profile and returns
 * its result; the fake home must not change. `control` runs it again under the
 * default profile and returns true when the hook reached that profile.
 */
function isolationCase(name, { work, workOk, control }) {
    const before = snapshot(HOME);
    const r = work();
    const touched = changes(before, snapshot(HOME));
    check(`${name}: work profile leaves the default profile's files untouched`, touched.length === 0,
        touched.length ? touched.slice(0, 4).join('; ') : `${before.size} entries unchanged`);
    const w = workOk(r);
    check(`${name}: work profile behaves as its own profile`, w.ok, w.detail);
    const c = control();
    check(`${name}: control, CLAUDE_CONFIG_DIR unset reaches the default profile`, c.ok, c.detail);
}

// ── git fixtures (outside the fake home) ──────────────────────────────────────
const GITCFG = ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false'];
function git(cwd, args) { return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, env: envFor('default') }); }
function makeRepoOnBranch() {
    const root = fs.mkdtempSync(path.join(TMP, 'repo-'));
    const bare = path.join(root, 'origin.git');
    const main = path.join(root, 'myrepo');
    git(root, ['init', '--bare', '-b', 'main', bare]);
    git(root, ['init', '-b', 'main', main]);
    fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
    git(main, ['add', 'a.txt']);
    git(main, [...GITCFG, 'commit', '-m', 'one']);
    git(main, ['remote', 'add', 'origin', bare]);
    git(main, ['push', '-u', 'origin', 'main']);
    git(main, ['remote', 'set-head', 'origin', 'main']);
    const wt = path.join(root, 'wt');
    git(main, ['worktree', 'add', '-b', 'claude/feature', wt]);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    git(wt, ['add', 'b.txt']);
    git(wt, [...GITCFG, 'commit', '-m', 'two']);
    return wt;
}

try {
    // ── 1. the two copies of the resolver agree, and name the right dirs ────────
    {
        const core = require(path.join(CORE, 'scripts', 'claude-paths.js'));
        const mem = require(path.join(MEM, 'scripts', 'config-dir.js'));
        const h = HOME;
        const envs = [
            { HOME: h, USERPROFILE: h },
            { HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: '' },
            { HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: WORK },
            { HOME: h },
            { USERPROFILE: h },
        ];
        const pairs = envs.map((e) => [core.configDir(e), mem.configDir(e)]);
        check('autodev-memory\'s copy answers exactly as claude-paths.js does', pairs.every(([a, b]) => a === b),
            JSON.stringify(pairs.map(([a, b]) => a === b)));
        check('unset or empty CLAUDE_CONFIG_DIR means <home>/.claude',
            core.configDir(envs[0]) === DEFAULT_CFG && core.configDir(envs[1]) === DEFAULT_CFG && core.configDir(envs[3]) === DEFAULT_CFG,
            JSON.stringify([core.configDir(envs[0]), core.configDir(envs[1])]));
        check('a set CLAUDE_CONFIG_DIR is the config dir', core.configDir(envs[2]) === WORK, core.configDir(envs[2]));
        const named = { HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: DEFAULT_CFG + path.sep };
        check('isDefaultConfigDir: unset, empty and <home>/.claude/ (trailing separator) are the default profile',
            core.isDefaultConfigDir(envs[0]) && core.isDefaultConfigDir(envs[1]) && core.isDefaultConfigDir(named));
        check('isDefaultConfigDir: another directory is not', core.isDefaultConfigDir(envs[2]) === false);
        if (process.platform === 'win32') {
            check('isDefaultConfigDir: case differences do not make a second profile on win32',
                core.isDefaultConfigDir({ HOME: h, USERPROFILE: h, CLAUDE_CONFIG_DIR: DEFAULT_CFG.toUpperCase() }));
        }
        check('fleetMemoryDir: the default profile keeps ~/claude-memory',
            core.fleetMemoryDir(envs[0]) === path.join(h, 'claude-memory') && core.fleetMemoryDir(named) === path.join(h, 'claude-memory'),
            core.fleetMemoryDir(envs[0]));
        check('fleetMemoryDir: a second profile never falls back to ~/claude-memory',
            core.fleetMemoryDir(envs[2]) === path.join(WORK, 'claude-memory'), core.fleetMemoryDir(envs[2]));
    }

    // ── 2. write leaks: per-profile state files ────────────────────────────────
    {
        const tx = path.join(SCRATCH, 'tx.jsonl');
        const depth = 402578;
        fs.writeFileSync(tx, [
            JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
            JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }],
                usage: { input_tokens: 32, cache_creation_input_tokens: 814, cache_read_input_tokens: depth - 846, output_tokens: 12 } } }),
        ].join('\n') + '\n');
        const payload = { session_id: 's-cdn', transcript_path: tx };
        // One state file per session since #285, under <config dir>/autodev/context-nudge.
        const nudgeState = (cfg) => path.join(cfg, 'autodev', 'context-nudge', 's-cdn.json');
        isolationCase('context-depth-nudge state', {
            work: () => run(hook(CORE, 'context-depth-nudge.js'), payload, 'work'),
            workOk: (r) => ({ ok: r.status === 0 && exists(nudgeState(WORK)), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'context-depth-nudge.js'), payload, 'default');
                return { ok: exists(nudgeState(DEFAULT_CFG)), detail: said(r) }; },
        });
    }
    {
        const target = 'local_ISO_TARGET';
        const payload = { hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_session_mgmt__send_message', tool_use_id: 'toolu_iso',
            tool_input: { session_id: target, message: 'status check, please rebase and re-run the gate' },
            tool_response: 'Message queued for session ' + target + ' ("t"): a turn is in progress there. (delivery: queued; message_id: MSG_ISO_1)' };
        isolationCase('peer-send-ledger', {
            work: () => run(hook(CORE, 'peer-send-ledger.js'), payload, 'work'),
            workOk: (r) => ({ ok: silentOk(r) && exists(path.join(WORK, 'autodev', 'peer-sends.jsonl')), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'peer-send-ledger.js'), payload, 'default');
                return { ok: exists(path.join(DEFAULT_CFG, 'autodev', 'peer-sends.jsonl')), detail: said(r) }; },
        });
    }
    {
        const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const payload = { session_id: id, cwd: SCRATCH, hook_event_name: 'SessionStart', transcript_path: path.join(SCRATCH, id + '.jsonl') };
        isolationCase('session-register fleet record', {
            work: () => run(hook(CORE, 'session-register.js'), payload, 'work'),
            workOk: (r) => ({ ok: silentOk(r) && exists(path.join(WORK, 'fleet', 'sessions', id + '.json')), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'session-register.js'), payload, 'default');
                return { ok: exists(path.join(DEFAULT_CFG, 'fleet', 'sessions', id + '.json')), detail: said(r) }; },
        });
    }
    {
        const id = 'ffffffff-1111-4222-8333-444444444444';
        const cwd = fs.mkdtempSync(path.join(TMP, 'noprd-'));
        const payload = { session_id: id, cwd, hook_event_name: 'Stop' };
        isolationCase('stop-auto-check heartbeat', {
            work: () => run(hook(CORE, 'stop-auto-check.js'), payload, 'work'),
            workOk: (r) => ({ ok: r.status === 0 && exists(path.join(WORK, 'fleet', id + '.json')), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'stop-auto-check.js'), payload, 'default');
                return { ok: exists(path.join(DEFAULT_CFG, 'fleet', id + '.json')), detail: said(r) }; },
        });
    }
    {
        const rule = path.join(SCRATCH, 'rule.md');
        fs.writeFileSync(rule, '# a rule\n');
        const payload = { file_path: rule, hook_event_name: 'InstructionsLoaded' };
        isolationCase('instructions-loaded log', {
            work: () => run(hook(CORE, 'instructions-loaded.js'), payload, 'work'),
            workOk: (r) => ({ ok: silentOk(r) && exists(path.join(WORK, 'logs', 'instructions-loaded.jsonl')), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'instructions-loaded.js'), payload, 'default');
                return { ok: exists(path.join(DEFAULT_CFG, 'logs', 'instructions-loaded.jsonl')), detail: said(r) }; },
        });
    }
    {
        const cwd = fs.mkdtempSync(path.join(TMP, 'memproj-'));
        const payload = { session_id: 'mem-iso-1', cwd, hook_event_name: 'SessionStart' };
        isolationCase('autodev-memory database', {
            work: () => run(hook(MEM, 'memory-session-start.js'), payload, 'work'),
            workOk: (r) => ({ ok: r.status === 0 && exists(path.join(WORK, 'auto-dev-memory.db')), detail: said(r) }),
            control: () => { const r = run(hook(MEM, 'memory-session-start.js'), payload, 'default');
                return { ok: exists(path.join(DEFAULT_CFG, 'auto-dev-memory.db')), detail: said(r) }; },
        });
    }

    // ── 3. read leaks: the armed default profile must not arm the work profile ──
    {
        const repo = makeRepoOnBranch();
        const payload = { session_id: 'WORKER-1', cwd: repo, hook_event_name: 'Stop' };
        isolationCase('stop-brain-report (default profile\'s brain-role.json)', {
            work: () => run(hook(CORE, 'stop-brain-report.js'), payload, 'work'),
            workOk: (r) => ({ ok: silentOk(r) && !exists(path.join(WORK, 'brain-report-state.json')), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'stop-brain-report.js'), payload, 'default');
                return { ok: exists(path.join(DEFAULT_CFG, 'brain-report-state.json')), detail: said(r) }; },
        });

        const intent = { session_id: 'WORKER-2', cwd: repo, hook_event_name: 'Stop' };
        const noCooldown = { AUTODEV_INTENT_COOLDOWN_MIN: '0' };
        isolationCase('stop-intent-record (default profile\'s ~/claude-memory/fleet-intent)', {
            work: () => run(hook(CORE, 'stop-intent-record.js'), intent, 'work', noCooldown),
            workOk: (r) => ({ ok: silentOk(r) && !exists(path.join(WORK, 'intent-nudge-state.json')), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'stop-intent-record.js'), intent, 'default', noCooldown);
                return { ok: r.status === 0 && r.out.length > 0 && exists(path.join(DEFAULT_CFG, 'intent-nudge-state.json')), detail: said(r) }; },
        });
        // CLAUDE_CONFIG_DIR naming <home>/.claude IS the default profile, so the
        // fleet stays armed: the second profile's rule must not catch the first.
        const named = run(hook(CORE, 'stop-intent-record.js'), intent, 'named-default', noCooldown);
        check('stop-intent-record: CLAUDE_CONFIG_DIR=<home>/.claude still reads ~/claude-memory',
            named.status === 0 && named.out.length > 0, said(named));
    }
    {
        const payload = { tool_name: 'Bash', session_id: COORD_SESSION, cwd: path.join(TMP, 'product'), tool_input: { command: 'git commit -m "x"' } };
        isolationCase('coordinator-write-guard (default profile\'s brain-role.json)', {
            work: () => run(hook(CORE, 'coordinator-write-guard.js'), payload, 'work'),
            workOk: (r) => ({ ok: silentOk(r), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'coordinator-write-guard.js'), payload, 'default');
                return { ok: r.status === 2 && /^Blocked:/.test(r.err), detail: said(r) }; },
        });
    }
    {
        const payload = { tool_name: 'ArtifactData', tool_input: { action: 'set', url: 'https://example.invalid/artifacts/' + ARTIFACT_ID,
            collection: 'tasks', doc_id: 't1', data: { status: 'nonsense' } } };
        const denied = (r) => { try { return JSON.parse(r.out).hookSpecificOutput.permissionDecision === 'deny'; } catch { return false; } };
        isolationCase('artifact-write-guard (default profile\'s artifact schemas)', {
            work: () => run(hook(CORE, 'artifact-write-guard.js'), payload, 'work'),
            workOk: (r) => ({ ok: silentOk(r), detail: said(r) }),
            control: () => { const r = run(hook(CORE, 'artifact-write-guard.js'), payload, 'default');
                return { ok: r.status === 0 && denied(r), detail: said(r) }; },
        });
    }
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nconfig-dir isolation: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
