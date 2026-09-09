#!/usr/bin/env node
// Actual generator/bump CLI and shell child processes; all targets are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-package-test-'));
let passed = 0, failed = 0;
const json = (x) => JSON.stringify(x, null, 2) + '\n';
function check(name, ok, detail = '') { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + detail}`); }
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function run(file, args = [], options = {}) { return cp.spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 15000, ...options }); }
function hash(x) { return crypto.createHash('sha256').update(x).digest('hex'); }
const plugin = path.join(ROOT, 'plugins/demo');
const sourceHooks = path.join(plugin, 'hooks/hooks.json');
const manifest = path.join(plugin, '.claude-plugin/plugin.json');
const generated = path.join(plugin, 'hooks/codex.json');
const capsFile = path.join(plugin, '.codex-plugin/capabilities.json');
const codexManifest = path.join(plugin, '.codex-plugin/plugin.json');
const generator = path.join(ROOT, 'tooling/generate-codex-packages.js');
const argv = ['${CLAUDE_PLUGIN_ROOT}/hooks/receipt.js', 'literal $name and \' quote', 'Café', 'line\nbreak'];
const hook = () => ({ type: 'command', command: 'node', args: argv, timeout: 10 });
const original = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [hook()] }], SessionEnd: [{ hooks: [hook()] }], FutureEvent: [{ matcher: 'literal', hooks: [hook()] }] }, modules: ['./fn/preserved.mjs'] };
try {
  write(generator, fs.readFileSync(path.join(__dirname, 'generate-codex-packages.js')));
  write(path.join(ROOT, 'tooling/bump.js'), fs.readFileSync(path.join(__dirname, 'bump.js')));
  write(path.join(ROOT, 'VERSION'), '1.2.3\n');
  write(path.join(ROOT, 'package.json'), json({ name: 'fixture', version: '1.2.3' }));
  write(path.join(ROOT, '.claude-plugin/marketplace.json'), json({ metadata: { version: '1.2.3' } }));
  write(manifest, json({ name: 'demo', version: '1.2.3', description: 'Synthetic fixture', userConfig: { custom: { type: 'string' } } }));
  write(sourceHooks, json(original));
  const receiptSource = "let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),input:JSON.parse(raw),root:process.env.PLUGIN_ROOT}));process.exitCode=2;});";
  write(path.join(plugin, 'hooks/receipt.js'), receiptSource);
  const beforeHooks = hash(fs.readFileSync(sourceHooks));
  const beforeManifest = hash(fs.readFileSync(manifest));
  let result = run(generator, ['--check']);
  check('missing generated artifacts fail with a named drift diagnostic', result.status === 1 && result.stderr.includes('3/3') && result.stderr.includes('.codex-plugin/plugin.json'), result.stderr);
  result = run(generator, ['--write']);
  check('actual generator writes the nonempty projection', result.status === 0 && result.stdout.includes('3/3'), result.stderr);
  result = run(generator, ['--check']);
  check('generated positive passes actual check CLI', result.status === 0, result.stderr);
  check('Claude hook and metadata inputs remain byte-identical', beforeHooks === hash(fs.readFileSync(sourceHooks)) && beforeManifest === hash(fs.readFileSync(manifest)));
  const target = JSON.parse(fs.readFileSync(generated));
  const caps = JSON.parse(fs.readFileSync(capsFile));
  check('Codex selects separate hooks explicitly and carries version', JSON.parse(fs.readFileSync(codexManifest)).hooks === './hooks/codex.json' && JSON.parse(fs.readFileSync(codexManifest)).version === '1.2.3');
  check('unsupported event source retained in explicit capability gap', caps.sourceHandlers === 3 && caps.projectedHandlers === 2 && caps.unsupportedEventHandlers.length === 1 && caps.unsupportedEventHandlers[0].source.args[0] === argv[0] && !target.hooks.FutureEvent);
  check('function module gap retained without invalid native modules field', caps.unavailableFunctionModules[0].source === './fn/preserved.mjs' && !Object.hasOwn(target, 'modules'));
  check('projection stays unadmitted with user config gap disclosed', caps.admission === 'unverified' && caps.unsupportedUserConfigKeys.includes('custom'));
  check('native SessionEnd budget reduction is explicit', target.hooks.SessionEnd[0].hooks[0].timeout === 3 && caps.timeoutLimitations[0].sourceTimeout === 10 && caps.timeoutLimitations[0].codexTimeout === 3);
  check('matcher and normal timeout retained', target.hooks.SessionStart[0].matcher === 'startup' && target.hooks.SessionStart[0].hooks[0].timeout === 10);
  const first = [generated, capsFile, codexManifest].map((p) => fs.readFileSync(p));
  run(generator, ['--write']);
  check('repeat generation produces identical bytes', [generated, capsFile, codexManifest].every((p, i) => fs.readFileSync(p).equals(first[i])));
  const goodGenerated = fs.readFileSync(generated);
  fs.appendFileSync(generated, ' '); result = run(generator, ['--check']);
  check('changed generated hook fails the real CLI', result.status === 1 && result.stderr.includes('hooks/codex.json'), result.stderr);
  fs.writeFileSync(generated, goodGenerated);
  const meta = JSON.parse(fs.readFileSync(codexManifest)); meta.version = '9.9.9';write(codexManifest, json(meta));result=run(generator,['--check']);
  check('stale Codex identity fails drift check', result.status === 1 && result.stderr.includes('.codex-plugin/plugin.json'), result.stderr);run(generator,['--write']);
  const metadata=JSON.parse(fs.readFileSync(manifest));metadata.hooks='./other.json';write(manifest,json(metadata));result=run(generator,['--write']);
  check('metadata control fields cannot be silently discarded',result.status===1 && result.stderr.includes('unsupported field hooks'),result.stderr);delete metadata.hooks;write(manifest,json(metadata));
  const mutations = [
    ['unknown top-level control', (j) => {j.guardPolicy=true;}, 'unsupported field guardPolicy'],
    ['unknown handler control', (j) => {j.hooks.SessionStart[0].hooks[0].guardPolicy=true;}, 'unsupported field guardPolicy'],
    ['unknown group control', (j) => {j.hooks.SessionStart[0].guardPolicy=true;}, 'unsupported field guardPolicy'],
    ['unsupported shell-only command', (j) => {delete j.hooks.SessionStart[0].hooks[0].args;}, 'only explicit node'],
    ['unsupported executable tokens', (j) => {j.hooks.SessionStart[0].hooks[0].command='node script.js';}, 'only explicit node'],
    ['unsupported prompt hook', (j) => {j.hooks.SessionStart[0].hooks[0].type='prompt';}, 'only explicit node'],
    ['traversal outside plugin', (j) => {j.hooks.SessionStart[0].hooks[0].args=['${CLAUDE_PLUGIN_ROOT}/../outside.js'];}, 'invalid script path'],
    ['unsupported template placeholder', (j) => {j.hooks.SessionStart[0].hooks[0].args=[argv[0], '${user_config.custom}'];}, 'unsupported argument placeholder'],
    ['zero timeout', (j) => {j.hooks.SessionStart[0].hooks[0].timeout=0;}, 'invalid timeout'],
    ['non-string matcher', (j) => {j.hooks.SessionStart[0].matcher=[];}, 'matcher must be string'],
  ];
  for (const [name, mutate, diagnostic] of mutations) {
    const j=JSON.parse(json(original));mutate(j);write(sourceHooks,json(j));const before=fs.readFileSync(generated);result=run(generator,['--write']);
    check(name+' refuses before generated writes',result.status===1 && result.stderr.includes(diagnostic) && before.equals(fs.readFileSync(generated)),result.stderr);
  }
  write(sourceHooks,json(original));
  if (process.platform !== 'win32') {
  const outside=path.join(ROOT,'outside.js');write(outside,receiptSource);fs.unlinkSync(path.join(plugin,'hooks/receipt.js'));fs.symlinkSync(outside,path.join(plugin,'hooks/receipt.js'));result=run(generator,['--write']);
  check('symlink escape is refused',result.status===1 && result.stderr.includes('inside plugin'),result.stderr);fs.unlinkSync(path.join(plugin,'hooks/receipt.js'));write(path.join(plugin,'hooks/receipt.js'),receiptSource);
  } else console.log('NOT CHECKED: Windows symlink creation requires host permissions; no symlink-escape pass claimed');
  const command=target.hooks.SessionStart[0].hooks[0].command;
  check('no eager-expansion root placeholder enters shell command',!command.includes('${') && !command.includes(plugin));
  if (process.platform !== 'win32') {
    for(const name of ['normal','space root',"apostrophe's root",'root $literal','root `printf MUTATED`','root $(printf MUTATED)']) {
      const root=path.join(ROOT,'paths',name);write(path.join(root,'hooks/receipt.js'),receiptSource);
      result=cp.spawnSync('/bin/sh',['-c',command],{input:'{"sentinel":"payload"}\n',encoding:'utf8',timeout:10000,env:{...process.env,PLUGIN_ROOT:root}});
      let out;try{out=JSON.parse(result.stdout);}catch{}
      check('actual child argv/input/exit survive '+name,result.status===2 && json(out?.args)===json(argv.slice(1)) && out?.input.sentinel==='payload' && out?.root===root,result.stderr);
    }
    result=cp.spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:10000,env:{...process.env,PLUGIN_ROOT:''}});
    check('missing runtime root fails without fallback',result.status!==0 && result.stderr.includes('Missing or non-absolute PLUGIN_ROOT'),result.stderr);
    result=cp.spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:10000,env:{...process.env,PLUGIN_ROOT:'relative-root'}});
    check('relative runtime root fails without cwd fallback',result.status!==0 && result.stderr.includes('non-absolute PLUGIN_ROOT'),result.stderr);
    result=cp.spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:10000,env:{...process.env,PLUGIN_ROOT:plugin,PATH:ROOT}});
    check('missing node executable is nonzero',result.status!==0 && result.stdout==='',result.stderr);
    const killed=path.join(ROOT,'killed');write(path.join(killed,'hooks/receipt.js'),"process.kill(process.pid, 'SIGTERM');");
    result=cp.spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:10000,env:{...process.env,PLUGIN_ROOT:killed}});
    check('signaled child is nonzero, never null-to-success',result.status===1,result.stderr);
    const large=path.join(ROOT,'large');write(path.join(large,'hooks/receipt.js'),"process.stdout.write('x'.repeat(1048576));process.stderr.write('evidence-stderr');process.exitCode=2;");
    result=cp.spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:10000,maxBuffer:2*1048576,env:{...process.env,PLUGIN_ROOT:large}});
    check('child large output/stderr drain and exit2 propagate',result.status===2 && result.stdout.length===1048576 && result.stderr==='evidence-stderr',`${result.status}/${result.stdout.length}/${result.stderr}`);
  } else console.log('NOT CHECKED: native Windows command-shell execution requires its own host canary; this suite does not admit Windows');
  // Native canaries show Write/Edit aliases already select apply_patch. Keep
  // declarations intact; metadata must state the payload adapter's real limits.
  const boundary=path.join(ROOT,'native-boundary');
  const boundaryGenerator=path.join(boundary,'tooling/generate-codex-packages.js');
  write(boundaryGenerator,fs.readFileSync(generator));write(path.join(boundary,'VERSION'),'1.2.3\n');
  const adaptedArgs=['${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-filter.js'];
  const nativeSource={hooks:{PreToolUse:[{matcher:'Read|Write|Edit',hooks:[
    {type:'command',command:'node',args:argv,timeout:10},
    {type:'command',command:'node',args:adaptedArgs,timeout:5},
    {type:'command',command:'node',args:argv,timeout:10},
  ]}],PostToolUse:[{matcher:'Write|Edit',hooks:[{type:'command',command:'node',args:adaptedArgs,timeout:5}]}]}};
  for(const name of ['autodev-core','demo']){
    const dir=path.join(boundary,'plugins',name);
    write(path.join(dir,'.claude-plugin/plugin.json'),json({name,version:'1.2.3',description:'Synthetic matcher boundary'}));
    write(path.join(dir,'hooks/hooks.json'),json(nativeSource));
    write(path.join(dir,'hooks/pre-tool-filter.js'),receiptSource);write(path.join(dir,'hooks/receipt.js'),receiptSource);
  }
  result=run(boundaryGenerator,['--write']);
  check('native adapter fixture generates through actual CLI',result.status===0,result.stderr);
  const native=JSON.parse(fs.readFileSync(path.join(boundary,'plugins/autodev-core/hooks/codex.json')));
  const peer=JSON.parse(fs.readFileSync(path.join(boundary,'plugins/demo/hooks/codex.json')));
  const nativeCaps=JSON.parse(fs.readFileSync(path.join(boundary,'plugins/autodev-core/.codex-plugin/capabilities.json')));
  const matching=(doc,event,tool)=>doc.hooks[event].filter(g=>g.matcher===undefined||new RegExp(g.matcher).test(tool)).flatMap(g=>g.hooks);
  const decoded=hook=>JSON.parse(Buffer.from(hook.command.match(/Buffer\.from\('([^']+)'/)[1],'base64').toString('utf8'))[0];
  const patches=matching(native,'PreToolUse','Write').filter(h=>decoded(h)===adaptedArgs[0]);
  check('pre-tool-filter transport exists once within its preserved registration',patches.length===1);
  check('Write keeps every original handler in order',json(matching(native,'PreToolUse','Write').map(decoded))===json([argv[0],adaptedArgs[0],argv[0]]));
  check('native matcher and shared-group declarations remain unchanged',native.hooks.PreToolUse.length===1 && native.hooks.PreToolUse[0].matcher==='Read|Write|Edit' && native.hooks.PreToolUse[0].hooks.length===3);
  check('other plugin projection retains the same source declarations',json(native.hooks)===json(peer.hooks));
  check('PostToolUse matcher remains unchanged',native.hooks.PostToolUse[0].matcher==='Write|Edit');
  check('canonical Claude registrations stay byte-identical',fs.readFileSync(path.join(boundary,'plugins/autodev-core/hooks/hooks.json'),'utf8')===json(nativeSource));
  check('capabilities retain native content, custom home, ownership and workdir limits',
    nativeCaps.knownProtectionGaps.some(x=>x.includes('content')&&x.includes('lint')) &&
    nativeCaps.knownProtectionGaps.some(x=>x.includes('CODEX_HOME')) &&
    nativeCaps.knownProtectionGaps.some(x=>x.includes('ownership')) &&
    nativeCaps.knownProtectionGaps.some(x=>x.includes('workdir')) && nativeCaps.admission==='unverified');
  if(process.platform!=='win32' && patches.length===1){
    const input={tool_name:'apply_patch',tool_input:{command:'*** Begin Patch\n*** Add File: ordinary.txt\n+okay\n*** End Patch'},cwd:boundary};
    result=cp.spawnSync('/bin/sh',['-c',patches[0].command],{input:JSON.stringify(input),encoding:'utf8',timeout:10000,env:{...process.env,PLUGIN_ROOT:path.join(boundary,'plugins/autodev-core')}});
    let output;try{output=JSON.parse(result.stdout);}catch{}
    check('generated adapter preserves native payload and exit2 without Write alias',result.status===2 && json(output?.input)===json(input),result.stderr);
  } else check('generated native command is available for transport control',patches.length===1);
  const bad=JSON.parse(json(original));bad.hooks.SessionStart[0].hooks[0].guardPolicy=true;write(sourceHooks,json(bad));
  result=run(path.join(ROOT,'tooling/bump.js'),['2.0.0']);
  check('version writer rejects unsupported controls before mutation',result.status===1 && fs.readFileSync(path.join(ROOT,'VERSION'),'utf8')==='1.2.3\n' && JSON.parse(fs.readFileSync(manifest)).version==='1.2.3',result.stderr);
  write(sourceHooks,json(original));const drifted=JSON.parse(fs.readFileSync(manifest));drifted.version='9.9.9';write(manifest,json(drifted));
  result=run(path.join(ROOT,'tooling/bump.js'),['2.0.0']);
  check('single version writer refreshes Codex metadata and projection',result.status===0 && JSON.parse(fs.readFileSync(codexManifest)).version==='2.0.0' && JSON.parse(fs.readFileSync(capsFile)).version==='2.0.0' && run(generator,['--check']).status===0,result.stderr);
  fs.rmSync(path.join(ROOT,'plugins'),{recursive:true});fs.mkdirSync(path.join(ROOT,'plugins'));
  result=run(generator,['--check']);check('empty plugin population cannot pass',result.status===1 && result.stderr.includes('No plugins'),result.stderr);
} finally { fs.rmSync(ROOT,{recursive:true,force:true}); }
console.log(`population: ${passed+failed} assertions run, ${passed} passed, ${failed} failed`);
process.exitCode=failed ? 1 : 0;
