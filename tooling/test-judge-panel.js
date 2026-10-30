#!/usr/bin/env node
'use strict';
// judge-panel.js over a fake claude bin: majority, the KEEP/REVERT ratchet,
// quorum, position bias and owner agreement. No model is called.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scripts = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const subject = process.env.JUDGE_PANEL_SUBJECT || path.join(scripts, 'judge-panel.js');
const { makePairs } = require(path.join(scripts, 'unslop-sweep.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-panel-'));
const home = path.join(root, 'profile');
const budgetLedger = path.join(root, 'state', 'execution-budget.json');
// Capacity off: admission would probe this machine's live memory, so the suite
// went red whenever commit headroom dipped. test-capacity-admission.js owns it.
const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: home, AUTODEV_CAPACITY: 'off',
    AUTODEV_BUDGET_LEDGER: budgetLedger, AUTODEV_GATE_LOCK_PATH: path.join(root, 'state', 'locks', 'full-gate.lock') };
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }

// The fake judge reads its mode per lens from modes.json beside it: the child env is an allowlist.
const fake = path.join(root, 'bin', 'fake-claude.js');
fs.mkdirSync(path.dirname(fake), { recursive: true });
fs.writeFileSync(fake, `
const fs = require('fs'); const path = require('path');
const modes = JSON.parse(fs.readFileSync(path.join(__dirname, 'modes.json'), 'utf8'));
const msg = JSON.parse(fs.readFileSync(0, 'utf8').trim().split('\\n')[0]).message.content;
const lens = msg[0].text;
const mode = modes.find((m) => lens.includes(m.lens)).mode;
fs.appendFileSync(path.join(__dirname, 'calls.log'), mode + ' ' + msg.filter((c) => c.type === 'image').length + '\\n');
fs.appendFileSync(path.join(__dirname, 'texts.log'), JSON.stringify(msg.filter((c) => c.type === 'text').map((c) => c.text)) + '\\n');
if (mode === 'crash') { process.stderr.write('boom'); process.exit(1); }
// Quality of an image: a 'worse' render 0, a before 1, an improved after 2.
const quality = (t) => (t.includes('worse') ? 0 : t.includes('AFTER') ? 2 : 1);
const seen = {}; let id = null; let label = null;
for (const c of msg) {
  const m = c.type === 'text' && /^Pair (p\\d+), image ([AB]):/.exec(c.text);
  if (m) { id = m[1]; label = m[2].toLowerCase(); continue; }
  if (c.type === 'image' && id) { (seen[id] = seen[id] || {})[label] = quality(Buffer.from(c.source.data, 'base64').toString()); id = null; }
}
const verdicts = {};
for (const [pid, q] of Object.entries(seen)) {
  if (mode === 'position') verdicts[pid] = 'a';
  else if (mode === 'tie' || q.a === q.b) verdicts[pid] = 'tie';
  else if (mode === 'good') verdicts[pid] = q.a > q.b ? 'a' : 'b';
  else if (mode === 'bad') verdicts[pid] = q.a > q.b ? 'b' : 'a';
}
if (mode === 'partial') delete verdicts[Object.keys(verdicts)[0]];
process.stdout.write(JSON.stringify({ type: 'system' }) + '\\n' + JSON.stringify({ type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.01, structured_output: { verdicts, notes: {} } }) + '\\n');
`);
const { LENSES } = require(subject);
const setModes = (list) => fs.writeFileSync(path.join(root, 'bin', 'modes.json'), JSON.stringify(list.map((mode, i) => ({ lens: LENSES[i].slice(0, 40), mode }))));

