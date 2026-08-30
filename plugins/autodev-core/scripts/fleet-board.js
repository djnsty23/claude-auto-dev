#!/usr/bin/env node
/**
 * fleet-board.js - the dispatch list, served locally and read live off disk.
 *
 * READ-ONLY BY MEASUREMENT, not by caution. A/B tested 2026-08-21 with one
 * instrument and two targets:
 *
 *   busy session (mid-turn, sitting on a panel)  -> send_message says "queued",
 *      and over 482s, 49 polls and 166KB of transcript growth it never arrived.
 *   idle session (70m, assistant spoke last)     -> send_message says "sent",
 *      delivered and acked in 20s.
 *
 * A panel does not end a turn - answering one feeds a tool_result back into the
 * same turn - so a session in an options-protocol loop may never reach the
 * boundary where queued mail is delivered. The sessions you most want to answer
 * are exactly the ones that cannot receive an answer. So this board tells you
 * WHICH session to go to; it does not pretend to answer for you.
 *
 * Usage:
 *   node fleet-board.js               # serve on 7717
 *   node fleet-board.js --port 8080
 *   node fleet-board.js --days 3
 *
 * No dependencies, no build step, binds loopback only.
 */
'use strict';
const http = require('http');
const path = require('path');
const { scanFleet } = require(path.join(__dirname, 'fleet-status.js'));

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(val('--port', 7717));
const DAYS = Number(val('--days', 2));

