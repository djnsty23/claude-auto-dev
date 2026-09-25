#!/usr/bin/env node
'use strict';
/**
 * parity-capture.js - did a redesign CANDIDATE keep what the BASELINE has?
 *
 * A redesign PR is usually graded only against itself: it builds, it types, its
 * layout holds at several widths. Nothing compares it with what is live, so a
 * lost footer link, a dropped canonical or copy that moved client-only ships
 * unnoticed. This compares a baseline site (production) with a candidate site
 * (a preview deploy or a local dev server), route by route, and reports what the
 * candidate lost or changed.
 *
 * ------------------------------------------------------------------ HOW IT RUNS
 *
 * Two halves, the same split as rendered-layout-gate.js:
 *
 *   server capture   here, in Node, with fetch and no JavaScript. Status, the
 *                    redirect chain followed by hand, the trailing-slash variant,
 *                    and from the raw HTML the SEO fields, links, forms and text.
 *   rendered harvest `harvest()` below runs IN a browser and judges nothing. The
 *                    caller evaluates `--print-probe` on each route of each side
 *                    and saves the results as one JSON file per side.
 *
 * The plugin ships the measurement and the caller supplies the browser, so any
 * browser surface works and none of them is a dependency of the plugin.
 *
 * ------------------------------------------------------------ CLASSIFICATION
 *
 * Every loss is exactly one of:
 *
 *   replaced     the same href with new text, the same text at a new href, or a
 *                text block reworded (at least half its words kept)
 *   intentional  matched by the --intent file the author wrote
 *   lost         gone, with nothing standing in for it
 *   unclear      changed in a way this tool cannot call a loss or a keep: a
 *                changed canonical, a new redirect, text that moved client-only
 *
 * and anything that could not be measured is UNVERIFIED, never "unchanged".
 * With no rendered harvest, every rendered field is UNVERIFIED.
 *
 * ---------------------------------------------------------------- EXIT CODES
 *
 *   0  no lost, no unclear, nothing UNVERIFIED
 *   1  any lost or unclear (a MISSING route is lost): this blocks
 *   2  anything UNVERIFIED, or unusable input: INDETERMINATE, never a pass
 *
 * When a run has both a blocking finding and an UNVERIFIED one it exits 1. The
 * loss is a measured fact about the candidate and must not be softened into
 * "could not tell". The summary line still prints the UNVERIFIED count beside it.
 *
 * This file requires only Node built-ins, so a copy of it runs anywhere.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Block elements whose text is compared. Headings are left out on purpose: the
// outline is compared as its own field, so a heading is never reported twice.
const TEXT_TAGS = ['p', 'li', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption'];
const MIN_TEXT = 12;
const ASSET_EXT = /\.(?:css|js|mjs|json|xml|txt|png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|woff2?|ttf|mp4|webm|mp3)$/i;
const SCALAR_FIELDS = ['title', 'description', 'canonical', 'robots', 'xRobotsTag', 'hreflang', 'h1'];
// Fields where an ADDED value can hurt: a new noindex deindexes a page that was
// indexed. For every other field an addition is not a loss.
const ADD_MATTERS = new Set(['robots', 'xRobotsTag']);

// ---------------------------------------------------------------- the probe
//
// Evaluated in a browser. It must stay self-contained: `--print-probe` ships its
// source text, so it can reach nothing outside its own body.
function harvest() {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const all = (root, sel) => Array.prototype.slice.call(root.querySelectorAll(sel));
    const label = (el) => norm(el.textContent) || norm(el.getAttribute('aria-label')) || norm(el.value);
    const links = all(document, 'a[href]').map((a) => ({ href: a.href, text: label(a) }));
    const ctas = all(document, 'button, [role="button"], input[type="submit"], a[href][class*="btn"], '
        + 'a[href][class*="button"], a[href][class*="cta"]')
        .map((el) => ({ href: el.tagName === 'A' ? el.href : '', text: label(el) }));
    const forms = all(document, 'form').map((f) => ({
        action: f.getAttribute('action') === null ? '' : f.action,
        method: String(f.getAttribute('method') || 'get').toLowerCase(),
        fields: all(f, 'input[name], select[name], textarea[name]').map((i) => i.getAttribute('name')).sort(),
    }));
    const seen = {};
    const text = all(document, 'p, li, blockquote, td, th, dd, dt, figcaption')
        .map((el) => norm(el.textContent))
        .filter((t) => t.length >= 12 && !seen[t] && (seen[t] = true));
    return { probe: 'parity-capture/1', url: location.href, path: location.pathname, links, ctas, forms, text };
}

function probeSource() {
    return '(' + harvest.toString() + ')()';
}

function probeSha() {
    return crypto.createHash('sha256').update(harvest.toString()).digest('hex').slice(0, 12);
}

// ------------------------------------------------------------- HTML reading
//
// Regular expressions, not a parser: the plugin carries no dependencies. They
// read what a crawler reads, which is the raw server HTML.

function decode(s) {
    return String(s)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripTags(s) {
    return norm(decode(String(s).replace(/<[^>]*>/g, ' ')));
}

function attrs(tag) {
    const out = {};
    const re = /([^\s=/<>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
    const body = tag.replace(/^<\/?[a-z0-9-]+/i, '').replace(/\/?>$/, '');
    let m;
    while ((m = re.exec(body))) {
        const v = m[2] === undefined ? '' : m[2].replace(/^["']|["']$/g, '');
        out[m[1].toLowerCase()] = decode(v);
    }
    return out;
}

function jsonLdTypes(node, out) {
    if (Array.isArray(node)) { node.forEach((n) => jsonLdTypes(n, out)); return out; }
    if (!node || typeof node !== 'object') return out;
    const t = node['@type'];
    (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => out.add(String(x)));
    Object.keys(node).forEach((k) => { if (k !== '@type') jsonLdTypes(node[k], out); });
    return out;
}

// hosts: every host that means "this site", so a link to either side's origin
// compares as a path and a preview is not charged for linking to production.
function normHref(href, pageUrl, hosts) {
    const raw = String(href || '').trim();
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return null;
    let u;
    try { u = new URL(raw, pageUrl); } catch { return raw; }
    if (!/^https?:$/.test(u.protocol)) return u.href;
    if (hosts.has(u.host)) return (u.pathname || '/') + u.search;
    u.hash = '';
    return u.href;
}

function parseHtml(html, pageUrl, hosts) {
    const src = String(html || '');
    const types = new Set();
    let ldError = 0;
    for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (!/application\/ld\+json/i.test(attrs('<s ' + m[1] + '>').type || '')) continue;
        try { jsonLdTypes(JSON.parse(m[2]), types); } catch { ldError++; }
    }
    const body = src.replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ');

    const seo = { title: '', description: '', canonical: '', robots: '', xRobotsTag: '', hreflang: '', h1: '', og: {}, twitter: {} };
    const title = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (title) seo.title = stripTags(title[1]);
    for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        const key = (a.name || a.property || '').toLowerCase();
        const content = norm(a.content);
        if (key === 'description') seo.description = content;
        else if (key === 'robots') seo.robots = content.toLowerCase();
        else if (key.startsWith('og:')) seo.og[key] = content;
        else if (key.startsWith('twitter:')) seo.twitter[key] = content;
    }
    const hreflang = [];
    for (const m of body.matchAll(/<link\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        const rel = (a.rel || '').toLowerCase().split(/\s+/);
        if (rel.includes('canonical')) seo.canonical = normHref(a.href, pageUrl, hosts) || '';
        if (rel.includes('alternate') && a.hreflang) hreflang.push(`${a.hreflang.toLowerCase()}=${normHref(a.href, pageUrl, hosts)}`);
    }
    seo.hreflang = hreflang.sort().join(' ');
    const outline = [];
    const h1 = [];
    for (const m of body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
        const t = stripTags(m[2]);
        if (m[1] === '1') h1.push(t); else if (t) outline.push(`h${m[1]} ${t}`);
    }
    seo.h1 = h1.join(' | ');

    const links = [];
    for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const a = attrs('<a ' + m[1] + '>');
        const href = normHref(a.href, pageUrl, hosts);
        if (href) links.push({ href, text: stripTags(m[2]) || norm(a['aria-label']) });
    }
    const forms = [];
    for (const m of body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
        const a = attrs('<form ' + m[1] + '>');
        const fields = [];
        for (const f of m[2].matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
            const fa = attrs(f[0]);
            if (fa.name) fields.push(fa.name);
        }
        forms.push({ action: a.action === undefined ? '' : (normHref(a.action, pageUrl, hosts) || ''), method: (a.method || 'get').toLowerCase(), fields: fields.sort() });
    }
    const text = [];
    const tagRe = new RegExp(`<(${TEXT_TAGS.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    for (const m of body.matchAll(tagRe)) {
        const t = stripTags(m[2]);
        if (t.length >= MIN_TEXT && !text.includes(t)) text.push(t);
    }
    seo.jsonLdTypes = [...types].sort();
    return { seo, outline, links, forms, text, ldError };
}

// ----------------------------------------------------------------- fetching

async function get(url, timeoutMs) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'parity-capture/1' } });
    const body = await res.text();
    return { status: res.status, location: res.headers.get('location'), xRobotsTag: norm(res.headers.get('x-robots-tag')).toLowerCase(), body };
}

// The chain is followed by hand so every hop is on the record: a redirect the
// baseline did not have is itself a finding.
async function chain(url, timeoutMs) {
    const hops = [];
    let cur = url;
    for (let i = 0; i <= 10; i++) {
        const r = await get(cur, timeoutMs);
        if (r.status >= 300 && r.status < 400 && r.location) {
            const next = new URL(r.location, cur).href;
            hops.push({ url: cur, status: r.status, location: next });
            cur = next;
            continue;
        }
        return { hops, final: r, finalUrl: cur };
    }
    throw new Error('more than 10 redirects');
}

function slashVariant(p) {
    if (p === '/' || p.includes('?')) return null;
    return p.endsWith('/') ? p.slice(0, -1) : p + '/';
}

async function captureRoute(origin, route, hosts, timeoutMs) {
    try {
        const c = await chain(new URL(route, origin).href, timeoutMs);
        const out = {
            ok: true, status: c.final.status, hops: c.hops,
            finalPath: normHref(c.finalUrl, origin, hosts), slashStatus: null,
        };
        const v = slashVariant(route);
        if (v) {
            try { out.slashStatus = (await get(new URL(v, origin).href, timeoutMs)).status; } catch (e) { out.slashStatus = `error: ${e.message}`; }
        }
        if (out.status >= 200 && out.status < 300) {
            Object.assign(out, parseHtml(c.final.body, c.finalUrl, hosts));
            out.seo.xRobotsTag = c.final.xRobotsTag;
        }
        return out;
    } catch (e) {
        return { ok: false, error: e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message };
    }
}

async function captureFile(origin, file, timeoutMs) {
    try {
        const r = await get(new URL(file, origin).href, timeoutMs);
        return { ok: true, status: r.status, body: r.status >= 200 && r.status < 300 ? r.body : '' };
    } catch (e) {
        return { ok: false, error: e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message };
    }
}

function sitemapLocs(xml) {
    return [...String(xml || '').matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decode(m[1]));
}

// A sitemap index is followed one level. Its child locations usually name the
// production host, so each is re-rooted on the side being read.
async function readSitemap(origin, timeoutMs) {
    const top = await captureFile(origin, '/sitemap.xml', timeoutMs);
    if (!top.ok || !top.body) return { ...top, paths: [] };
    const paths = [];
    const toPath = (loc) => { try { const u = new URL(loc, origin); return u.pathname + u.search; } catch { return null; } };
    if (/<sitemapindex\b/i.test(top.body)) {
        for (const loc of sitemapLocs(top.body).slice(0, 20)) {
            const child = await captureFile(origin, toPath(loc) || loc, timeoutMs);
            if (!child.ok) return { ok: false, error: `child sitemap ${loc}: ${child.error}`, paths: [] };
            sitemapLocs(child.body).forEach((l) => paths.push(toPath(l)));
        }
    } else {
        sitemapLocs(top.body).forEach((l) => paths.push(toPath(l)));
    }
    return { ...top, paths: [...new Set(paths.filter(Boolean))] };
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
}

// ------------------------------------------------------------------- inputs

function readJson(file, what) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${what} ${file}: ${e.message}`); }
}

function loadIntent(file) {
    const empty = { removedRoutes: [], removedHrefs: [], textPatterns: [], changedFields: [] };
    if (!file) return empty;
    const j = readJson(file, 'intent file');
    const out = { ...empty };
    for (const k of Object.keys(empty)) {
        if (j[k] === undefined) continue;
        if (!Array.isArray(j[k]) || j[k].some((x) => typeof x !== 'string')) throw new Error(`intent file ${file}: "${k}" must be an array of strings`);
        out[k] = j[k];
    }
    const unknown = Object.keys(j).filter((k) => !(k in empty));
    if (unknown.length) throw new Error(`intent file ${file}: unknown key(s) ${unknown.join(', ')}; allowed: ${Object.keys(empty).join(', ')}`);
    out.textPatterns = out.textPatterns.map((p) => new RegExp(p, 'i'));
    return out;
}

// A harvest file is an array of probe results, an object keyed by route, or one
// probe result. Every href is re-normalized here, so the probe can stay dumb.
function loadHarvest(file, origin, hosts) {
    if (!file) return null;
    const j = readJson(file, 'harvest file');
    const entries = Array.isArray(j) ? j : (j && j.probe ? [j] : Object.entries(j || {}).map(([p, e]) => ({ path: p, ...e })));
    const map = new Map();
    for (const e of entries) {
        if (!e || typeof e !== 'object') throw new Error(`harvest file ${file}: an entry is not an object`);
        if (e.url) { try { hosts.add(new URL(e.url).host); } catch { /* a relative url adds no host */ } }
    }
    for (const e of entries) {
        const page = e.url || new URL(e.path || '/', origin).href;
        const route = e.path || new URL(page).pathname;
        const pairs = (xs) => (Array.isArray(xs) ? xs : []).map((x) => ({ href: x.href ? (normHref(x.href, page, hosts) || '') : '', text: norm(x.text) }));
        map.set(route, {
            links: pairs(e.links).filter((l) => l.href),
            ctas: pairs(e.ctas),
            forms: (Array.isArray(e.forms) ? e.forms : []).map((f) => ({ action: f.action ? (normHref(f.action, page, hosts) || '') : '', method: String(f.method || 'get').toLowerCase(), fields: [...(f.fields || [])].sort() })),
            text: (Array.isArray(e.text) ? e.text : []).map(norm).filter((t) => t.length >= MIN_TEXT),
        });
    }
    return map;
}

