#!/usr/bin/env node
'use strict';
/**
 * role-chain.js - run one story through standing role sessions:
 * PM -> Spec -> Eng -> QA -> Copy, each handing the next a typed file.
 *
 * WHY. One worker per story does spec, code, check and copy in a single
 * context, so nothing reviews the spec before code exists and nothing checks
 * the code except the session that wrote it. A chain splits those jobs over
 * sessions with their own model, skills and worktree, and makes every handover
 * a file another role can read, so a rework names what was wrong. The design
 * is docs/role-chain.md.
 *
 * WHAT IT OWNS. The MCP calls (start_session, SendMessage) stay with the
 * coordinator, because a Node script cannot make them. This script owns the
 * state those calls need and get wrong by hand:
 *
 *   start <run> --story <id> --repo <path> [--prd <file>] [--base <ref>]
 *         [--ac "<check>|<expect>"]... [--no-memory]
 *       writes <root>/<run>/ with chain.json (the manifest), chain.jsonl (the
 *       event log), briefs/<role>.md for all five roles, and the first
 *       handoff (pm -> spec) built from the story's acceptance. Prints the
 *       start_session arguments per role as JSON.
 *   handoff <run> <from> <to> --file <json> [--no-memory]
 *       validates the handoff (shape, edge, rework cap, role artefacts),
 *       copies it to handoffs/<seq>-<from>-<to>.json, appends to chain.jsonl,
 *       and writes one autodev-memory observation per handoff. A refused
 *       handoff prints each named reason and exits 1, writing nothing.
 *   status [<run>] [--json]
 *       one run: each role's state and its latest artefacts. No run: every
 *       chain under the root, one line each.
 *
 * ROOT. ~/.claude/autodev/chain, or AUTODEV_CHAIN_ROOT.
 * MEMORY. autodev-memory's memory-db.js, found beside this plugin or through
 * AUTODEV_MEMORY_DB. Missing or failing, the handoff still lands and its
 * event says `memory: "unavailable"`: the chain folder is the source of truth.
 *
 * Exit codes: 0 ok, 1 refused (named reasons on stderr), 2 usage error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROLES = ['pm', 'spec', 'eng', 'qa', 'copy'];
const ROLE_INFO = {
    pm: { model: 'claude-opus-5-5', effort: 'high', writes: 'nothing (the Brain seat)', worktree: false },
    spec: { model: 'claude-opus-5-5', effort: 'medium', writes: 'the spec file in the chain folder', worktree: true },
    eng: { model: 'claude-opus-5-5', effort: 'medium', writes: 'code, tests and migrations on its branch', worktree: true },
    qa: { model: 'claude-haiku-5-5', effort: 'xhigh', writes: 'its QA report in the chain folder', worktree: true },
    copy: { model: 'claude-haiku-5-5', effort: 'xhigh', writes: 'only the copy files Eng listed', worktree: true },
};
// Forward edge on `done`, and where a role sends a `rework`.
const NEXT = { pm: 'spec', spec: 'eng', eng: 'qa', qa: 'copy', copy: 'pm' };
const REWORK_TO = { spec: 'pm', eng: 'spec', qa: 'eng', copy: 'eng' };
const STATUSES = ['done', 'rework', 'blocked'];
const ARTEFACT_KINDS = ['spec', 'branch', 'commit', 'report', 'file', 'story'];
const REWORK_CAP = 2;
// What a `done` handoff from each role must carry, by artefact kind.
const REQUIRED_DONE = { pm: ['story'], spec: ['spec'], eng: ['branch', 'commit'], qa: ['report'], copy: ['commit'] };

function chainRoot() {
    return process.env.AUTODEV_CHAIN_ROOT || path.join(os.homedir(), '.claude', 'autodev', 'chain');
}
function runDir(run) { return path.join(chainRoot(), run); }
function validRunName(run) { return typeof run === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(run); }

function parseArgs(argv) {
    const out = { _: [], ac: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--no-memory' || a === '--json' || a === '--help' || a === '-h') { out[a.replace(/^-+/, '')] = true; continue; }
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const val = argv[i + 1];
            if (val === undefined || val.startsWith('--')) { out.error = `${a} needs a value`; continue; }
            i++;
            if (key === 'ac') out.ac.push(val); else out[key] = val;
            continue;
        }
        out._.push(a);
    }
    return out;
}

// Stories live as an object keyed by id, an array, or under sprints[].stories.
function findStory(prd, id) {
    const pools = [];
    if (prd && prd.stories) pools.push(prd.stories);
    if (prd && Array.isArray(prd.sprints)) for (const sp of prd.sprints) if (sp && sp.stories) pools.push(sp.stories);
    for (const pool of pools) {
        if (Array.isArray(pool)) {
            const hit = pool.find((s) => s && s.id === id);
            if (hit) return hit;
        } else if (pool && typeof pool === 'object' && pool[id]) {
            return { id, ...pool[id] };
        }
    }
    return null;
}

// --ac "check|expect" flags win; otherwise the story's acceptance becomes AC1.
function storyCriteria(story, acFlags) {
    if (acFlags.length) {
        return acFlags.map((raw, i) => {
            const cut = raw.indexOf('|');
            return { id: `AC${i + 1}`, check: cut < 0 ? raw : raw.slice(0, cut).trim(), expect: cut < 0 ? '' : raw.slice(cut + 1).trim() };
        });
    }
    const acc = story && story.acceptance;
    if (Array.isArray(acc)) return acc.filter((x) => typeof x === 'string' && x.trim()).map((x, i) => ({ id: `AC${i + 1}`, check: 'story acceptance', expect: x.trim() }));
    if (typeof acc === 'string' && acc.trim()) return [{ id: 'AC1', check: 'story acceptance', expect: acc.trim() }];
    return [];
}

/**
 * Validate a handoff object against the chain's rules. Returns a list of
 * { field, reason } problems; an empty list means it may land. `history` is
 * the chain's earlier handoff events, for the rework cap.
 */
