'use strict';
const fs=require('node:fs'),path=require('node:path');const {execFileSync}=require('node:child_process');const {randomUUID}=require('node:crypto');
const {execute,digest,canonical}=require('../plugins/autodev-core/scripts/mission-store.js');const {fixtureScope}=require('./synthetic-adapter.cjs');
const send=m=>new Promise(resolve=>{if(process.connected)process.send(m,()=>resolve());else resolve()});
const release=()=>new Promise(resolve=>process.once('message',m=>resolve(m)));
process.once('message',async ({root,store,fence,nonce,mode})=>{try{
 fixtureScope(root,store);const command=(c,p={})=>execute(c,store,{...fence,eventId:randomUUID(),...p});const s=execute('status',store,{missionId:fence.missionId}),c=s.mission.contract;
 if(fs.realpathSync(process.cwd())!==c.repo.root||canonical(c.scope.paths)!==canonical(['owned.js'])||!c.repo.root.startsWith(root+path.sep)||!c.scope.effects.includes('write'))throw Error('context-invalid');
 if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()!==c.repo.baseSha)throw Error('context-invalid');
 if(mode==='hold-before-register'){await send({kind:'held-before-register'});await release()}
 const identity={host:'synthetic-local',pid:process.pid,nonce};command('register-executor',{identity});await send({kind:'registered',identity});
 if(mode==='hold-after-register'){await send({kind:'held-after-register'});await release()}
 if(mode==='blocked'){await send({kind:'completion',hookStatus:'blocked',nativeStatus:'completed',items:[],itemsView:'notLoaded'});process.disconnect();return}
 fs.appendFileSync(path.join(store,'synthetic-starts.jsonl'),JSON.stringify(identity)+'\n',{mode:0o600});
 const content='module.exports = () => ({ ok: true, source: "owned-synthetic-worker" });\n';
 // This fixed worker never changes cwd. A relative destination stays anchored
 // to that admitted directory even if its external pathname is renamed.
 const target='owned.js', previous=fs.lstatSync(target,{throwIfNoEntry:false});
 if(previous?.isSymbolicLink())throw Error('artifact-symlink');
 if(previous && (!previous.isFile() || previous.nlink!==1))throw Error('artifact-linked-or-nonregular');
 // Stage in the private control store, then atomically replace the directory
 // entry. Never truncate/follow a destination before its link checks. Rename
 // also prevents a late symlink/hardlink swap from redirecting the write.
 const temporary=path.join(store,'artifact-'+randomUUID()+'.tmp');let fd;
 try{
  fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,content);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temporary,target);const dir=fs.openSync('.','r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary)}catch(e){if(e.code!=='ENOENT')throw e}}
 if(mode==='hold-after-write'){await send({kind:'held-after-write'});await release()}
 const result={resultId:'result-'+fence.attemptId,contractHash:mode==='wrong-envelope'?'b'.repeat(64):s.mission.contractHash,repoId:c.repo.id,baseSha:c.repo.baseSha,candidateSha:mode==='wrong-candidate'?'d'.repeat(40):c.repo.baseSha,acceptanceIds:c.acceptance.map(a=>a.id),artifacts:[{path:'owned.js',sha256:digest(content)}]};
 command('enqueue-result',{messageId:'message-'+fence.attemptId,result,artifactBundle:[{path:'owned.js',content}]});
 await send({kind:'completion',hookStatus:mode==='blocked-with-artifact'?'blocked':'completed',nativeStatus:'completed'});process.disconnect();
 }catch(e){await send({kind:'refused',code:e.publicCode||e.message});process.exitCode=1;if(process.connected)process.disconnect()}});
