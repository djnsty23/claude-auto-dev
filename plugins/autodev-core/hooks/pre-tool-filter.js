#!/usr/bin/env node
// PreToolUse hook - write protection and token optimization
// Exit 2 = block, Exit 0 = allow
//
// THE BASH COMMAND DENYLIST WAS REMOVED ON 2026-08-17. It is deliberately not
// coming back, and the reasoning is recorded here so it is not re-added by
// someone who assumes it was lost in a refactor.
//
// It was measured over every transcript on one developer's machine: 656
// sessions, 57,599 Bash calls, 807 blocks. What it caught:
//
//     591  node -e / node -p        read-only JSON inspection
//      73  npx (non-allowlisted)    including a real production deploy
//      27  curl … | node -e         reading a JSON API response
//      56  git force/reset/stash    agents cleaning up throwaway worktrees
//       0  mkfs, format c:, diskpart, rm -rf ~, curl | bash, find / -delete,
//          chmod -R 000 /, prd-archive deletion
//
// The rules that existed to prevent catastrophe never fired once. The rules that
// fired were blocking inspection. Driven directly with 22 crafted cases, 7 came
// back wrong, all of them refusing legitimate work: `npx create-next-app` passed
// but `npx -y create-next-app` was blocked, because the 20-entry allowlist was
// defeated by any flag before the tool name; `git checkout -- .gitignore` was
// blocked as if it were `git checkout .`; grepping migrations FOR the string
// "drop table" was blocked; `--force-with-lease`, the safe form, was blocked
// while being the form actually in use.
//
// A denylist over command TEXT cannot tell executing a dangerous thing from
// mentioning one. That limit is structural, and the comments this file used to
// carry were a record of patching around it one idiom at a time. Command-level
// judgment now sits with the permission layer, which reads intent and, on the
// day this was measured, was the only layer that stopped anything destructive.
//
// What remains here is not judgment about danger — it is protection against two
// specific structural mistakes a model cannot see from inside a single tool
// call: writing to the INSTALLED plugin tree instead of the source repo, and
// putting a private name into a public one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Module-level constants — compiled once, reused on every tool call

const PROTECTED_FILE_PATTERNS = [
    /[/\\]\.claude[/\\]hooks[/\\]/,            // Project/global hook scripts
    /[/\\]\.claude[/\\]settings\.json$/,        // Permission deny rules
    // Installed plugin trees — hooks and their registration moved here in 8.0,
    // so without this the patterns above stopped protecting any hook that
    // actually runs. Scoped to the INSTALL location on purpose: editing a
    // plugin's source in its own repo is ordinary development, not tampering.
    /[/\\]\.claude[/\\]plugins[/\\]/,
];

const SKIP_READ_PATTERNS = [
    /node_modules/,
    /dist[/\\]/,
    /build[/\\]/,
    /\.git[/\\]/,
    /package-lock\.json/,
    /yarn\.lock/,
    /pnpm-lock\.yaml/,
    /\.next[/\\]/,
    /coverage[/\\]/,
    /\.turbo[/\\]/,
];

// Basenames, lowercase: matched case-insensitively because on the default
// macOS and Windows filesystems `.ESLINTRC.JS` is the same inode as
// `.eslintrc.js`, so a case-sensitive list is a list with a hole in it.
// Linter and formatter configs only. tsconfig.json is deliberately absent:
// changing compiler options is ordinary work, and a `strict: false` there is
// caught by review, not by a prompt on every tsconfig edit.
const LINT_CONFIG_NAMES = new Set([
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.mjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    'eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs', 'eslint.config.ts', '.eslintignore',
    '.prettierrc', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.json', '.prettierrc.yml',
    '.prettierrc.yaml', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
    '.prettierignore',
    'biome.json', 'biome.jsonc',
    '.stylelintrc', '.stylelintrc.js', '.stylelintrc.cjs', '.stylelintrc.json', '.stylelintrc.yml', '.stylelintrc.yaml',
    'stylelint.config.js', 'stylelint.config.cjs', 'stylelint.config.mjs',
]);

// Native apply_patch supplies one raw patch in tool_input.command, not a
// Write/Edit file_path. Inventory every source/destination before any verdict.
// This protects paths only; it does not claim native content/lint validation.
const CODEX_PROTECTED_FILE_PATTERNS = [
    /[/\\]\.codex[/\\](?:plugins|hooks)[/\\]/,
    /[/\\]\.codex[/\\](?:config\.toml|hooks\.json)$/,
];

