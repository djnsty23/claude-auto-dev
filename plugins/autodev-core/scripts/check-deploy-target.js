#!/usr/bin/env node
'use strict';

// check-deploy-target.js — two refusals on the deploy path, both after the fact,
// both from measurements taken on 2026-09-08.
//
// They are one script because they are one failure surface: a `vercel` command
// run from a directory, doing more than the person running it asked for. They
// are two SUBCOMMANDS because they fail independently and either one alone is
// still worth refusing on.
//
//   --deployment <file|->  --intent <preview|production>
//        Read a deployment JSON and refuse when a PREVIEW was intended and the
//        target came back "production".
//
//   --ignore-file [dir]
//        Refuse when a directory Vercel would upload has no .vercelignore.
//
// ---------------------------------------------------------------------------
// WHY THIS IS CHECKED AFTER THE DEPLOY AND NOT BEFORE
//
// `vercel --yes` is documented — and was documented in this repo's own ship
// skill — as the way to get a PREVIEW. On a project's FIRST deployment it is
// not. Vercel's own words, captured 2026-09-08:
//
//   "This is the project's first deployment, so it was assigned to production.
//    Future deployments will be preview deployments unless you use --prod."
//
// No pre-check can predict this. Whether a deploy is a project's first is a
// fact about Vercel's account state, not about the tree, the flags or anything
// a session can read locally. So the intent is declared, the deploy runs, and
// the RESULT is read back. `target` is already in the deploy JSON:
//   null           -> preview
//   "production"   -> production
//
// This was hit twice independently in one day: by a greenfield-run session on a
// throwaway project, and by the fleet coordinator by accident, which created a
// public production alias for a repo worktree.
//
// ---------------------------------------------------------------------------
// WHY A MISSING target IS NOT A PREVIEW
//
// The dangerous reading of this JSON is that absence means preview, because
// preview really is encoded as `null`. It is not the same fact. `target: null`
// is Vercel saying "preview"; a missing `target` key is this script failing to
// find the field it came for — a changed CLI shape, the wrong object, an error
// payload, an empty file. Those two must not print the same, so absence exits 2
// (INDETERMINATE) and never 0. A check that reports "preview, fine" on an empty
// JSON is a check that passes on emptiness.
//
// ---------------------------------------------------------------------------
// WHY .vercelignore IS A SEPARATE DEFECT
//
// THE VERCEL CLI DOES NOT READ .gitignore. Measured on the accidental deploy
// above: 423 tracked files AND 16 gitignored files were uploaded, and with no
// framework detected Vercel set the output directory to `.` and served the tree
// statically. `/.claude/settings.local.json` returned HTTP 200 to an
// unauthenticated curl while `/` returned 404.
//
// That instance was low-value — a public repo, no secret-shaped strings in the
// uploaded set — but the mechanism does not know that. The same command from a
// product worktree uploads whatever that repo gitignores.
//
// And .vercelignore is NOT "the .gitignore rules again". The two files answer
// different questions. .gitignore decides what is TRACKED; .vercelignore decides
// what is UPLOADED AND SERVED. Every file in this repo is tracked and none of it
// should ever be served, so matching .gitignore is a floor, not the rule. This
// repo's .gitignore deliberately names individual .claude/ paths so that partial
// tracking there stays possible; a .vercelignore has no such reason and excludes
// .claude/ wholesale.
//
// ---------------------------------------------------------------------------
// EXIT CODES
//   0  the result matches the declared intent / the ignore floor is covered
//   1  REFUSAL — a stated fact about what happened, with the undo
//   2  INDETERMINATE — could not read the answer; NOT a pass

const fs = require('fs');
const path = require('path');

// Read as literals, never derived from anything this script also checks against,
// so narrowing one cannot narrow the other in the same edit.
const IGNORE_FLOOR = ['.claude', '.git', 'node_modules', '.env'];

