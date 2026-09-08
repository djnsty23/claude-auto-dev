#!/usr/bin/env node
// validate.js's hooks-module scan must not report a healthy module as broken on
// a host that prints no component scan.
//
// THE DEFECT. `scanHooksModule` asks `claude plugin validate` to scan the
// plugin and then reads "validation passed, and no `hooks:` line" as proof that
// the `modules` entry was never read. That inference holds only where the host
// PRINTS a component scan. `[measured 2026-09-07, claude 2.1.233]` this host
// prints none — for any plugin, with or without `--strict` — so the check could
// not tell "the module was not read" from "this host reports no components for
// anything", and it announced the first while it had measured the second. The
// FAIL blocked every push from this machine; CI, which never installs `claude`,
// stayed green on `skipped` throughout. Three environments, three answers to one
// question, and only the middle one was about the repo.
//
// THE STUB, and why the suite needs one. Which of those three answers a bare
// `node tooling/validate.js` gives depends entirely on which CLI the machine
// happens to carry, so a suite that used the real one would assert a property of
// the developer's laptop. Every scenario below therefore drives the REAL
// validate.js as a subprocess with a fake `claude` first on PATH, and the stub
// is what makes all three host behaviours reachable on any machine, including
// the two this machine cannot produce.
//
// Both halves are load-bearing and neither is evidence alone. `noscan` alone
// would pass just as well against a check that had simply been deleted;
// `scanned-no-hooks` is the control that keeps the FAIL path reachable, and it
// is the assertion that must stay red if anyone widens the skip.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VALIDATE = path.join(ROOT, 'tooling', 'validate.js');
const IS_WIN = process.platform === 'win32';
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);

// ---------------------------------------------------------------- the stub

// A shebang script plus a .cmd shim, which is the shape npm installs and the
// shape validate.js's `shell: true` spawn is written against. A copy of node
// renamed would not do: this stub has to answer `claude --version` as well,
// and that flag is node's own before it is ever a script's.
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-host-scan-'));
const STUB_JS = path.join(STUB_DIR, 'claude-stub.js');
const MODE_ENV = 'AUTODEV_TEST_CLAUDE_STUB_MODE';

fs.writeFileSync(STUB_JS, `
const mode = process.env[${JSON.stringify(MODE_ENV)}] || 'noscan';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('9.9.9-stub (Claude Code)\\n'); process.exit(0); }
// A shell that cannot find the command prints NOTHING to stdout, so this
// has to run before the Validating line below — emulating the failure
// after announcing a successful start would test a state no shell produces.
if (mode.indexOf('shell-') === 0) {
  // The three ways a shell reports a command it could not find. From
  // validate.js's side these are indistinguishable from the real thing: it
  // sees stdout+stderr and a status, and cannot tell the shell's complaint
  // from the binary's. Emulating them here is what makes the ubuntu and
  // windows cases reachable on a mac.
  const shells = {
    'shell-bash': ['claude: command not found', 127],
    'shell-dash': ['claude: not found', 127],
    'shell-cmd': ["'claude' is not recognized as an internal or external command,", 1],
  };
  const [text, code] = shells[mode];
  process.stderr.write('/bin/sh: ' + text + '\\n');
  process.exit(code);
}
const dir = argv[argv.length - 1];
process.stdout.write('Validating plugin manifest: ' + dir + '/.claude-plugin/plugin.json\\n\\n');
if (mode === 'scan') {
  // What a host that reads the modules entry prints: the module's own hooks
  // and the harness calls it makes.
  process.stdout.write('\\u276f hooks: session.start, prompt.submit, tool.call, attribution.text, turn.complete\\n');
  process.stdout.write('\\u276f calls: $.store, $.session\\n');
} else if (mode === 'warning-named-hooks') {
  // 2.1.233's real diagnostic shape. The bullet is formatted exactly like a
  // scan line, and the field here is literally named hooks.
  process.stdout.write('\\u26a0 Found 2 warnings:\\n\\n');
  process.stdout.write('  \\u276f hooks: Unknown field "hooks". Claude Code ignores it at load time.\\n');
  process.stdout.write('  \\u276f author: No author information provided\\n\\n');
  process.stdout.write('\\u2714 Validation passed with warnings\\n');
  process.exit(0);
} else if (mode === 'scanned-no-hooks') {
  // A host that scans and names components, listing everything EXCEPT hooks.
  // This is the state the FAIL message describes, and the only one it may fire on.
  process.stdout.write('\\u276f skills: 58\\n');
  process.stdout.write('\\u276f agents: 5\\n');
  process.stdout.write('\\u276f commands: 12\\n');
}
// mode 'noscan': the verdict and nothing else, byte-for-byte the shape claude
// 2.1.233 prints for every plugin in this repo.
process.stdout.write('\\u2714 Validation passed\\n');
process.exit(0);
`, 'utf8');

