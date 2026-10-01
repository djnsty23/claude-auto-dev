#!/usr/bin/env node
'use strict';

// check-ungated-apps.js - an app in the repository that no gate covers.
//
// THE INCIDENT. A product repository held a nested app: a subdirectory with
// its own package.json, its own framework and its own deploy target. It began
// as a throwaway prototype and was deliberately left out of the root app's CI,
// typecheck and lint. The next day it was reading a production database, with
// secrets and access-control logic. It then grew to roughly 675 commits with no
// tests and no CI step. Its only gate was a typecheck somebody ran by hand, and
// the session-end lint hook covered only the root app, so it reported green
// over it on every turn. A human review then found 150 defects (forged role
// cookies, path-matcher bypasses, a spoofable client IP, unbounded database
// reads, crashes on crafted input) that no check could have caught, because no
// check ever ran on that directory.
//
// Every signal in that repository was green and every one was true. The root
// gate passed, the hook passed, the deploy built. None of them was a statement
// about the nested app, and nothing said so. This check says so.
//
// WHAT IT ANSWERS, per app:
//   1. Is it reached by a gate? A CI file at the repository root
//      (.github/workflows, bitbucket-pipelines.yml, .gitlab-ci.yml and a few
//      others), a git hook (.husky, lefthook.yml), or a root package.json
//      script that a gate runs, which cds into it, passes its path, or runs it
//      by workspace name or as a workspace member.
//   2. Does it carry tests: a test script that is not the npm placeholder, and
//      at least one test file.
//   3. If it is ungated, what is at risk: database access, secret-named
//      environment variables, cookies, client-IP headers, auth or middleware
//      files, a deploy config of its own.
//
// WHAT COUNTS AS AN APP. A package.json with a build, start or dev script, or a
// framework dependency. A package.json that only marks a module type, or only
// holds tooling devDependencies, is read and counted but is not an app.
//
// WHAT IT IS NOT. It reads text; it runs nothing. A reference to an app inside
// a CI step is evidence the step runs on it, not that the step is strict. A
// path inside a `paths:`, `paths-ignore:`, cache or artifact block is not a
// reference, because the incident's own shape was an EXCLUSION, and reading an
// exclusion as coverage is the one mistake this check must not make.
//
// THE POPULATION. Inside a git repository: every tracked file plus every
// untracked file git does not ignore (`git ls-files --cached --others
// --exclude-standard`). Ignored directories are not part of the repository and
// are not counted. Outside one, or under --walk: a filesystem walk that skips
// node_modules, dot directories and build output. Both are printed.
//
// Usage:
//   check-ungated-apps.js [root] [--json] [--strict] [--walk] [--no-history]
//   check-ungated-apps.js --selftest
//
// Exit: 0 every app is reached by a gate (under --strict, and carries tests).
//       1 at least one app is reached by no gate (under --strict, or is untested).
//       2 could not check: no package.json at all, an unreadable package.json
//         and no other finding, a root that is not a directory, or bad usage.
//         A 2 vouches for nothing, never for a clean tree.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HELP = 'usage: check-ungated-apps.js [root] [--json] [--strict] [--walk] [--no-history] [--selftest]\n'
    + 'Lists every app in the repository (a package.json with a build, start or dev\n'
    + 'script, or a framework dependency) that no gate reaches: no root CI file, git\n'
    + 'hook or gate script cds into it, passes its path, or runs it by workspace.\n'
    + 'Each finding says what is missing (CI, tests or both) and what is at risk.\n'
    + '  --json        machine-readable report\n'
    + '  --strict      an app reached by a gate but carrying no tests also exits 1\n'
    + '  --walk        walk the filesystem instead of asking git for the file list\n'
    + '  --no-history  skip the per-app commit count (one git call per finding)\n'
    + 'Exit 0 every app gated, 1 at least one ungated app, 2 could not check.';

// Directories that never hold an app of this repository, in either mode.
const ALWAYS_SKIP = new Set(['node_modules', 'bower_components', 'jspm_packages']);
// Build output and vendored code. Git already ignores these where they matter,
// so only the walk needs them named.
const WALK_SKIP = new Set(['dist', 'build', 'out', 'coverage', 'vendor', 'tmp', 'temp']);
const WALK_CAP = 200000;