function nativePatchPaths(command) {
    if (typeof command !== 'string') throw new Error('apply_patch command must be text');
    let lines = command.trim().split(/\r?\n/);
    if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines.at(-1) === 'EOF') {
        lines = lines.slice(1, -1);
    }
    if (lines[0]?.trim() !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch') {
        throw new Error('unsupported apply_patch framing');
    }
    const paths = [];
    let operation = null, moved = false;
    for (const line of lines.slice(1, -1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // In Update hunks a leading space is content, even when it names a
        // patch marker. Native streaming_parser preserves that prefix.
        if (operation === 'Update File' && line.startsWith(' ')) continue;
        if (trimmed.startsWith('*** Environment ID:')) {
            throw new Error('remote apply_patch path protection is unsupported');
        }
        const header = trimmed.match(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/);
        if (header) {
            const [, action, target] = header;
            if (target.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
                throw new Error('unsupported apply_patch path');
            }
            if (action === 'Move to') {
                if (operation !== 'Update File' || moved) throw new Error('unsupported apply_patch move');
                moved = true;
            } else { operation = action; moved = false; }
            paths.push(target);
            continue;
        }
        if (trimmed === '*** End of File' && operation === 'Update File') continue;
        if (trimmed.startsWith('***')) throw new Error('unsupported apply_patch header');
        if (operation === 'Add File' && line.startsWith('+')) continue;
        if (operation === 'Update File' && (/^[ +\-]/.test(line) || line === '@@' || line.startsWith('@@ '))) continue;
        throw new Error('unsupported apply_patch body');
    }
    return paths;
}

function nativePatchResolvedPaths(cwd, target) {
    // Match native PathUri's lexical '..' normalization first, then inspect
    // existing symlink ancestors of that target. Raw kernel alias/.. traversal
    // differs from native apply_patch and would falsely block ordinary paths.
    const lexical = path.resolve(cwd, target);
    let probe = lexical;
    const suffix = [];
    for (;;) {
        try { return [lexical, path.resolve(fs.realpathSync(probe), ...suffix)]; }
        catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
            const parent = path.dirname(probe);
            if (parent === probe) throw error;
            suffix.unshift(path.basename(probe)); probe = parent;
        }
    }
}