// F8 (codex audit 2026-08-30): --help used to fall through to the server -
// probing the script started it, and it stayed alive until killed. A script
// you cannot ask "what are you" without launching is a side effect wearing a
// CLI's clothes. Help exits before any fleet state is read.
if (argv.includes('--help') || argv.includes('-h')) {
    console.log('fleet-board - the dispatch list, served locally and read live off disk.');
    console.log('');
    console.log('Usage:');
    console.log('  node fleet-board.js               # serve on 7717');
    console.log('  node fleet-board.js --port 8080');
    console.log('  node fleet-board.js --days 3');
    console.log('');
    console.log('Binds loopback only. Read-only. No dependencies.');
    process.exit(0);
}

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--ground:#EDF0F3;--surface:#fff;--surface-2:#F5F7F9;--ink:#10151B;--ink-2:#3D4854;--ink-3:#6B7885;
--rule:#DCE2E8;--rule-2:#C6D0D9;--accent:#0F6E7E;--accent-soft:#DCEEF1;
--blocked:#B23A0E;--blocked-bg:#FBE9E0;--blocked-edge:#E8A886;--stalled:#8A6D1F;--stalled-bg:#FBF3DC;
--working:#0F6E7E;--idle:#7A8794;--done:#2F6B4F}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0C1116;--surface:#131A21;--surface-2:#1A232C;
--ink:#E6EDF3;--ink-2:#A9B7C4;--ink-3:#7A8894;--rule:#253039;--rule-2:#31404C;--accent:#4FC3D4;--accent-soft:#12333A;
--blocked:#FF8A4C;--blocked-bg:#361D11;--blocked-edge:#7A4526;--stalled:#D9B24C;--stalled-bg:#2E2712;
--working:#4FC3D4;--idle:#6E7C89;--done:#6FBF95}}
:root[data-theme="dark"]{--ground:#0C1116;--surface:#131A21;--surface-2:#1A232C;
--ink:#E6EDF3;--ink-2:#A9B7C4;--ink-3:#7A8894;--rule:#253039;--rule-2:#31404C;--accent:#4FC3D4;--accent-soft:#12333A;
--blocked:#FF8A4C;--blocked-bg:#361D11;--blocked-edge:#7A4526;--stalled:#D9B24C;--stalled-bg:#2E2712;
--working:#4FC3D4;--idle:#6E7C89;--done:#6FBF95}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.5}
.wrap{max-width:1000px;margin:0 auto;padding:26px 20px 70px}
h1{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:0 0 3px}
.sub{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}
header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.counts{display:flex;gap:0;border:1px solid var(--rule);border-radius:7px;overflow:hidden;background:var(--surface)}
.ct{padding:7px 14px;border-right:1px solid var(--rule);text-align:center}
.ct:last-child{border-right:0}
.ct b{display:block;font-family:"IBM Plex Mono",monospace;font-size:17px;font-weight:500;font-variant-numeric:tabular-nums}
.ct span{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}
.ct.hot b{color:var(--blocked)}
.ct.ctog{cursor:pointer;user-select:none}
.ct.ctog:hover{background:var(--surface-2)}
.ct.ctog:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.rows{background:var(--surface);border:1px solid var(--rule);border-radius:9px;overflow:hidden}
.row{display:grid;grid-template-columns:3px 88px minmax(0,1fr) auto;gap:0 13px;align-items:center;border-bottom:1px solid var(--rule)}
.row:last-child{border-bottom:0}
.stripe{align-self:stretch}
.row.blocked{background:var(--blocked-bg)}.row.blocked .stripe{background:var(--blocked)}
.row.stalled{background:var(--stalled-bg)}.row.stalled .stripe{background:var(--stalled)}
.st{padding:10px 0 10px 13px}.bd{padding:10px 0;min-width:0}.mt{padding:10px 15px 10px 0;text-align:right;white-space:nowrap}
.pill{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:10px;font-weight:500;letter-spacing:.05em;
text-transform:uppercase;padding:2px 7px;border-radius:3px;border:1px solid var(--rule-2);color:var(--ink-3);background:var(--surface-2)}
.pill.blocked{color:var(--blocked);border-color:var(--blocked-edge);background:var(--surface)}
.pill.stalled{color:var(--stalled);border-color:var(--stalled);background:var(--surface)}
.pill.working{color:var(--working);border-color:var(--accent);background:var(--accent-soft)}
.pill.done{color:var(--done)}
.ttl{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.age{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.row.blocked .age{color:var(--blocked);font-weight:500}
.panel{grid-column:2/-1;padding:0 15px 14px 0}
.q{font-size:14px;font-weight:500;margin:0 0 8px}
.opt{display:flex;gap:8px;align-items:flex-start;background:var(--surface);border:1px solid var(--rule);border-radius:5px;padding:6px 10px;margin-bottom:5px}
.opt .k{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--ink-3);border:1px solid var(--rule-2);border-radius:3px;padding:0 5px;flex:none;margin-top:2px}
.opt .l{font-size:13px}
.opt .d{font-size:12.5px;color:var(--ink-3);line-height:1.45;margin-top:2px}
.go{font-family:"IBM Plex Sans",sans-serif;font-size:11.5px;font-weight:500;color:var(--accent);background:var(--surface);
border:1px solid var(--accent);border-radius:5px;padding:4px 9px;cursor:pointer;margin-top:8px}
.go:hover{background:var(--accent-soft)}
.go:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.na{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink-3)}
.machines{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.mach{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-3);background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:5px 10px}
.mach b{color:var(--ink)}
.mach.hot{border-color:var(--blocked-edge)}
.mach.hot b{color:var(--blocked)}
.mach.stale{opacity:.6}
.mach i{font-style:normal;opacity:.75}
.empty{padding:34px 18px;text-align:center;color:var(--ink-3)}
.empty b{display:block;color:var(--ink);font-size:15px;margin-bottom:5px;font-weight:500}
footer{margin-top:16px;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-3)}
</style></head><body><div class="wrap">
<header>
  <div><h1>Fleet</h1><div class="sub" id="scanline">loading&hellip;</div></div>
  <div class="counts" id="counts"></div>
</header>
<div id="machines" class="machines"></div>
<div class="rows" id="rows"><div class="empty">loading&hellip;</div></div>
<footer id="foot"></footer>
</div>
<script>
var REFRESH_MS = 15000;
// Cold is hidden, not dropped. Measured: 72 of 124 sessions were quiet for a day
// or more against 4 blocked, so showing everything buries the rows that matter.
// The count stays visible and clickable, because a filter you cannot see is
// indistinguishable from data that never arrived.
var showCold = false;
var lastData = null;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function proj(cwd){ if(!cwd) return '?'; var p=cwd.split(/[\\\\/]/);
  var i=p.indexOf('.claude'); return i>0?p[i-1]:p[p.length-1]; }