fs.writeFileSync(path.join(STUB_DIR, 'claude'), `#!/usr/bin/env node\nrequire(${JSON.stringify(STUB_JS)});\n`, 'utf8');
fs.chmodSync(path.join(STUB_DIR, 'claude'), 0o755);
fs.writeFileSync(path.join(STUB_DIR, 'claude.cmd'), `@echo off\r\nnode "${STUB_JS}" %*\r\n`, 'utf8');

// ---------------------------------------------------------------- PATH work

const PATH_EXTS = IS_WIN ? ['.exe', '.cmd', '.bat', '.com'] : [''];
const pathDirs = () => String(process.env[PATH_KEY] || '').split(path.delimiter).filter(Boolean);
const holdsClaude = (dir) => PATH_EXTS.some((e) => {
    try { return fs.statSync(path.join(dir, 'claude' + e)).isFile(); } catch { return false; }
});

// The no-CLI scenario removes every directory that HOLDS a claude, rather than
// emptying PATH: validate.js spawns its child checks through node by absolute
// path, but they are entitled to reach for anything else on PATH, and a suite
// that broke those would be measuring the wrong failure.
const PATH_WITHOUT_CLAUDE = pathDirs().filter((d) => !holdsClaude(d)).join(path.delimiter);

// ---------------------------------------------------------------- the runner

