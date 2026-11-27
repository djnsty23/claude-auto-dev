#!/usr/bin/env node
// Suite for the asks in live-edit.js and for live-edit-a2ui.js.
//
// The owner types or dictates a change on the page, the proxy queues it in the
// worktree's git dir, the session answers with choices drawn on the page, and a
// tap comes back as a pick. The claims that matter are the ones a wrong build
// makes quietly: a page script or another site that can ask, a click the page
// forged that sends, a component outside the catalog that draws, a body that is
// read without a size cap, a tap that picks something never offered, a preview
// counted as the edit, and a queue written into the site's tree. Each block
// plants one with a known answer. Every fixture lives in a temp directory.

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPTS, 'live-edit.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'a2ui');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'live-edit-asks-')));

fs.writeFileSync(path.join(tmp, 'gitconfig'), '', 'utf8');
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp.replace(/\\/g, '/'),
  GIT_AUTHOR_NAME: 'Suite', GIT_AUTHOR_EMAIL: 'suite@example.test', GIT_COMMITTER_NAME: 'Suite', GIT_COMMITTER_EMAIL: 'suite@example.test',
});

const le = require(SUBJECT);
const kit = require(path.join(SCRIPTS, 'live-edit-a2ui.js'));

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' : ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
};
const same = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), { got, want });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 8; i++) await sleep(0); };
const cleanup = [];

const git = (dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
};
const makeRepo = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"site"}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'page.txt'), 'Book now\n', 'utf8');
  git(dir, 'add', 'package.json', 'src/page.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
};

const CAT = kit.CATALOG_ID;
const v = (body) => ({ version: '1.0', ...body });
// A choice surface as the session would draw it: two copy variants, a colour, a spacing slider and its button.
const choices = (sid = 'hero') => [
  v({ createSurface: { surfaceId: sid, catalogId: CAT, dataModel: { gap: 16 } } }),
  v({ updateComponents: { surfaceId: sid, components: [
    { id: 'root', component: 'Column', children: ['title', 'v1', 'v2', 'sw', 'gap', 'apply'] },
    { id: 'title', component: 'Text', text: 'Pick the hero button copy', variant: 'heading' },
    { id: 'v1_t', component: 'Text', text: 'Book a call' },
    { id: 'v1', component: 'Button', child: 'v1_t', action: { event: { name: 'pick_copy', context: { copy: 'Book a call' } } }, preview: { selector: '#cta', text: 'Book a call' } },
    { id: 'v2_t', component: 'Text', text: 'Tell us about your project' },
    { id: 'v2', component: 'Button', child: 'v2_t', action: { event: { name: 'pick_copy', context: { copy: 'Tell us about your project' } } }, preview: { selector: '#cta', text: 'Tell us about your project' } },
    { id: 'sw', component: 'Swatch', color: '#2f6f4f', label: 'Forest', action: { event: { name: 'pick_colour', context: { color: '#2f6f4f' } } }, preview: { selector: '#cta', style: { 'background-color': '#2f6f4f' } } },
    { id: 'gap', component: 'Slider', value: { '@path': '/gap' }, min: 0, max: 48, steps: 12, label: 'Gap', unit: 'px', preview: { selector: '.hero', property: 'gap' } },
    { id: 'apply_t', component: 'Text', text: 'Use this gap' },
    { id: 'apply', component: 'Button', child: 'apply_t', variant: 'primary', action: { event: { name: 'pick_gap', context: { gap: { '@path': '/gap' } } } } },
  ] } }),
];
const stateOf = (messages) => { const s = kit.newState(); for (const m of messages) kit.apply(s, m); return s; };
const tapOn = (state, sid, id, context) => {
  const msg = kit.actionMessage(state.surfaces.get(sid), id, Date.UTC(2026, 10, 27, 12));
  if (context) msg.action.context = context;
  return msg;
};

