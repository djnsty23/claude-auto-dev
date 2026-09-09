#!/usr/bin/env node
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const subject = path.resolve(process.argv[2] || path.join(__dirname, '../plugins/autodev-memory/scripts/memory-db.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-conflict-'));
let passed = 0, failed = 0;
function check(name, ok) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); ok ? passed++ : failed++; }
try {
  const run = spawnSync(process.execPath, ['-e', `
    const m=require(${JSON.stringify(subject)}),{DatabaseSync}=require('node:sqlite'),p='/fixture/project';
    const first=m.startSession(p),second=m.startSession(p),db=new DatabaseSync(require('node:path').join(process.env.CLAUDE_CONFIG_DIR,'auto-dev-memory.db'));
    const ids=[];function add(sessionId,concept,file){const id=m.saveObservation({sessionId,projectPath:p,type:'decision',title:'Configuration decision',concept,sourceFiles:[file]});if(!id)throw Error('seed refused');ids.push(id);db.exec("UPDATE observations SET timestamp='2020-01-01 00:00:00'")}
    add(first,'Enable validation','src/auth/config.js');add(first,'Disable validation','src/auth/config.js');add(second,'Enable validation','src/auth/config.js');add(second,'Enable validation','src/auth/other.js');
    const before=m.getStats(p),brief=m.knowledge(p,'src/auth'),repeat=m.knowledge(p,'src/auth'),empty=m.knowledge(p,'src/missing'),after=m.getStats(p);
    const pa='/fixture/duplicate-a',pb='/fixture/duplicate-b',sa=m.startSession(pa),sb=m.startSession(pb);
    const save=(sessionId,projectPath,file,concept='Same decision')=>m.saveObservation({sessionId,projectPath,type:'decision',title:'Scope control',concept,sourceFiles:[file]});
    const writer={first:save(sa,pa,'src/a.js'),same:save(sa,pa,'src/a.js'),otherProject:save(sb,pb,'src/a.js'),otherFile:save(sa,pa,'src/b.js'),positive:save(sb,pb,'src/a.js','Different decision')};
    console.log(JSON.stringify({ids,first,second,before,brief,repeat,empty,after,writer,rendered:m.renderKnowledgeBrief(brief,'src/auth')}));db.close();
  `], { cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'store') } });
  check('actual API seeds and reads isolated store', run.status === 0);
  if (run.status !== 0) throw Error(run.stderr);
  const r = JSON.parse(run.stdout), rows = r.brief.groups.decisions;
  check('known-positive corpus contains four stored observations', r.before.totalObservations === 4 && r.ids.length === 4);
  check('distinct concepts and source files produce three groups', r.brief.total === 3 && rows.length === 3);
  check('conflicting decision remains retrievable', rows.some(x => x.concept === 'Disable validation'));
  check('same-second newest representative uses insertion order', rows.some(x => x.id === r.ids[2]));
  check('same-second order is deterministic', JSON.stringify(rows.map(x => x.id)) === JSON.stringify([r.ids[3], r.ids[2], r.ids[1]]));
  check('exact duplicate retains both observation identities', rows.some(x => JSON.stringify(x.observationIds) === JSON.stringify([r.ids[2], r.ids[0]])));
  check('every original identity survives grouping exactly once', JSON.stringify(rows.flatMap(x => x.observationIds || []).sort()) === JSON.stringify([...r.ids].sort()));
  check('representative retains actual session provenance', rows.some(x => x.id === r.ids[2] && x.session_id === r.second));
  check('both conflicting decisions appear in rendered brief', r.rendered.includes('Enable validation') && r.rendered.includes('Disable validation'));
  check('repeated reads preserve order and grouping', JSON.stringify(r.brief) === JSON.stringify(r.repeat));
  check('read grouping never deletes stored observations', r.after.totalObservations === 4);
  check('unmatched area is a valid empty result', r.empty.total === 0);
  check('writer positive control saves first payload', typeof r.writer.first === 'string');
  check('same project and source duplicate remains suppressed', r.writer.same === null);
  check('another project retains its identical decision', typeof r.writer.otherProject === 'string');
  check('another source context retains its identical decision', typeof r.writer.otherFile === 'string');
  check('other project writer succeeds for different content too', typeof r.writer.positive === 'string');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`population: ${passed + failed} assertions run, ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
