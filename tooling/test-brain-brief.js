#!/usr/bin/env node
// Tests for plugins/autodev-core/scripts/brain-brief.js — the overseer's opening
// report. Run: node tooling/test-brain-brief.js
// Exits 1 on any failure; 0 if all pass.
//
// WHY THIS SUITE EXISTS, AND WHAT IT REFUSES TO ASSERT.
//
// brain-brief is a report, not a gate. Its one contract is that silence must
// never read as "nothing there": every section prints the population it scanned
// and every section distinguishes a REAL ZERO ("gh answered and there are no
// open PRs") from a BLIND SPOT ("gh was never asked"). A degraded section that
// renders as an all-clear is the failure this file is here to catch, because an
// overseer session opens on this output and acts on it.
//
// So the assertions come in PAIRS wherever the distinction exists. Asserting
// only the "COULD NOT CHECK" half would pass just as well against a script that
// prints COULD NOT CHECK unconditionally, and asserting only the zero half would
// pass against one that never checks anything. Neither half is evidence alone.
//
// Everything is driven as a SUBPROCESS against a temp fixture: a fake HOME
// (transcripts, handoffs, config), real throwaway git repos, and a stub `gh`.
// Nothing here reads this machine's live transcripts, sessions, repos or PRs —
// a suite that did would go green on a busy day and red on a quiet one, which is
// the same defect it is testing for.
//
// THE `gh` STUB. execFile() resolves a bare command name against PATH and, on
// Windows, will not run a .cmd or .bat shim, so a stub has to be a real
// executable. It is a copy of node itself named `gh`: `gh --version` becomes
// `node --version` (exits 0, which is all the probe needs), and
// `gh pr list ...` becomes `node pr list ...`, which runs a CommonJS file named
// `pr` from the working directory. Deleting that file is how a scenario makes
// the per-repo gh call FAIL rather than return an empty list — the two must not
// print the same thing, and that is asserted below.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_DIR = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const SUBJECT = path.join(SCRIPT_DIR, 'brain-brief.js');
const THIN = '-'.repeat(78);

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`);
}

/** Assert a literal string is present in some captured text. */
function hasText(label, text, needle) {
    check(label, text.includes(needle), 'missing: ' + JSON.stringify(needle));
}
/** Assert a literal string is ABSENT — the half that catches a blind spot rendering as a zero. */
function lacksText(label, text, needle) {
    check(label, !text.includes(needle), 'unexpectedly present: ' + JSON.stringify(needle));
}
function matches(label, text, re) {
    check(label, re.test(text), 'no match for ' + re + ' in ' + JSON.stringify(text.slice(0, 400)));
}

/**
 * Slice one numbered section out of the report. Section-scoped assertions matter
 * because "COULD NOT CHECK" appears in several places and a global substring
 * search cannot tell which section was blind.
 */
function section(text, title) {
    const i = text.indexOf('\n' + title);
    if (i < 0) return '';
    const rest = text.slice(i + 1);
    const head = rest.indexOf('\n' + THIN);
    if (head < 0) return rest;
    const body = rest.slice(head + 1 + THIN.length);
    const end = body.search(/\n(?:-{78}|={78})/);
    return end < 0 ? body : body.slice(0, end);
}

// ---------------------------------------------------------------------------
// fixture construction
// ---------------------------------------------------------------------------

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-brief-'));
const IS_WIN = process.platform === 'win32';

function git(args, cwd) {
    const r = spawnSync('git', [
        '-c', 'user.email=fixture@example.invalid',
        '-c', 'user.name=Fixture',
        '-c', 'commit.gpgsign=false',
        ...args,
    ], { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error('fixture git ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout || r.error));
    }
    return (r.stdout || '').trim();
}

/**
 * A throwaway repo whose origin is a GitHub URL (so the PR path is exercised)
 * but whose remote-tracking ref is written by hand — no network, no second
 * clone. `dirty` decides whether it carries work: two local-only commits, one
 * commit that exists only on origin, and a working tree with one staged, one
 * modified and two untracked files. That yields exactly ahead 2 / behind 1 /
 * untracked 2, which is what pins the porcelain parser.
 */
function buildRepo(root, dirty) {
    fs.mkdirSync(root, { recursive: true });
    git(['init', '-b', 'main', '.'], root);
    git(['remote', 'add', 'origin', 'https://github.com/example/brain-brief-fixture.git'], root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
    git(['add', 'a.txt'], root);
    git(['commit', '-m', 'A'], root);
    const a = git(['rev-parse', 'HEAD'], root);
    git(['update-ref', 'refs/remotes/origin/main', a], root);
    git(['branch', '--set-upstream-to=origin/main', 'main'], root);
    if (!dirty) return;

    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], root); git(['commit', '-m', 'B'], root);
    fs.writeFileSync(path.join(root, 'c.txt'), 'c\n');
    git(['add', 'c.txt'], root); git(['commit', '-m', 'C'], root);

    git(['checkout', '-q', '-b', 'tmp', a], root);
    fs.writeFileSync(path.join(root, 'd.txt'), 'd\n');
    git(['add', 'd.txt'], root); git(['commit', '-m', 'D'], root);
    const d = git(['rev-parse', 'HEAD'], root);
    git(['update-ref', 'refs/remotes/origin/main', d], root);
    git(['checkout', '-q', 'main'], root);
    git(['branch', '-D', 'tmp'], root);

    fs.appendFileSync(path.join(root, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(root, 'staged.txt'), 's\n');
    git(['add', 'staged.txt'], root);
    fs.writeFileSync(path.join(root, 'u1.txt'), 'u\n');
    fs.writeFileSync(path.join(root, 'u2.txt'), 'u\n');
}

const DIRTY_REPO = path.join(ROOT, 'fixture-repo-dirty');
const CLEAN_REPO = path.join(ROOT, 'fixture-repo-clean');
buildRepo(DIRTY_REPO, true);
buildRepo(CLEAN_REPO, false);

// A repo dirty in exactly the same way as DIRTY_REPO, differing ONLY in when its
// dirty files were last touched. `git status` cannot tell the two apart - that is
// the whole point - so the report has to, and the pair is what proves it read an
// mtime rather than printing a constant. [measured 2026-08-27] a worktree with 11
// modified files all dated 87 days back was reported upward as live uncommitted
// work; it had been abandoned since May and had become a merge hazard.
const STALE_REPO = path.join(ROOT, 'fixture-repo-stale');
buildRepo(STALE_REPO, true);
{
    const old = (Date.now() - 90 * 86400 * 1000) / 1000;
    for (const f of ['a.txt', 'staged.txt', 'u1.txt', 'u2.txt']) {
        fs.utimesSync(path.join(STALE_REPO, f), old, old);
    }
}
// A fetch age the report can name. The dirty repo deliberately has none, so the
// UNKNOWN branch is exercised too.
{
    const fh = path.join(CLEAN_REPO, '.git', 'FETCH_HEAD');
    fs.writeFileSync(fh, '');
    const t = (Date.now() - 3 * 3600 * 1000) / 1000;
    fs.utimesSync(fh, t, t);
}

/**
 * A COPY of the shipped brain-brief.js, planted beside a fleet-overlap.js that
 * refuses to run. That is how the `!r.ok` branch of the overlap child is reached
 * without touching plugins/.
 *
 * brain-brief resolves BOTH its siblings off its own __dirname - fleet-status.js
 * for the transcript parse and fleet-overlap.js for the scoring - so the
 * directory a copy sits in IS the seam, and the real fleet-status has to travel
 * with it (together with fleet-heartbeat.js, which fleet-status itself requires
 * off __dirname) or section 1 goes blind for the wrong reason.
 *
 * The stub mirrors what the real fleet-overlap.js does when its own child fails:
 * the COULD NOT CHECK block on STDOUT, exit 2. So this exercises the exact shape
 * production emits, and the assertions can check that brain-brief neither
 * swallows it nor renders that stdout as a scoring result.
 *
 * Earlier this was forced by pointing USERPROFILE at a home with no
 * claude-auto-dev in it, back when fleet-overlap hardcoded an absolute path
 * under USERPROFILE. That path was a production defect and is gone; copying the
 * subject replaces the seam without asking plugins/ to carry a test-only
 * override.
 */
function briefWithFailingOverlap() {
    const dir = path.join(ROOT, 'subject-overlap-fails');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['brain-brief.js', 'fleet-status.js', 'fleet-heartbeat.js']) {
        fs.copyFileSync(path.join(SCRIPT_DIR, f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, 'fleet-overlap.js'), [
        "'use strict';",
        "process.stdout.write('COULD NOT CHECK overlap - fleet-status did not run\\n');",
        "process.stdout.write('  This is NOT \"no overlapping pairs\". Nothing was scanned.\\n');",
        'process.exit(2);',
        '',
    ].join('\n'));
    return path.join(dir, 'brain-brief.js');
}
const BRIEF_OVERLAP_FAILS = briefWithFailingOverlap();

// The stub gh, plus per-scenario working directories that decide what it prints.
const GH_BIN = path.join(ROOT, 'ghbin');
fs.mkdirSync(GH_BIN);
const GH_EXE = path.join(GH_BIN, 'gh' + (IS_WIN ? '.exe' : ''));
fs.copyFileSync(process.execPath, GH_EXE);
if (!IS_WIN) fs.chmodSync(GH_EXE, 0o755);

function workDir(name, prJson) {
    const d = path.join(ROOT, 'work-' + name);
    fs.mkdirSync(d, { recursive: true });
    if (prJson !== null) {
        fs.writeFileSync(path.join(d, 'pr'),
            'process.stdout.write(' + JSON.stringify(JSON.stringify(prJson)) + " + '\\n');\n");
    }
    return d;
}

function pr(number, extra) {
    return Object.assign({
        number,
        title: 'fixture pull request ' + number,
        headRefName: 'feat/pr-' + number,
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        updatedAt: '2026-08-24T09:00:00Z',
        url: 'https://github.com/example/brain-brief-fixture/pull/' + number,
        author: { login: 'fixture' },
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }, extra);
}

/** A fake HOME: transcript root, handoff dir, repo config. */
function makeHome(name, opts) {
    const home = path.join(ROOT, 'home-' + name);
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    if (opts.memoryDir) fs.mkdirSync(path.join(home, 'claude-memory'), { recursive: true });
    for (const f of opts.memoryFiles || []) {
        const p = path.join(home, 'claude-memory', f.name);
        fs.writeFileSync(p, f.body || '# fixture handoff\n');
        if (f.ageHours != null) {
            const t = (Date.now() - f.ageHours * 3600 * 1000) / 1000;
            fs.utimesSync(p, t, t);
        }
    }
    if (opts.config !== undefined) {
        fs.writeFileSync(path.join(home, '.claude', 'brain-brief.json'), opts.config);
    }
    for (const t of opts.transcripts || []) {
        const dir = path.join(home, '.claude', 'projects', t.project);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, t.id + '.jsonl'), t.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
    return home;
}

/**
 * One session transcript. `answered` decides whether the panel it raised is
 * still blocking — the pending/answered pair is what separates "1 blocked" from
 * "none blocked, out of N scanned", and both readings must be reachable.
 */
function transcript(id, cwd, branch, opts) {
    const o = opts || {};
    const lines = [{
        type: 'user', cwd, sessionId: id, gitBranch: branch,
        timestamp: '2026-08-24T09:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'start' }] },
    }];
    if (o.panel) {
        lines.push({
            type: 'assistant', cwd, sessionId: id, gitBranch: branch,
            timestamp: '2026-08-24T09:01:00.000Z',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use', id: 'toolu_' + id, name: 'AskUserQuestion',
                    input: {
                        questions: [{
                            question: 'Ship the fixture change?',
                            header: 'Ship',
                            multiSelect: false,
                            options: [
                                { label: 'Ship it now', description: 'd' },
                                { label: 'Hold for review', description: 'd' },
                            ],
                        }],
                    },
                }],
            },
        });
        if (o.answered) {
            lines.push({
                type: 'user', cwd, sessionId: id, gitBranch: branch,
                timestamp: '2026-08-24T09:02:00.000Z',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + id, content: 'Ship it now' }] },
            });
        }
    }
    return { id, project: o.project || 'proj', lines };
}

/**
 * PATH entries with no `gh` in them. Built by REMOVING every directory that
 * holds a gh executable, so gh is absent by construction rather than by hoping
 * this machine has none. git has to survive that removal for the scenario to
 * mean anything, which is why it is asserted as a control before it is used.
 */
function pathWithoutGh() {
    const exts = IS_WIN ? ['.exe', '.cmd', '.bat', '.com'] : [''];
    return (process.env.PATH || '').split(path.delimiter).filter(Boolean).filter((d) => {
        return !exts.some((e) => {
            try { return fs.statSync(path.join(d, 'gh' + e)).isFile(); } catch { return false; }
        });
    }).join(path.delimiter);
}

function runBrief(opts) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!/^(PATH|USERPROFILE|HOME|APPDATA|AUTODEV_FLEET_DIR)$/i.test(k)) env[k] = v;
    }
    env.PATH = opts.path;
    env.USERPROFILE = opts.home;
    env.HOME = opts.home;
    env.APPDATA = path.join(opts.home, 'AppData');
    env.AUTODEV_FLEET_DIR = path.join(opts.home, '.claude', 'fleet');
    const r = spawnSync(process.execPath, [opts.subject || SUBJECT, ...(opts.args || [])], {
        cwd: opts.cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const WITH_GH = GH_BIN + path.delimiter + (process.env.PATH || '');

try {
    // -----------------------------------------------------------------------
    // control: gh really is absent from the reduced PATH, and git really is not
    // -----------------------------------------------------------------------
    const NO_GH = pathWithoutGh();
    {
        const g = spawnSync('git', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: NO_GH } });
        check('control: git survives the gh-free PATH', g.status === 0,
            'git is unreachable once every gh-bearing directory is dropped, so the '
            + 'gh-absent scenario below cannot run on this machine');
        const h = spawnSync('gh', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: NO_GH } });
        check('control: gh really is gone from that PATH', h.error != null && h.error.code === 'ENOENT',
            'gh still resolved: ' + (h.error ? h.error.code : 'status ' + h.status));
    }

    // -----------------------------------------------------------------------
    // A. the full report: stale handoff, a live fleet, PRs, dirty worktree.
    //
    // This is the only scenario that does not pass --no-overlap, so it is the
    // one that drives the overlap child. It runs the COPY planted above, whose
    // fleet-overlap.js sibling always fails - the report must carry that failure
    // through to the reader rather than quietly dropping the section.
    // -----------------------------------------------------------------------
    const homeA = makeHome('a', {
        memoryDir: true,
        memoryFiles: [{ name: 'HANDOFF-2020-01-02.md', ageHours: 100 }],
        config: JSON.stringify({ repos: [DIRTY_REPO] }),
        transcripts: [
            transcript('11111111-1111-1111-1111-111111111111', DIRTY_REPO, 'feat/x', { panel: true }),
            transcript('22222222-2222-2222-2222-222222222222', DIRTY_REPO, 'feat/x', {}),
        ],
    });
    const workA = workDir('a', [
        pr(11, { statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'WOBBLE' }] }),
        pr(12, { statusCheckRollup: null }),
        pr(13, { statusCheckRollup: [], mergeable: 'UNKNOWN' }),
        pr(14, { statusCheckRollup: [{ conclusion: 'STARTUP_FAILURE' }, { conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }] }),
        pr(15, { isDraft: true, mergeable: 'CONFLICTING', statusCheckRollup: [{ conclusion: '' }, {}] }),
    ]);
    const A = runBrief({
        home: homeA, cwd: workA, path: WITH_GH, args: [], subject: BRIEF_OVERLAP_FAILS,
    });

    check('A: a full report exits 0', A.status === 0, 'exit ' + A.status + ' stderr ' + A.stderr.slice(0, 200));
    hasText('A: prints the closing population reminder', A.stdout,
        'Every section above prints the population it scanned.');

    // freshness header — a handoff past the trust window must be disowned by name
    hasText('A: names the newest handoff when none is dated today', A.stdout, '(no handoff dated today)');
    matches('A: renders an over-48h age in days as well as hours', A.stdout, /\d+h old \(\d+\.\d+ days\)/);
    matches('A: warns that a stale handoff is not to be trusted', A.stdout,
        /THAT HANDOFF IS [\d.]+h OLD\. DO NOT TRUST ITS VOLATILE SECTIONS\./);
    lacksText('A: does not also claim the handoff is inside the trust window', A.stdout,
        'Under the 4h trust window');

    // section 1 — population first, then the blocked panel
    const a1 = section(A.stdout, '1. FLEET');
    hasText('A: fleet population names transcripts, dirs and the window', a1,
        'population: 2 transcripts in 1 project dirs (last 2d), 2 live (<24h), 0 cold');
    hasText('A: counts the blocked session in the population line', a1, '1 blocked on an unanswered panel');
    hasText('A: counts sessions that have ever raised a panel', a1, '1 have ever raised a panel');
    check('A: breaks live sessions down by state', a1.includes('blocked 1') && a1.includes('working 1'),
        'live-by-state line was: ' + JSON.stringify((a1.match(/ live by state: .*/) || [''])[0]));
    hasText('A: reports the blocked count against the scanned denominator', a1,
        'BLOCKED ON A PANEL: 1 of 2 live sessions.');
    hasText('A: echoes the unanswered question itself', a1, '? Ship the fixture change?');
    hasText('A: echoes the options the session is waiting on', a1, '- Ship it now');
    hasText('A: says plainly when a blocked session cannot be messaged', a1,
        'NOT ADDRESSABLE - cannot be messaged');
    hasText('A: prints the stalled count even when it is zero', a1,
        'STALLED (running, addressable, quiet 15-240m): 0');
    lacksText('A: a scanned fleet is not reported as unscanned', a1, 'VACUOUS, not reassuring');

    // section 2 — ownership, and the collision that matters
    const a2 = section(A.stdout, '2. OWNERSHIP');
    hasText('A: ownership population names live sessions, repos and unresolved roots', a2,
        'population: 2 live sessions across 1 repo(s), 0 whose git root could not be resolved');
    hasText('A: groups both sessions under the one repo', a2, 'fixture-repo-dirty  (2 sessions)');
    hasText('A: flags two sessions sharing one branch', a2, 'feat/x  <-- 2 SESSIONS ON ONE BRANCH');
    hasText('A: a failed overlap child is reported, not swallowed', a2,
        'COULD NOT CHECK - overlap scoring (same branch / same repo / same topic)');
    hasText('A: says what survives when only the scoring is missing', a2,
        'The branch listing above still stands - only the SCORING is missing.');
    // The reason has to carry the child's own exit status, or every different
    // way the child can fail renders as one indistinguishable message.
    matches('A: names the exit status the overlap child failed with', a2, /reason: exit 2:/);
    lacksText('A: a failed child\'s stdout is never rendered as a scoring result', a2,
        'overlap scoring (from fleet-overlap.js');

    // repo set
    hasText('A: repo set counts what sections 3 and 4 will cover', A.stdout, 'population: 1 repo(s) discovered');
    hasText('A: reports the config file it read and what was present', A.stdout, ': 1 listed, 1 present');
    // Name and provenance must stay on ONE line. Asserting the exact spacing
    // instead would make every column-width change look like a lost attribution.
    matches('A: attributes the repo to the session cwd that revealed it', A.stdout,
        /^ +- fixture-repo-dirty .*\[session cwd\]/m);
    matches('A: dates each repo so the panel can be ordered by recency', A.stdout,
        /^ +- fixture-repo-dirty .*(since last commit|last commit UNREADABLE)/m);
    hasText('A: says which order the repo set is in', A.stdout,
        'sorted: most recently worked on first');
    hasText('A: counts session cwds it could resolve to a git root', A.stdout,
        'session cwds resolved to a git root: 1 of 1');
    hasText('A: names a directory it was asked about and could not use', A.stdout,
        'NOT COVERED - asked for but unusable:');

    // section 3 — the rollup polarity, which is the whole point of that function
    const a3 = section(A.stdout, '3. OPEN PRs');
    hasText('A: PR population separates queried from unqueryable repos', a3,
        'population: 1 repo(s) discovered, 1 queried successfully, 0 COULD NOT BE CHECKED, 5 open PR(s) found');
    hasText('A: echoes the gh it actually ran', a3, '  gh: ');
    hasText('A: an unrecognised check state is named and counted as not-passed', a3,
        'checks: 2 pass, 1 UNRECOGNISED (WOBBLE) - counted as not-passed');
    hasText('A: an unrecognised state never inflates the pass tally', a3, '2 pass, 1 UNRECOGNISED');
    hasText('A: a null rollup is not the same as passing', a3,
        'checks: NO CHECKS REPORTED (null rollup - not the same as passing)');
    hasText('A: an empty rollup is not the same as passing', a3,
        'checks: 0 checks reported (not the same as passing)');
    hasText('A: a completed-but-failed run counts as FAIL, not as noise', a3,
        'checks: 1 pass, 1 FAIL, 1 pending');
    hasText('A: a blank check state counts as unrecognised, not as benign', a3,
        'checks: 0 pass, 2 UNRECOGNISED ((empty)) - counted as not-passed');
    hasText('A: an uncomputed mergeable state says so rather than guessing', a3,
        'mergeable UNKNOWN (GitHub has not computed it)');
    hasText('A: marks a draft PR', a3, '#15 [DRAFT]  CONFLICTING');
    lacksText('A: a repo with PRs is not reported as an empty one', a3, 'none open. This is a real zero');

    // section 4 — the porcelain parse
    const a4 = section(A.stdout, '4. UNCOMMITTED AND UNPUSHED');
    hasText('A: work population separates carrying, clean and unreadable worktrees', a4,
        '1 carrying uncommitted or unpushed work, 0 clean and pushed, 0 UNREADABLE');
    hasText('A: names the branch and its upstream', a4, '[main -> origin/main]');
    hasText('A: counts commits ahead of upstream from porcelain', a4, '2 ahead of upstream');
    hasText('A: counts commits behind upstream from porcelain', a4, '1 behind upstream');
    hasText('A: counts untracked files from porcelain', a4, '2 untracked');
    hasText('A: counts staged entries from porcelain', a4, '1 staged');
    hasText('A: counts unstaged modifications from porcelain', a4, '1 modified');
    hasText('A: counts commits no origin ref can reach', a4,
        '2 commit(s) unreachable from any origin ref (CONTENT NOT CHECKED)');
    hasText('A: a clone that never fetched says UNKNOWN rather than zero', a4,
        'last fetch UNKNOWN (no FETCH_HEAD)');
    lacksText('A: a dirty repo is not reported as clean', a4, 'all clean and pushed');
    // The FRESH half of the abandoned-tree pair. Scenario H holds the stale half;
    // neither is evidence alone, because a script that never labels anything
    // abandoned passes this one and a script that labels everything passes that.
    matches('A: a freshly edited dirty tree reports its edit age with the files read', a4,
        /last edited \d+m ago \(4 of 4 read\)/);
    lacksText('A: a freshly edited tree is not called abandoned', a4, 'LIKELY ABANDONED');
    hasText('A: the derelict count is a real zero when every dirty tree is live', a4,
        'of those, 0 last edited over 30d ago');

    // -----------------------------------------------------------------------
    // B. the quiet machine: every zero must carry its denominator
    // -----------------------------------------------------------------------
    const homeB = makeHome('b', {
        memoryDir: true,
        memoryFiles: [{ name: 'notes.md' }, { name: 'RESUME.md' }],
        transcripts: [],
    });
    const workB = workDir('b', []);
    const B = runBrief({
        home: homeB, cwd: workB, path: WITH_GH,
        args: ['--no-overlap', '--days', '5', '--repo', CLEAN_REPO],
    });

    check('B: a machine with nothing on it still exits 0', B.status === 0,
        'exit ' + B.status + ' stderr ' + B.stderr.slice(0, 200));
    hasText('B: no handoff is a counted zero, not a blind spot', B.stdout,
        'handoff: NONE FOUND - 0 files matching HANDOFF-*.md');
    hasText('B: says how many entries it looked through to find none', B.stdout,
        'entries scanned, directory readable)');
    lacksText('B: a readable but empty handoff dir is not a COULD NOT CHECK', B.stdout,
        'COULD NOT CHECK - handoff document age');

    const b1 = section(B.stdout, '1. FLEET');
    hasText('B: honours a custom --days window in the population line', b1,
        'population: 0 transcripts in 0 project dirs (last 5d)');
    hasText('B: a scan that found nothing says so rather than reading as calm', b1,
        'the scan found 0 project dirs and 0 transcripts');
    hasText('B: names the window in the explanation of the empty scan', b1, 'no session has run in 5d');
    hasText('B: calls the sections below it vacuous, not reassuring', b1,
        'Everything below in sections 1 and 2 is therefore VACUOUS, not reassuring.');
    lacksText('B: an unscanned fleet never prints a blocked-count all-clear', b1, 'BLOCKED ON A PANEL: none');

    const b2 = section(B.stdout, '2. OWNERSHIP');
    hasText('B: zero live sessions is reported as unattributable, not as free branches', b2,
        'COULD NOT CHECK - ownership - 0 live sessions were available to attribute');
    hasText('B: spells out that no branch is being claimed free', b2,
        'do not take that as "every branch is free"');
    hasText('B: reports the skipped overlap scoring as skipped', b2, 'overlap scoring: SKIPPED (--no-overlap)');

    hasText('B: an absent config names the path that would fix it', B.stdout, 'no config at ');
    hasText('B: a repo given on the command line is attributed to the flag', B.stdout, '[--repo flag]');

    const b3 = section(B.stdout, '3. OPEN PRs');
    hasText('B: an answered query with no PRs is called a real zero', b3,
        'none open. This is a real zero: gh answered.');
    hasText('B: counts zero open PRs against a queried repo', b3,
        '1 queried successfully, 0 COULD NOT BE CHECKED, 0 open PR(s) found');
    lacksText('B: a real zero is not dressed up as a blind spot', b3, 'Nothing was asked.');

    const b4 = section(B.stdout, '4. UNCOMMITTED AND UNPUSHED');
    hasText('B: a clean worktree is a read zero, not an unread one', b4,
        'all clean and pushed. A real zero: every worktree was read.');
    hasText('B: counts the clean worktree in the population', b4,
        '0 carrying uncommitted or unpushed work, 1 clean and pushed');
    hasText('B: reports how long ago the clone last fetched', b4, 'last fetch 3h ago');

    // -----------------------------------------------------------------------
    // C1. a handoff path that points at nothing — absent file, not absent handoff
    // -----------------------------------------------------------------------
    const homeC = makeHome('c', { memoryDir: false, config: '{ this is not json' });
    const workC = workDir('c', null);
    const C1 = runBrief({
        home: homeC, cwd: workC, path: WITH_GH,
        args: ['--no-overlap', '--handoff', path.join(ROOT, 'no-such-handoff.md')],
    });

    check('C1: a bad --handoff path still exits 0', C1.status === 0,
        'exit ' + C1.status + ' stderr ' + C1.stderr.slice(0, 200));
    hasText('C1: a missing handoff file is a COULD NOT CHECK', C1.stdout,
        'COULD NOT CHECK - handoff document age');
    hasText('C1: names the file it could not find', C1.stdout, 'file not found: ');
    hasText('C1: refuses to read one absent file as no handoff existing', C1.stdout,
        'This is not "no handoff exists"');
    lacksText('C1: does not report a zero handoff count it never measured', C1.stdout,
        'handoff: NONE FOUND');

    hasText('C1: an unparseable config says so instead of reading as empty', C1.stdout, 'COULD NOT READ config ');
    hasText('C1: with no repos discovered, PRs are unchecked rather than absent', section(C1.stdout, '3. OPEN PRs'),
        'COULD NOT CHECK - open PRs');
    hasText('C1: with no repos discovered, uncommitted work is unchecked rather than absent',
        section(C1.stdout, '4. UNCOMMITTED AND UNPUSHED'), 'COULD NOT CHECK - uncommitted work');
    hasText('C1: reports zero repos as a discovered population', C1.stdout, 'population: 0 repo(s) discovered');

    // -----------------------------------------------------------------------
    // C2. no handoff directory at all — unreadable, which is a third state again
    // -----------------------------------------------------------------------
    const C2 = runBrief({ home: homeC, cwd: workC, path: WITH_GH, args: ['--no-overlap'] });
    check('C2: an unreadable handoff directory still exits 0', C2.status === 0,
        'exit ' + C2.status + ' stderr ' + C2.stderr.slice(0, 200));
    hasText('C2: an unreadable handoff directory is a COULD NOT CHECK', C2.stdout,
        'COULD NOT CHECK - handoff document age');
    matches('C2: names the directory and the errno', C2.stdout, /reason: cannot read .*claude-memory \(ENOENT\)/);
    hasText('C2: tells the reader their carried-in facts are unverified', C2.stdout,
        'Treat every volatile claim you carry in from anywhere as UNVERIFIED.');
    lacksText('C2: an unreadable directory is never reported as an empty one', C2.stdout,
        'handoff: NONE FOUND');

    // -----------------------------------------------------------------------
    // D. gh absent — the whole PR section is blind, and must say so
    // -----------------------------------------------------------------------
    const homeD = makeHome('d', {
        memoryDir: true,
        config: JSON.stringify({
            repos: [DIRTY_REPO, CLEAN_REPO, path.join(ROOT, 'no-such-repo')],
            retired: [CLEAN_REPO],
        }),
    });
    const workD = workDir('d', null);
    const D = runBrief({ home: homeD, cwd: workD, path: NO_GH, args: ['--no-overlap'] });

    check('D: a missing gh does not change the exit status', D.status === 0,
        'exit ' + D.status + ' stderr ' + D.stderr.slice(0, 200));
    const d3 = section(D.stdout, '3. OPEN PRs');
    hasText('D: reports the whole PR section as unchecked, with a repo count', d3,
        'COULD NOT CHECK - open PRs in all 1 repo(s)');
    hasText('D: names the reason as gh not being on PATH', d3, "gh: 'gh' not found on PATH");
    hasText('D: refuses to let a missing gh read as no open PRs', d3,
        'NOT "there are no open PRs". Nothing was asked.');
    lacksText('D: never prints a real-zero claim it did not earn', d3, 'This is a real zero: gh answered.');

    hasText('D: a configured repo that is not on disk is named as missing', D.stdout, ', MISSING: ');
    hasText('D: attributes a repo found only through the config file', D.stdout, '[config]');

    // A retired repo is excluded ON PURPOSE, so it must be NAMED as retired and
    // must not reach the sections that cover work. Dropping it silently would
    // leave a reader unable to tell a decision from a config edited by accident.
    hasText('D: says a retired repo was excluded deliberately', D.stdout,
        'RETIRED - excluded on purpose by config. This is a decision, not a gap:');
    hasText('D: names the retired repo rather than dropping it', D.stdout, '~ fixture-repo-clean');
    hasText('D: counts the retired repo in the config note', D.stdout, '1 retired (named below, not a gap)');
    hasText('D: a retired repo does not inflate the covered population', D.stdout,
        'population: 1 repo(s) discovered');
    const d4 = section(D.stdout, '4. UNCOMMITTED AND UNPUSHED');
    hasText('D: a blind PR section does not stop the git section from running', d4, '2 ahead of upstream');
    lacksText('D: a retired repo is never scanned for work', d4, 'fixture-repo-clean');

    // -----------------------------------------------------------------------
    // E. gh present but the per-repo call fails — one repo blind, not zero PRs
    // -----------------------------------------------------------------------
    const workE = workDir('e', null);   // no `pr` file, so `gh pr list` exits non-zero
    const E = runBrief({
        home: homeD, cwd: workE, path: WITH_GH, args: ['--no-overlap'],
    });
    check('E: a failing gh call does not change the exit status', E.status === 0,
        'exit ' + E.status + ' stderr ' + E.stderr.slice(0, 200));
    const e3 = section(E.stdout, '3. OPEN PRs');
    hasText('E: a repo whose gh call failed is counted as unchecked', e3,
        '0 queried successfully, 1 COULD NOT BE CHECKED, 0 open PR(s) found');
    hasText('E: names the repo that could not be checked', e3, 'COULD NOT CHECK - open PRs for fixture-repo-dirty');
    lacksText('E: a failed query is never rendered as an empty one', e3, 'none open. This is a real zero');

    // -----------------------------------------------------------------------
    // F. a fresh handoff, an ANSWERED panel, and a gh call that times out
    // -----------------------------------------------------------------------
    const today = new Date();
    const stamp = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0')
        + '-' + String(today.getDate()).padStart(2, '0');
    const homeF = makeHome('f', {
        memoryDir: true,
        memoryFiles: [{ name: 'HANDOFF-' + stamp + '.md', ageHours: 0 }],
        config: JSON.stringify({ repos: [CLEAN_REPO] }),
        transcripts: [transcript('33333333-3333-3333-3333-333333333333', CLEAN_REPO, 'main',
            { panel: true, answered: true })],
    });
    const workF = workDir('f', [pr(21, {})]);
    const F = runBrief({
        home: homeF, cwd: workF, path: WITH_GH, args: ['--no-overlap', '--gh-timeout', '1'],
    });

    check('F: a timed-out gh call does not change the exit status', F.status === 0,
        'exit ' + F.status + ' stderr ' + F.stderr.slice(0, 200));
    hasText('F: uses the handoff dated today when one exists', F.stdout, "today's dated handoff");
    hasText('F: a fresh handoff is described as inside the trust window', F.stdout,
        'Under the 4h trust window');
    lacksText('F: a fresh handoff is not also disowned as stale', F.stdout,
        'DO NOT TRUST ITS VOLATILE SECTIONS');

    const f1 = section(F.stdout, '1. FLEET');
    hasText('F: an answered panel leaves nobody blocked, against a stated denominator', f1,
        'BLOCKED ON A PANEL: none, out of 1 live sessions scanned.');
    hasText('F: still counts the session as having raised a panel', f1, '1 have ever raised a panel');
    hasText('F: counts zero blocked in the population line', f1, '0 blocked on an unanswered panel');

    const f3 = section(F.stdout, '3. OPEN PRs');
    matches('F: a gh timeout is reported as a timeout, never as an empty result', f3,
        /COULD NOT CHECK - open PRs for [\s\S]*?reason: TIMED OUT after 1ms \(gh pr list\)/);
    hasText('F: a timed-out repo is counted as unchecked, not as zero PRs', f3,
        '0 queried successfully, 1 COULD NOT BE CHECKED, 0 open PR(s) found');
    lacksText('F: a timeout is never rendered as a real zero', f3, 'none open. This is a real zero');

    // -----------------------------------------------------------------------
    // G. --help is a documentation path, not a scan
    // -----------------------------------------------------------------------
    const G = runBrief({ home: homeF, cwd: workF, path: WITH_GH, args: ['--help'] });
    check('G: --help exits 0', G.status === 0, 'exit ' + G.status);
    hasText('G: --help prints the usage block', G.stdout, '--no-overlap');
    lacksText('G: --help does not run the scan', G.stdout, '1. FLEET - who is alive');

    // -----------------------------------------------------------------------
    // H. a derelict tree and a live one are both "dirty" to git
    //
    // STALE_REPO is byte-for-byte the same shape as DIRTY_REPO; only the mtimes
    // differ. So every assertion here that scenario A's fresh half does not also
    // make would pass against a script that hardcodes the label.
    // -----------------------------------------------------------------------
    const homeH = makeHome('h', {
        memoryDir: true,
        config: JSON.stringify({ repos: [STALE_REPO] }),
        transcripts: [],
    });
    const workH = workDir('h', []);
    const H = runBrief({ home: homeH, cwd: workH, path: WITH_GH, args: ['--no-overlap'] });
    const h4 = section(H.stdout, '4. UNCOMMITTED AND UNPUSHED');
    check('H: exits 0 on a derelict tree', H.status === 0, 'exit ' + H.status);
    matches('H: a 90-day-old dirty tree reports its age in days', h4,
        /last edited (89|90|91)d ago \(4 of 4 read\)/);
    hasText('H: and is called out as derelict rather than in flight', h4,
        'LIKELY ABANDONED, not in flight');
    hasText('H: the derelict count separates it from the carrying count', h4,
        'of those, 1 last edited over 30d ago');
    // It is still dirty. The label reframes the work; it must not hide it.
    hasText('H: a derelict tree is still counted as carrying work', h4,
        '1 carrying uncommitted or unpushed work');
    lacksText('H: a derelict tree is never reported as clean', h4, 'all clean and pushed');
} finally {
    try {
        fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch (e) {
        console.log('NOTE  fixture cleanup left files behind at ' + ROOT + ': ' + e.message);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
