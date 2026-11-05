#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/usage-digest.js.
//
// A digest fails silently in four ways: it names a PR the session never touched, it carries a
// person's name or a human's words into a file that gets indexed, it keeps a digest the secret
// scanner never cleared, or it runs without the private denylists and digests a client. Each
// is pinned by a fixture written by hand. The names used here are invented for this file, so
// narrowing the subject's lists cannot narrow these guards. The local model is stubbed: these
// cases test what code does with a topic, not what the model writes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'usage-digest.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`); }
}

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-digest-')));
const home = path.join(scratch, 'home');
const root = path.join(home, '.claude', 'projects');
const usage = path.join(home, '.claude', 'autodev', 'usage');
const cfgFile = path.join(usage, 'digest-config.json');
const CONFIG = { clientMarkers: ['clientco'], knownNames: ['Zorbek'], userNames: ['Pat'] };
const setConfig = (v) => { fs.mkdirSync(usage, { recursive: true }); if (v === null) fs.rmSync(cfgFile, { force: true }); else fs.writeFileSync(cfgFile, JSON.stringify(v)); };

// The env the subject reads at call time. Set before require, so in-process calls see the scratch home.
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.AUTODEV_USAGE_DIR = usage;

// A stub scanner with the real one's contract: exit 0 and the clean line, or a finding.
const SECRET = ['sk', 'ant', 'api03', 'SUITECANARY' + 'Zq7'.repeat(12)].join('-');
const scanner = path.join(scratch, 'scanner.js');
fs.writeFileSync(scanner, [
    "const t = require('fs').readFileSync(process.argv[process.argv.indexOf('--file') + 1], 'utf8');",
    "if (t.includes('SUITECANARY')) { console.log('1 credential-shaped string found'); process.exitCode = 1; }",
    "else console.log('No credential-shaped strings found.');",
].join('\n'));
process.env.AUTODEV_SECRET_SCANNER = scanner;

