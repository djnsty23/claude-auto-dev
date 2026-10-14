#!/usr/bin/env node
'use strict';
/**
 * worker-authority.js - what each kind of headless claude run may do, and the
 * PreToolUse guard that holds a run to it.
 *
 * WHY. headless runs used to start with every credential the caller had in its
 * environment, and unattended runs with --permission-mode bypassPermissions. A
 * worker could push, write anywhere and read any secret the Windows user can.
 * This file gives each kind a fixed authority (worker-authority.json), builds the
 * child environment from an allowlist, refuses bypassPermissions, and writes the
 * --settings that put a PreToolUse guard (this file, `guard`) in front of every
 * tool call. Privileged actions (push, gh writes, secrets) stay with the Brain,
 * the broker the worker cannot call.
 *
 * WHAT THE GUARD ENFORCES. Each tool call is checked against the run's authority:
 *   - a tool outside the kind's tool set (including any mcp__ tool) is denied
 *   - Write, Edit, MultiEdit and NotebookEdit outside the write roots are denied,
 *     and so are writes to settings, hook and git config files inside them
 *   - Read, Glob and Grep of a credential file path are denied
 *   - a Bash or PowerShell command is denied when it, or any shell child it
 *     wraps (bash -c, sh -c, cmd /c, powershell -Command or -EncodedCommand,
 *     node -e, python -c, wsl, $( ), backticks), runs git push, an unknown git
 *     subcommand (an alias can hide a push), a gh write, a secret store read, a
 *     credential file read, an environment dump, a read of an environment name
 *     the run was not given, or opaque code (a pipe into a shell, eval, iex)
 *   - a review run's Bash is limited to read-only commands with no redirection
 * The authority travels in the hook's argv, fixed at launch. The guard never
 * reads the repository, the transcript or its own environment for authority, so
 * a file or tool output telling the worker to escalate cannot widen it.
 *
 * THE CAP, PLAINLY. This is a guard on tool calls, not an OS boundary. It reads
 * the text of each call. It does not see inside a script file the worker wrote
 * and then runs by path, a git hook or npm script the repository already has,
 * or a process that is already running. Any of those can do whatever the
 * Windows user can do: Windows Sandbox and a separate account are absent on the
 * machine this was built on. The environment allowlist is the one layer that
 * holds against them, because an undeclared secret never reaches the child.
 * Credentials the OS keeps for the user (git's credential manager, gh's stored
 * login) remain reachable by a running process. So the scorecard's child_escape
 * field grades the guard's decision on visible wrappers, nothing more.
 *
 * THE CLI FLAGS ARE READ FROM `claude --help` 2.1.299: --permission-mode choices
 * (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan), --permission-prompts
 * none, --strict-mcp-config and --settings <file-or-json>. Whether a real run
 * honours the hook in dontAsk mode is unverified here: check one real run by hand
 * after a CLI upgrade, with a prompt that asks for `git push --dry-run`.
 *
 * Usage:
 *   node worker-authority.js guard <authority>   (the PreToolUse hook: payload on stdin)
 * Allow prints nothing and exits 0. Deny prints the reason on stderr and exits 2.
 * An unreadable payload or authority is a deny.
 */
const fs = require('node:fs');
const path = require('node:path');

const AUTHORITY_FILE = path.join(__dirname, 'worker-authority.json');
const KINDS_DOC = JSON.parse(fs.readFileSync(AUTHORITY_FILE, 'utf8'));
const KINDS = Object.freeze(Object.keys(KINDS_DOC.kinds));

/** The only permission mode a worker launches with. A legacy 'default' means it. */
const LAUNCH_MODE = 'dontAsk';
const LEGACY_MODES = Object.freeze({ default: LAUNCH_MODE, manual: LAUNCH_MODE });
const ACCEPTED_MODES = Object.freeze([LAUNCH_MODE, 'plan']);

// ---------------------------------------------------------------- environment

/** Names every child gets when the caller has them: the OS, the shell, the network path. */
const BASE_ENV = Object.freeze([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
    'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'COMPUTERNAME',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
    'CommonProgramW6432', 'PUBLIC', 'ALLUSERSPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'MSYSTEM',
]);
/** Prefixes of the harness's own non-secret settings. */
const PASS_PREFIXES = Object.freeze(['AUTODEV_', 'CLAUDE_CODE_']);
/** A name shaped like a secret never passes by prefix. */
const SECRET_SHAPED = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE|(^|_)PAT($|_)|COOKIE|AUTH/i;
/** The CLI's own login. It reaches the claude process, and the guard refuses any tool read of it. */
const CLI_AUTH = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']);
/** Harness variables a parent session would hand down. Always removed. */
const SCRUBBED_ENV = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']);

function fault(code, message) { const e = new Error(message); e.publicCode = code; throw e; }

function requireKind(kind) {
    if (!KINDS.includes(kind)) fault('usage', `worker kind must be one of ${KINDS.join(', ')}; got ${kind}`);
    return kind;
}

