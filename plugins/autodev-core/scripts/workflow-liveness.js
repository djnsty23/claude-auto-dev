#!/usr/bin/env node
/**
 * Is each scheduled thing still RUNNING, as opposed to still passing?
 *
 * `[measured 2026-08-25]` Every scheduled workflow across three repos stopped on
 * 2026-08-21 and nothing said so for four days. A production error monitor on a
 * 15-minute cron ran zero times. The reason nothing noticed is structural:
 *
 *   `gh run list` returns runs that HAPPENED. A job that is never scheduled
 *   produces no row at all, so the repo reads as quiet rather than as broken,
 *   and quiet is indistinguishable from healthy.
 *
 * That inverts the usual intuition. The failing runs were the harmless ones,
 * because a failure still creates a row a person can see. The damaging failure
 * emitted nothing at all. So the question this asks is not "are runs failing"
 * but "when did this last run, against how often it claims to run".
 *
 * THREE SUBJECT KINDS, because a loop can live in three places:
 *
 *   --repo owner/name           GitHub Actions workflows carrying a cron
 *   --log  label=path=minutes   anything whose file mtime advances when it runs:
 *                               an append-only history log, a report, an artifact
 *   --task name=minutes         a Windows scheduled task
 *
 * The `--log` form is the portable one and covers loops that live nowhere a
 * platform API can see them. It reads MTIME rather than parsing timestamps out
 * of the file, because a log written by `cmd` carries a locale-formatted date
 * that differs between machines, and a parser that silently fails on an
 * unfamiliar format would report NEVER RAN for a healthy job.
 *
 * ON TASKS, ATTENDANCE ONLY, NEVER SUCCESS. `[measured 2026-08-25]` a task whose
 * script exits 1 still reports `LastTaskResult=0`, because it is launched via
 * `wscript.exe` and that returns its own status rather than the child's. So a
 * monitor keyed on LastTaskResult would show a permanently green job that is in
 * fact reporting a finding every single day. This reads LastRunTime and nothing
 * else.
 *
 * Deliberate choices, each one a rule this repo already learned the hard way:
 *
 *  - An UNPARSEABLE cron or spec reports UNKNOWN and never healthy. Letting a
 *    state you failed to anticipate fall through to fine is how startup_failure
 *    hid an outage across three merges.
 *  - NO RUNS AT ALL is its own verdict. "Never ran" and "ran and is current"
 *    are opposite facts that would otherwise both produce an empty overdue list.
 *  - Every run prints the population it scanned.
 *  - A missing prerequisite is COULD NOT CHECK, never a pass.
 *
 * Exit codes: 0 all current, 1 something overdue or never-run, 2 the check
 * itself could not run.
 *
 * Usage:
 *   node workflow-liveness.js --repo owner/name [--repo owner/name ...]
 *   node workflow-liveness.js --log monitor=C:/path/history.log=15
 *   node workflow-liveness.js --task SpotiviblyTypesDrift=1440
 *   node workflow-liveness.js --selftest
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const args = process.argv.slice(2);

function many(flag) {
    const out = [];
    for (let i = 0; i < args.length - 1; i++) if (args[i] === flag) out.push(args[i + 1]);
    return out;
}

function one(flag, dflt) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

/**
 * Shortest interval a 5-field cron can fire at, in minutes.
 *
 * Returns null for anything not confidently understood. null means UNKNOWN and
 * is never treated as healthy: a cron shape this cannot read is a cron whose
 * liveness cannot be judged, and saying so is the whole point of the field.
 */