// ---------------------------------------------------------------------------
function a2uiSuite() {
  console.log('the choices: A2UI v1.0 checks');
  const cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'renderer_messages.json'), 'utf8')).tests;
  const wrong = cases.filter((t) => kit.checkRendererMessage(t.data).ok !== t.valid).map((t) => t.description);
  same('every renderer case in the spec gets the spec\'s verdict', [cases.length, cases.filter((t) => t.valid).length, wrong], [12, 7, []]);
  const lines = fs.readFileSync(path.join(FIXTURES, 'contact_form_example.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const env = lines.map((l) => kit.checkEnvelope(l));
  same('every line of the spec\'s example passes the envelope rules', [lines.length >= 3, env.filter((e) => !e.ok).map((e) => e.message)], [true, []]);
  const ours = lines.map((l) => kit.checkAgentMessage(l, null));
  same('the spec\'s basic catalog is refused by ours, by name', [ours[0].message, ours[1].message], [`live edit renders its own catalog only: ${CAT}`, '"Card" is not in the live edit catalog']);

  const s = kit.newState();
  const verdicts = choices().map((msg) => { const r = kit.checkAgentMessage(msg, s); if (r.ok) kit.apply(s, msg); return r.ok || r.message; });
  same('a surface in our catalog is accepted, message by message', verdicts, [true, true]);

  const comp = (c) => kit.checkAgentMessage(v({ updateComponents: { surfaceId: 'hero', components: [c] } }), s);
  const outside = comp({ id: 'img', component: 'Image', url: 'https://example.test/x.png' });
  same('an out-of-catalog component is refused', [outside.ok, outside.path, outside.message], [false, '/updateComponents/components/0/component', '"Image" is not in the live edit catalog']);
  same('an unknown field on a known component is refused', comp({ id: 't', component: 'Text', text: 'x', onClick: 'go()' }).path, '/updateComponents/components/0/onClick');
  same('a directive live edit does not implement is named as one', comp({ id: 't', component: 'Text', text: 'x', '@weight': 1 }).message, '"@weight" is a directive live edit does not implement');
  same('a function call action is refused', comp({ id: 'b', component: 'Button', child: 'title', action: { functionCall: { call: 'openUrl' } } }).message, 'function calls are not implemented by live edit');
  same('an @call binding is refused', comp({ id: 't', component: 'Text', text: { '@call': 'formatDate' } }).message, 'functions are not implemented by live edit');
  same('a child template is refused', comp({ id: 'c', component: 'Column', children: { path: '/items', componentId: 't' } }).message, 'child templates are not implemented by live edit');
  same('a style that can fetch is refused', comp({ id: 'b', component: 'Button', child: 'title', action: { event: { name: 'x' } }, preview: { selector: '#cta', style: { 'background-color': 'url(https://example.test/a)' } } }).message, 'a style value live edit refuses');
  same('a style outside the list is refused', comp({ id: 'b', component: 'Button', child: 'title', action: { event: { name: 'x' } }, preview: { selector: '#cta', style: { behavior: 'x' } } }).message, '"behavior" is not a style live edit previews');
  same('a selector that could close a rule is refused', comp({ id: 'b', component: 'Button', child: 'title', action: { event: { name: 'x' } }, preview: { selector: '#cta}{x', text: 'y' } }).message, 'a CSS selector of at most 200 characters');
  same('a slider whose max is not above min is refused', comp({ id: 'g', component: 'Slider', value: 3, min: 5, max: 5 }).message, 'max must be above min');
  const other = [
    kit.checkAgentMessage(v({ callRendererFunction: { functionCallId: 'f', callFunction: { call: 'x' } } }), s).message,
    kit.checkAgentMessage(v({ createSurface: { surfaceId: 'x', catalogId: CAT, sendDataModel: true } }), s).message,
    kit.checkAgentMessage(v({ createSurface: { surfaceId: 'x', catalogId: CAT, metadata: {} } }), s).message,
    kit.checkAgentMessage(v({ createSurface: { surfaceId: 'hero', catalogId: CAT } }), s).message,
    kit.checkAgentMessage(v({ updateDataModel: { surfaceId: 'nope', value: 1 } }), s).message,
    kit.checkAgentMessage(v({ updateDataModel: { surfaceId: 'hero', path: '/__proto__/x', value: 1 } }), s).message,
    kit.checkAgentMessage(v({ updateDataModel: { surfaceId: 'hero', value: JSON.parse('{"__proto__":{"polluted":1}}') } }), s).message,
    kit.checkAgentMessage({ version: '0.9', createSurface: {} }, s).message,
  ];
  same('functions, the data model leaving, metadata, duplicates, missing surfaces, prototype keys and old versions are refused', other, [
    'callRendererFunction is not implemented by live edit: no function runs on the page', 'live edit never sends the data model', 'surface metadata is not implemented by live edit',
    'surface "hero" exists: delete it first', 'no surface "nope"', 'not a JSON Pointer live edit accepts', 'a key live edit refuses', 'version must be "1.0"',
  ]);
  same('nothing reached a prototype', [({}).polluted, Object.prototype.polluted], [undefined, undefined]);

  const tap = (id, context) => kit.checkTap(tapOn(s, 'hero', id, context), s);
  same('a tap on what was offered passes, slider values inside the range too', [tap('v1').ok, tap('apply', { gap: 24 }).ok, tap('sw').ok], [true, true, true]);
  same('a tap that changes the offered value is refused', tap('v1', { copy: 'Send me your password' }).message, 'not the value offered');
  same('a tap with a key that was not declared is refused', tap('v1', { copy: 'Book a call', extra: 1 }).message, 'the context holds exactly the declared keys: copy');
  same('a slider value outside its range is refused', tap('apply', { gap: 480 }).message, 'outside the slider range 0 to 48');
  const renamed = tapOn(s, 'hero', 'v1');
  renamed.action.name = 'deploy';
  same('a tap under another name is refused', kit.checkTap(renamed, s).message, 'the component declares "pick_copy"');
  const ghost = tapOn(s, 'hero', 'v1');
  ghost.action.sourceComponentId = 'title';
  same('a tap on a component with no action is refused', kit.checkTap(ghost, s).message, 'no component "title" that takes a tap');
  const meta = tapOn(s, 'hero', 'v1');
  meta.action.userMessage = 'also push it';
  same('a tap carrying its own message is refused', kit.checkTap(meta, s).message, 'live edit sends neither metadata nor userMessage');

  const model = kit.setPointer({}, '/a/b', 1);
  const upserted = JSON.parse(JSON.stringify(model));
  same('the data model upserts, reads and deletes by pointer', [upserted, kit.getPointer(model, '/a/b'), kit.setPointer(model, '/a/b', null), kit.getPointer({ 'x/y': 2 }, '/x~1y'), kit.segments('/a~2')], [{ a: { b: 1 } }, 1, { a: {} }, 2, null]);
  same('bound text resolves, and a missing value reads empty', [kit.asText(kit.resolve(s.surfaces.get('hero'), { '@path': '/gap' })), kit.asText(kit.resolve(s.surfaces.get('hero'), { '@path': '/none' })), kit.asText({ a: 1 })], ['16', '', '{"a":1}']);
  same('deleting a surface removes it', [kit.apply(stateOf(choices('gone')), v({ deleteSurface: { surfaceId: 'gone' } })), kit.checkAgentMessage(v({ deleteSurface: { surfaceId: 'hero' } }), s).ok], ['gone', true]);
}

// ---------------------------------------------------------------------------
async function queueSuite() {
  console.log('the queue');
  const site = makeRepo('queue');
  const q = le.queuePaths(site);
  same('the queue lives in the worktree\'s git dir, never in its tree', [path.relative(site, q.root).split(path.sep)[0], le.queuePaths(tmp)], ['.git', null]);
  const t0 = Date.UTC(2026, 10, 27, 12);
  const id = le.addAsk(q, { text: 'Make the hero button say Book a call', target: { selector: '#cta', text: 'x'.repeat(500), tag: 'button', source: null }, instance: 'pageA' }, t0);
  same('an ask is logged and waits in the inbox', [le.readEvents(q).length, fs.readdirSync(q.inbox).length, git(site, 'status', '--porcelain')], [1, 1, '']);
  same('a pointed-at element is capped as page content', [le.cleanTarget({ selector: '#cta', text: 'x'.repeat(500) }).text.length, le.cleanTarget({ text: 'no selector' }), le.cleanTarget('x')], [200, null, null]);
  const item = le.claimNext(q);
  same('claiming moves it out of the inbox, once', [item.id, item.kind, fs.readdirSync(q.inbox).length, le.claimNext(q)], [id, 'ask', 0, null]);

  let now = t0;
  const clock = () => now;
  const pause = async (ms) => { now += ms; };
  same('wait at its deadline returns nothing and leaves no heartbeat', [await le.waitForItem(q, { timeoutMs: 1000, clock, pause }), fs.existsSync(q.listening)], [null, false]);
  same('wait on the real clock sleeps between looks and gives up at its deadline', await le.waitForItem(q, { timeoutMs: 60, pollMs: 20 }), null);
  le.addAsk(q, { text: 'Second ask' }, now);
  let beat = null;
  const watching = async (ms) => { beat = le.isListening(q, now); now += ms; };
  const second = await le.waitForItem(q, { timeoutMs: 5000, clock, pause: watching });
  same('wait returns the first item, marks it working, and the page saw someone listening', [second.text, le.askView(le.readEvents(q)).pop().state, beat === null || beat === true], ['Second ask', 'working', true]);
  fs.writeFileSync(q.listening, JSON.stringify({ at: now - 20e3 }));
  same('a stale heartbeat is nobody listening', [le.isListening(q, now), le.isListening(q, now - 19e3)], [false, true]);

  const before = le.readEvents(q).length;
  const half = [choices()[0], v({ updateComponents: { surfaceId: 'hero', components: [{ id: 'root', component: 'Iframe' }] } })];
  same('a batch with one refused message writes nothing', [le.showMessages(q, id, half, now), le.readEvents(q).length], [{ ok: false, why: 'message 2: /updateComponents/components/0/component: "Iframe" is not in the live edit catalog' }, before]);
  same('drawing needs a known ask and a message', [le.showMessages(q, 'nope', choices(), now).why, le.showMessages(q, id, [], now).why], ['no ask nope', 'no message to draw']);
  const huge = v({ createSurface: { surfaceId: 'big', catalogId: CAT, dataModel: { s: 'x'.repeat(40e3) } } });
  same('a message over the size cap is refused', le.showMessages(q, id, [huge], now).why, `message 1 is over ${le.MESSAGE_MAX} bytes`);
  same('a good batch is drawn in order and the ask waits for a pick', [le.showMessages(q, id, choices(), now), le.askView(le.readEvents(q)).find((a) => a.id === id).state], [{ ok: true, count: 2 }, 'choices']);
  const feed = le.feedView(le.readEvents(q), 0, true);
  same('the feed carries the messages with their sequence and the latest asks', [feed.messages.map((m) => m.seq), feed.last, feed.reset, feed.asks.length, feed.listening], [[1, 2], 2, false, 2, true]);
  same('a page that already has them gets none, a page from an older log starts again', [le.feedView(le.readEvents(q), 2, false).messages.length, le.feedView(le.readEvents(q), 9, false).reset, le.feedView(le.readEvents(q), 9, false).messages.length], [0, true, 2]);
  same('the drawn surfaces rebuild from the log', [...le.surfaceStateFrom(le.readEvents(q)).surfaces.keys()], ['hero']);
  same('the ask a surface belongs to', [le.surfaceOwner(le.readEvents(q), 'hero'), le.surfaceOwner([], 'hero')], [id, null]);

  same('messages parse as one object, an array or JSON lines', [le.parseMessages('{"a":1}'), le.parseMessages('[{"a":1},{"b":2}]'), le.parseMessages('{"a":1}\n\n{"b":2}\n')], [[{ a: 1 }], [{ a: 1 }, { b: 2 }], [{ a: 1 }, { b: 2 }]]);
  let thrown = null;
  try { le.parseMessages('{"a":1}\nnot json'); } catch (e) { thrown = e.message; }
  same('a line that is not JSON is named', thrown, 'line 2 is not JSON');

  const rule = le.describeItem(item, site).rule;
  check('wait hands the session the rule that bounds an ask', [site, 'push', 'merge', 'deploy', 'credential', 'outside this worktree'].every((w) => rule.includes(w)), rule);
  same('an ask reaches the session as the owner\'s words, apart from what the page said', Object.keys(le.describeItem(item, site)), ['kind', 'id', 'ownerWords', 'pointedAt', 'rule']);
  const tapMsg = tapOn(stateOf(choices()), 'hero', 'v1');
  same('a pick reaches the session as its surface, component, name and context', le.describeItem({ kind: 'action', id: 't1', ask: id, msg: tapMsg }, site).context, { copy: 'Book a call' });
  same('an error reaches it as the error', le.describeItem({ kind: 'error', id: 'e1', ask: null, msg: { error: { code: 'X' } } }, site).error, { code: 'X' });
  same('the tree is untouched by the whole queue', git(site, 'status', '--porcelain'), '');
  return { site, q };
}

// ---------------------------------------------------------------------------
const PAGE = '<!doctype html><html><head><title>t</title></head><body><button id="cta">Book now</button></body></html>';
const request = (port, urlPath, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, agent: false, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, body: text, json }); });
  });
  req.on('error', reject);
  if (Array.isArray(body)) { for (const part of body) req.write(part); req.end(); } else req.end(body);
});
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const shut = (server) => new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); });