// Three captures; capture 3's after is a regression when `regress` is set.
function pairsDir(name, { regress = false } = {}) {
    const dir = path.join(root, name);
    const shots = path.join(root, `${name}-shots`);
    fs.mkdirSync(shots, { recursive: true });
    const before = {}; const after = {};
    for (const c of ['home|out|390', 'home|out|414', 'pricing|out|390']) {
        const f = c.replace(/\|/g, '_');
        before[c] = path.join(shots, `${f}-before.png`); fs.writeFileSync(before[c], 'BEFORE ' + c);
        after[c] = path.join(shots, `${f}-after.png`);
        fs.writeFileSync(after[c], regress && c.startsWith('pricing') ? 'BEFORE-LIKE worse ' + c : 'AFTER ' + c);
    }
    const pr = makePairs(before, after, 7);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = pr.manifest.map((p) => {
        fs.copyFileSync(p.a, path.join(dir, `${p.id}-a.png`)); fs.copyFileSync(p.b, path.join(dir, `${p.id}-b.png`));
        return { id: p.id, a: `${p.id}-a.png`, b: `${p.id}-b.png` };
    });
    fs.writeFileSync(path.join(dir, 'pairs.json'), JSON.stringify({ pairs: manifest }));
    fs.writeFileSync(path.join(dir, '.key.json'), JSON.stringify(pr.key));
    return { dir, key: pr.key };
}
const panel = (dir, extra = []) => spawnSync(process.execPath, [subject, 'run', dir, '--claude-bin', fake, '--batch', '4', ...extra], { env, encoding: 'utf8' });
const readPanel = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'panel.json'), 'utf8'));
try {
    let p = pairsDir('good');
    setModes(['good', 'good', 'bad']);
    let r = panel(p.dir);
    let j = readPanel(p.dir);
    check('a majority preferring the after side keeps the change', r.status === 0 && j.decision === 'KEEP' && j.score.wins === 3, r.stdout + r.stderr);
    check('a dissenting judge lowers agreement, not the verdict', j.agreement === 0 && j.perJudge[2].score.losses === 3, JSON.stringify({ a: j.agreement }));
    // The lens says "before and after" in general; no pair may say which side is which.
    const texts = fs.readFileSync(path.join(root, 'bin', 'texts.log'), 'utf8').replace(/before and after/g, '');
    check('judges see pair ids but never the key or which side is the after', /Pair p001, image A:/.test(texts) && !/key|\bafter\b|\bbefore\b|AFTER|BEFORE/i.test(texts), texts.slice(0, 300));
    const calls = fs.readFileSync(path.join(root, 'bin', 'calls.log'), 'utf8').trim().split('\n');
    check('pairs are batched per judge (6 pairs, batch 4: 2 calls each)', calls.length === 6 && calls[0].endsWith(' 8') && calls[1].endsWith(' 4'), calls.join('|'));

    p = pairsDir('regress', { regress: true });
    setModes(['good', 'good', 'good']);
    r = panel(p.dir);
    j = readPanel(p.dir);
    check('a regressed capture over the loss share reverts', r.status === 1 && j.decision === 'REVERT' && j.score.losses === 1, r.stdout);
    check('the regressed capture is named', /regressed: pricing\|out\|390/.test(r.stdout), r.stdout);
    r = panel(p.dir, ['--max-loss-share', '0.5']);
    check('a looser loss share keeps it', r.status === 0, r.stdout);

    p = pairsDir('bias');
    setModes(['position', 'position', 'position']);
    r = panel(p.dir);
    j = readPanel(p.dir);
    check('a panel that reads by position wins nothing and reverts', r.status === 1 && j.score.wins === 0 && j.score.inconsistent === 3, JSON.stringify(j.score && { w: j.score.wins, i: j.score.inconsistent }));

    setModes(['tie', 'tie', 'tie']);
    r = panel(p.dir);
    check('all ties revert: no improvement is not a keep', r.status === 1 && readPanel(p.dir).decision === 'REVERT', r.stdout);

    setModes(['good', 'crash', 'partial']);
    r = panel(p.dir);
    j = readPanel(p.dir);
    check('fewer than a quorum of complete judges is indeterminate (exit 2)', r.status === 2 && j.decision === 'INDETERMINATE' && j.answered === 1, r.stdout + r.stderr);
    check('an incomplete judge says why', /judge 2 incomplete: no-result-exit-1/.test(r.stdout) && /judge 3 incomplete: unanswered/.test(r.stdout), r.stdout);

    setModes(['good', 'crash', 'good']);
    r = panel(p.dir);
    check('a quorum of complete judges still decides', r.status === 0 && readPanel(p.dir).answered === 2, r.stdout);

    setModes(['good', 'good', 'good']);
    const owner = path.join(root, 'owner.json');
    fs.writeFileSync(owner, JSON.stringify(Object.fromEntries(Object.entries(p.key).map(([id, k], i) => [id, i === 0 ? (k.after === 'a' ? 'b' : 'a') : k.after]))));
    r = panel(p.dir, ['--owner', owner]);
    check('owner agreement is scored against the owner\'s picks', /owner agreement: 5 of 6 picks/.test(r.stdout), r.stdout);

    r = panel(path.join(root, 'nowhere'));
    check('a missing pairs dir is refused with exit 2', r.status === 2);
    r = spawnSync(process.execPath, [subject, 'run', p.dir, '--judges', '9'], { env, encoding: 'utf8' });
    check('an out-of-range panel size is refused', r.status === 2 && /--judges takes 2 to 7/.test(r.stderr), r.stderr);

    // A2: one judge is one model's preference, not a panel.
    setModes(['good', 'good', 'good']);
    r = panel(p.dir, ['--judges', '1']);
    check('A2. a one-judge panel is refused, never a KEEP', r.status === 2 && /--judges takes 2 to 7/.test(r.stderr), `exit ${r.status} ${r.stdout}${r.stderr}`);
    setModes(['good', 'crash', 'good']);
    r = panel(p.dir, ['--judges', '2']);
    check('A2. a KEEP needs at least two complete judges', r.status === 2 && readPanel(p.dir).quorum === 2 && readPanel(p.dir).answered === 1, `exit ${r.status} ${r.stdout}`);

    // A1: the default pair set must not be decodable from its ids. An attacker
    // that ignores the images rebuilds the set with the old default seed (1) and
    // reads the orientation off the ids.
    const sweep = path.join(scripts, 'unslop-sweep.js');
    const outDir = (name, tag) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        const routes = [];
        for (const route of ['/', '/pricing', '/about']) {
            const shot = `${route === '/' ? 'home' : route.slice(1)}-390.png`;
            fs.writeFileSync(path.join(d, shot), `${tag} ${route}`);
            routes.push({ route, state: 'signed-out', widths: { 390: { shot } } });
        }
        fs.writeFileSync(path.join(d, 'scorecard.json'), JSON.stringify({ routes }));
        return d;
    };
    const bOut = outDir('sweep-before', 'BEFORE'); const aOut = outDir('sweep-after', 'AFTER');
    const shotsOf = (d) => Object.fromEntries(JSON.parse(fs.readFileSync(path.join(d, 'scorecard.json'), 'utf8')).routes.map((x) => [`${x.route}|${x.state}|390`, path.join(d, x.widths[390].shot)]));
    const guess = makePairs(shotsOf(bOut), shotsOf(aOut), 1).key;
    let decoded = 0; const idSets = [];
    for (let i = 0; i < 4; i++) {
        const pd = path.join(root, `blind-${i}`);
        const s = spawnSync(process.execPath, [sweep, 'pairs', bOut, aOut, '--pairs', pd], { encoding: 'utf8' });
        const key = JSON.parse(fs.readFileSync(path.join(pd, '.key.json'), 'utf8'));
        idSets.push(Object.keys(key).sort().join(','));
        if (s.status === 0 && Object.entries(guess).every(([id, g]) => key[id] && key[id].after === g.after)) decoded++;
    }
    check('A1. the default pair set cannot be decoded from its ids with the fixed seed', decoded === 0, `${decoded} of 4 runs decoded 6/6`);
    check('A1. default pair ids are opaque and differ per run', new Set(idSets).size === 4 && idSets.every((s) => !/\bp00\d\b/.test(s)), idSets.join(' | '));
    const seeded = path.join(root, 'seeded');
    spawnSync(process.execPath, [sweep, 'pairs', bOut, aOut, '--pairs', seeded, '--seed', '5'], { encoding: 'utf8' });
    check('A1. a seeded pair set is marked non-blind', JSON.parse(fs.readFileSync(path.join(seeded, 'pairs.json'), 'utf8')).blind === false);
    r = panel(seeded);
    check('A1. the panel refuses a non-blind (seeded) pair set', r.status === 2 && /not blind/.test(r.stderr), `exit ${r.status} ${r.stdout}${r.stderr}`);

    const booked = fs.existsSync(budgetLedger) ? fs.readFileSync(budgetLedger, 'utf8') : '';
    check('judge calls are booked in the shared execution budget', /judge-panel/.test(booked) && /"judge"/.test(booked), booked.slice(0, 200));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`judge-panel: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