function cronIntervalMinutes(expr) {
    const f = String(expr || '').trim().split(/\s+/);
    if (f.length !== 5) return null;
    const min = f[0], hour = f[1], dom = f[2], mon = f[3], dow = f[4];

    const stepOf = (field) => {
        const m = /^(?:\*|[0-9-]+)\/(\d+)$/.exec(field);
        return m ? Number(m[1]) : null;
    };
    const listLen = (field) => {
        if (field === '*') return null;
        if (!/^[0-9]+(,[0-9]+)*$/.test(field)) return null;
        return field.split(',').length;
    };

    const minStep = stepOf(min);
    if (minStep) return minStep;

    const minCount = listLen(min);
    if (minCount === null) return null;

    const hourStep = stepOf(hour);
    if (hourStep) return hourStep * 60;

    if (hour === '*') return Math.max(1, Math.floor(60 / minCount));

    const hourCount = listLen(hour);
    if (hourCount === null) return null;

    const perDay = minCount * hourCount;
    const daily = dom === '*' && mon === '*' && dow === '*';
    const weekly = dom === '*' && mon === '*' && /^[0-9]+(,[0-9]+)*$/.test(dow);
    if (daily) return Math.floor(1440 / perDay);
    if (weekly) {
        const days = listLen(dow) || 1;
        return Math.floor((10080 / days) / perDay);
    }
    return null;
}

/**
 * Parse `label=value=minutes` or `name=minutes`.
 *
 * Returns null on anything malformed rather than guessing. A spec this cannot
 * read must not silently become a subject with a fabricated interval, because a
 * fabricated interval turns a dead job into a live-looking one.
 */
function parseSpec(raw, wantPath) {
    const s = String(raw || '');
    const parts = s.split('=');
    const need = wantPath ? 3 : 2;
    if (parts.length !== need) return null;
    const minutes = Number(parts[need - 1]);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const label = parts[0].trim();
    if (!label) return null;
    if (!wantPath) return { label: label, minutes: minutes };
    const p = parts[1].trim();
    if (!p) return null;
    return { label: label, path: p, minutes: minutes };
}

function schedulesFromYaml(text) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
        const m = /^\s*-?\s*cron:\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
        if (m) out.push(m[1].trim());
    }
    return out;
}

function ghJson(argv) {
    return JSON.parse(execFileSync('gh', argv, { encoding: 'utf8', maxBuffer: 1 << 24 }));
}

function ghAvailable() {
    try {
        execFileSync('gh', ['--version'], { encoding: 'utf8' });
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: String((e && e.message) || e).split('\n')[0] };
    }
}

// First line only, and capped. A diagnostic that dumps a whole command line
// pushes the verdict off the row it belongs to, which is how a real finding
// gets skimmed past.
const shortReason = (e) => {
    const first = String((e && e.message) || e).split(/\r?\n/)[0].trim();
    return first.length > 80 ? first.slice(0, 77) + '...' : first;
};

// ---------------------------------------------------------------------------
// subject kind 1: GitHub Actions workflows
// ---------------------------------------------------------------------------
function collectRepos(repos, tolerance, rows, pop) {
    if (!repos.length) return;
    const probe = ghAvailable();
    if (!probe.ok) {
        pop.notes.push('COULD NOT CHECK - ' + repos.length + ' repo(s): gh is unavailable: ' + probe.reason);
        pop.blind += repos.length;
        return;
    }
    for (const repo of repos) {
        let workflows;
        try {
            workflows = ghJson(['api', 'repos/' + repo + '/actions/workflows', '--jq', '.workflows']);
        } catch (e) {
            pop.notes.push('COULD NOT CHECK - ' + repo + ': ' + shortReason(e));
            pop.blind++;
            continue;
        }
        for (const wf of workflows || []) {
            pop.seen++;
            let yaml = '';
            try {
                const b64 = execFileSync('gh',
                    ['api', 'repos/' + repo + '/contents/' + wf.path, '--jq', '.content'],
                    { encoding: 'utf8' });
                yaml = Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
            } catch (e) {
                rows.push({ subject: repo + '  ' + wf.name, verdict: 'UNKNOWN',
                    detail: 'workflow file unreadable, so its schedule is unknown' });
                continue;
            }

            const crons = schedulesFromYaml(yaml);
            if (!crons.length) continue;   // not scheduled: out of scope, not passing
            pop.scheduled++;

            if (wf.state !== 'active') {
                rows.push({ subject: repo + '  ' + wf.name, verdict: 'DISABLED',
                    detail: wf.state + ', so it is not expected to run' });
                continue;
            }

            let last = null;
            try {
                const runs = ghJson(['run', 'list', '--repo', repo,
                    '--workflow', wf.path.split('/').pop(),
                    '--limit', '1', '--json', 'createdAt,conclusion']);
                if (runs && runs.length) last = runs[0];
            } catch (e) { /* falls through to NEVER RAN, reported as such */ }

            if (!last) {
                rows.push({ subject: repo + '  ' + wf.name, verdict: 'NEVER RAN',
                    detail: 'no runs returned at all, which is not the same as up to date' });
                continue;
            }

            const ageMin = (Date.now() - Date.parse(last.createdAt)) / 60000;
            const known = crons.map(cronIntervalMinutes).filter((x) => x !== null);
            if (!known.length) {
                rows.push({ subject: repo + '  ' + wf.name, verdict: 'UNKNOWN',
                    detail: 'cron not read (' + crons.join(' | ') + '), last run ' +
                        Math.round(ageMin) + 'm ago, liveness NOT judged' });
                continue;
            }
            const interval = Math.min.apply(null, known);
            rows.push(judge(repo + '  ' + wf.name, ageMin, interval, tolerance));
        }
    }
}

