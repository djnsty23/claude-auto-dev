#!/usr/bin/env node
// Tests for autodev-memory's cross-process session state.
//
// This covers the mechanisms that previously failed silently:
//   1. The session id carrier — was an env var that died with its process, then
//      a single per-project file that concurrent sessions clobbered.
//   2. memory-session-start.js, which had no tests.
//   3. The `.prompt` sibling a pre-2026-09-08 build wrote beside each session
//      id (verbatim user text): the hook and the carrier functions are gone,
//      and clear() must still remove a stale one.
//
// Run: node tooling/test-session-carrier.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_SRC = path.resolve(__dirname, '..', 'plugins', 'autodev-memory');
const carrier = require(path.join(PLUGIN_SRC, 'scripts', 'session-carrier.js'));

// realpathSync: on macOS os.tmpdir() is /var/folders/... but a child process
// reports cwd as /private/var/folders/..., and the two must agree.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-test-')));
const PROJ = path.join(TMP, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

// ---------------------------------------------------------------- carrier

carrier.write(PROJ, 'harness-A', 'ses_aaa');
carrier.write(PROJ, 'harness-B', 'ses_bbb');

check('carrier reads back session A', carrier.read(PROJ, 'harness-A') === 'ses_aaa');
check('carrier reads back session B', carrier.read(PROJ, 'harness-B') === 'ses_bbb');
check('unknown session reads null', carrier.read(PROJ, 'harness-Z') === null);

// The regression that motivated the per-session keying: closing one session must
// not blind the other. Under the old single-file carrier, B stopped capturing.
carrier.clear(PROJ, 'harness-A');
check('clearing A removes only A', carrier.read(PROJ, 'harness-A') === null);
check('B survives A closing (concurrent sessions)', carrier.read(PROJ, 'harness-B') === 'ses_bbb');

// A hostile session id must not escape the carrier directory.
carrier.write(PROJ, '../../escape', 'ses_evil');
const escaped = path.join(TMP, 'escape');
check('path-traversal session id cannot escape the carrier dir', !fs.existsSync(escaped));
check('sanitized id still round-trips', carrier.read(PROJ, '../../escape') === 'ses_evil');

// PRIVACY: this directory holds verbatim user prompts, and projects do not
// reliably ignore all of .claude/. It must exclude itself on creation, or a
// user's prompts end up committed — to a public repo, in the worst case.
const dirIgnore = path.join(PROJ, '.claude', 'memory-sessions', '.gitignore');
check('carrier dir self-ignores on creation', fs.existsSync(dirIgnore));
check('self-ignore excludes everything', fs.readFileSync(dirIgnore, 'utf8').includes('\n*'));

// The prompt carrier is gone (2026-09-08), and so is the hook that wrote it.
// The module must not quietly keep exporting either half, or a caller would
// write verbatim prompts to disk that nothing reads and nothing clears.
check('writePrompt is no longer exported', typeof carrier.writePrompt === 'undefined');
check('readPrompt is no longer exported', typeof carrier.readPrompt === 'undefined');
check('the prompt-capture hook file is gone',
    !fs.existsSync(path.join(PLUGIN_SRC, 'hooks', 'memory-prompt-capture.js')));
check('and hooks.json no longer registers a UserPromptSubmit hook',
    !('UserPromptSubmit' in (JSON.parse(fs.readFileSync(path.join(PLUGIN_SRC, 'hooks', 'hooks.json'), 'utf8')).hooks || {})));

// A `.prompt` sibling left by an older build still holds verbatim user text.
// clear() removes it with the session id; the control plants one and reads
// it back first, so a clear() that ignores the sibling is what fails here.
{
    carrier.write(PROJ, 'harness-old', 'ses_old');
    const stale = carrier.carrierPath(PROJ, 'harness-old') + '.prompt';
    fs.writeFileSync(stale, 'something the user typed last week');
    check('control: the stale .prompt sibling exists before clear()', fs.existsSync(stale));
    carrier.clear(PROJ, 'harness-old');
    check('clear() removes a stale .prompt sibling from an older build', !fs.existsSync(stale));
}

function runHook(hookFile, payload, env = {}) {
    return spawnSync(process.execPath, [path.join(PLUGIN_SRC, 'hooks', hookFile)], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: PROJ,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC, ...env },
    });
}
let r;

