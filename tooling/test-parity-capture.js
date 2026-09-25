#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/parity-capture.js.
// Run: node tooling/test-parity-capture.js
// Exits 1 on any failure, 2 when a case produced no verdict, 0 when all pass.
//
// The script is driven as a SUBPROCESS against two local http servers, one per
// side, serving fixture sites built from the object below. The exit code and the
// printed report are what a caller consumes, so they are what is asserted. The
// child is spawned asynchronously: spawnSync would block this process's event
// loop, and with it the very servers the child is fetching from.
//
// Every planted defect runs twice more: against a COPY of the script with that
// defect's detector disabled, where the case's own named assertion must go red,
// and against the real script, where it must pass. The copy is made by an
// anchored replacement that must match exactly once, so a refactor that moves
// the anchor fails here by name instead of silently mutating nothing.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { tally, exitCode } = require('./spawn-budget.js');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'parity-capture.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-capture-test-'));

let pass = 0;
let fail = 0;
let infra = 0;
const indeterminate = [];
const planted = [];

function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (${String(detail).slice(0, 600)})`}`);
}

// ------------------------------------------------------------------ fixtures
//
// Written by hand. The harvest for each side is derived from the same page
// objects the HTML is rendered from, which is what a browser would report for
// pages with no client-side rendering. `clientOnly` text is the exception, put
// into the harvest and kept out of the HTML.

const FOOTER = [['/', 'Home'], ['/about', 'About us'], ['/pricing', 'Pricing'], ['/privacy', 'Privacy policy']];

function page(title, extra) {
    return {
        title, description: `${title} at Example Widgets`, jsonld: ['Organization'], h1: title,
        h2: ['Why widgets'], links: [], ctas: [], forms: [], text: [`${title} explains everything about sturdy widgets.`],
        clientOnly: [], ...extra,
    };
}

function baseSite() {
    return {
        '/': page('Home', {
            jsonld: ['Organization', 'WebSite'],
            ctas: [['/signup', 'Start free trial']],
            forms: [{ action: '/subscribe', method: 'post', fields: ['email', 'name'] }],
            text: ['We build sturdy widgets for every kind of workshop.', 'Shipping is free on every order over fifty euros.'],
        }),
        '/about': page('About'),
        '/pricing': page('Pricing', { text: ['Three plans, each billed monthly with no setup fee.'] }),
        '/privacy': page('Privacy'),
    };
}

function renderHtml(route, p) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': p.jsonld.map((t) => ({ '@type': t, name: 'Example' })) });
    const link = ([h, t]) => `<a href="${esc(h)}">${esc(t)}</a>`;
    const cta = ([h, t]) => `<a class="btn btn-primary" href="${esc(h)}">${esc(t)}</a>`;
    const form = (f) => `<form action="${f.action}" method="${f.method}">${f.fields.map((n) => `<input name="${n}">`).join('')}<button>Send</button></form>`;
    return `<!doctype html><html><head><title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${esc(p.canonical || 'https://example.com' + route)}">
<meta property="og:title" content="${esc(p.title)}">
<script type="application/ld+json">${ld}</script>
</head><body><header>${p.links.map(link).join('')}</header>
<main><h1>${esc(p.h1)}</h1>${p.h2.map((h) => `<h2>${esc(h)}</h2>`).join('')}
${p.text.map((t) => `<p>${esc(t)}</p>`).join('\n')}
${p.ctas.map(cta).join('')}${p.forms.map(form).join('')}</main>
<footer>${(p.footer || FOOTER).map(link).join('')}</footer></body></html>`;
}

function harvestOf(site, origin) {
    return Object.entries(site).map(([route, p]) => ({
        probe: 'parity-capture/1',
        url: origin + route,
        path: route,
        links: [...p.links, ...p.ctas, ...(p.footer || FOOTER)].map(([h, t]) => ({ href: new URL(h, origin).href, text: t })),
        ctas: p.ctas.map(([h, t]) => ({ href: new URL(h, origin).href, text: t })).concat(p.forms.map(() => ({ href: '', text: 'Send' }))),
        forms: p.forms.map((f) => ({ action: new URL(f.action, origin).href, method: f.method, fields: f.fields })),
        text: [...p.text, ...p.clientOnly],
    }));
}

