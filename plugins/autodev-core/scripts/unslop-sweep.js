#!/usr/bin/env node
'use strict';
/**
 * unslop-sweep.js - sweep a product's routes for layout slop, rank what it
 * finds, turn it into fix stories, and prove whether a fix changed anything.
 *
 * The measuring is done by the rendered-layout gate's two halves:
 * layout-probe.js harvests in the page and layout-checks.js judges. This file
 * is the route loop around them, the report, the prd.json writer, the
 * before/after scorecard, and the bookkeeping for the advisory vision pass.
 *
 *   routes        list what would be swept: Next app-router pages, a sitemap,
 *                 or a list file, with the dynamic patterns it could not sample
 *   sweep         drive every route at every width, signed out and (when a
 *                 test login is supplied) signed in. Saves a snapshot, a
 *                 screenshot and a scorecard per route and width
 *   report        print the ranked findings of a finished sweep
 *   stories       group the findings by component into prd.json fix stories
 *   compare       the before/after delta table, and whether a fix COUNTS
 *   pairs         blind before/after screenshot pairs for a vision judge
 *   pair-score    the judge's win rate for the after side, from its verdicts
 *   vision-pack   the screenshots and rubric for the vision pass
 *   vision-merge  validate the vision findings, drop what the rules already
 *                 measured, and keep the rest as a separate ADVISORY section
 *   brief         a ready brief for a periodic per-product sweep
 *
 * LOCAL ONLY. `sweep` refuses any base URL that is not localhost, 127.0.0.1,
 * [::1], *.localhost or *.test, and exits 2. A sweep signs in with a test
 * login, and a test login must never be typed into production.
 *
 * SECRETS. A login comes from two environment variable NAMES
 * (--email-env, --password-env), supplied by the caller, typically through
 * `doppler run --`. Values are never printed, logged or written: the report
 * says only whether each name was present. `routes` lists the names of
 * candidate test-login variables it finds in env and seed files, never a value.
 *
 * Exit: 0 done, 1 --strict and a mechanical finding (or compare says the fix
 * does not count), 2 refused or could not run. Vision findings never set the
 * exit code: taste is advisory.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const CHECKS = require('./layout-checks.js');
const PROBE = require('./layout-probe.js');

const DEFAULT_WIDTHS = [390, 414, 1280];
const SHOT_MAX_HEIGHT = 6000;

// Weight per rule for ranking. Higher reads worse: a page that scrolls
// sideways or hides words outranks a 3px padding difference.
const RULE_WEIGHT = {
    'DOC-SCROLL': 5, 'OVERFLOW-CULPRIT': 4, 'TEXT-OCCLUDED': 4, 'CLIPPED-TEXT': 3,
    'GLUED-CONTROLS': 3, 'DOUBLE-BORDER': 3, 'NO-GUTTER': 3, 'SHORT-BAR': 2,
    'ROW-HEIGHT': 2, 'ROW-CENTER': 2, 'ROW-BORDER': 2, 'ROW-RADIUS': 2, 'ROW-PADDING': 2,
    'TAP-TARGET': 2, 'TRUNCATED-TEXT': 2, 'RHYTHM': 1,
};
// The overflow, occlusion and clipping family, counted together on the scorecard.
const OOC = new Set(['DOC-SCROLL', 'OVERFLOW-CULPRIT', 'CLIPPED-TEXT', 'TEXT-OCCLUDED']);

class Bail extends Error {
    constructor(code, message) { super(message); this.exitCode = code; }
}

// ================================================================ arguments

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
    }
    return out;
}

// ================================================================ routes

const PAGE_FILE = /^page\.(tsx|ts|jsx|js|mdx)$/;
const LOCALE_SEGMENTS = new Set(['locale', 'lang', 'lng']);

/** The app-router directory under a product root, or null. */
function findAppDir(root) {
    for (const rel of ['src/app', 'app']) {
        const p = path.join(root, rel);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    }
    return null;
}

/**
 * Every page.* under the app directory, as a route pattern. Route groups
 * `(x)` vanish from the URL; parallel slots `@x`, private folders `_x` and
 * intercepting routes `(.)x` are not addressable pages and are skipped.
 * Dynamic segments stay as `[x]`, `[...x]` or `[[...x]]` for sampling.
 */
function discoverAppRoutes(appDir, opts) {
    const locales = (opts && opts.locales) || [];
    const patterns = new Set();
    const walk = (dir, segs) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        if (entries.some((e) => e.isFile() && PAGE_FILE.test(e.name))) patterns.add('/' + segs.join('/'));
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const n = e.name;
            if (n.startsWith('@') || n.startsWith('_') || /^\(\.{1,3}\)/.test(n) || n === 'node_modules') continue;
            if (/^\(.*\)$/.test(n)) { walk(path.join(dir, n), segs); continue; }
            walk(path.join(dir, n), segs.concat(n));
        }
    };
    walk(appDir, []);
    const out = new Set();
    for (const p of patterns) {
        const segs = p.split('/').filter(Boolean);
        const loc = segs.findIndex((s) => /^\[(.+)\]$/.test(s) && LOCALE_SEGMENTS.has(s.slice(1, -1)));
        if (loc >= 0 && locales.length) {
            for (const l of locales) out.add('/' + segs.map((s, i) => (i === loc ? l : s)).join('/'));
        } else {
            out.add(p === '/' ? '/' : p.replace(/\/+$/, ''));
        }
        // An optional catch-all also matches the route without it.
        if (/\[\[\.\.\..+\]\]$/.test(p)) out.add('/' + segs.slice(0, -1).join('/'));
    }
    return [...out].map((r) => r || '/').sort();
}

function isDynamic(pattern) { return /\[[^\]]+\]/.test(pattern); }

