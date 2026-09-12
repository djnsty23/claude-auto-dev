from pathlib import Path
import tempfile,shutil,subprocess,json,os,hashlib,signal
base=Path(__file__).resolve().parent.parent
store='plugins/autodev-core/scripts/mission-store.js';adapter='fixtures/synthetic-adapter.cjs'
mutants=[
 ('duplicate-registration',store,"requireThat(l.state==='prepared' && !l.identity_json,'executor-already-registered');","requireThat(true,'executor-already-registered');",'duplicate-helper-registration-allows-one-worker','one execution despite duplicate live helper processes'),
 ('unsafe-release',store,"requireThat(!launch || ['prepared','terminal','never-started'].includes(launch.state), 'worker-disposition-unknown');","requireThat(true, 'worker-disposition-unknown');",'unknown-and-live-hold-until-owned-close-recovery','unknown execution retains checkout'),
 ('wrong-ack',store,"requireThat(p.receipt.receiverId===row.receiver_id && p.receipt.envelopeHash===digest(canonical(payload.result)) && saved && canonical(p.receipt)===saved.ingestion_receipt,'ack-mismatch');","requireThat(true,'ack-mismatch');",'lost-and-wrong-ack-do-not-start-another-worker','wrong receiver cannot clear pending delivery'),
 ('ignore-required-hook',adapter,"||o?.hookStatus!=='completed'",'', 'required-hook-failure-refuses-existing-valid-artifact','blocked required hook must prevent review readiness even with valid output'),
 ('replay-send-budget',store,"if (command === 'begin-delivery') fault('delivery-already-issued');",'', 'transport-replay-cannot-renew-send-budget','delivery-already-issued'),
]
# Predicted assertion names above are fixed before execution. Every copy runs a
# separate unmodified happy-path control, not merely node --check.
results=[];root=Path(tempfile.mkdtemp(prefix='mission-v2-mutants-')).resolve()
def run(candidate,case,name):
 env={**os.environ,'MISSION_CASE':case,'MISSION_TEST_REPORT':str(base/(name+'.json'))}
 child=subprocess.Popen(['node',str(candidate/'tooling/test-synthetic-runtime.js')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,env=env,start_new_session=True)
 try: output,_=child.communicate(timeout=40)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGKILL);output,_=child.communicate();raise RuntimeError('owned mutation group timed out: '+name)
 (base/(name+'.log')).write_text(output)
 data=json.loads((base/(name+'.json')).read_text());return child.returncode,data
try:
 for name,rel,old,new,case,expected in mutants:
  dest=root/name;shutil.copytree(base,dest,ignore=shutil.ignore_patterns('*.log','*.json','*.diff','README.md','__pycache__'))
  p=dest/rel;s=p.read_text();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
  check=subprocess.run(['node','--check',str(p)],capture_output=True,text=True);assert check.returncode==0,check.stderr
  code,r=run(dest,case,'mutation-'+name);control_code,control=run(dest,'happy-path-real-child-artifact-loopback','control-'+name)
  # The duplicate case might fail its winner cardinality first; both are the same
  # safety boundary but report the exact assertion rather than claiming a later one ran.
  errors='\n'.join(x.get('error','') for x in r['results'])
  detected=code==1 and r['summary']['failed']==1 and r['results'][0]['id']==case
  results.append({'name':name,'targetCase':case,'predictedAssertion':expected,'matchedPredictedText':expected in errors,'detected':detected,'actualError':errors,'control':control['summary'],'mutationSummary':r['summary'],'sourceSha256':hashlib.sha256(p.read_bytes()).hexdigest()})
  assert detected and expected in errors and control_code==0 and control['summary']['passed']==1,name
finally:shutil.rmtree(root)
(base/'mutation-results.json').write_text(json.dumps({'results':results,'summary':{'detected':sum(r['detected'] for r in results),'population':len(results),'positiveControls':sum(r['control']['passed'] for r in results),'fixtureRemoved':not root.exists()}},indent=2)+'\n')
print(json.dumps({'detected':len(results),'population':len(results),'positiveControls':len(results),'fixtureRemoved':not root.exists()}))