async function startUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"', 'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT', 'cache-control': 'max-age=600' });
    res.end(PAGE);
  });
  const port = await listen(server);
  cleanup.push(() => server.close());
  return { server, url: `http://127.0.0.1:${port}` };
}

async function proxySuite({ q }) {
  console.log('the ask gate');
  same('the tag with a ticket has no defer, so it runs before the page\'s scripts', [le.scriptTag(null, 'T1'), le.scriptTag("script-src 'nonce-n1'", 'T1')], ['<script src="/__live-edit/overlay.js?t=T1"></script>', '<script src="/__live-edit/overlay.js?t=T1" nonce="n1"></script>']);
  const up = await startUpstream();
  let now = Date.UTC(2026, 10, 27, 12);
  const clock = () => now;
  const proxy = le.createProxy({ upstream: new URL(up.url), getState: () => ({ ok: true }), ask: { layout: 'panel', point: true, preview: true, queue: q, clock } });
  const port = await listen(proxy);
  cleanup.push(() => proxy.close());
  const gate = proxy.liveEditGate;
  const origin = `http://localhost:${port}`;
  const asScript = { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors' };
  const ticketOf = (page) => (/overlay\.js\?t=([A-Za-z0-9_-]+)"><\/script>/.exec(page.body) || [])[1];

  const page = await request(port, '/');
  const ticket = ticketOf(page);
  same('each page gets a fresh ticket and is never kept', [Boolean(ticket), page.body.includes(' defer'), page.headers['cache-control'], page.headers.etag, page.headers['last-modified'], ticketOf(await request(port, '/')) !== ticket], [true, false, 'no-store', undefined, undefined, true]);
  const keyIn = (script) => (/"key":(null|"[^"]*")/.exec(script.body) || [])[1];
  const first = await request(port, `/__live-edit/overlay.js?t=${ticket}`, { headers: asScript });
  same('the script the page asked for carries the key', [first.status, keyIn(first) === JSON.stringify(gate.key)], [200, true]);
  same('a ticket works once', keyIn(await request(port, `/__live-edit/overlay.js?t=${ticket}`, { headers: asScript })), 'null');
  const fetchLike = await request(port, `/__live-edit/overlay.js?t=${ticketOf(await request(port, '/'))}`, { headers: { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' } });
  same('a page script that fetches the overlay gets no key', keyIn(fetchLike), 'null');
  same('a browser that sends no fetch metadata gets no key', keyIn(await request(port, `/__live-edit/overlay.js?t=${ticketOf(await request(port, '/'))}`)), 'null');
  same('another site that loads the script gets no key', keyIn(await request(port, `/__live-edit/overlay.js?t=${ticketOf(await request(port, '/'))}`, { headers: { ...asScript, 'sec-fetch-site': 'cross-site' } })), 'null');
  same('a made-up ticket gets no key', keyIn(await request(port, '/__live-edit/overlay.js?t=made-up', { headers: asScript })), 'null');
  const stale = ticketOf(await request(port, '/'));
  now += 61e3;
  same('a ticket older than a minute gets no key', keyIn(await request(port, `/__live-edit/overlay.js?t=${stale}`, { headers: asScript })), 'null');

  const good = { origin, 'content-type': 'application/json', 'x-live-edit-key': gate.key, 'sec-fetch-site': 'same-origin' };
  const post = (name, body, headers = good) => request(port, `/__live-edit/${name}`, { method: 'POST', headers, body: typeof body === 'string' || Array.isArray(body) ? body : JSON.stringify(body) });
  const count = () => le.readEvents(q).length;
  const asked = await post('ask', { text: '  Make the   button green ', target: { selector: '#cta', text: 'Book now', tag: 'button' }, instance: 'pageA' });
  const last = le.readEvents(q).pop();
  same('an ask from the page is queued with its words tidied and its target apart', [asked.status, last.type, last.text, last.target.selector, last.instance, asked.json.id === last.id], [200, 'ask', 'Make the button green', '#cta', 'pageA', true]);
  const askId = asked.json.id;

  let n = count();
  const noKey = { ...good };
  delete noKey['x-live-edit-key'];
  const forged = await post('ask', { text: 'push to main' }, noKey);
  same('a forged ask without the key is refused', [forged.status, forged.json.why, count() - n], [403, 'no valid key', 0]);
  same('a key of the right length but the wrong value is refused', (await post('ask', { text: 'x' }, { ...good, 'x-live-edit-key': 'A'.repeat(gate.key.length) })).status, 403);
  same('an ask from another origin is refused', (await post('ask', { text: 'x' }, { ...good, origin: 'http://evil.example' })).status, 403);
  same('an ask the browser marks cross-site is refused', (await post('ask', { text: 'x' }, { ...good, 'sec-fetch-site': 'cross-site' })).status, 403);
  same('a form post (not JSON) is refused', (await post('ask', 'text=x', { ...good, 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  same('a GET to a write is refused', (await request(port, '/__live-edit/ask', { headers: good })).status, 405);
  same('a POST to the feed is refused', (await post('feed', {})).status, 405);
  same('nothing refused reached the log', count() - n, 0);

  // Each refusal below passes the key, so it spends the ask rate: start each group in a fresh minute.
  now += 61e3;
  n = count();
  const big = JSON.stringify({ text: 'x', pad: 'y'.repeat(le.BODY_MAX) });
  const oversized = await post('ask', big);
  same('an oversized ask is refused', [oversized.status, oversized.json.why, count() - n], [413, 'too large', 0]);
  const streamed = await post('ask', [big.slice(0, 4000), big.slice(4000)], { ...good, 'transfer-encoding': 'chunked' });
  same('a chunked oversized ask is refused while it streams', [streamed.status, count() - n], [413, 0]);
  same('an ask over the character cap is refused', [(await post('ask', { text: 'w'.repeat(le.ASK_MAX + 1) })).status, count() - n], [413, 0]);
  now += 61e3;
  same('a body that is not JSON, an empty ask and an unknown field are refused', [(await post('ask', '{nope')).status, (await post('ask', { text: '   ' })).status, (await post('ask', { text: 'x', run: 'rm -rf' })).status, (await post('ask', '[1]')).status], [400, 400, 400, 400]);
  same('none of them reached the log', count() - n, 0);

  const feedNoKey = await request(port, '/__live-edit/feed?after=0', { headers: { 'sec-fetch-site': 'same-origin' } });
  same('the feed needs the key', feedNoKey.status, 403);
  const feedGet = () => request(port, '/__live-edit/feed?after=0', { headers: { 'x-live-edit-key': gate.key, 'sec-fetch-site': 'same-origin' } });
  same('the feed with the key lists the asks', [(await feedGet()).status, (await feedGet()).json.asks.some((a) => a.id === askId)], [200, true]);

  same('a pick on a surface nobody drew is refused', (await post('action', tapOn(stateOf(choices('nobody')), 'nobody', 'v1'))).status, 409);
  le.showMessages(q, askId, choices('pick'), now);
  const drawn = stateOf(choices('pick'));
  n = count();
  const picked = await post('action', tapOn(drawn, 'pick', 'v2'));
  const action = le.readEvents(q).pop();
  same('a pick on what was offered is queued for the session', [picked.status, action.type, action.ask, action.msg.action.context.copy], [200, 'action', askId, 'Tell us about your project']);
  same('a pick that changes the offered value is refused at the proxy', [(await post('action', tapOn(drawn, 'pick', 'v1', { copy: 'Delete the repo' }))).status, count() - n], [400, 1]);
  same('a renderer message that is not an action is refused as a pick', (await post('action', { version: '1.0', error: { code: 'X', message: 'y', surfaceId: 'pick' } })).status, 400);

  same('seen before the session marked the ask edited is refused', (await post('seen', { id: askId, instance: 'pageA' })).status, 409);
  now += 2000;
  le.setAskState(q, askId, 'edited', { expect: 'Tell us about your project' }, now);
  now += 700;
  same('seen once edited is recorded', (await post('seen', { id: askId, instance: 'pageA' })).status, 200);
  const shown = le.askView(le.readEvents(q)).find((a) => a.id === askId);
  same('visible records the seconds from the ask, the edit and the pick, and that the page never reloaded', [shown.state, shown.fromEditMs, shown.fromTapMs, shown.sameInstance, shown.visibleMs > shown.fromTapMs], ['visible', 700, 2700, true, true]);
  same('seen twice is refused', (await post('seen', { id: askId, instance: 'pageA' })).status, 409);
  same('a pick on a finished ask is refused', (await post('action', tapOn(drawn, 'pick', 'v1'))).status, 409);
  const err = await post('error', { version: '1.0', error: { code: 'VALIDATION_FAILED', surfaceId: 'pick', path: '/x', message: 'refused' } });
  same('a renderer error is queued for the session with its ask', [err.status, le.readEvents(q).pop().ask], [200, askId]);
  same('an error without its fields is refused', (await post('error', { version: '1.0', error: { code: 'VALIDATION_FAILED', message: 'x' } })).status, 400);
  same('an endpoint that is not one is a 404', (await post('nope', {})).status, 404);
  same('the API refuses a body that is not an object, and a name it does not have', [le.handleAskApi('ask', 'x', q, now)[0], le.handleAskApi('other', {}, q, now)[0]], [400, 404]);

  const reload = await request(port, '/');
  const second = await request(port, `/__live-edit/overlay.js?t=${ticketOf(reload)}`, { headers: asScript });
  same('a reloaded page earns the same run\'s key again', keyIn(second) === JSON.stringify(gate.key), true);
  await shut(proxy);

  // The rate, on a proxy of its own so the asks above do not count.
  const rated = le.createProxy({ upstream: new URL(up.url), getState: () => ({}), ask: { layout: 'sheet', queue: q, clock } });
  const rport = await listen(rated);
  const rhead = { ...good, origin: `http://localhost:${rport}`, 'x-live-edit-key': rated.liveEditGate.key };
  const fire = () => request(rport, '/__live-edit/ask', { method: 'POST', headers: rhead, body: JSON.stringify({ text: 'rate' }) }).then((r) => r.status);
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push(await fire());
  now += 61e3;
  statuses.push(await fire());
  same('the seventh ask in a minute is refused, and the next minute is open again', statuses, [200, 200, 200, 200, 200, 200, 429, 200]);
  same('every run has its own key', rated.liveEditGate.key !== gate.key, true);
  await shut(rated);

  const off = le.createProxy({ upstream: new URL(up.url), getState: () => ({}), ask: { layout: 'off', queue: q } });
  const oport = await listen(off);
  const offPage = await request(oport, '/');
  same('with the ask box off the page keeps the v1 tag and its own caching', [offPage.body.includes('<script src="/__live-edit/overlay.js" defer></script>'), offPage.headers.etag, (await request(oport, '/__live-edit/ask', { method: 'POST', headers: good, body: '{}' })).status], [true, '"v1"', 404]);
  await shut(off);

  const g = le.askGate({ clock: () => 0 });
  for (let i = 0; i < 300; i++) g.ticket();
  same('the gate holds a bounded number of tickets', [g.redeem('missing', asScript), g.keyOk(''), g.keyOk(g.key), g.rate('other')], [null, false, true, true]);
  await shut(up.server);
}

// ---------------------------------------------------------------------------
// The overlay with an ask box, in a page that is just enough DOM.
// ---------------------------------------------------------------------------

const CORNERS = ['bottom-left', 'bottom-right', 'top-right', 'top-left', 'right', 'left'];
const box = { left: 10, right: 110, top: 20, bottom: 50, width: 100, height: 30 };
const styleBag = () => {
  const s = {
    setProperty(k, val) { s[k] = val; }, getPropertyValue(k) { return typeof s[k] === 'string' ? s[k] : ''; }, removeProperty(k) { delete s[k]; },
  };
  return s;
};
function pageDom({ speech = null } = {}) {
  const dom = { nodes: [], fetches: [], listeners: {}, observers: [], timeouts: [], routes: {}, page: {}, bodyText: '' };
  const node = (tag) => {
    const n = {
      tag, nodeType: 1, className: '', children: [], attrs: {}, listeners: {}, isConnected: false, text: '', value: '', parentElement: null, style: styleBag(), focused: false,
      setAttribute(k, val) { n.attrs[k] = String(val); }, getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; }, removeAttribute(k) { delete n.attrs[k]; },
      appendChild(c) { c.parentElement = n; n.children.push(c); return c; }, removeChild(c) { n.children.splice(n.children.indexOf(c), 1); return c; },
      addEventListener(type, fn) { n.listeners[type] = fn; }, getBoundingClientRect() { return box; }, focus() { n.focused = true; },
      querySelectorAll(sel) {
        const attr = /^\[([\w-]+)\]$/.exec(sel)[1];
        const out = [];
        const walk = (x) => { for (const c of x.children || []) { if (c.attrs && attr in c.attrs) out.push(c); walk(c); } };
        walk(n);
        return out;
      },
      attachShadow(o) { n.shadowMode = o.mode; n.shadow = node('#shadow'); return n.shadow; },
      get firstChild() { return n.children[0] || null; },
      get textContent() { return n.text + n.children.map((c) => c.textContent).join(''); },
      set textContent(val) { n.text = String(val); n.children = []; },
    };
    dom.nodes.push(n);
    return n;
  };
  const documentElement = node('html');
  documentElement.appendChild = (c) => { documentElement.children.push(c); c.isConnected = true; return c; };
  dom.host = () => dom.nodes.find((x) => x.tag === 'live-edit-overlay');
  dom.document = {
    documentElement, readyState: 'complete', createElement: node, createTextNode: (text) => ({ textContent: String(text) }),
    elementsFromPoint: () => [dom.host()], querySelectorAll: (sel) => dom.page[sel] || [], addEventListener() {},
    get body() { return { innerText: dom.bodyText }; },
  };
  dom.window = {
    fetch: (url, opts) => {
      dom.fetches.push([url, opts]);
      const route = dom.routes[String(url).split('?')[0]];
      return route ? Promise.resolve(route(url, opts)) : Promise.reject(new Error('no helper'));
    },
    addEventListener: (type, fn) => { dom.listeners[type] = fn; },
    setInterval: () => 1,
    setTimeout: (fn, ms) => { dom.timeouts.push([fn, ms]); return 1; },
    getComputedStyle: () => ({ position: 'static' }),
    MutationObserver: class { constructor(fn) { this.fn = fn; dom.observers.push(this); } observe(target, opts) { this.target = target; this.opts = opts; } },
  };
  if (speech) dom.window.webkitSpeechRecognition = speech;
  dom.posts = (name) => dom.fetches.filter(([u, o]) => u === `/__live-edit/${name}` && o && o.method === 'POST').map(([, o]) => ({ headers: o.headers, body: JSON.parse(o.body) }));
  return dom;
}
const reply = (status, body) => ({ status, json: () => Promise.resolve(body) });
const trusted = (extra = {}) => ({ isTrusted: true, preventDefault() {}, stopPropagation() {}, ...extra });
const forged = (extra = {}) => ({ isTrusted: false, preventDefault() {}, stopPropagation() {}, ...extra });
const KEY = 'k'.repeat(32);
// The config the proxy serves, read out of the served script itself.
const servedConfig = (ask) => JSON.parse(/\)\(window, document, (\{[\s\S]*?\}), \(function a2uiKit/.exec(le.overlayScript('pill', ask))[1]);
const textNode = (value) => ({ nodeType: 3, nodeValue: value, isConnected: true });
const pageEl = (child, extra = {}) => ({ nodeType: 1, childNodes: [child], firstChild: child, style: styleBag(), getBoundingClientRect: () => box, ...extra });
const feedOf = (asks, messages = [], extra = {}) => ({ reset: false, asks, messages, listening: true, ...extra });

async function overlaySuite() {
  console.log('the overlay\'s ask box');
  const config = servedConfig({ layout: 'panel', point: true, preview: true, key: KEY });
  same('the served config names every endpoint, the layout and the cap', [config.ask.layout, config.ask.askUrl, config.ask.feedUrl, config.ask.maxChars, config.ask.key], ['panel', '/__live-edit/ask', '/__live-edit/feed', le.ASK_MAX, KEY]);
  same('with the ask box off the script carries no ask at all', servedConfig({ layout: 'off', key: KEY }).ask, null);

  const dom = pageDom();
  let feed = feedOf([]);
  dom.routes['/__live-edit/state'] = () => reply(200, { ok: true, pill: 'No pending changes', changes: { count: 0, lines: [] }, eta: null, etaNote: 'Nothing to ship yet.' });
  dom.routes['/__live-edit/feed'] = () => reply(200, feed);
  dom.routes['/__live-edit/ask'] = () => reply(200, { id: 'a1' });
  dom.routes['/__live-edit/action'] = () => reply(200, { id: 't1' });
  dom.routes['/__live-edit/seen'] = () => reply(200, { ok: true });
  dom.routes['/__live-edit/error'] = () => reply(200, { id: 'e1' });
  const api = le.overlayClient(dom.window, dom.document, config, kit.a2uiKit());
  await flush();
  same('the shadow root is closed and the page sees only a marker', [dom.host().shadowMode, dom.window.__liveEditOverlay], ['closed', true]);
  same('the panel holds the ask box: Point and Send, no Dictate without a speech API', [api.input !== null, api.pointBtn.textContent, api.sendBtn.textContent, api.micBtn, api.wrap.getAttribute('data-ask')], [true, 'Point', 'Send', null, 'panel']);
  check('the feed is polled with the key, and again soon while nothing is busy', dom.fetches.some(([u, o]) => u === '/__live-edit/feed?after=0' && o.headers['x-live-edit-key'] === KEY) && dom.timeouts.length === 1 && dom.timeouts[0][1] === 2000, dom.timeouts);

  api.input.value = 'Make the hero button say Book a call';
  api.sendBtn.listeners.click(forged());
  api.input.listeners.keydown(forged({ key: 'Enter' }));
  await flush();
  same('an untrusted click on Send sends nothing', dom.posts('ask').length, 0);
  api.input.listeners.keydown(trusted({ key: 'Enter', shiftKey: true }));
  same('Shift+Enter is a new line, not a send', dom.posts('ask').length, 0);
  api.sendBtn.listeners.click(trusted());
  await flush();
  const sent = dom.posts('ask');
  same('a trusted click sends the words with the key, as JSON', [sent.length, sent[0].headers['x-live-edit-key'], sent[0].headers['content-type'], sent[0].body.text, sent[0].body.target, typeof sent[0].body.instance], [1, KEY, 'application/json', 'Make the hero button say Book a call', null, 'string']);
  same('the box empties and the ask shows as received', [api.input.value, api.asksEl.textContent.includes('Received'), api.pill.textContent.startsWith('Received')], ['', true, true]);
  const instance = sent[0].body.instance;

  api.input.value = 'x'.repeat(le.ASK_MAX + 5);
  await api.sendAsk();
  same('a box over the cap says so and sends nothing', [api.note(), dom.posts('ask').length], [`That is ${le.ASK_MAX + 5} characters. One ask holds ${le.ASK_MAX}.`, 1]);
  api.input.value = '   ';
  await api.sendAsk();
  same('an empty box says so', api.note(), 'Type or dictate a change first.');
  for (const [status, words] of [[403, 'Reload the page to ask'], [429, 'Too many asks'], [413, 'too long'], [500, 'status 500']]) {
    dom.routes['/__live-edit/ask'] = () => reply(status, {});
    api.input.value = 'again';
    await api.sendAsk();
    check(`a ${status} from the helper is said in plain words`, api.note().includes(words), api.note());
  }
  dom.routes['/__live-edit/ask'] = () => Promise.reject(new Error('down'));
  api.input.value = 'again';
  await api.sendAsk();
  check('a helper that stopped is said', api.note().includes('helper stopped'), api.note());

  const t0 = Date.now();
  const ask1 = { id: 'a1', text: 'Make the hero button say Book a call', at: t0, state: 'working', instance };
  feed = feedOf([ask1]);
  await api.pollFeed();
  same('the pill follows the ask: working', api.pill.textContent, 'Working on it');

  // The page: a button whose only child is its text, and a hero section.
  const ctaText = textNode('Book now');
  const cta = pageEl(ctaText);
  const hero = pageEl(textNode('hero'));
  dom.page['#cta'] = [cta];
  dom.page['.hero'] = [hero];
  const msgs = choices().map((msg, i) => ({ seq: i + 1, ask: 'a1', msg }));
  feed = feedOf([{ ...ask1, state: 'choices' }], msgs);
  await api.pollFeed();
  const surface = api.surfacesEl.children[0];
  same('the drawn choices open the panel and show each option', [api.wrap.getAttribute('data-open'), surface.getAttribute('data-surface'), ['Pick the hero button copy', 'Book a call', 'Tell us about your project', 'Forest', 'Gap16px', 'Use this gap'].every((t) => surface.textContent.includes(t)), api.state().after], ['true', 'hero', true, 2]);
  const byId = (id) => dom.nodes.find((x) => x.attrs['data-id'] === id && x.parentElement);
  byId('v1').listeners.click(forged());
  await flush();
  same('an untrusted tap on a choice sends nothing and previews nothing', [dom.posts('action').length, ctaText.nodeValue], [0, 'Book now']);
  byId('v1').listeners.click(trusted());
  await flush();
  const pick = dom.posts('action')[0];
  same('a trusted tap previews the copy in place and sends the pick', [ctaText.nodeValue, cta.style.outline, pick.body.action.name, pick.body.action.context, pick.headers['x-live-edit-key'], byId('v1').getAttribute('data-picked')], ['Book a call', '2px dashed #2f6f4f', 'pick_copy', { copy: 'Book a call' }, KEY, '']);
  same('the sent pick passes the proxy\'s own check', kit.checkTap(pick.body, stateOf(choices())).ok, true);
  byId('sw').listeners.click(trusted());
  await flush();
  same('a colour previews as a style', [cta.style['background-color'], dom.posts('action').length], ['#2f6f4f', 2]);
  const range = byId('gap').children[1];
  range.value = '24';
  range.listeners.input(forged());
  same('an untrusted slide changes nothing', [api.state().surfaces.surfaces.get('hero').data.gap, hero.style.gap], [16, undefined]);
  range.listeners.input(trusted());
  byId('apply').listeners.click(trusted());
  await flush();
  same('a trusted slide previews the spacing and the button sends the value', [hero.style.gap, byId('gap').textContent, dom.posts('action')[2].body.action.context], ['24px', 'Gap24px', { gap: 24 }]);

  const bad = { seq: 3, ask: 'a1', msg: v({ updateComponents: { surfaceId: 'hero', components: [{ id: 'x', component: 'Script', src: 'https://example.test/x.js' }] } }) };
  feed = feedOf([{ ...ask1, state: 'choices' }], [bad]);
  await api.pollFeed();
  const error = dom.posts('error')[0];
  same('a message outside the catalog is refused on the page too, and reported', [error.body.error.code, error.body.error.surfaceId, error.body.error.message, dom.nodes.some((x) => x.attrs['data-id'] === 'x'), api.state().after], ['VALIDATION_FAILED', 'hero', '"Script" is not in the live edit catalog', false, 3]);

  // The session edited the source. The preview of the same words does not count until the page rewrites them.
  byId('v1').listeners.click(trusted());
  await flush();
  same('tapping the copy again puts its preview back', ctaText.nodeValue, 'Book a call');
  const edited = { ...ask1, state: 'edited', expect: 'Book a call', editedAt: Date.now(), tapAt: Date.now() };
  dom.bodyText = 'Book a call';
  feed = feedOf([edited]);
  await api.pollFeed();
  same('a preview showing the expected words is not the edit', dom.posts('seen').length, 0);
  api.onMutations([{ target: ctaText, oldValue: 'Book a call', addedNodes: [] }]);
  await flush();
  same('once the page itself rewrites them, seen is sent with the page\'s instance', dom.posts('seen').map((p) => p.body), [{ id: 'a1', instance }]);
  api.checkVisible();
  same('seen is sent once', dom.posts('seen').length, 1);

  feed = feedOf([{ ...edited, state: 'visible', visibleAt: Date.now(), visibleMs: 5400, fromTapMs: 3200, sameInstance: true }]);
  await api.pollFeed();
  same('visible says the seconds from the pick and closes the choices', [api.pill.textContent, api.surfacesEl.children.length, cta.style.outline, cta.style['background-color']], ['Visible 3.2 s after your pick', 0, undefined, undefined]);
  feed = feedOf([{ id: 'a2', text: 'x', at: t0, state: 'visible', visibleAt: Date.now(), visibleMs: 4100, sameInstance: false }]);
  await api.pollFeed();
  same('a change that needed a reload says so', api.pill.textContent, 'Visible after 4.1 s, after a reload');
  feed = feedOf([{ id: 'a3', text: 'x', at: t0, state: 'failed', reason: 'the file is generated', failedAt: Date.now() }]);
  await api.pollFeed();
  same('failed says the reason', [api.pill.textContent, api.wrap.getAttribute('data-ask-state')], ['Failed: the file is generated', 'failed']);
  feed = feedOf([{ id: 'a4', text: 'x', at: t0, state: 'failed', failedAt: Date.now() - 60e3 }]);
  await api.pollFeed();
  same('a finished ask leaves the pill to the changes after a while', [api.drawPill(), api.pill.textContent], ['state', 'No pending changes']);
  feed = feedOf([{ id: 'a5', text: 'x', at: t0, state: 'received' }], [], { listening: false });
  await api.pollFeed();
  same('received with no session listening says so', api.pill.textContent, 'Received. No session is listening yet.');
  feed = feedOf([], [], { reset: true });
  await api.pollFeed();
  same('a reset log drops the drawn surfaces', [api.state().surfaces.surfaces.size, api.state().after], [0, 0]);

  // A failed ask puts back what its preview changed.
  const label = textNode('Old');
  dom.page['#label'] = [pageEl(label)];
  feed = feedOf([{ id: 'b1', text: 'x', at: t0, state: 'choices' }], [
    { seq: 1, ask: 'b1', msg: v({ createSurface: { surfaceId: 'lbl', catalogId: CAT } }) },
    { seq: 2, ask: 'b1', msg: v({ updateComponents: { surfaceId: 'lbl', components: [{ id: 'root', component: 'Button', child: 't', action: { event: { name: 'pick' } }, preview: { selector: '#label', text: 'New', style: { color: '#ff0000' } } }, { id: 't', component: 'Text', text: 'New' }] } }) },
  ]);
  await api.pollFeed();
  dom.nodes.find((x) => x.attrs['data-id'] === 'root' && x.parentElement && x.parentElement.getAttribute('data-surface') === 'lbl').listeners.click(trusted());
  await flush();
  same('a preview changes the words in place', label.nodeValue, 'New');
  feed = feedOf([{ id: 'b1', text: 'x', at: t0, state: 'failed', reason: 'no', failedAt: Date.now() }]);
  await api.pollFeed();
  same('a failed ask restores what its preview changed', [label.nodeValue, dom.page['#label'][0].style.color], ['Old', undefined]);

  // Pointing at a part of the page.
  const parent = { nodeType: 1, tagName: 'P', id: '', previousElementSibling: null, getAttribute: () => null };
  parent.parentElement = dom.document.documentElement;
  const sib = { tagName: 'SPAN', previousElementSibling: null };
  const span = { nodeType: 1, tagName: 'SPAN', id: '', innerText: '  Our   prices ', previousElementSibling: sib, parentElement: parent, getBoundingClientRect: () => box, getAttribute: (k) => ({ 'data-inspector-relative-path': 'src/app/page.tsx', 'data-inspector-line': '12' }[k] || null) };
  api.onPageClick(trusted({ target: span }));
  same('a plain click on the page is the page\'s own', api.state().target, null);
  api.pointBtn.listeners.click(forged());
  same('an untrusted click does not start pointing', api.state().pointing, false);
  api.pointBtn.listeners.click(trusted());
  api.onPageMove(trusted({ target: span }));
  same('pointing outlines what is under the pointer', [api.state().pointing, api.mark.getAttribute('data-on'), api.mark.style.width], [true, '', '100px']);
  api.onPageClick(forged({ target: span }));
  same('an untrusted click does not pick a target', api.state().target, null);
  api.onPageClick(trusted({ target: span }));
  same('a trusted click names the element, its words and its source', api.state().target, { selector: 'p:nth-of-type(1) > span:nth-of-type(2)', text: 'Our prices', tag: 'span', source: 'src/app/page.tsx:12' });
  same('the box says what the ask is about, and pointing ends', [api.targetEl.textContent, api.state().pointing, api.input.focused], ['AboutOur pricesClear', false, true]);
  api.targetEl.children[2].listeners.click(trusted());
  same('Clear forgets the target', [api.state().target, api.targetEl.getAttribute('hidden')], [null, '']);
  api.onPageClick(trusted({ target: { ...span, id: 'price' }, altKey: true }));
  same('Alt-click points without the button, and an id is enough', api.state().target.selector, '#price');
  api.pointBtn.listeners.click(trusted());
  api.onPageKey(trusted({ key: 'Escape' }));
  same('Escape ends pointing', api.state().pointing, false);
  const fiber = { _debugSource: { fileName: 'src/Hero.tsx', lineNumber: 7 } };
  const reactEl = { nodeType: 1, tagName: 'H1', id: 'h', textContent: 'Hello', getAttribute: () => null, parentElement: null, '__reactFiber$x1': { return: fiber } };
  same('a React 18 dev build names the source file', api.describe(reactEl).source, 'src/Hero.tsx:7');
  api.onPageClick(trusted({ target: dom.host(), altKey: true }));
  same('a click on the overlay itself is not a target', api.state().target.selector, '#price');

  // Asks need the key: a copy that earned none says how to get one.
  const keyless = pageDom();
  const noKeyApi = le.overlayClient(keyless.window, keyless.document, servedConfig({ layout: 'sheet', point: true, preview: true, key: null }), kit.a2uiKit());
  await flush();
  same('an overlay with no key shows how to get one and asks for nothing', [noKeyApi.input, noKeyApi.panel.textContent.includes('Reload this page to ask'), keyless.fetches.some(([u]) => String(u).startsWith('/__live-edit/feed')), noKeyApi.wrap.getAttribute('data-ask')], [null, true, false, 'sheet']);
  noKeyApi.panel.children[0].children[1].listeners.click();
  same('Close closes the panel', noKeyApi.wrap.getAttribute('data-open'), 'false');

  // Dictation fills the box, never sends.
  class Rec {
    constructor() { Rec.last = this; this.started = false; }
    start() { this.started = true; }
    stop() { if (this.onend) this.onend(); }
  }
  const spoken = pageDom({ speech: Rec });
  spoken.routes['/__live-edit/feed'] = () => reply(200, feedOf([]));
  const mic = le.overlayClient(spoken.window, spoken.document, servedConfig({ layout: 'side', point: false, preview: false, key: KEY }), kit.a2uiKit());
  await flush();
  same('Dictate appears when the browser has speech recognition, Point is off when asked', [mic.micBtn && mic.micBtn.textContent, mic.pointBtn], ['Dictate', null]);
  mic.micBtn.listeners.click(forged());
  same('an untrusted click does not start the microphone', Rec.last, undefined);
  mic.input.value = 'Make it';
  mic.micBtn.listeners.click(trusted());
  Rec.last.onresult({ results: [[{ transcript: ' bigger' }], [{ transcript: ' please ' }]] });
  same('speech fills the box in English and sends nothing', [Rec.last.lang, Rec.last.started, mic.input.value, spoken.posts('ask').length, mic.micBtn.getAttribute('aria-pressed')], ['en-US', true, 'Make it bigger please', 0, 'true']);
  mic.micBtn.listeners.click(trusted());
  same('a second click stops listening', mic.micBtn.getAttribute('aria-pressed'), 'false');
  mic.micBtn.listeners.click(trusted());
  Rec.last.onerror({ error: 'not-allowed' });
  same('a refused microphone hides Dictate and says to type', [mic.micBtn.getAttribute('hidden'), mic.note()], ['', 'Dictation stopped: not-allowed. Type the change instead.']);

  // The served script, in an empty realm: the checks' source travels with it.
  const realm = pageDom();
  realm.routes['/__live-edit/ask'] = () => reply(200, { id: 'z1' });
  realm.routes['/__live-edit/feed'] = () => reply(200, feedOf([]));
  let live = null;
  let threw = null;
  try { live = vm.runInNewContext(le.overlayScript('pill', { layout: 'panel', point: true, preview: true, key: KEY }), { window: realm.window, document: realm.document }); } catch (e) { threw = e.message; }
  same('the served ask script runs with nothing but window and document', [threw, Boolean(live && live.input)], [null, true]);
  if (live) {
    live.input.value = 'From an empty realm';
    live.sendBtn.listeners.click(trusted());
    await flush();
    same('and sends a trusted ask with the key', realm.posts('ask').map((p) => [p.body.text, p.headers['x-live-edit-key']]), [['From an empty realm', KEY]]);
  }
}

// ---------------------------------------------------------------------------
async function cliSuite({ site, q }) {
  console.log('the session\'s commands');
  const out = [];
  const err = [];
  const io = [(s) => out.push(s), (s) => err.push(s)];
  check('help names wait, reply and show', ['wait', 'reply', 'show'].every((c) => le.help().includes(`  ${c} `)));
  same('bad ask flags exit 1 with the reason', [await le.main(['state', '--dir', site, '--ask', 'popup'], ...io), await le.main(['state', '--dir', site, '--point', 'maybe'], ...io), await le.main(['wait'], ...io)], [1, 1, 1]);
  check('each with its reason', ['live-edit: --ask is one of panel, sheet, side, off', 'live-edit: --point is on or off', 'live-edit: wait needs --dir SITE'].every((l) => err.includes(l)), err);

  const id = le.addAsk(q, { text: 'Footer says 2027' }, Date.now());
  const run = (args) => spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20e3 });
  // Earlier blocks left items in the inbox; drain them so the process below gets this ask.
  while (le.claimNext(q)) { /* drained */ }
  le.enqueue(q, { kind: 'ask', id, at: Date.now(), text: 'Footer says 2027', target: null }, Date.now());
  const waited = run(['wait', '--dir', site, '--timeout', '5']);
  let item = null;
  try { item = JSON.parse(waited.stdout); } catch { /* shown below */ }
  same('as a process, wait exits 0 with the ask as JSON', [waited.status, item && item.ownerWords, item && item.kind, waited.stderr], [0, 'Footer says 2027', 'ask', '']);
  const idle = run(['wait', '--dir', site, '--timeout', '0']);
  same('wait with nothing asked exits 2 and says how to keep listening', [idle.status, idle.stdout.trim()], [2, 'live-edit: nothing asked in 0 s. Run wait again to keep listening.']);
  same('wait outside a repository, or with a bad timeout, exits 1', [await le.main(['wait', '--dir', tmp], ...io), await le.main(['wait', '--dir', site, '--timeout', 'soon'], ...io)], [1, 1]);

  out.length = 0;
  same('reply needs a known ask and a known state', [await le.main(['reply', '--dir', site, '--id', 'nope', '--state', 'edited'], ...io), await le.main(['reply', '--dir', site, '--id', id, '--state', 'shipped'], ...io)], [1, 1]);
  same('reply edited records what the page should show', [await le.main(['reply', '--dir', site, '--id', id, '--state', 'edited', '--expect', 'Footer 2027'], ...io), out.pop(), le.askView(le.readEvents(q)).find((a) => a.id === id).expect], [0, `live-edit: ${id} is edited, the page reports it visible once it shows "Footer 2027"`, 'Footer 2027']);
  same('reply failed records the reason, or says none was given', [await le.main(['reply', '--dir', site, '--id', id, '--state', 'failed'], ...io), le.askView(le.readEvents(q)).find((a) => a.id === id).reason], [0, 'no reason given']);
  same('reply working is plain', [await le.main(['reply', '--dir', site, '--id', id, '--state', 'working'], ...io), out.pop()], [0, `live-edit: ${id} is working`]);
  le.setAskState(q, id, 'visible', {}, Date.now());
  same('a visible ask takes no more replies', await le.main(['reply', '--dir', site, '--id', id, '--state', 'edited'], ...io), 1);

  const fresh = le.addAsk(q, { text: 'Pick a colour' }, Date.now());
  const good = path.join(tmp, 'choices.jsonl');
  fs.writeFileSync(good, choices('cli').map((x) => JSON.stringify(x)).join('\n'));
  const evil = path.join(tmp, 'evil.json');
  fs.writeFileSync(evil, JSON.stringify(v({ createSurface: { surfaceId: 'e', catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json' } })));
  const shown = run(['show', '--dir', site, '--id', fresh, '--file', evil]);
  check('show refuses a message outside our catalog, as a process, with exit 1', shown.status === 1 && shown.stderr.includes('refused: message 1: /createSurface/catalogId: live edit renders its own catalog only'), shown.stderr);
  same('show without a file, or with an unreadable one, exits 1', [await le.main(['show', '--dir', site, '--id', fresh], ...io), await le.main(['show', '--dir', site, '--id', fresh, '--file', path.join(tmp, 'none.json')], ...io)], [1, 1]);
  same('show draws a good batch', [await le.main(['show', '--dir', site, '--id', fresh, '--file', good], ...io), out.pop()], [0, `live-edit: drew 2 message(s) for ${fresh}. Run wait for the owner's pick.`]);
  same('the site\'s tree is still clean', git(site, 'status', '--porcelain'), '');
}

async function serveSuite({ site }) {
  console.log('serve with asks');
  const up = await startUpstream();
  const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const lines = [];
  const running = await le.serve({ dir: site, port, upstream: up.url, base: 'origin/main', variant: 'pill', headline: 'queue', ask: 'sheet', point: 'off', preview: 'on' }, (l) => lines.push(l));
  same('serve says which ask box it draws', lines[0].endsWith('ask box "sheet", changes since origin/main'), true);
  const page = await request(port, '/');
  const t = /\?t=([A-Za-z0-9_-]+)/.exec(page.body)[1];
  const script = await request(port, `/__live-edit/overlay.js?t=${t}`, { headers: { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' } });
  same('the served page and script carry the layout and the switches', [/"layout":"sheet","point":false,"preview":true/.test(script.body), /"key":"[A-Za-z0-9_-]{32}"/.test(script.body)], [true, true]);
  running.close();
  let threw = null;
  const plainDir = path.join(tmp, 'plain');
  fs.mkdirSync(plainDir, { recursive: true });
  try { await le.serve({ dir: plainDir, port, upstream: up.url, base: 'origin/main', variant: 'pill', ask: 'panel' }, () => {}); } catch (e) { threw = e.message; }
  same('asks outside a repository are refused before anything listens', /is not inside a git repository, so asks have nowhere to wait/.test(String(threw)), true);
  await shut(up.server);
}

// ---------------------------------------------------------------------------
const watchdog = setTimeout(() => {
  fail++;
  console.log('  FAIL the suite did not finish in 120 s');
  for (const stop of cleanup) { try { stop(); } catch { /* already closed */ } }
}, 120e3);

(async () => {
  a2uiSuite();
  const ctx = await queueSuite();
  await proxySuite(ctx);
  await overlaySuite();
  await cliSuite(ctx);
  await serveSuite(ctx);
})().catch((e) => {
  fail++;
  console.log('  FAIL the suite threw : ' + (e && e.stack ? e.stack : e));
}).then(() => {
  clearTimeout(watchdog);
  for (const stop of cleanup) { try { stop(); } catch { /* already closed */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a temp folder the OS still holds is not a result */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
});