function sitemapOf(site) {
    return `<?xml version="1.0"?><urlset>${Object.keys(site).map((r) => `<url><loc>https://example.com${r}</loc></url>`).join('')}</urlset>`;
}

// A server whose site can be swapped between cases, so two ports serve the run.
function serve() {
    const state = { site: {}, robots: 'User-agent: *\nDisallow: /admin\n' };
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(state.robots); return; }
        if (u.pathname === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(sitemapOf(state.site)); return; }
        const p = state.site[u.pathname];
        if (p) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderHtml(u.pathname, p)); return; }
        // Trailing-slash variants redirect to the canonical form, on both sides.
        if (u.pathname.length > 1 && u.pathname.endsWith('/') && state.site[u.pathname.slice(0, -1)]) {
            res.writeHead(308, { location: u.pathname.slice(0, -1) }); res.end(); return;
        }
        res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        state.origin = `http://127.0.0.1:${server.address().port}`;
        resolve({ server, state });
    }));
}

function runScript(script, args, timeoutMs = 60000) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
}

function writeJson(name, v) {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, JSON.stringify(v, null, 2));
    return f;
}

// One report line per finding: "  [class] route kind item: detail".
function findings(out, cls, kind) {
    return out.stdout.split('\n').filter((l) => l.startsWith(`  [${cls}] `) && (!kind || l.includes(` ${kind} `)));
}