const FRAMEWORKS = [
    'next', 'react-scripts', 'vite', '@remix-run/node', '@remix-run/react', '@react-router/dev',
    'astro', 'nuxt', '@sveltejs/kit', 'svelte', 'vue', '@angular/core', 'gatsby', 'expo',
    'react-native', 'electron', 'express', 'fastify', 'hono', 'koa', '@nestjs/core',
    '@builder.io/qwik', 'solid-start', '@solidjs/start', '@tanstack/start', '@tanstack/react-start',
    'wrangler', 'remotion',
];
const DB_DEPS = [
    'pg', 'postgres', 'mysql2', 'mysql', 'mongodb', 'mongoose', '@prisma/client', 'prisma',
    'drizzle-orm', '@supabase/supabase-js', '@supabase/ssr', 'kysely', 'knex', 'better-sqlite3',
    '@neondatabase/serverless', '@planetscale/database', '@vercel/postgres', '@libsql/client',
    'redis', 'ioredis', '@upstash/redis',
];
const AUTH_DEPS = [
    'next-auth', '@auth/core', 'jose', 'jsonwebtoken', 'iron-session', 'better-auth', 'lucia',
    '@clerk/nextjs', 'passport', 'cookie', 'cookie-parser',
];
const DEPLOY_FILES = ['vercel.json', 'netlify.toml', 'Dockerfile', 'fly.toml', 'wrangler.toml', 'wrangler.jsonc', 'app.yaml', 'render.yaml', 'railway.json'];
const CODE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|e2e|cypress|playwright)\/.+\.[cm]?[jt]sx?$|\.(?:test|spec)\.[cm]?[jt]sx?$/;
// A root script with one of these names is a gate by name; anything it runs
// is a gate by reach.
const GATE_NAME = /^(?:gate|test|tests|check|checks|ci|verify|validate|lint|typecheck|type-check|types|precommit|pre-commit|prepush|pre-push)(?:[:-].*)?$/;
const PLACEHOLDER = /no test specified|^\s*(?:echo\b[^&|;]*|true|exit 0|:)\s*$/;
// Keys whose values are paths that FILTER or STORE, never paths a step runs in.
const FILTER_KEY = /^(\s*)(?:-\s+)?(?:paths|paths-ignore|path|branches|branches-ignore|tags|tags-ignore|changes|includePaths|excludePaths|exclude|ignore|only|except|artifacts|caches?|cache-dependency-path)\s*:/;
const PM_COMMAND = /\b(?:npm|pnpm|yarn|bun|npx|bunx|node|turbo|nx|tsc|eslint|vitest|jest|playwright)\b/;

// --- the file list -----------------------------------------------------------

function skippedSegment(rel, mode) {
    const parts = rel.split('/');
    parts.pop();
    return parts.some((s) => ALWAYS_SKIP.has(s) || s.startsWith('.') || (mode === 'walk' && WALK_SKIP.has(s)));
}

function gitFiles(root) {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root, timeout: 20000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).toString('utf8');
    return out.split('\0').filter(Boolean);
}

function walkFiles(root) {
    const files = [];
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        let entries;
        try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (ALWAYS_SKIP.has(e.name) || WALK_SKIP.has(e.name) || e.name.startsWith('.')) continue;
                stack.push(child);
            } else if (e.isFile()) {
                if (files.length >= WALK_CAP) return { files, truncated: true };
                files.push(child);
            }
        }
    }
    return { files, truncated: false };
}

function listFiles(root, forceWalk) {
    if (!forceWalk && fs.existsSync(path.join(root, '.git'))) {
        try { return { mode: 'git', files: gitFiles(root), truncated: false, note: null }; } catch (e) {
            const w = walkFiles(root);
            return { mode: 'walk', files: w.files, truncated: w.truncated, note: `git ls-files failed (${String(e.message).split('\n')[0]}), walked instead` };
        }
    }
    const w = walkFiles(root);
    return { mode: 'walk', files: w.files, truncated: w.truncated, note: null };
}

// --- reading packages ---------------------------------------------------------

function readText(abs) {
    try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

function readJson(abs) {
    const raw = readText(abs);
    if (raw === null) return { ok: false, error: 'unreadable' };
    try {
        const v = JSON.parse(raw.replace(/^﻿/, ''));
        return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, error: 'not an object' };
    } catch { return { ok: false, error: 'invalid JSON' }; }
}

function depsOf(pkg) {
    return Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {}, pkg.peerDependencies || {});
}

function scriptsOf(pkg) {
    return pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
}