/** A route pattern as a regex over URL paths. */
function patternRegex(pattern) {
    const segs = pattern.split('/').filter(Boolean).map((s) => {
        if (/^\[\[\.\.\..+\]\]$/.test(s)) return '(?:/.*)?';
        if (/^\[\.\.\..+\]$/.test(s)) return '/.+';
        if (/^\[.+\]$/.test(s)) return '/[^/]+';
        return '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return new RegExp('^' + (segs.join('') || '/') + '/?$');
}

/** Sitemap XML to {urls, sitemaps}: a urlset gives urls, an index gives sitemaps. */
function parseSitemap(xml) {
    const locs = [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    const isIndex = /<sitemapindex[\s>]/i.test(String(xml || ''));
    return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

function pathOf(u) {
    try { return new URL(u, 'http://x.invalid').pathname.replace(/\/+$/, '') || '/'; } catch { return null; }
}

/** One route per non-empty, non-# line. */
function readRouteList(text) {
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
        .map((l) => (l.startsWith('/') ? l : pathOf(l))).filter(Boolean);
}

/**
 * The routes to sweep. Static patterns as they are; each dynamic pattern
 * sampled from sitemap paths (up to `samples` each). Sitemap paths no pattern
 * explains are swept too when there are no app patterns at all. Returns the
 * list plus every dynamic pattern left unsampled, so a sweep cannot read as
 * covering pages it never opened.
 */
function planRoutes(patterns, sitemapPaths, opts) {
    const o = Object.assign({ samples: 1, maxRoutes: 60 }, opts || {});
    const routes = [];
    const unsampled = [];
    const seen = new Set();
    const add = (r, from) => { if (!seen.has(r)) { seen.add(r); routes.push({ path: r, from }); } };
    for (const p of patterns) if (!isDynamic(p)) add(p, 'app');
    for (const p of patterns.filter(isDynamic)) {
        const re = patternRegex(p);
        const hits = (sitemapPaths || []).filter((s) => re.test(s) && !seen.has(s)).slice(0, o.samples);
        if (!hits.length) unsampled.push(p);
        for (const h of hits) add(h, 'sitemap:' + p);
    }
    if (!patterns.length) for (const s of sitemapPaths || []) add(s, 'sitemap');
    const capped = routes.length > o.maxRoutes;
    return { routes: routes.slice(0, o.maxRoutes), unsampled, total: routes.length, capped };
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1|.+\.localhost|.+\.test)$/i;
/** Only a local development host may be swept, because a sweep may sign in. */
function isLocalBase(base) {
    try {
        const u = new URL(base);
        return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOST.test(u.hostname);
    } catch { return false; }
}

const LOGIN_NAME = /^(QA|TEST|E2E|SEED|DEMO)_[A-Z0-9_]*?(EMAIL|USER(NAME)?|LOGIN|PASSWORD|PASS)$/;
/**
 * Candidate test-login variable NAMES in a product's env and seed files.
 * Reads names only: an env line is matched up to `=` and the value is never
 * captured. Seed files are reported by path when they hold an email literal
 * beside a password field, which is where a fixture login usually lives.
 */
function findLoginSources(root) {
    const names = new Set();
    const files = [];
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { /* unreadable root: no sources */ }
    for (const f of entries.filter((n) => /^\.env(\..+)?$/.test(n))) {
        let text = '';
        try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
        for (const line of text.split(/\r?\n/)) {
            const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
            if (m && LOGIN_NAME.test(m[1])) names.add(m[1]);
        }
        files.push(f);
    }
    const seeds = [];
    for (const rel of ['supabase/seed.sql', 'prisma/seed.ts', 'prisma/seed.js', 'scripts/seed.ts', 'scripts/seed.js', 'e2e/fixtures', 'tests/fixtures']) {
        const p = path.join(root, rel);
        if (!fs.existsSync(p)) continue;
        const list = fs.statSync(p).isDirectory()
            ? fs.readdirSync(p).map((n) => path.join(p, n)).filter((x) => fs.statSync(x).isFile())
            : [p];
        for (const file of list.slice(0, 50)) {
            let t = '';
            try { t = fs.readFileSync(file, 'utf8'); } catch { continue; }
            if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t) && /password/i.test(t)) seeds.push(path.relative(root, file).replace(/\\/g, '/'));
        }
    }
    const emailNames = [...names].filter((n) => /(EMAIL|USER(NAME)?|LOGIN)$/.test(n)).sort();
    const pairs = emailNames.map((e) => {
        const stem = e.replace(/(EMAIL|USERNAME|USER|LOGIN)$/, '');
        const pw = [...names].find((n) => n === stem + 'PASSWORD' || n === stem + 'PASS');
        return pw ? { emailEnv: e, passwordEnv: pw } : null;
    }).filter(Boolean);
    return { envFiles: files, names: [...names].sort(), pairs, seedFiles: seeds };
}

// ================================================================ judging

/** Short, file-safe key for a route + state + width. */
function slugOf(route) {
    const s = route.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 80);
    return s || 'root';
}

/**
 * The scorecard row for one analysed capture. Pure: built from analyse()
 * output, plus the axe count and pixel diff when the browser leg measured
 * them (null when it did not, which reads n/a, never 0).
 */
function scoreOf(result, extra) {
    const x = extra || {};
    if (!result || result.status !== 'MEASURED') {
        return { status: result ? result.status : 'UNMEASURED', reason: result ? result.reason : 'no result', rules: {}, ruleHits: null, axe: x.axe == null ? null : x.axe, ooc: null, pixelDiffPct: x.pixelDiffPct == null ? null : x.pixelDiffPct };
    }
    const rules = {};
    for (const f of result.findings) rules[f.code] = (rules[f.code] || 0) + 1;
    const ooc = result.findings.filter((f) => OOC.has(f.code)).length;
    return {
        status: 'MEASURED',
        rules,
        ruleHits: result.findings.length,
        componentsMeasured: !!(result.counts && result.counts.components),
        axe: x.axe == null ? null : x.axe,
        axeById: x.axeById || null,
        ooc,
        pixelDiffPct: x.pixelDiffPct == null ? null : x.pixelDiffPct,
    };
}

/**
 * Rank findings across a sweep. Grouped by rule and selector, so one header
 * defect on forty routes is one row; scored by rule weight times how many
 * route-width captures it appears on.
 */
function rankFindings(captures) {
    const groups = new Map();
    for (const c of captures) {
        if (!c.result || c.result.status !== 'MEASURED') continue;
        for (const f of c.result.findings) {
            const key = f.code + ' ' + f.sel;
            if (!groups.has(key)) groups.set(key, { code: f.code, sel: f.sel, lm: f.lm || null, hits: [], first: f });
            groups.get(key).hits.push({ route: c.route, state: c.state, width: c.width, detail: f.detail, note: f.note, threshold: f.threshold });
        }
    }
    const rows = [...groups.values()].map((g) => {
        const where = new Set(g.hits.map((h) => h.route + '|' + h.state + '|' + h.width));
        const routes = [...new Set(g.hits.map((h) => h.route))];
        const widths = [...new Set(g.hits.map((h) => h.width))].sort((a, b) => a - b);
        return {
            code: g.code, sel: g.sel, lm: g.lm,
            score: (RULE_WEIGHT[g.code] || 1) * where.size,
            captures: where.size, routes, widths, count: g.hits.length,
            example: g.hits[0],
        };
    });
    rows.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code) || a.sel.localeCompare(b.sel));
    return rows;
}

/**
 * The component a finding belongs to. Shared chrome (anything inside a
 * header, nav or footer landmark) is one component across every route, so a
 * header defect seen on forty pages becomes one story. Anything else is its
 * selector.
 */
function componentOf(row) {
    if (row.lm && /^(header|nav|footer)\b/.test(row.lm)) return row.lm;
    if (/^(header|nav|footer)\b/.test(row.sel)) return row.sel.split(' > ')[0];
    return row.sel;
}

/** Ranked rows to fix stories, one per component. */
function groupStories(rows, meta) {
    const m = meta || {};
    const byComp = new Map();
    for (const r of rows) {
        const comp = componentOf(r);
        if (!byComp.has(comp)) byComp.set(comp, []);
        byComp.get(comp).push(r);
    }
    const stories = [];
    for (const [comp, rs] of byComp) {
        const score = rs.reduce((n, r) => n + r.score, 0);
        const codes = [...new Set(rs.map((r) => r.code))];
        const routes = [...new Set(rs.flatMap((r) => r.routes))];
        const widths = [...new Set(rs.flatMap((r) => r.widths))].sort((a, b) => a - b);
        const top = Math.max(...rs.map((r) => RULE_WEIGHT[r.code] || 1));
        const priority = top >= 4 ? 1 : top >= 3 ? 2 : 3;
        const evidence = rs.slice(0, 6).map((r) => `${r.code} ${r.sel} @${r.widths.join('/')}: ${r.example.note} (threshold: ${r.example.threshold})`);
        stories.push({
            dedupeKey: 'unslop:' + comp,
            component: comp,
            title: `Fix ${codes.map((c) => c.toLowerCase()).join(', ')} in ${comp}`,
            priority,
            score,
            codes,
            routes,
            widths,
            notes: [
                `unslop:${comp} | sweep ${m.sweepId || '?'} at ${m.sha || '?'} | ${routes.length} route(s): ${routes.slice(0, 5).join(', ')}${routes.length > 5 ? ' ...' : ''} | widths ${widths.join(', ')}`,
                ...evidence,
                `Evidence: ${m.outDir || '<sweep dir>'}/findings.json`,
            ].join('\n'),
            acceptance: `Re-run the unslop sweep: ${codes.join(', ')} report 0 for ${comp} at ${widths.join(', ')}, and \`unslop-sweep.js compare\` says the fix COUNTS (no other route's counts rose).`,
        });
    }
    stories.sort((a, b) => b.score - a.score);
    return stories;
}

