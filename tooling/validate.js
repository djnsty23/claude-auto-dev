#!/usr/bin/env node
/**
 * validate.js — consistency checker for the autodev plugin marketplace.
 *
 * Checks the invariants the plugin layout depends on and nothing else. The
 * pre-8.0 validator policed a hand-maintained skills/manifest.json that no
 * runtime ever read; those checks are gone with the manifest.
 *
 * Usage: node tooling/validate.js
 * Exit codes: 0 = pass, 1 = at least one FAIL
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function log(status, message) {
  console.log(`[${status}] ${message}`);
  if (status === 'PASS') passCount++;
  else if (status === 'FAIL') failCount++;
  else if (status === 'WARN') warnCount++;
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    log('FAIL', `${path.relative(ROOT, p)}: ${e.message}`);
    return null;
  }
}

function parseFrontmatter(content) {
  const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  let currentKey = null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const raw = kv[2].trim();
      fm[currentKey] = raw === '' ? [] : raw.replace(/^["']|["']$/g, '');
    } else if (currentKey && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
    }
  }
  return fm;
}

function pluginDirs() {
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    // Dot-directories are never plugins or skills. The telemetry hook
    // writes `.claude/reports/` relative to process.cwd(), so any session
    // whose shell has cd'd in here plants one - and without this filter
    // validate reports it as "skill directory has no SKILL.md", failing the
    // gate for a file nobody committed. [measured 2026-08-24]
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

function skillDirs(plugin) {
  const d = path.join(PLUGINS_DIR, plugin, 'skills');
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

// ---------------------------------------------------------------- checks

function checkVersionSync() {
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const sources = [['package.json', readJSON(path.join(ROOT, 'package.json'))?.version]];

  const marketplace = readJSON(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  sources.push(['marketplace.json', marketplace?.metadata?.version]);

  for (const p of pluginDirs()) {
    const manifest = readJSON(path.join(PLUGINS_DIR, p, '.claude-plugin', 'plugin.json'));
    sources.push([`${p}/plugin.json`, manifest?.version]);
  }

  let ok = true;
  for (const [label, found] of sources) {
    if (found !== version) {
      log('FAIL', `Version drift: VERSION is ${version} but ${label} is ${found}`);
      ok = false;
    }
  }
  if (ok) log('PASS', `Version sync: ${version} across ${sources.length + 1} files`);
}

function checkMarketplace() {
  const mp = readJSON(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  if (!mp) return;

  if (!mp.name) log('FAIL', 'marketplace.json: missing required field "name"');
  if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) {
    log('FAIL', 'marketplace.json: "plugins" must be a non-empty array');
    return;
  }

  const onDisk = new Set(pluginDirs());
  const listed = new Set();
  let ok = true;

  for (const entry of mp.plugins) {
    if (!entry.name || !entry.source) {
      log('FAIL', `marketplace.json: plugin entry needs both name and source: ${JSON.stringify(entry)}`);
      ok = false;
      continue;
    }
    listed.add(entry.name);

    const src = path.resolve(ROOT, entry.source);
    if (!fs.existsSync(src)) {
      log('FAIL', `marketplace.json: ${entry.name} source does not exist: ${entry.source}`);
      ok = false;
      continue;
    }
    const manifest = readJSON(path.join(src, '.claude-plugin', 'plugin.json'));
    if (manifest && manifest.name !== entry.name) {
      log('FAIL', `marketplace.json: ${entry.name} source manifest is named "${manifest.name}"`);
      ok = false;
    }
  }

  for (const d of onDisk) {
    if (!listed.has(d)) {
      log('FAIL', `plugins/${d} exists on disk but is not listed in marketplace.json`);
      ok = false;
    }
  }

  if (ok) log('PASS', `Marketplace: ${mp.plugins.length} plugins listed and resolvable`);
}

function checkPluginManifests() {
  for (const p of pluginDirs()) {
    const dir = path.join(PLUGINS_DIR, p);
    const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');

    if (!fs.existsSync(manifestPath)) {
      log('FAIL', `plugins/${p}: missing .claude-plugin/plugin.json`);
      continue;
    }
    const manifest = readJSON(manifestPath);
    if (!manifest) continue;

    if (manifest.name !== p) {
      log('FAIL', `plugins/${p}: manifest name "${manifest.name}" does not match directory`);
      continue;
    }

    // Component dirs must sit at the plugin root, never inside .claude-plugin/.
    for (const stray of ['skills', 'agents', 'hooks', 'commands', 'scripts']) {
      if (fs.existsSync(path.join(dir, '.claude-plugin', stray))) {
        log('FAIL', `plugins/${p}: ${stray}/ must live at the plugin root, not inside .claude-plugin/`);
      }
    }

    log('PASS', `plugins/${p}: manifest valid`);
  }
}

function checkSkillFrontmatter() {
  let total = 0;
  let ok = true;

  for (const p of pluginDirs()) {
    for (const name of skillDirs(p)) {
      const file = path.join(PLUGINS_DIR, p, 'skills', name, 'SKILL.md');
      const rel = `plugins/${p}/skills/${name}/SKILL.md`;

      if (!fs.existsSync(file)) {
        log('FAIL', `${rel}: skill directory has no SKILL.md`);
        ok = false;
        continue;
      }
      total++;

      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      if (!fm) {
        log('FAIL', `${rel}: no YAML frontmatter`);
        ok = false;
        continue;
      }
      if (!fm.description) {
        log('FAIL', `${rel}: missing required "description"`);
        ok = false;
      }
      if (fm.name && fm.name !== name) {
        log('FAIL', `${rel}: name "${fm.name}" does not match directory "${name}"`);
        ok = false;
      }
      if (fm.triggers) {
        log('FAIL', `${rel}: "triggers" is not a Claude Code frontmatter field — use when_to_use`);
        ok = false;
      }
      // "Always-on" is a claim about LOADING, and loading needs a trigger.
      // A skill that is not user-invocable and declares no `paths:` glob loads
      // only when the model chooses to call it. That is model-invoked, not
      // always-on, and saying otherwise converts absent coverage into reported
      // coverage — a reader stops asking whether the rule was in context.
      //
      // `[measured 2026-08-24]` 12 skills claimed "Always-on"; 3 declared a
      // paths glob; 9 had no trigger of any kind. Among the 9 were
      // rule-gate-integrity, rule-diagnosis and rule-verification — the three
      // that describe this exact failure. Across 212 transcripts, rule-* skills
      // were explicitly invoked 3 times in total.
      const alwaysOn = /always-on/i.test(String(fm.when_to_use || ''));
      const hasPathTrigger = Array.isArray(fm.paths) && fm.paths.length > 0;
      if (alwaysOn && !hasPathTrigger) {
        log('FAIL', `${rel}: when_to_use claims "Always-on" but declares no "paths:" trigger — nothing loads it automatically. Say when to load it instead.`);
        ok = false;
      }

      // Both invocation paths off makes a skill unreachable by anyone.
      //
      // The second conjunct used to be `disable-model-invocation === 'true'`,
      // and that field appears ZERO times anywhere in plugins/ — so this gate
      // could not fire, and had never fired. It read as coverage of exactly the
      // defect it could not see. `[measured 2026-08-25]` a sweep found NINE
      // skills in the real shape: user-invocable:false with no paths glob, so
      // no user can type them and no file read loads them. Among them were
      // rule-verification, rule-gate-integrity and rule-diagnosis — the three
      // skills that exist to describe this failure.
      //
      // Model-invocation is still possible in principle, via the skill listing.
      // It is not a delivery route you can rely on: that listing is budget-
      // capped at ~1% of the context window, descriptions are dropped
      // least-invoked-first, and `[measured]` all ~56 autodev-core skills
      // currently arrive as bare names with no description at all. A trigger
      // that depends on text the harness has already discarded is not a trigger.
      //
      // So: a skill must be typeable, or loadable from a path. One or the other.
      if (String(fm['user-invocable']) === 'false' && !hasPathTrigger) {
        log('FAIL', `${rel}: user-invocable:false and no "paths:" glob — no user can type it and no file read loads it. Add a paths glob, or set user-invocable:true.`);
        ok = false;
      }
    }
  }

  if (ok) log('PASS', `Skill frontmatter: ${total} skills validated`);
}

/**
 * A skill that points at another skill by name must point at one that exists.
 *
 * `[measured 2026-08-25]` The `phase` skill shipped four names resolving to
 * nothing: `fix`, `pr-review`, `deploy` and `clean`. Its whole subject is that
 * an unreachable skill is indistinguishable from an absent one, so a dead
 * pointer inside it is the exact failure it was written to describe. Nothing
 * here caught it: checkSkillFrontmatter validates a skill against itself, and
 * checkScriptReferences resolves plugin-relative FILE paths only.
 *
 * Scope is deliberately narrow. It reads lines beginning `Existing:` plus the
 * line after, that being the one convention in this tree for listing sibling
 * skills. So it covers whatever adopts that convention and nothing else, which
 * is why it prints the file count it scanned and reports NOT CHECKED rather
 * than PASS when it finds none. A gate with no subject that says PASS turns
 * absent coverage into reported coverage.
 *
 * EXTERNAL_SKILLS holds names that are real but live in the harness rather than
 * this repo. Keep it short and justify each entry; a long allowlist is how a
 * gate loses the ability to fail.
 */
