#!/usr/bin/env node
'use strict';
// Subprocess suite for plugins/autodev-memory/scripts/memory-export.js.
// Every fixture memory lives under a scratch root passed with --root, and the
// default-roots case runs under a scratch CLAUDE_CONFIG_DIR, so no real memory is read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const subject = process.env.MEMORY_EXPORT_SUBJECT
    || path.resolve(__dirname, '../plugins/autodev-memory/scripts/memory-export.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-export-'));
const mem = path.join(root, 'memory');
const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'cfg') };
let total = 0;
let failed = 0;
function check(name, ok, detail = '') {
    total++;
    if (!ok) failed++;
    console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
}
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
const run = (args) => spawnSync(process.execPath, [subject, ...args], { env, encoding: 'utf8' });
const fm = (name, type, description) => `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: ${type}\n---\n\n`;

// Assembled at runtime so no literal address or number sits in this public file.
const fakeEmail = ['someone', 'example.test'].join('@');
const fakePhone = ['+40', '712', '345', '678'].join(' ');

try {
    write(path.join(mem, 'no-em-dashes.md'), `${fm('no-em-dashes', 'feedback', 'Never use em dashes in prose')}`
        + '`[stated 2026-08-25]` zero em dashes.\n\nRepeated `[stated 2026-08-22]` in chat and files.\n');
    write(path.join(mem, 'side-project.md'), `${fm('side-project', 'project', 'A habit tracker with streaks')}Plain notes, no dates.\n`);
    write(path.join(mem, 'contact.md'), `${fm('contact', 'reference', `Prefers to be reached at ${fakeEmail}`)}Body.\n`);
    write(path.join(mem, 'phone.md'), `${fm('phone', 'user', `Phone is ${fakePhone}`)}Body.\n`);
    write(path.join(mem, 'job.md'), `${fm('job', 'user', 'Runs an analytics agency as founder')}\`[measured 2026-09-10]\` five clients.\n`);
    write(path.join(mem, 'name.md'), `${fm('name', 'user', 'Goes by a short first name')}\`[stated 2026-07-01]\` always the short form.\n`);
    write(path.join(mem, 'tool-url.md'), `${fm('tool-url', 'reference', 'Dashboard lives at a fixed URL')}No taste here.\n`);
    write(path.join(mem, 'hooked.md'), `${fm('hooked', 'project', 'Dated only by its index hook')}No tags.\n`);
    write(path.join(mem, 'MEMORY.md'), '- [Hooked](hooked.md) — 01-15 kickoff, revisited 03-02\n');
    // The index mtime fixes the hook year: 2026-06-01 makes 01-15 read 2026-01-15.
    fs.utimesSync(path.join(mem, 'MEMORY.md'), new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

    let r = run(['--help']);
    check('--help answers and exits 0', r.status === 0 && r.stdout.startsWith('Usage:'), r.stderr);

    r = run(['--root', mem]);
    const out = r.stdout;
    check('default run exits 0', r.status === 0, r.stderr);
    const block = out.split('```');
    check('whole export is one code block', block.length === 3 && out.startsWith('```'), out);
    const order = ['Instructions', 'Identity', 'Career', 'Projects', 'Preferences'].map((c) => block[1].indexOf(`## ${c}`));
    check('five categories in the fixed order', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), order.join(','));
    check('feedback file dated by its earliest of two stated tags',
        block[1].includes('[2026-08-22] - Never use em dashes in prose'), block[1]);
    check('undated project file reads [unknown]',
        block[1].includes('[unknown] - side-project: A habit tracker with streaks'), block[1]);
    check('index hook dates an untagged file by its earliest MM-DD',
        block[1].includes('[2026-01-15] - hooked: Dated only by its index hook'), block[1]);
    check('role keywords route a user file to Career',
        /## Career\n\[2026-09-10\] - Runs an analytics agency as founder/.test(block[1]), block[1]);
    check('a user file without career words goes to Identity',
        /## Identity\n\[2026-07-01\] - Goes by a short first name/.test(block[1]), block[1]);
    check('an always line in a non-feedback body becomes an Instruction',
        /## Instructions[\s\S]*\[2026-07-01\] - `\[stated 2026-07-01\]` always the short form[\s\S]*## Identity/.test(block[1]), block[1]);
    const projects = block[1].split('## Projects')[1].split('## Preferences')[0].trim().split('\n');
    const instructions = block[1].split('## Instructions')[1].split('## Identity')[0];
    check('dated entries sort oldest first',
        instructions.indexOf('[2026-07-01]') >= 0 && instructions.indexOf('[2026-07-01]') < instructions.indexOf('[2026-08-22]'), instructions);
    check('entries sort oldest first, unknown last', projects[0].startsWith('[2026-01-15]') && projects[1].startsWith('[unknown]'), projects.join(' | '));
    check('reference without a stated taste is skipped', !out.includes('fixed URL'), out);
    check('email line withheld by default', !out.includes(fakeEmail), out);
    check('phone line withheld by default', !out.includes(fakePhone), out);
    const last = out.trim().split('\n').pop();
    check('final line says partial and names the withheld kinds',
        last.startsWith('Export: partial') && last.includes('2 withheld for PII') && last.includes('--with-pii'), last);

    r = run(['--root', mem, '--with-pii']);
    check('--with-pii keeps the email line under Preferences',
        /## Preferences\n\[unknown\] - Prefers to be reached at /.test(r.stdout) && r.stdout.includes(fakeEmail), r.stdout);
    check('--with-pii keeps the phone line', r.stdout.includes(fakePhone), r.stdout);
    check('--with-pii final line says complete', r.stdout.trim().split('\n').pop().startsWith('Export: complete'), r.stdout);

    r = run(['--root', mem, '--format', 'json']);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch { /* checked below */ }
    check('json format parses with five categories', j && Object.keys(j.categories).join() === 'Instructions,Identity,Career,Projects,Preferences', r.stdout);
    check('json sources are basenames, never paths', j && Object.values(j.categories).flat().every((e) => !/[\\/]/.test(e.source)), r.stdout);
    check('json withheld counts by kind', j && j.withheld.email === 1 && j.withheld.phone === 1 && j.complete === false, JSON.stringify(j && j.withheld));

    r = run(['--root', mem, '--counts']);
    check('--counts prints counts only', r.status === 0 && /^Instructions: \d+\nIdentity: 1\nCareer: 1\nProjects: 2\nPreferences: 0\nExport: partial/.test(r.stdout) && !r.stdout.includes('habit'), r.stdout);

    // Default roots: <config>/memory plus <config>/projects/*/memory.
    write(path.join(env.CLAUDE_CONFIG_DIR, 'memory', 'g.md'), `${fm('g', 'project', 'Global project')}x\n`);
    write(path.join(env.CLAUDE_CONFIG_DIR, 'projects', 'p1', 'memory', 'p.md'), `${fm('p', 'project', 'Per-project memory')}x\n`);
    r = run([]);
    check('default roots read global and per-project memory', r.status === 0 && r.stdout.includes('g: Global project') && r.stdout.includes('p: Per-project memory'), r.stdout + r.stderr);
    check('clean store says complete', r.stdout.trim().split('\n').pop().startsWith('Export: complete, 2 entries from 2'), r.stdout);

    r = run(['--root', path.join(root, 'missing')]);
    check('no readable root fails visibly with exit 2', r.status === 2 && r.stderr.includes('COULD NOT READ'), r.stderr);
    r = run(['--format', 'xml']);
    check('bad format exits 2', r.status === 2, r.stderr);
    r = run(['--bogus']);
    check('unknown argument exits 2', r.status === 2 && r.stderr.includes('unknown argument'), r.stderr);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`memory-export: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