/** Whether a name may pass from the caller's environment by the allowlist alone. */
function passable(name) {
    if (BASE_ENV.includes(name)) return true;
    return PASS_PREFIXES.some((p) => name.startsWith(p)) && !SECRET_SHAPED.test(name) && !CLI_AUTH.includes(name);
}

/** The secret names a kind declares. A --secret outside them is refused. */
function requireSecrets(kind, names = []) {
    const declared = KINDS_DOC.kinds[requireKind(kind)].secrets;
    const extra = names.filter((n) => !declared.includes(n));
    if (extra.length) fault('authority-refused', `${kind} does not declare ${extra.join(', ')}; a secret a kind does not declare stays with the broker`);
    return [...new Set(names)].sort();
}

/**
 * The child environment: the allowlist, the CLI's login, the declared secrets,
 * and nothing else. Values never leave this function; callers report names.
 * An inherited CLAUDE_CONFIG_DIR is dropped unless configDir names one.
 */
function childEnv(base, { kind = 'builder', secrets = [], configDir = null, set = {} } = {}) {
    const declared = requireSecrets(kind, secrets);
    const env = {};
    const deleted = [];
    const dropped = [];
    for (const [k, v] of Object.entries(base || {})) {
        if (SCRUBBED_ENV.includes(k)) { deleted.push(k); continue; }
        if (k === 'CLAUDE_CONFIG_DIR') { if (!configDir) deleted.push(k); continue; }
        if (passable(k) || CLI_AUTH.includes(k) || declared.includes(k)) env[k] = v;
        else dropped.push(k);
    }
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    Object.assign(env, set);
    return { env, names: Object.keys(env).sort(), deleted: deleted.sort(), dropped: dropped.sort(), declared };
}

// ---------------------------------------------------------------- launch

/** The permission mode a worker launches with. bypassPermissions and every other widening mode is refused. */
function launchMode(requested) {
    const m = requested == null || requested === '' ? LAUNCH_MODE : (LEGACY_MODES[requested] || requested);
    if (!ACCEPTED_MODES.includes(m)) {
        fault('authority-refused', `--permission-mode ${requested} is refused: a worker launches in ${ACCEPTED_MODES.join(' or ')}, `
            + 'and its guard decides each tool call. Privileged actions belong to the Brain');
    }
    return m;
}

/** The authority one run carries: { kind, tools, writeRoots, secrets, bash }. */
function resolveAuthority(kind, { tools = [], cwd = null, reportDir = null, secrets = [] } = {}) {
    const k = KINDS_DOC.kinds[requireKind(kind)];
    const named = { cwd, reportDir };
    const writeRoots = k.writeRoots.map((r) => named[r]).filter(Boolean).map((r) => path.resolve(r));
    return { kind, tools: [...tools].sort(), writeRoots: [...new Set(writeRoots)], secrets: requireSecrets(kind, secrets), bash: k.bash };
}

function encodeAuthority(a) { return Buffer.from(JSON.stringify(a), 'utf8').toString('base64url'); }
function decodeAuthority(s) {
    const a = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (!a || !KINDS.includes(a.kind) || !Array.isArray(a.tools) || !Array.isArray(a.writeRoots) || !Array.isArray(a.secrets)
        || !['guarded', 'read-only', 'none'].includes(a.bash)) throw new Error('authority is malformed');
    return a;
}

const slash = (p) => String(p).replace(/\\/g, '/');

/** The hook command string. Forward slashes and double quotes read the same in Git Bash and cmd. */
function guardCommand(authority, { node = process.execPath, script = __filename } = {}) {
    return `"${slash(node)}" "${slash(script)}" guard ${encodeAuthority(authority)}`;
}

/** Permission rules that hold even if the hook never runs. */
const STATIC_DENY = Object.freeze(['Bash(git push:*)', 'Bash(git -C:*push*)', 'Bash(gh pr merge:*)', 'Bash(gh pr create:*)',
    'Bash(gh release:*)', 'Bash(gh api:*)', 'Bash(doppler:*)', 'Read(~/.ssh/**)', 'Read(~/.git-credentials)',
    'Read(~/.config/gh/**)', 'Read(**/.env)', 'Read(~/.claude/.credentials.json)']);

/** The --settings object a worker runs under. */
function guardSettings(authority, opts = {}) {
    return {
        disableAllHooks: false,
        permissions: { defaultMode: LAUNCH_MODE, disableBypassPermissionsMode: 'disable', allow: authority.tools.slice(), deny: STATIC_DENY.slice() },
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guardCommand(authority, opts), timeout: 30 }] }] },
    };
}

/** The argv tail that puts a run under its authority. */
function launchArgs(authority, mode, opts = {}) {
    return ['--permission-mode', launchMode(mode), '--permission-prompts', 'none', '--strict-mcp-config',
        '--settings', JSON.stringify(guardSettings(authority, opts))];
}

// ---------------------------------------------------------------- shell reading