function runValidate(mode) {
    const env = { ...process.env };
    // Both scan-bearing modes and the no-scan one put the stub FIRST; the
    // no-CLI one must not see it at all.
    env[PATH_KEY] = mode === 'nocli' ? PATH_WITHOUT_CLAUDE : STUB_DIR + path.delimiter + pathDirs().join(path.delimiter);
    if (mode) env[MODE_ENV] = mode;
    const r = spawnSync(process.execPath, [VALIDATE], { encoding: 'utf8', cwd: ROOT, env });
    const out = (r.stdout || '') + (r.stderr || '');
    return {
        status: r.status,
        out,
        // The one line this suite is about, whatever verdict it carries.
        line: out.split('\n').find((l) => /^\[(PASS|FAIL|WARN)\].*hooks module \.\//.test(l)) || '',
    };
}

// Control, before anything is read from it: the stub is actually being reached.
// Without this every assertion below would also pass against a PATH that never
// resolved `claude` at all, which is a different scenario with a different
// correct answer.
const scan = runValidate('scan');
check('control: the stub is on PATH and its scan reaches validate.js',
    /session\.start, prompt\.submit/.test(scan.line), scan.line || scan.out.slice(-400));

// 1. A host that scans and lists hooks: a pass, carrying the host's own lines.
check('a host that lists the module\'s hooks is a PASS',
    /^\[PASS\]/.test(scan.line) && /scanned by the host/.test(scan.line), scan.line);

// 2. THE REGRESSION. A host that prints no component scan section at all.
//    Before the fix this line read
//      [FAIL] ... validation passed but the scan listed no hooks: the modules
//      entry was not read
//    which is a claim about the module made from a measurement of the host.
const noscan = runValidate('noscan');
check('a host that prints NO component scan does not FAIL the module',
    !/^\[FAIL\]/.test(noscan.line), noscan.line);
check('  and does not claim the modules entry was unread',
    !/modules entry was not read/.test(noscan.out), noscan.line);
check('  it WARNs that the module is unscanned instead',
    /^\[WARN\]/.test(noscan.line) && /NOT scanned/.test(noscan.line), noscan.line);
check('  the reason names the host, so the WARN is actionable',
    /9\.9\.9-stub/.test(noscan.line), noscan.line);
check('  and does not report a pass either — an unscanned module is not a verified one',
    !/^\[PASS\]/.test(noscan.line), noscan.line);
// A no-scan host must cost the gate nothing beyond whatever else was already
// red. Comparing against the scan run's status rather than against 0 keeps this
// assertion about the hooks module even when the tree is dirty for other reasons.
check('  and leaves validate.js\'s exit status where the scanning host left it',
    noscan.status === scan.status, `noscan=${noscan.status} scan=${scan.status}`);

// 3. THE CONTROL FOR THE FIX, and the assertion that must stay red if the skip
//    is ever widened. A host that DID scan, and named components, and still
//    listed no hooks — the state the FAIL message describes. Deleting the check
//    outright would satisfy every assertion above and fail this one.
const nohooks = runValidate('scanned-no-hooks');
check('a host that scanned and listed no hooks still FAILs',
    /^\[FAIL\]/.test(nohooks.line), nohooks.line);
check('  naming the unread modules entry',
    /modules entry was not read/.test(nohooks.line), nohooks.line);
check('  and validate.js exits non-zero on it',
    nohooks.status !== 0, `status=${nohooks.status}`);
// The FAIL must carry its own alternative explanation. A host that scans
// components but has never heard of hooks modules would produce this exact
// output, and that state is unobservable from here — so the message names it
// rather than asserting the module is broken and leaving the reader to find out.
check('  and names the host, so a false alarm is diagnosable from the line',
    /9\.9\.9-stub/.test(nohooks.line), nohooks.line);

// 3b. A DIAGNOSTIC that looks like a scan line. On 2.1.233 a warning bullet is
//     `\u276f <field>: <text>`, the same shape the scan uses, so a plugin.json
//     warning on a field named `hooks` can be mistaken for the host having
//     listed hooks. Reading it that way reports an UNSCANNED module as a PASS,
//     which is the silent direction of this defect and the one worth a suite.
const warned = runValidate('warning-named-hooks');
check('a warning bullet named `hooks:` is not mistaken for a scan',
    !/^\[PASS\]/.test(warned.line), warned.line);
check('  the module stays unverified rather than passing on a diagnostic',
    /^\[WARN\]/.test(warned.line) && /NOT scanned/.test(warned.line), warned.line);
// Control, read from the STUB rather than from validate.js. validate.js never
// echoes the host's raw output — only its own verdict — so asserting against
// that would have been vacuous: it would pass just as well against a stub that
// emitted no bullet at all, making this case a duplicate of `noscan`. Asking
// the stub directly is a known-positive with different provenance.
const stubSaid = spawnSync(path.join(STUB_DIR, IS_WIN ? 'claude.cmd' : 'claude'),
    ['plugin', 'validate', ROOT],
    { encoding: 'utf8', env: { ...process.env, [MODE_ENV]: 'warning-named-hooks' } });
check('  control: the stub really did emit a hooks:-shaped bullet to be fooled by',
    /\bhooks:\s*Unknown field/.test((stubSaid.stdout || '') + (stubSaid.stderr || '')),
    JSON.stringify((stubSaid.stdout || '').slice(0, 200)));

// 3c. THE CI REGRESSION. `[measured 2026-09-08]` the first version of the
//     not-on-PATH branch matched on the shell's ENGLISH plus exit 127/9009. It
//     passed on macOS and failed on BOTH ubuntu-latest and windows-latest —
//     the same defect this file exists to fix, one layer down, and caught only
//     because CI runs shells this machine does not. Ubuntu's dash says "not
//     found" without the word "command"; cmd.exe exits 1, not 9009. The check
//     now reads the CLI's own first line instead, which no shell authors.
for (const [shell, label] of [['shell-bash', 'macOS /bin/sh'], ['shell-dash', 'Ubuntu dash'], ['shell-cmd', 'Windows cmd.exe']]) {
    const r = runValidate(shell);
    check(`a CLI that never ran under ${label} is a WARN`,
        /^\[WARN\]/.test(r.line), r.line);
    check(`  and ${label}'s wording is read as "did not run", not as a missing verdict`,
        /did not run|not on PATH/.test(r.line), r.line);
}

// 4. No CLI at all: the CI shape. Unchanged by this fix, asserted so the three
//    host behaviours are all pinned in one place rather than two.
const nocli = runValidate('nocli');
check('no claude on PATH is a WARN naming the gap, not a FAIL',
    /^\[WARN\]/.test(nocli.line) && /claude is not on PATH/.test(nocli.line), nocli.line);

try { fs.rmSync(STUB_DIR, { recursive: true, force: true }); } catch { /* tmpdir litter is harmless */ }

let pass = 0, fail = 0;
for (const [label, ok, detail] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    if (!ok && detail) console.log('        ' + String(detail).replace(/\n/g, '\n        '));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