async function main() {
    const B = await serve();
    const C = await serve();
    let caseNo = 0;

    // Sets both sides up, runs the script, returns the child's result.
    async function scenario(mutateCand, { harvest = 'both', intent, script = SCRIPT, candidateUrl } = {}) {
        caseNo++;
        const base = baseSite();
        const cand = baseSite();
        if (mutateCand) mutateCand(cand);
        B.state.site = base;
        C.state.site = cand;
        const args = ['--baseline', B.state.origin, '--candidate', candidateUrl || C.state.origin, '--timeout-ms', '5000'];
        if (harvest === 'both' || harvest === 'baseline') args.push('--harvest-baseline', writeJson(`hb-${caseNo}.json`, harvestOf(base, B.state.origin)));
        if (harvest === 'both' || harvest === 'candidate') args.push('--harvest-candidate', writeJson(`hc-${caseNo}.json`, harvestOf(cand, C.state.origin)));
        if (intent) args.push('--intent', writeJson(`intent-${caseNo}.json`, intent));
        const out = await runScript(script, args);
        if (out.code === null) { infra++; indeterminate.push(`case ${caseNo}: child killed (${out.signal})`); }
        return out;
    }

    // --------------------------------------------------------- the identical pair
    {
        const out = await scenario(null);
        check('identical pair: exit 0', out.code === 0, `exit ${out.code}\n${out.stdout}${out.stderr}`);
        check('identical pair: the population is printed with its count and sources',
            /population: 5 of 5 routes measured \(sources: always 1, sitemap 4, routes file 0, links from \/ 5; cap 100\)/.test(out.stdout), out.stdout);
        check('identical pair: every route is named, and the one the baseline 404s is shown skipped', /routes: \/ \/signup \/about \/pricing \/privacy\n/.test(out.stdout)
            && /baseline non-2xx, nothing to keep: 1 of 5 \(\/signup 404\)/.test(out.stdout), out.stdout);
        check('identical pair: the summary line counts every class and says PASS',
            /summary: 5 routes \| lost 0 \(missing 0\), unclear 0, replaced 0, intentional 0, UNVERIFIED 0 -> PASS \(exit 0\)/.test(out.stdout), out.stdout);
    }

    // ------------------------------------------------------ the planted defects
    //
    // Each: how the candidate is broken, the ONE assertion that names the
    // defect, the exit the real script must give, and the anchored edit that
    // disables its detector in a copy of the script.
    const DEFECTS = [
        {
            name: 'removed route (MISSING)',
            mutate: (s) => { delete s['/about']; },
            assertion: 'a route-missing finding for /about, class lost',
            holds: (o) => findings(o, 'lost', 'route-missing').some((l) => l.includes('/about') && l.includes('MISSING')) && /missing 1\)/.test(o.stdout),
            exit: 1,
            off: ["J.add({ route, kind: 'route-missing'", "if (false) J.add({ route, kind: 'route-missing'"],
        },
        {
            name: 'changed canonical',
            mutate: (s) => { s['/about'].canonical = 'https://example.com/'; },
            assertion: 'a seo finding on /about naming canonical, class unclear',
            holds: (o) => findings(o, 'unclear', 'seo').some((l) => l.includes('/about') && l.includes('canonical')),
            exit: 1,
            off: ["const SCALAR_FIELDS = ['title', 'description', 'canonical',", "const SCALAR_FIELDS = ['title', 'description',"],
        },
        {
            name: 'removed JSON-LD type',
            mutate: (s) => { s['/'].jsonld = ['WebSite']; },
            assertion: 'a jsonld finding on / naming Organization, class lost',
            holds: (o) => findings(o, 'lost', 'jsonld').some((l) => l.includes(' / ') && l.includes('Organization')),
            exit: 1,
            off: ['for (const t of b.jsonLdTypes.filter((x) => !c.jsonLdTypes.includes(x))) {', 'for (const t of [].filter((x) => !c.jsonLdTypes.includes(x))) {'],
        },
        {
            name: 'lost footer link',
            mutate: (s) => { Object.values(s).forEach((p) => { p.footer = FOOTER.filter(([h]) => h !== '/privacy'); }); },
            assertion: 'a link finding for /privacy "Privacy policy", class lost',
            holds: (o) => findings(o, 'lost', 'link').some((l) => l.includes('/privacy "Privacy policy"')),
            exit: 1,
            off: ["else { cls = 'lost'; detail = 'absent on the candidate'; }\n        J.add({ route, kind, class: cls, item, detail });", "else { continue; }\n        J.add({ route, kind, class: cls, item, detail });"],
        },
        {
            name: 'CTA text changed, href kept',
            mutate: (s) => { s['/'].ctas = [['/signup', 'Try it free']]; },
            assertion: 'a cta finding for /signup "Start free trial", class replaced, and nothing lost',
            holds: (o) => findings(o, 'replaced', 'cta').some((l) => l.includes('/signup "Start free trial"') && l.includes('Try it free'))
                && findings(o, 'lost').length === 0,
            exit: 0,
            off: ["if (b.href && cHrefs.has(b.href)) { cls = 'replaced';", "if (false) { cls = 'replaced';"],
        },
        {
            name: 'removal declared in the intent file',
            mutate: (s) => {
                delete s['/pricing'];
                Object.values(s).forEach((p) => { p.footer = FOOTER.filter(([h]) => h !== '/pricing'); });
            },
            intent: { removedRoutes: ['/pricing'] },
            assertion: 'a route-missing finding for /pricing, class intentional, and nothing lost',
            holds: (o) => findings(o, 'intentional', 'route-missing').some((l) => l.includes('/pricing'))
                && findings(o, 'lost').length === 0 && findings(o, 'unclear').length === 0,
            exit: 0,
            off: ['routeIntended: (p) => intent.removedRoutes.includes(p),', 'routeIntended: (p) => false,'],
        },
        {
            name: 'text moved client-only',
            mutate: (s) => {
                const t = 'Shipping is free on every order over fifty euros.';
                s['/'].text = s['/'].text.filter((x) => x !== t);
                s['/'].clientOnly = [t];
            },
            assertion: 'a client-only finding on / for the shipping sentence, class unclear',
            holds: (o) => findings(o, 'unclear', 'client-only').some((l) => l.includes('Shipping is free')),
            exit: 1,
            off: ["if (kind === 'text' && candRendered && candRendered.includes(t)) {", "if (false) {"],
        },
    ];

    for (const d of DEFECTS) {
        const real = await scenario(d.mutate, { intent: d.intent });
        const on = d.holds(real);
        check(`${d.name}: ${d.assertion}`, on, real.stdout + real.stderr);
        check(`${d.name}: exit ${d.exit}`, real.code === d.exit, `exit ${real.code}\n${real.stdout}`);

        const src = fs.readFileSync(SCRIPT, 'utf8');
        const hits = src.split(d.off[0]).length - 1;
        check(`${d.name}: the detector-off anchor matches exactly once`, hits === 1, `${hits} matches for ${JSON.stringify(d.off[0])}`);
        let offHolds = null;
        if (hits === 1) {
            const copy = path.join(TMP, `parity-off-${planted.length}.js`);
            fs.writeFileSync(copy, src.replace(d.off[0], d.off[1]));
            const off = await scenario(d.mutate, { intent: d.intent, script: copy });
            offHolds = d.holds(off);
            // The copy must still RUN: a red from a copy that crashed proves nothing.
            check(`${d.name}: the detector-off copy runs and prints a summary`, /^summary: /m.test(off.stdout), off.stdout + off.stderr);
            check(`${d.name}: with the detector off, THAT assertion goes red`, offHolds === false, off.stdout);
        }
        planted.push({ defect: d.name, off: offHolds === null ? 'NOT RUN' : (offHolds ? 'PASS (vacuous)' : 'FAIL'), on: on ? 'PASS' : 'FAIL' });
    }

    // Two defects of the INDETERMINATE kind, with the same off/on discipline.
    {
        // An unreachable candidate: a port that was open and is now closed.
        const dead = await serve();
        const deadUrl = dead.state.origin;
        await new Promise((r) => dead.server.close(r));
        const holds = (o) => o.code === 2 && findings(o, 'UNVERIFIED').some((l) => l.includes('candidate could not be fetched')) && /INDETERMINATE \(exit 2\)/.test(o.stdout);
        const real = await scenario(null, { candidateUrl: deadUrl });
        check('unreachable candidate: exit 2, UNVERIFIED, INDETERMINATE', holds(real), `exit ${real.code}\n${real.stdout}${real.stderr}`);
        check('unreachable candidate: never reads as PASS', !/-> PASS/.test(real.stdout), real.stdout);
        const src = fs.readFileSync(SCRIPT, 'utf8');
        const anchor = "if (!c.ok) { J.add({ route, kind: 'unverified'";
        const hits = src.split(anchor).length - 1;
        check('unreachable candidate: the detector-off anchor matches exactly once', hits === 1, hits);
        const copy = path.join(TMP, 'parity-off-unreachable.js');
        fs.writeFileSync(copy, src.replace(anchor, "if (!c.ok) { return; J.add({ route, kind: 'unverified'"));
        const off = await scenario(null, { candidateUrl: deadUrl, script: copy });
        check('unreachable candidate: with the detector off, THAT assertion goes red', !holds(off), off.stdout);
        planted.push({ defect: 'unreachable candidate (exit 2)', off: holds(off) ? 'PASS (vacuous)' : 'FAIL', on: holds(real) ? 'PASS' : 'FAIL' });
    }
    {
        const holds = (o) => o.code === 2 && findings(o, 'UNVERIFIED', 'unverified').filter((l) => l.includes('no harvest for the baseline and candidate')).length === 4;
        const real = await scenario(null, { harvest: 'none' });
        check('no harvest: every route has its rendered fields UNVERIFIED, exit 2', holds(real), `exit ${real.code}\n${real.stdout}`);
        check('no harvest: the report says which harvest is missing', /rendered harvest: baseline none, candidate none/.test(real.stdout), real.stdout);
        const one = await scenario(null, { harvest: 'baseline' });
        check('only the baseline harvest: still UNVERIFIED and exit 2', one.code === 2 && /no harvest for the candidate/.test(one.stdout), `exit ${one.code}\n${one.stdout}`);
        const src = fs.readFileSync(SCRIPT, 'utf8');
        const anchor = "if (!hb || !hc) {\n        const missing";
        const hits = src.split(anchor).length - 1;
        check('no harvest: the detector-off anchor matches exactly once', hits === 1, hits);
        const copy = path.join(TMP, 'parity-off-harvest.js');
        fs.writeFileSync(copy, src.replace(anchor, "if (!hb || !hc) { return;\n        const missing"));
        const off = await scenario(null, { harvest: 'none', script: copy });
        check('no harvest: with the detector off, THAT assertion goes red', !holds(off), off.stdout);
        planted.push({ defect: 'no harvest (rendered UNVERIFIED, exit 2)', off: holds(off) ? 'PASS (vacuous)' : 'FAIL', on: holds(real) ? 'PASS' : 'FAIL' });
    }

    // ------------------------------------------------------------ smaller cases
    {
        const out = await scenario(null, { harvest: 'both' });
        const j = await runScript(SCRIPT, ['--baseline', B.state.origin, '--candidate', C.state.origin, '--json', '--harvest-baseline', path.join(TMP, `hb-${caseNo}.json`), '--harvest-candidate', path.join(TMP, `hc-${caseNo}.json`)]);
        let rep = null;
        try { rep = JSON.parse(j.stdout); } catch { /* asserted below */ }
        check('--json: parses, verdict PASS, population of 5', out.code === 0 && rep && rep.verdict.word === 'PASS' && rep.population.measured === 5 && rep.counts.lost === 0, j.stdout.slice(0, 300));
    }
    {
        const baseState = baseSite();
        B.state.site = baseState;
        C.state.site = baseSite();
        const orig = C.server.listeners('request')[0];
        C.server.removeAllListeners('request');
        C.server.on('request', (req, res) => {
            if (req.url === '/about') { res.writeHead(301, { location: '/' }); res.end(); return; }
            orig(req, res);
        });
        const out = await runScript(SCRIPT, ['--baseline', B.state.origin, '--candidate', C.state.origin,
            '--harvest-baseline', writeJson('rb.json', harvestOf(baseState, B.state.origin)), '--harvest-candidate', writeJson('rc.json', harvestOf(baseState, C.state.origin))]);
        C.server.removeAllListeners('request');
        C.server.on('request', orig);
        check('a new redirect on the candidate is REDIRECTED, class unclear, exit 1',
            out.code === 1 && findings(out, 'unclear', 'route-redirected').some((l) => l.includes('/about') && l.includes('301')), out.stdout);
    }
    {
        const routesFile = path.join(TMP, 'routes.txt');
        fs.writeFileSync(routesFile, '# extra\n/about\n/ghost\n');
        B.state.site = baseSite(); C.state.site = baseSite();
        const out = await runScript(SCRIPT, ['--baseline', B.state.origin, '--candidate', C.state.origin, '--routes', routesFile, '--max-routes', '3']);
        check('--routes adds to the population, is measured before the sitemap, and --max-routes caps the rest as UNVERIFIED',
            /population: 3 of 6 routes measured \(sources: always 1, sitemap 4, routes file 2/.test(out.stdout)
            && /routes: \/ \/about \/ghost\n/.test(out.stdout)
            && findings(out, 'UNVERIFIED').some((l) => l.includes('3 of 6 routes over --max-routes 3')) && out.code === 2, out.stdout);
    }
    {
        const bad = writeJson('bad-intent.json', { removedRoute: ['/x'] });
        const out = await runScript(SCRIPT, ['--baseline', B.state.origin, '--candidate', C.state.origin, '--intent', bad]);
        check('an intent file with an unknown key is refused as INDETERMINATE, exit 2', out.code === 2 && /unknown key\(s\) removedRoute/.test(out.stderr), out.stderr);
        const none = await runScript(SCRIPT, ['--baseline', B.state.origin]);
        check('a missing --candidate is a usage error, exit 2', none.code === 2 && /both required/.test(none.stderr), none.stderr);
    }
    {
        const out = await runScript(SCRIPT, ['--help']);
        check('--help answers, exit 0, and names the exit codes', out.code === 0 && /exit 2 {2}anything UNVERIFIED/.test(out.stdout), out.stdout);
        const p = await runScript(SCRIPT, ['--print-probe']);
        check('--print-probe prints one evaluable expression', p.code === 0 && /^\(function harvest\(\)/.test(p.stdout) && p.stdout.trim().endsWith(')()'), p.stdout.slice(0, 120));
    }

    // -------------------------------------------------- the probe, in a fake DOM
    //
    // The probe runs in a browser, which this suite does not have. A minimal fake
    // document drives every branch of it, so a probe edit that breaks the harvest
    // shape goes red here rather than on someone's page.
    {
        const { harvest } = require(SCRIPT);
        const el = (tag, a, text, kids) => ({
            tagName: tag.toUpperCase(), textContent: text || '', value: a.value,
            href: a.href ? new URL(a.href, 'https://example.com/x').href : undefined,
            action: a.action !== undefined ? new URL(a.action, 'https://example.com/x').href : 'https://example.com/x',
            getAttribute: (k) => (a[k] === undefined ? null : a[k]),
            querySelectorAll: () => kids || [],
        });
        const nodes = {
            'a[href]': [el('a', { href: '/about' }, ' About \n us '), el('a', { href: '/icon', 'aria-label': 'Menu' }, '')],
            button: [el('button', {}, 'Send'), el('input', { type: 'submit', value: 'Go' }, '')],
            form: [el('form', { action: '/subscribe', method: 'POST' }, '', [el('input', { name: 'email' }), el('input', { name: 'a' })]), el('form', {}, '', [])],
            text: [el('p', {}, 'A paragraph that is long enough.'), el('p', {}, 'A paragraph that is long enough.'), el('li', {}, 'short')],
        };
        globalThis.document = {
            querySelectorAll: (sel) => (sel === 'a[href]' ? nodes['a[href]'] : sel.startsWith('button') ? nodes.button : sel === 'form' ? nodes.form : nodes.text),
        };
        globalThis.location = { href: 'https://example.com/x', pathname: '/x' };
        const h = harvest();
        delete globalThis.document; delete globalThis.location;
        check('probe: links carry absolute href and collapsed text, aria-label as fallback',
            JSON.stringify(h.links) === JSON.stringify([{ href: 'https://example.com/about', text: 'About us' }, { href: 'https://example.com/icon', text: 'Menu' }]), JSON.stringify(h.links));
        check('probe: CTAs include buttons and submit inputs by value', JSON.stringify(h.ctas) === JSON.stringify([{ href: '', text: 'Send' }, { href: '', text: 'Go' }]), JSON.stringify(h.ctas));
        check('probe: forms carry action, lower-case method, sorted field names; no action stays empty',
            JSON.stringify(h.forms) === JSON.stringify([{ action: 'https://example.com/subscribe', method: 'post', fields: ['a', 'email'] }, { action: '', method: 'get', fields: [] }]), JSON.stringify(h.forms));
        check('probe: text blocks are deduplicated and short ones dropped', JSON.stringify(h.text) === JSON.stringify(['A paragraph that is long enough.']), JSON.stringify(h.text));
        check('probe: it reports where it ran', h.path === '/x' && h.probe === 'parity-capture/1', JSON.stringify(h));
    }

    B.server.close(); C.server.close();
    fs.rmSync(TMP, { recursive: true, force: true });

    console.log('\nplanted defects (detector off | detector on):');
    for (const p of planted) console.log(`  ${p.defect} | ${p.off} | ${p.on}`);
    console.log(`\n${tally(pass, fail, infra)}`);
    if (infra) console.log(`indeterminate: ${indeterminate.join(' | ')}`);
    process.exitCode = exitCode(fail, infra);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
