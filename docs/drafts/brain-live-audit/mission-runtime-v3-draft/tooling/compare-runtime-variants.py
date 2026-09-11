from pathlib import Path
import tempfile,shutil,subprocess,json,os,hashlib,signal
base=Path(__file__).resolve().parent.parent
root=Path(tempfile.mkdtemp(prefix='mission-v2-variant-')).resolve()
results=[]
def run(label,entry,script,case=None):
 env=os.environ.copy()
 if case:env['MISSION_CASE']=case
 if entry:env['MISSION_TEST_ENTRY']=str(entry)
 child=subprocess.Popen(['node',str(script)],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
 try:output,_=child.communicate(timeout=30)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGKILL);output,_=child.communicate();raise RuntimeError('owned variant group timed out: '+label)
 (base/(label+'.log')).write_text(output)
 summary=json.loads(output.splitlines()[-1]);results.append({'criterion':label,'exit':child.returncode,'summary':summary,'actualFailure':[l for l in output.splitlines() if l.startswith('FAIL ')]})
try:
 run('baseline-store-boundaries',base.parent/'mission-store-draft/plugins/autodev-core/scripts/mission-store.js',base/'tooling/test-runtime-boundaries.js')
 run('proposal-store-boundaries',None,base/'tooling/test-runtime-boundaries.js')
 run('proposal-durable-result',None,base/'tooling/test-synthetic-runtime.js','close-receipt-recovers-worker-store-gap')
 dest=root/'best-effort';shutil.copytree(base,dest,ignore=shutil.ignore_patterns('*.json','*.log','*.diff','__pycache__'))
 p=dest/'plugins/autodev-core/scripts/mission-store.js';s=p.read_text();lines=s.splitlines();hits=[i for i,l in enumerate(lines) if 'INSERT INTO outbox(' in l];assert len(hits)==1;lines[hits[0]]='    // Measured best-effort variant: acknowledge staging without a durable outbox row.';p.write_text('\n'.join(lines)+'\n')
 run('alternative-store-boundaries',None,dest/'tooling/test-runtime-boundaries.js')
 run('alternative-durable-result',None,dest/'tooling/test-synthetic-runtime.js','close-receipt-recovers-worker-store-gap')
 run('alternative-execution-control',None,dest/'tooling/test-synthetic-runtime.js','unknown-and-live-hold-until-owned-close-recovery')
 assert [r['summary']['passed'] for r in results]==[0,4,1,4,0,1]
finally:shutil.rmtree(root)
(base/'comparison-results.json').write_text(json.dumps({'results':results,'interpretation':'The frozen store lacks the four new boundaries (0/4); v2 and the simpler best-effort variant both pass those 4/4. The best-effort variant still executes one actual synthetic worker but loses its result at adapter recreation (0/1 durable-result case; separate execution control1/1). V2 passes durable recovery1/1. This is a behavioral comparison, not timing or exactly-once proof.','fixtureRemoved':not root.exists()},indent=2)+'\n')
print(json.dumps({'variants':3,'criteria':len(results),'passedByCriterion':[r['summary']['passed'] for r in results],'fixtureRemoved':not root.exists()}))
