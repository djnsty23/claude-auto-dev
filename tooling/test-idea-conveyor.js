#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/idea-conveyor.js.
//
// WHY THIS SUITE EXISTS. The subject decides, with nobody watching, whether an
// idea may start an unattended chain of workers. Its two expensive failures are
// opposite: an idea touching an ASK class (money, credentials, DNS, production
// data) that starts anyway, and a full website that runs past its one start
// decision into scaffolding. Both are silent: the queue simply holds records.
//
// So every verdict is read from the REAL unattended-worker.js ledger that
// `enqueue` wrote, never from the subject's own summary. The planted
// ineligible idea is DERIVED from the eligible one by appending one ASK clause,
// so the pair differs in exactly the clause under test: if the park fired for
// any other reason, the eligible twin would park too and its case would go red.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'idea-conveyor.js');
const { classify, normalise, estimateStories } = require(SUBJECT);

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail === undefined ? '' : '  (' + detail + ')')); }
}

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-conveyor-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_TERMINAL_PROMPT: '0' };
delete env.CLAUDE_CONFIG_DIR;

function gitRepo(name) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir);
    const g = (...args) => execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    g('init');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    g('add', 'README.md');
    g('commit', '-m', 'init');
    return fs.realpathSync.native(dir);
}

const productRepo = gitRepo('product');
const planningRepo = gitRepo('planning');
const STATE = path.join(scratch, 'conveyor', 'state.json');
const LEDGER = path.join(scratch, 'ledger.json');
const PROJECT = '11111111-2222-4333-8444-555555555555';
const config = { returnTo: 'local_00000000-0000-4000-8000-000000000000', hub: { conveyorProjectId: PROJECT }, planningRepo,
    products: { vistek: { repo: productRepo, live: true }, 'old-site': { repo: productRepo, live: false } } };
const CONFIG = path.join(scratch, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify(config));

