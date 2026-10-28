'use strict';
// Runs the harness2 adoption A/B: each trial is one headless Opus 5.5 call with the user's
// rules loaded (setting-sources user), no tools, no MCP. Resumable: existing results are kept.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { E1, E2, E4 } = require('./fixtures');

const HERE = __dirname;
const REPO = path.resolve(__dirname, '../../..');
// On Windows point CLAUDE_EXE at the claude.exe the npm shim wraps: spawning claude.cmd needs a shell.
const EXE = process.env.CLAUDE_EXE || 'claude';
const OUT = path.join(HERE, 'runs');
const CONCURRENCY = 4;
const read = (p) => fs.readFileSync(p, 'utf8');
const arm = (f) => read(path.join(HERE, 'arms', f));

const abSkill = read(path.join(REPO, 'plugins/autodev-core/skills/rule-ab-testing/SKILL.md')).replace(/^---[\s\S]*?---\n/, '');
const lessonsSkill = read(path.join(os.homedir(), '.claude/skills/lessons/SKILL.md')).replace(/^---[\s\S]*?---\n/, '').split('## Which file, and when')[0];
const learnLine = 'From CLAUDE.md: "Learn: a problem that cost retries gets a one-line rule in `rules/` and its incident in the `lessons` skill." and "Every `rules/*.md` without `paths:` frontmatter loads in every session. Keep that set under 32 KB."';

function e1Prompt(c, armId, rep) {
  const first = rep === 0 ? 'current' : 'proposed';
  const order = first === 'current' ? ['current', 'proposed'] : ['proposed', 'current'];
  const skill = abSkill + (armId === 'B' ? '\n\n' + arm('h2-blind.md') : armId === 'C' ? '\n\n' + arm('h2-criteria-only.md') : '');
  let body;
  if (armId === 'B') {
    body = `Two candidate implementations of the spec are below as X and Y. One is the code as it runs today and the other is a proposed change. You are not told which.\n\n` +
      order.map((k, i) => `## Candidate ${'XY'[i]}\n\`\`\`js\n${c[k]}\n\`\`\``).join('\n\n') +
      `\n\nDecide which candidate ships. End with <why>at most 4 lines</why> and then, as the very last thing:\n\`\`\`choice\nX or Y\n\`\`\``;
  } else {
    body = `The code as it runs today and a proposed change are below.\n\n` +
      order.map((k) => `## ${k === 'current' ? 'CURRENT (runs today)' : 'PROPOSED (the change)'}\n\`\`\`js\n${c[k]}\n\`\`\``).join('\n\n') +
      `\n\nDecide whether to keep CURRENT or adopt PROPOSED. End with <why>at most 4 lines</why> and then, as the very last thing:\n\`\`\`choice\nCURRENT or PROPOSED\n\`\`\``;
  }
  return { prompt: `You follow this skill:\n\n<skill>\n${skill}\n</skill>\n\n# Spec\n${c.spec}\n\n${body}`, meta: { order } };
}

function e2Prompt(c, armId, ruleLine = false) {
  const extra = armId === 'B' ? '\n\n' + arm('h1-entry.md') : '';
  const tail = ruleLine ? '\nRULE_LINE: <the exact text you add to always-on rules in ~/.claude/rules/, or none>' : '';
  return {
    prompt: `You maintain the lessons skill below. ${learnLine}\n\n<skill>\n${lessonsSkill}${extra}\n</skill>\n\n` +
      `Write the lessons entry for this incident${armId === 'B' ? ', following "Writing a new entry"' : ''}.\n\n<incident>\n${c.record}\n</incident>\n\n` +
      `After the entry, end with exactly ${ruleLine ? 'these lines' : 'one line'}:\nATTRIBUTION: <the change id your entry credits with fixing it, or NONE if it credits no single change>${tail}`,
    meta: {},
  };
}

