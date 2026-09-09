#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'codex-patch-paths-'));
const hook=path.resolve(__dirname,'../plugins/autodev-core/hooks/pre-tool-filter.js');
const work=path.join(root,'workspace');fs.mkdirSync(path.join(work,'.claude','hooks'),{recursive:true});fs.mkdirSync(path.join(work,'src'));fs.mkdirSync(path.join(work,'docs'));
fs.writeFileSync(path.join(work,'.claude','settings.json'),'{}');
fs.symlinkSync(path.join(work,'.claude'),path.join(work,'alias'),'dir');
fs.symlinkSync(path.join(work,'.claude','settings.json'),path.join(work,'ordinary-link.json'));
fs.symlinkSync(path.join(work,'.claude','hooks'),path.join(work,'alias-hooks'),'dir');
const patch=body=>'*** Begin Patch\n'+body+'\n*** End Patch';
const add=name=>patch('*** Add File: '+name+'\n+content');
const update=name=>patch('*** Update File: '+name+'\n@@\n-old\n+new');
const del=name=>patch('*** Delete File: '+name);
const move=(from,to)=>patch('*** Update File: '+from+'\n*** Move to: '+to+'\n@@\n-old\n+new');
const cases=[
 ['Update context Add marker',patch('*** Update File: example.md\n@@\n *** Add File: .claude/settings.json\n+ordinary content'),0],
 ['Update context Update marker',patch('*** Update File: example.md\n@@\n *** Update File: .claude/settings.json\n+ordinary content'),0],
 ['Update context Delete marker',patch('*** Update File: example.md\n@@\n *** Delete File: .claude/settings.json\n+ordinary content'),0],
 ['Update context Move marker',patch('*** Update File: example.md\n@@\n *** Move to: .claude/settings.json\n+ordinary content'),0],
 ['Update context End marker',patch('*** Update File: example.md\n@@\n *** End Patch\n+ordinary content'),0],
 ['Update context Environment marker',patch('*** Update File: example.md\n@@\n *** Environment ID: remote\n+ordinary content'),0],
 ['real protected header after Update context',patch('*** Update File: example.md\n@@\n *** Add File: .claude/settings.json\n+ordinary content\n*** Delete File: .claude/settings.json'),2],
 ['native lexical alias-parent Add',add('alias-hooks/../settings.json'),0],
 ['native lexical alias-parent Update',update('alias-hooks/../settings.json'),0],
 ['native lexical alias-parent Move destination',move('old.txt','alias-hooks/../settings.json'),0],
 ['ordinary Add',add('new.txt'),0],['ordinary Update',update('src/a.js'),0],['ordinary Delete',del('old.txt'),0],['ordinary Move',move('old.txt','new.txt'),0],
 ['ordinary absolute',add(path.join(work,'absolute.txt')),0],['ordinary traversal',add('docs/../ordinary.txt'),0],['ordinary whitespace path',add('docs/two words.txt'),0],['ordinary unicode',add('docs/café.txt'),0],
 ['empty native no-op',patch(''),0],['CRLF',add('new.txt').replaceAll('\n','\r\n'),0],['literal marker text in content',patch('*** Add File: example.md\n+*** Add File: .claude/settings.json'),0],
 ['Add protected relative',add('.claude/settings.json'),2],['Update protected',update('.claude/settings.json'),2],['Delete protected',del('.claude/settings.json'),2],
 ['Move protected source',move('.claude/settings.json','new.json'),2],['Move protected destination',move('old.json','.claude/settings.json'),2],
 ['later protected path',patch('*** Add File: safe.txt\n+safe\n*** Delete File: .claude/settings.json'),2],
 ['earlier protected path',patch('*** Delete File: .claude/settings.json\n*** Add File: safe.txt\n+safe'),2],
 ['absolute protected',add(path.join(work,'.claude/settings.json')),2],['traversal protected',add('docs/../.claude/settings.json'),2],
 ['case alias follows host path policy',add('.CLAUDE/SETTINGS.JSON'),process.platform === 'linux' ? 0 : 2],['trimmed native header',patch(' \t*** Add File: .claude/settings.json   \n+bad'),2],
 ['existing symlink parent',add('alias/settings.json'),2],['existing symlink file',update('ordinary-link.json'),2],
 ['symlink parent with missing suffix',add('alias/plugins/new/file.js'),2],['symlink before parent traversal',add('alias/hooks/../settings.json'),2],
 ['claude hooks',add('.claude/hooks/new.js'),2],['claude plugins',add('.claude/plugins/cache/new.js'),2],
 ['codex plugins',add('.codex/plugins/cache/new.js'),2],['codex config',add('.codex/config.toml'),2],['codex hooks',add('.codex/hooks.json'),2],
 ['missing command',undefined,2],['nonstring command',{},2],['malformed framing','*** Add File: safe.txt\n+x',2],
 ['unknown action',patch('*** Copy File: .claude/settings.json'),2],['remote environment',patch('*** Environment ID: remote\n*** Add File: file.txt\n+x'),2],
 ['path uri',add('file:///tmp/file.txt'),2],['nul path',add('bad\0name'),2],['empty header path',patch('*** Add File: \n+x'),2],
 ['stray move',patch('*** Move to: .claude/settings.json'),2],['missing inventory',patch('unexpected operation'),2],
 ['bare heredoc',"<<EOF\n"+add('okay.txt')+'\nEOF',0],['quoted heredoc',"<<'EOF'\n"+add('okay.txt')+'\nEOF',0],
 ['mixed ordinary actions',patch('*** Add File: new.txt\n+x\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** Delete File: gone.txt'),0],
];
let passed=0,failed=0;
function test(label,input,expected){const r=cp.spawnSync(process.execPath,[hook],{input:JSON.stringify(input),cwd:work,encoding:'utf8',timeout:5000});const okay=r.status===expected;if(okay)passed++;else failed++;console.log((okay?'PASS ':'FAIL ')+label+(okay?'':': expected '+expected+', got '+r.status+'; '+r.stderr));}
try{
 for(const [label,command,expected] of cases)test(label,{tool_name:'apply_patch',tool_input:{command},cwd:work},expected);
 test('native cwd required',{tool_name:'apply_patch',tool_input:{command:add('file.txt')}},2);
 test('native cwd absolute',{tool_name:'apply_patch',tool_input:{command:add('file.txt')},cwd:'relative'},2);
 test('legacy protected Write unchanged',{tool_name:'Write',tool_input:{file_path:path.join(work,'.claude/settings.json'),content:'x'}},2);
 test('legacy ordinary Edit unchanged',{tool_name:'Edit',tool_input:{file_path:path.join(work,'file.txt'),new_string:'x'}},0);
 test('legacy Bash unchanged',{tool_name:'Bash',tool_input:{command:'printf harmless'}},0);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed,failed,population:passed+failed}));process.exitCode=failed?1:0;