/**
 * Add stories to a prd.json object. Pure: returns {prd, added, skipped}.
 * A story whose dedupe key already sits in an open story is skipped; one that
 * matches only DONE stories is added again, because the defect came back.
 * New ids are S{sprint}-{nnn}, unused across every container.
 */
function mergeIntoPrd(prd, stories, opts) {
    const o = opts || {};
    const out = prd && typeof prd === 'object' ? JSON.parse(JSON.stringify(prd)) : { stories: {} };
    const containers = Array.isArray(out.sprints) && out.sprints.length
        ? out.sprints.map((s) => { s.stories = s.stories || {}; return s.stories; })
        : [out.stories = out.stories || {}];
    const target = containers[containers.length - 1];
    const all = Object.assign({}, ...containers);
    let sprint = Number(o.sprint) || Number(out.sprint) || 0;
    if (!sprint) {
        for (const id of Object.keys(all)) {
            const m = /^S(\d+)-/.exec(id);
            if (m) sprint = Math.max(sprint, Number(m[1]));
        }
        sprint = sprint || 1;
    }
    let n = 0;
    for (const id of Object.keys(all)) {
        const m = new RegExp('^S' + sprint + '-(\\d+)$').exec(id);
        if (m) n = Math.max(n, Number(m[1]));
    }
    const added = [];
    const skipped = [];
    for (const s of stories) {
        const open = Object.values(all).find((x) => x && typeof x.notes === 'string' && x.notes.includes(s.dedupeKey + ' ') && x.passes !== true && x.passes !== 'deferred');
        if (open) { skipped.push({ dedupeKey: s.dedupeKey, existing: open.id }); continue; }
        n++;
        const id = `S${sprint}-${String(n).padStart(3, '0')}`;
        target[id] = {
            id, title: s.title, priority: s.priority, passes: null, type: 'fix', category: 'ux-ui',
            notes: s.notes, acceptance: s.acceptance, resolution: '',
        };
        all[id] = target[id];
        added.push(id);
    }
    return { prd: out, added, skipped };
}

/** Sum a scorecard route entry into one comparable row per width. */
function flattenScorecard(card) {
    const rows = new Map();
    for (const r of (card && card.routes) || []) {
        for (const [w, s] of Object.entries(r.widths || {})) rows.set(`${r.route}|${r.state}|${w}`, Object.assign({ route: r.route, state: r.state, width: Number(w) }, s));
    }
    return rows;
}

function sumRules(rules, codes) {
    return Object.entries(rules || {}).filter(([c]) => !codes || codes.includes(c)).reduce((n, [, v]) => n + v, 0);
}

/**
 * Before/after per route, state and width. A fix COUNTS only when the target
 * count dropped on its own route(s) AND no other count rose anywhere: not the
 * rule hits, not axe, not the overflow family. `target` is {codes?, routes?};
 * without codes the target is every rule hit, without routes every route.
 */
function compareScorecards(before, after, target) {
    const t = target || {};
    const B = flattenScorecard(before);
    const A = flattenScorecard(after);
    const keys = [...new Set([...B.keys(), ...A.keys()])].sort();
    const rows = [];
    let targetBefore = 0;
    let targetAfter = 0;
    const rises = [];
    const unmeasured = [];
    for (const k of keys) {
        const b = B.get(k);
        const a = A.get(k);
        if (!b || !a || b.status !== 'MEASURED' || a.status !== 'MEASURED') {
            unmeasured.push({ key: k, before: b ? b.status : 'absent', after: a ? a.status : 'absent' });
            continue;
        }
        const onTarget = !t.routes || t.routes.includes(b.route);
        const tb = sumRules(b.rules, t.codes);
        const ta = sumRules(a.rules, t.codes);
        if (onTarget) { targetBefore += tb; targetAfter += ta; }
        const row = {
            route: b.route, state: b.state, width: b.width,
            ruleHits: [b.ruleHits, a.ruleHits], axe: [b.axe, a.axe], ooc: [b.ooc, a.ooc],
            target: onTarget ? [tb, ta] : null, pixelDiffPct: a.pixelDiffPct,
            rose: [],
        };
        // Any rule that rose on any capture is a regression, even on a target
        // route: a fix that trades one defect for another has not fixed it.
        const codes = new Set([...Object.keys(b.rules || {}), ...Object.keys(a.rules || {})]);
        for (const c of codes) {
            const d = (a.rules[c] || 0) - (b.rules[c] || 0);
            if (d > 0) row.rose.push(`${c} +${d}`);
        }
        if (b.axe != null && a.axe != null && a.axe > b.axe) row.rose.push(`axe +${a.axe - b.axe}`);
        if (row.rose.length) rises.push(`${b.route} ${b.state} @${b.width}: ${row.rose.join(', ')}`);
        rows.push(row);
    }
    const dropped = targetAfter < targetBefore;
    const counts = dropped && rises.length === 0;
    return {
        verdict: counts ? 'COUNTS' : dropped ? 'REGRESSED-ELSEWHERE' : 'NO-DROP',
        counts, targetBefore, targetAfter, rises, unmeasured, rows,
    };
}

// ---------------------------------------------------------------- blind pairs

