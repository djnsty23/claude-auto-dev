#!/usr/bin/env node
'use strict';
/**
 * check-release-lag.js: are plugin fixes sitting on main unreleased?
 *
 * WHY. The plugin cache is keyed on the version number. A fix merged to main
 * reaches no installed session until VERSION moves and a release ships. Plugin
 * fixes sat on main for five days while VERSION stayed put, so every installed
 * session kept running the old hooks, and nothing measured the gap. The version
 * that finally shipped was not tagged either.
 *
 * WHAT IT MEASURES, on the first-parent history of one ref (default
 * origin/main, read locally, so fetch first):
 *   - the last commit that changed VERSION, the bump
 *   - every later commit that touches plugins/
 *   - RED when any of those has a committer date older than --max-age-hours
 *   - RED when the tag v<VERSION at the ref> is missing, locally and on the
 *     remote
 * First parent, so a --no-ff merge of old branch commits counts once, dated
 * by the merge, which is when the fix reached the ref. A fast-forward or a
 * rebase carries no such record, so those commits keep their own committer
 * dates.
 *
 * Exit 0 green, 1 red, 2 indeterminate. Any git failure is a 2. A shallow clone
 * is a 2: its oldest commit looks like the one that added VERSION, so the bump
 * would be misread and the lag would read 0. When the remote cannot be listed
 * and the tag is not present locally, that is a 2 as well, never a pass and
 * never a "missing tag". 2 wins over 1, and every finding still prints. The
 * population prints on every run: whether the history is complete, the bump
 * commit, how many plugin commits followed it, the oldest one's age, and where
 * the tag was found.
 *
 * NOT IN THE GATE, on purpose. A red here says the repo is due a release, which
 * is not a fact about the pull request being gated. It runs as
 * `npm run check:release-lag`.
 */
const { spawnSync } = require('child_process');

const USAGE = 'usage: node tooling/check-release-lag.js [--ref <ref>] [--max-age-hours <n>] [--remote <name>] [--json]\n'
    + 'Red when plugin commits after the last VERSION bump are older than the limit, or when v<VERSION> is untagged.\n'
    + '  --ref            the ref to read, locally (default origin/main, so git fetch first)\n'
    + '  --max-age-hours  the oldest an unreleased plugin commit may be (default 24)\n'
    + '  --remote         where to look for the tag (default origin)\n'
    + '  --json           print one JSON object\n'
    + 'Exit 0 green, 1 red, 2 indeterminate (any git failure, or a shallow clone).';

function parseArgs(argv) {
    const opts = { ref: 'origin/main', maxAgeHours: 24, remote: 'origin', json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--ref' || a === '--remote' || a === '--max-age-hours') {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) return { error: a + ' needs a value' };
            i++;
            if (a === '--ref') opts.ref = v;
            else if (a === '--remote') opts.remote = v;
            else {
                opts.maxAgeHours = Number(v);
                if (!Number.isFinite(opts.maxAgeHours) || opts.maxAgeHours < 0) return { error: '--max-age-hours needs a non-negative number, got ' + v };
            }
        } else return { error: 'unknown argument ' + a };
    }
    return opts;
}

function git(args, timeoutMs) {
    const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs || 30000 });
    const err = r.error ? String(r.error.code || r.error.message) : (r.stderr || '').trim().split('\n')[0];
    return { ok: !r.error && r.status === 0, out: r.stdout || '', err };
}