// -------------------------------------------------- memory-session-start.js

const SS_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-home-')));
r = runHook('memory-session-start.js',
    { cwd: PROJ, session_id: 'harness-D', hook_event_name: 'SessionStart' },
    { HOME: SS_HOME, USERPROFILE: SS_HOME });

check('session start exits 0', r.status === 0);

const memDB = require(path.join(PLUGIN_SRC, 'scripts', 'memory-db.js'));
if (memDB.isAvailable()) {
    check('session start writes a carrier for its own session', /^ses_/.test(carrier.read(PROJ, 'harness-D') || ''));
} else {
    console.log('[skip] node:sqlite unavailable — skipping session-start carrier assertion');
}

// Whatever it prints must be valid hook JSON; a bare string would land in
// Claude's context as noise.
if ((r.stdout || '').trim()) {
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* stays null */ }
    check('session start stdout is valid JSON', parsed !== null);
    check('session start uses hookSpecificOutput',
        parsed === null || parsed.hookSpecificOutput?.hookEventName === 'SessionStart');
} else {
    check('session start is silent with no prior memory', true);
}

// ---------------------------------------------- clear(): the concurrency rule
//
// Found by mutation. `if (left.length === 0)` survived being forced to `true`,
// to `false`, AND inverted — three mutants, one branch, no assertion able to see
// any of them. Nothing tested either side of the directory cleanup.
//
// The dangerous side is the one the code's own comment promises: "never touch a
// directory another session is using". Forced to `true`, clear() deletes the
// carrier directory while another session's file is still in it, and that
// session loses its state mid-run. A guarantee stated in a comment and asserted
// nowhere is a guarantee only until someone edits the line.
{
    const proj = path.join(TMP, 'concurrent');
    fs.mkdirSync(proj, { recursive: true });

    carrier.write(proj, 'session-A', 'ses_a');
    carrier.write(proj, 'session-B', 'ses_b');
    const dir = carrier.carrierDir(proj);

    // A leaves; B is still live, so the directory must survive.
    carrier.clear(proj, 'session-A');
    check('clear() keeps the directory while another session is live',
        fs.existsSync(dir));
    check("  and does not disturb the other session's state",
        carrier.read(proj, 'session-B') === 'ses_b');
    // The self-ignore must survive a sibling's clear() too. This is the assertion
    // that actually catches `if (left.length === 0)` forced to `true`: rmdirSync
    // refuses a non-empty directory and the catch swallows the error, so the
    // directory itself survives either way — but the mutant unlinks .gitignore
    // BEFORE trying, and that file is the only thing keeping a folder of verbatim
    // user prompts out of git.
    check('  and the self-ignore survives, so prompts stay out of git',
        fs.existsSync(path.join(dir, '.gitignore')));

    // B leaves too: now nothing is left and the directory goes.
    carrier.clear(proj, 'session-B');
    check('clear() removes the directory once the last session leaves',
        !fs.existsSync(dir));
}

// The self-ignore file is ours and must not count as "still in use", or the
// directory would never be cleaned up at all. `filter(f => f !== '.gitignore')`
// inverted to `===` survived, because no test had a directory holding BOTH the
// .gitignore and a live session file.
{
    const proj = path.join(TMP, 'ignorecount');
    fs.mkdirSync(proj, { recursive: true });

    carrier.write(proj, 'only-session', 'ses_only');
    const dir = carrier.carrierDir(proj);
    check('the carrier directory self-ignores', fs.existsSync(path.join(dir, '.gitignore')));

    carrier.clear(proj, 'only-session');
    check('.gitignore alone does not keep the directory alive', !fs.existsSync(dir));
}

// ensureDir is called on every write; rewriting the ignore file each time would
// clobber a hand-edit and churn the disk. `if (!fs.existsSync(ignore))` forced to
// `true` survived — nothing asserted the file is written only once.
{
    const proj = path.join(TMP, 'idempotent');
    fs.mkdirSync(proj, { recursive: true });

    carrier.write(proj, 's1', 'ses_1');
    const ignore = path.join(carrier.carrierDir(proj), '.gitignore');
    fs.writeFileSync(ignore, '# edited by hand\n*\n');

    carrier.write(proj, 's2', 'ses_2');
    check('an existing .gitignore is left alone',
        fs.readFileSync(ignore, 'utf8').includes('# edited by hand'));
}