/** Read one shell word from i. Null on an unclosed quote. */
function lexWord(src, i) {
    let s = '';
    let any = false;
    while (i < src.length) {
        const c = src[i];
        if (' \t\r\n;|&()<>`'.includes(c)) break;
        if (c === "'") {
            const j = src.indexOf("'", i + 1);
            if (j < 0) return null;
            s += src.slice(i + 1, j); i = j + 1; any = true; continue;
        }
        if (c === '"') {
            let j = i + 1;
            while (j < src.length && src[j] !== '"') {
                if (src[j] === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; }
            }
            if (j >= src.length) return null;
            i = j + 1; any = true; continue;
        }
        if (c === '\\') { if (i + 1 < src.length) s += src[i + 1]; i += 2; any = true; continue; }
        s += c; i++; any = true;
    }
    return { word: s, next: i, any };
}

/**
 * Split a command into segments of { words, redirects }. Separators are ; && || |
 * & newline ( ) and backticks, so a subshell or substitution becomes its own
 * segment. A heredoc body is skipped. Null when a quote never closes.
 */
function lex(src) {
    const segs = [];
    let words = [];
    let reds = [];
    const heredocs = [];
    const endSeg = () => { if (words.length || reds.length) segs.push({ words, redirects: reds }); words = []; reds = []; };
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
        if (c === '\n') {
            endSeg(); i++;
            while (heredocs.length) {
                const { delim, strip } = heredocs.shift();
                for (;;) {
                    if (i >= src.length) break;
                    const nl = src.indexOf('\n', i);
                    const line = src.slice(i, nl < 0 ? src.length : nl).replace(/\r$/, '');
                    i = nl < 0 ? src.length : nl + 1;
                    if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
                }
            }
            continue;
        }
        if (';()`{}'.includes(c) && (c !== '{' && c !== '}' ? true : (src[i + 1] === undefined || /\s/.test(src[i + 1])))) { endSeg(); i++; continue; }
        if (c === '|' || c === '&') {
            if (c === '&' && src[i + 1] === '>') { i++; continue; }
            endSeg(); i += src[i + 1] === c ? 2 : 1; continue;
        }
        let fd = null;
        let at = i;
        if (c !== '>' && c !== '<') {
            const w = lexWord(src, i);
            if (!w) return null;
            if (/^\d+$/.test(w.word) && (src[w.next] === '>' || src[w.next] === '<')) { fd = w.word; at = w.next; } else { if (w.any) words.push(w.word); i = w.next === i ? i + 1 : w.next; continue; }
        }
        let op = src[at];
        let j = at + 1;
        if (op === '>' && src[j] === '>') { op = '>>'; j++; } else if (op === '<' && src[j] === '<') { op = '<<'; j++; if (src[j] === '<') { op = '<<<'; j++; } else if (src[j] === '-') { op = '<<-'; j++; } }
        if (src[j] === '&') { op += '&'; j++; }
        if ((op === '<' || op === '>') && src[j] === '(') { reds.push({ op: op + '(', fd, target: null }); endSeg(); i = j + 1; continue; }
        while (src[j] === ' ' || src[j] === '\t') j++;
        const t = lexWord(src, j);
        if (!t) return null;
        if (op === '<<' || op === '<<-') heredocs.push({ delim: t.word, strip: op === '<<-' });
        reds.push({ op, fd, target: t.any ? t.word : null });
        i = t.next;
    }
    endSeg();
    return segs;
}