// ---------------------------------------------------------------------------
// subject kind 2: anything whose mtime advances when it runs
// ---------------------------------------------------------------------------
function collectLogs(specs, tolerance, rows, pop) {
    for (const raw of specs) {
        const spec = parseSpec(raw, true);
        if (!spec) {
            rows.push({ subject: String(raw).slice(0, 40), verdict: 'UNKNOWN',
                detail: 'spec not understood, expected label=path=intervalMinutes' });
            pop.seen++;
            continue;
        }
        pop.seen++;
        pop.scheduled++;
        let st;
        try {
            st = fs.statSync(spec.path);
        } catch (e) {
            rows.push({ subject: spec.label, verdict: 'NEVER RAN',
                detail: 'no file at ' + spec.path + ', so nothing has ever written it' });
            continue;
        }
        const ageMin = (Date.now() - st.mtimeMs) / 60000;
        rows.push(judge(spec.label, ageMin, spec.minutes, tolerance));
    }
}

// ---------------------------------------------------------------------------
// subject kind 3: Windows scheduled tasks. ATTENDANCE ONLY.
// ---------------------------------------------------------------------------
function collectTasks(specs, tolerance, rows, pop) {
    if (!specs.length) return;
    if (process.platform !== 'win32') {
        pop.notes.push('COULD NOT CHECK - ' + specs.length + ' task(s): scheduled tasks are Windows-only, this is ' + process.platform);
        pop.blind += specs.length;
        return;
    }
    for (const raw of specs) {
        const spec = parseSpec(raw, false);
        if (!spec) {
            rows.push({ subject: String(raw).slice(0, 40), verdict: 'UNKNOWN',
                detail: 'spec not understood, expected name=intervalMinutes' });
            pop.seen++;
            continue;
        }
        pop.seen++;
        pop.scheduled++;
        let out;
        try {
            // LastRunTime and State only. LastTaskResult is deliberately NOT read:
            // a task launched through wscript reports the launcher's status, not
            // the script's, so it says 0 while the work reports a finding.
            out = execFileSync('powershell', ['-NoProfile', '-Command',
                "$ErrorActionPreference='Stop';" +
                "$t=Get-ScheduledTask -TaskName '" + spec.label.replace(/'/g, "''") + "';" +
                "$i=$t | Get-ScheduledTaskInfo;" +
                "$t.State.ToString() + '|' + $i.LastRunTime.ToString('o')"],
                // stderr is captured rather than inherited. PowerShell's own error
                // text would otherwise print above this tool's report and bury the
                // verdict it belongs to.
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            // MISSING, not UNKNOWN. A task named here that does not exist is a
            // misconfiguration, and this whole tool exists because a subject that
            // silently is not there reads exactly like one that is fine. UNKNOWN is
            // reserved for a subject that EXISTS and whose cadence cannot be read.
            rows.push({ subject: spec.label, verdict: 'MISSING',
                detail: 'no such task: ' + shortReason(e) });
            continue;
        }
        const parts = String(out).trim().split('|');
        const state = parts[0] || '';
        const lastMs = Date.parse(parts[1] || '');
        if (state === 'Disabled') {
            rows.push({ subject: spec.label, verdict: 'DISABLED',
                detail: 'task is disabled, so it is not expected to run' });
            continue;
        }
        if (!Number.isFinite(lastMs) || lastMs <= 0) {
            rows.push({ subject: spec.label, verdict: 'NEVER RAN',
                detail: 'no LastRunTime, so the task has never actually fired' });
            continue;
        }
        rows.push(judge(spec.label, (Date.now() - lastMs) / 60000, spec.minutes, tolerance));
    }
}

function judge(subject, ageMin, interval, tolerance) {
    const limit = interval * tolerance;
    return {
        subject: subject,
        verdict: ageMin > limit ? 'OVERDUE' : 'ok',
        detail: 'every ~' + interval + 'm, last run ' + Math.round(ageMin) +
            'm ago (limit ' + Math.round(limit) + 'm)',
    };
}

function report(repos, logs, tasks, tolerance) {
    const rows = [];
    const pop = { seen: 0, scheduled: 0, blind: 0, notes: [] };

    collectRepos(repos, tolerance, rows, pop);
    collectLogs(logs, tolerance, rows, pop);
    collectTasks(tasks, tolerance, rows, pop);

    // MISSING is fatal alongside OVERDUE and NEVER RAN. A subject that is named
    // and absent is a misconfiguration, and the whole premise here is that a thing
    // which silently is not there looks identical to a thing that is fine.
    //
    // UNKNOWN is deliberately NOT fatal. It means the subject exists and only its
    // cadence could not be read, and making that red would leave the check
    // permanently red for any monthly cron. A permanently red gate gets muted, and
    // a muted gate is worse than a loud unjudgeable row.
    const FATAL = ['OVERDUE', 'NEVER RAN', 'MISSING'];
    const bad = rows.filter((r) => FATAL.indexOf(r.verdict) >= 0);
    const unknown = rows.filter((r) => r.verdict === 'UNKNOWN');
    const okRows = rows.filter((r) => r.verdict === 'ok');
    const disabled = rows.filter((r) => r.verdict === 'DISABLED');

    console.log('population: ' + repos.length + ' repo(s), ' + logs.length + ' log(s), ' +
        tasks.length + ' task(s) asked for; ' + pop.seen + ' subject(s) seen, ' +
        pop.scheduled + ' carrying a schedule, ' + pop.blind + ' UNCHECKABLE');
    console.log('tolerance: overdue past ' + tolerance + 'x the stated interval');
    for (const n of pop.notes) console.log('  ' + n);
    console.log('');
    for (const r of rows) console.log('  ' + r.verdict.padEnd(10) + r.subject.padEnd(46) + r.detail);
    console.log('');
    const missing = rows.filter((r) => r.verdict === 'MISSING').length;
    console.log(bad.length + ' overdue, never-run or missing (' + missing + ' missing), ' +
        unknown.length + ' unjudgeable, ' + okRows.length + ' current, ' +
        disabled.length + ' disabled, ' + pop.blind + ' uncheckable');
    if (unknown.length) console.log('An unjudgeable row is NOT a passing row. Read its schedule.');

    if (!rows.length && pop.blind) return 2;   // nothing could be read at all
    return bad.length ? 1 : 0;
}

function selftest() {
    const cronCases = [
        ['*/15 * * * *', 15],
        ['*/5 * * * *', 5],
        ['*/15 5-19 * * *', 15],
        ['0 */6 * * *', 360],
        ['35 6 * * *', 1440],
        ['20 6 * * *', 1440],
        ['0 17 * * *', 1440],
        ['30 5,10,17 * * *', 480],
        ['0 5 * * 1', 10080],
        ['0 0 1 * *', null],
        ['0 5-9 * * *', null],
        ['nonsense', null],
        ['', null],
        ['* * * *', null],
    ];
    let fail = 0;
    for (const c of cronCases) {
        const got = cronIntervalMinutes(c[0]);
        const ok = got === c[1];
        if (!ok) fail++;
        console.log((ok ? 'ok   ' : 'FAIL ') + JSON.stringify(c[0]).padEnd(20) +
            ' got ' + String(got).padEnd(8) + ' want ' + String(c[1]));
    }

    const found = schedulesFromYaml([
        'on:', '  schedule:', '    - cron: "*/15 * * * *"', "    - cron: '0 5 * * 1'", '  push:',
    ].join('\n'));
    const extractOk = JSON.stringify(found) === JSON.stringify(['*/15 * * * *', '0 5 * * 1']);
    if (!extractOk) fail++;
    console.log((extractOk ? 'ok   ' : 'FAIL ') + 'schedulesFromYaml'.padEnd(20) + ' got ' + JSON.stringify(found));

    // A malformed spec must yield null, never a subject with a guessed interval.
    const specCases = [
        ['mon=C:/x/y.log=15', true, { label: 'mon', path: 'C:/x/y.log', minutes: 15 }],
        ['mon=C:/x/y.log', true, null],
        ['mon=C:/x/y.log=0', true, null],
        ['mon=C:/x/y.log=abc', true, null],
        ['=C:/x/y.log=15', true, null],
        ['TaskName=1440', false, { label: 'TaskName', minutes: 1440 }],
        ['TaskName', false, null],
        ['TaskName=-5', false, null],
        ['', false, null],
    ];
    for (const c of specCases) {
        const got = parseSpec(c[0], c[1]);
        const ok = JSON.stringify(got) === JSON.stringify(c[2]);
        if (!ok) fail++;
        console.log((ok ? 'ok   ' : 'FAIL ') + ('parseSpec ' + JSON.stringify(c[0])).padEnd(34) +
            ' got ' + JSON.stringify(got));
    }

    // judge() is the whole verdict, so pin both sides of the boundary.
    const judgeCases = [
        [10, 15, 2, 'ok'],
        [29, 15, 2, 'ok'],
        [31, 15, 2, 'OVERDUE'],
        [5000, 1440, 2, 'OVERDUE'],
    ];
    for (const c of judgeCases) {
        const got = judge('x', c[0], c[1], c[2]).verdict;
        const ok = got === c[3];
        if (!ok) fail++;
        console.log((ok ? 'ok   ' : 'FAIL ') + ('judge age=' + c[0] + ' every=' + c[1]).padEnd(34) +
            ' got ' + got.padEnd(9) + ' want ' + c[3]);
    }

    const total = cronCases.length + 1 + specCases.length + judgeCases.length;
    console.log('');
    console.log(total + ' cases, ' + fail + ' failed');
    return fail ? 1 : 0;
}

if (args.includes('--selftest')) process.exit(selftest());

const repos = many('--repo');
const logs = many('--log');
const tasks = many('--task');
if (!repos.length && !logs.length && !tasks.length) {
    console.log('usage: node workflow-liveness.js [--repo owner/name] [--log label=path=minutes] [--task name=minutes] [--tolerance N]');
    console.log('       node workflow-liveness.js --selftest');
    console.log('');
    console.log('  --repo  GitHub Actions workflows carrying a cron');
    console.log('  --log   anything whose file mtime advances when it runs');
    console.log('  --task  a Windows scheduled task (attendance only, never success)');
    process.exit(2);
}
process.exit(report(repos, logs, tasks, Number(one('--tolerance', '2')) || 2));