const EXTERNAL_SKILLS = new Set([
  'artifact-design',  // Anthropic built-in, cited by the design phase
]);

function checkSkillCrossReferences() {
  let filesScanned = 0;
  let namesChecked = 0;
  let ok = true;

  const known = new Set();
  for (const plug of pluginDirs()) for (const name of skillDirs(plug)) known.add(name);

  for (const plug of pluginDirs()) {
    for (const name of skillDirs(plug)) {
      const file = path.join(PLUGINS_DIR, plug, 'skills', name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const rel = 'plugins/' + plug + '/skills/' + name + '/SKILL.md';
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

      let touched = false;
      for (let i = 0; i < lines.length; i++) {
        if (!/^Existing:/.test(lines[i])) continue;
        touched = true;
        // The convention wraps. A line-oriented probe cannot see a list that
        // spans lines, so read the continuation line as part of the same block.
        const block = lines[i] + ' ' + (lines[i + 1] || '');
        for (const m of block.matchAll(/`([^`]+)`/g)) {
          const ref = m[1].replace(/^\//, '').trim();
          if (!ref) continue;
          namesChecked++;
          if (!known.has(ref) && !EXTERNAL_SKILLS.has(ref)) {
            log('FAIL', rel + ': lists "' + ref + '" as an existing skill, and no skill by that name exists in any plugin. Remove it, or add it to EXTERNAL_SKILLS in validate.js with the reason.');
            ok = false;
          }
        }
      }
      if (touched) filesScanned++;
    }
  }

  if (filesScanned === 0) {
    log('FAIL', 'Skill cross-references: NOT CHECKED - no SKILL.md carries an "Existing:" line, so this gate had no subject. That is not a pass.');
    return;
  }
  if (ok) log('PASS', 'Skill cross-references: ' + namesChecked + ' name(s) across ' + filesScanned + ' file(s) resolve to a real skill');
}

function checkHookWiring() {
  const VALID_EVENTS = new Set([
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact',
    'SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest',
    // InstructionsLoaded fires per CLAUDE.md / .claude/rules file as it reaches
    // context, carrying file_path, load_reason and file_content. Its exit code is
    // ignored by the harness, so a hook on it can observe and never block.
    'InstructionsLoaded',
  ]);

  for (const p of pluginDirs()) {
    const hooksFile = path.join(PLUGINS_DIR, p, 'hooks', 'hooks.json');
    if (!fs.existsSync(hooksFile)) continue;

    const cfg = readJSON(hooksFile);
    if (!cfg) continue;

    let count = 0;
    let ok = true;

    for (const [event, groups] of Object.entries(cfg.hooks || {})) {
      if (!VALID_EVENTS.has(event)) {
        log('FAIL', `plugins/${p}/hooks/hooks.json: unknown hook event "${event}"`);
        ok = false;
      }
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          count++;
          // Exec form (Claude Code 2.1.139+) puts the executable in `command`
          // and the rest in `args`; ${CLAUDE_PLUGIN_ROOT} is substituted in both.
          // [measured 2026-08-30, CC 2.1.239] `args` without `command` is rejected
          // by `claude plugin validate`, so `command` is always present. Joining
          // the two is inert for shell-form hooks, which carry no args.
          const cmd = [hook.command || '', ...(hook.args || [])].join(' ');
          if (!cmd.includes('${CLAUDE_PLUGIN_ROOT}')) {
            log('FAIL', `plugins/${p}: ${event} hook does not use \${CLAUDE_PLUGIN_ROOT}: ${cmd}`);
            ok = false;
            continue;
          }
          const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/);
          if (m && !fs.existsSync(path.join(PLUGINS_DIR, p, m[1]))) {
            log('FAIL', `plugins/${p}: ${event} hook points at a missing file: ${m[1]}`);
            ok = false;
          }
        }
      }
    }

    if (ok) log('PASS', `plugins/${p}: ${count} hooks wired to existing files`);
  }
}

function checkScriptReferences() {
  let ok = true;
  let checked = 0;

  for (const p of pluginDirs()) {
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf8');
          const rel = path.relative(ROOT, full);

          // A skill must not reach into the old global install location.
          if (/~\/\.claude\/(scripts|hooks|skills|agents)\//.test(content)) {
            log('FAIL', `${rel}: references the pre-8.0 global install path (~/.claude/...)`);
            ok = false;
          }

          for (const m of content.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) {
            checked++;
            if (!fs.existsSync(path.join(PLUGINS_DIR, p, m[1]))) {
              log('FAIL', `${rel}: \${CLAUDE_PLUGIN_ROOT}/${m[1]} does not exist in this plugin`);
              ok = false;
            }
          }
        }
      }
    };
    walk(path.join(PLUGINS_DIR, p));
  }

  if (ok) log('PASS', `Script references: ${checked} plugin-relative paths resolve`);
}

// Shell snippets inside skills run in the user's shell, which is often zsh.
// An unquoted glob in a flag value (`--include=*.tsx`) is expanded by zsh before
// grep sees it, and when nothing matches in the current directory zsh errors the
// whole command. The failure is silent in a pipeline: counts come back 0 and a
// skill that measures a codebase reports that it found nothing.
function checkShellGlobQuoting() {
  const OFFENDERS = [
    { re: /--include=(?!['"])\S*\*/g, hint: "--include=*.ext must be quoted: --include='*.ext'" },
    { re: /--exclude=(?!['"])\S*\*/g, hint: "--exclude=*.ext must be quoted: --exclude='*.ext'" },
    { re: /--exclude-dir=(?!['"])\S*\*/g, hint: "--exclude-dir must be quoted when it contains a glob" },
  ];

  let ok = true;
  let scanned = 0;

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        scanned++;
        const content = fs.readFileSync(full, 'utf8');
        const rel = path.relative(ROOT, full);
        content.split('\n').forEach((line, i) => {
          for (const { re, hint } of OFFENDERS) {
            re.lastIndex = 0;
            if (re.test(line)) {
              log('FAIL', `${rel}:${i + 1}: ${hint}`);
              ok = false;
            }
          }
        });
      }
    }
  };
  walk(PLUGINS_DIR);

  if (ok) log('PASS', `Shell glob quoting: ${scanned} docs clean`);
}

function checkAgents() {
  for (const p of pluginDirs()) {
    const dir = path.join(PLUGINS_DIR, p, 'agents');
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    let ok = true;

    for (const file of files) {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!fm) {
        log('FAIL', `plugins/${p}/agents/${file}: no frontmatter`);
        ok = false;
        continue;
      }
      for (const field of ['name', 'description']) {
        if (!fm[field]) {
          log('FAIL', `plugins/${p}/agents/${file}: missing required field "${field}"`);
          ok = false;
        }
      }
      const expected = file.replace(/\.md$/, '');
      if (fm.name && fm.name !== expected) {
        log('FAIL', `plugins/${p}/agents/${file}: name "${fm.name}" does not match filename`);
        ok = false;
      }
    }

    if (ok && files.length) log('PASS', `plugins/${p}: ${files.length} agents validated`);
  }
}

function checkNoLegacyArtifacts() {
  const gone = [
    'install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1',
    'scripts/sync.js', 'scripts/uninstall.js', 'skills/manifest.json',
  ];
  let ok = true;
  for (const f of gone) {
    if (fs.existsSync(path.join(ROOT, f))) {
      log('FAIL', `${f} still exists — the copy-based installer was removed in 8.0`);
      ok = false;
    }
  }
  if (ok) log('PASS', 'No pre-8.0 installer artifacts remain');
}

// This repo is public and the codebases it learned from are not. Delegates to
// the dedicated checker so there is exactly one denylist, not a copy here that
// drifts from it.
// No tracked file may carry anyone's home directory. This repo is PUBLIC, and
// checkNoPrivateNames protects project NAMES rather than paths -- a home
// directory is neither a name nor a secret, so nothing was looking at it.
// A generator added 2026-08-25 wrote one into a committed RESUME.md and it
// survived the whole suite.
// Both checks below used to report only "run the checker yourself". That is
// fine on a laptop and useless in CI, where nobody can re-run it and the log is
// the whole record. 2026-08-30: check-no-private-names FAILED on ubuntu and
// windows while passing locally on the same commit, and the run log carried
// exactly one line about it, naming no file. The checkers already know the file
// and the line; validate was throwing both away.
//
// The matched TEXT is still never printed, and that suppression is the point
// rather than an oversight. These two checks exist to keep private names and
// home paths out of a PUBLIC repo, and a public CI log is one more place they
// must not appear. A location is not a secret; the line it points at is.
const LOC_CAP = 12;

function locationsFrom(output, re) {
  // Keyed by location so a repeated line is counted once, valued by the kind the
  // checker assigned it, which is blank for a checker that reports only one.
  const seen = new Map();
  // Strip CR before matching. The child's output is CRLF on Windows, so a `$`
  // anchor would otherwise never match and every location would be dropped -
  // silently, and only on one platform.
  for (const m of String(output || '').replace(/\r/g, '').matchAll(re)) {
    const g = m.groups || {};
    seen.set(`${g.rel}:${g.ln}`, g.kind || '');
  }
  return [...seen].map(([loc, kind]) => ({ loc, kind }));
}

function reportLocations(what, found, script) {
  if (!found.length) {
    // Parsing nothing out of a FAILING checker is not a clean result, and
    // staying quiet here would rebuild the exact defect this code removes.
    // Say the parse failed, loudly, rather than printing a bare verdict.
    return log('FAIL', `${what}, and validate could not parse any location from the `
      + `checker output. Run node ${script}`);
  }
  // Report the kind the checker actually assigned rather than the one this
  // function is named after. check-no-private-names reports home paths too, and
  // saying "a private project name appears" over six home-path findings sent a
  // reader looking for the wrong thing entirely - which is what happened on
  // 2026-08-30, where all six were home paths and none was a name.
  const kinds = [...new Set(found.map((f) => f.kind).filter(Boolean))];
  const headline = kinds.length
    ? `${found.length} finding(s) in tracked files `
      + `(${kinds.map((k) => `${found.filter((f) => f.kind === k).length} ${k}`).join(', ')})`
    : `${what} in ${found.length} place(s)`;
  const locs = found.map((f) => f.loc);
  const more = locs.length > LOC_CAP ? ` (+${locs.length - LOC_CAP} more)` : '';
  log('FAIL', `${headline}: ${locs.slice(0, LOC_CAP).join(', ')}${more}. `
    + `Run node ${script} to see the offending lines, which are deliberately not printed here`);
}

function checkNoHomePaths() {
  const script = path.join(ROOT, 'tooling', 'check-no-home-paths.js');
  if (!fs.existsSync(script)) return log('WARN', 'check-no-home-paths.js is missing');
  const r = cp.spawnSync(process.execPath, [script], { encoding: 'utf8' });
  if (r.status === 0) return log('PASS', (r.stdout || '').trim().replace(/^\[no-home-paths\]\s*/, 'No home paths: '));
  // That checker prints "  <rel>:<line>  <text>" on stdout. Anchoring on the two
  // spaces that separate location from text is what keeps the text uncaptured.
  reportLocations('a home path appears in a tracked file',
    locationsFrom(`${r.stdout || ''}\n${r.stderr || ''}`, /^ {2}(?<rel>\S[^\n]*?):(?<ln>\d+) {2}/gm),
    'tooling/check-no-home-paths.js');
}

function checkNoPrivateNames() {
  const script = path.join(ROOT, 'tooling', 'check-no-private-names.js');
  if (!fs.existsSync(script)) return log('WARN', 'check-no-private-names.js is missing');
  const r = cp.spawnSync(process.execPath, [script], { encoding: 'utf8' });
  if (r.status === 0) return log('PASS', (r.stdout || '').trim().replace(/^\[no-private-names\]\s*/, 'No private project names: '));
  // That checker prints "  [<kind>] <rel>:<line>" on stderr with the offending
  // line indented on the NEXT line, so an end-of-line anchor separates them.
  // One regex covers both its kinds, private name and absolute home path.
  reportLocations('a private project name appears in a tracked file',
    locationsFrom(`${r.stdout || ''}\n${r.stderr || ''}`, /^ {2}\[(?<kind>[^\]\n]+)\] (?<rel>\S[^\n]*?):(?<ln>\d+)$/gm),
    'tooling/check-no-private-names.js');
}

// A mutation run that did not finish may have left a mutant in a source file.
//
// This is the one defect class no test can catch, by construction: a mutant that
// SURVIVES its suite is precisely one the suite cannot see. On 2026-08-16 three
// of them reached the public remote across four commits — an `if (!x)` shipped
// as `if (true)`, and a dropped negation that outlived the revert because the
// commit I reverted to was contaminated too. test-all, validate and the pre-push
// hook were all green for every one of them.
//
// So this does not look for mutants. It looks for the WINDOW in which one can
// exist: find-vacuous-assertions.js writes <subject>.vacuity-backup before its
// first mutation and removes it only after the final restore is verified. The
// file existing means a run is in progress or died — either way the tree cannot
// be trusted, and neither can a commit made from it.
//
// Zero false positives by construction: nothing else creates this file, and a
// completed run always removes it. Cost is one readdir per plugin directory.
function checkNoStaleMutationBackups() {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.vacuity-backup')) found.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);

  if (!found.length) return log('PASS', 'No interrupted mutation runs (no .vacuity-backup files)');

  log('FAIL', `${found.length} interrupted mutation run(s) — a source file may still be MUTATED:`);
  for (const f of found) {
    const subject = f.replace(/\.vacuity-backup$/, '');
    console.log(`         ${f}`);
    console.log(`         restore with: git checkout -- ${subject} && rm ${f}`);
  }
  console.log('         Check no mutation process is still running first: pkill -9 -f find-vacuous-assertions');
}

// A hook wired into hooks.json that no suite drives.
//
// Now a FAIL. It shipped as a WARN because 5 of 13 hooks were untested, and a
// gate that is red from the moment it ships is a gate people learn to bypass.
// All 5 have suites now, so the debt is zero and the check can hold the line
// instead of just reporting it: a NEW hook wired without a test fails validate,
// and therefore fails the pre-push hook.
//
// If this ever goes red on a wired hook you are not ready to test, put it back
// to WARN in the same commit that wires the hook, rather than deleting the call.
function checkUntestedHooks() {
  const script = path.join(ROOT, 'tooling', 'find-untested-hooks.js');
  if (!fs.existsSync(script)) return log('WARN', 'find-untested-hooks.js is missing');
  // --referenced-only on purpose: the full execution phase runs every candidate
  // suite (~40s), and validate runs inside suites that run inside sweeps - the
  // full phase here blew runSuite timeouts and orphaned suite fixtures. This is
  // the fast STATIC precheck ("referenced", never "driven"); execution evidence
  // is gated by tooling/test-hook-execution-evidence.js in npm test.
  const r = cp.spawnSync(process.execPath, [script, '--json', '--referenced-only'], { encoding: 'utf8' });
  let out;
  try { out = JSON.parse(r.stdout); } catch { return log('WARN', 'find-untested-hooks.js produced no parseable output'); }
  if (!out.untested.length) return log('PASS', `Hook references: all ${out.wired} wired hooks are referenced by a suite (static precheck; execution gated by test-hook-execution-evidence.js)`);
  log('FAIL', `${out.untested.length} of ${out.wired} wired hooks are referenced by no suite — run node tooling/find-untested-hooks.js`);
}

// A hook that spawns a console child without windowsHide can pop a visible
// window on Windows. execSync/exec route through cmd.exe, and Node's windowsHide
// option defaults to FALSE — so a child spawned by a parent that owns no console
// (Claude Desktop is an Electron app) gets a real window. Reported 2026-08-17.
//
// Scoped to hooks/ ON PURPOSE. Hooks are the only spawners that run unattended,
// on every tool call or session start; the ~90 other spawn sites in the repo are
// test suites, which run under `npm test` from a shell that already owns a console
// and would produce ~90 findings that all need waiving. A gate that ships red is
// a gate people learn to bypass (see checkUntestedHooks above).
//
// Prints the population it scanned, so a zero is distinguishable from a probe
// that matched nothing. Verified two-sided by test-validate.js.
function checkHookSpawnsHidden() {
  const hooksDir = path.join(ROOT, 'plugins', 'autodev-core', 'hooks');
  if (!fs.existsSync(hooksDir)) return log('WARN', 'hooks/ not found — spawn scan skipped');

  // execFileSync/spawn with an argv array still creates a console child, so they
  // are scanned too; only the shell-routing forms are inherently cmd.exe-bound.
  const CALL = /\b(execSync|execFileSync|exec|spawnSync|spawn)\s*\(/g;
  const files = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.js'));

  let sites = 0;
  const exposed = [];

  for (const f of files) {
    const src = fs.readFileSync(path.join(hooksDir, f), 'utf8');
    const lines = src.split('\n');
    let m;
    CALL.lastIndex = 0;
    while ((m = CALL.exec(src))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const prefix = src.slice(lineStart, m.index);
      // Skip comments, and skip `re.exec(str)` — a regex method, not a spawn.
      if (prefix.includes('//') || prefix.trimStart().startsWith('*')) continue;
      if (m[1] === 'exec' && /[\w\])]\s*\.\s*$/.test(prefix)) continue;
      sites++;
      const lineNo = src.slice(0, m.index).split('\n').length;
      // The options object can trail the call over several lines; 12 lines covers
      // every shape currently in hooks/ without running into the next call.
      const region = lines.slice(lineNo - 1, lineNo + 11).join('\n');
      if (!/windowsHide:\s*true/.test(region)) {
        exposed.push(`${f}:${lineNo}  ${m[1]}`);
      }
    }
  }

  if (!exposed.length) {
    return log('PASS', `Hook spawns: ${sites} site(s) across ${files.length} hook file(s), all windowsHide:true`);
  }
  log('FAIL', `${exposed.length} of ${sites} hook spawn site(s) can pop a console window (add windowsHide: true):`);
  for (const e of exposed) console.log(`         ${e}`);
}

// A project slug encodes an absolute path with every separator replaced by '-'.
// Reversing it without putting the drive letter back yields a rooted path with
// NO DRIVE, and on Windows that is drive-RELATIVE: it resolves against whatever
// drive the process happens to be on.
//
// That shipped and hid for as long as the code existed. drift-audit found its
// projects when cwd was on C: and missed them from a D: workspace, so the
// Windows CI job discovered zero projects, every finding vanished, and the
// assertions expecting no finding passed vacuously — a green half of a suite
// that was structurally incapable of firing.
//
// Scoped to the slug reversal itself rather than to bare-slash concatenation:
// measured against this tree, a '/' + x scan returned 4 hits and all 4 were
// legitimate (a display key, a substring test, and the two guarded fallbacks).
// This prints its population, so "nothing found" cannot masquerade as "clean".
function checkSlugReversalRestoresDrive() {
  const REVERSAL = /\.replace\(\/-\/g,\s*['"]\/['"]\)/g;
  const DRIVE_RESTORE = /\^\(\[A-Za-z\]\)--/;

  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(PLUGINS_DIR);

  let sites = 0;
  const carriers = [];
  const naked = [];

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = src.match(REVERSAL);
    if (!hits) continue;
    sites += hits.length;
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    carriers.push(rel);
    if (!DRIVE_RESTORE.test(src)) naked.push(rel);
  }

  if (!sites) {
    return log('WARN', `Slug reversal: 0 site(s) found across ${files.length} plugin script(s) — the scan matched nothing, so it proves nothing`);
  }
  if (!naked.length) {
    return log('PASS', `Slug reversal: ${sites} site(s) across ${carriers.length} file(s), all restore the drive letter`);
  }
  log('FAIL', `${naked.length} of ${carriers.length} file(s) reverse a project slug without restoring the drive letter (drive-relative on Windows):`);
  for (const n of naked) console.log(`         ${n}`);
}

// ---------------------------------------------------------------- run

console.log('Validating autodev marketplace...\n');

checkVersionSync();
checkMarketplace();
checkPluginManifests();
checkSkillFrontmatter();
checkSkillCrossReferences();
checkHookWiring();
checkScriptReferences();
checkShellGlobQuoting();
checkAgents();
checkNoLegacyArtifacts();
checkNoPrivateNames();
checkNoHomePaths();
checkNoStaleMutationBackups();
checkUntestedHooks();
checkHookSpawnsHidden();
checkSlugReversalRestoresDrive();

console.log(`\nSummary: ${passCount} PASS, ${failCount} FAIL, ${warnCount} WARN`);
process.exit(failCount > 0 ? 1 : 0);