const out = [];
const say = (s) => out.push(s);
const flush = () => { if (out.length) process.stdout.write(out.join('\n') + '\n'); };

// --------------------------------------------------------------- arg parsing

function parseArgs(argv) {
    const a = { mode: null, deployment: null, intent: null, dir: null, bad: null };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--deployment') { a.mode = 'deployment'; a.deployment = argv[++i] || null; }
        else if (v === '--intent') { a.intent = argv[++i] || null; }
        else if (v === '--ignore-file') { a.mode = 'ignore'; if (argv[i + 1] && !argv[i + 1].startsWith('--')) a.dir = argv[++i]; }
        else if (v === '--help' || v === '-h') { a.mode = 'help'; }
        else a.bad = v;
    }
    return a;
}

const USAGE = [
    'check-deploy-target.js — refuse a deploy that did more than was intended',
    '',
    '  --deployment <file|-> --intent <preview|production>',
    '        Read a deployment JSON (vercel inspect <url> --json) and refuse',
    '        when a preview was intended and target came back "production".',
    '',
    '  --ignore-file [dir]',
    '        Refuse when [dir] (default: cwd) has no .vercelignore covering',
    '        ' + IGNORE_FLOOR.join(', '),
    '',
    'Exit: 0 ok  ·  1 refusal  ·  2 indeterminate (could not read the answer)',
].join('\n');

// ------------------------------------------------------- the target subcommand

// Find `target` without assuming the exact envelope. `vercel inspect --json`
// has returned the deployment at the top level and nested under `deployment`;
// both are accepted, and WHICH ONE matched is printed, because a check that
// silently falls back to a second source can match something it was not aimed
// at and report a fact about the wrong object.
function locateTarget(doc) {
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        if (Object.prototype.hasOwnProperty.call(doc, 'target')) return { found: true, at: 'target', value: doc.target, holder: doc };
        const d = doc.deployment;
        if (d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, 'target')) {
            return { found: true, at: 'deployment.target', value: d.target, holder: d };
        }
    }
    return { found: false, at: null, value: undefined, holder: null };
}

function describe(value) {
    if (value === null) return 'preview';
    if (value === 'production') return 'production';
    return null; // a value this script does not know how to read
}

