#!/usr/bin/env node
/**
 * bump.js — propagate VERSION into every file that must agree with it.
 *
 * VERSION is the single source of truth. Before 8.0 the version was smeared
 * across nine files and kept in step by platform-specific sed branches; now
 * there are five JSON files and one writer. It also regenerates AGENTS.md,
 * whose banner carries the version.
 *
 * Usage: node tooling/bump.js <x.y.z>
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const version = process.argv[2];

if (!version) {
  console.error('Usage: node tooling/bump.js <x.y.z>');
  console.error(`Current: ${fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()}`);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Error: version must be x.y.z (got: ${version})`);
  process.exit(1);
}

const oldVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
console.log(`Bumping ${oldVersion} → ${version}\n`);

function patchJSON(relPath, mutate) {
  const full = path.join(ROOT, relPath);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  mutate(json);
  fs.writeFileSync(full, JSON.stringify(json, null, 2) + '\n');
  console.log(`  ${relPath}`);
}

fs.writeFileSync(path.join(ROOT, 'VERSION'), version + '\n');
console.log('  VERSION');

patchJSON('package.json', (j) => { j.version = version; });
patchJSON('.claude-plugin/marketplace.json', (j) => {
  j.metadata = j.metadata || {};
  j.metadata.version = version;
});

for (const p of fs.readdirSync(path.join(ROOT, 'plugins'))) {
  const rel = path.join('plugins', p, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(path.join(ROOT, rel))) {
    patchJSON(rel, (j) => { j.version = version; });
  }
}

// AGENTS.md carries the version in its banner, so a bump that skips it leaves
// check:agents-md red. Every release before 8.177.0 regenerated it by hand.
const { spawnSync } = require('child_process');
const gen = spawnSync(process.execPath, [path.join(ROOT, 'tooling', 'generate-agents-md.js'), '--write'], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true,
});
if (gen.status !== 0) {
  console.error(`\nError: generate-agents-md.js --write exited ${gen.status}\n${gen.stderr || gen.stdout}`);
  process.exitCode = 1;
} else {
  console.log('  AGENTS.md');
}

console.log('\nNext:');
console.log(`  1. Add a ## [${version}] section to CHANGELOG.md`);
console.log('  2. node tooling/validate.js');
// Annotated: a lightweight tag carries no date or tagger, and check-release-lag
// reads one as red. 8.178.0 and 8.179.0 shipped lightweight from this line.
console.log(`  3. git tag -a v${version} -m "v${version}"`);
// Installs pin to the stable branch (README), so moving it is what ships the
// version. A plain push, never forced: the branch only ever moves forward.
// Not `release`: origin keeps the old release/<version> PR branches, and a
// branch cannot share its name with a ref directory (refname conflict).
console.log(`  4. once the tagged commit is on main: git push origin v${version} v${version}^{commit}:refs/heads/stable`);
