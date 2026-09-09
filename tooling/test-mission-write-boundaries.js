'use strict';
// Suite for the synthetic worker's write boundary: read-only scope, a dangling
// symlink, an existing symlink and a hardlink at the artifact path must not
// write outside the owned checkout or become review-ready; the normal case must.
// Run: node tooling/test-mission-write-boundaries.js
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync,spawnSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const SUBJECT=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'..');
const entry=path.join(SUBJECT,'plugins/autodev-core/scripts/mission-store.js');
// HOST BOUNDARY. The store requires node:sqlite and POSIX ownership checks and
// answers `runtime-unavailable` without them. On such a host this suite proves
// that refusal and nothing else, and says so; it does not pass on an empty
// population, and a host that lacks the runtime but does NOT refuse is red.
{
  const posix = typeof process.getuid === 'function';
  let sqlite = false; try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch {}
  if (!(posix && sqlite)) {
    const cp = require('node:child_process'), osm = require('node:os'), fsm = require('node:fs'), pm = require('node:path');
    const dir = fsm.mkdtempSync(pm.join(fsm.realpathSync(osm.tmpdir()), 'mission-write-boundaries-host-'));
    const store = pm.join(dir, 'store');
    const r = cp.spawnSync(process.execPath, [entry, 'init', '--store', store], { input: '{}', encoding: 'utf8', timeout: 10000 });
    let out = null; try { out = JSON.parse(r.stdout); } catch {}
    const refused = r.status === 1 && out && out.ok === false && out.error && out.error.code === 'runtime-unavailable' && !fsm.existsSync(store);
    fsm.rmSync(dir, { recursive: true, force: true });
    const why = !posix ? 'POSIX ownership checks (win32)' : 'node:sqlite';
    if (!refused) { console.error('mission-write-boundaries: host lacks ' + why + ' and the store did NOT refuse explicitly: exit ' + r.status + ' ' + String(r.stdout).slice(0, 200)); process.exitCode = 1; return; }
    console.log('mission-write-boundaries: 1/1 passed — host lacks ' + why + '; the store refuses with runtime-unavailable and creates nothing. 5 POSIX+SQLite cases not run on this host.');
    return;
  }
}
const {SyntheticAdapter}=require(path.join(SUBJECT,'tooling/fixtures/mission-runtime/synthetic-adapter.cjs'));
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mission-write-boundary-'));
fs.writeFileSync(path.join(root,'.synthetic-mission-fixture'),'{"owned":true}',{mode:0o600});
const rows=[],adapters=[];
function cli(store,command,p){const r=spawnSync(process.execPath,[entry,command,'--store',store],{input:JSON.stringify(p),encoding:'utf8'});const out=JSON.parse(r.stdout);if(r.status!==0||!out.ok)throw Error(command+': '+r.stdout);return out.value;}
function fixture(name,effects){const repo=path.join(root,name),store=path.join(root,name+'-store');fs.mkdirSync(repo);const git=(...args)=>execFileSync('git',['-c','core.hooksPath='+path.join(root,'nohooks'),'-c','commit.gpgSign=false','-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init','-q');git('-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-qm','base');const baseSha=git('rev-parse','HEAD');cli(store,'init',{});const contract={repo:{id:name,root:repo,commonDir:path.join(repo,'.git'),baseSha},scope:{paths:['owned.js'],effects},target:{kind:'local',identifier:'fixture'},acceptance:[{id:'behavior',description:'Synthetic fixture only'}],retry:{maxAttempts:2,backoffMs:1,maxBackoffMs:5}};cli(store,'admit',{missionId:name,eventId:randomUUID(),contract});const c=cli(store,'claim',{missionId:name,eventId:randomUUID(),owner:'owner'}),fence={missionId:name,attemptId:c.attemptId,generation:c.generation,owner:c.owner};const adapter=new SyntheticAdapter(root,store);adapters.push(adapter);return {repo,store,git,contract,fence,adapter};}
(async()=>{try{for(const kind of ['normal','read-only','dangling-symlink','existing-symlink','hardlink']){const f=fixture(kind,kind==='read-only'?['read']:['read','write']),target=path.join(f.repo,'owned.js'),outside=path.join(root,kind+'-outside.js');if(kind==='dangling-symlink')fs.symlinkSync(outside,target);if(kind==='existing-symlink'||kind==='hardlink'){fs.writeFileSync(outside,'sentinel\n');if(kind==='existing-symlink')fs.symlinkSync(outside,target);else fs.linkSync(outside,target);}let result;let launched;try{launched=await f.adapter.start(f.fence)}catch(e){rows.push({case:kind,authorizedEffects:f.contract.scope.effects,refused:e.message,targetExists:fs.existsSync(target),outsideExists:fs.existsSync(outside)});console.log(JSON.stringify(rows[rows.length-1]));continue;}const timer=setTimeout(()=>launched.child.kill('SIGKILL'),8000);try{result=await launched.done}finally{clearTimeout(timer)}const delivery=f.adapter.deliver(f.fence.missionId),ready=f.adapter.reviewReadiness(f.fence),content=fs.existsSync(outside)?fs.readFileSync(outside,'utf8'):null;rows.push({case:kind,authorizedEffects:f.contract.scope.effects,exit:result.code,messages:result.messages,persistenceError:result.persistenceError,targetExists:fs.existsSync(target),targetSymlink:fs.lstatSync(target,{throwIfNoEntry:false})?.isSymbolicLink()||false,outsideExists:content!==null,outsideContent:content,outsideSha256:content===null?null:createHash('sha256').update(content).digest('hex'),delivery:delivery.map(x=>x.state),readiness:ready});console.log(JSON.stringify(rows[rows.length-1]));}const normal=rows.find(r=>r.case==='normal');if(normal.readiness.state!=='review-ready')throw Error('normal-control-failed');for(const r of rows.filter(r=>r.case!=='normal')){if(r.outsideContent && r.outsideContent!=='sentinel\n')throw Error('outside-write:'+r.case);if(r.case==='read-only'&&r.targetExists)throw Error('read-only-write');if(r.case==='dangling-symlink'&&r.outsideExists)throw Error('dangling-link-followed');if(r.readiness?.state==='review-ready')throw Error('unsafe-review-ready:'+r.case);}console.log(JSON.stringify({passed:rows.length,failed:0,population:rows.length}));console.log('mission-write-boundaries: ' + rows.length + '/' + rows.length + ' passed — read-only, dangling symlink, existing symlink and hardlink refused; normal control review-ready');}finally{for(const a of adapters)await a.cleanup();fs.rmSync(root,{recursive:true,force:true});if(process.env.MISSION_TEST_REPORT)fs.writeFileSync(process.env.MISSION_TEST_REPORT,JSON.stringify({rows,fixtureRemoved:!fs.existsSync(root),remainingChildren:adapters.reduce((n,a)=>n+a.children.size,0),modelCalls:0},null,2));}})().catch(e=>{console.error(e);process.exitCode=1});