function validateHandoff(h, { run, from, to, history = [], checkFiles = true } = {}) {
    const problems = [];
    const add = (field, reason) => problems.push({ field, reason });
    if (!h || typeof h !== 'object' || Array.isArray(h)) { add('(root)', 'not-an-object'); return problems; }
    if (h.schema !== 1) add('schema', 'schema-must-be-1');
    if (h.run !== run) add('run', `run-mismatch: file says ${JSON.stringify(h.run)}, command says ${JSON.stringify(run)}`);
    if (!ROLES.includes(from)) add('from', `unknown-role: ${from}`);
    if (!ROLES.includes(to)) add('to', `unknown-role: ${to}`);
    if (h.from !== from) add('from', `from-mismatch: file says ${JSON.stringify(h.from)}`);
    if (h.to !== to) add('to', `to-mismatch: file says ${JSON.stringify(h.to)}`);
    if (!STATUSES.includes(h.status)) add('status', `status-must-be-one-of: ${STATUSES.join(', ')}`);
    if (typeof h.summary !== 'string' || !h.summary.trim()) add('summary', 'missing-summary');

    // Acceptance criteria: every handoff carries the criteria its work is judged by.
    if (!Array.isArray(h.acceptanceCriteria) || h.acceptanceCriteria.length === 0) {
        add('acceptanceCriteria', 'missing-acceptance-criteria: a handoff must name at least one AC with check and expect');
    } else {
        const seen = new Set();
        h.acceptanceCriteria.forEach((ac, i) => {
            const at = `acceptanceCriteria[${i}]`;
            if (!ac || typeof ac !== 'object') { add(at, 'not-an-object'); return; }
            if (typeof ac.id !== 'string' || !/^AC\d+$/.test(ac.id)) add(`${at}.id`, 'id-must-match-AC<n>');
            else if (seen.has(ac.id)) add(`${at}.id`, `duplicate-id: ${ac.id}`);
            else seen.add(ac.id);
            if (typeof ac.check !== 'string' || !ac.check.trim()) add(`${at}.check`, 'missing-check');
            if (typeof ac.expect !== 'string' || !ac.expect.trim()) add(`${at}.expect`, 'missing-expect');
        });
    }

    // Artefacts.
    if (!Array.isArray(h.artefacts)) add('artefacts', 'artefacts-must-be-an-array');
    const artefacts = Array.isArray(h.artefacts) ? h.artefacts : [];
    artefacts.forEach((a, i) => {
        const at = `artefacts[${i}]`;
        if (!a || typeof a !== 'object') { add(at, 'not-an-object'); return; }
        if (!ARTEFACT_KINDS.includes(a.kind)) add(`${at}.kind`, `kind-must-be-one-of: ${ARTEFACT_KINDS.join(', ')}`);
        if (typeof a.path !== 'string' || !a.path.trim()) add(`${at}.path`, 'missing-path');
        if (a.kind === 'commit' && !(typeof a.sha === 'string' && /^[0-9a-f]{7,40}$/.test(a.sha))) add(`${at}.sha`, 'commit-needs-sha');
        if (checkFiles && ['spec', 'report', 'file'].includes(a.kind) && typeof a.path === 'string' && a.path.trim()) {
            if (!path.isAbsolute(a.path)) add(`${at}.path`, 'path-must-be-absolute');
            else if (!fs.existsSync(a.path)) add(`${at}.path`, `file-not-found: ${a.path}`);
        }
    });

    // Edge rules.
    if (h.status === 'done') {
        if (NEXT[from] && to !== NEXT[from]) add('to', `wrong-edge: done from ${from} goes to ${NEXT[from]}`);
        for (const kind of REQUIRED_DONE[from] || []) {
            if (!artefacts.some((a) => a && a.kind === kind)) add('artefacts', `missing-artefact: done from ${from} carries a ${kind}`);
        }
    } else if (h.status === 'rework') {
        if (!REWORK_TO[from]) add('status', `no-rework-from: ${from}`);
        else if (to !== REWORK_TO[from]) add('to', `wrong-edge: rework from ${from} goes to ${REWORK_TO[from]}`);
        const reasons = h.rework && Array.isArray(h.rework.reasons) ? h.rework.reasons.filter((r) => typeof r === 'string' && r.trim()) : [];
        if (!reasons.length) add('rework.reasons', 'rework-needs-reasons');
        const used = history.filter((e) => e.status === 'rework' && e.from === from && e.to === to).length;
        if (used >= REWORK_CAP) add('status', `rework-cap: ${used} rounds used on ${from}->${to}, send status blocked to pm`);
    } else if (h.status === 'blocked') {
        if (to !== 'pm') add('to', 'wrong-edge: blocked goes to pm');
        if (typeof h.blocker !== 'string' || !h.blocker.trim()) add('blocker', 'blocked-needs-blocker');
    }

    if (h.memory !== undefined) {
        if (!Array.isArray(h.memory)) add('memory', 'memory-must-be-an-array');
        else h.memory.forEach((m, i) => {
            if (!m || typeof m.title !== 'string' || !m.title.trim()) add(`memory[${i}].title`, 'missing-title');
            if (m && m.type !== undefined && !['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'].includes(m.type)) add(`memory[${i}].type`, 'unknown-memory-type');
        });
    }
    return problems;
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return { type: 'unparseable', line }; }
    });
}
function handoffEvents(run) { return readJsonl(path.join(runDir(run), 'chain.jsonl')).filter((e) => e.type === 'handoff'); }