function classifyPackage(pkg) {
    const why = [];
    const run = Object.keys(scriptsOf(pkg)).find((n) => /^(?:build|start|dev)(?::.*)?$/.test(n));
    if (run) why.push(`script ${run}`);
    const deps = depsOf(pkg);
    const fw = FRAMEWORKS.filter((d) => Object.prototype.hasOwnProperty.call(deps, d));
    if (fw.length) why.push(`framework ${fw.slice(0, 3).join(', ')}`);
    return { isApp: why.length > 0, why };
}

// --- the gate sources -----------------------------------------------------------

/** Strip YAML comments so a commented-out step is not read as live. */
function stripYamlComments(src) {
    return src.split('\n').map((line) => {
        let inSingle = false;
        let inDouble = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === "'" && !inDouble) inSingle = !inSingle;
            else if (c === '"' && !inSingle) inDouble = !inDouble;
            else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
        }
        return line;
    }).join('\n');
}

/**
 * Remove every block under a key whose values filter or store paths. A path
 * listed under `paths-ignore:` is the precise opposite of coverage, and the
 * incident was an exclusion, so it must never read as a reference.
 */
function dropFilterBlocks(src) {
    const lines = src.split('\n');
    const out = [];
    const indent = (l) => l.length - l.replace(/^[ \t]*/, '').length;
    for (let i = 0; i < lines.length; i++) {
        if (!FILTER_KEY.test(lines[i])) { out.push(lines[i]); continue; }
        const keyIndent = indent(lines[i]) + (/^\s*-\s+/.test(lines[i]) ? 2 : 0);
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || indent(lines[j]) > keyIndent)) j++;
        i = j - 1;
    }
    return out.join('\n');
}