/** A deterministic PRNG, so a pair set can be regenerated from its seed. */
function rng(seed) {
    let s = (Number(seed) >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Before/after shot pairs in shuffled order. Returns the judge's manifest
 * (pair id, image A, image B, nothing else) and the key (which side is the
 * after), kept apart so the judge never sees it.
 */
function makePairs(beforeShots, afterShots, seed) {
    const rand = rng(seed);
    const manifest = [];
    const key = {};
    const ids = Object.keys(beforeShots).filter((k) => afterShots[k]).sort();
    ids.forEach((k, i) => {
        const id = 'p' + String(i + 1).padStart(3, '0');
        const afterIsA = rand() < 0.5;
        manifest.push({ id, a: afterIsA ? afterShots[k] : beforeShots[k], b: afterIsA ? beforeShots[k] : afterShots[k] });
        key[id] = { capture: k, after: afterIsA ? 'a' : 'b' };
    });
    return { manifest, key };
}

/** Win rate of the after side over the judge's verdicts {id: 'a'|'b'|'tie'}. */
function scorePairs(key, verdicts) {
    let wins = 0, losses = 0, ties = 0, missing = 0;
    const per = [];
    for (const [id, k] of Object.entries(key)) {
        const v = verdicts ? verdicts[id] : undefined;
        if (v !== 'a' && v !== 'b' && v !== 'tie') { missing++; continue; }
        const outcome = v === 'tie' ? 'tie' : v === k.after ? 'after' : 'before';
        if (outcome === 'after') wins++; else if (outcome === 'before') losses++; else ties++;
        per.push({ id, capture: k.capture, preferred: outcome });
    }
    const judged = wins + losses + ties;
    return { pairs: Object.keys(key).length, judged, wins, losses, ties, missing, winRate: judged ? Math.round((wins / judged) * 1000) / 1000 : null, per };
}

// ---------------------------------------------------------------- vision

const RUBRIC = ['hierarchy', 'alignment', 'control-consistency', 'spacing-rhythm', 'copy', 'empty-error-states', 'unfinished'];
// The rule family each rubric item overlaps, for dedupe against the measured findings.
const RUBRIC_RULES = {
    alignment: ['ROW-CENTER', 'NO-GUTTER', 'SHORT-BAR', 'OVERFLOW-CULPRIT'],
    'control-consistency': ['ROW-HEIGHT', 'ROW-BORDER', 'ROW-RADIUS', 'ROW-PADDING', 'GLUED-CONTROLS', 'DOUBLE-BORDER', 'TAP-TARGET'],
    'spacing-rhythm': ['RHYTHM', 'GLUED-CONTROLS', 'NO-GUTTER'],
    unfinished: ['SHORT-BAR', 'TRUNCATED-TEXT', 'CLIPPED-TEXT', 'TEXT-OCCLUDED', 'DOUBLE-BORDER'],
    copy: ['TRUNCATED-TEXT', 'CLIPPED-TEXT'],
    hierarchy: [],
    'empty-error-states': [],
};

/** Shape-check vision findings. Returns {valid, rejected}. */
function validateVision(items) {
    const valid = [];
    const rejected = [];
    for (const it of Array.isArray(items) ? items : []) {
        const why = [];
        if (!it || typeof it !== 'object') { rejected.push({ item: it, why: ['not an object'] }); continue; }
        if (!RUBRIC.includes(it.rubric)) why.push('rubric not one of ' + RUBRIC.join(', '));
        if (typeof it.route !== 'string') why.push('route missing');
        if (!Number.isFinite(Number(it.width))) why.push('width missing');
        if (!(typeof it.confidence === 'number' && it.confidence >= 0 && it.confidence <= 1)) why.push('confidence must be 0..1');
        if (typeof it.observation !== 'string' || it.observation.length < 8) why.push('observation missing');
        if (why.length) rejected.push({ item: it, why }); else valid.push(Object.assign({ state: 'signed-out' }, it, { width: Number(it.width) }));
    }
    return { valid, rejected };
}

function overlaps(a, b) {
    if (!a || !b) return false;
    return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}

/**
 * Vision findings minus what the measured rules already reported at the same
 * route, state and width, in the same rule family, by selector or box overlap.
 * What remains is ADVISORY and is never counted with the mechanical findings.
 */
function mergeVision(captures, visionItems) {
    const { valid, rejected } = validateVision(visionItems);
    const kept = [];
    const duplicates = [];
    for (const v of valid) {
        const cap = captures.find((c) => c.route === v.route && c.width === v.width && c.state === v.state);
        const family = RUBRIC_RULES[v.rubric] || [];
        const match = cap && cap.result && cap.result.status === 'MEASURED' && cap.result.findings.find((f) =>
            family.includes(f.code) && ((v.sel && f.sel && (f.sel.includes(v.sel) || v.sel.includes(f.sel))) ||
                overlaps(v.box, f.detail && f.detail.box)));
        if (match) duplicates.push({ vision: v, rule: match.code, sel: match.sel });
        else kept.push(v);
    }
    kept.sort((a, b) => b.confidence - a.confidence);
    return { advisory: kept, duplicates, rejected };
}

// ================================================================ browser

/** Resolve a module from the product first, then from an explicit path. */
function resolveFrom(root, name, explicit) {
    if (explicit) return require(path.resolve(explicit));
    const paths = [root, process.cwd()].filter(Boolean);
    return require(require.resolve(name, { paths }));
}

function contextOptions(width) {
    const touch = width < 768;
    return {
        viewport: { width, height: 844 },
        deviceScaleFactor: touch ? 2 : 1,
        isMobile: touch,
        hasTouch: touch,
        reducedMotion: 'reduce',
    };
}

async function settle(page) {
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* a page that never idles is still measured */ }
    await page.waitForTimeout(250);
}

/**
 * Measure one page at one width. The adapter takes an open Playwright page so
 * the suite can drive it with a fake. Returns {snapshot, finalUrl, axe, shot}.
 */
async function capture(page, url, width, opts) {
    const o = opts || {};
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs || 60000 });
    await settle(page);
    const snapshot = await page.evaluate(PROBE.probeSource({ requestedWidth: width, label: o.label || null }));
    let axe = null;
    let axeById = null;
    if (o.axeSource) {
        try {
            await page.evaluate(o.axeSource);
            const v = await page.evaluate('axe.run(document, { resultTypes: ["violations"] }).then(function (r) { return r.violations.map(function (x) { return { id: x.id, n: x.nodes.length }; }); })');
            axe = v.reduce((n, x) => n + x.n, 0);
            axeById = Object.fromEntries(v.map((x) => [x.id, x.n]));
        } catch { axe = null; }
    }
    let shot = null;
    if (o.shotPath) {
        const h = Math.min(SHOT_MAX_HEIGHT, (snapshot && snapshot.viewport && snapshot.viewport.scrollHeight) || 844);
        shot = await page.screenshot({ path: o.shotPath, fullPage: true, clip: { x: 0, y: 0, width, height: h }, animations: 'disabled' });
    }
    return { snapshot, finalUrl: page.url(), status: resp ? resp.status() : null, axe, axeById, shot };
}

/** Share of differing pixels between two PNGs, measured in the browser. */
async function pixelDiff(page, pngA, pngB) {
    const a = 'data:image/png;base64,' + Buffer.from(pngA).toString('base64');
    const b = 'data:image/png;base64,' + Buffer.from(pngB).toString('base64');
    await page.setContent('<!doctype html><title>diff</title>');
    return page.evaluate(async ([da, db]) => {
        const load = async (d) => createImageBitmap(await (await fetch(d)).blob());
        const ia = await load(da);
        const ib = await load(db);
        const w = Math.max(ia.width, ib.width);
        const h = Math.max(ia.height, ib.height);
        const px = (img) => {
            const c = new OffscreenCanvas(w, h);
            const x = c.getContext('2d');
            x.fillStyle = '#ff00ff';
            x.fillRect(0, 0, w, h);
            x.drawImage(img, 0, 0);
            return x.getImageData(0, 0, w, h).data;
        };
        const pa = px(ia);
        const pb = px(ib);
        let diff = 0;
        for (let i = 0; i < pa.length; i += 4) {
            if (Math.abs(pa[i] - pb[i]) > 16 || Math.abs(pa[i + 1] - pb[i + 1]) > 16 || Math.abs(pa[i + 2] - pb[i + 2]) > 16) diff++;
        }
        return Math.round((diff / (w * h)) * 10000) / 100;
    }, [a, b]);
}

async function signIn(page, base, loginPath, email, password) {
    await page.goto(new URL(loginPath, base).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page);
    const emailBox = page.locator('input[type=email], input[name*=email i], input[autocomplete=username]').first();
    const pwBox = page.locator('input[type=password]').first();
    await emailBox.fill(email, { timeout: 10000 });
    await pwBox.fill(password, { timeout: 10000 });
    await pwBox.press('Enter');
    try {
        await page.waitForURL((u) => !new URL(u).pathname.startsWith(loginPath), { timeout: 20000 });
        return true;
    } catch { return false; }
}