function loadMemoryDb() {
    const candidates = [
        process.env.AUTODEV_MEMORY_DB,
        path.join(__dirname, '..', '..', 'autodev-memory', 'scripts', 'memory-db.js'),
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return require(c); } catch { /* try the next one */ }
    }
    return null;
}

// One observation per handoff plus any the role asked for. Never throws.
function writeMemory(manifest, h, noMemory) {
    if (noMemory || process.env.AUTODEV_CHAIN_MEMORY === 'off') return 'skipped';
    try {
        const db = loadMemoryDb();
        if (!db || typeof db.saveObservation !== 'function') return 'unavailable';
        if (typeof db.isAvailable === 'function' && !db.isAvailable()) return 'unavailable';
        const sessionId = db.startSession(manifest.repo);
        const files = (h.artefacts || []).map((a) => a.path).filter(Boolean);
        const entries = [{ type: 'decision', title: `chain ${manifest.run}: ${h.from} -> ${h.to} ${h.status}`, concept: h.summary }]
            .concat((h.memory || []).map((m) => ({ type: m.type || 'discovery', title: m.title, concept: m.concept || '' })));
        let n = 0;
        for (const e of entries) {
            const id = db.saveObservation({ sessionId, projectPath: manifest.repo, type: e.type, title: e.title, concept: e.concept, sourceFiles: files, rawData: JSON.stringify({ chain: manifest.run, story: manifest.story.id }) });
            if (id) n++;
        }
        return `written:${n}`;
    } catch {
        return 'unavailable';
    }
}

