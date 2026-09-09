#!/usr/bin/env node
// Project Claude plugin declarations into the separately selected Codex manifest.
// This validates generated files and command transport, NOT native hook admission.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NATIVE = 'rust-v0.153.4';
const EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact',
  'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart',
  'SubagentStop', 'Stop', 'Interrupt']);
const PREFIX = '${CLAUDE_PLUGIN_ROOT}/';
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const digest = (x) => crypto.createHash('sha256').update(x).digest('hex');
const object = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function fail(message) { throw new Error(message); }
function keys(value, allowed, label) {
  if (!object(value)) fail(`${label}: expected object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}: unsupported field ${key}`);
}
function commandFor(args) {
  // No root placeholder appears in this shell string. Codex substitutes such
  // placeholders BEFORE shell parsing, so even quoting the placeholder fails
  // for roots containing $ or command substitutions. Only constant JS and a
  // base64 argv literal enter the shell. Dynamic roots are read inside Node.
  const encoded = Buffer.from(JSON.stringify(args)).toString('base64');
  const script = `const a=JSON.parse(Buffer.from('${encoded}','base64').toString('utf8')),r=process.env.PLUGIN_ROOT;if(!r||!require('node:path').isAbsolute(r))throw Error('Missing or non-absolute PLUGIN_ROOT');const s=require('node:child_process').spawnSync(process.execPath,a.map(x=>x.split(String.fromCharCode(36)+'{CLAUDE_PLUGIN_ROOT}').join(r)),{stdio:'inherit',windowsHide:true});if(s.error)console.error('autodev Codex hook spawn: '+s.error.code);process.exitCode=Number.isInteger(s.status)?s.status:1;`;
  return `node -e "${script}"`;
}
function project(root, nextVersion) {
  const version = nextVersion || fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('VERSION must be x.y.z');
  const plugins = fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
    .filter((x) => x.isDirectory() && !x.name.startsWith('.')).map((x) => x.name).sort();
  if (!plugins.length) fail('No plugins: refusing an empty projection');
  const files = new Map();
  for (const plugin of plugins) {
    const rel = `plugins/${plugin}`;
    const pluginRoot = path.join(root, rel);
    const manifestText = fs.readFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8');
    const sourceManifest = JSON.parse(manifestText);
    keys(sourceManifest, ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'userConfig'], `${rel}/.claude-plugin/plugin.json`);
    if (sourceManifest.name !== plugin || (!nextVersion && sourceManifest.version !== version) || typeof sourceManifest.description !== 'string') {
      fail(`${rel}: Claude name/version/description must match plugin and VERSION before generation`);
    }
    const inputPath = path.join(pluginRoot, 'hooks/hooks.json');
    const inputText = fs.existsSync(inputPath) ? fs.readFileSync(inputPath, 'utf8') : null;
    const input = inputText === null ? { hooks: {} } : JSON.parse(inputText);
    keys(input, ['hooks', 'modules', 'description'], `${rel}/hooks/hooks.json`);
    if (!object(input.hooks)) fail(`${rel}: hooks must be an object`);
    if (input.modules !== undefined && (!Array.isArray(input.modules) || input.modules.some((x) => typeof x !== 'string'))) fail(`${rel}: modules must be a string array`);
    const hooks = {};
    const unsupported = [];
    const limitations = [];
    const scriptHashes = {};
    let sourceHandlers = 0;
    let projectedHandlers = 0;
    for (const [event, groups] of Object.entries(input.hooks)) {
      if (!Array.isArray(groups)) fail(`${rel}/${event}: expected groups array`);
      const projectedGroups = [];
      for (const [groupIndex, group] of groups.entries()) {
        keys(group, ['matcher', 'hooks'], `${rel}/${event}/${groupIndex}`);
        if (group.matcher !== undefined && typeof group.matcher !== 'string') fail(`${rel}/${event}: matcher must be string`);
        if (!Array.isArray(group.hooks) || !group.hooks.length) fail(`${rel}/${event}: hooks must be nonempty`);
        const projected = [];
        for (const [handlerIndex, hook] of group.hooks.entries()) {
          const label = `${rel}/${event}/${groupIndex}/${handlerIndex}`;
          keys(hook, ['type', 'command', 'args', 'timeout', 'statusMessage'], label);
          if (hook.type !== 'command' || hook.command !== 'node' || !Array.isArray(hook.args) || !hook.args.length || hook.args.some((x) => typeof x !== 'string' || x.includes('\0'))) fail(`${label}: only explicit node + string argv is supported`);
          if (!hook.args[0].startsWith(PREFIX)) fail(`${label}: script must start with CLAUDE_PLUGIN_ROOT`);
          const relative = hook.args[0].slice(PREFIX.length);
          if (!/^[a-zA-Z0-9_./-]+\.js$/.test(relative) || relative.split('/').some((x) => x === '..' || x === '' || x === '.')) fail(`${label}: invalid script path`);
          const scriptPath = path.join(pluginRoot, relative);
          if (!fs.statSync(scriptPath).isFile() || !fs.realpathSync(scriptPath).startsWith(fs.realpathSync(pluginRoot) + path.sep)) fail(`${label}: script must exist inside plugin`);
          scriptHashes[relative] = digest(fs.readFileSync(scriptPath));
          for (const arg of hook.args) if (/\$\{(?!CLAUDE_PLUGIN_ROOT\})/.test(arg)) fail(`${label}: unsupported argument placeholder`);
          if (hook.timeout !== undefined && (!Number.isSafeInteger(hook.timeout) || hook.timeout < 1)) fail(`${label}: invalid timeout`);
          if (hook.statusMessage !== undefined && typeof hook.statusMessage !== 'string') fail(`${label}: invalid statusMessage`);
          sourceHandlers++;
          if (!EVENTS.has(event)) {
            unsupported.push({ event, group: groupIndex, handler: handlerIndex, matcher: group.matcher ?? null, source: hook, reason: `${NATIVE} does not declare this event` });
            continue;
          }
          const target = { type: 'command', command: commandFor(hook.args) };
          if (hook.timeout !== undefined) target.timeout = hook.timeout;
          if (event === 'SessionEnd' && (hook.timeout === undefined || hook.timeout > 3)) {
            target.timeout = 3;
            limitations.push({ event, script: relative, sourceTimeout: hook.timeout ?? null, codexTimeout: 3, status: 'completion within native budget unverified' });
          }
          if (hook.statusMessage !== undefined) target.statusMessage = hook.statusMessage;
          projected.push(target);
          projectedHandlers++;
        }
        if (projected.length) projectedGroups.push({ ...(group.matcher === undefined ? {} : { matcher: group.matcher }), hooks: projected });
      }
      if (projectedGroups.length) hooks[event] = projectedGroups;
    }
    const modules = input.modules || [];
    const gaps = `${unsupported.length} unsupported event handler(s), ${modules.length} unavailable function module(s)`;
    const description = `Generated Codex projection (${NATIVE}); native admission incomplete: ${gaps}. Tool matcher/payload and timeout semantics require host canaries. See .codex-plugin/capabilities.json.`;
    const manifest = { name: plugin, version, description: `${sourceManifest.description} Codex hook admission incomplete; see .codex-plugin/capabilities.json.` };
    if (inputText !== null) manifest.hooks = './hooks/codex.json';
    files.set(`${rel}/.codex-plugin/plugin.json`, json(manifest));
    files.set(`${rel}/.codex-plugin/capabilities.json`, json({
      schemaVersion: 1, generatedBy: 'tooling/generate-codex-packages.js', nativeSchema: NATIVE,
      plugin, version, admission: 'unverified', sourceManifestSha256: digest(manifestText),
      sourceHooksSha256: inputText === null ? null : digest(inputText), sourceScriptsSha256: scriptHashes, sourceHandlers, projectedHandlers,
      knownProtectionGaps: plugin === 'autodev-core' ? [
        'Native apply_patch protected-path checks do not enforce workspace ownership or cover other write tools and racing filesystem changes',
        'Native apply_patch content/private-name and lint/format-config protections are unavailable',
        'Custom CODEX_HOME installation paths not named .codex are not identified by the protected-path patterns',
        'Native exec_command requested workdir is absent from hook input while cwd is the thread cwd; coordinator-write-guard needs independently admitted filesystem containment and must not substitute hook cwd for execution workdir',
      ] : [],
      unsupportedEventHandlers: unsupported,
      unavailableFunctionModules: modules.map((source) => ({ source, reason: 'Codex hook manifest does not accept Claude modules; source is preserved for Claude' })),
      timeoutLimitations: limitations,
      unsupportedUserConfigKeys: Object.keys(sourceManifest.userConfig || {}).sort(),
      remainingChecks: ['Actual installed candidate identity and hook trust',
        ...(plugin === 'autodev-core' ? ['Generated pre-tool-filter apply_patch registration and exact runtime protected/ordinary path controls on the target host', 'Native worker filesystem containment for the actual sandbox policy, approval policy, writable roots and runtime version; hook cwd does not identify requested exec_command workdir'] : []),
        'Native hooks: blocking, side effects, cancellation and timeout completion', 'Windows command-shell execution has not been measured'],
    }));
    if (inputText !== null) files.set(`${rel}/hooks/codex.json`, json({ description, hooks }));
  }
  return files;
}
function sync(root, write = false) {
  const files = project(root); // Validate ALL inputs before any write.
  const mismatches = [];
  for (const [relative, expected] of files) {
    const file = path.join(root, relative);
    if (write) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, expected); }
    else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) mismatches.push(relative);
  }
  if (mismatches.length) fail(`Codex package drift in ${mismatches.length}/${files.size} generated files: ${mismatches.join(', ')}. Run node tooling/generate-codex-packages.js --write`);
  return files.size;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--check', '--write'].includes(args[0]))) {
    console.error('Usage: node tooling/generate-codex-packages.js [--check|--write]'); process.exitCode = 2;
  } else {
    try { const n = sync(path.resolve(__dirname, '..'), args[0] === '--write'); console.log(`Codex projection: ${n}/${n} generated files ${args[0] === '--write' ? 'written' : 'match'}; native admission remains unverified`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { commandFor, project, sync };