// ================================================================ sweep

async function sweep(args) {
    const base = args.base;
    if (!base || !isLocalBase(base)) throw new Bail(2, `refused: --base must be a local development host (localhost, 127.0.0.1, [::1], *.localhost, *.test), got ${base || 'nothing'}`);
    const root = args.root ? path.resolve(args.root) : null;
    const out = path.resolve(args.out || '.unslop/' + new Date().toISOString().replace(/[:.]/g, '-'));
    const widths = args.widths ? String(args.widths).split(',').map(Number).filter(Boolean) : DEFAULT_WIDTHS;
    const plan = await planFromArgs(args, root);
    if (!plan.routes.length) throw new Bail(2, 'no routes to sweep: pass --root with an app router, --sitemap or --routes-file');

    const pw = resolveFrom(root, 'playwright', args.playwright);
    let axeSource = null;
    if (!args['no-axe']) {
        try {
            const p = args.axe ? path.resolve(args.axe) : require.resolve('axe-core/axe.min.js', { paths: [root || process.cwd()] });
            axeSource = fs.readFileSync(p, 'utf8');
        } catch { axeSource = null; }
    }
    const initStorage = args['init-storage'] ? JSON.parse(fs.readFileSync(path.resolve(args['init-storage']), 'utf8')) : null;
    const baseline = args.baseline ? path.resolve(args.baseline) : null;

    fs.mkdirSync(path.join(out, 'shots'), { recursive: true });
    fs.mkdirSync(path.join(out, 'snapshots'), { recursive: true });

    const login = { requested: !!(args['email-env'] && args['password-env']) };
    login.emailPresent = login.requested && !!process.env[args['email-env']];
    login.passwordPresent = login.requested && !!process.env[args['password-env']];
    const loginPath = args['login-path'] || '/login';

    const browser = await pw.chromium.launch({ headless: true });
    const captures = [];
    const log = (s) => { if (!args.quiet) process.stderr.write(s + '\n'); };
    try {
        const states = [{ name: 'signed-out' }];
        if (login.requested) states.push({ name: 'signed-in' });
        const protectedRoutes = new Set();
        for (const st of states) {
            for (const width of widths) {
                const ctx = await browser.newContext(contextOptions(width));
                if (initStorage) {
                    await ctx.addInitScript((kv) => { try { for (const k of Object.keys(kv)) localStorage.setItem(k, kv[k]); } catch (e) { /* storage blocked */ } }, initStorage);
                }
                const page = await ctx.newPage();
                let ok = true;
                if (st.name === 'signed-in') {
                    if (!(login.emailPresent && login.passwordPresent)) {
                        ok = false;
                        st.reason = `login variables not present in env (${args['email-env']}: ${login.emailPresent ? 'present' : 'absent'}, ${args['password-env']}: ${login.passwordPresent ? 'present' : 'absent'})`;
                    } else {
                        ok = await signIn(page, base, loginPath, process.env[args['email-env']], process.env[args['password-env']]);
                        if (!ok) st.reason = 'sign-in did not leave the login page within 20s';
                    }
                }
                const routes = st.name === 'signed-in'
                    ? plan.routes.filter((r) => protectedRoutes.has(r.path) || r.path === '/' || args['signed-in-all'])
                    : plan.routes;
                const seenFinal = new Map();
                for (const r of routes) {
                    const label = `${slugOf(r.path)}-${st.name}-${width}`;
                    if (!ok) { captures.push({ route: r.path, state: st.name, width, label, result: { status: 'UNMEASURED', reason: st.reason, findings: [] } }); continue; }
                    const shotPath = path.join(out, 'shots', label + '.png');
                    let cap;
                    try {
                        cap = await capture(page, new URL(r.path, base).href, width, { label, axeSource, shotPath });
                    } catch (e) {
                        captures.push({ route: r.path, state: st.name, width, label, result: { status: 'UNMEASURED', reason: 'capture failed: ' + String(e.message || e).split('\n')[0], findings: [] } });
                        log(`  ${label}: capture failed`);
                        continue;
                    }
                    const finalPath = pathOf(cap.finalUrl);
                    const redirectedTo = finalPath !== (pathOf(r.path) || '/') ? finalPath : null;
                    if (redirectedTo && st.name === 'signed-out' && redirectedTo.startsWith(loginPath)) protectedRoutes.add(r.path);
                    if (redirectedTo && seenFinal.has(finalPath)) {
                        captures.push({ route: r.path, state: st.name, width, label, redirectedTo, sameAs: seenFinal.get(finalPath), result: { status: 'REDIRECT', reason: `redirected to ${redirectedTo}, already measured as ${seenFinal.get(finalPath)}`, findings: [] } });
                        continue;
                    }
                    seenFinal.set(finalPath, r.path);
                    const snapFile = path.join(out, 'snapshots', label + '.json.gz');
                    fs.writeFileSync(snapFile, zlib.gzipSync(JSON.stringify(cap.snapshot)));
                    const result = CHECKS.analyse(cap.snapshot);
                    let pixelDiffPct = null;
                    if (baseline && fs.existsSync(path.join(baseline, 'shots', label + '.png'))) {
                        const dp = await ctx.newPage();
                        try { pixelDiffPct = await pixelDiff(dp, fs.readFileSync(path.join(baseline, 'shots', label + '.png')), fs.readFileSync(shotPath)); } catch { pixelDiffPct = null; }
                        await dp.close();
                    }
                    captures.push({ route: r.path, state: st.name, width, label, redirectedTo, httpStatus: cap.status, shot: path.relative(out, shotPath).replace(/\\/g, '/'), result, axe: cap.axe, axeById: cap.axeById, pixelDiffPct });
                    log(`  ${label}: ${result.status} ${result.findings ? result.findings.length : 0} findings${cap.axe != null ? `, axe ${cap.axe}` : ''}`);
                }
                await ctx.close();
            }
        }
    } finally {
        await browser.close();
    }

    const meta = {
        schema: 'autodev.unslop/1', base, root, widths, startedAt: new Date().toISOString(),
        sweepId: path.basename(out), sha: args.sha || null, componentSha: PROBE.componentSha(), probeSha: PROBE.probeSha(),
        plan: { total: plan.total, swept: plan.routes.length, capped: plan.capped, unsampled: plan.unsampled, sources: plan.sources },
        login: { requested: login.requested, emailEnv: args['email-env'] || null, passwordEnv: args['password-env'] || null, emailPresent: login.emailPresent, passwordPresent: login.passwordPresent },
        axe: axeSource ? 'measured' : 'not available',
    };
    const card = scorecardOf(captures, meta);
    const slim = captures.map((c) => Object.assign({}, c, { result: slimResult(c.result) }));
    fs.writeFileSync(path.join(out, 'findings.json'), JSON.stringify({ meta, captures: slim }, null, 1));
    fs.writeFileSync(path.join(out, 'scorecard.json'), JSON.stringify(card, null, 1));
    return { out, meta, captures: slim, card };
}

function slimResult(r) {
    if (!r) return r;
    return { status: r.status, reason: r.reason || null, findings: r.findings || [], counts: r.counts || null, componentPopulation: r.componentPopulation || null };
}