function runDeployment(args) {
    if (args.intent !== 'preview' && args.intent !== 'production') {
        say('INDETERMINATE  --intent must be "preview" or "production"; got ' + JSON.stringify(args.intent));
        say('  An undeclared intent cannot be compared against a result. Nothing was checked.');
        return 2;
    }
    if (!args.deployment) {
        say('INDETERMINATE  --deployment needs a file path or "-" for stdin. Nothing was read.');
        return 2;
    }

    let raw;
    try {
        raw = args.deployment === '-'
            ? fs.readFileSync(0, 'utf8')
            : fs.readFileSync(args.deployment, 'utf8');
    } catch (e) {
        say('INDETERMINATE  could not read ' + args.deployment + ': ' + e.message);
        say('  Nothing was checked. This is NOT a passing deploy.');
        return 2;
    }

    // Population floor. An empty read is the case that most looks like a pass.
    if (raw.trim() === '') {
        say('INDETERMINATE  read 0 bytes from ' + args.deployment + ', so nothing was checked.');
        say('  An empty deployment JSON is not a preview. Capture it with:');
        say('    vercel inspect <deployment-url> --json');
        return 2;
    }

    let doc;
    try {
        doc = JSON.parse(raw);
    } catch (e) {
        say('INDETERMINATE  read ' + raw.length + ' bytes from ' + args.deployment + ' and could not parse them as JSON: ' + e.message);
        say('  Nothing was checked. This is NOT a passing deploy.');
        return 2;
    }

    const loc = locateTarget(doc);
    if (!loc.found) {
        say('INDETERMINATE  read ' + raw.length + ' bytes of valid JSON with NO "target" field.');
        say('  Looked at: target, deployment.target');
        say('  A missing target is not a preview. It means this is not the object');
        say('  this check came for — a changed CLI shape, an error payload, or the');
        say('  wrong deployment. Re-capture with: vercel inspect <url> --json');
        return 2;
    }

    const actual = describe(loc.value);
    if (actual === null) {
        say('INDETERMINATE  ' + loc.at + ' = ' + JSON.stringify(loc.value) + ', which this check does not know how to read.');
        say('  Known values: null (preview), "production" (production).');
        say('  Treat as unverified, not as a preview.');
        return 2;
    }

    const url = (loc.holder && (loc.holder.url || loc.holder.alias)) || null;
    const project = (loc.holder && (loc.holder.name || loc.holder.project)) || null;
    const where = url ? (String(url).startsWith('http') ? url : 'https://' + url) : '(no url in the JSON)';

    if (actual === args.intent) {
        say('OK  intent=' + args.intent + '  ' + loc.at + '=' + JSON.stringify(loc.value) + ' (' + actual + ')  ' + where);
        return 0;
    }

    if (args.intent === 'preview' && actual === 'production') {
        say('REFUSED  A PREVIEW WAS INTENDED AND THIS DEPLOY WENT TO PRODUCTION.');
        say('');
        say('  ' + loc.at + ' = "production"   read from ' + args.deployment);
        say('  url        ' + where);
        if (project) say('  project    ' + project);
        say('');
        say('  THIS HAS ALREADY HAPPENED. It is not a warning about a future step.');
        say('  The most likely cause is that this was the project\'s FIRST deployment:');
        say('  Vercel assigns the first one to production regardless of flags, so');
        say('  `vercel --yes` produced a production deploy and a public alias.');
        say('');
        say('  To undo:');
        say('    first deployment of a NEW project — remove the project outright');
        say('      vercel remove ' + (project || '<project>') + ' --yes');
        say('    a project that already had production traffic — put the old one back');
        say('      vercel rollback');
        say('  Pick by whether ANY earlier production deployment exists (`vercel ls`).');
        say('  `vercel rollback` cannot undo a first deployment: there is nothing behind it.');
        say('');
        say('  Then check what was uploaded, which is a separate defect:');
        say('    node ' + path.basename(__filename) + ' --ignore-file <deployed-dir>');
        return 1;
    }

    // intent=production, actual=preview. Not a disclosure, but the deploy the
    // caller thinks they made does not exist, which is its own incident class:
    // a merged change sitting undeployed reads as shipped.
    say('REFUSED  PRODUCTION WAS INTENDED AND THIS DEPLOY IS A PREVIEW.');
    say('');
    say('  ' + loc.at + ' = null   read from ' + args.deployment);
    say('  url        ' + where);
    say('');
    say('  Nothing is live. Promote with `vercel --prod --yes`, or correct the');
    say('  intent if a preview was what you meant.');
    return 1;
}

// ------------------------------------------------------- the ignore subcommand

// Pattern lines only: strip comments and blanks. Trailing slashes are dropped so
// `.claude/` and `.claude` count as the same coverage.
function readPatterns(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/);
    const patterns = lines
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => l.replace(/\/+$/, ''));
    return { raw, lineCount: lines.length, patterns };
}

function covers(patterns, entry) {
    return patterns.some((p) => {
        const q = p.replace(/^\/+/, '');
        return q === entry || q === entry + '/**' || q === '*';
    });
}

