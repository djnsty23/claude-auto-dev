'use strict';
// Fixture-only execution port. This is deliberately not a native/model adapter.
const fs=require('node:fs'),path=require('node:path');
const {fork,execFileSync}=require('node:child_process');const {randomUUID}=require('node:crypto');
const {execute,canonical,digest}=require('../plugins/autodev-core/scripts/mission-store.js');
function inside(root,p){return p!==root && p.startsWith(root+path.sep)}
function fixtureScope(root,store){if(fs.realpathSync(root)!==root || !inside(root,store) || JSON.parse(fs.readFileSync(path.join(root,'.synthetic-mission-fixture'),'utf8')).owned!==true)throw Error('owned-fixture-required');const st=fs.lstatSync(root);if(!st.isDirectory() || st.isSymbolicLink() || (st.mode&0o077))throw Error('private-fixture-required')}
function atomic(file,value){const temp=file+'.'+randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}}finally{if(fd!==undefined&&fd!==null)fs.closeSync(fd);try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}}}
// Independent committed-tree readback: Git diff suppresses assume-unchanged and
// skip-worktree entries. Compare actual bytes without changing either index flag.
function outsideScopeUnchanged(repo,baseSha){
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{timeout:3000,stdio:['ignore','pipe','pipe']});
 const raw=new (require('node:util').TextDecoder)('utf-8',{fatal:true}).decode(git('ls-tree','-rz',baseSha));
 for(const record of raw.split('\0').filter(Boolean)){
  const match=/^([0-7]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record);
  if(!match)throw Error('unsupported-tree-entry');
  const [,mode,type,oid,name]=match;if(name==='owned.js')continue;
  const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||p==='.git'))throw Error('unsupported-tree-path');
  let parent=repo;for(const part of parts.slice(0,-1)){parent=path.join(parent,part);const st=fs.lstatSync(parent);if(!st.isDirectory()||st.isSymbolicLink())return false;}
  const file=path.join(repo,name),stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)return false;
  if(type!=='blob'||!['100644','100755','120000'].includes(mode))throw Error('unsupported-tree-entry');
  let actual;
  if(mode==='120000'){if(!stat.isSymbolicLink())return false;actual=fs.readlinkSync(file,{encoding:'buffer'});}
  else{if(!stat.isFile()||stat.isSymbolicLink()||Boolean(stat.mode&0o111)!==(mode==='100755'))return false;actual=fs.readFileSync(file);}
  if(!actual.equals(git('cat-file','blob',oid)))return false;
 }
 return true;
}
class SyntheticAdapter{
 constructor(root,store){fixtureScope(root,store);this.root=root;this.store=store;this.children=new Set();this.sequence=0}
 call(command,p){return execute(command,this.store,p)}
 status(missionId){return this.call('status',{missionId})}
 command(f,command,p={}){return this.call(command,{...f,eventId:randomUUID(),...p})}
 async start(f,{mode='normal',skipCloseStore=false}={}){
  const s=this.status(f.missionId),c=s.mission.contract;
  if(!inside(this.root,c.repo.root) || canonical(c.scope.paths)!==canonical(['owned.js']) || c.target.kind!=='local' || !c.scope.effects.includes('write'))throw Error('synthetic-scope-required');
  let l=s.launches.find(l=>l.attempt_id===f.attemptId);
  if(!l){this.command(f,'prepare-start',{operationKey:'synthetic-'+f.attemptId,expectedRevision:s.mission.revision});l=this.status(f.missionId).launches.find(l=>l.attempt_id===f.attemptId)}
  if(l.state!=='prepared')return {state:'reconcile-required',observation:this.reconcile(f)};
  const nonce=randomUUID();this.command(f,'authorize-bootstrap',{nonce});const child=fork(path.join(__dirname,'synthetic-worker.cjs'),[],{cwd:mode==='wrong-cwd'?this.root:c.repo.root,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});
  this.children.add(child);const messages=[];let stderr='';child.stderr.on('data',d=>stderr+=d);child.stdout.resume();
  child.on('message',m=>messages.push(m));
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{this.children.delete(child);const identity={host:'synthetic-local',pid:child.pid,nonce};let persistenceError=null;try{const completion=messages.find(m=>m.kind==='completion');const observation={kind:'terminal',exitCode:code,hookStatus:completion?.hookStatus||'unknown',nativeStatus:completion?.nativeStatus||'unknown'};this.status(f.missionId);atomic(path.join(this.store,'close-'+f.attemptId+'-'+nonce+'.json'),{fence:f,identity,observation,source:'owned-child-close',signal});if(!skipCloseStore){const current=this.status(f.missionId).launches.find(l=>l.attempt_id===f.attemptId);if(current?.identity_json===canonical(identity))this.command(f,'observe-worker',{identity,observation})}}catch(e){persistenceError=e.publicCode||e.message}resolve({code,signal,messages,stderr,persistenceError})})});
  child.send({root:this.root,store:this.store,fence:f,nonce,mode});
  return {state:'helper-created',child,done,messages,identity:{host:'synthetic-local',pid:child.pid,nonce}};
 }
 reconcile(f){
  const s=this.status(f.missionId),l=s.launches.find(l=>l.attempt_id===f.attemptId);if(!l)return {state:'not-requested'};
  if(l.state==='terminal'||l.state==='never-started')return {state:l.state,observation:l.observation_json&&JSON.parse(l.observation_json)};
  if(l.state==='prepared')return {state:'prepared',executionObserved:false};
  const identity=JSON.parse(l.identity_json),file=path.join(this.store,'close-'+f.attemptId+'-'+identity.nonce+'.json');
  if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw Error('invalid-close-receipt');const receipt=JSON.parse(fs.readFileSync(file,'utf8'));if(canonical(receipt.fence)!==canonical(f)||canonical(receipt.identity)!==canonical(identity)||receipt.source!=='owned-child-close')throw Error('close-receipt-mismatch');this.command(f,'observe-worker',{identity,observation:receipt.observation});return {state:'terminal',observation:receipt.observation,recovered:true}}
  try{this.command(f,'poll-worker')}catch(e){if(['backoff-active','reconciliation-exhausted'].includes(e.publicCode))return {state:e.publicCode,reservationHeld:true};throw e}
  const child=[...this.children].find(c=>c.pid===identity.pid&&c.exitCode===null&&c.signalCode===null);
  const kind=child?'live':'unknown';this.command(f,'observe-worker',{identity,observation:{kind,exitCode:null,hookStatus:'unknown',nativeStatus:'unknown'}});return {state:kind,reservationHeld:true};
 }
 deliver(missionId,{dropAck=false,wrongAck=false,unavailable=false}={}){
  const s=this.status(missionId),reports=[];
  for(const row of s.outbox.filter(r=>r.state!=='acked')){
   // A local durable ingestion receipt can repair lost ACK without spending a send.
   // Its historical disposition is not current execution or acceptance authority.
   const saved=s.results.find(r=>r.attempt_id===row.attempt_id);
   if(saved){try{const receipt=JSON.parse(saved.ingestion_receipt);this.call('ack-delivery',{missionId,eventId:randomUUID(),messageId:row.message_id,receipt:wrongAck?{...receipt,receiverId:'wrong-receiver'}:receipt});reports.push({messageId:row.message_id,state:'acked'});continue}catch(e){if(e.publicCode!=='ack-mismatch')throw e;reports.push({messageId:row.message_id,state:e.publicCode});continue}}
   if(row.state==='exhausted'){reports.push({messageId:row.message_id,state:'delivery-exhausted'});continue}
   if(reports.filter(r=>r.sendAttempted).length>=3)break;
   let delivery;try{delivery=this.call('begin-delivery',{missionId,eventId:randomUUID(),messageId:row.message_id})}catch(e){reports.push({messageId:row.message_id,state:e.publicCode});continue}
   if(unavailable){reports.push({messageId:row.message_id,state:'unavailable',sendAttempted:true});continue}
   const p=delivery.payload,receipt=this.call('receive',{missionId,eventId:randomUUID(),owner:p.owner,attemptId:p.attemptId,generation:p.generation,result:p.result});
   if(dropAck){reports.push({messageId:row.message_id,state:'ack-lost',receipt,sendAttempted:true});continue}
   try{this.call('ack-delivery',{missionId,eventId:randomUUID(),messageId:row.message_id,receipt:wrongAck?{...receipt,receiverId:'wrong-receiver'}:receipt});reports.push({messageId:row.message_id,state:'acked',sendAttempted:true})}catch(e){reports.push({messageId:row.message_id,state:e.publicCode,sendAttempted:true})}
  }
  return reports;
 }
 reviewReadiness(f){const s=this.status(f.missionId);if(s.mission.activeAttempt!==f.attemptId||s.mission.owner!==f.owner||s.mission.generation!==f.generation)return {state:'stale-owner',verified:false};const l=s.launches.find(l=>l.attempt_id===f.attemptId),o=l?.observation_json&&JSON.parse(l.observation_json);if(l?.state!=='terminal'||o?.exitCode!==0||o?.hookStatus!=='completed'||o?.nativeStatus!=='completed')return {state:'execution-incomplete',verified:false};const r=s.results.find(r=>r.attempt_id===f.attemptId&&['received','envelope-accepted'].includes(r.state));if(!r)return {state:'result-missing',verified:false};const b=s.outbox.find(b=>b.attempt_id===f.attemptId&&b.state==='acked');if(!b)return {state:'delivery-incomplete',verified:false};const payload=JSON.parse(b.payload_json),c=s.mission.contract,e=r.envelope;if(e.contractHash!==s.mission.contractHash||e.repoId!==c.repo.id||e.baseSha!==c.repo.baseSha||e.candidateSha!==c.repo.baseSha||canonical([...e.acceptanceIds].sort())!==canonical(c.acceptance.map(a=>a.id).sort()))return {state:'envelope-mismatch',verified:false};try{const git=(...args)=>execFileSync('git',['-C',c.repo.root,...args],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).trim();if(fs.realpathSync(c.repo.root)!==c.repo.root||fs.realpathSync(git('rev-parse','--show-toplevel'))!==c.repo.root||fs.realpathSync(git('rev-parse','--path-format=absolute','--git-common-dir'))!==c.repo.commonDir||git('rev-parse','HEAD')!==c.repo.baseSha)return {state:'context-mismatch',verified:false};const names=(...args)=>execFileSync('git',['-C',c.repo.root,...args],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean);const changed=[...names('diff','--name-only','-z','HEAD'),...names('diff','--cached','--name-only','-z','HEAD'),...names('ls-files','--others','--exclude-standard','-z'),...names('ls-files','--others','--ignored','--exclude-standard','-z')];if(changed.some(name=>name!=='owned.js')||!outsideScopeUnchanged(c.repo.root,c.repo.baseSha))return {state:'scope-mismatch',verified:false}}catch{return {state:'context-mismatch',verified:false}}for(const a of payload.artifactBundle){const file=path.join(s.mission.contract.repo.root,a.path);try{if(fs.lstatSync(file).isSymbolicLink()||fs.readFileSync(file,'utf8')!==a.content||digest(a.content)!==r.envelope.artifacts.find(x=>x.path===a.path)?.sha256)return {state:'artifact-mismatch',verified:false}}catch{return {state:'artifact-missing',verified:false}}}return {state:'review-ready',verified:false,candidate:{kind:'inline-artifact-manifest',hash:digest(canonical(payload.artifactBundle))},baseSha:r.envelope.baseSha};}
 async cleanup(){const children=[...this.children];await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('close',resolve);child.kill('SIGKILL')})));return {remainingChildren:this.children.size}}
}
module.exports={SyntheticAdapter,fixtureScope,atomic};