function scorecardOf(captures, meta) {
    const byRoute = new Map();
    for (const c of captures) {
        const k = c.route + '|' + c.state;
        if (!byRoute.has(k)) byRoute.set(k, { route: c.route, state: c.state, widths: {} });
        byRoute.get(k).widths[c.width] = Object.assign(scoreOf(c.result, { axe: c.axe, axeById: c.axeById, pixelDiffPct: c.pixelDiffPct }), { shot: c.shot || null });
    }
    return { schema: 'autodev.unslop-scorecard/1', sweepId: meta ? meta.sweepId : null, sha: meta ? meta.sha : null, routes: [...byRoute.values()] };
}

async function planFromArgs(args, root) {
    const sources = [];
    let patterns = [];
    if (root) {
        const app = findAppDir(root);
        if (app) {
            patterns = discoverAppRoutes(app, { locales: args.locales ? String(args.locales).split(',') : [] });
            sources.push(`app router: ${patterns.length} patterns`);
        }
    }
    let sitemapPaths = [];
    if (args.sitemap) {
        let xml = '';
        const src = String(args.sitemap);
        if (/^https?:/.test(src) || src === 'auto') {
            const u = src === 'auto' ? new URL('/sitemap.xml', args.base).href : src;
            if (!isLocalBase(u)) throw new Bail(2, 'refused: a sitemap URL must be local too');
            try { const res = await fetch(u); if (res.ok) xml = await res.text(); } catch { xml = ''; }
        } else {
            xml = fs.readFileSync(path.resolve(src), 'utf8');
        }
        const sm = parseSitemap(xml);
        sitemapPaths = sm.urls.map(pathOf).filter(Boolean);
        sources.push(`sitemap: ${sitemapPaths.length} urls${sm.sitemaps.length ? `, ${sm.sitemaps.length} child sitemaps not followed` : ''}`);
    }
    if (args['routes-file']) {
        const list = readRouteList(fs.readFileSync(path.resolve(args['routes-file']), 'utf8'));
        sources.push(`list: ${list.length} routes`);
        const plan = { routes: list.map((p) => ({ path: p, from: 'list' })), unsampled: [], total: list.length, capped: false };
        plan.sources = sources;
        return plan;
    }
    const plan = planRoutes(patterns, sitemapPaths, { samples: Number(args.samples) || 1, maxRoutes: Number(args['max-routes']) || 60 });
    plan.sources = sources;
    return plan;
}

// ================================================================ printing

function printReport(data, opts) {
    const o = opts || {};
    const caps = data.captures;
    const m = data.meta || {};
    const lines = [];
    const measured = caps.filter((c) => c.result && c.result.status === 'MEASURED');
    const routes = [...new Set(caps.map((c) => c.route))];
    lines.push(`unslop sweep ${m.sweepId || ''} - ${m.base || ''}`);
    lines.push(`routes: ${routes.length} swept of ${m.plan ? m.plan.total : '?'} planned${m.plan && m.plan.capped ? ' (capped)' : ''}; widths ${(m.widths || []).join(', ')}; captures ${caps.length}, measured ${measured.length}`);
    const byStatus = {};
    for (const c of caps) { const s = c.result ? c.result.status : '?'; byStatus[s] = (byStatus[s] || 0) + 1; }
    lines.push('capture status: ' + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', '));
    if (m.plan && m.plan.unsampled && m.plan.unsampled.length) lines.push(`unsampled dynamic patterns (no sitemap match, NOT swept): ${m.plan.unsampled.join(', ')}`);
    if (m.login) lines.push(`signed in: ${m.login.requested ? `${m.login.emailEnv} ${m.login.emailPresent ? 'present' : 'absent'}, ${m.login.passwordEnv} ${m.login.passwordPresent ? 'present' : 'absent'}` : 'not requested (no --email-env/--password-env), signed-in leg UNMEASURED'}`);
    lines.push(`axe: ${m.axe || '?'}`);
    lines.push('');
    // Findings by rule, with the population: how many captures the rule could
    // judge. A mobile-only rule judges only touch widths.
    const codes = Object.values(CHECKS.CODES);
    lines.push('rule                 findings  captures-hit  judged');
    for (const code of codes) {
        const key = CHECKS.COUNT_KEY[code];
        const judged = measured.filter((c) => {
            const cs = c.result.counts;
            if (!cs) return false;
            if (key) return cs.components && cs.components[key] != null;
            return true;
        }).length;
        const n = measured.reduce((s, c) => s + c.result.findings.filter((f) => f.code === code).length, 0);
        const hit = measured.filter((c) => c.result.findings.some((f) => f.code === code)).length;
        lines.push(`${code.padEnd(20)} ${String(n).padStart(8)}  ${String(hit).padStart(12)}  ${String(judged).padStart(6)}`);
    }
    const rows = rankFindings(caps);
    lines.push('');
    lines.push(`top ${Math.min(o.top || 10, rows.length)} of ${rows.length} distinct findings (rule x selector), ranked by weight x captures:`);
    rows.slice(0, o.top || 10).forEach((r, i) => {
        lines.push(`${String(i + 1).padStart(2)}. [${r.score}] ${r.code}  ${r.sel}`);
        lines.push(`    ${r.routes.length} route(s) at ${r.widths.join('/')}: e.g. ${r.example.route} @${r.example.width} ${r.example.state}`);
        lines.push(`    ${r.example.note}`);
        lines.push(`    measured: ${JSON.stringify(compactDetail(r.example.detail))}`);
        lines.push(`    threshold: ${r.example.threshold}`);
    });
    return lines.join('\n');
}

function compactDetail(d) {
    if (!d) return d;
    const out = {};
    for (const [k, v] of Object.entries(d)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') out[k] = v.map((x) => `${x.sel}:h${x.h}${x.frame != null ? ` f${x.frame}` : ''}${x.radius != null ? ` r${x.radius}` : ''}${x.padX != null ? ` p${x.padX}` : ''}`);
        else out[k] = v;
    }
    return out;
}

function printCompare(cmp) {
    const n = (v) => (v == null ? 'n/a' : String(v));
    const lines = ['route                          state       width  rules       axe        overflow   target     pixel%   rose'];
    for (const r of cmp.rows) {
        lines.push([
            r.route.slice(0, 30).padEnd(30), r.state.padEnd(11), String(r.width).padEnd(6),
            `${n(r.ruleHits[0])}->${n(r.ruleHits[1])}`.padEnd(11), `${n(r.axe[0])}->${n(r.axe[1])}`.padEnd(10),
            `${n(r.ooc[0])}->${n(r.ooc[1])}`.padEnd(10), (r.target ? `${r.target[0]}->${r.target[1]}` : '-').padEnd(10),
            n(r.pixelDiffPct).padEnd(8), r.rose.join(', ') || '-',
        ].join(' '));
    }
    lines.push('');
    lines.push(`target: ${cmp.targetBefore} -> ${cmp.targetAfter}; rises elsewhere: ${cmp.rises.length}; unmeasured pairs: ${cmp.unmeasured.length}`);
    lines.push(`verdict: ${cmp.verdict}${cmp.counts ? ' (the fix counts)' : ' (the fix does NOT count)'}`);
    for (const r of cmp.rises) lines.push(`  rose: ${r}`);
    return lines.join('\n');
}

// ================================================================ brief

