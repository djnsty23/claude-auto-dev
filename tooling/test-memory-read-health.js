#!/usr/bin/env node
// Real CLI controls. The preload redirects only the subject's legacy path;
// baseline failures cannot open the operator's memory store.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const subject = path.resolve(process.argv[2] || path.join(__dirname, '../plugins/autodev-memory/scripts/memory-db.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-read-health-'));
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `const Module=require('node:module'),p=require('node:path'),load=Module._load;
const shim=Object.create(p);shim.join=(...args)=>args.length===2&&args[1]==='.claude'?process.env.MEMORY_FIXTURE_LEGACY:p.join(...args);
Module._load=function(id,parent,main){if(parent?.filename===${JSON.stringify(subject)}&&id==='path')return shim;if(id==='node:sqlite'&&process.env.MEMORY_FIXTURE_NO_SQLITE==='1')throw Error('fixture unavailable');const result=load.call(this,id,parent,main);if(id==='node:sqlite'&&process.env.MEMORY_FIXTURE_WRITE_RECEIPT)return {...result,DatabaseSync:function(...args){const db=new result.DatabaseSync(...args);let error=null;try{db.exec('CREATE TABLE readonly_probe(value)')}catch(e){error=e.message}require('node:fs').writeFileSync(process.env.MEMORY_FIXTURE_WRITE_RECEIPT,JSON.stringify({error}));return db}};return result};`);
let passed = 0, failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); ok ? passed++ : failed++; };
function run(dir, args, extra = {}) {
  return spawnSync(process.execPath, ['--require', preload, ...args], {
    encoding: 'utf8', timeout: 10000, cwd: root,
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, MEMORY_FIXTURE_LEGACY: dir, ...extra },
  });
}
const cli = (dir, command, extra) => run(dir, [subject, command, '/fixture/project', 'unique-memory-control'], extra);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function failure(result, code) {
  let error; try { error = JSON.parse(result.stderr.trim().split('\n').find(line => line.startsWith('{'))); } catch {}
  return result.status === 2 && result.stdout === '' && error?.ok === false && error.code === code;
}
try {
  const commands = ['stats', 'recent', 'search', 'semantic', 'timeline', 'sessions', 'decisions', 'bugs', 'knowledge', 'dashboard'];
  for (const command of commands) {
    for (const kind of ['missing', 'corrupt', 'wrong-schema']) {
      const dir = path.join(root, `${command}-${kind}`), file = path.join(dir, 'auto-dev-memory.db');
      if (kind === 'corrupt') { fs.mkdirSync(dir); fs.writeFileSync(file, 'not a sqlite database'); }
      if (kind === 'wrong-schema') {
        fs.mkdirSync(dir);
        const setup = run(dir, ['-e', `const d=new(require('node:sqlite').DatabaseSync)(${JSON.stringify(file)});d.exec('CREATE TABLE unrelated(value)');d.close()`]);
        check(`${command} wrong-schema fixture created`, setup.status === 0);
      }
      const before = fs.existsSync(file) ? hash(file) : null;
      const result = cli(dir, command);
      check(`${command} ${kind} is non-success without a result`, failure(result, kind === 'missing' ? 'memory-store-missing' : 'memory-store-unreadable'));
      check(`${command} ${kind} never initializes or rewrites database`, before === null ? !fs.existsSync(dir) : hash(file) === before);
    }
  }
  const healthy = path.join(root, 'healthy');
  const seed = run(healthy, ['-e', `const m=require(${JSON.stringify(subject)}),s=m.startSession('/fixture/project');if(!s)throw Error('seed failed');if(!m.saveObservation({sessionId:s,projectPath:'/fixture/project',type:'decision',title:'unique-memory-control',concept:'healthy seeded control',sourceFiles:['src/control.js']}))throw Error('save failed');m.endSession(s,{request:'unique-memory-control',completed:'seeded'});`]);
  check('real writer seeds positive store', seed.status === 0);
  const file = path.join(healthy, 'auto-dev-memory.db');
  const before = hash(file);
  for (const command of commands) {
    const result = cli(healthy, command);
    check(`${command} healthy store succeeds`, result.status === 0 && result.stdout.trim().length > 0);
    check(`${command} read preserves database bytes`, hash(file) === before);
    const unavailable = cli(healthy, command, { MEMORY_FIXTURE_NO_SQLITE: '1' });
    check(`${command} unavailable SQLite is explicit beside healthy control`, failure(unavailable, 'memory-sqlite-unavailable'));
    check(`${command} unavailable SQLite preserves database bytes`, hash(file) === before);
  }
  const found = cli(healthy, 'search');
  check('known-positive search retrieves seeded record', found.status === 0 && /unique-memory-control/.test(found.stdout));
  const empty = run(healthy, [subject, 'search', '/fixture/project', 'zzzz-no-match-zzzz']);
  check('valid empty search remains successful empty array', empty.status === 0 && empty.stdout.trim() === '[]');
  const configured = path.join(root, 'configured'), legacy = path.join(root, 'legacy-absent');
  fs.cpSync(healthy, configured, { recursive: true });
  const selected = cli(configured, 'search', { MEMORY_FIXTURE_LEGACY: legacy });
  check('configured store is queried instead of legacy path', selected.status === 0 && /unique-memory-control/.test(selected.stdout) && !fs.existsSync(legacy));
  const writeReceipt = path.join(root, 'write-receipt.json');
  const read = cli(healthy, 'stats', { MEMORY_FIXTURE_WRITE_RECEIPT: writeReceipt });
  const denied = JSON.parse(fs.readFileSync(writeReceipt));
  check('actual CLI connection denies injected SQL write', read.status === 0 && /readonly|read-only/i.test(denied.error || ''));
  check('injected write leaves database bytes unchanged', hash(file) === before);
  const writeControl = run(path.join(root, 'writer-control'), ['-e', `const m=require(${JSON.stringify(subject)});if(!m.startSession('/fixture/control'))throw Error('writer failed')`], { MEMORY_FIXTURE_WRITE_RECEIPT: writeReceipt });
  check('same injected SQL write succeeds on writer connection', writeControl.status === 0 && JSON.parse(fs.readFileSync(writeReceipt)).error === null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`population: ${passed + failed} assertions run, ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
