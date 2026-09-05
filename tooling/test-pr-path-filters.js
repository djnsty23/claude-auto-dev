'use strict';
// Suite for plugins/autodev-core/scripts/pr-path-filters.js.
//
// The subject answers WHY a PR's check rollup is empty: every PR-firing
// workflow path-filtered the change out (fine), or a run was due and none
// exists (the outage shape). It reads workflows at a TRUNK REF, so the fixture
// is a real git repo with a real origin/main pointing at synthetic workflows.
//
// Each workflow below is one case, and the changed-file sets are chosen so a
// wrong reading of `paths` versus `paths-ignore` flips the verdict.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'pr-path-filters.js');
const { explainEmptyRollup, globToRe, listUnder, pullRequestBlock } = require(SUBJECT);

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail ? '  (' + detail + ')' : '')); }
}

// ---- the glob subset GitHub uses ------------------------------------------
check('** matches across directories', globToRe('**/*.md').test('design/notes/a.md'));
check('** matches at the root too', globToRe('**/*.md').test('README.md'));
check('* does not cross a slash', !globToRe('docs/*.js').test('docs/lcd/app.js'));
check('docs/lcd/** matches a deep file', globToRe('docs/lcd/**').test('docs/lcd/x/y.js'));
check('a literal dot is not a wildcard', !globToRe('a.js').test('abjs'));

// ---- YAML list extraction, including the comment trap ----------------------
const BLOCK = '    branches:\n      - main\n    paths-ignore:\n      - "state/**"   # runtime data\n      - \'**/*.md\'\n';
check('listUnder reads a quoted, commented list', JSON.stringify(listUnder(BLOCK, 'paths-ignore')) === JSON.stringify(['state/**', '**/*.md']));
check('listUnder returns null for an absent key', listUnder(BLOCK, 'paths') === null);
check('a commented-out paths: line is not a filter',
    pullRequestBlock('on:\n  pull_request:\n    # paths:\n    #   - docs/**\n    branches: [main]\njobs:\n  x: {}\n') !== null
    && listUnder(pullRequestBlock('on:\n  pull_request:\n    # paths:\n    #   - docs/**\n    branches: [main]\njobs:\n  x: {}\n'), 'paths') === null);
check('a workflow with no pull_request trigger yields null', pullRequestBlock('on:\n  push:\n    branches: [main]\njobs:\n  x: {}\n') === null);

// ---- the fixture repo --------------------------------------------------------
function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
const WF = {
    'ignore-md.yml': 'name: ignore-md\non:\n  pull_request:\n    branches:\n      - main\n    paths-ignore:\n      - "**/*.md"\n      - "state/**"\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    'only-lcd.yml': 'name: only-lcd\non:\n  pull_request:\n    branches:\n      - main\n    paths:\n      - "docs/lcd/**"\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    'other-base.yml': 'name: other-base\non:\n  pull_request:\n    branches:\n      - develop\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    'push-only.yml': 'name: push-only\non:\n  push:\n    branches:\n      - main\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
    'unfiltered.yml': 'name: unfiltered\non:\n  pull_request:\n  workflow_dispatch:\njobs:\n  x:\n    runs-on: ubuntu-latest\n',
};

let tmp = null;
try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-path-filters-'));
    git(['init', '-q'], tmp);
    git(['config', 'user.email', 'suite@example.invalid'], tmp);
    git(['config', 'user.name', 'suite'], tmp);
    fs.mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true });
    for (const [n, body] of Object.entries(WF)) fs.writeFileSync(path.join(tmp, '.github', 'workflows', n), body, 'utf8');
    git(['add', '.'], tmp);
    git(['commit', '-q', '-m', 'workflows'], tmp);
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], tmp).trim()], tmp);
} catch (e) { check('the fixture repo could be built', false, String(e.message).slice(0, 160)); tmp = null; }

