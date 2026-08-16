#!/usr/bin/env node
/**
 * bump.js — propagate VERSION into every file that must agree with it.
 *
 * VERSION is the single source of truth. Before 8.0 the version was smeared
 * across nine files and kept in step by platform-specific sed branches; now
 * there are five JSON files and one writer.
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

console.log('\nNext:');
console.log(`  1. Add a ## [${version}] section to CHANGELOG.md`);
console.log('  2. node tooling/validate.js');
console.log(`  3. git tag v${version}`);
