#!/usr/bin/env node
/**
 * Is each scheduled workflow still RUNNING, as opposed to still passing?
 *
 * `[measured 2026-08-25]` Every scheduled workflow across three repos stopped on
 * 2026-08-21 and nothing said so for four days. A production error monitor on a
 * 15-minute cron ran zero times. The reason nothing noticed is structural:
 *
 *   `gh run list` returns runs that HAPPENED. A job that was never scheduled
 *   produces no row at all, so the repo reads as quiet rather than as broken,
 *   and quiet is indistinguishable from healthy.
 *
 * That inverts the usual intuition. The failing runs were the harmless ones,
 * because a failure still creates a row somebody can see. The damaging failure
 * emitted nothing at all. So the question this asks is not "are runs failing"
 * but "when did this workflow last run, against how often it claims to run".
 *
 * Deliberate choices, each one a rule this repo already learned the hard way:
 *
 *  - An UNPARSEABLE cron reports UNKNOWN and never healthy. Letting a state you
 *    failed to anticipate fall through to fine is how startup_failure hid an
 *    outage across three merges.
 *  - A workflow with NO RUNS AT ALL is its own outcome, not a zero. "Never ran"
 *    and "ran and is current" are opposite facts that both produce an empty
 *    overdue list.
 *  - Every section prints the population it scanned, so a clean report is
 *    distinguishable from a probe that found nothing.
 *  - gh missing is COULD NOT CHECK, never a pass.
 *
 * Usage:
 *   node workflow-liveness.js --repo owner/name [--repo owner/name ...]
 *   node workflow-liveness.js --repo owner/name --tolerance 3
 *   node workflow-liveness.js --selftest
 */

'use strict';

const { execFileSync } = require('child_process');

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

    // Sub-hourly: a step in the minute field wins outright.
    const minStep = stepOf(min);
    if (minStep) return minStep;

    const minCount = listLen(min);
    if (minCount === null) return null;      // a range or mixed form: not read

    // Hourly: a step in the hour field.
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
    return null;                              // monthly and stranger: not read
}

/**
 * Pull the cron lines out of a workflow file.
 *
 * A real YAML parse is not worth a dependency here. A cron this misses surfaces
 * as "not scheduled" or UNKNOWN, both of which are the safe direction: neither
 * one reports a dead workflow as live.
 */
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