if (tmp) {
    const byName = (r) => Object.fromEntries(r.workflows.map((w) => [w.name, w]));

    // Docs only: the unfiltered workflow is the one that must catch this.
    const docs = explainEmptyRollup(tmp, 'origin/main', ['README.md', 'design/SWEEP.md'], 'main');
    const d = byName(docs);
    check('population names every workflow file at the trunk', docs.population === 5, String(docs.population));
    check('paths-ignore excludes a docs-only change', d['ignore-md.yml'].wouldRun === false, d['ignore-md.yml'].why);
    check('paths (allow-list) excludes a change matching none of them', d['only-lcd.yml'].wouldRun === false, d['only-lcd.yml'].why);
    check('a branches filter naming another base excludes this PR', d['other-base.yml'].wouldRun === false, d['other-base.yml'].why);
    check('a push-only workflow is not a PR workflow at all', d['push-only.yml'].hasPullRequest === false && d['push-only.yml'].wouldRun === false);
    check('an UNFILTERED pull_request workflow is always due', d['unfiltered.yml'].wouldRun === true, d['unfiltered.yml'].why);
    check('so a docs-only PR in this repo is DUE a run, because of the unfiltered one', docs.anyDue === true,
        'the benign verdict must not be reachable while any workflow has no filter');

    // The same docs-only change with the unfiltered workflow absent: benign.
    fs.unlinkSync(path.join(tmp, '.github', 'workflows', 'unfiltered.yml'));
    git(['add', '-A'], tmp); git(['commit', '-q', '-m', 'drop unfiltered'], tmp);
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], tmp).trim()], tmp);
    const docs2 = explainEmptyRollup(tmp, 'origin/main', ['README.md', 'design/SWEEP.md'], 'main');
    check('with every workflow filtered, a docs-only PR is NOT due: zero runs is legitimate', docs2.anyDue === false);
    check('and the population still counts the four remaining files', docs2.population === 4, String(docs2.population));

    // The known positives: a file that MUST trigger each filtered workflow.
    const lcd = byName(explainEmptyRollup(tmp, 'origin/main', ['docs/lcd/app.js'], 'main'));
    check('a file matching `paths` makes that workflow due', lcd['only-lcd.yml'].wouldRun === true, lcd['only-lcd.yml'].why);
    const code = byName(explainEmptyRollup(tmp, 'origin/main', ['src/app.js'], 'main'));
    check('a file outside `paths-ignore` makes that workflow due', code['ignore-md.yml'].wouldRun === true, code['ignore-md.yml'].why);
    check('a mixed change is due if ANY file escapes the ignore list',
        explainEmptyRollup(tmp, 'origin/main', ['README.md', 'src/app.js'], 'main').anyDue === true);

    // The branches filter, from the other side.
    const dev = byName(explainEmptyRollup(tmp, 'origin/main', ['src/app.js'], 'develop'));
    check('a PR targeting the named base makes the branch-filtered workflow eligible', dev['other-base.yml'].wouldRun === true, dev['other-base.yml'].why);

    // Reads the REF, not the working copy. A NEW uncommitted file cannot prove
    // that, because the name list comes from the ref either way and a subject
    // reading file contents from disk would still never see it. The case that
    // discriminates is a COMMITTED workflow edited on disk: the ref says
    // docs/lcd/**, the working copy says src/**, and only one of them is the
    // filter CI will actually apply.
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'only-lcd.yml'),
        'name: only-lcd\non:\n  pull_request:\n    branches:\n      - main\n    paths:\n      - "src/**"\njobs:\n  x:\n    runs-on: ubuntu-latest\n', 'utf8');
    const refLcd = byName(explainEmptyRollup(tmp, 'origin/main', ['docs/lcd/app.js'], 'main'));
    check('a committed workflow edited on disk is judged by its REF version, not the working copy',
        refLcd['only-lcd.yml'].wouldRun === true, refLcd['only-lcd.yml'].why);
    const wcSrc = byName(explainEmptyRollup(tmp, 'origin/main', ['src/app.js'], 'main'));
    check('and the working-copy filter is NOT applied, so src/ does not make it due',
        wcSrc['only-lcd.yml'].wouldRun === false, wcSrc['only-lcd.yml'].why);
    fs.writeFileSync(path.join(tmp, '.github', 'workflows', 'late.yml'), 'name: late\non:\n  pull_request:\njobs:\n  x:\n    runs-on: ubuntu-latest\n', 'utf8');
    const late = explainEmptyRollup(tmp, 'origin/main', ['README.md'], 'main');
    check('an uncommitted NEW workflow is invisible too', !late.workflows.some((w) => w.name === 'late.yml'));

    // A trunk that does not exist: nothing scanned, and it says so with a zero population.
    const none = explainEmptyRollup(tmp, 'origin/nope', ['README.md'], 'main');
    check('an unresolvable trunk yields an empty population, never a verdict', none.population === 0 && none.anyDue === false);

    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