function readRoutesFile(file) {
    if (!file) return [];
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`routes file ${file}: ${e.message}`); }
    return src.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
        .map((l) => (l.startsWith('/') ? l : new URL(l).pathname));
}

// ---------------------------------------------------------------- judging

function words(s) {
    return new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function overlap(a, b) {
    const A = words(a); const B = words(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    A.forEach((w) => { if (B.has(w)) n++; });
    return n / Math.max(A.size, B.size);
}

function makeJudge(intent) {
    const findings = [];
    const seen = new Set();
    const hrefPath = (h) => String(h).replace(/[?#].*$/, '');
    const J = {
        findings,
        add(f) {
            const key = [f.route, f.kind.replace(/^rendered-/, ''), f.item || f.field || ''].join('|');
            if (seen.has(key)) return;
            seen.add(key);
            findings.push(f);
        },
        routeIntended: (p) => intent.removedRoutes.includes(p),
        hrefIntended: (h) => intent.removedHrefs.includes(h) || intent.removedRoutes.includes(hrefPath(h)),
        textIntended: (t) => intent.textPatterns.some((re) => re.test(t)),
        fieldIntended: (f) => intent.changedFields.includes(f),
    };
    return J;
}

function uniqPairs(xs) {
    const m = new Map();
    xs.forEach((x) => m.set(x.href + '\u0000' + x.text, x));
    return [...m.values()];
}

function diffPairs(J, route, kind, base, cand) {
    const key = (x) => x.href + '\u0000' + x.text;
    const cKeys = new Set(cand.map(key));
    const cHrefs = new Map(); const cTexts = new Map();
    cand.forEach((x) => { if (x.href) cHrefs.set(x.href, x.text); if (x.text) cTexts.set(x.text, x.href); });
    for (const b of uniqPairs(base)) {
        if (cKeys.has(key(b))) continue;
        const item = `${b.href || '(no href)'} "${b.text}"`;
        let cls; let detail;
        if (b.href && cHrefs.has(b.href)) { cls = 'replaced'; detail = `same href, text now "${cHrefs.get(b.href)}"`; }
        else if (b.text && cTexts.has(b.text)) { cls = 'replaced'; detail = `same text, href now ${cTexts.get(b.text) || '(none)'}`; }
        else if ((b.href && J.hrefIntended(b.href)) || (b.text && J.textIntended(b.text))) { cls = 'intentional'; detail = 'declared in the intent file'; }
        else { cls = 'lost'; detail = 'absent on the candidate'; }
        J.add({ route, kind, class: cls, item, detail });
    }
}

function diffForms(J, route, kind, base, cand) {
    const sig = (f) => f.fields.join(',');
    for (const b of base) {
        const item = `${b.method.toUpperCase()} ${b.action || '(self)'} [${sig(b)}]`;
        const same = cand.find((c) => c.action === b.action && c.method === b.method);
        if (!same) {
            const moved = cand.find((c) => sig(c) === sig(b));
            if (moved) J.add({ route, kind, class: 'replaced', item, detail: `same fields, now ${moved.method.toUpperCase()} ${moved.action || '(self)'}` });
            else if (b.action && J.hrefIntended(b.action)) J.add({ route, kind, class: 'intentional', item, detail: 'declared in the intent file' });
            else J.add({ route, kind, class: 'lost', item, detail: 'no form with this action or these fields on the candidate' });
            continue;
        }
        for (const field of b.fields.filter((x) => !same.fields.includes(x))) {
            J.add({ route, kind: kind + '-field', class: J.textIntended(field) ? 'intentional' : 'lost', item: `${item} field ${field}`, detail: 'field absent on the candidate' });
        }
    }
}

// Server text on the baseline that the candidate does not serve. The rendered
// harvest decides between "gone" and "now only arrives through JavaScript".
function diffText(J, route, kind, base, candServer, candRendered) {
    for (const t of base) {
        if (candServer.includes(t)) continue;
        const item = t.length > 80 ? t.slice(0, 77) + '...' : t;
        if (kind === 'text' && candRendered && candRendered.includes(t)) {
            J.add({ route, kind: 'client-only', class: 'unclear', item, detail: 'server HTML on the baseline, only in the rendered DOM on the candidate' });
            continue;
        }
        const pool = candServer.concat(candRendered || []);
        const best = pool.reduce((m, c) => Math.max(m, overlap(t, c)), 0);
        if (best >= 0.5) J.add({ route, kind, class: 'replaced', item, detail: `reworded (${Math.round(best * 100)}% of words kept)` });
        else if (J.textIntended(t)) J.add({ route, kind, class: 'intentional', item, detail: 'declared in the intent file' });
        else if (kind === 'text' && !candRendered) J.add({ route, kind, class: 'unclear', item, detail: 'absent from the candidate server HTML, and with no rendered harvest it cannot be told lost from client-only' });
        else J.add({ route, kind, class: 'lost', item, detail: 'absent on the candidate' });
    }
}

function diffSeo(J, route, b, c) {
    for (const f of SCALAR_FIELDS) {
        const bv = b[f] || ''; const cv = c[f] || '';
        if (bv === cv) continue;
        let cls; let detail;
        if (J.fieldIntended(f) || (bv && J.textIntended(bv))) { cls = 'intentional'; detail = 'declared in the intent file'; }
        else if (bv && !cv) { cls = 'lost'; detail = 'vanished'; }
        else if (!bv) { if (!ADD_MATTERS.has(f)) continue; cls = 'unclear'; detail = 'added'; }
        else { cls = 'unclear'; detail = 'changed'; }
        J.add({ route, kind: 'seo', field: f, class: cls, item: f, detail: `${detail}: "${bv}" -> "${cv}"` });
    }
    for (const t of b.jsonLdTypes.filter((x) => !c.jsonLdTypes.includes(x))) {
        J.add({ route, kind: 'jsonld', field: 'jsonLdTypes', class: J.fieldIntended('jsonLdTypes') ? 'intentional' : 'lost', item: t, detail: 'JSON-LD @type absent on the candidate' });
    }
    for (const group of ['og', 'twitter']) {
        for (const [k, bv] of Object.entries(b[group])) {
            const cv = c[group][k];
            if (cv === bv) continue;
            const cls = J.fieldIntended(k) ? 'intentional' : (cv === undefined || cv === '' ? 'lost' : 'unclear');
            J.add({ route, kind: 'seo', field: k, class: cls, item: k, detail: `"${bv}" -> ${cv === undefined ? '(absent)' : `"${cv}"`}` });
        }
    }
}

function judgeRoute(J, route, b, c, hb, hc) {
    if (!b.ok) { J.add({ route, kind: 'unverified', class: 'unverified', item: 'baseline', detail: `baseline could not be fetched: ${b.error}` }); return; }
    if (!c.ok) { J.add({ route, kind: 'unverified', class: 'unverified', item: 'candidate', detail: `candidate could not be fetched: ${c.error}` }); return; }
    if (b.status < 200 || b.status >= 300) return; // the baseline has nothing here to keep
    if (c.status >= 400 || c.status < 200) {
        J.add({ route, kind: 'route-missing', class: J.routeIntended(route) ? 'intentional' : 'lost', item: route, detail: `MISSING: baseline ${b.status}, candidate ${c.status}` });
        return;
    }
    if (c.status >= 300) {
        J.add({ route, kind: 'unverified', class: 'unverified', item: 'candidate', detail: `candidate answered ${c.status} with no Location to follow` });
        return;
    }
    const redirected = (b.hops.length === 0 && c.hops.length > 0) || (b.hops.length > 0 && b.finalPath !== c.finalPath);
    if (redirected) {
        J.add({ route, kind: 'route-redirected', class: J.routeIntended(route) ? 'intentional' : 'unclear', item: route, detail: `REDIRECTED: candidate ends at ${c.finalPath} via ${c.hops.map((h) => h.status).join(' -> ')}` });
        return;
    }
    if (b.slashStatus !== c.slashStatus) {
        J.add({ route, kind: 'trailing-slash', class: J.fieldIntended('trailingSlash') ? 'intentional' : 'unclear', item: slashVariant(route), detail: `trailing-slash variant: baseline ${b.slashStatus}, candidate ${c.slashStatus}` });
    }
    diffSeo(J, route, b.seo, c.seo);
    diffText(J, route, 'heading', b.outline, c.outline, null);
    diffPairs(J, route, 'link', b.links, c.links);
    diffForms(J, route, 'form', b.forms, c.forms);
    const rc = hc ? hc.get(route) : null;
    diffText(J, route, 'text', b.text, c.text, rc ? rc.text : null);

    if (!hb || !hc) {
        const missing = [!hb && 'baseline', !hc && 'candidate'].filter(Boolean).join(' and ');
        J.add({ route, kind: 'unverified', class: 'unverified', item: 'rendered', detail: `rendered links, CTAs, forms and text: no harvest for the ${missing}` });
        return;
    }
    const rb = hb.get(route);
    if (!rb || !rc) {
        J.add({ route, kind: 'unverified', class: 'unverified', item: 'rendered', detail: `rendered fields: the ${!rb ? 'baseline' : 'candidate'} harvest has no entry for ${route}` });
        return;
    }
    diffPairs(J, route, 'rendered-link', rb.links, rc.links);
    diffPairs(J, route, 'cta', rb.ctas, rc.ctas);
    diffForms(J, route, 'rendered-form', rb.forms, rc.forms);
    diffText(J, route, 'rendered-text', rb.text, rc.text, null);
}

function disallows(body) {
    return [...String(body).matchAll(/^\s*disallow\s*:\s*(\S+)/gim)].map((m) => m[1]);
}

function judgeSite(J, side) {
    const route = '(site)';
    const { robots, sitemap } = side;
    if (!robots.b.ok || !robots.c.ok) {
        J.add({ route, kind: 'unverified', class: 'unverified', item: 'robots.txt', detail: `robots.txt could not be fetched: ${robots.b.error || robots.c.error}` });
    } else if (robots.b.status === 200 && robots.c.status !== 200) {
        J.add({ route, kind: 'robots', class: J.fieldIntended('robots.txt') ? 'intentional' : 'lost', item: '/robots.txt', detail: `baseline 200, candidate ${robots.c.status}` });
    } else if (robots.b.status === 200) {
        for (const d of disallows(robots.c.body).filter((x) => !disallows(robots.b.body).includes(x))) {
            J.add({ route, kind: 'robots', class: J.fieldIntended('robots.txt') ? 'intentional' : 'unclear', item: `Disallow: ${d}`, detail: 'new on the candidate' });
        }
    }
    if (!sitemap.b.ok || !sitemap.c.ok) {
        J.add({ route, kind: 'unverified', class: 'unverified', item: 'sitemap.xml', detail: `sitemap could not be read: ${sitemap.b.error || sitemap.c.error}` });
    } else if (sitemap.b.status === 200 && sitemap.c.status !== 200) {
        J.add({ route, kind: 'sitemap', class: J.fieldIntended('sitemap') ? 'intentional' : 'lost', item: '/sitemap.xml', detail: `baseline 200, candidate ${sitemap.c.status}` });
    } else if (sitemap.b.status === 200) {
        for (const p of sitemap.b.paths.filter((x) => !sitemap.c.paths.includes(x))) {
            J.add({ route, kind: 'sitemap', class: J.routeIntended(p) ? 'intentional' : 'lost', item: p, detail: 'listed in the baseline sitemap, not in the candidate one' });
        }
    }
}

// ------------------------------------------------------------------- the run

const CLASSES = ['lost', 'unclear', 'replaced', 'intentional', 'unverified'];

function verdictOf(counts) {
    if (counts.lost + counts.unclear > 0) return { word: 'FAIL', exit: 1 };
    if (counts.unverified > 0) return { word: 'INDETERMINATE', exit: 2 };
    return { word: 'PASS', exit: 0 };
}

async function run(opts) {
    const baseline = new URL(opts.baseline).origin;
    const candidate = new URL(opts.candidate).origin;
    const hosts = new Set([new URL(baseline).host, new URL(candidate).host]);
    const intent = loadIntent(opts.intent);
    const hb = loadHarvest(opts.harvestBaseline, baseline, hosts);
    const hc = loadHarvest(opts.harvestCandidate, candidate, hosts);
    const t = opts.timeoutMs;

    const [smB, smC, rbB, rbC, homeB] = await Promise.all([
        readSitemap(baseline, t), readSitemap(candidate, t),
        captureFile(baseline, '/robots.txt', t), captureFile(candidate, '/robots.txt', t),
        captureRoute(baseline, '/', hosts, t),
    ]);

    // The population: what the baseline says exists, from three independent
    // places, printed with its sources so an empty run cannot pass as a clean one.
    const sources = { always: ['/'], sitemap: smB.paths || [], routesFile: readRoutesFile(opts.routes), links: [] };
    if (homeB.ok && homeB.links) {
        sources.links = [...new Set(homeB.links.map((l) => l.href)
            .filter((h) => h.startsWith('/') && !ASSET_EXT.test(h.replace(/\?.*$/, ''))))];
    }
    // Ordered so the cap drops the least-named first: routes the caller listed and
    // pages the home page links to come before the long tail of the sitemap.
    const all = [...new Set([].concat(sources.always, sources.routesFile, sources.links, sources.sitemap))];
    const routes = all.slice(0, opts.maxRoutes);
    const overCap = all.slice(opts.maxRoutes);

    const caps = await pool(routes, 4, async (r) => {
        const [b, c] = await Promise.all([r === '/' ? homeB : captureRoute(baseline, r, hosts, t), captureRoute(candidate, r, hosts, t)]);
        return { r, b, c };
    });

    const J = makeJudge(intent);
    judgeSite(J, { robots: { b: rbB, c: rbC }, sitemap: { b: smB, c: smC } });
    for (const { r, b, c } of caps) judgeRoute(J, r, b, c, hb, hc);
    if (overCap.length) {
        J.add({ route: '(site)', kind: 'unverified', class: 'unverified', item: 'cap', detail: `${overCap.length} of ${all.length} routes over --max-routes ${opts.maxRoutes} were not measured` });
    }

    const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
    J.findings.forEach((f) => { counts[f.class]++; });
    counts.missing = J.findings.filter((f) => f.kind === 'route-missing' && f.class === 'lost').length;
    return {
        baseline, candidate,
        population: {
            total: all.length, measured: routes.length, overCap: overCap.length, cap: opts.maxRoutes,
            sources: { always: 1, sitemap: sources.sitemap.length, routesFile: sources.routesFile.length, linksFromHome: sources.links.length },
            routes,
            baselineNotOk: caps.filter((x) => x.b.ok && (x.b.status < 200 || x.b.status >= 300)).map((x) => `${x.r} ${x.b.status}`),
        },
        harvest: { baseline: opts.harvestBaseline || null, candidate: opts.harvestCandidate || null, probeSha: probeSha() },
        findings: J.findings,
        counts,
        verdict: verdictOf(counts),
    };
}

function render(rep) {
    const p = rep.population;
    const lines = [
        `parity-capture: baseline ${rep.baseline} vs candidate ${rep.candidate}`,
        `population: ${p.measured} of ${p.total} routes measured (sources: always 1, sitemap ${p.sources.sitemap}, routes file ${p.sources.routesFile}, links from / ${p.sources.linksFromHome}; cap ${p.cap})`,
        `routes: ${p.routes.join(' ')}`,
        `baseline non-2xx, nothing to keep: ${p.baselineNotOk.length} of ${p.measured}${p.baselineNotOk.length ? ` (${p.baselineNotOk.join(', ')})` : ''}`,
        `rendered harvest: baseline ${rep.harvest.baseline || 'none'}, candidate ${rep.harvest.candidate || 'none'} (probe ${rep.harvest.probeSha})`,
    ];
    const order = { lost: 0, unclear: 1, unverified: 2, replaced: 3, intentional: 4 };
    const sorted = rep.findings.slice().sort((a, b) => order[a.class] - order[b.class]);
    for (const f of sorted) {
        const label = f.class === 'unverified' ? 'UNVERIFIED' : f.class;
        lines.push(`  [${label}] ${f.route} ${f.kind} ${f.item}: ${f.detail}`);
    }
    const c = rep.counts;
    lines.push(`summary: ${p.measured} routes | lost ${c.lost} (missing ${c.missing}), unclear ${c.unclear}, replaced ${c.replaced}, `
        + `intentional ${c.intentional}, UNVERIFIED ${c.unverified} -> ${rep.verdict.word} (exit ${rep.verdict.exit})`);
    return lines.join('\n');
}

function usage() {
    return `parity-capture.js - what a candidate site lost or changed against a baseline, route by route.

  node parity-capture.js --baseline <url> --candidate <url> [options]
  node parity-capture.js --print-probe     the browser expression that makes a harvest
  node parity-capture.js --help

  --routes <file>              extra routes, one path per line (# comments)
  --max-routes <n>             cap on the population (default 100); routes over it are UNVERIFIED
  --intent <json>              declared removals: {"removedRoutes":[], "removedHrefs":[],
                               "textPatterns":[], "changedFields":[]}
  --harvest-baseline <json>    rendered harvest of the baseline, from --print-probe
  --harvest-candidate <json>   rendered harvest of the candidate
  --timeout-ms <n>             per request (default 15000)
  --json                       machine-readable report on stdout

  A harvest file is a JSON array of what the probe returned, one element per route.
  Without both harvests every rendered field is UNVERIFIED.

  exit 0  nothing lost, nothing unclear, nothing UNVERIFIED
  exit 1  anything lost or unclear, including a MISSING route: this blocks
  exit 2  anything UNVERIFIED, or unusable input: INDETERMINATE, never a pass`;
}

function parseArgs(argv) {
    const o = { maxRoutes: 100, timeoutMs: 15000, json: false };
    const need = (i, f) => { if (i + 1 >= argv.length) throw new Error(`${f} needs a value`); return argv[i + 1]; };
    const map = { '--baseline': 'baseline', '--candidate': 'candidate', '--routes': 'routes', '--intent': 'intent', '--harvest-baseline': 'harvestBaseline', '--harvest-candidate': 'harvestCandidate' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (map[a]) { o[map[a]] = need(i, a); i++; }
        else if (a === '--max-routes' || a === '--timeout-ms') {
            const n = Number(need(i, a)); i++;
            if (!Number.isInteger(n) || n < 1) throw new Error(`${a} must be a positive integer`);
            o[a === '--max-routes' ? 'maxRoutes' : 'timeoutMs'] = n;
        }
        else if (a === '--json') o.json = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--print-probe') o.printProbe = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return o;
}

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
        process.stderr.write(`parity-capture: ${e.message}\n\n${usage()}\n`);
        process.exitCode = 2;
        return;
    }
    if (opts.help) { process.stdout.write(usage() + '\n'); return; }
    if (opts.printProbe) { process.stdout.write(probeSource() + '\n'); return; }
    if (!opts.baseline || !opts.candidate) {
        process.stderr.write(`parity-capture: --baseline and --candidate are both required\n\n${usage()}\n`);
        process.exitCode = 2;
        return;
    }
    let rep;
    try { rep = await run(opts); } catch (e) {
        process.stderr.write(`parity-capture: INDETERMINATE, no verdict: ${e.message}\n`);
        process.exitCode = 2;
        return;
    }
    process.stdout.write((opts.json ? JSON.stringify(rep, null, 2) : render(rep)) + '\n');
    process.exitCode = rep.verdict.exit;
}

if (require.main === module) main();

module.exports = { harvest, probeSource, probeSha, parseHtml, normHref };
