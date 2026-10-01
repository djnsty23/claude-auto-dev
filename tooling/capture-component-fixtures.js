#!/usr/bin/env node
'use strict';
/**
 * capture-component-fixtures.js - re-capture the component-rule snapshots in
 * tooling/fixtures/layout/components/snapshots from a REAL browser.
 *
 * Run it after changing harvestComponents() in layout-probe.js (the suite
 * fails on a stale componentSha) or a fixture page. It drives the pages
 * through unslop-sweep.js's own capture(), the same adapter a product sweep
 * uses, so the fixtures exercise the real pipeline rather than a copy of it.
 *
 * This repository has no browser dependency, so Playwright is passed in:
 *
 *   node tooling/capture-component-fixtures.js --playwright <dir of a playwright package>
 *
 * Pages are served from 127.0.0.1 on a fixed port so the recorded URLs are
 * stable and carry no local path.
 *
 * --layout re-captures the OTHER fixture set instead: the four pages in
 * tooling/fixtures/layout at 360, 390, 414, 768 and 1280, which
 * test-rendered-layout-gate.js reads and which fail on a stale probeSha.
 * Their viewport heights and URL are the ones they were first captured at,
 * and the component half is left out, as it was then.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tooling', 'fixtures', 'layout', 'components');
const OUT = path.join(DIR, 'snapshots');
const SWEEP = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'unslop-sweep.js'));
const CHECKS = require(path.join(ROOT, 'plugins', 'autodev-core', 'scripts', 'layout-checks.js'));

const WIDTHS = [390, 414, 1280];
const LAYOUT_DIR = path.join(ROOT, 'tooling', 'fixtures', 'layout');
const LAYOUT_PAGES = ['clean', 'defect-clip', 'defect-occlusion', 'defect-overflow'];
// Width -> viewport height, as the layout fixtures were first captured.
const LAYOUT_HEIGHTS = { 360: 800, 390: 844, 414: 896, 768: 1024, 1280: 800 };
// Each plant is captured at 390, where every rule applies.
const PLANTS = CHECKS.COMPONENT_CODES.map((c) => c.toLowerCase());

/** The capture list: [name, page path, width]. */
function plan(layout) {
    const list = [];
    if (layout) {
        for (const page of LAYOUT_PAGES) {
            for (const w of Object.keys(LAYOUT_HEIGHTS).map(Number)) list.push([`${page}-${w}`, `/${page}.html`, w]);
        }
        return list;
    }
    for (const page of ['header-mess', 'header-fixed', 'components-clean']) {
        for (const w of WIDTHS) list.push([`${page}-${w}`, `/${page}.html`, w]);
    }
    for (const p of PLANTS) list.push([`plant-${p}-390`, `/components-clean.html?plant=${p}`, 390]);
    return list;
}

function serve(port, dir) {
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
        const file = path.join(dir, path.basename(name));
        if (!name.endsWith('.html') || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(file));
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main(argv) {
    const layout = argv.includes('--layout');
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('usage: node tooling/capture-component-fixtures.js --playwright <playwright package dir> [--layout] [--port 7392] [--list]');
        console.log(`captures ${plan(false).length} snapshots into tooling/fixtures/layout/components/snapshots`);
        console.log(`--layout captures ${plan(true).length} into tooling/fixtures/layout/snapshots instead (port 7391)`);
        return 0;
    }
    if (argv.includes('--list')) { for (const [n, p, w] of plan(layout)) console.log(`${n}  ${p}  @${w}`); return 0; }
    const i = argv.indexOf('--playwright');
    if (i < 0 || !argv[i + 1]) { console.error('needs --playwright <dir of a playwright package>'); return 2; }
    const pw = require(path.resolve(argv[i + 1]));
    const pi = argv.indexOf('--port');
    const port = pi >= 0 ? Number(argv[pi + 1]) : (layout ? 7391 : 7392);
    const out = layout ? path.join(LAYOUT_DIR, 'snapshots') : OUT;
    const server = await serve(port, layout ? LAYOUT_DIR : DIR);
    const browser = await pw.chromium.launch({ headless: true });
    fs.mkdirSync(out, { recursive: true });
    let n = 0;
    try {
        for (const [name, p, w] of plan(layout)) {
            const opt = SWEEP.contextOptions(w);
            if (layout) opt.viewport.height = LAYOUT_HEIGHTS[w];
            const ctx = await browser.newContext(opt);
            const page = await ctx.newPage();
            const host = layout ? 'localhost' : '127.0.0.1';
            const cap = await SWEEP.capture(page, `http://${host}:${port}${p}`, w, { label: name });
            // capturedAt and the user agent are kept: the suite reads neither,
            // and a reader comparing captures wants them.
            const snap = cap.snapshot;
            if (layout) delete snap.components;
            fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(snap) + (layout ? '' : '\n'));
            const r = CHECKS.analyse(cap.snapshot);
            console.log(`${name.padEnd(34)} ${r.status} ${r.findings.map((f) => f.code).join(' ') || '-'}`);
            await ctx.close();
            n++;
        }
    } finally {
        await browser.close();
        server.close();
    }
    console.log(`${n} snapshots written`);
    return 0;
}

main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 2; });
