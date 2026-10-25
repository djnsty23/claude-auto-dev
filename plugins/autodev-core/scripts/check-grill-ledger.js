#!/usr/bin/env node
// Lints the new-app decision ledger, `docs/new-app/01-grill.md`, against the
// shape rules in skills/spec/references/new-app-chain.md.
//
// WHY. The ledger is the only code space for decisions about a new app, and
// every chain step appends to it. A step that reads a malformed ledger reads
// it wrong without noticing: a duplicate code makes "DY3 no, X" ambiguous, a
// `superseded by DY9` pointing at nothing hides which decision now holds, and
// a lock step outside the chain's six means the decision card groups the row
// nowhere, so the operator never sees it. Each chain step runs this before it
// hands on, so a bad row is caught by the step that wrote it.
//
// THE RULES, one finding each:
//   - a table headed Code | Answer | By | Lock step | Status exists and has rows
//   - each row has five cells
//   - codes look like Q1 or DY12 and are unique
//   - By is `you`, `accepted` or `Claude`
//   - Lock step is one of spec, setup, modules, provision, build, ship
//   - Status is `open`, `locked at <its lock step>`, or `superseded by <code>`
//     naming another row of this ledger
//
// An empty ledger is a finding, never a pass: a linter that reads zero rows
// and says ok has checked nothing.
//
// Usage: node check-grill-ledger.js [docs/new-app/01-grill.md]
// Exit 0 clean, 1 on any finding, 2 when the file cannot be read (not run).

const fs = require('fs');

const BY = ['you', 'accepted', 'Claude'];
const STEPS = ['spec', 'setup', 'modules', 'provision', 'build', 'ship'];
const HEADER = ['code', 'answer', 'by', 'lock step', 'status'];
const CODE = /^[A-Z]+\d+$/;
const USAGE = 'Usage: node check-grill-ledger.js [docs/new-app/01-grill.md]';

// Split a markdown table line on unescaped pipes, dropping the outer edges.
function cells(line) {
  const parts = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  return parts.map(p => p.trim().replace(/\\\|/g, '|'));
}

// A cell copied from the reference may carry backticks or bold around it.
function bare(cell) {
  return cell.replace(/^[`*]+|[`*]+$/g, '').trim();
}

// Every row of every table whose header is the ledger header, with its line number.
function parseLedger(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const head = cells(lines[i]).map(c => bare(c).toLowerCase());
    if (head.join('|') !== HEADER.join('|')) continue;
    if (!/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) continue;
    tables++;
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      rows.push({ line: j + 1, cells: cells(lines[j]) });
    }
    i = j - 1;
  }
  return { tables, rows };
}

function lintRows(parsed) {
  const findings = [];
  if (parsed.tables === 0) {
    findings.push('no ledger table: expected a header row "| Code | Answer | By | Lock step | Status |"');
    return findings;
  }
  if (parsed.rows.length === 0) {
    findings.push('the ledger table has no rows');
    return findings;
  }
  const seen = new Map();
  const wellFormed = [];
  for (const row of parsed.rows) {
    const at = `line ${row.line}`;
    if (row.cells.length !== 5) {
      findings.push(`${at}: ${row.cells.length} cells, expected 5 (code, answer, by, lock step, status)`);
      continue;
    }
    const [code, , by, lock, status] = row.cells.map(bare);
    if (!CODE.test(code)) findings.push(`${at}: code "${code}" is not a letter prefix and a number, like Q1 or DY12`);
    else if (seen.has(code)) findings.push(`${at}: code ${code} duplicates line ${seen.get(code)}`);
    else seen.set(code, row.line);
    if (!BY.includes(by)) findings.push(`${at}: ${code} By is "${by}", expected one of ${BY.join(', ')}`);
    if (!STEPS.includes(lock)) findings.push(`${at}: ${code} lock step is "${lock}", expected one of ${STEPS.join(', ')}`);
    wellFormed.push({ at, code, lock, status });
  }
  for (const { at, code, lock, status } of wellFormed) {
    if (status === 'open') continue;
    const locked = /^locked at (\S+)$/.exec(status);
    if (locked) {
      if (!STEPS.includes(locked[1])) findings.push(`${at}: ${code} is "locked at ${locked[1]}", which is not a chain step`);
      else if (STEPS.includes(lock) && locked[1] !== lock) findings.push(`${at}: ${code} is locked at ${locked[1]} but its lock step is ${lock}`);
      continue;
    }
    const sup = /^superseded by (\S+)$/.exec(status);
    if (sup) {
      if (sup[1] === code) findings.push(`${at}: ${code} is superseded by itself`);
      else if (!seen.has(sup[1])) findings.push(`${at}: ${code} is superseded by ${sup[1]}, which is not a row of this ledger`);
      continue;
    }
    findings.push(`${at}: ${code} status is "${status}", expected open, "locked at <step>" or "superseded by <code>"`);
  }
  return findings;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  if (argv.length > 1 || argv.some(a => a.startsWith('--'))) { console.error('check-grill-ledger: ' + USAGE); return 2; }
  const file = argv[0] || 'docs/new-app/01-grill.md';
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`check-grill-ledger: not run, cannot read ${file} (${err.code || err.message})`);
    return 2;
  }
  const parsed = parseLedger(text);
  const findings = lintRows(parsed);
  console.log(`check-grill-ledger: ${parsed.rows.length} rows read from ${parsed.tables} ledger table(s) in ${file}`);
  for (const f of findings) console.log('  ' + f);
  console.log(findings.length ? `check-grill-ledger: ${findings.length} finding(s)` : 'check-grill-ledger: ok');
  return findings.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