try {
    const input = fs.readFileSync(0, 'utf8');

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        // Can't parse input — block to be safe (fail-closed)
        process.stderr.write('pre-tool-filter: failed to parse hook input, blocking operation\n');
        process.exit(2);
    }

    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    if (toolName === 'apply_patch') {
        if (typeof data.cwd !== 'string' || !path.isAbsolute(data.cwd)) {
            throw new Error('native apply_patch requires an absolute local cwd');
        }
        const targets = nativePatchPaths(toolInput.command);
        for (const target of targets) {
            for (const resolved of nativePatchResolvedPaths(data.cwd, target)) {
                const candidate = process.platform === 'linux' ? resolved : resolved.toLowerCase();
                if ([...PROTECTED_FILE_PATTERNS, ...CODEX_PROTECTED_FILE_PATTERNS].some((pattern) => pattern.test(candidate))) {
                    process.stderr.write(`Blocked: native apply_patch cannot modify security-critical path: ${resolved}\n`);
                    process.exit(2);
                }
            }
        }
        process.exit(0);
    }

    // Write/Edit protection - prevent Claude from modifying security-critical files
    if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = toolInput.file_path || '';
        for (const pattern of PROTECTED_FILE_PATTERNS) {
            if (pattern.test(filePath)) {
                process.stderr.write(`Blocked: Cannot modify security-critical file: ${filePath}\nInstalled plugin files are managed by Claude Code — edit them in the source repo and run /plugin marketplace update.\n`);
                process.exit(2);
            }
        }
    }

    // Lint/format config protection, ported from ECC's config-protection hook
    // on 2026-09-07 (docs/evidence-ecc-comparison-2026-09-07.md). A branch in
    // THIS hook rather than a hook of its own: a separate PreToolUse subprocess
    // costs 58 ms on every Edit (median of 3, no-op path, this machine), and a
    // Set lookup here costs nothing that can be measured.
    //
    // `ask`, where ECC denies. The legitimate case (the user asked for a rule
    // change) needs a human answer, and ECC's escape is an environment variable
    // in the session, which cannot be set from the desktop app. Interactive
    // sessions get a prompt; a headless session cannot answer one and is
    // denied, which is the right default for an autonomous run weakening a
    // linter. Exit 0 with a JSON decision, never exit 2: this is a question,
    // not a block.
    if (toolName === 'Write' || toolName === 'Edit') {
        const base = path.basename(toolInput.file_path || '').toLowerCase();
        if (LINT_CONFIG_NAMES.has(base)) {
            console.log(JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                    permissionDecisionReason: `${base} is a lint/format config. A rule turned off here hides every finding it would have made; fix the code instead, unless the user asked for this config change.`,
                },
            }));
            process.exit(0);
        }
    }

    // Private-name leak protection, at WRITE time rather than at validate time.
    //
    // tooling/check-no-private-names.js already gates this, but only when it is
    // invoked. On 2026-08-16 a handoff doc naming three private repos was
    // written, validated (the file was untracked, so the gate could not see it),
    // added and PUSHED to a public remote. The gate was correct and still ran
    // after the leak. This block moves the same list to the moment of the write.
    //
    // SCOPED, NOT GLOBAL — the part that took the most care. This hook fires in
    // every project; the denylist belongs to one. Writing a private repo's own
    // name inside that repo is normal work, and a global version of this check would
    // block legitimate writes in three active production repos. So: walk up from
    // the target file looking for that repo's OWN check script, and do nothing
    // if there isn't one.
    //
    // The list is READ FROM that script rather than copied here, so the hook and
    // the gate cannot drift apart. Adding a digest to DIGESTS arms both at once.
    //
    // READ AS TEXT, NEVER `require`d. Loading it would execute a file found by
    // walking up to 40 directories from whatever the user is editing — which is
    // any repo they happen to have cloned. Parsing is the only safe reading of
    // an untrusted path, so the normalise-and-hash below is a deliberate copy of
    // the checker's, kept honest by tests rather than by sharing the module.
    //
    // Two formats are accepted: DIGESTS (2026-08-22 onward) and the older
    // plaintext NAMES. This hook ships INSTALLED, so it can be older or newer
    // than the checker it finds — and when it understands neither format it says
    // so on stderr instead of passing quietly, because a check that silently
    // stopped covering anything is worse than one that is absent.
    //
    // FAIL OPEN, unlike the rest of this hook. Everything above fails closed,
    // because a filter that cannot read its input must not pass a dangerous
    // command. This block is the reverse case: it is defence-in-depth in front
    // of a gate that still runs, and it ships inside an INSTALLED plugin, so a
    // defect here blocks every write in every project until the user reinstalls.
    // That is not hypothetical — during development a missing `require('path')`
    // hit the outer fail-closed handler and blocked every write in this repo,
    // reporting a plausible +2.3ms cost for a code path that only ever crashed.
    // Backstop present, blast radius large: skip the check, say so, let it pass.
    if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = toolInput.file_path || '';
        const content = toolInput.content || toolInput.new_string || '';
        try {
            if (filePath && content) {
                let dir = path.dirname(path.resolve(filePath));
                let checker = null;
                for (let i = 0; i < 40; i++) {
                    const candidate = path.join(dir, 'tooling', 'check-no-private-names.js');
                    if (fs.existsSync(candidate)) { checker = candidate; break; }
                    const up = path.dirname(dir);
                    if (up === dir) break;
                    dir = up;
                }
                // The denylist file IS the list; editing it must not trip on itself.
                if (checker && path.resolve(filePath) !== checker) {
                    const listSrc = fs.readFileSync(checker, 'utf8');
                    const quoted = (name) => {
                        const block = listSrc.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\]'));
                        return block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
                    };
                    const digests = new Set(quoted('DIGESTS'));

                    // NAMES comes from a file in whatever repo is being edited, so on a
                    // cloned repo it is attacker text — and it used to be concatenated
                    // into a RegExp unescaped. `const NAMES = ['(a+)+$']` is a
                    // catastrophic-backtracking bomb that would then fire on every
                    // single write.
                    //
                    // ESCAPING is the defence, not rejection. Every metacharacter is
                    // escaped, so `(a+)+$` becomes the literal `\(a\+\)\+\$` — no
                    // backtracking, no bomb. The first version ALSO rejected any entry
                    // containing a metacharacter, and `.` is one: a private project
                    // name is very often a domain (example.io, acme.ai), so that filter
                    // silently removed exactly the entries this hook exists to catch.
                    // It made the hook quieter and less protective at once.
                    //
                    // What survives is the two limits escaping cannot supply: a length
                    // cap per entry and a cap on the alternation's size, so the
                    // alternation itself cannot become the pathology. An empty entry is
                    // dropped too — `a||b` matches at every word boundary, the same
                    // failure the `names.length` guard below exists for.
                    const MAX_NAME_LEN = 64;
                    const MAX_NAMES = 500;
                    const rawNames = quoted('NAMES');
                    const kept = rawNames.filter((n) => n.length > 0 && n.length <= MAX_NAME_LEN);
                    const names = kept
                        .slice(0, MAX_NAMES)
                        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                    // Never report a narrowed denylist as full coverage. A silent skip
                    // turns absent checking into reported checking, which is worse than
                    // no opinion at all. Say WHICH entries went, not just how many —
                    // a bare count cannot be acted on. Each is shown truncated, because
                    // stderr ends up in transcripts and these are private names.
                    const dropped = [
                        ...rawNames.filter((n) => n.length === 0 || n.length > MAX_NAME_LEN)
                            .map((n) => `${n.slice(0, 3)}…(${n.length} chars, over the ${MAX_NAME_LEN} cap)`),
                        ...kept.slice(MAX_NAMES).map((n) => `${n.slice(0, 3)}…(past the ${MAX_NAMES} cap)`),
                    ];
                    if (dropped.length) {
                        process.stderr.write(
                            `pre-tool-filter: ignored ${dropped.length} of ${rawNames.length} denylist `
                            + `entries in ${checker} — those names were NOT checked for in this write: `
                            + `${dropped.slice(0, 10).join(', ')}`
                            + `${dropped.length > 10 ? `, +${dropped.length - 10} more` : ''}\n`);
                    }

                    let hit = null;
                    if (digests.size) {
                        const prefix = (listSrc.match(/const PREFIX = '([^']*)'/) || [, ''])[1];
                        const len = Number((listSrc.match(/const DIGEST_LEN = (\d+)/) || [, 16])[1]);
                        const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
                        const dig = (s) => crypto.createHash('sha256')
                            .update(prefix + norm(s)).digest('hex').slice(0, len);
                        outer:
                        for (const line of content.split('\n')) {
                            const toks = line.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
                            for (let i = 0; i < toks.length; i++) {
                                let joined = '';
                                for (let k = 0; k < 3 && i + k < toks.length; k++) {
                                    joined += toks[i + k];
                                    if (digests.has(dig(joined))) { hit = joined; break outer; }
                                }
                            }
                        }
                    } else if (names.length) {
                        // Legacy plaintext checker. The `names.length` guard matters:
                        // an empty list builds \b()\b, which matches at every word
                        // boundary and would block every write in the repo.
                        const m = new RegExp('\\b(' + names.join('|') + ')\\b', 'i').exec(content);
                        hit = m ? m[1] : null;
                    } else if (!/const (DIGESTS|NAMES) = \[\s*\]/.test(listSrc)) {
                        // Neither format parsed, and it is not a legitimately empty
                        // list — so this hook does not understand this checker and is
                        // covering nothing. Say it; do not report silence as safety.
                        process.stderr.write(
                            `pre-tool-filter: found ${checker} but could not read its denylist in `
                            + `either supported format — this write was NOT checked for private names. `
                            + `Update the plugin, or run the checker directly.\n`);
                    }

                    if (hit) {
                        process.stderr.write(
                            `Blocked: this write puts the private project name "${hit}" into `
                            + `${path.relative(dir, path.resolve(filePath))}, which is a PUBLIC repo.\n`
                            + `Anonymise it (Project A/B/C, keeping the numbers and the product shape), or add\n`
                            + `a reviewed exemption to ALLOW in tooling/check-no-private-names.js.\n`);
                        process.exit(2);
                    }
                }
            }
        } catch (err) {
            process.stderr.write(
                `pre-tool-filter: private-name check skipped (${err.message}); `
                + `tooling/check-no-private-names.js still gates this at validate time\n`);
        }
    }

    // Read file filtering - skip large/generated files
    if (toolName === 'Read') {
        const filePath = toolInput.file_path || '';
        if (filePath) {
            for (const pattern of SKIP_READ_PATTERNS) {
                if (pattern.test(filePath)) {
                    process.stderr.write(`Skipping generated/large file: ${filePath} (use targeted search instead)\n`);
                    process.exit(2);
                }
            }
        }
    }

    // Allow operation
    process.exit(0);
} catch (err) {
    // Hook should never crash - fail closed on error
    process.stderr.write(`pre-tool-filter error (blocking): ${err.message}\n`);
    process.exit(2);
}
