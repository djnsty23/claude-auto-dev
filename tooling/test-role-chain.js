#!/usr/bin/env node
'use strict';
// role-chain.js moves one story through PM, Spec, Eng, QA and Copy, and every
// handover is a JSON file it validates. A handoff that lands without
// acceptance criteria gives the next role nothing to check against, so the
// planted negative below is the defect the validator exists to stop: a real
// spec handoff with its acceptanceCriteria removed. It must be refused with
// the reason named, and the event log must not grow.
//
// Every run uses a scratch chain root and a scratch HOME, never the real
// ~/.claude/autodev/chain.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'role-chain.js');
const rc = require(SCRIPT);

let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'role-chain-'));
const root = path.join(scratch, 'chain');
const home = path.join(scratch, 'home');
fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, AUTODEV_CHAIN_ROOT: root, HOME: home, USERPROFILE: home, AUTODEV_MEMORY_DB: '' };

function run(args, extraEnv = {}) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 20000 });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function events(name) {
    const f = path.join(root, name, 'chain.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
function writeJson(name, obj) { const f = path.join(scratch, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; }

// A product repo with stories in the three shapes prd.json takes.
const repo = path.join(scratch, 'repo');
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'prd.json'), JSON.stringify({
    sprints: [{ id: 'S1', stories: [
        { id: 'S-1', title: 'Name the preview image', passes: null, acceptance: 'og-images test passes and fails when one page drops its image' },
        { id: 'S-2', title: 'No acceptance', passes: null },
    ] }],
}));
const prdObject = writeJson('prd-object.json', { stories: { 'K-1': { title: 'keyed', acceptance: ['a', 'b'] } } });
const prdArray = writeJson('prd-array.json', { stories: [{ id: 'A-1', title: 'array' }] });

try {
    // --- usage ---
    const help = run(['--help']);
    check('--help exits 0 and prints usage', help.code === 0 && /role-chain\.js start/.test(help.out), help.err);
    check('an unknown command exits 2', run(['bogus']).code === 2);

    // --- findStory / storyCriteria (the three prd shapes) ---
    check('findStory reads sprints[].stories arrays', rc.findStory(JSON.parse(fs.readFileSync(path.join(repo, 'prd.json'), 'utf8')), 'S-1')?.title === 'Name the preview image');
    check('findStory reads a keyed stories object', rc.findStory(JSON.parse(fs.readFileSync(prdObject, 'utf8')), 'K-1')?.id === 'K-1');
    check('findStory reads a stories array', rc.findStory(JSON.parse(fs.readFileSync(prdArray, 'utf8')), 'A-1')?.title === 'array');
    check('findStory returns null for an absent id', rc.findStory({ stories: [] }, 'X') === null);
    check('storyCriteria turns an acceptance array into AC1..ACn', rc.storyCriteria({ acceptance: ['a', 'b'] }, []).map((c) => c.id).join() === 'AC1,AC2');
    check('storyCriteria takes --ac "check|expect" over the story', JSON.stringify(rc.storyCriteria({ acceptance: 'x' }, ['npm test|exit 0'])[0]) === JSON.stringify({ id: 'AC1', check: 'npm test', expect: 'exit 0' }));
    check('renderTemplate leaves an unknown placeholder as written', rc.renderTemplate('{{a}} {{zz}}', { a: 1 }) === '1 {{zz}}');

    // --- start ---
    const bad = run(['start', 'Bad_Name', '--story', 'S-1', '--repo', repo]);
    check('start refuses a run name with capitals or underscores (exit 2)', bad.code === 2, bad.err);
    const noAc = run(['start', 'no-ac', '--story', 'S-2', '--repo', repo, '--no-memory']);
    check('start refuses a story with no acceptance, naming the reason', noAc.code === 1 && /missing-acceptance-criteria/.test(noAc.err), noAc.err);
    check('the refused start left no chain folder', !fs.existsSync(path.join(root, 'no-ac')));
    const withAc = run(['start', 'with-ac', '--story', 'S-2', '--repo', repo, '--ac', 'npm test|exit 0', '--no-memory']);
    check('start accepts the same story once --ac supplies a criterion', withAc.code === 0, withAc.err);
    check('start refuses a missing story', run(['start', 'nostory', '--story', 'NOPE', '--repo', repo]).code === 1);

    const started = run(['start', 'c1', '--story', 'S-1', '--repo', repo, '--no-memory']);
    check('start exits 0', started.code === 0, started.err);
    const out = started.code === 0 ? JSON.parse(started.out) : { dispatch: [] };
    const dir = path.join(root, 'c1');
    const briefs = rc.ROLES.map((r) => path.join(dir, 'briefs', `${r}.md`));
    check('start writes one brief per role (5)', briefs.every((b) => fs.existsSync(b)), briefs.filter((b) => !fs.existsSync(b)).join());
    const leftover = briefs.filter((b) => fs.existsSync(b) && /\{\{\w+\}\}/.test(fs.readFileSync(b, 'utf8')));
    check('no brief keeps an unrendered placeholder', leftover.length === 0, leftover.join());
    check('every brief carries an Acceptance criteria section', briefs.every((b) => fs.existsSync(b) && /^## Acceptance criteria$/m.test(fs.readFileSync(b, 'utf8'))));
    const models = Object.fromEntries(out.dispatch.map((d) => [d.role, `${d.model} ${d.effort}`]));
    check('dispatch pins spec and eng to Opus medium, qa and copy to Haiku xhigh',
        models.spec === 'claude-opus-5-5 medium' && models.eng === 'claude-opus-5-5 medium' && models.qa === 'claude-haiku-5-5 xhigh' && models.copy === 'claude-haiku-5-5 xhigh', JSON.stringify(models));
    check('dispatch has four roles (PM is the coordinator)', out.dispatch.length === 4);
    const ev0 = events('c1');
    check('start logs a start event and the pm -> spec handoff', ev0.length === 2 && ev0[1].from === 'pm' && ev0[1].to === 'spec' && ev0[1].status === 'done', JSON.stringify(ev0));
    check('start refuses an existing run', run(['start', 'c1', '--story', 'S-1', '--repo', repo]).code === 1);
    const st0 = run(['status', 'c1']);
    check('after start: pm done, spec pending, eng waiting', /^pm\s+done/m.test(st0.out) && /^spec\s+pending/m.test(st0.out) && /^eng\s+waiting/m.test(st0.out), st0.out);

    // --- the planted negative: a spec handoff with its criteria removed ---
    const specPath = path.join(dir, 'artefacts', 'spec.md');
    fs.writeFileSync(specPath, '# spec\n');
    const good = {
        schema: 1, run: 'c1', from: 'spec', to: 'eng', status: 'done', summary: 'spec written',
        artefacts: [{ kind: 'spec', path: specPath }],
        acceptanceCriteria: [{ id: 'AC1', check: 'node test.js', expect: 'exit 0' }],
        memory: [{ type: 'decision', title: 'use the existing helper' }],
    };
    const planted = { ...good };
    delete planted.acceptanceCriteria;
    const before = events('c1').length;
    const refused = run(['handoff', 'c1', 'spec', 'eng', '--file', writeJson('planted.json', planted), '--no-memory']);
    check('PLANTED: a handoff missing acceptance criteria is refused (exit 1)', refused.code === 1, `exit ${refused.code}`);
    check('PLANTED: the refusal names missing-acceptance-criteria', /acceptanceCriteria: missing-acceptance-criteria/.test(refused.err), refused.err);
    check('PLANTED: the refused handoff did not grow chain.jsonl', events('c1').length === before);
    const emptyAc = run(['handoff', 'c1', 'spec', 'eng', '--file', writeJson('empty-ac.json', { ...good, acceptanceCriteria: [] }), '--no-memory']);
    check('an empty acceptanceCriteria array is refused too', emptyAc.code === 1 && /missing-acceptance-criteria/.test(emptyAc.err), emptyAc.err);
    const noExpect = run(['handoff', 'c1', 'spec', 'eng', '--file', writeJson('no-expect.json', { ...good, acceptanceCriteria: [{ id: 'AC1', check: 'x' }] }), '--no-memory']);
    check('a criterion without expect is refused as missing-expect', noExpect.code === 1 && /missing-expect/.test(noExpect.err), noExpect.err);

    // --- other refusals ---
    const wrongEdge = run(['handoff', 'c1', 'spec', 'qa', '--file', writeJson('edge.json', { ...good, to: 'qa' }), '--no-memory']);
    check('done from spec to qa is refused as wrong-edge', wrongEdge.code === 1 && /wrong-edge/.test(wrongEdge.err), wrongEdge.err);
    const noSpec = run(['handoff', 'c1', 'spec', 'eng', '--file', writeJson('nospec.json', { ...good, artefacts: [] }), '--no-memory']);
    check('done from spec without a spec artefact is refused', noSpec.code === 1 && /missing-artefact: done from spec carries a spec/.test(noSpec.err), noSpec.err);
    const ghost = run(['handoff', 'c1', 'spec', 'eng', '--file', writeJson('ghost.json', { ...good, artefacts: [{ kind: 'spec', path: path.join(dir, 'nope.md') }] }), '--no-memory']);
    check('a spec path that does not exist is refused', ghost.code === 1 && /file-not-found/.test(ghost.err), ghost.err);
    check('a handoff to an unknown run is refused', run(['handoff', 'nope', 'spec', 'eng', '--file', writeJson('g2.json', good)]).code === 1);

    // --- the real spec handoff, with memory through a stub module ---
    const memLog = path.join(scratch, 'mem.log');
    const stub = path.join(scratch, 'memstub.js');
    fs.writeFileSync(stub, `const fs=require('fs');module.exports={isAvailable:()=>true,startSession:()=> 'sess',saveObservation:(o)=>{fs.appendFileSync(${JSON.stringify(memLog)},JSON.stringify(o)+'\\n');return 'obs';}};`);
    const landed = run(['handoff', 'c1', 'spec', 'eng', '--file', writeJson('good.json', good)], { AUTODEV_MEMORY_DB: stub });
    check('a complete spec handoff lands', landed.code === 0, landed.err);
    check('the handoff wrote two memory observations (summary + memory entry)', /memory written:2/.test(landed.out) && fs.readFileSync(memLog, 'utf8').trim().split('\n').length === 2, landed.out);
    const st1 = run(['status', 'c1']);
    check('status: spec done with the spec path, eng pending', new RegExp(`^spec\\s+done.*spec=${specPath.replace(/[\\.]/g, (c) => `\\${c}`)}`, 'm').test(st1.out) && /^eng\s+pending/m.test(st1.out), st1.out);

    // A memory module that throws never blocks a handoff.
    const throwing = path.join(scratch, 'memthrow.js');
    fs.writeFileSync(throwing, "module.exports={startSession(){throw new Error('db down')},saveObservation(){}};");

    // --- rework cap: two rounds eng -> spec, the third refused, then blocked to pm ---
    const rework = { schema: 1, run: 'c1', from: 'eng', to: 'spec', status: 'rework', summary: 'spec unclear', artefacts: [], acceptanceCriteria: good.acceptanceCriteria, rework: { reasons: ['which helper?'] } };
    const r1 = run(['handoff', 'c1', 'eng', 'spec', '--file', writeJson('rw1.json', rework)], { AUTODEV_MEMORY_DB: throwing });
    check('rework round 1 lands even when the memory module throws', r1.code === 0 && /round 1\/2\), memory unavailable/.test(r1.out), r1.out + r1.err);
    const r2 = run(['handoff', 'c1', 'eng', 'spec', '--file', writeJson('rw2.json', rework), '--no-memory']);
    check('rework round 2 lands', r2.code === 0 && /round 2\/2/.test(r2.out), r2.err);
    const r3 = run(['handoff', 'c1', 'eng', 'spec', '--file', writeJson('rw3.json', rework), '--no-memory']);
    check('rework round 3 is refused as rework-cap', r3.code === 1 && /rework-cap/.test(r3.err), r3.err);
    const noReason = run(['handoff', 'c1', 'qa', 'eng', '--file', writeJson('rw4.json', { ...rework, from: 'qa', to: 'eng', rework: { reasons: [] } }), '--no-memory']);
    check('a rework with no reasons is refused', noReason.code === 1 && /rework-needs-reasons/.test(noReason.err), noReason.err);
    const blocked = { ...rework, status: 'blocked', to: 'pm', blocker: 'two rounds, spec and eng disagree' };
    delete blocked.rework;
    const b1 = run(['handoff', 'c1', 'eng', 'pm', '--file', writeJson('blk.json', blocked), '--no-memory']);
    check('blocked to pm lands after the cap', b1.code === 0, b1.err);
    const st2 = run(['status', 'c1', '--json']);
    const js = JSON.parse(st2.out || '{}');
    check('status --json: eng blocked, pm escalated, rework rounds 2', js.roles?.eng?.state === 'blocked' && js.roles?.pm?.state === 'escalated' && js.roles?.eng?.reworkRounds === 2, st2.out);

    // --- eng and copy artefact rules ---
    const engDone = { schema: 1, run: 'c1', from: 'eng', to: 'qa', status: 'done', summary: 'built', artefacts: [{ kind: 'branch', path: 'chain/c1-eng' }, { kind: 'commit', path: 'chain/c1-eng', sha: 'XYZ' }], acceptanceCriteria: good.acceptanceCriteria };
    const badSha = run(['handoff', 'c1', 'eng', 'qa', '--file', writeJson('sha.json', engDone), '--no-memory']);
    check('an eng commit with a malformed sha is refused', badSha.code === 1 && /commit-needs-sha/.test(badSha.err), badSha.err);

    // --- validateHandoff direct ---
    check('validateHandoff: a non-object is refused', rc.validateHandoff(null, { run: 'c1', from: 'spec', to: 'eng' })[0]?.reason === 'not-an-object');
    check('validateHandoff: a run mismatch is named', rc.validateHandoff({ ...good, run: 'other' }, { run: 'c1', from: 'spec', to: 'eng', checkFiles: false }).some((p) => /run-mismatch/.test(p.reason)));
    check('validateHandoff: the complete handoff has no problems', rc.validateHandoff(good, { run: 'c1', from: 'spec', to: 'eng' }).length === 0);

    // --- the listing ---
    const list = run(['status']);
    check('status with no run lists both chains', /^2 chain\(s\)/.test(list.out) && /^c1\s+S-1/m.test(list.out) && /^with-ac\s+S-2/m.test(list.out), list.out);
    const listJson = JSON.parse(run(['status', '--json']).out || '[]');
    check('status --json with no run returns one row per chain', listJson.length === 2);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`role-chain: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