/** The executable's bare name: no directory, no quotes, no .exe. */
function exeName(word) {
    return slash(word).split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

/** Tokens of a text for proximity scans, separators dropped. */
function tokens(text) { return String(text).split(/[\s'"`,\[\](){};|&<>=+]+/).filter(Boolean); }

// ---------------------------------------------------------------- what is forbidden

const GIT_BUILTINS = new Set(('add am apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout cherry cherry-pick '
    + 'clean clone commit commit-graph commit-tree config count-objects describe diff diff-files diff-index diff-tree difftool fetch '
    + 'for-each-ref format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree maintenance merge merge-base '
    + 'merge-file merge-tree mergetool mktree mv name-rev notes prune pull range-diff read-tree rebase reflog remote repack replace '
    + 'reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status stripspace '
    + 'submodule switch symbolic-ref tag update-index update-ref var verify-commit verify-tag version whatchanged worktree write-tree').split(' '));
const GIT_DENIED = new Set(['push', 'send-pack', 'receive-pack', 'credential', 'credential-store', 'credential-cache', 'credential-manager', 'http-push']);
const GIT_READ = new Set('log diff show status blame rev-parse ls-files ls-tree cat-file grep shortlog describe merge-base rev-list for-each-ref show-ref name-rev version diff-tree range-diff help'.split(' '));
const GIT_LISTING = new Set(['branch', 'tag', 'remote', 'worktree', 'config', 'stash']);
const GIT_LIST_ARGS = /^(--list|-l|-a|-r|-v|-vv|--show-current|list|get-url|--get|--get-all|--get-regexp|--show-origin|show|--contains|--merged|--no-merged)$/;
const GIT_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
/** git -c keys that run code or reroute auth. */
const GIT_RISKY_CONFIG = /^(alias\.|credential\.|include\.|includeif\.|core\.hookspath|core\.sshcommand|core\.askpass|core\.fsmonitor|core\.editor|sequence\.editor|url\..*\.(push)?insteadof|remote\..*\.(push)?url|protocol\.)/i;
const GIT_CONFIG_SAFE_SET = /^(user\.name|user\.email|core\.autocrlf|core\.longpaths)$/i;

/** The read-only gh verbs. Every other gh call is a write or reveals a token. */
const GH_READ = Object.freeze({
    pr: ['view', 'list', 'status', 'diff', 'checks'], issue: ['view', 'list', 'status'], run: ['view', 'list', 'watch'],
    repo: ['view', 'list'], release: ['view', 'list'], workflow: ['view', 'list'], search: null, auth: ['status'], label: ['list'],
    api: null, cache: ['list'], status: null, browse: [],
});

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const POWERSHELLS = new Set(['powershell', 'pwsh']);
const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'py', 'ruby', 'perl', 'php']);
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'sudo', 'doas', 'xargs', 'start', 'call', 'timeout', 'stdbuf', 'npx', 'winpty']);
const SECRET_TOOLS = new Set(['doppler', 'cmdkey', 'vaultcmd', 'secret-tool', 'op', 'bw', 'keyring', 'get-storedcredential', 'security', 'vault', 'aws-vault', 'pass']);
const REVIEW_READ = new Set(['ls', 'dir', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'echo', 'printf', 'pwd',
    'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'file', 'stat', 'du', 'df', 'which', 'where', 'type', 'true', 'false', 'test', '[',
    'basename', 'dirname', 'realpath', 'readlink', 'date', 'git', 'jq', 'tree', 'cd', 'get-content', 'gc', 'get-childitem', 'gci',
    'select-string', 'sls', 'get-item', 'gi', 'measure-object', 'select-object', 'format-list', 'format-table', 'out-string', 'write-output']);
const SHELL_VARS = new Set(('HOME PWD OLDPWD RANDOM LINENO SECONDS BASH_SOURCE BASHPID BASH_VERSION OSTYPE PPID IFS UID EUID HOSTNAME HOSTTYPE '
    + 'MACHTYPE SHLVL PIPESTATUS FUNCNAME REPLY OPTARG OPTIND COLUMNS LINES PS1 PS4 BASH_REMATCH EPOCHSECONDS EPOCHREALTIME MINGW_PREFIX '
    + 'PROMPT_COMMAND BASH').split(' '));

const CREDENTIAL_PATHS = [
    /\.credentials\.json/, /\.git-credentials/, /(^|\/)gh\/hosts\.ya?ml/, /(^|[\/\s'"=:])\.npmrc(?![\w.])/, /(^|[\/\s'"=:])[._]netrc(?![\w.])/,
    /(^|\/)\.ssh(\/|$)/, /(^|[\/\s'"=:])id_(rsa|ed25519|ecdsa|dsa)(?![\w])/, /\.aws\/credentials/, /\.docker\/config\.json/, /(^|\/)\.doppler/,
    /\.pypirc/, /\.kube\/config/, /\/proc\/(self|\d+)\/environ/, /\.config\/git\/credentials/, /(^|[\/\s'"=:])\.env(\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)?(?=$|[\s'"`;|&)\/]|\*)/,
];

/** Paths a worker never writes even inside its roots: they change its own authority or run code later. */
const CONFIG_PATHS = [/(^|\/)\.claude\/settings(\.local)?\.json$/, /(^|\/)\.claude\/hooks\//, /(^|\/)\.mcp\.json$/, /(^|\/)\.git\/hooks\//,
    /(^|\/)\.git\/config$/, /(^|\/)\.gitconfig$/, /(^|\/)\.husky\//];

function credentialPath(text) {
    const t = slash(text).toLowerCase();
    return CREDENTIAL_PATHS.some((re) => re.test(t));
}

function deny(rule, why) { return { decision: 'deny', rule, reason: why }; }
const ALLOW = Object.freeze({ decision: 'allow', rule: null, reason: null });

/** Git Bash /c/x and x: forms to one absolute path. */
function toAbs(p, cwd) {
    let s = slash(p);
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(s);
    if (m && process.platform === 'win32') s = `${m[1]}:/${m[2]}`;
    if (s.startsWith('~')) s = path.join(process.env.USERPROFILE || process.env.HOME || '', s.slice(1));
    return path.resolve(cwd || process.cwd(), s);
}

function inside(root, p) {
    const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
    const rel = path.relative(norm(root), norm(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The write rule for one target path. */
function checkWrite(target, auth, cwd) {
    if (target == null || target === '') return deny('write-unknown', 'the write has no target path');
    const t = slash(target);
    if (/^(\/dev\/null|nul|&\d|-)$/i.test(t) || /^&/.test(t)) return ALLOW;
    if (credentialPath(t)) return deny('credential-file', `writing ${t} touches a credential file`);
    const abs = toAbs(t, cwd);
    if (!auth.writeRoots.length) return deny('write-outside-roots', `a ${auth.kind} run writes nothing, and this writes ${slash(abs)}`);
    if (!auth.writeRoots.some((r) => inside(r, abs))) return deny('write-outside-roots', `${slash(abs)} is outside the write roots ${auth.writeRoots.map(slash).join(', ')}`);
    if (CONFIG_PATHS.some((re) => re.test(slash(abs).toLowerCase()))) return deny('authority-config', `${slash(abs)} configures hooks, settings or git and is not a worker's to change`);
    return ALLOW;
}

/** Environment names a text reads, by dialect. */
function envRefs(text, dialect) {
    const names = [];
    const add = (re, s = text) => { for (const m of s.matchAll(re)) names.push(m[1]); };
    if (dialect === 'bash') {
        const unquoted = text.replace(/'[^']*'/g, "''");
        add(/\$\{?#?!?([A-Za-z_][A-Za-z0-9_]*)/g, unquoted);
    }
    if (dialect === 'ps') add(/\$env:([A-Za-z_][A-Za-z0-9_()]*)/gi);
    if (dialect === 'cmd') add(/%([A-Za-z_][A-Za-z0-9_]*)%/g);
    add(/process\.env\.([A-Za-z_]\w*)/g);
    add(/process\.env\[\s*['"`]([^'"`]+)['"`]\s*\]/g);
    add(/Deno\.env\.get\(\s*['"`]([^'"`]+)/g);
    add(/os\.environ\[\s*['"]([^'"]+)['"]\s*\]/g);
    add(/os\.environ\.get\(\s*['"]([^'"]+)/g);
    add(/getenv\(\s*['"]([^'"]+)/gi);
    add(/ENV\[\s*['"]([^'"]+)['"]\s*\]/g);
    add(/\[environment\]::getenvironmentvariable\(\s*['"]([^'"]+)/gi);
    add(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi);
    return [...new Set(names)];
}

/** Names the command itself assigns, so `X=1; echo $X` is not a read of the caller's X. */
function assignedNames(text) {
    const out = new Set();
    for (const m of text.matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=/g)) out.add(m[1]);
    for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) out.add(m[1]);
    for (const m of text.matchAll(/\bread\s+(?:-\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
    return out;
}

function readableEnv(name, auth, assigned) {
    if (auth.secrets.includes(name) || assigned.has(name) || SHELL_VARS.has(name)) return true;
    return passable(name);
}

const ENV_DUMP = [/\b(get-childitem|gci|dir|ls|get-item|gi)\s+env:/i, /\[environment\]::getenvironmentvariables/i,
    /process\.env(?!\s*(\.\s*[A-Za-z_]|\[\s*['"`]))/, /os\.environ(?!\s*(\[\s*['"]|\.get\s*\())/, /Deno\.env\.toObject/, /\/proc\/(self|\d+)\/environ/];
const OPAQUE = [/\|\s*(sh|bash|zsh|dash|pwsh|powershell|cmd|python3?|py|node|ruby|perl)(\.exe)?\s*(-s\b|-\s|-$|-command\s+-|\/dev\/stdin|$|[;&|)])/im,
    /\b(iex|invoke-expression)\b/i, /(^|[;&|(\s])eval\s/, /\b(source|bash|sh|zsh|\.)\s+<\(/, /\bfrom(base64string|base64)\b.*\|\s*(iex|sh|bash)/i];

/** Text-level scans: they see inside quotes and code, where a wrapper hides a call. */
function scanText(text, auth, dialect) {
    if (credentialPath(text)) return deny('credential-file', 'the command names a credential file');
    if (ENV_DUMP.some((re) => re.test(text))) return deny('env-dump', 'the command dumps the environment');
    const assigned = assignedNames(text);
    const bad = envRefs(text, dialect).filter((n) => !readableEnv(n, auth, assigned));
    if (bad.length) return deny('undeclared-env', `the command reads ${bad.join(', ')}, which this run was not given`);
    if (OPAQUE.some((re) => re.test(text))) return deny('opaque-exec', 'the command runs code the guard cannot read (a pipe into a shell, eval or iex)');
    const toks = tokens(text);
    for (let i = 0; i < toks.length; i++) {
        const name = exeName(toks[i]);
        if (name === 'git') {
            for (const t of toks.slice(i + 1, i + 14)) {
                const l = t.toLowerCase();
                if (GIT_DENIED.has(l)) return deny('git-push', `git ${l} belongs to the Brain`);
                if (/^alias\./.test(l) || /^core\.hookspath/.test(l)) return deny('git-push', `git ${t} can hide a push`);
            }
        }
        if (name === 'gh') {
            const v = ghVerdict(toks.slice(i + 1, i + 20));
            if (v) return v;
        }
        if (SECRET_TOOLS.has(name) && (name !== 'security' || /find-(generic|internet)-password/.test(text)) && (name !== 'pass' || i === 0)) {
            return deny('secret-store', `${name} reads a secret store`);
        }
    }
    return null;
}

/** The decision on a gh argument list, or null when it reads. */
function ghVerdict(args) {
    const words = args.filter((a) => !/^-/.test(a) || /^--?(X|method|f|F|field|raw-field|input|show-token|t)$/.test(a));
    const group = (args[0] || '').toLowerCase();
    if (!group || group.startsWith('-')) return null;
    if (!(group in GH_READ)) return deny('gh-write', `gh ${group} is not a read`);
    if (group === 'api') {
        for (let k = 0; k < args.length; k++) {
            const a = args[k];
            if (/^(-X|--method)$/.test(a) && args[k + 1] && args[k + 1].toUpperCase() !== 'GET') return deny('gh-write', `gh api ${args[k + 1]} writes`);
            if (/^(-f|-F|--field|--raw-field|--input)$/.test(a)) return deny('gh-write', 'gh api with fields sends a write');
        }
        return null;
    }
    if (group === 'auth' && args.some((a) => /^(--show-token|-t|token)$/.test(a))) return deny('secret-store', 'gh auth token reveals the login');
    const allowed = GH_READ[group];
    if (allowed === null) return null;
    const verb = (words[1] || '').toLowerCase();
    if (!allowed.includes(verb)) return deny('gh-write', `gh ${group} ${verb || '(none)'} is not a read`);
    return null;
}

/** git in command position: options walked, then the subcommand judged. */
function checkGit(args, auth) {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) {
        const a = args[k];
        const [flag, val] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
        const value = GIT_WITH_VALUE.has(flag) && val === null ? args[++k] : val;
        if ((flag === '-c' || flag === '--config-env') && value && GIT_RISKY_CONFIG.test(value)) return deny('git-push', `git -c ${value} can run code or hide a push`);
        k++;
    }
    const sub = (args[k] || '').toLowerCase();
    const rest = args.slice(k + 1);
    if (!sub) return null;
    if (GIT_DENIED.has(sub)) return deny('git-push', `git ${sub} belongs to the Brain`);
    if (!GIT_BUILTINS.has(sub)) return deny('git-push', `git ${sub} is not a git builtin, and an alias can hide a push`);
    if (sub === 'config') {
        const reads = rest.some((a) => GIT_LIST_ARGS.test(a));
        const key = rest.find((a) => !a.startsWith('-'));
        if (!reads && key && (GIT_RISKY_CONFIG.test(key) || !GIT_CONFIG_SAFE_SET.test(key))) return deny('git-push', `git config ${key} is not a worker's to set`);
    }
    if (auth.bash === 'read-only' && !GIT_READ.has(sub) && !(GIT_LISTING.has(sub) && (rest.length === 0 || rest.every((a) => GIT_LIST_ARGS.test(a) || a.startsWith('--format'))))) {
        return deny('review-write', `git ${sub} changes the repository, and a review run only reads`);
    }
    return null;
}

/** String literals inside code, each a candidate shell command. */
function codeStrings(code) {
    const out = [];
    for (const m of String(code).matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]);
    return out;
}

/** The payload a wrapper runs, with the dialect to read it in, or null. */
function wrapped(name, args) {
    const lower = args.map((a) => a.toLowerCase());
    if (SHELLS.has(name)) {
        const k = lower.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
        if (k >= 0) return [{ text: args[k + 1] || '', dialect: 'bash' }];
        return null;
    }
    if (name === 'cmd') {
        const k = lower.findIndex((a) => a === '/c' || a === '/k' || a === '/r');
        if (k >= 0) return [{ text: args.slice(k + 1).join(' '), dialect: 'cmd' }];
        return null;
    }
    if (POWERSHELLS.has(name)) {
        const out = [];
        for (let k = 0; k < args.length; k++) {
            const a = lower[k];
            if (/^-(e|ec|en|enc|encodedcommand)$/.test(a)) {
                let decoded = null;
                try { decoded = Buffer.from(args[k + 1] || '', 'base64').toString('utf16le'); } catch { decoded = null; }
                if (!decoded) return [{ text: null, dialect: 'ps' }];
                out.push({ text: decoded, dialect: 'ps' });
                k++;
            } else if (/^-(c|command)$/.test(a)) { out.push({ text: args.slice(k + 1).join(' '), dialect: 'ps' }); break; }
            else if (/^-(file|f)$/.test(a)) { k++; }
            else if (!a.startsWith('-')) { out.push({ text: args.slice(k).join(' '), dialect: 'ps' }); break; }
        }
        return out;
    }
    if (name === 'wsl') {
        const k = lower.findIndex((a) => a === '--' || a === '-e' || a === '--exec');
        return [{ text: (k >= 0 ? args.slice(k + 1) : args.filter((a) => !a.startsWith('-'))).join(' '), dialect: 'bash' }];
    }
    if (INTERPRETERS.has(name)) {
        const k = lower.findIndex((a) => /^(-e|-p|-c|--eval|--print|-pe|-ne|-le|-r)$/.test(a));
        if (k >= 0) return codeStrings(args[k + 1] || '').map((s) => ({ text: s, dialect: 'bash' })).concat([{ text: args[k + 1] || '', dialect: 'code' }]);
        return null;
    }
    if (name === 'start-process' || name === 'saps') return [{ text: args.filter((a) => !/^-/.test(a)).join(' '), dialect: 'ps' }];
    return null;
}

/** Write targets of one segment, for builder runs. */
function segmentWrites(name, args, redirects) {
    const out = redirects.filter((r) => /^>/.test(r.op) || r.op === '&>').map((r) => r.target);
    const plain = args.filter((a) => !a.startsWith('-'));
    if (name === 'tee') out.push(...plain);
    if (['cp', 'mv', 'copy-item', 'move-item', 'cpi', 'mi', 'install'].includes(name) && plain.length) out.push(plain[plain.length - 1]);
    if (['rm', 'rmdir', 'mkdir', 'touch', 'remove-item', 'ri', 'del', 'erase', 'new-item', 'ni', 'truncate', 'shred'].includes(name)) out.push(...plain);
    if (['out-file', 'set-content', 'add-content', 'sc', 'ac'].includes(name)) {
        const k = args.findIndex((a) => /^-(path|filepath|literalpath)$/i.test(a));
        out.push(k >= 0 ? args[k + 1] : plain[0]);
    }
    if (name === 'sed' && args.some((a) => /^-i/.test(a) || a === '--in-place')) out.push(...plain.slice(1));
    return out;
}

/**
 * The decision on one shell command. Recurses into every wrapper it can read.
 * depth bounds the recursion: past it, the command is denied.
 */
function analyseCommand(cmd, auth, cwd, dialect = 'bash', depth = 0) {
    if (typeof cmd !== 'string') return deny('unreadable', 'the command is not text');
    if (depth > 6) return deny('opaque-exec', 'the command nests wrappers deeper than the guard reads');
    if (auth.bash === 'none') return deny('tool-not-in-authority', `a ${auth.kind} run has no shell`);
    const text = scanText(cmd, auth, dialect);
    if (text) return text;
    if (dialect === 'code') return null;
    for (const m of cmd.matchAll(/\$\(((?:[^()]|\([^()]*\))*)\)/g)) { const r = analyseCommand(m[1], auth, cwd, dialect, depth + 1); if (r) return r; }
    for (const m of cmd.matchAll(/`([^`]*)`/g)) if (dialect !== 'ps') { const r = analyseCommand(m[1], auth, cwd, dialect, depth + 1); if (r) return r; }
    const segs = lex(cmd);
    if (!segs) return deny('unreadable', 'a quote in the command never closes');
    if (auth.bash === 'read-only') {
        if (/\$\(|`|<\(|>\(/.test(cmd)) return deny('review-write', 'a review run reads, and substitutions can run anything');
    }
    for (const seg of segs) {
        const head = seg.words.length ? exeName(seg.words[0]) : '';
        const operands = seg.words.slice(1).filter((a) => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
        if ((head === 'env' || head === 'printenv') && operands.length === 0) return deny('env-dump', `${head} with no name dumps the environment`);
        if (['set', 'export', 'declare', 'typeset'].includes(head) && seg.words.slice(1).every((a) => /^-[pxv]*$/.test(a))) return deny('env-dump', `${head} with no name dumps the environment`);
        if (head === 'compgen' && seg.words.includes('-v')) return deny('env-dump', 'compgen -v lists the environment');
        let w = seg.words.slice();
        let fedByXargs = false;
        while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || WRAPPERS.has(exeName(w[0])) || w[0] === '&' || w[0] === '!' || w[0] === '{' || w[0] === '}')) {
            const wn = exeName(w[0]);
            if (wn === 'xargs') fedByXargs = true;
            w.shift();
            if (wn === 'timeout' && w.length && /^\d/.test(w[0])) w.shift();
            while (w.length && w[0].startsWith('-') && wn !== 'xargs') w.shift();
            if (wn === 'xargs') while (w.length && w[0].startsWith('-')) w.shift();
        }
        if (!w.length) {
            if (auth.bash === 'read-only' && seg.redirects.some((r) => /^>|&>/.test(r.op) && !/^(\/dev\/null|nul|&\d)$/i.test(slash(r.target || '')))) return deny('review-write', 'a review run writes nothing');
            continue;
        }
        const name = exeName(w[0]);
        const args = w.slice(1);
        if (fedByXargs && (name === 'git' || name === 'gh' || SHELLS.has(name) || POWERSHELLS.has(name) || INTERPRETERS.has(name) || name === 'cmd')) {
            return deny('opaque-exec', `xargs feeds ${name} arguments the guard cannot read`);
        }
        if (name === 'eval' || name === 'source' || name === '.') return deny('opaque-exec', `${name} runs text the guard cannot read`);
        if (name === 'printenv' && args.some((a) => !readableEnv(a, auth, new Set()))) return deny('undeclared-env', `printenv reads ${args.join(' ')}, which this run was not given`);
        if (name === 'git') { const r = checkGit(args, auth); if (r) return r; }
        if (name === 'gh') { const r = ghVerdict(args); if (r) return r; }
        const inner = wrapped(name, args);
        if (inner) {
            for (const { text: t, dialect: d } of inner) {
                if (t === null) return deny('opaque-exec', `${name} carries an encoded command the guard cannot decode`);
                const r = analyseCommand(t, auth, cwd, d, depth + 1);
                if (r) return r;
            }
        }
        if (auth.bash === 'read-only') {
            if (!REVIEW_READ.has(name) && !(inner && inner.length)) return deny('review-write', `${name} is not a read-only command, and a review run only reads`);
            if (name === 'find' && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a))) return deny('review-write', 'find with an action can write');
            for (const r of seg.redirects) {
                if ((/^>/.test(r.op) || r.op === '&>') && !/^(\/dev\/null|nul|&\d)$/i.test(slash(r.target || ''))) return deny('review-write', 'a review run writes nothing, and this redirects into a file');
            }
        } else {
            for (const target of segmentWrites(name, args, seg.redirects)) {
                const r = checkWrite(target, auth, cwd);
                if (r.decision === 'deny') return r;
            }
        }
    }
    return null;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * The guard's decision on one PreToolUse payload under one authority.
 * { decision: 'allow'|'deny', rule, reason }. Every unreadable shape is a deny.
 */
function decide(payload, auth) {
    if (!payload || typeof payload !== 'object' || typeof payload.tool_name !== 'string') return deny('unreadable', 'the hook payload names no tool');
    const tool = payload.tool_name;
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : (auth.writeRoots[0] || process.cwd());
    if (!auth.tools.includes(tool)) return deny('tool-not-in-authority', `${tool} is not in the ${auth.kind} tool set`);
    if (WRITE_TOOLS.has(tool)) return checkWrite(input.file_path || input.notebook_path, auth, cwd);
    if (READ_TOOLS.has(tool)) {
        for (const k of ['file_path', 'path', 'pattern', 'glob']) {
            if (typeof input[k] === 'string' && credentialPath(input[k])) return deny('credential-file', `${tool} of ${input[k]} reads a credential file`);
        }
        return ALLOW;
    }
    if (SHELL_TOOLS.has(tool)) return analyseCommand(input.command, auth, cwd, tool === 'PowerShell' ? 'ps' : 'bash') || ALLOW;
    return ALLOW;
}

/** The hook body: read stdin, decide, answer. Silent on allow. */
function guardMain(argv, stdinText) {
    let auth;
    try { auth = decodeAuthority(argv[0]); } catch (e) { return { exit: 2, stderr: `worker-authority: the authority is unreadable (${e.message}), so every call is denied\n` }; }
    let payload;
    try { payload = JSON.parse(stdinText); } catch { return { exit: 2, stderr: 'worker-authority: the hook payload is not JSON, so the call is denied\n' }; }
    let d;
    try { d = decide(payload, auth); } catch (e) { d = deny('guard-error', `the guard failed (${e.message}), so the call is denied`); }
    if (d.decision === 'allow') return { exit: 0, stderr: '' };
    return { exit: 2, stderr: `worker-authority denied ${payload.tool_name} [${d.rule}]: ${d.reason}. A ${auth.kind} run cannot do this; `
        + 'say in your report what you needed and the Brain decides.\n' };
}

if (require.main === module) {
    try {
        if (process.argv[2] !== 'guard') {
            process.stdout.write('Usage: node worker-authority.js guard <authority>   (PreToolUse hook; payload on stdin)\n');
            process.exitCode = process.argv[2] ? 1 : 0;
        } else {
            const chunks = [];
            process.stdin.on('data', (c) => chunks.push(c));
            process.stdin.on('end', () => {
                const r = guardMain(process.argv.slice(3), Buffer.concat(chunks).toString('utf8'));
                if (r.stderr) process.stderr.write(r.stderr);
                process.exitCode = r.exit;
            });
            process.stdin.on('error', () => { process.stderr.write('worker-authority: stdin failed, so the call is denied\n'); process.exitCode = 2; });
        }
    } catch (e) {
        try { process.stderr.write(`worker-authority: ${e.message}; the call is denied\n`); } catch { /* nothing left to say */ }
        process.exitCode = 2;
    }
}

module.exports = {
    AUTHORITY_FILE, KINDS, LAUNCH_MODE, ACCEPTED_MODES, BASE_ENV, CLI_AUTH, SCRUBBED_ENV, STATIC_DENY,
    requireKind, passable, requireSecrets, childEnv, launchMode, resolveAuthority, encodeAuthority, decodeAuthority,
    guardCommand, guardSettings, launchArgs, lex, exeName, credentialPath, envRefs, analyseCommand, decide, guardMain,
};