function report(repos, toleranceIntervals) {
    const probe = ghAvailable();
    if (!probe.ok) {
        console.log('COULD NOT CHECK - gh is unavailable: ' + probe.reason);
        console.log('That is not a pass. Nothing was asked.');
        return 1;
    }

    const rows = [];
    let seen = 0, scheduled = 0, unreadable = 0;

    for (const repo of repos) {
        let workflows;
        try {
            workflows = ghJson(['api', 'repos/' + repo + '/actions/workflows', '--jq', '.workflows']);
        } catch (e) {
            console.log('COULD NOT CHECK - ' + repo + ': ' + String((e && e.message) || e).split('\n')[0]);
            unreadable++;
            continue;
        }

        for (const wf of workflows || []) {
            seen++;
            let yaml = '';
            try {
                const b64 = execFileSync('gh',
                    ['api', 'repos/' + repo + '/contents/' + wf.path, '--jq', '.content'],
                    { encoding: 'utf8' });
                yaml = Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
            } catch (e) {
                rows.push({
                    repo: repo, name: wf.name, verdict: 'UNKNOWN',
                    detail: 'workflow file could not be read, so its schedule is unknown',
                });
                continue;
            }

            const crons = schedulesFromYaml(yaml);
            if (!crons.length) continue;   // not scheduled: out of scope rather than passing
            scheduled++;

            if (wf.state !== 'active') {
                rows.push({
                    repo: repo, name: wf.name, verdict: 'DISABLED',
                    detail: wf.state + ', so it is not expected to run',
                });
                continue;
            }

            let last = null;
            try {
                const runs = ghJson(['run', 'list', '--repo', repo,
                    '--workflow', wf.path.split('/').pop(),
                    '--limit', '1', '--json', 'createdAt,conclusion']);
                if (runs && runs.length) last = runs[0];
            } catch (e) { /* falls through to NEVER RAN, which is reported as such */ }

            if (!last) {
                rows.push({
                    repo: repo, name: wf.name, verdict: 'NEVER RAN',
                    detail: 'no runs returned at all, which is not the same as up to date',
                });
                continue;
            }

            const ageMin = (Date.now() - Date.parse(last.createdAt)) / 60000;
            const known = crons.map(cronIntervalMinutes).filter((x) => x !== null);
            if (!known.length) {
                rows.push({
                    repo: repo, name: wf.name, verdict: 'UNKNOWN',
                    detail: 'cron not read (' + crons.join(' | ') + '), last run ' +
                        Math.round(ageMin) + 'm ago, liveness NOT judged',
                });
                continue;
            }

            const interval = Math.min.apply(null, known);
            const limit = interval * toleranceIntervals;
            rows.push({
                repo: repo, name: wf.name,
                verdict: ageMin > limit ? 'OVERDUE' : 'ok',
                detail: 'every ~' + interval + 'm, last run ' + Math.round(ageMin) +
                    'm ago (limit ' + Math.round(limit) + 'm)',
            });
        }
    }

    const bad = rows.filter((r) => r.verdict === 'OVERDUE' || r.verdict === 'NEVER RAN');
    const unknown = rows.filter((r) => r.verdict === 'UNKNOWN');
    const okRows = rows.filter((r) => r.verdict === 'ok');
    const disabled = rows.filter((r) => r.verdict === 'DISABLED');

    console.log('population: ' + repos.length + ' repo(s), ' + unreadable + ' unreadable, ' +
        seen + ' workflow(s) seen, ' + scheduled + ' carrying a cron');
    console.log('tolerance: overdue past ' + toleranceIntervals + 'x the cron interval');
    console.log('');
    for (const r of rows) {
        console.log('  ' + r.verdict.padEnd(10) + (r.repo + '  ' + r.name).padEnd(46) + r.detail);
    }
    console.log('');
    console.log(bad.length + ' overdue or never-run, ' + unknown.length + ' unjudgeable, ' +
        okRows.length + ' current, ' + disabled.length + ' disabled');
    if (unknown.length) console.log('An unjudgeable row is NOT a passing row. Read its cron.');
    return bad.length ? 1 : 0;
}

function selftest() {
    const cases = [
        ['*/15 * * * *', 15],
        ['*/5 * * * *', 5],
        ['*/15 5-19 * * *', 15],
        ['0 */6 * * *', 360],
        ['35 6 * * *', 1440],
        ['20 6 * * *', 1440],
        ['40 6 * * *', 1440],
        ['17 3 * * *', 1440],
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
    for (const c of cases) {
        const got = cronIntervalMinutes(c[0]);
        const ok = got === c[1];
        if (!ok) fail++;
        console.log((ok ? 'ok   ' : 'FAIL ') + JSON.stringify(c[0]).padEnd(20) +
            ' got ' + String(got).padEnd(8) + ' want ' + String(c[1]));
    }

    // The extractor needs its own known-positive, or an empty result would read
    // as "this workflow is not scheduled" for every file it fails to parse.
    const yaml = [
        'on:',
        '  schedule:',
        '    - cron: "*/15 * * * *"',
        "    - cron: '0 5 * * 1'",
        '  push:',
    ].join('\n');
    const found = schedulesFromYaml(yaml);
    const wantFound = ['*/15 * * * *', '0 5 * * 1'];
    const extractOk = JSON.stringify(found) === JSON.stringify(wantFound);
    if (!extractOk) fail++;
    console.log((extractOk ? 'ok   ' : 'FAIL ') + 'schedulesFromYaml'.padEnd(20) +
        ' got ' + JSON.stringify(found));

    console.log('');
    console.log((cases.length + 1) + ' cases, ' + fail + ' failed');
    return fail ? 1 : 0;
}

if (args.includes('--selftest')) process.exit(selftest());

const repos = many('--repo');
if (!repos.length) {
    console.log('usage: node workflow-liveness.js --repo owner/name [--repo owner/name ...] [--tolerance N]');
    console.log('       node workflow-liveness.js --selftest');
    process.exit(2);
}
process.exit(report(repos, Number(one('--tolerance', '2')) || 2));