function ciSources(root) {
    const out = [];
    const add = (rel, kind) => {
        const raw = readText(path.join(root, rel));
        if (raw !== null) out.push({ label: rel, kind, text: /\.ya?ml$/i.test(rel) ? dropFilterBlocks(stripYamlComments(raw)) : raw });
    };
    for (const dir of ['.github/workflows', '.gitea/workflows', '.forgejo/workflows']) {
        let names = [];
        try { names = fs.readdirSync(path.join(root, dir)).filter((f) => /\.ya?ml$/i.test(f)).sort(); } catch { /* none */ }
        for (const n of names) add(`${dir}/${n}`, 'ci');
    }
    for (const f of ['bitbucket-pipelines.yml', '.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', '.travis.yml', 'Jenkinsfile', '.buildkite/pipeline.yml']) {
        if (fs.existsSync(path.join(root, f))) add(f, 'ci');
    }
    let hooks = [];
    try { hooks = fs.readdirSync(path.join(root, '.husky'), { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('_') && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { /* none */ }
    for (const h of hooks) add(`.husky/${h}`, 'hook');
    for (const f of ['lefthook.yml', 'lefthook.yaml', '.pre-commit-config.yaml']) {
        if (fs.existsSync(path.join(root, f))) add(f, 'hook');
    }
    return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Root script names a command invokes. A segment that cds elsewhere invokes another package's scripts. */
function invokedScripts(text, known) {
    const names = new Set();
    for (const raw of text.split(/\n|&&|\|\||;/)) {
        const seg = ` ${raw.trim()} `;
        if (!raw.trim() || /\s(?:cd|pushd)\s|--prefix|\s-C\s|--dir[\s=]|--cwd[\s=]|--filter[\s=]|\s-F\s|--workspace[\s=]|\s-w\s|working-directory/.test(seg)) continue;
        let m;
        const runRe = /\b(?:npm|pnpm|bun|yarn)\s+run(?:-script)?\s+([\w:.@/-]+)/g;
        while ((m = runRe.exec(seg))) names.add(m[1]);
        if (/\bnpm\s+(?:test|t)\b/.test(seg)) names.add('test');
        if (/\bnpm\s+start\b/.test(seg)) names.add('start');
        const shortRe = /\b(?:pnpm|yarn)\s+([\w:.-]+)/g;
        while ((m = shortRe.exec(seg))) names.add(m[1]);
        const allRe = /\b(?:run-s|run-p|npm-run-all)\s+(.+)/g;
        while ((m = allRe.exec(seg))) {
            for (const tok of m[1].split(/\s+/)) {
                const t = tok.replace(/^['"]|['"]$/g, '');
                if (!t || t.startsWith('-')) continue;
                const re = new RegExp(`^${escapeRe(t).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^:]*')}$`);
                for (const k of known) if (re.test(k)) names.add(k);
            }
        }
    }
    return [...names].filter((n) => known.has(n));
}

/**
 * The root scripts a gate runs: every gate-named script, every script a CI
 * file or git hook invokes, and everything those invoke, with pre/post hooks.
 * The rest are returned too, because a root script that names the app and
 * that nothing runs is the shape a hand-run "gate" takes.
 */
function gateScripts(rootPkg, sources) {
    const scripts = scriptsOf(rootPkg);
    const known = new Set(Object.keys(scripts));
    const queue = [];
    for (const name of known) if (GATE_NAME.test(name) && !PLACEHOLDER.test(String(scripts[name]))) queue.push(name);
    for (const s of sources) queue.push(...invokedScripts(s.text, known));
    const closure = new Set();
    while (queue.length) {
        const n = queue.shift();
        if (closure.has(n)) continue;
        closure.add(n);
        for (const hook of [`pre${n}`, `post${n}`]) if (known.has(hook)) queue.push(hook);
        queue.push(...invokedScripts(String(scripts[n]), known));
    }
    const inGate = [...closure].sort().map((n) => ({ label: `root script "${n}"`, kind: 'root-script', text: String(scripts[n]) }));
    const outside = [...known].filter((n) => !closure.has(n)).sort().map((n) => ({ name: n, text: String(scripts[n]) }));
    return { inGate, outside };
}

// --- workspaces -----------------------------------------------------------------

function workspaceGlobs(root, rootPkg) {
    const globs = [];
    const ws = rootPkg && rootPkg.workspaces;
    if (Array.isArray(ws)) globs.push(...ws);
    else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages);
    const pnpm = readText(path.join(root, 'pnpm-workspace.yaml'));
    if (pnpm) {
        let inPackages = false;
        for (const line of stripYamlComments(pnpm).split('\n')) {
            if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
            if (/^\S/.test(line)) inPackages = false;
            const m = inPackages ? /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line) : null;
            if (m) globs.push(m[1]);
        }
    }
    return globs.filter((g) => typeof g === 'string');
}

function globToRegex(glob) {
    const g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
    const body = escapeRe(g).replace(/\\\*\\\*/g, '\u0000').replace(/\\\*/g, '[^/]*').replace(/\u0000/g, '.*');
    return new RegExp(`^${body}$`);
}

function isWorkspaceMember(rel, globs) {
    let member = false;
    for (const g of globs) {
        if (g.startsWith('!')) { if (globToRegex(g.slice(1)).test(rel)) member = false; } else if (globToRegex(g).test(rel)) member = true;
    }
    return member;
}

// --- does a source reach an app ------------------------------------------------------

/** The app's directory as a path token: `cd apps/web`, `--prefix=./apps/web`. Never `apps/web/**` or `apps/web-v2`. */
function referencesPath(text, rel) {
    const re = new RegExp(`(?:^|[\\s'"\`=:(,\\[])(?:\\./)?${escapeRe(rel)}/?(?=$|[\\s'"\`;&|),\\]])`, 'm');
    return re.test(text);
}

function referencesName(text, name) {
    if (!name) return false;
    const n = escapeRe(name);
    return new RegExp(`(?:--filter|-F|--workspace|-w|--scope)(?:=|\\s+)['"]?${n}(?:\\.\\.\\.)?(?=$|[\\s'"\`;&|)])`, 'm').test(text)
        || new RegExp(`\\byarn\\s+workspace\\s+${n}(?=$|\\s)`, 'm').test(text)
        || new RegExp(`\\bnx\\s+(?:run\\s+)?${n}:`, 'm').test(text);
}

function runsWholeWorkspace(text) {
    return text.split('\n').some((line) => /\bturbo\s+(?:run\s+)?[\w:-]+|\bnx\s+(?:run-many|affected)\b|\bpnpm\b.*\s(?:-r|--recursive)\b|--workspaces\b|\s(?:-ws|--ws)\b|\byarn\s+workspaces\s+foreach\b|\blerna\s+run\b/.test(line)
        && !/--filter|\s-F\s|--scope/.test(line));
}

function invokesPackageManagerAtRoot(text) {
    return text.split('\n').some((line) => PM_COMMAND.test(line) && !/(?:^|\s)cd\s|--prefix|\s-C\s|working-directory|--filter|--workspace[\s=]/.test(line));
}

function gatedBy(app, sources, members) {
    const by = [];
    for (const s of sources) {
        if (app.rel === '') {
            if (s.kind === 'root-script' || invokesPackageManagerAtRoot(s.text)) by.push(s.label);
        } else if (referencesPath(s.text, app.rel)) by.push(`${s.label} (path)`);
        else if (referencesName(s.text, app.name)) by.push(`${s.label} (workspace name)`);
        else if (members.has(app.rel) && runsWholeWorkspace(s.text)) by.push(`${s.label} (workspace-wide)`);
    }
    return by;
}

// --- tests and risk ---------------------------------------------------------------

function testsOf(pkg, owned) {
    const scripts = scriptsOf(pkg);
    const script = Object.keys(scripts).find((n) => /^(?:test|e2e)(?:[:-].*)?$/.test(n) && !PLACEHOLDER.test(String(scripts[n]))) || null;
    const files = owned.filter((f) => TEST_FILE.test(f.local)).length;
    return { script, files };
}

const RISK_PATTERNS = [
    ['database', /\b(?:DATABASE_URL|DIRECT_URL|POSTGRES_(?:URL|PRISMA_URL|URL_NON_POOLING)|SUPABASE_SERVICE_ROLE(?:_KEY)?|MONGODB_URI|MONGO_URL|MYSQL_URL|REDIS_URL|KV_URL|TURSO_DATABASE_URL)\b|service_role/],
    ['cookies', /\bcookies\(\)|\b(?:req|request)\.cookies\b|document\.cookie|set-cookie|\bsetCookie\(/i],
    ['client-ip', /x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|\b(?:req|request)\.ip\b/i],
];
const SECRET_ENV = /process\.env(?:\.|\[\s*['"])([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|_KEY|SERVICE_ROLE)[A-Z0-9_]*)/g;
const AUTH_FILE = /(?:^|\/)(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$|(?:^|\/)(?:auth|session|login|permissions?|rbac|roles?)(?:\.[\w-]+)?\.[cm]?[jt]sx?$|(?:^|\/)(?:auth|api\/auth)\//;

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function riskOf(appAbs, pkg, owned, deadline) {
    const hits = new Map();
    const hit = (k, file) => { if (!hits.has(k)) hits.set(k, new Set()); hits.get(k).add(file); };
    const deps = depsOf(pkg);
    const dbDeps = DB_DEPS.filter((d) => Object.prototype.hasOwnProperty.call(deps, d));
    const authDeps = AUTH_DEPS.filter((d) => Object.prototype.hasOwnProperty.call(deps, d));
    const secrets = new Set();
    let complete = true;
    for (const f of owned) {
        if (AUTH_FILE.test(f.local)) hit('auth', f.rel);
        if (!CODE_EXT.test(f.local) || TEST_FILE.test(f.local)) continue;
        if (Date.now() > deadline) { complete = false; break; }
        let text;
        try {
            const abs = path.join(appAbs, f.local);
            if (fs.statSync(abs).size > 512 * 1024) continue;
            text = fs.readFileSync(abs, 'utf8');
        } catch { continue; }
        for (const [k, re] of RISK_PATTERNS) if (re.test(text)) hit(k, f.rel);
        let m;
        SECRET_ENV.lastIndex = 0;
        while ((m = SECRET_ENV.exec(text))) { secrets.add(m[1]); hit('secrets', f.rel); }
    }
    const deploy = DEPLOY_FILES.filter((d) => fs.existsSync(path.join(appAbs, d)));
    const files = (k) => [...(hits.get(k) || [])].slice(0, 5);
    const out = [];
    if (hits.has('database') || dbDeps.length) {
        out.push({ hint: 'database', detail: [hits.has('database') ? 'reads a database URL or service-role key' : null, dbDeps.length ? `database client ${dbDeps.slice(0, 3).join(', ')}` : null].filter(Boolean).join('; '), files: files('database') });
    }
    if (secrets.size) out.push({ hint: 'secrets', detail: `${plural(secrets.size, 'secret-named env var')}`, files: files('secrets') });
    if (hits.has('cookies')) out.push({ hint: 'cookies', detail: 'reads or sets cookies', files: files('cookies') });
    if (hits.has('client-ip')) out.push({ hint: 'client-ip', detail: 'reads a client-IP header, which a caller can forge', files: files('client-ip') });
    if (hits.has('auth') || authDeps.length) {
        out.push({ hint: 'auth', detail: [hits.has('auth') ? plural(hits.get('auth').size, 'auth or middleware file') : null, authDeps.length ? `auth library ${authDeps.slice(0, 3).join(', ')}` : null].filter(Boolean).join('; '), files: files('auth') });
    }
    if (deploy.length) out.push({ hint: 'deploys', detail: `own deploy config ${deploy.join(', ')}`, files: [] });
    return { hints: out, complete };
}

function commitsOf(root, rel) {
    try {
        const n = execFileSync('git', ['rev-list', '--count', 'HEAD', '--', rel || '.'], {
            cwd: root, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        }).toString().trim();
        return /^\d+$/.test(n) ? Number(n) : null;
    } catch { return null; }
}

// --- the assessment ---------------------------------------------------------------

/**
 * Assess one repository. A root that is not a directory returns { error }.
 *   opts.walk        force the filesystem walk
 *   opts.history     count commits per finding (git mode only), default true
 *   opts.deadlineMs  budget for the risk scan, default 20000
 */
function assess(rootIn, opts = {}) {
    const root = path.resolve(rootIn);
    let st = null;
    try { st = fs.statSync(root); } catch { /* reported below */ }
    if (!st || !st.isDirectory()) return { root, error: `not a directory: ${root}` };
    const deadline = Date.now() + (opts.deadlineMs || 20000);

    const listing = listFiles(root, !!opts.walk);
    const pkgFiles = listing.files.filter((f) => (f === 'package.json' || f.endsWith('/package.json')) && !skippedSegment(f, listing.mode)).sort();
    const packages = [];
    const unreadable = [];
    for (const f of pkgFiles) {
        const j = readJson(path.join(root, f));
        if (!j.ok) { unreadable.push({ path: f, error: j.error }); continue; }
        packages.push({ rel: f === 'package.json' ? '' : f.slice(0, -'/package.json'.length), pkg: j.value, cls: classifyPackage(j.value) });
    }
    const rootEntry = packages.find((p) => p.rel === '');
    const rootPkg = rootEntry ? rootEntry.pkg : null;

    const ci = ciSources(root);
    const scripts = gateScripts(rootPkg, ci);
    const sources = ci.concat(scripts.inGate);
    const globs = workspaceGlobs(root, rootPkg);

    const apps = packages.filter((p) => p.cls.isApp).map((p) => ({
        rel: p.rel, name: typeof p.pkg.name === 'string' ? p.pkg.name : null, pkg: p.pkg, why: p.cls.why,
    }));
    const members = new Set(apps.filter((a) => a.rel && isWorkspaceMember(a.rel, globs)).map((a) => a.rel));

    // Each file belongs to the deepest app directory above it.
    const owned = new Map(apps.map((a) => [a.rel, []]));
    for (const f of listing.files) {
        if (skippedSegment(f, listing.mode)) continue;
        let dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
        for (;;) {
            if (owned.has(dir)) { owned.get(dir).push({ rel: f, local: dir ? f.slice(dir.length + 1) : f }); break; }
            if (!dir) break;
            dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
        }
    }

    const rows = apps.map((a) => {
        const by = gatedBy(a, sources, members);
        const tests = testsOf(a.pkg, owned.get(a.rel));
        const missing = [];
        if (!by.length) missing.push('CI');
        if (!tests.script || !tests.files) missing.push('tests');
        const row = {
            path: a.rel || '.', name: a.name, root: a.rel === '', why: a.why, gated: by.length > 0, gatedBy: by,
            workspaceMember: members.has(a.rel), tests, missing, risk: [], commits: null, notes: [],
        };
        if (row.gated) return row;
        const r = riskOf(path.join(root, a.rel), a.pkg, owned.get(a.rel), deadline);
        row.risk = r.hints;
        if (!r.complete) row.notes.push('the risk scan stopped at its time budget, so the hints are partial');
        if (opts.history !== false && listing.mode === 'git') row.commits = commitsOf(root, a.rel);
        if (a.rel) {
            const named = scripts.outside.filter((s) => referencesPath(s.text, a.rel) || referencesName(s.text, a.name)).map((s) => s.name);
            if (named.length) row.notes.push(`named by root script ${named.slice(0, 4).join(', ')}, which no CI step, git hook or gate script runs`);
            const own = ['.github/workflows', 'bitbucket-pipelines.yml', '.gitlab-ci.yml'].filter((f) => fs.existsSync(path.join(root, a.rel, f)));
            if (own.length) row.notes.push(`has its own ${own.join(', ')}, which the host never reads: only the repository root's CI config runs`);
        }
        return row;
    });

    return {
        root,
        population: {
            mode: listing.mode, files: listing.files.length, truncated: listing.truncated, note: listing.note,
            packageJsons: pkgFiles.length, unreadable, apps: rows.length,
        },
        gateSources: sources.map((s) => s.label),
        workspaceGlobs: globs,
        apps: rows,
        ungated: rows.filter((r) => !r.gated).length,
        untested: rows.filter((r) => r.gated && r.missing.includes('tests')).length,
    };
}

function exitFor(report, strict) {
    if (report.error) return 2;
    if (report.ungated > 0 || (strict && report.untested > 0)) return 1;
    if (report.population.packageJsons === 0 || report.population.unreadable.length > 0 || report.population.truncated) return 2;
    return 0;
}

// --- rendering -----------------------------------------------------------------------

function testSummary(t) {
    return `${t.script ? `test script "${t.script}"` : 'no test script'}, ${plural(t.files, 'test file')}`;
}

function render(report, strict) {
    const L = [];
    if (report.error) return `${report.error}\nCould not check, so this run vouches for NOTHING.`;
    const p = report.population;
    L.push(`${plural(p.apps, 'app')} in ${plural(p.packageJsons, 'package.json')}, from ${plural(p.files, 'file')} listed by `
        + `${p.mode === 'git' ? 'git (tracked plus untracked-not-ignored)' : 'a filesystem walk'} under ${report.root}`);
    if (p.note) L.push(`  note: ${p.note}`);
    const files = report.gateSources.filter((s) => !s.startsWith('root script '));
    const named = report.gateSources.filter((s) => s.startsWith('root script ')).map((s) => s.slice('root script '.length));
    L.push(`gate sources read: ${report.gateSources.length
        ? [files.join(', '), named.length ? `${plural(named.length, 'root gate script')} (${named.slice(0, 6).join(', ')}${named.length > 6 ? ', ...' : ''})` : ''].filter(Boolean).join('; ')
        : 'NONE (no root CI file, git hook or gate-named root script)'}`);
    if (p.packageJsons === 0) {
        L.push('\nNo package.json here, so there is no population: this run vouches for NOTHING, not even an all-clear.');
        return L.join('\n');
    }
    for (const u of p.unreadable) L.push(`  UNREADABLE  ${u.path} (${u.error}): not classified, so not vouched for`);
    if (p.truncated) L.push(`  the walk stopped at ${WALK_CAP} files: apps past it were not seen`);

    for (const r of report.apps) {
        if (!r.missing.length) continue;
        const label = `${r.path}${r.name ? ` (${r.name})` : ''}${r.root ? '  [the root app]' : ''}`;
        if (r.gated) {
            L.push(`\n  UNTESTED  ${label}`);
            L.push(`            gated by ${r.gatedBy.join(', ')}, but ${testSummary(r.tests)}`);
            continue;
        }
        L.push(`\n  UNGATED   ${label}`);
        L.push(`            missing: ${r.missing.join(' and ')}${r.missing.includes('tests') ? ` (${testSummary(r.tests)})` : ''}`);
        L.push(`            an app because: ${r.why.join('; ')}${r.commits !== null ? `; ${plural(r.commits, 'commit')} touch it` : ''}`);
        if (r.risk.length) {
            L.push('            at risk:');
            for (const h of r.risk) L.push(`              ${h.hint.padEnd(9)} ${h.detail}${h.files.length ? ` (${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? ', ...' : ''})` : ''}`);
        } else {
            L.push('            at risk: no database, secret, cookie, client-IP, auth or deploy marker found in its source');
        }
        for (const n of r.notes) L.push(`            note: ${n}`);
    }

    if (!p.apps) {
        L.push(`\nNone of the ${plural(p.packageJsons, 'package.json')} is an app (no build, start or dev script and no framework dependency), so there is nothing to gate.`);
        return L.join('\n');
    }
    const gated = report.apps.filter((r) => r.gated).length;
    L.push(`\n${gated} of ${plural(p.apps, 'app')} reached by a gate, ${report.ungated} ungated, ${report.untested} gated but untested.`);
    if (report.ungated) {
        L.push('An ungated app is outside every check this repository runs: a green root gate, lint hook or');
        L.push('deploy build is not a statement about it. Wire it into the root gate script or CI (cd into it,');
        L.push('or run it by workspace), then add tests. A path under paths-ignore, a cache or an artifact list');
        L.push('is not a reference, and a root script that no gate runs is not a gate.');
    } else if (report.untested && !strict) {
        L.push('Advisory: an untested app exits 0. --strict gates on it.');
    }
    return L.join('\n');
}

/**
 * The one line the SessionStart hook adds, or null. Nested apps only: a root
 * app with no gate means the repository has no gate, a different and visible
 * state, and saying so on every session in every small repository would teach
 * the reader to skip the line that matters.
 */
function hookLine(report, scriptPath, clean) {
    if (!report || report.error) return null;
    const nested = report.apps.filter((r) => !r.gated && !r.root);
    if (!nested.length) return null;
    const shown = nested.slice(0, 4).map((r) => {
        const risk = r.risk.map((h) => h.hint).join(', ');
        return `${clean(r.path).slice(0, 100)} (missing ${r.missing.join(' and ')}${risk ? `; at risk: ${risk}` : ''})`;
    });
    const more = nested.length > 4 ? `, +${nested.length - 4} more` : '';
    return `Ungated apps: ${nested.length} of ${plural(report.population.apps, 'app')} in this repository reached by no CI step, git hook or root gate script: `
        + `${shown.join('; ')}${more}. A green root gate, lint hook or typecheck says nothing about ${nested.length === 1 ? 'it' : 'them'}, `
        + `so verify a change there by hand and say so. Detail: node "${scriptPath}" "${clean(report.root).slice(0, 300)}"`;
}

// --- selftest --------------------------------------------------------------------------

function selftest() {
    const os = require('os');
    let pass = 0;
    let fail = 0;
    const t = (label, ok) => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ungated-'));
    const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    put('package.json', JSON.stringify({ name: 'root', scripts: { gate: 'npm test && npm --prefix apps/web test', test: 'vitest run', dev: 'next dev' }, dependencies: { next: '1' } }));
    put('src/a.test.ts', '');
    put('apps/web/package.json', JSON.stringify({ name: 'web', scripts: { build: 'next build', test: 'vitest' } }));
    put('apps/web/x.test.ts', '');
    put('apps/admin/package.json', JSON.stringify({ name: 'admin', scripts: { dev: 'next dev' } }));
    put('apps/admin/middleware.ts', 'const u = process.env.DATABASE_URL; req.cookies;');
    put('node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', scripts: { build: 'x' } }));
    const r = assess(root, { walk: true, history: false });
    const by = (p) => r.apps.find((a) => a.path === p) || { risk: [] };
    t('the root app is gated by its own gate script', by('.').gated === true);
    t('a nested app the root gate passes by path is gated', by('apps/web').gated === true);
    t('a nested app nothing reaches is UNGATED', by('apps/admin').gated === false);
    t('  and its risk names the database, cookies and the middleware file',
        ['database', 'auth', 'cookies'].every((h) => by('apps/admin').risk.some((x) => x.hint === h)));
    t('an app under node_modules is not in the population', r.apps.length === 3);
    t('the verdict is exit 1', exitFor(r) === 1);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ungated-empty-'));
    t('no package.json is exit 2, never a pass', exitFor(assess(empty, { walk: true })) === 2);
    for (const d of [root, empty]) fs.rmSync(d, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cases: gated root and nested apps, an ungated nested app and its risk, node_modules, and the no-population case)`);
    return fail ? 1 : 0;
}

// --- live run ----------------------------------------------------------------------------

function main(argv) {
    const has = (f) => argv.includes(f);
    if (has('--help') || has('-h')) { console.log(HELP); return 0; }
    if (has('--selftest')) return selftest();
    const known = new Set(['--json', '--strict', '--walk', '--no-history']);
    const bad = argv.filter((a) => a.startsWith('-') && !known.has(a));
    const positional = argv.filter((a) => !a.startsWith('-'));
    if (bad.length || positional.length > 1) {
        console.error(`unknown argument(s): ${bad.concat(positional.slice(1)).join(' ')}\n${HELP}`);
        return 2;
    }
    const report = assess(positional[0] || '.', { walk: has('--walk'), history: !has('--no-history') });
    const code = exitFor(report, has('--strict'));
    if (has('--json')) {
        console.log(JSON.stringify(Object.assign({}, report, { strict: has('--strict'), exit: code }), null, 2));
    } else {
        console.log(render(report, has('--strict')));
        const say = ['every app is reached by a gate', 'at least one app is outside every gate', 'could not check, so this vouches for nothing'];
        console.log(`exit ${code}: ${say[code]}${code === 1 && !report.ungated ? ' (--strict: an app carries no tests)' : ''}`);
    }
    return code;
}

module.exports = { assess, exitFor, render, hookLine };

// process.exitCode, never process.exit(): an immediate exit truncates a piped
// stdout on POSIX, and a long --json report is exactly what would be cut.
if (require.main === module) process.exitCode = main(process.argv.slice(2));