function briefText(repo, base, opts) {
    const o = opts || {};
    return [
        `# Periodic unslop sweep: ${path.basename(repo)}`,
        '',
        'Load the `unslop` skill and follow it. Scope: this repository only, on a local dev or prod build.',
        '',
        '1. `git worktree add .claude/worktrees/unslop-<date> -b chore/unslop-<date> origin/main`, copy `.env.local` in, install, and start the app on a free port.',
        `2. Sweep: \`node "<plugin>/scripts/unslop-sweep.js" sweep --root . --base ${base} --out .claude/reports/unslop/<date> --sitemap auto\`. Add \`--email-env\`/\`--password-env\` only when the test login variables are present in env (\`doppler run --\`), and only on localhost.`,
        '3. Turn findings into stories: `unslop-sweep.js stories <out> --prd prd.json --write`. One shared header or footer defect is one story.',
        '4. Hand the stories to `auto`. After the fixes, sweep again with `--baseline <first out>` and run `unslop-sweep.js compare <first out> <second out>`. A fix counts only when its target drops and nothing else rises.',
        '5. Report: routes, widths, findings by rule, the top 10, before and after counts, the compare verdict.',
        '',
        `Return to: ${o.returnTo || '<address>'}`,
    ].join('\n');
}

// ================================================================ selftest

function selftest() {
    let bad = 0;
    const say = (ok, what) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
    say(isLocalBase('http://localhost:3000') && isLocalBase('http://127.0.0.1:1') && isLocalBase('http://app.test') && !isLocalBase('https://example.com'), 'only local hosts may be swept');
    say(patternRegex('/blog/[category]/[slug]').test('/blog/a/b') && !patternRegex('/blog/[slug]').test('/blog/a/b'), 'dynamic patterns match one segment each');
    const plan = planRoutes(['/', '/pricing', '/blog/[slug]', '/docs/[...p]'], ['/blog/hello', '/blog/world'], { samples: 1 });
    say(plan.routes.length === 3 && plan.unsampled.length === 1 && plan.unsampled[0] === '/docs/[...p]', 'a dynamic pattern with no sitemap match is reported as unsampled');
    const cardA = { routes: [{ route: '/', state: 'signed-out', widths: { 390: { status: 'MEASURED', rules: { 'GLUED-CONTROLS': 1 }, ruleHits: 1, axe: 0, ooc: 0 } } }] };
    const cardB = { routes: [{ route: '/', state: 'signed-out', widths: { 390: { status: 'MEASURED', rules: {}, ruleHits: 0, axe: 0, ooc: 0 } } }] };
    say(compareScorecards(cardA, cardB).verdict === 'COUNTS' && compareScorecards(cardB, cardA).verdict === 'NO-DROP', 'compare: a drop counts and its reverse does not');
    const pr = makePairs({ x: 'b.png' }, { x: 'a.png' }, 7);
    say(scorePairs(pr.key, { p001: pr.key.p001.after }).winRate === 1, 'pairs: a judge that picks the after side scores 1');
    say(findLoginSources(path.join(__dirname, 'no-such-dir')).names.length === 0, 'an unreadable root has no login sources');
    console.log(bad ? `${bad} selftest check(s) failed` : 'selftest passed');
    return bad ? 1 : 0;
}

// ================================================================ main

function usage() {
    console.log(`unslop-sweep.js - sweep a product's routes for layout slop, rank it, make stories, prove fixes.

  routes        --root <app> [--sitemap <file|url|auto> --base <url>] [--routes-file <f>] [--locales en,ro]
  sweep         --base <local url> [--root <app>] [--out <dir>] [--widths 390,414,1280]
                [--sitemap ..] [--routes-file ..] [--max-routes 60] [--samples 1]
                [--email-env NAME --password-env NAME] [--login-path /login] [--signed-in-all]
                [--init-storage <json>] [--baseline <earlier out>] [--playwright <dir>] [--axe <file>|--no-axe]
                [--sha <commit>] [--strict] [--quiet]
  report        <out> [--top 10] [--json]
  stories       <out> [--prd prd.json] [--write] [--sprint N]
  compare       <before out> <after out> [--codes A,B] [--routes /a,/b] [--json]
  pairs         <before out> <after out> --pairs <dir> [--seed 1]
  pair-score    <pairs dir> --verdicts <json>
  vision-pack   <out> [--max 12]
  vision-merge  <out> --vision <json>
  brief         --repo <dir> --base <url> [--return <address>]
  --selftest | --help

Local only: sweep refuses any base that is not localhost, 127.0.0.1, [::1], *.localhost or *.test.
Exit: 0 done, 1 --strict with mechanical findings or compare not counting, 2 refused or could not run.`);
}