/** The report for one run. Never throws for a git failure: that is exit 2. */
function measure(opts, nowMs) {
    const report = {
        ref: opts.ref, remote: opts.remote, maxAgeHours: opts.maxAgeHours, shallow: null, version: null, bump: null,
        pluginCommitsSince: null, oldestAgeHours: null, stale: [],
        tag: { name: null, local: null, remote: null, remoteError: null },
        verdict: null, reasons: [], errors: [],
    };
    const finish = () => {
        report.verdict = report.errors.length ? 'indeterminate' : report.reasons.length ? 'red' : 'green';
        return { code: report.errors.length ? 2 : report.reasons.length ? 1 : 0, report };
    };

    const ref = git(['rev-parse', '--verify', '--quiet', opts.ref + '^{commit}']);
    if (!ref.ok) { report.errors.push('could not resolve ' + opts.ref + (ref.err ? ': ' + ref.err : '')); return finish(); }

    const shallow = git(['rev-parse', '--is-shallow-repository']);
    const shallowOut = shallow.out.trim();
    if (!shallow.ok || (shallowOut !== 'true' && shallowOut !== 'false')) {
        report.errors.push('could not tell whether this clone is shallow' + (shallow.ok ? ': git printed ' + JSON.stringify(shallowOut.slice(0, 60)) : shallow.err ? ': ' + shallow.err : ''));
        return finish();
    }
    report.shallow = shallowOut === 'true';
    if (report.shallow) {
        report.errors.push('this clone is shallow, so the oldest commit it holds would read as the VERSION bump and the lag as 0. Run git fetch --unshallow, then re-run');
        return finish();
    }

    const bump = git(['log', '-1', '--first-parent', '--format=%H%x09%ct%x09%s', opts.ref, '--', 'VERSION']);
    if (!bump.ok || !bump.out.trim()) {
        report.errors.push(bump.ok ? 'no commit on ' + opts.ref + ' changed VERSION' : 'git log for VERSION failed: ' + bump.err);
        return finish();
    }
    const [sha, ct, ...subject] = bump.out.trim().split('\t');
    report.bump = { sha, committedAt: new Date(Number(ct) * 1000).toISOString(), subject: subject.join('\t') };

    const version = git(['show', opts.ref + ':VERSION']);
    if (!version.ok || !version.out.trim()) { report.errors.push('could not read VERSION at ' + opts.ref + (version.err ? ': ' + version.err : '')); return finish(); }
    report.version = version.out.trim();

    const since = git(['log', '--first-parent', '--format=%H%x09%ct%x09%s', sha + '..' + opts.ref, '--', 'plugins/']);
    if (!since.ok) { report.errors.push('git log for plugins/ failed: ' + since.err); return finish(); }
    const commits = since.out.split('\n').filter(Boolean).map((line) => {
        const [h, t, ...s] = line.split('\t');
        return { sha: h, committedAt: new Date(Number(t) * 1000).toISOString(), ageHours: (nowMs - Number(t) * 1000) / 3600000, subject: s.join('\t') };
    });
    report.pluginCommitsSince = commits.length;
    if (commits.length) report.oldestAgeHours = Math.round(Math.max(...commits.map((c) => c.ageHours)) * 10) / 10;
    report.stale = commits.filter((c) => c.ageHours > opts.maxAgeHours)
        .map((c) => ({ sha: c.sha, committedAt: c.committedAt, ageHours: Math.round(c.ageHours * 10) / 10, subject: c.subject }));
    if (report.stale.length) {
        report.reasons.push(report.stale.length + ' plugin commit(s) older than ' + opts.maxAgeHours + ' h sit on ' + opts.ref + ' unreleased since the VERSION bump');
    }

    const tagName = 'v' + report.version;
    report.tag.name = tagName;
    const local = git(['tag', '-l', tagName]);
    if (!local.ok) { report.errors.push('git tag -l failed: ' + local.err); return finish(); }
    report.tag.local = local.out.split('\n').map((l) => l.trim()).includes(tagName);
    const remote = git(['ls-remote', '--tags', opts.remote, 'refs/tags/' + tagName], 60000);
    if (remote.ok) report.tag.remote = remote.out.split('\n').some((l) => l.split('\t')[1] === 'refs/tags/' + tagName);
    else report.tag.remoteError = remote.err || 'git ls-remote failed';

    if (!report.tag.local && report.tag.remote === null) {
        report.errors.push('could not list tags on ' + opts.remote + ' (' + report.tag.remoteError + ') and ' + tagName + ' is not present locally');
    } else if (!report.tag.local && !report.tag.remote) {
        report.reasons.push('tag ' + tagName + ' is missing, locally and on ' + opts.remote);
    }
    return finish();
}

function render(result) {
    const r = result.report;
    const lines = ['check-release-lag: ref ' + r.ref + ', VERSION ' + (r.version || '(unread)')];
    lines.push('  history: ' + (r.shallow === null ? '(not checked)' : r.shallow ? 'shallow clone, incomplete' : 'complete'));
    lines.push('  bump commit: ' + (r.bump ? r.bump.sha.slice(0, 7) + ' ' + r.bump.committedAt + ' "' + r.bump.subject + '"' : '(not found)'));
    lines.push('  plugin commits since the bump: ' + (r.pluginCommitsSince === null ? '(not measured)' : r.pluginCommitsSince)
        + (r.oldestAgeHours === null ? '' : ', oldest ' + r.oldestAgeHours + ' h') + ' (limit ' + r.maxAgeHours + ' h)');
    let tag = '(not checked)';
    if (r.tag.name) {
        const remote = r.tag.remote === null ? 'unreadable (' + r.tag.remoteError + ')' : r.tag.remote ? 'present' : 'absent';
        tag = r.tag.name + ': local ' + (r.tag.local ? 'present' : 'absent') + ', ' + r.remote + ' ' + remote;
    }
    lines.push('  tag ' + tag);
    lines.push('verdict: ' + r.verdict.toUpperCase());
    for (const e of r.errors) lines.push('  INDETERMINATE: ' + e);
    for (const x of r.reasons) lines.push('  RED: ' + x);
    for (const s of r.stale.slice(0, 10)) lines.push('    ' + s.sha.slice(0, 7) + ' ' + s.ageHours + ' h old "' + s.subject + '"');
    if (r.stale.length > 10) lines.push('    ... and ' + (r.stale.length - 10) + ' more');
    return lines.join('\n');
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(USAGE);
    } else {
        const opts = parseArgs(argv);
        if (opts.error) {
            process.stderr.write(opts.error + '\n' + USAGE + '\n');
            process.exitCode = 2;
        } else {
            const result = measure(opts, Date.now());
            process.stdout.write((opts.json ? JSON.stringify(result.report, null, 2) : render(result)) + '\n');
            process.exitCode = result.code;
        }
    }
}

module.exports = { measure, parseArgs };