function e4Prompt(c, armId) {
  const extra = armId === 'B' ? '\n\n' + arm('h4-placement.md') : '';
  return {
    prompt: `You file lessons for this harness. ${learnLine}${extra}\n\nDecide where this lesson goes and write what you would add.\n\n<lesson>\n${c.lesson}\n</lesson>\n\n` +
      `End with exactly these three lines:\nHOME: <always-on|skill|script|hook|none>\nALWAYS_ON_TEXT: <the exact text you add to always-on rules, or none>\nCUT: <the exact always-on text you remove or move out, or none>`,
    meta: {},
  };
}

function trials() {
  const t = [];
  for (const c of E1) for (const a of ['A', 'C', 'B']) for (const rep of [0, 1]) t.push({ exp: 'E1', c, a, rep, ...e1Prompt(c, a, rep) });
  for (const c of E2) for (const a of ['A', 'B']) for (const rep of [0, 1]) t.push({ exp: 'E2', c, a, rep, ...e2Prompt(c, a) });
  for (const c of E4) for (const a of ['A', 'B']) for (const rep of [0, 1]) t.push({ exp: 'E4', c, a, rep, ...e4Prompt(c, a) });
  for (const c of require('./fixtures-e2c')) for (const a of ['A', 'B']) for (const rep of [0, 1]) t.push({ exp: 'E2C', c, a, rep, ...e2Prompt(c, a, true) });
  for (const c of require('./fixtures-hard')) for (const a of ['A', 'C', 'B']) for (const rep of [0, 1]) t.push({ exp: 'E1H', c, a, rep, ...e1Prompt(c, a, rep) });
  return t;
}

function call(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', 'claude-opus-5-5', '--effort', 'medium', '--tools', '', '--strict-mcp-config',
      '--setting-sources', 'user', '--no-session-persistence', '--output-format', 'json',
      '--system-prompt', 'You are a careful senior engineer working in this harness. Answer exactly in the requested format.'];
    const p = spawn(EXE, args, { cwd: HERE, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill(), 300000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    p.stdin.end(prompt);
  });
}

async function main() {
  const only = process.argv[2];
  const all = trials().filter((t) => !only || t.exp === only);
  fs.mkdirSync(OUT, { recursive: true });
  const todo = all.filter((t) => !fs.existsSync(path.join(OUT, `${t.exp}.${t.c.id}.${t.a}.${t.rep}.json`)));
  console.log(`trials: ${all.length} total, ${todo.length} to run`);
  let i = 0, done = 0, failed = 0;
  async function worker() {
    while (i < todo.length) {
      const t = todo[i++];
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        r = await call(t.prompt);
        try { const j = JSON.parse(r.out); if (!j.is_error && j.result) { r.json = j; break; } } catch { /* retry once */ }
      }
      const file = path.join(OUT, `${t.exp}.${t.c.id}.${t.a}.${t.rep}.json`);
      if (r.json) {
        fs.writeFileSync(file, JSON.stringify({ exp: t.exp, case: t.c.id, arm: t.a, rep: t.rep, truth: t.c.truth, meta: t.meta, result: r.json.result, cost: r.json.total_cost_usd, usage: r.json.usage }, null, 1));
        done++;
      } else {
        failed++;
        fs.writeFileSync(file + '.err', `exit ${r.code}\n${r.err.slice(0, 2000)}\n${r.out.slice(0, 2000)}`);
      }
      console.log(`${done + failed}/${todo.length} ${t.exp} ${t.c.id} ${t.a}${t.rep}${r.json ? '' : ' FAILED'}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`finished: ${done} ok, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[2] === '--dump') {
  const t = trials();
  for (const ex of ['E1', 'E2', 'E4']) { const s = t.find((x) => x.exp === ex && x.a === 'B'); console.log(`===== ${ex} B ${s.c.id}\n${s.prompt}\n`); }
  console.log(`total trials: ${t.length}`);
} else main();
