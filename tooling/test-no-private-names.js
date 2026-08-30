#!/usr/bin/env node
// Tests for check-no-private-names.js, which had no suite of its own despite
// being the gate that keeps private project names and home paths out of a
// PUBLIC repo. It was referenced by test-githooks and test-pre-tool-filter and
// directly covered by neither.
//
// Run: node tooling/test-no-private-names.js
//
// EVERY planted value is DERIVED from os.homedir() at runtime. Nothing here is
// a literal name or a literal home path, for two reasons. The obvious one is
// that a literal secret must not enter a public repo. The less obvious one is
// that this file is itself scanned by the gate it tests, so a realistic literal
// would trip the very pattern under test -- which happened to the fix that
// prompted this suite, in the comment explaining the fix.
//
// The home-path half is reachable ONLY through the full repo sweep. `--check-text`
// runs scanText, which covers names alone, so a test written against that flag
// would pass without exercising any of this.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'tooling', 'check-no-private-names.js');
const PROBE = path.join(ROOT, 'zz-private-names-probe.md');

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

/**
 * Run the real gate over the real tree with one extra untracked file.
 * Untracked-but-not-ignored is deliberate: it is the window a new file passes
 * through, and the gate covers it on purpose.
 *
 * `home` overrides os.homedir() for the child, which is how a build account's
 * name can be simulated without a build account.
 */
function sweepWith(content, home) {
    fs.writeFileSync(PROBE, `# probe\n${content}\n`);
    try {
        const env = { ...process.env };
        if (home) { env.HOME = home; env.USERPROFILE = home; }
        const r = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8', env, cwd: ROOT });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        return { status: r.status, out, namesProbe: out.includes(path.basename(PROBE)) };
    } finally {
        fs.rmSync(PROBE, { force: true });
    }
}

// A home directory whose account name is an ordinary English word, which is
// what a hosted CI runner has. Built under the temp dir so the parent segment
// is real rather than asserted.
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'privnames-'));
const FAKE_HOME = path.join(fakeRoot, 'home', 'runner');
fs.mkdirSync(FAKE_HOME, { recursive: true });

const shapes = (home) => {
    const user = path.basename(home);
    const parent = path.basename(path.dirname(home));
    return { user, parent, home };
};

try {
    // ---------------------------------------------------------------- clean
    {
        const r = sweepWith('nothing sensitive on this line at all', null);
        check('a clean tree with a harmless probe passes', r.status === 0,
            'the tree is not clean to begin with, so nothing below distinguishes anything');
        check('  and it prints the population it scanned', /files read/.test(r.out));
    }

    // ------------------------------------------------- home paths, must fire
    for (const home of [null, FAKE_HOME]) {
        const s = shapes(home || os.homedir());
        const tag = home ? 'simulated build account' : 'this machine';

        const slash = sweepWith(`see ${path.join(s.home, 'code')} for details`, home);
        check(`slash-delimited home path is caught (${tag})`,
            slash.status !== 0 && slash.namesProbe);

        // The dash-encoded spelling, which is how project directories are named.
        // Both platform shapes, because the encoding differs only in the drive.
        const dashWin = sweepWith(`see C--${s.parent}-${s.user}-someproject for details`, home);
        check(`dash-encoded home path is caught, drive shape (${tag})`,
            dashWin.status !== 0 && dashWin.namesProbe);

        const dashNix = sweepWith(`see -${s.parent}-${s.user}-work-repo for details`, home);
        check(`dash-encoded home path is caught, rooted shape (${tag})`,
            dashNix.status !== 0 && dashNix.namesProbe);
    }

    // ------------------------------------------- the false positive, must NOT
    //
    // The regression this suite exists for. When the account name is an ordinary
    // word, a dash pattern anchored only on a leading hyphen matches any
    // identifier containing that word between hyphens. On a hosted runner that
    // made the gate unpassable: it reported findings in files that hold no path
    // at all, every run, forever.
    {
        const s = shapes(FAKE_HOME);
        const r = sweepWith(`a file named test-${s.user}-guard.js in tooling`, FAKE_HOME);
        check('the account name inside an unrelated identifier is NOT a finding',
            r.status === 0,
            'the dash pattern is matching a bare hyphenated word again, which is what '
            + 'made this gate impossible to pass on a hosted runner');
    }

    // The same string with the parent segment in front of it IS a path, and the
    // pair is what proves the narrowing kept its teeth rather than going quiet.
    {
        const s = shapes(FAKE_HOME);
        const r = sweepWith(`a path like x-${s.parent}-${s.user}-guard for details`, FAKE_HOME);
        check('  but the same name behind its parent segment still IS',
            r.status !== 0 && r.namesProbe);
    }
} finally {
    fs.rmSync(PROBE, { force: true });
    fs.rmSync(fakeRoot, { recursive: true, force: true });
}

let pass = 0; let fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (!ok && detail ? '  (' + detail + ')' : ''));
    ok ? pass += 1 : fail += 1;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