function runIgnore(args) {
    const dir = path.resolve(args.dir || process.cwd());
    let stat;
    try {
        stat = fs.statSync(dir);
    } catch (e) {
        say('INDETERMINATE  could not stat ' + dir + ': ' + e.message);
        say('  Nothing was scanned.');
        return 2;
    }
    if (!stat.isDirectory()) {
        say('INDETERMINATE  ' + dir + ' is not a directory. Nothing was scanned.');
        return 2;
    }

    const file = path.join(dir, '.vercelignore');
    if (!fs.existsSync(file)) {
        say('REFUSED  NO .vercelignore IN ' + dir);
        say('');
        say('  The Vercel CLI does not read .gitignore. Without a .vercelignore,');
        say('  every file in this directory is uploaded — including the ones git');
        say('  ignores. With no framework detected Vercel sets the output directory');
        say('  to "." and SERVES THE TREE STATICALLY, so an uploaded file is a');
        say('  publicly fetchable URL.');
        say('');
        say('  Measured 2026-09-08 on an accidental deploy of a repo worktree:');
        say('    423 tracked files and 16 gitignored files uploaded');
        say('    curl /.claude/settings.local.json  ->  HTTP 200');
        say('    curl /                             ->  HTTP 404');
        say('');
        say('  Create ' + file + ' covering at least:');
        for (const e of IGNORE_FLOOR) say('    ' + e + '/');
        say('  plus everything this repo\'s .gitignore names. Note that matching');
        say('  .gitignore is a FLOOR, not the rule: a file can be tracked and still');
        say('  be one you would never serve.');
        return 1;
    }

    let parsed;
    try {
        parsed = readPatterns(file);
    } catch (e) {
        say('INDETERMINATE  could not read ' + file + ': ' + e.message);
        return 2;
    }

    // Population floor: an EMPTY .vercelignore excludes nothing, and its mere
    // existence is exactly what a presence check would have accepted.
    if (parsed.patterns.length === 0) {
        say('REFUSED  ' + file + ' HAS NO PATTERNS (' + parsed.lineCount + ' line(s), all blank or comments).');
        say('');
        say('  An empty .vercelignore excludes nothing. The file existing is not the');
        say('  protection; the patterns in it are.');
        say('  Add at least: ' + IGNORE_FLOOR.map((e) => e + '/').join(' '));
        return 1;
    }

    const missing = IGNORE_FLOOR.filter((e) => !covers(parsed.patterns, e));
    if (missing.length) {
        say('REFUSED  ' + file + ' DOES NOT COVER ' + missing.length + ' REQUIRED ENTRY(S).');
        say('');
        say('  scanned    ' + file + ' — ' + parsed.patterns.length + ' pattern(s)');
        say('  missing    ' + missing.map((e) => e + '/').join(' '));
        say('');
        say('  Each of these is uploaded and served on a deploy from this directory.');
        say('  Add them and re-run.');
        return 1;
    }

    say('OK  ' + file + ' — ' + parsed.patterns.length + ' pattern(s), all ' + IGNORE_FLOOR.length + ' required entries covered.');
    say('  covered: ' + IGNORE_FLOOR.map((e) => e + '/').join(' '));
    say('  This is a FLOOR, not a guarantee. It does not know what else this');
    say('  particular tree holds that should never be served.');
    return 0;
}

// ---------------------------------------------------------------------- main

function main(argv) {
    const args = parseArgs(argv);
    if (args.mode === 'help' || args.mode === null) {
        say(USAGE);
        if (args.bad) { say(''); say('Unrecognised argument: ' + args.bad); return 2; }
        return args.mode === 'help' ? 0 : 2;
    }
    if (args.bad) {
        say('INDETERMINATE  unrecognised argument: ' + args.bad);
        say('');
        say(USAGE);
        return 2;
    }
    return args.mode === 'deployment' ? runDeployment(args) : runIgnore(args);
}

let code;
try {
    code = main(process.argv.slice(2));
} catch (e) {
    say('INDETERMINATE  check-deploy-target.js threw: ' + (e && e.message));
    say('  Nothing was checked. This is NOT a passing deploy.');
    code = 2;
}
flush();
// process.exitCode, never process.exit(): on macOS stdout to a PIPE is async and
// process.exit() truncates a pending write at the 64KiB buffer while still
// exiting 0. See CLAUDE.md.
process.exitCode = code;
