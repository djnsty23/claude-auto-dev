#!/usr/bin/env node
'use strict';
// A skill's shell examples run in SOMEONE ELSE'S session, one Bash call at a
// time. Shell state does not survive between calls, so a path built from a
// variable the skill told the session to assign earlier expands to nothing:
//
//     node "${autodev_core_root}/scripts/deploy-ledger.js"
//     -> Error: Cannot find module '/scripts/deploy-ledger.js'
//
// It fails loudly but names a path that never existed rather than the unset
// variable. `${CLAUDE_PLUGIN_ROOT}` is supplied by the host to every call, which
// is why it is the only unguarded form allowed here.
//
// A different variable is allowed ONLY when the same file proves it is unset-
// safe: it must throw a message naming the variable. core/SKILL.md does this.
//
// Run: node tooling/check-skill-plugin-root.js

const fs = require('fs');
const path = require('path');

// A root argument makes this gate testable against fixture trees. Without one
// it grades this repo. A gate that can only ever grade itself cannot be shown
// to fail, which is the failure mode rule-gate-integrity names first.
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const ALLOWED = 'CLAUDE_PLUGIN_ROOT';

function skillFiles() {
    const out = [];
    const plugins = path.join(ROOT, 'plugins');
    if (!fs.existsSync(plugins)) return out;
    for (const plugin of fs.readdirSync(plugins)) {
        const skills = path.join(plugins, plugin, 'skills');
        if (!fs.existsSync(skills)) continue;
        for (const skill of fs.readdirSync(skills)) {
            const walk = (dir) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const p = path.join(dir, e.name);
                    if (e.isDirectory()) walk(p);
                    else if (e.name.endsWith('.md')) out.push(p);
                }
            };
            const d = path.join(skills, skill);
            if (fs.existsSync(d) && fs.statSync(d).isDirectory()) walk(d);
        }
    }
    return out;
}

// `${VAR}/` or `$VAR/` immediately followed by a path segment that looks like a
// shipped plugin file. Anchoring on the following path is what keeps ordinary
// prose variables out of the population.
const EXPANSION = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?\/(scripts|hooks|agents|skills)\//g;

// The same mistake in a javascript fence, where it is a free identifier rather
// than a shell expansion: `join(someRoot, 'scripts', ...)`. A member expression
// such as `process.env.CLAUDE_PLUGIN_ROOT` has a dot and so never matches here,
// which is what makes the allowed form pass without a special case.
const JOINED = /\bjoin\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*['"](scripts|hooks|agents|skills)['"]/g;

function guardsVariable(text, name) {
    // A guard must name the variable AND raise. Both, in one construct.
    const guard = new RegExp(
        'if\\s*\\(\\s*!\\s*process\\.env\\.' + name + '\\s*\\)[^\\n]*throw', 'i'
    );
    return guard.test(text);
}

const files = skillFiles();
const violations = [];
let expansions = 0;

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        for (const re of [EXPANSION, JOINED]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(line))) {
                expansions++;
                const name = m[1];
                if (name === ALLOWED) continue;
                if (guardsVariable(text, name)) continue;
                violations.push({ rel, line: i + 1, name, text: line.trim() });
            }
        }
    });
}

const scanned = `${files.length} skill markdown file(s), ${expansions} plugin-path expansion(s)`;

if (!files.length || !expansions) {
    console.error(`check:skill-plugin-root INDETERMINATE — scanned ${scanned}.`);
    console.error('  Nothing to grade. A pass on an empty population is not a pass.');
    process.exitCode = 2;
    return;
}

if (!violations.length) {
    console.log(`check:skill-plugin-root OK — ${scanned}; every one resolves through \${${ALLOWED}} or a variable its own file guards.`);
    process.exitCode = 0;
    return;
}

for (const v of violations) {
    console.error(`FAIL ${v.rel}:${v.line} — \$${v.name} is neither \${${ALLOWED}} nor guarded in this file.`);
    console.error(`  ${v.text}`);
}
console.error(`\n${violations.length} of ${expansions} plugin-path expansion(s) across ${files.length} skill markdown file(s) resolve from a variable nothing sets: empty in a fresh shell call, undefined in a fresh javascript context.`);
console.error(`Use \${${ALLOWED}} (the host sets it per call), or guard the variable with a throw that names it.`);
process.exitCode = 1;