// Three states, and the absent one must read as absent rather than as bad news:
// a session with no heartbeat is simply one the Stop hook has not run in yet.
function hb(s){
  if(s.endedCleanly===true)  return ' \\u00b7 turn ended';
  if(s.endedCleanly===false) return ' \\u00b7 <b style="color:var(--stalled)">turn never ended</b>';
  return '';
}
function render(d){
  lastData = d;
  var pop=d.population;
  var n=function(st){return d.sessions.filter(function(s){return s.state===st}).length};
  var coldCount=n('cold');
  document.getElementById('scanline').textContent =
    pop.transcripts+' transcripts \\u00b7 '+pop.dirs+' project dirs \\u00b7 '+pop.addressable+' addressable \\u00b7 '+
    new Date(d.scannedAt).toLocaleTimeString();
  document.getElementById('counts').innerHTML =
    '<div class="ct'+(pop.blocked?' hot':'')+'"><b>'+pop.blocked+'</b><span>blocked</span></div>'+
    '<div class="ct"><b>'+n('stalled')+'</b><span>stalled</span></div>'+
    '<div class="ct"><b>'+n('working')+'</b><span>working</span></div>'+
    '<div class="ct ctog" role="button" tabindex="0" title="'+(showCold?'hide':'show')+' sessions quiet 24h+">'+
      '<b>'+coldCount+'</b><span>cold '+(showCold?'\\u2212':'+')+'</span></div>'+
    '<div class="ct"><b>'+d.sessions.length+'</b><span>sessions</span></div>';

  if(!d.sessions.length){
    document.getElementById('rows').innerHTML='<div class="empty"><b>No sessions in window</b>Nothing has written a transcript recently.</div>';
    return;
  }
  var visible = showCold ? d.sessions : d.sessions.filter(function(s){return s.state!=='cold'});
  if(!visible.length){
    document.getElementById('rows').innerHTML='<div class="empty"><b>Nothing active</b>'+
      coldCount+' session'+(coldCount===1?'':'s')+' quiet for 24h+. Click "cold" above to show them.</div>';
    return;
  }
  var html = visible.map(function(s){
    var cls = s.state==='blocked' ? 'blocked' : (s.state==='stalled' ? 'stalled' : '');
    var out = '<div class="row '+cls+'"><div class="stripe"></div>'+
      '<div class="st"><span class="pill '+esc(s.state)+'">'+esc(s.state)+'</span></div>'+
      '<div class="bd"><div class="ttl">'+esc(s.title || proj(s.cwd))+'</div>'+
      '<div class="meta">'+esc(proj(s.cwd))+(s.gitBranch?' \\u00b7 '+esc(s.gitBranch):'')+
      (s.prNumber?' \\u00b7 PR #'+esc(s.prNumber):'')+hb(s)+'</div></div>'+
      '<div class="mt"><span class="age">'+s.idleMinutes+'m</span></div>';
    if(s.pending){
      out += '<div class="panel">';
      s.pending.questions.forEach(function(q){
        out += '<p class="q">'+esc(q.question)+'</p>';
        q.options.forEach(function(o,i){
          out += '<div class="opt"><span class="k">'+(i+1)+'</span><div><div class="l">'+esc(o.label)+'</div>'+
                 (o.description?'<div class="d">'+esc(o.description)+'</div>':'')+'</div></div>';
        });
      });
      // Deliberately not an answer control: a blocked session cannot receive a
      // message, so this copies the id you need to find it in the app instead.
      out += s.addressableId
        ? '<button class="go" data-id="'+esc(s.addressableId)+'">Copy session id</button>'
        : '<div class="na">no desktop record \\u2014 cannot be addressed</div>';
      out += '</div>';
    }
    return out + '</div>';
  }).join('');
  document.getElementById('rows').innerHTML = html;
  // Other machines. Always stamp the AGE — a stale count read as current is the
  // whole failure mode of a synced status file, and this one rides a 4-hourly
  // sync rather than a live connection.
  var mHtml = '';
  if (d.machines && d.machines.length) {
    mHtml = d.machines.map(function(m){
      var age = Math.round((Date.now() - Date.parse(m.publishedAt))/60000);
      var stale = age > 360;
      return '<span class="mach'+(m.blocked?' hot':'')+(stale?' stale':'')+'">'+
        esc(m.host)+': <b>'+m.blocked+'</b> blocked / '+m.sessions+
        ' <i>as of '+(age<60?age+'m':Math.round(age/60)+'h')+' ago</i></span>';
    }).join('');
  }
  document.getElementById('machines').innerHTML = mHtml;
  document.getElementById('foot').textContent =
    'read-only \\u00b7 a blocked session cannot receive a message, so go to it rather than answering from here';
}
function toggleCold(){ showCold = !showCold; if(lastData) render(lastData); }
document.addEventListener('keydown', function(e){
  if((e.key==='Enter'||e.key===' ') && e.target.closest && e.target.closest('.ctog')){
    e.preventDefault(); toggleCold();
  }
});
document.addEventListener('click', function(e){
  if(e.target.closest && e.target.closest('.ctog')){ toggleCold(); return; }
  var b = e.target.closest && e.target.closest('.go');
  if(!b) return;
  navigator.clipboard.writeText(b.dataset.id).then(function(){
    var t=b.textContent; b.textContent='Copied'; setTimeout(function(){b.textContent=t;},1200);
  }, function(){ b.textContent = b.dataset.id; });
});
function tick(){
  fetch('/api/fleet').then(function(r){return r.json();}).then(render).catch(function(e){
    document.getElementById('scanline').textContent='scan failed: '+e.message;
  });
}
tick(); setInterval(tick, REFRESH_MS);
</script></body></html>`;

// --------------------------------------------------------------- access guard
//
// Binding 127.0.0.1 keeps other HOSTS out. It does nothing about the browser
// already running on this machine, and that is the real exposure: /api/fleet
// carries sessionIds, absolute cwd paths (which spell out the OS username and
// client project directory names), branch names, titles, and the verbatim text
// of every open options panel. Any page the developer visits can point a
// hostname it controls at 127.0.0.1 — DNS rebinding — and then read all of it
// with a plain fetch.
//
// Three checks, on headers a hostile page cannot set:
//   Host   — the browser sends the name it dialled. A rebinding page's name is
//            neither 127.0.0.1 nor localhost, so it fails here.
//   Origin — browsers attach it to cross-origin requests and omit it on the
//            same-origin GET this board's own page makes, so its mere presence
//            means the request came from somewhere else.
//   Method — this surface is read-only.
//
// The board's own page is unaffected: it is served from, and fetches from, the
// exact origin the user typed.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const deny = (res, code, why) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${why}\n`);
};