function renderTemplate(text, vars) {
    return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
function templateDir() { return path.join(__dirname, '..', 'skills', 'role-chain', 'templates'); }

function landHandoff(run, from, to, h, noMemory) {
    const dir = runDir(run);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'chain.json'), 'utf8'));
    const history = handoffEvents(run);
    const seq = history.length + 1;
    const file = path.join(dir, 'handoffs', `${String(seq).padStart(3, '0')}-${from}-${to}.json`);
    const stamped = { ...h, at: h.at || new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stamped, null, 2) + '\n');
    const round = h.status === 'rework' ? history.filter((e) => e.status === 'rework' && e.from === from && e.to === to).length + 1 : undefined;
    const memory = writeMemory(manifest, stamped, noMemory);
    const event = { type: 'handoff', seq, at: stamped.at, from, to, status: h.status, file, artefacts: h.artefacts || [], acceptance: (h.acceptanceCriteria || []).length, round, memory };
    fs.appendFileSync(path.join(dir, 'chain.jsonl'), JSON.stringify(event) + '\n');
    return event;
}

function cmdStart(args) {
    const run = args._[1];
    if (!validRunName(run)) return usage('start needs a run name: lowercase letters, digits and dashes, at most 40');
    if (!args.story || !args.repo) return usage('start needs --story <id> and --repo <path>');
    const repo = path.resolve(args.repo);
    const prdFile = path.resolve(args.prd || path.join(repo, 'prd.json'));
    const dir = runDir(run);
    if (fs.existsSync(dir)) return refuse([{ field: 'run', reason: `run-exists: ${dir}` }]);
    if (!fs.existsSync(prdFile)) return refuse([{ field: '--prd', reason: `prd-not-found: ${prdFile}` }]);
    let prd;
    try { prd = JSON.parse(fs.readFileSync(prdFile, 'utf8')); } catch (e) { return refuse([{ field: '--prd', reason: `prd-unparseable: ${e.message}` }]); }
    const story = findStory(prd, args.story);
    if (!story) return refuse([{ field: '--story', reason: `story-not-found: ${args.story}` }]);
    const criteria = storyCriteria(story, args.ac);
    const base = args.base || 'origin/main';
    const roles = {};
    for (const role of ROLES) {
        const info = ROLE_INFO[role];
        roles[role] = {
            model: info.model, effort: info.effort, writes: info.writes,
            worktree: info.worktree ? path.join(repo, '.claude', 'worktrees', `chain-${run}-${role}`) : null,
            branch: info.worktree ? `chain/${run}-${role}` : null,
            brief: path.join(dir, 'briefs', `${role}.md`),
            report: path.join(os.homedir(), '.claude', 'autodev', 'reports', `chain-${run}-${role}`, 'REPORT.md'),
        };
    }
    const manifest = { schema: 1, run, createdAt: new Date().toISOString(), repo, prd: prdFile, base, story: { id: story.id, title: story.title || '', acceptance: story.acceptance || null }, roles, reworkCap: REWORK_CAP };
    const pmHandoff = {
        schema: 1, run, from: 'pm', to: 'spec', status: 'done',
        summary: `Spec story ${story.id}: ${story.title || ''}`.trim(),
        artefacts: [{ kind: 'story', path: `${prdFile}#${story.id}` }],
        acceptanceCriteria: criteria,
    };
    // Validate before touching disk, so a story with no acceptance leaves no folder.
    const problems = validateHandoff(pmHandoff, { run, from: 'pm', to: 'spec', checkFiles: false });
    if (problems.length) return refuse(problems);

    fs.mkdirSync(path.join(dir, 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'artefacts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chain.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.appendFileSync(path.join(dir, 'chain.jsonl'), JSON.stringify({ type: 'start', at: manifest.createdAt, run, story: story.id, repo, base }) + '\n');
    const script = __filename;
    const dispatch = [];
    for (const role of ROLES) {
        const r = roles[role];
        const tpl = fs.readFileSync(path.join(templateDir(), `${role}.md`), 'utf8');
        const vars = {
            run, role, story: story.id, storyTitle: story.title || '', repo, base, chainDir: dir, script,
            model: r.model, effort: r.effort, worktree: r.worktree || '', branch: r.branch || '', report: r.report,
            next: NEXT[role], reworkTo: REWORK_TO[role] || 'pm', reworkCap: REWORK_CAP,
            specPath: path.join(dir, 'artefacts', 'spec.md'), qaPath: path.join(dir, 'artefacts', 'qa.md'),
            engBranch: roles.eng.branch, handoffDir: path.join(dir, 'handoffs'),
        };
        fs.writeFileSync(r.brief, renderTemplate(tpl, vars));
        if (role !== 'pm') dispatch.push({ role, title: `chain ${run}: ${role}`, name: `${run}-${role}`.slice(0, 24), model: r.model, effort: r.effort, brief: r.brief, worktree: r.worktree });
    }
    const event = landHandoff(run, 'pm', 'spec', pmHandoff, args['no-memory']);
    process.stdout.write(JSON.stringify({ run, chainDir: dir, story: story.id, criteria: criteria.length, firstHandoff: event.file, dispatch }, null, 2) + '\n');
    return 0;
}

function cmdHandoff(args) {
    const [, run, from, to] = args._;
    if (!validRunName(run) || !from || !to || !args.file) return usage('handoff <run> <from> <to> --file <json>');
    if (!fs.existsSync(path.join(runDir(run), 'chain.json'))) return refuse([{ field: 'run', reason: `no-such-run: ${run}` }]);
    let h;
    try { h = JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8')); } catch (e) { return refuse([{ field: '--file', reason: `unreadable-handoff: ${e.message}` }]); }
    const problems = validateHandoff(h, { run, from, to, history: handoffEvents(run) });
    if (problems.length) return refuse(problems);
    const event = landHandoff(run, from, to, h, args['no-memory']);
    process.stdout.write(`handoff ${event.seq} landed: ${from} -> ${to} ${event.status}${event.round ? ` (round ${event.round}/${REWORK_CAP})` : ''}, memory ${event.memory}\n${event.file}\n`);
    return 0;
}

/** Each role's state, derived from the handoff events alone. */
function chainState(manifest, events) {
    const state = {};
    for (const role of ROLES) state[role] = { state: 'waiting', artefacts: [], reworkRounds: 0 };
    for (const e of events) {
        if (!state[e.from] || !state[e.to]) continue;
        if (e.status === 'done') {
            state[e.from].state = 'done';
            state[e.from].artefacts = e.artefacts || [];
            state[e.to].state = e.to === 'pm' ? 'done' : 'pending';
        } else if (e.status === 'rework') {
            state[e.from].state = 'waiting-rework';
            state[e.from].reworkRounds = Math.max(state[e.from].reworkRounds, e.round || 0);
            state[e.to].state = 'rework';
        } else if (e.status === 'blocked') {
            state[e.from].state = 'blocked';
            state.pm.state = 'escalated';
        }
    }
    return state;
}

function cmdStatus(args) {
    const run = args._[1];
    const root = chainRoot();
    if (!run) {
        const runs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'chain.json'))) : [];
        const rows = runs.map((r) => {
            const m = JSON.parse(fs.readFileSync(path.join(root, r, 'chain.json'), 'utf8'));
            const s = chainState(m, handoffEvents(r));
            return { run: r, story: m.story.id, roles: Object.fromEntries(ROLES.map((x) => [x, s[x].state])) };
        });
        if (args.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        else {
            process.stdout.write(`${rows.length} chain(s) under ${root}\n`);
            for (const r of rows) process.stdout.write(`${r.run}  ${r.story}  ${ROLES.map((x) => `${x}:${r.roles[x]}`).join(' ')}\n`);
        }
        return 0;
    }
    const file = path.join(runDir(run), 'chain.json');
    if (!fs.existsSync(file)) return refuse([{ field: 'run', reason: `no-such-run: ${run}` }]);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const events = handoffEvents(run);
    const state = chainState(manifest, events);
    if (args.json) { process.stdout.write(JSON.stringify({ run, story: manifest.story, handoffs: events.length, roles: state }, null, 2) + '\n'); return 0; }
    process.stdout.write(`chain ${run}  story ${manifest.story.id}  ${events.length} handoff(s)\n`);
    for (const role of ROLES) {
        const s = state[role];
        const r = manifest.roles[role];
        const arts = s.artefacts.map((a) => `${a.kind}=${a.path}${a.sha ? `@${a.sha.slice(0, 9)}` : ''}`).join(' ');
        process.stdout.write(`${role.padEnd(5)} ${s.state.padEnd(15)} ${r.model} ${r.effort}${s.reworkRounds ? ` rework ${s.reworkRounds}/${REWORK_CAP}` : ''}${arts ? `  ${arts}` : ''}\n`);
    }
    return 0;
}

function refuse(problems) {
    process.stderr.write(`REFUSED: ${problems.length} problem(s)\n`);
    for (const p of problems) process.stderr.write(`  ${p.field}: ${p.reason}\n`);
    return 1;
}
function usage(msg) {
    const text = 'Usage:\n  role-chain.js start <run> --story <id> --repo <path> [--prd <file>] [--base <ref>] [--ac "<check>|<expect>"]... [--no-memory]\n  role-chain.js handoff <run> <from> <to> --file <json> [--no-memory]\n  role-chain.js status [<run>] [--json]\n';
    if (msg) process.stderr.write(`${msg}\n${text}`); else process.stdout.write(text);
    return msg ? 2 : 0;
}

function main(argv) {
    const args = parseArgs(argv);
    if (args.help || args.h) return usage();
    if (args.error) return usage(args.error);
    const cmd = args._[0];
    if (cmd === 'start') return cmdStart(args);
    if (cmd === 'handoff') return cmdHandoff(args);
    if (cmd === 'status') return cmdStatus(args);
    return usage(cmd ? `unknown command: ${cmd}` : 'no command');
}

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`role-chain: ${e.message}\n`); process.exitCode = 2; }
}

module.exports = { ROLES, ROLE_INFO, NEXT, REWORK_TO, REWORK_CAP, validateHandoff, findStory, storyCriteria, chainState, renderTemplate, parseArgs, main };