function readSweep(dir) {
    const f = path.join(path.resolve(dir), 'findings.json');
    if (!fs.existsSync(f)) throw new Bail(2, `no findings.json in ${dir}`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}

async function main(argv) {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (args.help || args.h || cmd === 'help') { usage(); return 0; }
    if (args.selftest) return selftest();
    if (!cmd) { usage(); return 2; }

    if (cmd === 'routes') {
        const root = args.root ? path.resolve(args.root) : null;
        const plan = await planFromArgs(args, root);
        const logins = root ? findLoginSources(root) : null;
        if (args.json) { console.log(JSON.stringify({ plan, logins }, null, 1)); return 0; }
        console.log(`sources: ${plan.sources.join('; ') || 'none'}`);
        console.log(`routes: ${plan.routes.length} of ${plan.total}${plan.capped ? ' (capped by --max-routes)' : ''}`);
        for (const r of plan.routes) console.log(`  ${r.path}   (${r.from})`);
        console.log(`unsampled dynamic patterns: ${plan.unsampled.length}${plan.unsampled.length ? ' - ' + plan.unsampled.join(', ') : ''}`);
        if (logins) {
            console.log(`test-login variable names in ${logins.envFiles.length} env file(s): ${logins.names.length ? logins.names.join(', ') : 'none'}`);
            console.log(`email/password pairs: ${logins.pairs.length ? logins.pairs.map((p) => p.emailEnv + '+' + p.passwordEnv).join(', ') : 'none'}`);
            console.log(`seed files holding an email and a password field: ${logins.seedFiles.length ? logins.seedFiles.join(', ') : 'none'}`);
        }
        return 0;
    }
    if (cmd === 'sweep') {
        const res = await sweep(args);
        const data = { meta: res.meta, captures: res.captures };
        console.log(printReport(data, { top: Number(args.top) || 10 }));
        console.log(`\nsaved: ${res.out}`);
        const mech = res.captures.reduce((n, c) => n + ((c.result && c.result.findings) || []).length, 0);
        return args.strict && mech ? 1 : 0;
    }
    if (cmd === 'report') {
        const data = readSweep(args._[1]);
        if (args.json) { console.log(JSON.stringify(rankFindings(data.captures), null, 1)); return 0; }
        console.log(printReport(data, { top: Number(args.top) || 10 }));
        const vf = path.join(path.resolve(args._[1]), 'vision.json');
        if (fs.existsSync(vf)) console.log('\n' + printVision(JSON.parse(fs.readFileSync(vf, 'utf8'))));
        return 0;
    }
    if (cmd === 'stories') {
        const dir = path.resolve(args._[1] || '.');
        const data = readSweep(dir);
        const stories = groupStories(rankFindings(data.captures), { sweepId: data.meta.sweepId, sha: data.meta.sha, outDir: path.relative(process.cwd(), dir).replace(/\\/g, '/') });
        const prdPath = path.resolve(args.prd || 'prd.json');
        let prd = null;
        if (fs.existsSync(prdPath)) {
            try { prd = JSON.parse(fs.readFileSync(prdPath, 'utf8')); } catch { throw new Bail(2, `refused: ${prdPath} is not valid JSON; never overwrite an unreadable backlog`); }
        }
        const merged = mergeIntoPrd(prd || { project: path.basename(path.dirname(prdPath)), sprint: 1, stories: {} }, stories, { sprint: args.sprint });
        console.log(`${stories.length} component stories from ${rankFindings(data.captures).length} distinct findings; ${merged.added.length} new, ${merged.skipped.length} already open`);
        for (const s of stories) console.log(`  p${s.priority} [${s.score}] ${s.title}  (${s.routes.length} routes)`);
        for (const s of merged.skipped) console.log(`  skipped ${s.dedupeKey}: open as ${s.existing}`);
        if (args.write) {
            fs.writeFileSync(prdPath, JSON.stringify(merged.prd, null, 2) + '\n');
            console.log(`wrote ${merged.added.join(', ') || 'nothing'} to ${prdPath}`);
        } else {
            console.log('dry run: pass --write to add them');
        }
        return 0;
    }
    if (cmd === 'compare') {
        const read = (d) => JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'scorecard.json'), 'utf8'));
        if (!args._[1] || !args._[2]) throw new Bail(2, 'compare needs <before out> <after out>');
        const target = { codes: args.codes ? String(args.codes).split(',') : undefined, routes: args.routes ? String(args.routes).split(',') : undefined };
        const cmp = compareScorecards(read(args._[1]), read(args._[2]), target);
        console.log(args.json ? JSON.stringify(cmp, null, 1) : printCompare(cmp));
        return cmp.counts ? 0 : 1;
    }
    if (cmd === 'pairs') {
        const shots = (d) => {
            const card = JSON.parse(fs.readFileSync(path.join(path.resolve(d), 'scorecard.json'), 'utf8'));
            const out = {};
            for (const r of card.routes) for (const [w, s] of Object.entries(r.widths)) if (s.shot) out[`${r.route}|${r.state}|${w}`] = path.join(path.resolve(d), s.shot);
            return out;
        };
        if (!args.pairs) throw new Bail(2, 'pairs needs --pairs <dir>');
        const dir = path.resolve(args.pairs);
        fs.mkdirSync(dir, { recursive: true });
        const pr = makePairs(shots(args._[1]), shots(args._[2]), args.seed || 1);
        const manifest = pr.manifest.map((p) => {
            const a = path.join(dir, p.id + '-a.png');
            const b = path.join(dir, p.id + '-b.png');
            fs.copyFileSync(p.a, a);
            fs.copyFileSync(p.b, b);
            return { id: p.id, a: path.basename(a), b: path.basename(b) };
        });
        fs.writeFileSync(path.join(dir, 'pairs.json'), JSON.stringify({ instructions: 'For each pair, answer which image reads as the more finished, consistent UI: "a", "b" or "tie". Return {"<id>": "a"|"b"|"tie"}.', pairs: manifest }, null, 1));
        // The key is written beside, never inside, what the judge reads. Give
        // the judge pairs.json and the images only.
        fs.writeFileSync(path.join(dir, '.key.json'), JSON.stringify(pr.key, null, 1));
        console.log(`${manifest.length} blind pairs in ${dir} (judge reads pairs.json and the images; .key.json stays with you)`);
        return 0;
    }
    if (cmd === 'pair-score') {
        const dir = path.resolve(args._[1] || '.');
        const key = JSON.parse(fs.readFileSync(path.join(dir, '.key.json'), 'utf8'));
        const verdicts = JSON.parse(fs.readFileSync(path.resolve(args.verdicts), 'utf8'));
        const s = scorePairs(key, verdicts);
        console.log(`after preferred in ${s.wins} of ${s.judged} judged pairs (win rate ${s.winRate == null ? 'n/a' : s.winRate}); before ${s.losses}, tie ${s.ties}, unanswered ${s.missing}`);
        return 0;
    }
    if (cmd === 'vision-pack') {
        const dir = path.resolve(args._[1] || '.');
        const data = readSweep(dir);
        const max = Number(args.max) || 12;
        const rows = rankFindings(data.captures);
        // The worst-ranked routes first, then one capture per remaining route,
        // so the judge sees the problems and a spread, within its budget.
        const pick = [];
        const seen = new Set();
        const addCap = (c) => { const k = c.label; if (c.shot && !seen.has(k) && pick.length < max) { seen.add(k); pick.push(c); } };
        for (const r of rows) for (const c of data.captures.filter((x) => x.route === r.example.route && x.width === r.example.width && x.state === r.example.state)) addCap(c);
        for (const c of data.captures) addCap(c);
        const rubric = fs.readFileSync(path.join(__dirname, '..', 'skills', 'unslop', 'references', 'vision-rubric.md'), 'utf8');
        const pack = { rubric: RUBRIC, instructions: rubric, shots: pick.map((c) => ({ route: c.route, width: c.width, state: c.state, image: path.join(dir, c.shot), measured: (c.result.findings || []).map((f) => `${f.code} ${f.sel}`) })) };
        fs.writeFileSync(path.join(dir, 'vision-pack.json'), JSON.stringify(pack, null, 1));
        console.log(`${pack.shots.length} screenshots packed in ${path.join(dir, 'vision-pack.json')}`);
        return 0;
    }
    if (cmd === 'vision-merge') {
        const dir = path.resolve(args._[1] || '.');
        const data = readSweep(dir);
        const items = JSON.parse(fs.readFileSync(path.resolve(args.vision), 'utf8'));
        const merged = mergeVision(data.captures, Array.isArray(items) ? items : items.findings);
        fs.writeFileSync(path.join(dir, 'vision.json'), JSON.stringify(merged, null, 1));
        console.log(printVision(merged));
        return 0;
    }
    if (cmd === 'brief') {
        if (!args.repo || !args.base) throw new Bail(2, 'brief needs --repo and --base');
        if (!isLocalBase(args.base)) throw new Bail(2, 'refused: --base must be local');
        console.log(briefText(path.resolve(args.repo), args.base, { returnTo: args.return }));
        return 0;
    }
    usage();
    return 2;
}

function printVision(m) {
    const lines = [`ADVISORY (vision pass, never gates): ${m.advisory.length} finding(s); ${m.duplicates.length} dropped as already measured; ${m.rejected.length} rejected as malformed`];
    for (const v of m.advisory.slice(0, 15)) lines.push(`  [${v.confidence.toFixed(2)}] ${v.rubric}  ${v.route} @${v.width} ${v.state}: ${v.observation}`);
    return lines.join('\n');
}

module.exports = {
    discoverAppRoutes, findAppDir, isDynamic, patternRegex, parseSitemap, readRouteList, planRoutes,
    isLocalBase, findLoginSources, slugOf, scoreOf, rankFindings, componentOf, groupStories, mergeIntoPrd,
    flattenScorecard, compareScorecards, scorecardOf, makePairs, scorePairs, rng, validateVision, mergeVision,
    contextOptions, capture, pixelDiff, signIn, sweep, printReport, printCompare, briefText, parseArgs,
    RULE_WEIGHT, RUBRIC, RUBRIC_RULES, DEFAULT_WIDTHS,
};

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
        if (e instanceof Bail) { console.error(e.message); process.exitCode = e.exitCode; return; }
        console.error('unslop-sweep: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : e));
        process.exitCode = 2;
    });
}