// F8, second half: server construction, listen() and the first scan ran at
// module top level, so merely require()ing this file started the service.
// Everything with a side effect now lives behind require.main.
function serve() {
const server = http.createServer((req, res) => {
    if (req.method !== 'GET') return deny(res, 405, 'fleet board is read-only: GET only');
    if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
        return deny(res, 403, 'fleet board only answers to 127.0.0.1 or localhost');
    }
    if (req.headers.origin) return deny(res, 403, 'fleet board refuses cross-origin requests');

    if (req.url.startsWith('/api/fleet')) {
        let body;
        try {
            const fleet = scanFleet(DAYS);
            // Other machines publish COUNTS ONLY — see fleet-publish.js for why
            // nothing identifying can cross a git remote. Absent is normal: the
            // other host may simply not be publishing.
            try {
                const { readAll, DIR } = require(path.join(__dirname, 'fleet-publish.js'));
                fleet.machines = readAll().filter((m) => m.host !== require('os').hostname());
                fleet.machinesDir = DIR;
            } catch { fleet.machines = []; }
            body = JSON.stringify(fleet);
        } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(body);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
});

server.listen(PORT, '127.0.0.1', () => {
    const t0 = Date.now();
    const first = scanFleet(DAYS);
    console.log(`fleet board on http://127.0.0.1:${PORT}`);
    console.log(`  first scan: ${first.population.transcripts} transcripts, `
        + `${first.population.blocked} blocked, ${first.population.addressable} addressable `
        + `(${Date.now() - t0}ms)`);
});
}

if (require.main === module) serve();

module.exports = { esc };