const d = require(SUBJECT);
const line = (o) => JSON.stringify(o);
function session(dir, id, cwd, extra = []) {
    const sid = id.slice(0, 8);
    const a = (ts, mid, blocks) => ({ type: 'assistant', timestamp: ts, sessionId: sid, cwd, message: { id: mid, model: 'claude-opus-5-5', content: blocks } });
    const r = (ts, tid, text, isErr = false) => ({ type: 'user', timestamp: ts, sessionId: sid, cwd, message: { content: [{ type: 'tool_result', tool_use_id: tid, is_error: isErr, content: text }] } });
    const rows = [
        { type: 'user', timestamp: '2026-11-05T10:00:00Z', sessionId: sid, cwd, origin: { kind: 'human' },
            message: { content: 'The parser tests keep failing after the refactor, please ask Brannah whether the fixture format changed and then repair the failure in tests.' } },
        a('2026-11-05T10:00:05Z', 'm1', [{ type: 'text', text: 'I will look at the parser failure in the tests and check the fixture format before changing anything in the parser module.' }]),
        a('2026-11-05T10:00:06Z', 'm2', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${cwd}/src/parser.ts`, old_string: 'a', new_string: 'b' } }]),
        a('2026-11-05T10:00:07Z', 'm3', [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: `${cwd}/notes/zorbek-call.md`, content: 'x' } }]),
        a('2026-11-05T10:00:08Z', 'm4', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'gh pr list --state all' } }]),
        r('2026-11-05T10:00:09Z', 't3', 'https://github.com/acme/widgets/pull/901\topen\nhttps://github.com/acme/widgets/pull/902\tmerged'),
        a('2026-11-05T10:00:10Z', 'm5', [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'gh pr create --fill' } }]),
        r('2026-11-05T10:00:11Z', 't4', 'https://github.com/acme/widgets/pull/950'),
        a('2026-11-05T10:00:12Z', 'm6', [{ type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'gh pr merge https://github.com/acme/widgets/pull/951 --rebase' } }]),
        r('2026-11-05T10:00:13Z', 't5', 'Merged'),
        a('2026-11-05T10:00:14Z', 'm7', [{ type: 'text', text: 'The parser failure was a stale fixture, the tests pass now and the user asked for nothing else.' }]),
        ...extra.map((e) => (e.tool ? a('2026-11-05T10:00:20Z', 'mx', [{ type: 'tool_use', id: 'tx', name: 'Edit', input: { file_path: `${cwd}/${e.tool}`, old_string: 'a', new_string: 'b' } }]) : e)),
    ];
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const f = path.join(root, dir, `${id}.jsonl`);
    fs.writeFileSync(f, rows.map(line).join('\n') + '\n');
    return f;
}
const topicIs = (t) => async () => ({ topic: t, tokens: 1 });
const header = (body) => body.split('\n')[0];

(async () => {
    try {
        setConfig(CONFIG);
        const fa = session('C--code-proj-a', 'aaaa1111-0000-0000-0000-000000000000', 'C:/code/proj-a');

        // PR links: only from gh commands that act on a PR. The list output names PRs the session never touched.
        let r = await d.digestOne(fa, { print: true, askTopic: topicIs('Fix parser failure in tests') });
        check('digest builds with a grounded topic', r.status === 'ok' && /topic by: 4B, checked/.test(r.body), r.status);
        check('PR from gh pr create output is kept', /pull\/950\b/.test(r.body || ''));
        check('PR named in a gh pr merge command is kept', /pull\/951\b/.test(r.body || ''));
        check('PRs from gh pr list output are dropped', !/pull\/90[12]\b/.test(r.body || ''), (r.body || '').match(/pull\/\d+/g));

        // D3: a name on no list, written in a human turn, must not reach the digest.
        r = await d.digestOne(fa, { print: true, askTopic: topicIs('Parser fixture question for Brannah') });
        check('unlisted name in the topic falls back to a code topic', /topic by: code \(4B topic refused: names a person\)/.test(r.body || ''), header(r.body || ''));
        check('unlisted name is absent from the whole digest', !/brannah/i.test(r.body || ''));

        // The denylist covers the name the heuristic cannot: one the log also writes lowercase, in a path.
        check('control: the lowercase name in a path defeats the heuristic alone', d.nameSuspects('Parser notes for Zorbek', d.condense(fa).lines).length === 0);
        r = await d.digestOne(fa, { print: true, askTopic: topicIs('Parser notes for Zorbek') });
        check('listed name in the topic is refused', /refused: names a person/.test(r.body || ''), header(r.body || ''));
        check('edited file whose path carries a listed name is left out', !/zorbek/i.test(r.body || ''));
        check('control: an ordinary edited file is listed', /- file src\/parser\.ts/.test(r.body || ''));

        r = await d.digestOne(fa, { print: true, askTopic: topicIs('Pat wanted the parser failure in tests fixed') });
        check('user names become "the user"', /^# the user wanted the parser failure/.test(r.body || '') && !/\bPat\b/.test(r.body || ''), header(r.body || ''));

        r = await d.digestOne(fa, { print: true, askTopic: topicIs('please ask Brannah whether the fixture format changed and then repair the failure') });
        check('a topic quoting a human turn is refused', /refused: (quotes a human turn|names a person)/.test(r.body || ''), header(r.body || ''));
        r = await d.digestOne(fa, { print: true, askTopic: topicIs('please ask whether the fixture format changed and then repair the failure in tests') });
        check('a ten-word human quote with no name is refused as a quote', /refused: quotes a human turn/.test(r.body || ''), header(r.body || ''));
        r = await d.digestOne(fa, { print: true, askTopic: topicIs('kubernetes helm migration rollout planning') });
        check('an ungrounded topic is refused', /refused: \d+ of \d+ topic words are in the log/.test(r.body || ''), header(r.body || ''));
        r = await d.digestOne(fa, { print: true, askTopic: topicIs('') });
        check('an empty topic is refused', /refused: empty/.test(r.body || ''));

        // Client projects get no digest.
        const fc = session('C--code-clientco-site', 'cccc3333-0000-0000-0000-000000000000', 'C:/code/clientco-site');
        r = await d.digestOne(fc, { print: true, askTopic: topicIs('Fix parser failure in tests') });
        check('a client project is skipped', r.status === 'skipped' && r.why === 'client project', r.status);

        // Without the private lists nothing is digested, in-process and through the CLI.
        setConfig({ clientMarkers: ['clientco'] });
        r = await d.digestOne(fa, { print: true, askTopic: topicIs('Fix parser failure in tests') });
        check('no knownNames: the digest refuses', r.status === 'retry' && /needs clientMarkers and knownNames/.test(r.why || ''), r.status);
        setConfig(null);
        r = await d.digestOne(fa, { print: true, askTopic: topicIs('Fix parser failure in tests') });
        check('no config: the digest refuses', r.status === 'retry', r.status);
        const cli = spawnSync(process.execPath, [SUBJECT, 'one', fa, '--print'], { encoding: 'utf8', env: process.env });
        check('no config: the CLI exits 2', cli.status === 2, cli.status);
        const rr = await d.run({ root, askTopic: topicIs('x') });
        check('no config: run refuses before reading', Boolean(rr.error), JSON.stringify(rr));
        setConfig(CONFIG);

        // The scanner gate: kept only on the clean line, dropped otherwise, dropped when the scanner is missing.
        const clean = path.join(scratch, 'clean.md');
        const dirty = path.join(scratch, 'dirty.md');
        fs.writeFileSync(clean, '# fine\n');
        fs.writeFileSync(dirty, `# leaked ${SECRET}\n`);
        check('scanner clears a clean digest', d.scanClean(clean).ok === true);
        check('scanner flags a planted secret', d.scanClean(dirty).ok === false);
        process.env.AUTODEV_SECRET_SCANNER = path.join(scratch, 'no-such-scanner.js');
        check('a missing scanner fails closed', d.scanClean(clean).ok === false && /not found/.test(d.scanClean(clean).why));
        process.env.AUTODEV_SECRET_SCANNER = scanner;
        const fs2 = session('C--code-proj-s', 'ssss4444-0000-0000-0000-000000000000', 'C:/code/proj-s', [{ tool: `src/${SECRET}.ts` }]);
        r = await d.digestOne(fs2, { outDir: path.join(scratch, 'out'), askTopic: topicIs('Fix parser failure in tests') });
        const left = fs.existsSync(path.join(scratch, 'out', 'proj-s')) ? fs.readdirSync(path.join(scratch, 'out', 'proj-s')) : [];
        check('a digest the scanner flags is dropped and deleted', r.status === 'dropped' && left.length === 0, `${r.status}, ${left.length} file(s) left`);
        fs.rmSync(fs2, { force: true });

        // Ingest is off by default and spawns nothing.
        const kb = path.join(scratch, 'kb');
        const marker = path.join(scratch, 'ingest-ran');
        fs.mkdirSync(path.join(kb, 'memory-kb'), { recursive: true });
        fs.writeFileSync(path.join(kb, 'memory-kb', 'ingest.py'), `open(r"${marker}", "w").write("ran")\n`);
        process.env.AUTODEV_KB_DIR = kb;
        const ing = d.ingest();
        check('ingest is off by default', ing.ran === false && /ingest is off/.test(ing.why) && d.ingestEnabled() === false);
        check('ingest off spawns nothing', !fs.existsSync(marker));
        delete process.env.AUTODEV_KB_DIR;

        // Ledger: a second run skips finished records, a retry runs again, subagent transcripts are not sessions.
        fs.rmSync(fc, { force: true });
        fs.mkdirSync(path.join(root, 'C--code-proj-a', 'aaaa1111-0000-0000-0000-000000000000', 'subagents'), { recursive: true });
        fs.writeFileSync(path.join(root, 'C--code-proj-a', 'aaaa1111-0000-0000-0000-000000000000', 'subagents', 'agent-1.jsonl'), '');
        check('subagent transcripts are not listed', d.transcripts(root).every((f) => !/subagents/.test(f)) && d.transcripts(root).length === 1, d.transcripts(root).length);
        const fb = session('C--code-proj-b', 'bbbb2222-0000-0000-0000-000000000000', 'C:/code/proj-b');
        let calls = 0;
        const flaky = async () => { calls++; if (calls === 1) throw new Error('local model answered 503'); return { topic: 'Fix parser failure in tests', tokens: 1 }; };
        const r1 = await d.run({ root, askTopic: flaky });
        check('first run digests both, one as a retry', r1.batch === 2 && r1.tally.ok === 1 && r1.tally.retry === 1, JSON.stringify(r1));
        const r2 = await d.run({ root, askTopic: flaky });
        check('second run picks up only the retry', r2.batch === 1 && r2.tally.ok === 1, JSON.stringify(r2));
        const r3 = await d.run({ root, askTopic: flaky });
        check('third run has nothing to do', r3.batch === 0, JSON.stringify(r3));
        fs.appendFileSync(fb, line({ type: 'user', timestamp: '2026-11-05T11:00:00Z', sessionId: 'bbbb2222', message: { content: 'one more parser test' } }) + '\n');
        const r4 = await d.run({ root, askTopic: flaky });
        check('a transcript that grew is digested again', r4.batch === 1, JSON.stringify(r4));
        const st = d.status();
        check('status counts the ledger', st.records === 2 && st.byStatus.ok === 2 && st.configured === true && st.ingest === false, JSON.stringify(st));
        const kept = fs.readdirSync(path.join(usage, 'digests', 'proj-a'));
        check('digests are written under the usage dir', kept.length === 1 && /^2026-11-05-aaaa1111\.md$/.test(kept[0]), kept);

        // The real model call, through the CLI, with a local server standing in for the model.
        // Every check above injects askTopic, so none of them reach this path. The child is
        // spawned, not spawnSync'd, because the stub answers on this process's event loop.
        const replies = [];
        const asked = [];
        const stub = http.createServer((req, res) => {
            if (req.url === '/health') { res.end('{}'); return; }
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                asked.push(JSON.parse(body));
                const next = replies.shift();
                res.statusCode = next.status || 200;
                res.end(JSON.stringify({ choices: [{ message: { content: next.content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
            });
        });
        await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${stub.address().port}`;
        const cliRun = (...args) => new Promise((resolve) => {
            const child = spawn(process.execPath, [SUBJECT, ...args], { windowsHide: true, env: { ...process.env, AUTODEV_LOCAL_SMALL_URL: url, AUTODEV_SMALL_START: '', AUTODEV_SMALL_STOP: '' } });
            let out = '';
            let err = '';
            child.stdout.on('data', (c) => { out += c; });
            child.stderr.on('data', (c) => { err += c; });
            child.on('close', (code) => resolve({ code, out, err }));
        });
        try {
            session('C--code-proj-live', 'dddd4444-0000-0000-0000-000000000000', 'C:/code/proj-live');
            let c = await cliRun('run', '--project', 'proj-live', '--dry-run');
            check('--dry-run counts the batch and calls no model', c.code === 0 && /1 transcript\(s\) need a digest, 1 in this batch \(dry run/.test(c.out) && asked.length === 0, c.out + c.err);
            c = await cliRun('run', '--limit', 'many');
            check('a non-numeric --limit is refused with exit 2', c.code === 2 && /--limit takes a positive number/.test(c.err), c.err);

            replies.push({ content: '<think>{"topic":"Hidden reasoning topic"}</think>\nHere it is: {"topic":"Fix parser failure in tests"} done' });
            c = await cliRun('run', '--limit', '1', '--project', 'proj-live');
            check('run reaches the model and records the digest', c.code === 0 && /ok: 1/.test(c.out) && asked.length === 1, c.out + c.err);
            const sent = asked[0] || { messages: [] };
            check('the session log is what the model is asked about', /SESSION LOG/.test((sent.messages[1] || {}).content || '') && /parser/.test((sent.messages[1] || {}).content || ''));
            const liveDir = path.join(usage, 'digests', 'proj-live');
            const liveFile = fs.existsSync(liveDir) ? fs.readdirSync(liveDir)[0] : null;
            const liveBody = liveFile ? fs.readFileSync(path.join(liveDir, liveFile), 'utf8') : '';
            check('the topic is parsed out of the surrounding prose, past the think block', /^# Fix parser failure in tests/.test(liveBody) && /topic by: 4B, checked/.test(liveBody), header(liveBody));

            const fp = session('C--code-proj-parse', 'eeee5555-0000-0000-0000-000000000000', 'C:/code/proj-parse');
            replies.push({ content: 'no json in this answer' });
            c = await cliRun('one', fp, '--print');
            check('an answer with no JSON falls back to a code topic', c.code === 0 && /refused: empty/.test(c.out), c.out + c.err);
            replies.push({ content: '{"topic": broken}' });
            c = await cliRun('one', fp, '--print');
            check('an answer with malformed JSON falls back to a code topic', c.code === 0 && /refused: empty/.test(c.out), c.out + c.err);

            session('C--code-proj-down', 'ffff6666-0000-0000-0000-000000000000', 'C:/code/proj-down');
            replies.push({ status: 500, content: '' });
            c = await cliRun('run', '--project', 'proj-down');
            check('a model error is a retry and exit 1, not a clean run', c.code === 1 && /retry: 1/.test(c.out), c.out + c.err);
        } finally {
            await new Promise((resolve) => stub.close(resolve));
        }
        const down = await cliRun('run', '--project', 'proj-down');
        check('a model that is not up refuses with exit 2 and reads nothing', down.code === 2 && /local model is not answering/.test(down.err), down.out + down.err);
    } catch (e) {
        check('suite ran without throwing', false, e && e.stack);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
})();
