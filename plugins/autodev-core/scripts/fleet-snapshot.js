#!/usr/bin/env node
'use strict';
/**
 * fleet-snapshot.js - one page that says what needs the operator, what is moving,
 * and what is stranded, across the mandate's repos, with the population beside
 * every number.
 *
 * It is a SNAPSHOT and says so. A board this page could not keep live (the forge
 * and local git are not reachable from a browser) would be a lie the moment it
 * loaded, so the masthead carries the time every figure was measured and the
 * page names the probe that produced it. Re-run to republish.
 *
 *   node fleet-snapshot.js --out board.html            gather live, render
 *   node fleet-snapshot.js --json > snapshot.json      gather live, dump the data
 *   node fleet-snapshot.js --data snapshot.json --out board.html   render a dump
 *
 * Reads the same instruments the fleet already merges on, so the board and the
 * merge decision cannot disagree: check-pr-ready for each open PR, prd-states
 * at the TRUNK REF (never a working copy, which has as many current values as
 * there are checkouts), check-doc-staleness, and transcript mtimes for session
 * activity. Client repos are excluded by construction: the mandate's `repos`
 * array in ~/.claude/brain-brief.json is the population.
 *
 * `--data` exists so the renderer can be tested on a fixed dataset without gh,
 * git or a live fleet. The gather half is exercised by the fleet itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = __dirname;
const { summarise, storiesOf } = require(path.join(SCRIPTS, 'prd-states.js'));

function sh(cmd, args, cwd) {
    try {
        return execFileSync(cmd, args, {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1e8,
            env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }),
        });
    } catch (e) { return null; }
}
function shJson(cmd, args, cwd) {
    // check-pr-ready exits 2 or 3 with its JSON still on stdout; keep it.
    try { return JSON.parse(execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1e8 })); }
    catch (e) { try { return JSON.parse(String(e.stdout || '')); } catch (e2) { return null; } }
}

function trunkOf(cwd) {
    const h = sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
    if (h) return h.trim();
    for (const c of ['origin/main', 'origin/master']) if (sh('git', ['rev-parse', '--verify', c], cwd)) return c;
    return null;
}

/** Transcripts written in the last 24 h whose project dir is inside `repo`. */
function transcriptsFor(repo) {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const slug = repo.replace(/[:\\/]/g, '-').replace(/^-/, '');
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (e) { return { recent: [], scanned: 0 }; }
    let scanned = 0;
    for (const d of dirs) {
        if (!d.startsWith(slug)) continue;
        let files = [];
        try { files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch (e) { continue; }
        for (const f of files) {
            scanned++;
            let st; try { st = fs.statSync(path.join(root, d, f)); } catch (e) { continue; }
            const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
            if (ageMin > 24 * 60) continue;
            out.push({ worktree: d.slice(slug.length).replace(/^-+\.claude-worktrees-/, '').replace(/^-+/, '') || '(root)', ageMin });
        }
    }
    out.sort((a, b) => a.ageMin - b.ageMin);
    return { recent: out, scanned };
}

function repoFacts(repoPath) {
    const cwd = repoPath;
    sh('git', ['fetch', '-q', 'origin'], cwd);
    const trunk = trunkOf(cwd);
    const tip = trunk ? (sh('git', ['log', '-1', '--format=%h %s', trunk], cwd) || '').trim() : '';
    const tipAge = trunk ? (sh('git', ['log', '-1', '--format=%cr', trunk], cwd) || '').trim() : '';

    const prs = [];
    const list = shJson('gh', ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,isDraft,headRefName'], cwd) || [];
    for (const p of list) {
        const r = shJson('node', [path.join(SCRIPTS, 'check-pr-ready.js'), String(p.number), '--repo', cwd, '--json']) || {};
        prs.push({ number: p.number, title: p.title, draft: !!p.isDraft, head: p.headRefName,
            verdict: r.verdict || 'CANNOT_TELL', population: r.population || {}, reasons: (r.reasons || []).slice(0, 3) });
    }

    let prd = null;
    if (trunk) {
        const raw = sh('git', ['show', trunk + ':prd.json'], cwd);
        if (raw) {
            try {
                const st = storiesOf(JSON.parse(raw)); const s = summarise(st);
                const next = Object.entries(st).filter(([, v]) => v && (v.passes === null || v.passes === false)).slice(0, 3)
                    .map(([id, v]) => ({ id, title: String(v.title || '').slice(0, 64) }));
                prd = { done: s.done, pending: s.pending, failed: s.failed, deferred: s.deferred, needsSetup: s.needsSetup, total: s.total, next };
            } catch (e) { prd = null; }
        }
    }

    const stale = shJson('node', [path.join(SCRIPTS, 'check-doc-staleness.js'), '--repo', cwd, '--age', '7', '--max', '3', '--json']) || null;
    const branchesAhead = trunk ? (sh('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], cwd) || '')
        .split('\n').filter((b) => b && !/\/(main|master|HEAD)$/.test(b) && b !== trunk)
        .filter((b) => Number((sh('git', ['rev-list', '--count', trunk + '..' + b], cwd) || '0').trim()) > 0).length : null;

    const { recent, scanned } = transcriptsFor(repoPath);
    return { name: path.basename(repoPath), trunk, tip, tipAge, prs, prd,
        stale: stale && stale.population ? stale.population : null, branchesAhead, transcripts: recent, transcriptsScanned: scanned };
}

function gather() {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'brain-brief.json'), 'utf8'));
    let away = null;
    try { away = (fs.readFileSync(path.join(os.homedir(), 'claude-memory', 'AWAY.md'), 'utf8').match(/until:\s*(\S+)/) || [])[1] || null; } catch (e) { away = null; }
    return { measuredAt: new Date().toISOString(), repos: (cfg.repos || []).map(repoFacts), clientReposExcluded: (cfg.clients || []).length, away };
}

// ---------------------------------------------------------------- render
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (m) => m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';

function verdictChip(v) {
    const cls = v === 'READY' ? 'good' : v === 'CANNOT_TELL' ? 'warn' : 'crit';
    const word = v === 'READY' ? 'ready' : v === 'CANNOT_TELL' ? 'cannot tell' : 'not ready';
    return '<span class="chip ' + cls + '">' + word + '</span>';
}

function prdBar(p) {
    if (!p) return '<p class="muted mono">no prd.json at the trunk</p>';
    const segs = [['done', p.done, 'good'], ['pending', p.pending, 'accent'], ['failed', p.failed, 'crit'], ['deferred', p.deferred, 'muted'], ['needs setup', p.needsSetup, 'warn']].filter(([, n]) => n > 0);
    const bar = segs.map(([k, n, c]) => '<i class="seg ' + c + '" style="flex:' + n + '" title="' + k + ' ' + n + '"></i>').join('');
    const legend = segs.map(([k, n]) => '<span><b class="mono">' + n + '</b> ' + k + '</span>').join('');
    const next = (p.next || []).length ? '<ol class="next">' + p.next.map((s) => '<li><span class="mono">' + esc(s.id) + '</span> ' + esc(s.title) + '</li>').join('') + '</ol>' : '';
    return '<div class="bar" role="img" aria-label="' + p.total + ' stories: ' + segs.map(([k, n]) => n + ' ' + k).join(', ') + '">' + bar + '</div>'
        + '<div class="legend">' + legend + '<span class="muted">of <b class="mono">' + p.total + '</b></span></div>' + next;
}

function repoPanel(r) {
    const ready = r.prs.filter((p) => p.verdict === 'READY').length;
    const prs = r.prs.length
        ? '<ul class="prs">' + r.prs.map((p) => '<li>' + verdictChip(p.verdict) + '<span class="mono">#' + esc(p.number) + '</span> <span class="t">' + esc(p.title) + '</span>'
            + (p.draft ? '<span class="chip muted">draft</span>' : '') + '<span class="why mono">' + esc(String((p.reasons || [])[0] || '').slice(0, 90)) + '</span></li>').join('') + '</ul>'
        : '<p class="muted">no open pull requests</p>';
    const st = r.stale;
    const stale = st ? '<span class="mono">' + (st.olderThanAgeDays || 0) + '</span> of <span class="mono">' + (st.openStateAndDated || 0) + '</span> dated open-state claims older than 7 d, in <span class="mono">' + (st.present || 0) + '</span> boot docs' : 'not scanned';
    const tr = (r.transcripts || []).length
        ? r.transcripts.slice(0, 5).map((s) => '<li><span class="mono">' + esc(s.worktree) + '</span><span class="muted mono">' + ago(s.ageMin) + ' ago</span></li>').join('')
        : '<li class="muted">none written in 24 h</li>';
    return '<section class="repo">\n'
        + '  <header><h2>' + esc(r.name) + '</h2><span class="mono muted">' + esc(r.trunk || 'no trunk') + '</span></header>\n'
        + '  <p class="tip mono">' + esc(r.tip) + ' <span class="muted">' + esc(r.tipAge) + '</span></p>\n'
        + '  <h3>Pull requests <span class="count mono">' + r.prs.length + '</span>' + (ready ? '<span class="chip good">' + ready + ' mergeable</span>' : '') + '</h3>\n'
        + '  ' + prs + '\n'
        + '  <h3>Stories</h3>\n  ' + prdBar(r.prd) + '\n'
        + '  <h3>Documents</h3>\n  <p class="small">' + stale + '</p>\n'
        + '  <h3>Transcripts, 24 h <span class="count mono">' + (r.transcripts || []).length + '</span></h3>\n  <ul class="sess">' + tr + '</ul>\n'
        + '  <p class="foot mono muted">' + (r.branchesAhead == null ? '' : r.branchesAhead + ' branches ahead of the trunk · ') + (r.transcriptsScanned || 0) + ' transcripts scanned</p>\n'
        + '</section>';
}

const CSS = [
    ':root{--paper:#eef0ee;--card:#f8f9f8;--sunk:#e2e6e4;--ink:#161a19;--ink2:#4f5856;--muted:#66706e;--rule:#cfd5d2;--accent:#3b6d8c;--accent-soft:#dbe6ee;--good:#2f7a52;--warn:#a06d12;--crit:#a83a2b;--shadow:0 1px 2px rgba(22,26,25,.06),0 12px 28px -20px rgba(22,26,25,.35)}',
    '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#121615;--card:#1a1f1e;--sunk:#222827;--ink:#e7ebe9;--ink2:#b3bbb8;--muted:#8c9592;--rule:#2b3331;--accent:#8db6d0;--accent-soft:#1d2b34;--good:#5fc08c;--warn:#d9a84e;--crit:#ef8b7a;--shadow:0 1px 2px rgba(0,0,0,.5),0 12px 28px -20px rgba(0,0,0,.8)}}',
    ':root[data-theme="dark"]{--paper:#121615;--card:#1a1f1e;--sunk:#222827;--ink:#e7ebe9;--ink2:#b3bbb8;--muted:#8c9592;--rule:#2b3331;--accent:#8db6d0;--accent-soft:#1d2b34;--good:#5fc08c;--warn:#d9a84e;--crit:#ef8b7a;--shadow:0 1px 2px rgba(0,0,0,.5),0 12px 28px -20px rgba(0,0,0,.8)}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 "Libre Franklin",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}',
    '.wrap{max-width:1180px;margin:0 auto;padding:0 24px 56px}',
    'h1,h2,h3{font-family:"Schibsted Grotesk",ui-sans-serif,system-ui,sans-serif;margin:0;letter-spacing:-.015em;text-wrap:balance}',
    '.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;font-size:.9em}',
    '.muted{color:var(--muted)}',
    '.mast{padding:40px 0 22px;border-bottom:1px solid var(--rule);display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 32px}',
    '.mast h1{font-size:clamp(1.8rem,4vw,2.6rem);line-height:1.05;font-weight:700}',
    '.mast .stamp{font-family:"IBM Plex Mono",monospace;font-size:.8rem;color:var(--muted);letter-spacing:.04em}',
    '.mast .stamp b{color:var(--ink);font-weight:500}',
    '.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:22px 0 30px}',
    '.tile{background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:14px 16px}',
    '.tile .v{font-family:"Schibsted Grotesk",sans-serif;font-size:2rem;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}',
    '.tile .k{font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-top:6px}',
    '.tile.you{border-color:var(--accent);background:var(--accent-soft)}',
    '.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));align-items:start}',
    '.repo{background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:18px 18px 12px;box-shadow:var(--shadow)}',
    '.repo header{display:flex;align-items:baseline;justify-content:space-between;gap:10px;border-bottom:1px solid var(--rule);padding-bottom:8px}',
    '.repo h2{font-size:1.25rem;font-weight:700}',
    '.repo h3{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:16px 0 6px;display:flex;align-items:center;gap:8px;font-weight:600}',
    '.repo .count{color:var(--ink);font-size:.8rem}',
    '.tip{margin:10px 0 0;font-size:.82rem;overflow-wrap:anywhere}',
    '.prs,.sess,.next{list-style:none;margin:0;padding:0;display:grid;gap:6px}',
    '.prs li{display:grid;grid-template-columns:auto auto 1fr;gap:4px 8px;align-items:baseline;padding:6px 0;border-top:1px solid var(--rule)}',
    '.prs li:first-child{border-top:0}',
    '.prs .t{font-size:.9rem;overflow-wrap:anywhere}',
    '.prs .why{grid-column:1/-1;font-size:.72rem;color:var(--muted)}',
    '.chip{display:inline-flex;align-items:center;font-family:"IBM Plex Mono",monospace;font-size:.68rem;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}',
    '.chip.good{color:var(--good)}.chip.warn{color:var(--warn)}.chip.crit{color:var(--crit)}.chip.muted{color:var(--muted)}',
    '.bar{display:flex;height:10px;border-radius:2px;overflow:hidden;background:var(--sunk);gap:1px}',
    '.seg{display:block}.seg.good{background:var(--good)}.seg.accent{background:var(--accent)}.seg.crit{background:var(--crit)}.seg.muted{background:var(--muted)}.seg.warn{background:var(--warn)}',
    '.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.78rem;margin-top:6px}',
    '.next{margin-top:8px}.next li{display:flex;gap:8px;font-size:.82rem;align-items:baseline}',
    '.sess li{display:flex;justify-content:space-between;gap:8px;font-size:.8rem}',
    '.small{font-size:.82rem;margin:0}',
    '.foot{font-size:.7rem;margin:14px 0 0;border-top:1px solid var(--rule);padding-top:8px}',
    '.note{margin:32px 0 0;padding:14px 16px;border-left:2px solid var(--accent);font-size:.85rem;color:var(--ink2);max-width:66ch}',
    '@media (prefers-reduced-motion:reduce){*{transition:none!important}}',
].join('\n');

function render(d) {
    const total = { prs: 0, ready: 0, pending: 0, transcripts: 0 };
    for (const r of d.repos) {
        total.prs += r.prs.length; total.ready += r.prs.filter((p) => p.verdict === 'READY').length;
        total.pending += (r.prd && r.prd.pending) || 0; total.transcripts += (r.transcripts || []).length;
    }
    const when = String(d.measuredAt || '').replace('T', ' ').slice(0, 16) + ' UTC';
    return '<title>Fleet Board</title>\n'
        + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500;600;700&family=Libre+Franklin:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">\n'
        + '<style>\n' + CSS + '\n</style>\n'
        + '<div class="wrap">\n<header class="mast">\n  <h1>Fleet Board</h1>\n'
        + '  <div class="stamp">measured <b>' + esc(when) + '</b> · ' + d.repos.length + ' repos in the mandate · ' + (d.clientReposExcluded || 0) + ' client repos excluded'
        + (d.away ? ' · away window until <b>' + esc(d.away) + '</b>' : '') + '</div>\n</header>\n'
        + '<div class="tiles">\n'
        + '  <div class="tile you"><div class="v">' + total.ready + '</div><div class="k">mergeable now</div></div>\n'
        + '  <div class="tile"><div class="v">' + total.prs + '</div><div class="k">open pull requests</div></div>\n'
        + '  <div class="tile"><div class="v">' + total.pending + '</div><div class="k">stories pending</div></div>\n'
        + '  <div class="tile"><div class="v">' + total.transcripts + '</div><div class="k">transcripts written, 24 h</div></div>\n'
        + '</div>\n<div class="grid">\n' + d.repos.map(repoPanel).join('\n') + '\n</div>\n'
        + '<p class="note">Every figure here is a snapshot from the same instruments the fleet merges on: each pull request through <span class="mono">check-pr-ready</span>, stories from <span class="mono">prd.json</span> at the trunk ref rather than any working copy, document claims from <span class="mono">check-doc-staleness</span>, sessions from transcript writes. A count with no population beside it is a guess, so each panel ends with what was scanned. Re-run the generator to republish.</p>\n'
        + '</div>';
}

module.exports = { gather, render, repoPanel, prdBar, esc };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
    const dataFile = arg('--data');
    const out = arg('--out');
    let d;
    if (dataFile) d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    else d = gather();
    if (argv.includes('--json')) console.log(JSON.stringify(d, null, 2));
    if (out) { fs.writeFileSync(out, render(d), 'utf8'); console.error('wrote ' + out + ' (' + fs.statSync(out).size + ' bytes) measured ' + d.measuredAt); }
    if (!out && !argv.includes('--json')) console.log('fleet-snapshot.js --out <file.html> | --json | --data <snapshot.json> --out <file.html>');
}