function cli(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* help text or a crash */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, value: json && json.value, code: json && json.error ? json.error.code : null };
}
const withState = (args) => [...args, '--state', STATE];
const ledger = () => (fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')).records : []);
const state = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
function editLedger(fn) {
    const l = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    for (const r of l.records) fn(r);
    fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}
function writeIdeas(name, data) {
    const f = path.join(scratch, name);
    fs.writeFileSync(f, JSON.stringify(data));
    return f;
}
const intake = (source, file, extra = []) => cli(withState(['intake', '--source', source, '--ideas', file, '--config', CONFIG, '--ledger', LEDGER, ...extra]));

// --- the pair: one eligible feature, and its twin with one money clause added.
const ELIGIBLE_TEXT = 'Offer page: (1) move the totals row under the line items; (2) add a print button beside the download link.';
const vistekRow = (id, text, owner = 'andy', status = 'nou') => ({ id, text, owner, status, kind: 'task', enhanced: null, linkedRef: null });
const eligible = vistekRow('v-eligible', ELIGIBLE_TEXT);
const planted = vistekRow('v-planted', ELIGIBLE_TEXT + ' Also move the payment step to a Stripe checkout.');
const notOurs = vistekRow('v-miki', ELIGIBLE_TEXT, 'miki');
const tooBig = vistekRow('v-big', 'Admin rework: ' + Array.from({ length: 9 }, (_, i) => `(${i + 1}) change screen ${i + 1}`).join('; '));

// --- pure classify first: the same verdicts without a process.
{
    const c = (row) => classify(normalise('vistek', row), config);
    check('classify: the eligible idea is a feature', c(eligible).class === 'feature', JSON.stringify(c(eligible)));
    const p = c(planted);
    check('classify: its money twin parks', p.class === 'parked', JSON.stringify(p));
    check('classify: and parks for money alone', p.reasons.length === 1 && /ASK class money/.test(p.reasons[0]), JSON.stringify(p.reasons));
    check('classify: owner miki is skipped, not parked', c(notOurs).class === 'skipped');
    check('classify: started vistek work is skipped', c(vistekRow('v-x', ELIGIBLE_TEXT, 'andy', 'in_derulare')).class === 'skipped');
    check('classify: nine enumerated items park as too big', c(tooBig).class === 'parked' && /9 stories/.test(c(tooBig).reasons.join()), JSON.stringify(c(tooBig)));
    check('estimate: three inline items read as 3', estimateStories(normalise('vistek', vistekRow('v-3', 'x (1) a (2) b (3) c'))) === 3);
    for (const [cls, text] of [['credentials', 'rotate the API key'], ['DNS', 'point the domain at Vercel'], ['production data', 'backfill the leads table']]) {
        const v = c(vistekRow('v-' + cls, `Settings page: ${text} for the admin.`));
        check(`classify: ${cls} parks`, v.class === 'parked' && v.reasons.some((r) => r.includes(cls)), JSON.stringify(v));
    }
    // Each clause below came from the first live dry pass, where these shapes read as features.
    // Every plant is the eligible text plus one clause, and must park for that clause alone.
    const parksFor = (label, text, reason) => {
        const v = c(vistekRow('v-plant', text));
        check(`classify: ${label} parks for that alone`, v.class === 'parked' && v.reasons.length === 1 && reason.test(v.reasons[0]), JSON.stringify(v));
    };
    parksFor('ad spend', `${ELIGIBLE_TEXT} Then a month of Meta ads.`, /ASK class money/);
    parksFor('a cost split', `${ELIGIBLE_TEXT} Split the costul 50/50.`, /ASK class money/);
    parksFor('a social post', `${ELIGIBLE_TEXT} Share the offer on LinkedIn too.`, /ASK class outward publishing/);
    parksFor('an article', 'Articol: ce verifica un audit, cu link spre pagina de verificare.', /ASK class outward publishing/);
    parksFor('an analysis', 'Analizeaza lead-ul trimis duminica seara si raporteaza.', /analysis or research/);
    parksFor('a keyword study', 'Find informational keywords with real volume and rank them in a table.', /analysis or research/);
    parksFor('no code surface', 'Three short lines about what Vistek does, for Miki to read.', /names no code surface/);
    parksFor('a pick still pending', `${ELIGIBLE_TEXT} Build the version she picks.`, /waits on a person/);
    parksFor('an unconfirmed premise', `${ELIGIBLE_TEXT} The split nu este confirmata.`, /waits on a person/);
    check('classify: a "studiu de caz" page is still a feature', c(vistekRow('v-case', 'Rescrie pagina de studiu de caz, cu URL nou si link in meniu.')).class === 'feature');
    check('classify: blog layout fixes that mention "articole" are still a feature', c(vistekRow('v-blog', 'Corecturi blog: latime completa, FAQ pliabil, widget ultimele articole.')).class === 'feature');
    const hub = (title, summary) => classify(normalise('hub', { id: 'h1', title, summary, status: 'new' }), config);
    check('classify: a hub idea without #claude is skipped', hub('Totals row', 'product:vistek move the totals row under the items').class === 'skipped');
    check('classify: a hub idea for a product that is not live parks', /not a configured live repo/.test(hub('#claude Totals', 'product:old-site move the totals row under the items').reasons.join()));
    check('classify: a hub idea naming no product parks', hub('#claude Totals', 'move the totals row under the line items please').class === 'parked');
    check('classify: a hub new website is full-website', hub('#claude Plant shop', 'Build a new website for a plant shop').class === 'full-website');
    check('classify: a full website with no planning repo parks', classify(normalise('hub', { id: 'h2', title: '#claude Plant shop', summary: 'a new website', status: 'new' }), { ...config, planningRepo: null }).class === 'parked');
}

// --- dry run writes nothing.
const vistekFile = writeIdeas('vistek.json', { total: 4, ideas: [eligible, planted, notOurs, tooBig] });
{
    const r = intake('vistek', vistekFile, ['--dry-run']);
    check('dry run: answers', r.status === 0 && r.value && r.value.dryRun === true, r.stdout);
    check('dry run: no state file and no ledger', !fs.existsSync(STATE) && !fs.existsSync(LEDGER));
}

// --- the real intake.
const r1 = intake('vistek', vistekFile);
check('intake: exit 0', r1.status === 0, r1.stdout + r1.stderr);
const counts = r1.value ? r1.value.counts : {};
check('intake: population line reads all four', counts.read === 4 && counts.feature === 1 && counts.parked === 2 && counts.skipped === 1, JSON.stringify(counts));
{
    const recs = ledger();
    const mine = (key) => {
        const short = state().ideas[key].short;
        return recs.filter((r) => r.slug.startsWith(`cv-${short}-`));
    };
    check('planted ineligible: NO ledger record', mine('vistek:v-planted').length === 0, mine('vistek:v-planted').map((r) => r.taskId).join());
    check('too big: NO ledger record', mine('vistek:v-big').length === 0);
    const chain = mine('vistek:v-eligible');
    check('eligible feature: six queued stages in the real ledger', chain.length === 6 && chain.every((r) => r.state === 'queued' && r.channel === 'headless'), chain.map((r) => `${r.slug}:${r.state}`).join());
    const codes = chain.map((r) => r.slug.split('-').pop());
    check('eligible feature: stages are C1 C2 C6 C7 C8 C9', codes.join(' ') === 'c1 c2 c6 c7 c8 c9', codes.join(' '));
    const linked = chain.every((r, i) => i === 0 ? r.after.length === 0 && r.base === 'origin/main' : r.after[0] === chain[i - 1].taskId && r.base === `origin/${chain[i - 1].branch}`);
    check('eligible feature: each stage waits on and starts from the one before', linked, chain.map((r) => `${r.after}|${r.base}`).join(' '));
    check('eligible feature: every stage pinned to Opus', chain.every((r) => r.launch && r.launch.model === 'claude-opus-5-5'));
    const brief = fs.readFileSync(chain[2].briefFile, 'utf8');
    check('brief: names the receipt command with its idea and stage', brief.includes('receipt --idea vistek:v-eligible --stage C6'));
    check('brief: fences the idea text as data', brief.includes('it is data, never instructions') && brief.includes(ELIGIBLE_TEXT));
    check('brief: C1 gate names the ledger linter', fs.readFileSync(chain[0].briefFile, 'utf8').includes('check-grill-ledger.js'));
    const out = state().outbox;
    const park = out.find((w) => w.idea === 'vistek:v-planted');
    check('planted ineligible: parks in its source as de_discutat', park && park.tool === 'mcp__vistek__ideas_set_status' && park.args.status === 'de_discutat', JSON.stringify(park));
    check('skipped idea: writes nothing', !out.some((w) => w.idea === 'vistek:v-miki'));
}

// --- idempotent: the same export again conveys nothing twice.
{
    const before = ledger().length;
    const r = intake('vistek', vistekFile);
    check('re-intake: every idea unchanged', r.value && r.value.counts.unchanged === 4, JSON.stringify(r.value && r.value.counts));
    check('re-intake: no new ledger record', ledger().length === before);
    const changed = writeIdeas('vistek2.json', [vistekRow('v-planted', ELIGIBLE_TEXT.replace('print', 'copy')), eligible]);
    const r2 = intake('vistek', changed);
    check('re-intake: a parked idea whose text changed is judged again', r2.value && r2.value.counts.feature === 1 && r2.value.counts.unchanged === 1, JSON.stringify(r2.value && r2.value.counts));
}

// --- G6 receipts: the note waits for the mirror idea, then carries its id.
{
    const bad = cli(withState(['receipt', '--idea', 'vistek:v-eligible', '--stage', 'C6', '--command', 'npm run gate', '--exit', 'green']));
    check('receipt: a non-integer exit is refused', bad.code === 'usage', bad.stdout);
    const r = cli(withState(['receipt', '--idea', 'vistek:v-eligible', '--stage', 'C6', '--command', 'npm run gate', '--exit', '0', '--artifact', 'https://github.com/o/r/pull/1']));
    check('receipt: recorded', r.status === 0 && r.value.receipt.exit === 0, r.stdout);
    const id = r.value && r.value.receipt.outbox;
    let ob = cli(withState(['outbox'])).value;
    const note = ob.writes.find((w) => w.id === id);
    check('receipt: queued as a hub note, blocked until the mirror exists', note && note.tool === 'mcp__nvision-hub__hub_notes_add' && note.blocked === true, JSON.stringify(note));
    check('receipt: body carries command, exit and artifact', note && /npm run gate` exit 0\. Artifact: https:\/\/github\.com\/o\/r\/pull\/1/.test(note.args.body), note && note.args.body);
    const early = cli(withState(['outbox-done', '--id', id]));
    check('outbox-done: a blocked write cannot be marked sent', early.code === 'bad-state', early.stdout);
    const mirror = state().ideas['vistek:v-eligible'].mirrorOutbox;
    const noId = cli(withState(['outbox-done', '--id', mirror]));
    check('outbox-done: a create without its result id is refused', noId.code === 'usage', noId.stdout);
    const MIRROR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    check('outbox-done: the mirror add records its id', cli(withState(['outbox-done', '--id', mirror, '--result-id', MIRROR])).status === 0);
    ob = cli(withState(['outbox'])).value;
    const ready = ob.writes.find((w) => w.id === id);
    check('receipt: the note is ready with the mirror id filled', ready && ready.blocked === false && ready.args.ideaId === MIRROR, JSON.stringify(ready));
}

// --- G2 review points: silence approves once the next stage starts; a person's pick wins.
{
    const rp = (stage, extra = []) => cli(withState(['review-point', '--idea', 'vistek:v-eligible', '--stage', stage, '--question', 'Totals layout',
        '--option', 'a=Totals under the items', '--option', 'b=Totals in a side column', '--recommended', 'b', '--row', 'DY3: totals keep + TVA beside each price', ...extra]));
    const r = rp('C1');
    check('review-point: recorded', r.status === 0, r.stdout);
    const d = r.value && r.value.decision;
    check('review-point: recommended option first and labelled', d && d.options[0].key === 'b' && /\(Recommended\)$/.test(d.options[0].label), JSON.stringify(d && d.options));
    check('review-point: Decided-for-you row is in the question', d && d.question.includes('DY3: totals keep + TVA'));
    check('review-point: code fits the hub pattern', d && /^[A-Z][A-Z0-9-]{0,15}$/.test(d.code), d && d.code);
    check('review-point: a recommendation that is not an option is refused', rp('C2', ['--recommended', 'zz']).code === 'usage');
    const blocking = rp('C6', ['--blocking']);
    check('review-point: a blocking one records', blocking.status === 0 && blocking.value.decision.approvesAt === null);

    let t = cli(withState(['tick', '--ledger', LEDGER])).value;
    check('silence: nothing approved while C2 is still queued', t && !t.events.some((e) => e.event === 'silence-approved'), JSON.stringify(t && t.events));
    const short = state().ideas['vistek:v-eligible'].short;
    editLedger((rec) => { if (rec.slug === `cv-${short}-c2` || rec.slug === `cv-${short}-c7`) rec.state = 'started'; });
    t = cli(withState(['tick', '--ledger', LEDGER])).value;
    const approved = t.events.filter((e) => e.event === 'silence-approved');
    check('silence: C1 decision approved once C2 started, with the recommended pick', approved.length === 1 && approved[0].code === d.code && approved[0].pick === 'b', JSON.stringify(t.events));
    check('silence: a blocking decision is never approved by silence', state().decisions[blocking.value.decision.code].state === 'open');
    // Two guards stand between a blocking decision and silence: it records no
    // approvesAt, and tick skips blocking. Give it an approvesAt so the second is tested alone.
    {
        const s = state();
        const bcode = blocking.value.decision.code;
        s.decisions[bcode].approvesAt = ledger().find((x) => x.slug === `cv-${short}-c7`).taskId;
        fs.writeFileSync(STATE, JSON.stringify(s));
        cli(withState(['tick', '--ledger', LEDGER]));
        check('silence: tick skips a blocking decision even with a started next stage', state().decisions[bcode].state === 'open', state().decisions[bcode].state);
    }
    const pickWrite = state().outbox.find((w) => w.tool === 'mcp__nvision-hub__hub_decisions_pick' && w.decision === d.code);
    check('silence: queues the hub pick, waiting on the decision add', pickWrite && pickWrite.needs === d.outbox && pickWrite.args.pick === 'b', JSON.stringify(pickWrite));

    const c6 = rp('C7');
    const decisions = writeIdeas('decisions.json', [{ code: c6.value.decision.code, pick: 'a' }]);
    t = cli(withState(['tick', '--ledger', LEDGER, '--decisions', decisions])).value;
    const picked = t.events.find((e) => e.code === c6.value.decision.code);
    check("person: a person's pick wins over silence and is flagged as overturned", picked && picked.event === 'picked' && picked.pick === 'a' && picked.overturned === true, JSON.stringify(t.events));
}

// --- the full website: grill and spec only, then one blocking start decision, then nothing.
{
    const site = { id: 'f0f0f0f0-0000-4000-8000-000000000001', title: '#claude Plant shop', summary: 'Build a new website for a plant shop with a care calendar.', status: 'new' };
    const r = intake('hub', writeIdeas('hub.json', [site]));
    check('full website: intake exit 0', r.status === 0, r.stdout);
    const key = `hub:${site.id}`;
    const entry = state().ideas[key];
    check('full website: classified', entry && entry.class === 'full-website', JSON.stringify(entry));
    const mine = () => ledger().filter((x) => x.slug.startsWith(`cv-${entry.short}-`));
    check('full website: only C1 and C2 enqueued, in the planning repo', mine().length === 2 && mine().every((x) => x.repo === planningRepo) && mine().map((x) => x.slug.slice(-2)).join() === 'c1,c2',
        mine().map((x) => x.slug).join());
    const go = entry.startDecision;
    check('full website: start decision waits for spec, not yet posted', state().decisions[go].state === 'waiting-spec' && !state().outbox.some((w) => w.decision === go));
    let t = cli(withState(['tick', '--ledger', LEDGER])).value;
    check('full website: tick does not post while spec is unfinished', state().decisions[go].state === 'waiting-spec' && t.events.some((e) => e.code === go && e.event === 'waiting'));
    editLedger((x) => { if (x.slug.startsWith(`cv-${entry.short}-`)) Object.assign(x, { state: 'closed', runStatus: 'succeeded', verdict: { decision: 'accept', by: 'brain' } }); });
    t = cli(withState(['tick', '--ledger', LEDGER])).value;
    const add = state().outbox.find((w) => w.decision === go && w.tool === 'mcp__nvision-hub__hub_decisions_add');
    check('full website: once spec is accepted, one blocking start decision is queued', add && add.args.code === go && add.args.options[0].key === 'start' && add.args.projectId === PROJECT, JSON.stringify(add));
    check('full website: still only two ledger records', mine().length === 2);
    t = cli(withState(['tick', '--ledger', LEDGER])).value;
    check('full website: silence never starts it', state().decisions[go].state === 'open' && mine().length === 2, state().decisions[go].state);
    cli(withState(['outbox-done', '--id', add.id, '--result-id', 'cccccccc-0000-4000-8000-000000000001']));
    t = cli(withState(['tick', '--ledger', LEDGER, '--decisions', writeIdeas('go.json', { decisions: [{ code: go, pick: 'start' }] })])).value;
    check('full website: a start pick is recorded as start-approved', state().decisions[go].state === 'start-approved', JSON.stringify(t.events));
    check('full website: and enqueues no build stage here', mine().length === 2);
    const note = state().outbox.find((w) => w.idea === key && w.tool === 'mcp__nvision-hub__hub_notes_add');
    check('full website: hub idea notes go straight onto the idea', note && note.args.ideaId === site.id && !note.needs, JSON.stringify(note));
}

// --- one start per pass: the rest are held, written nowhere, and judged again next pass.
{
    const limState = path.join(scratch, 'limit', 'state.json');
    const limLedger = path.join(scratch, 'limit-ledger.json');
    const two = writeIdeas('two.json', [vistekRow('v-lim-a', ELIGIBLE_TEXT), vistekRow('v-lim-b', ELIGIBLE_TEXT.replace('print', 'share'))]);
    const pass1 = (extra = []) => cli(['intake', '--source', 'vistek', '--ideas', two, '--config', CONFIG, '--state', limState, '--ledger', limLedger, ...extra]);
    const r = pass1();
    const v = r.value || {};
    check('limit: two eligible ideas, the default starts one', v.counts && v.counts.feature === 2 && v.counts.held === 1, JSON.stringify(v.counts));
    const held = (v.results || []).filter((x) => x.held === 'limit').map((x) => x.key);
    check('limit: the second in input order is the one held', held.join() === 'vistek:v-lim-b', held.join());
    const s = JSON.parse(fs.readFileSync(limState, 'utf8'));
    check('limit: the held idea is not in state', !s.ideas['vistek:v-lim-b'] && s.ideas['vistek:v-lim-a'], Object.keys(s.ideas).join());
    const recs = JSON.parse(fs.readFileSync(limLedger, 'utf8')).records;
    check('limit: only one chain reaches the ledger', recs.length === 6, String(recs.length));
    const r2 = pass1();
    check('limit: the next pass starts the held idea', r2.value && r2.value.counts.feature === 1 && r2.value.counts.held === 0 && r2.value.counts.unchanged === 1, JSON.stringify(r2.value && r2.value.counts));
    check('limit: --limit 0 is refused', pass1(['--limit', '0']).code === 'usage');
}

// --- refusals that guard the inputs.
{
    check('usage: an unknown command is refused', cli(['nope']).code === 'usage');
    check('usage: a flag the command does not read is refused', cli(withState(['outbox', '--idea', 'x'])).code === 'usage');
    const badCfg = path.join(scratch, 'bad-config.json');
    fs.writeFileSync(badCfg, JSON.stringify({ ...config, hub: {} }));
    check('config: a missing Conveyor project is refused before any idea is read', cli(withState(['intake', '--source', 'vistek', '--ideas', vistekFile, '--config', badCfg])).code === 'config-invalid');
    const help = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', env });
    check('help: returns usage, exit 0', help.status === 0 && /Usage: node idea-conveyor\.js intake/.test(help.stdout));
}

// --- status, and the default state and ledger under the sandboxed HOME.
{
    const s = cli(withState(['status']));
    check('status: reads the state the run wrote', s.status === 0 && path.resolve(s.value.state) === path.resolve(STATE) && s.value.ideasRead === Object.keys(state().ideas).length && s.value.ideasRead > 0, s.stdout.slice(0, 300));
    const bare = cli(['status']);
    const defaultFile = path.join(home, '.claude', 'autodev', 'conveyor', 'state.json');
    check('status: with no --state reads the config dir default, empty there', bare.status === 0 && path.resolve(bare.value.state) === path.resolve(defaultFile) && bare.value.ideasRead === 0, bare.stdout.slice(0, 300));
    const t = cli(['tick']);
    check('tick: with no --ledger reads the config dir default and starts nothing', t.status === 0, t.stdout.slice(0, 300));
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} checks`);
process.exitCode = fail ? 1 : 0;