// Privacy must hold before extraction: basename, case normalization, clipping,
// JSON encoding and the area throttle can each discard or change a marker.
// All stores and carriers below are owned fixtures; HOME is never redirected.
if (memDB.isAvailable()) {
    const { DatabaseSync } = require('node:sqlite');
    const privacyRoot = path.join(TMP, 'extraction-privacy');
    const privacyProj = path.join(privacyRoot, 'project');
    const privacyStore = path.join(privacyRoot, 'store');
    fs.mkdirSync(privacyProj, { recursive: true });
    const dbModule = path.join(PLUGIN_SRC, 'scripts', 'memory-db.js');
    const preload = path.join(privacyRoot, 'fixture-path.cjs');
    fs.writeFileSync(preload, `const Module=require('module'),path=require('path');const original=Module._load;Module._load=function(name,parent){if(name==='path'&&parent&&parent.filename===${JSON.stringify(dbModule)})return {...path,join:(...p)=>p.length===2&&p[1]==='.claude'?path.join(${JSON.stringify(privacyStore)},'.claude'):path.join(...p)};return original.apply(this,arguments)};`);
    const privacyHook = (name, payload) => spawnSync(process.execPath, ['-r', preload, path.join(PLUGIN_SRC, 'hooks', name)], {
        cwd: privacyProj, input: JSON.stringify({cwd: privacyProj, session_id: 'privacy-extraction', ...payload}),
        encoding: 'utf8', env: {...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_SRC},
    });
    const start = privacyHook('memory-session-start.js', {hook_event_name:'SessionStart'});
    const sessionId = carrier.read(privacyProj, 'privacy-extraction');
    check('extraction privacy: real fixture session starts', start.status === 0 && /^ses_/.test(sessionId || ''));
    const readRows = () => {
        const db = new DatabaseSync(path.join(privacyStore, '.claude', 'auto-dev-memory.db'), {readOnly:true});
        try { return db.prepare('SELECT title,concept,source_files,raw_data FROM observations WHERE session_id=? ORDER BY rowid').all(sessionId); }
        finally { db.close(); }
    };
    // Since 2026-09-08 capture records only Write/Edit of a project file, typed
    // `change`, with the edit (never the prompt) as the concept. The recording
    // fixtures below carry the privacy cases onto that contract; the Bash/Grep/
    // Read fixtures after them assert the other tools store nothing and say
    // nothing, private markers included.
    const fixtures = [
        ['public', 'Write', {file_path:path.join(privacyProj,'public-area','public-control.ts')}, '', 'Created public-control.ts', 'New file: public-area/public-control.ts', [], false],
        ['write-unclosed', 'Write', {file_path:path.join(privacyProj,'<private>PRIVATE_DIR','WRITE_FILENAME_SECRET.ts')}, '', 'Created [REDACTED]', 'New file: [REDACTED]', ['PRIVATE_DIR','WRITE_FILENAME_SECRET'], true],
        ['edit-nested', 'Edit', {file_path:path.join(privacyProj,'<private>OUTER_DIR','<private>INNER_DIR</private>','EDIT_FILENAME_SECRET.ts')}, '', 'Modified [REDACTED]', 'Edited [REDACTED]', ['OUTER_DIR','INNER_DIR','EDIT_FILENAME_SECRET'], true],
        // Built with '/' on purpose, not path.join: on Windows path.join rewrites the
        // '/' inside '</PRIVATE>' to '\', the tag never closes, and the filename this
        // case expects to survive is redacted with it. [measured 2026-09-09] the
        // Windows CI leg failed exactly this case and no other closed-tag case.
        // A Windows path with '/' separators is valid input; the subject is the tag.
        ['write-uppercase', 'Write', {file_path:privacyProj+'/<PRIVATE>UPPER_DIR</PRIVATE>/public-read.ts'}, '', 'Created public-read.ts', 'New file: [REDACTED]/public-read.ts', ['UPPER_DIR'], true],
        ['edit-strings-before-clip', 'Edit', {file_path:path.join(privacyProj,'public-area','edited.ts'), old_string:'A<private>OLD_SECRET'+'x'.repeat(100)+'</private>OLD_TAIL', new_string:'B<private>NEW_SECRET'+'x'.repeat(100)+'</private>NEW_TAIL'}, 'A<private>RESULT_SECRET</private>', 'Modified edited.ts', 'A[REDACTED]OLD_TAIL → B[REDACTED]NEW_TAIL', ['OLD_SECRET','NEW_SECRET','RESULT_SECRET'], true],
    ];
    for (const [label,tool,input,result,title,concept,secrets,redacted] of fixtures) {
        const before=readRows().length;
        const hook=privacyHook('memory-capture.js',{tool_name:tool,tool_input:input,tool_response:result});
        const rows=readRows(), row=rows.at(-1);
        check(`extraction ${label}: actual PostToolUse persists a row`, hook.status===0 && rows.length===before+1);
        check(`extraction ${label}: title and edit-derived concept survive`, !!row && row.title===title && row.concept===concept);
        check(`extraction ${label}: nothing on stdout`, hook.stdout === '');
        const decoded= row ? [row.title,row.concept,...JSON.parse(row.source_files || '[]'),row.raw_data && JSON.parse(row.raw_data)].join('\n') : '';
        check(`extraction ${label}: protected text absent with positive redaction control`, !!row && secrets.every(s=>!decoded.includes(s)) && (!redacted || decoded.includes('[REDACTED]')));
    }
    for (const [label,tool,input,result] of [
        ['read-uppercase', 'Read', {file_path:privacyProj+'/<PRIVATE>UPPER_DIR</PRIVATE>/public-read.ts'}, ''],
        ['command-with-private', 'Bash', {command:'inspect_custom_action <private>deploy COMMAND_SECRET'+ 'x'.repeat(200) +'</private> PUBLIC_TAIL'}, 'VISIBLE_RESULT'],
        ['grep-with-private', 'Grep', {pattern:'P<private>GREP_SECRET'+'x'.repeat(100)+'</private>PUBLIC_TAIL'}, ''],
        ['long-private-result', 'Bash', {command:'custom_long_result_command'}, 'A<private>RESULT_SECRET'+'x'.repeat(600)+'</private>PUBLIC_TAIL'],
        ['structured-private-result', 'Bash', {command:'custom_structured_result_command'}, {note:'A<private>JSON_SECRET"\\\n'+'x'.repeat(600)+'</private>PUBLIC_TAIL',after:'PUBLIC_SIBLING'}],
    ]) {
        const before=readRows().length;
        const hook=privacyHook('memory-capture.js',{tool_name:tool,tool_input:input,tool_response:result});
        check(`extraction ${label}: ${tool} stores no row`, hook.status===0 && readRows().length===before);
        check(`extraction ${label}: and emits zero bytes on both streams`, hook.stdout==='' && hook.stderr==='');
    }
    const throttle=fs.readFileSync(path.join(privacyProj,'.claude','knowledge-surfaced'),'utf8');
    check('extraction privacy: private paths skip area lookup while a real public area survives', throttle.includes('privacy-extraction\tpublic-area') && !/PRIVATE_DIR|OUTER_DIR|INNER_DIR|UPPER_DIR|REDACTED/.test(throttle));
    const { classifyObservation } = require(path.join(PLUGIN_SRC,'scripts','observation-classifier.js'));
    const direct=classifyObservation('Write',{file_path:'PUBLIC.ts'},'', '<private>FIX PROMPT_SECRET'+'X'.repeat(240)+'</private> PUBLIC_REQUEST');
    check('extraction privacy: a legacy prompt argument shapes neither type nor concept', direct.type==='change' && direct.concept==='New file: PUBLIC.ts' && !JSON.stringify(direct).includes('PROMPT_SECRET'));
    const named=classifyObservation('Write',{file_path:'dir/<private>NAME_SECRET.ts'},'',undefined);
    check('extraction privacy: direct classifier redacts before basename', named.title==='Created [REDACTED]' && !JSON.stringify(named).includes('NAME_SECRET'));
    const edit=classifyObservation('Edit',{file_path:'PUBLIC.ts',old_string:'A<private>OLD_SECRET'+'x'.repeat(100)+'</private>OLD_TAIL',new_string:'B<private>NEW_SECRET'+'x'.repeat(100)+'</private>NEW_TAIL'},'','');
    check('extraction privacy: edit fallback redacts before shortening both strings', edit.concept==='A[REDACTED]OLD_TAIL → B[REDACTED]NEW_TAIL');
}


// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
try { fs.rmSync(SS_HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
