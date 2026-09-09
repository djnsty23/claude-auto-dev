from pathlib import Path
import subprocess, json, os, shutil, hashlib
base = Path(__file__).resolve().parent.parent
root = base / 'hardening-mutations'
root.mkdir(exist_ok=True)
adapter='fixtures/synthetic-adapter.cjs'; store='plugins/autodev-core/scripts/mission-store.js'
plans=[
 ('close-read-before-receipt',adapter,"atomic(path.join(this.store,'close-'","this.status(f.missionId);atomic(path.join(this.store,'close-'",'sqlite-lock-close-receipt-survives','owned close receipt survives database outage'),
 ('omit-independent-bytes',adapter,"||!outsideScopeUnchanged(c.repo.root,c.repo.baseSha)",'','hidden-source-assume-unchanged','hidden out-of-scope bytes cannot become review-ready'),
 ('unbounded-bootstrap',store,"requireThat(spent<3,'bootstrap-budget-exhausted');","requireThat(spent<100,'bootstrap-budget-exhausted');",'bootstrap-budget-persists-across-adapters','fourth helper must not be created'),
 ('replay-bootstrap-permit',store,"if (command === 'authorize-bootstrap') fault('bootstrap-already-issued');",'','bootstrap-permit-replay-and-unissued-registration-refused','replayed permit never grants another spawn'),
 ('unissued-bootstrap-registration',store,"requireThat(permit && permit.state==='issued','bootstrap-not-authorized');","requireThat(true,'bootstrap-not-authorized');",'bootstrap-permit-replay-and-unissued-registration-refused','registration requires issued nonce')
]
files=[adapter,store,'fixtures/synthetic-worker.cjs','tooling/test-hardening.cjs']
def copy(name):
 d=root/name;d.mkdir(exist_ok=True)
 for rel in files:
  p=d/rel;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(base/rel,p)
 return d
def run(d,case,label):
 report=d/(label+'.json');env={**os.environ,'MISSION_HARDENING_CASE':case,'MISSION_HARDENING_REPORT':str(report)}
 p=subprocess.run(['node',str(d/'tooling/test-hardening.cjs')],env=env,capture_output=True,text=True,timeout=40)
 (d/(label+'.log')).write_text(p.stdout+p.stderr)
 return p.returncode,json.loads(report.read_text())
results=[]
for name,rel,old,new,case,predicted in plans:
 d=copy(name);p=d/rel;s=p.read_text();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
 check=subprocess.run(['node','--check',str(p)],capture_output=True,text=True);assert check.returncode==0,check.stderr
 code,data=run(d,case,'mutation');controlCode,control=run(d,'positive-authorized-worker-readback','control')
 errors='\n'.join(r.get('error','') for r in data['results']);matched=predicted in errors
 results.append({'name':name,'mutatedSourceSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'case':case,'predictedAssertion':predicted,'matchedPredictedAssertion':matched,'exit':code,'actualError':errors,'summary':data['summary'],'controlExit':controlCode,'controlSummary':control['summary']})
 (base/'hardening-mutation-results.json').write_text(json.dumps(results,indent=2))
 assert code==1 and matched and data['summary']['failed']==1 and controlCode==0 and control['summary']['passed']==1,name
# Simpler supported-state alternative refuses flagged indexes entirely. It detects
# dirty hidden source, but also refuses the unchanged flagged positive fixture.
d=copy('alternative-reject-index-flags');p=d/adapter;s=p.read_text();needle="function outsideScopeUnchanged(repo,baseSha){";assert s.count(needle)==1
s=s.replace(needle,needle+"\n if(execFileSync('git',['-C',repo,'ls-files','-v'],{encoding:'utf8'}).split('\\n').some(line=>/^[a-zS] /.test(line)))return false;")
p.write_text(s);alternative=[]
for flag in ['assume-unchanged','skip-worktree']:
 code,data=run(d,'hidden-source-'+flag,'alternative-'+flag)
 errors='\n'.join(r.get('error','') for r in data['results']);assert code==1 and 'unchanged flagged source remains supported' in errors
 alternative.append({'flag':flag,'exit':code,'summary':data['summary'],'error':errors})
code,control=run(d,'positive-authorized-worker-readback','alternative-control');assert code==0
(base/'hardening-alternative-results.json').write_text(json.dumps({'variant':'reject all assume-unchanged/skip-worktree indexes','cases':alternative,'ordinaryControl':control['summary'],'sourceSha256':hashlib.sha256(p.read_bytes()).hexdigest()},indent=2))
print(json.dumps({'mutantsDetected':len(results),'population':len(plans),'positiveControls':len(results),'alternativeFlaggedFalseRefusals':len(alternative),'alternativeOrdinaryControl':control['summary']['passed']}))
