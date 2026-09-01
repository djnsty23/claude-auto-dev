#!/usr/bin/env node
/**
 * quota-tripwire.js - fire ONCE when the weekly quota is 30-50 minutes from 100%.
 *
 * Runs as a poll loop under a Monitor that turns each stdout line into a
 * notification. Silence is the normal state. A line means act now.
 *
 * WHAT IS REUSED vs REWRITTEN
 * ---------------------------
 * REUSED, by execution rather than by copying: `~/.claude/scripts/quota-burn.js`
 * is spawned as `node quota-burn.js --json --days 0` and its `windowCost` and
 * `windowStart` are read straight out of the JSON. Nothing about the weekly
 * window boundary (Wed 01:59 local), the per-model price table, the token
 * weighting, or the transcript scan is reimplemented here - a second
 * implementation that disagreed with the first would be worse than none.
 *
 * `--days 0` narrows the file scan to transcripts touched since the window
 * opened. That is a pure speed change and it is safe by construction: a row
 * inside the window can only exist in a file whose mtime is at or after the
 * window start, so no in-window row can be skipped. Verified empirically on
 * 2026-08-21 - `--days 0` (186 files) and `--days 14` (400 files) returned an
 * identical $10164.3566 on back-to-back runs, and ~1.3s vs ~1.5s wall clock.
 *
 * REWRITTEN here, because quota-burn.js has none of it: sample persistence,
 * burn-rate derivation, the ceiling calibration, arm/fire/re-arm state, and the
 * diagnostic path.
 *
 * THE MEASURE, AND WHY THE CEILING IS CALIBRATED RATHER THAN CONSTANT
 * ------------------------------------------------------------------
 * Measure: cumulative LIST-PRICE-EQUIVALENT dollars consumed in the current
 * weekly window, exactly as quota-burn.js computes it. Everything below - the
 * samples, the rate, the ceiling - is expressed in that one measure. The rate
 * is always a delta between two consecutive samples OF THAT MEASURE; no other
 * measure is ever mixed into the arithmetic.
 *
 * The percentage the app shows does NOT convert linearly to this measure.
 * `[measured]` two readings 40 minutes apart: 83% at $9,559 and 86% at $10,069.
 * That is $170/point taken as a delta but $117/point taken as an absolute
 * ratio. So there is no dollars-per-percent constant to hardcode, and this
 * script hardcodes none. The 100% ceiling is instead DERIVED from the two most
 * recent `--calibrate <percent>` samples using the DELTA slope:
 *
 *     perPoint = (cost_b - cost_a) / (pct_b - pct_a)
 *     ceiling  = cost_b + (100 - pct_b) * perPoint
 *
 * With no ceiling and fewer than two calibration points, the script CANNOT
 * project, and it says so on a DIAGNOSTIC line. It never falls silent in that
 * case - silence from this tripwire means "measured, and not close", and
 * nothing else.
 *
 * USAGE
 *   node quota-tripwire.js                          # poll loop, 5 min, threshold 50 min
 *   node quota-tripwire.js --threshold-minutes 35
 *   node quota-tripwire.js --once                   # single check, exit
 *   node quota-tripwire.js --calibrate 86           # record app % against the live cost
 *   node quota-tripwire.js --status                 # human readout, exit
 *   node quota-tripwire.js --reset                  # clear samples / re-arm
 *   node quota-tripwire.js --selftest
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const TZ = 'Europe/Bucharest';

// ---------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
function val(n, def) {
  const i = argv.indexOf('--' + n);
  return i === -1 || i + 1 >= argv.length ? def : argv[i + 1];
}
function num(n, def) {
  const v = val(n, null);
  if (v === null) return def;
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
}

const OPTS = {
  thresholdMinutes: num('threshold-minutes', 50),
  intervalMinutes: num('interval-minutes', 5),
  lookbackMinutes: num('lookback-minutes', 60),
  minSpanMinutes: num('min-span-minutes', 2),
  rearmFactor: num('rearm-factor', 2),
  cooldownMinutes: num('cooldown-minutes', 30),
  diagRepeatMinutes: num('diag-repeat-minutes', 60),
  ceiling: num('ceiling', null),
  statePath: val('state', path.join(HOME, '.claude', 'quota-tripwire-state.json')),
  // The SHIPPED sibling first. This defaulted to ~/.claude/scripts/quota-burn.js,
  // a path outside every plugin: [measured 2026-08-28] it existed on no machine
  // and in no repo, so --status read FAILED code=source-missing and the tripwire
  // could never fire — while silence is this tripwire's success signal. An alarm
  // that cannot ring is indistinguishable from one with nothing to report.
  //
  // Order: explicit --source, then QUOTA_BURN_JS, then the sibling that ships with
  // this plugin, then the legacy path for anyone who already has one there.
  sourcePath: val('source', process.env.QUOTA_BURN_JS || (() => {
    const shipped = path.join(__dirname, 'quota-burn.js');
    if (fs.existsSync(shipped)) return shipped;
    return path.join(HOME, '.claude', 'scripts', 'quota-burn.js');
  })()),
  verbose: has('verbose'),
};

// ------------------------------------------------------------ formatting ----

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const money2 = (n) => '$' + n.toFixed(n < 10 ? 2 : 1);

function tzStamp(ms) {
  if (!Number.isFinite(ms)) return 'never at this rate';
  try {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).formatToParts(new Date(ms)).reduce((a, x) => ((a[x.type] = x.value), a), {});
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  } catch (e) {
    return new Date(ms).toISOString() + ' UTC (no tz data)';
  }
}

// ----------------------------------------------------------------- state ----

function emptyState() {
  return {
    version: 1,
    windowStart: null,
    samples: [],        // [{ t: epochMs, cost: number }] - one measure only
    calibration: [],    // [{ t, cost, pct }] - survives window rollover
    ceiling: null,      // explicit override, in the same measure
    armed: true,
    firedAt: null,
    lastDiag: null,     // { code, t }
  };
}

function loadState(p) {
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s = Object.assign(emptyState(), o);
    if (!Array.isArray(s.samples)) s.samples = [];
    if (!Array.isArray(s.calibration)) s.calibration = [];
    return s;
  } catch (e) {
    return emptyState();
  }
}

function saveState(p, s) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// ---------------------------------------------------------------- source ----
// Everything numeric about the window comes from quota-burn.js. If it cannot be
// run or cannot be parsed, that is a DIAGNOSTIC, never a silent zero.

function readSource(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, code: 'source-missing', detail: 'quota-burn.js not found at ' + sourcePath };
  }
  let res;
  try {
    res = spawnSync(process.execPath, [sourcePath, '--json', '--days', '0'], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, code: 'source-failed', detail: 'spawn threw: ' + e.message };
  }
  if (res.error) return { ok: false, code: 'source-failed', detail: 'spawn error: ' + res.error.message };
  if (res.status !== 0) {
    return { ok: false, code: 'source-failed', detail: 'exit ' + res.status + (res.signal ? ' (signal ' + res.signal + ')' : '') + ': ' + (String(res.stderr || '').trim().slice(0, 200) || '(no stderr)') };
  }
  const out = String(res.stdout || '').trim();
  if (!out) return { ok: false, code: 'source-unparseable', detail: 'no stdout from quota-burn.js' };
  let o;
  try { o = JSON.parse(out); } catch (e) {
    return { ok: false, code: 'source-unparseable', detail: 'stdout is not JSON: ' + out.slice(0, 160).replace(/\s+/g, ' ') };
  }
  if (typeof o.windowCost !== 'number' || !Number.isFinite(o.windowCost)) {
    return { ok: false, code: 'source-unparseable', detail: 'windowCost missing or not a number' };
  }
  const ws = Date.parse(o.windowStart || '');
  if (!ws) return { ok: false, code: 'source-unparseable', detail: 'windowStart missing or unparseable' };
  return { ok: true, cost: o.windowCost, windowStart: ws, population: o.population || null };
}

// --------------------------------------------------------------- ceiling ----

function deriveCeiling(state, opts) {
  const explicit = opts.ceiling != null ? opts.ceiling : state.ceiling;
  if (explicit != null && Number.isFinite(explicit) && explicit > 0) {
    return { ok: true, ceiling: explicit, basis: 'explicit ceiling ' + money(explicit) };
  }
  const cal = (state.calibration || []).slice().sort((a, b) => a.t - b.t);
  if (cal.length < 2) {
    return {
      ok: false, code: 'no-ceiling',
      detail: 'no ceiling set and only ' + cal.length + ' calibration point(s); run --calibrate <percent> twice, 30+ min apart',
    };
  }
  const a = cal[cal.length - 2];
  const b = cal[cal.length - 1];
  const dPct = b.pct - a.pct;
  const dCost = b.cost - a.cost;
  if (!(dPct > 0) || !(dCost > 0)) {
    return {
      ok: false, code: 'calibration-degenerate',
      detail: 'last two calibration points do not both increase (dPct=' + dPct.toFixed(2) + ', dCost=' + dCost.toFixed(2) + ')',
    };
  }
  // DELTA slope, not the absolute ratio. The two do not agree: the measured
  // pair 83%/$9,559 -> 86%/$10,069 gives $170/pt by delta and $117/pt by
  // absolute, and only the delta describes burn near the top of the window.
  const perPoint = dCost / dPct;
  const ceiling = b.cost + Math.max(0, 100 - b.pct) * perPoint;
  return {
    ok: true, ceiling, perPoint,
    basis: 'delta calibration ' + dPct.toFixed(1) + 'pt -> ' + money2(perPoint) + '/pt, anchored at ' + b.pct + '% = ' + money(b.cost),
  };
}

// ------------------------------------------------------------------ rate ----

function deriveRate(samples, nowMs, opts) {
  if (!samples || samples.length < 2) {
    return { ok: false, code: 'insufficient-samples', detail: 'have ' + (samples ? samples.length : 0) + ' sample(s) of window cost, need 2 - a single reading cannot yield a rate' };
  }
  const cutoff = nowMs - opts.lookbackMinutes * 60000;
  let use = samples.filter((s) => s.t >= cutoff);
  if (use.length < 2) use = samples.slice(-2);
  const first = use[0];
  const last = use[use.length - 1];
  const spanMin = (last.t - first.t) / 60000;
  if (spanMin < opts.minSpanMinutes) {
    return { ok: false, code: 'span-too-short', detail: 'newest two samples span ' + spanMin.toFixed(1) + ' min, need ' + opts.minSpanMinutes };
  }
  return { ok: true, rate: (last.cost - first.cost) / spanMin, spanMin, n: use.length };
}

// -------------------------------------------------------------- evaluate ----
// Pure: takes a reading + state, returns { kind, code, line, state }.
// kind is 'alert' | 'silent' | 'diagnostic' | 'suppressed-diagnostic'.

function evaluate(reading, prev, opts) {
  const state = JSON.parse(JSON.stringify(prev));
  const nowMs = reading.nowMs;

  // A new weekly window invalidates every sample and re-arms unconditionally.
  const rolled = state.windowStart !== null && state.windowStart !== reading.windowStart;
  if (rolled) {
    state.samples = [];
    state.armed = true;
    state.firedAt = null;
    state.lastDiag = null;
  }
  state.windowStart = reading.windowStart;

  state.samples.push({ t: nowMs, cost: reading.cost });
  state.samples.sort((a, b) => a.t - b.t);
  const keepFrom = nowMs - Math.max(opts.lookbackMinutes * 3, 180) * 60000;
  state.samples = state.samples.filter((s) => s.t >= keepFrom).slice(-500);

  const diag = (code, detail) => {
    const suppressed =
      state.lastDiag &&
      state.lastDiag.code === code &&
      nowMs - state.lastDiag.t < opts.diagRepeatMinutes * 60000;
    state.lastDiag = { code, t: suppressed ? state.lastDiag.t : nowMs };
    if (suppressed) return { kind: 'suppressed-diagnostic', code, line: null, state };
    return {
      kind: 'diagnostic', code, state,
      line:
        'QUOTA TRIPWIRE DIAGNOSTIC  code=' + code +
        '  cannot compute minutes-to-100%: ' + detail +
        '  |  silence from this tripwire is NOT evidence of headroom',
    };
  };

  const c = deriveCeiling(state, opts);
  if (!c.ok) return diag(c.code, c.detail);

  const r = deriveRate(state.samples, nowMs, opts);
  if (!r.ok) return diag(r.code, r.detail);

  const remaining = c.ceiling - reading.cost;
  let minutes;
  if (remaining <= 0) minutes = 0;
  else if (r.rate <= 0) minutes = Infinity;
  else minutes = remaining / r.rate;

  // Re-arm only when consumption has fallen well clear AND the post-fire
  // cooldown has elapsed, so a one-poll lull cannot produce a repeat alert.
  if (!state.armed) {
    const clear = minutes >= opts.thresholdMinutes * opts.rearmFactor;
    const cooled = state.firedAt == null || nowMs - state.firedAt >= opts.cooldownMinutes * 60000;
    if (clear && cooled) {
      state.armed = true;
      state.firedAt = null;
    }
  }

  if (minutes <= opts.thresholdMinutes && state.armed) {
    state.armed = false;
    state.firedAt = nowMs;
    state.lastDiag = null;
    const pct = (reading.cost / c.ceiling) * 100;
    const line =
      'QUOTA TRIPWIRE  PREP HANDOVER  ' + Math.floor(minutes) + ' min to 100%' +
      '  |  window ' + money(reading.cost) + ' of ' + money(c.ceiling) + ' ceiling (' + pct.toFixed(1) + '%)' +
      '  |  burn ' + money2(r.rate) + '/min over ' + r.spanMin.toFixed(r.spanMin < 10 ? 1 : 0) + ' min (' + r.n + ' samples)' +
      '  |  exhausts ~' + tzStamp(nowMs + minutes * 60000) +
      '  |  measure: list-price-equivalent window cost from quota-burn.js; ceiling from ' + c.basis;
    return { kind: 'alert', code: 'threshold-crossed', line, state, minutes, ceiling: c.ceiling, rate: r.rate };
  }

  return { kind: 'silent', code: null, line: null, state, minutes, ceiling: c.ceiling, rate: r.rate };
}

// ------------------------------------------------------------ reading src ----

function takeReading(opts) {
  const fc = num('fixture-cost', null);
  if (fc != null) {
    return {
      ok: true,
      cost: fc,
      windowStart: num('fixture-window', 0),
      nowMs: num('fixture-now', Date.now()),
      fixture: true,
    };
  }
  const s = readSource(opts.sourcePath);
  if (!s.ok) return s;
  return { ok: true, cost: s.cost, windowStart: s.windowStart, nowMs: Date.now(), population: s.population };
}

function sourceDiagLine(code, detail) {
  return (
    'QUOTA TRIPWIRE DIAGNOSTIC  code=' + code +
    '  cannot compute minutes-to-100%: ' + detail +
    '  |  silence from this tripwire is NOT evidence of headroom'
  );
}

function pollOnce(opts) {
  const state = loadState(opts.statePath);
  const reading = takeReading(opts);

  if (!reading.ok) {
    // Source failure gets the same once-per-code suppression as any other
    // diagnostic, so a broken source is loud but not a firehose.
    const nowMs = Date.now();
    const suppressed =
      state.lastDiag && state.lastDiag.code === reading.code &&
      nowMs - state.lastDiag.t < opts.diagRepeatMinutes * 60000;
    if (!suppressed) {
      state.lastDiag = { code: reading.code, t: nowMs };
      saveState(opts.statePath, state);
      console.log(sourceDiagLine(reading.code, reading.detail));
      return { kind: 'diagnostic', code: reading.code };
    }
    saveState(opts.statePath, state);
    return { kind: 'suppressed-diagnostic', code: reading.code };
  }

  const out = evaluate(reading, state, opts);
  const w = saveState(opts.statePath, out.state);
  if (!w.ok) {
    // Cannot persist => cannot guarantee fire-once. Say so rather than repeat.
    console.log(sourceDiagLine('state-unwritable', 'cannot write ' + opts.statePath + ': ' + w.detail + '; fire-once cannot be guaranteed'));
    return { kind: 'diagnostic', code: 'state-unwritable' };
  }
  if (out.line) console.log(out.line);
  return out;
}

// --------------------------------------------------------------- commands ----

function cmdCalibrate() {
  const pct = num('calibrate', null);
  if (pct == null || !(pct > 0) || pct > 100) {
    console.error('--calibrate needs the percentage the app is showing right now, e.g. --calibrate 86');
    process.exit(2);
  }
  const reading = takeReading(OPTS);
  if (!reading.ok) {
    console.error(sourceDiagLine(reading.code, reading.detail));
    process.exit(1);
  }
  const state = loadState(OPTS.statePath);
  state.calibration.push({ t: reading.nowMs, cost: reading.cost, pct });
  state.calibration = state.calibration.slice(-20);
  const w = saveState(OPTS.statePath, state);
  if (!w.ok) { console.error('could not write state: ' + w.detail); process.exit(1); }
  console.log('calibrated: ' + pct + '% = ' + money(reading.cost) + ' at ' + tzStamp(reading.nowMs));
  const c = deriveCeiling(state, OPTS);
  if (c.ok) console.log('ceiling now ' + money(c.ceiling) + '  (' + c.basis + ')');
  else console.log('no ceiling yet: ' + c.detail);
}

function cmdStatus() {
  const state = loadState(OPTS.statePath);
  const reading = takeReading(OPTS);
  console.log('state file : ' + OPTS.statePath);
  console.log('source     : ' + OPTS.sourcePath);
  console.log('measure    : list-price-equivalent window cost from quota-burn.js (--json --days 0)');
  console.log('threshold  : ' + OPTS.thresholdMinutes + ' min   interval ' + OPTS.intervalMinutes + ' min   lookback ' + OPTS.lookbackMinutes + ' min');
  if (!reading.ok) {
    console.log('reading    : FAILED  code=' + reading.code + '  ' + reading.detail);
    return;
  }
  console.log('reading    : ' + money(reading.cost) + '  window opened ' + tzStamp(reading.windowStart));
  console.log('samples    : ' + state.samples.length + '   calibration points: ' + state.calibration.length);
  console.log('armed      : ' + state.armed + (state.firedAt ? '   last fired ' + tzStamp(state.firedAt) : ''));
  const c = deriveCeiling(state, OPTS);
  if (!c.ok) { console.log('ceiling    : NONE - ' + c.detail); return; }
  console.log('ceiling    : ' + money(c.ceiling) + '  (' + c.basis + ')');
  const r = deriveRate(state.samples.concat([{ t: reading.nowMs, cost: reading.cost }]), reading.nowMs, OPTS);
  if (!r.ok) { console.log('rate       : NONE - ' + r.detail); return; }
  const remaining = c.ceiling - reading.cost;
  const minutes = remaining <= 0 ? 0 : r.rate <= 0 ? Infinity : remaining / r.rate;
  console.log('rate       : ' + money2(r.rate) + '/min over ' + r.spanMin.toFixed(1) + ' min (' + r.n + ' samples)');
  console.log('projection : ' + (Number.isFinite(minutes) ? Math.floor(minutes) + ' min -> ' + tzStamp(reading.nowMs + minutes * 60000) : 'not burning at present'));
}

function cmdReset() {
  const state = loadState(OPTS.statePath);
  const keep = state.calibration;
  const ceil = state.ceiling;
  const fresh = emptyState();
  fresh.calibration = keep;
  fresh.ceiling = ceil;
  const w = saveState(OPTS.statePath, fresh);
  console.log(w.ok ? 'reset: samples cleared, re-armed, calibration kept (' + keep.length + ' points)' : 'reset FAILED: ' + w.detail);
}

// --------------------------------------------------------------- selftest ----

function selftest() {
  const results = [];
  const T = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
  };
  const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
  const near = (a, b, tol, m) => { if (!(Math.abs(a - b) <= tol)) throw new Error((m || '') + ' expected ~' + b + ' (+-' + tol + ') got ' + a); };
  const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

  const O = Object.assign({}, OPTS, {
    thresholdMinutes: 50, lookbackMinutes: 60, minSpanMinutes: 2,
    rearmFactor: 2, cooldownMinutes: 30, diagRepeatMinutes: 60, ceiling: null,
  });
  const MIN = 60000;
  const base = Date.UTC(2026, 7, 21, 12, 0, 0);
  // The measured non-linear pair from the brief.
  const CAL = [{ t: base - 40 * MIN, cost: 9559, pct: 83 }, { t: base, cost: 10069, pct: 86 }];
  const withCal = () => { const s = emptyState(); s.calibration = CAL.map((x) => Object.assign({}, x)); return s; };

  // A1 - the ceiling uses the DELTA slope, and is measurably not the absolute ratio.
  T('A1 ceiling from delta slope, not absolute ratio', () => {
    const c = deriveCeiling(withCal(), O);
    ok(c.ok, 'ceiling should derive');
    near(c.perPoint, 170, 0.001, 'perPoint');
    near(c.ceiling, 10069 + 14 * 170, 0.001, 'ceiling');       // 12449
    const absolute = (10069 / 86) * 100;                        // 11708 - the wrong answer
    ok(Math.abs(c.ceiling - absolute) > 500, 'ceiling must not equal the absolute-ratio answer ' + absolute.toFixed(0));
  });

  // A2 - one calibration point cannot yield a ceiling.
  T('A2 one calibration point => no-ceiling diagnostic', () => {
    const s = emptyState(); s.calibration = [CAL[0]];
    const c = deriveCeiling(s, O);
    eq(c.ok, false); eq(c.code, 'no-ceiling');
  });

  // A3 - a single cost sample cannot yield a rate; that is a diagnostic, not silence.
  T('A3 first poll => insufficient-samples DIAGNOSTIC, not silence', () => {
    const out = evaluate({ nowMs: base, cost: 10069, windowStart: 1 }, withCal(), O);
    eq(out.kind, 'diagnostic'); eq(out.code, 'insufficient-samples');
    ok(/DIAGNOSTIC/.test(out.line), 'line must be a diagnostic line');
  });

  // A4 - measured and far away => silence.
  T('A4 slow burn => silent', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 10069, windowStart: 1 }, s, O).state;
    const out = evaluate({ nowMs: base + 10 * MIN, cost: 10079, windowStart: 1 }, s, O);
    eq(out.kind, 'silent'); eq(out.line, null);
    near(out.minutes, (12449 - 10079) / 1, 1, 'minutes');       // 1 $/min
  });

  // A5 - a crossing fires exactly once, and the next poll is silent.
  T('A5 crossing fires once, next poll silent', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 12000, windowStart: 1 }, s, O).state;
    const a = evaluate({ nowMs: base + 10 * MIN, cost: 12100, windowStart: 1 }, s, O); // 10 $/min, 349 left => 34.9 min
    eq(a.kind, 'alert');
    ok(a.minutes < 50 && a.minutes > 30, 'minutes should land in the 30-50 band, got ' + a.minutes);
    const b = evaluate({ nowMs: base + 20 * MIN, cost: 12200, windowStart: 1 }, a.state, O);
    eq(b.kind, 'silent', 'second poll must not repeat the alert:');
    eq(b.line, null);
  });

  // A6 - the alert line carries the numbers that justify it.
  T('A6 alert line carries cost, ceiling, rate, minutes, Bucharest time', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 12000, windowStart: 1 }, s, O).state;
    const a = evaluate({ nowMs: base + 10 * MIN, cost: 12100, windowStart: 1 }, s, O);
    const L = a.line;
    ok(/min to 100%/.test(L), 'minutes remaining missing');
    ok(/window \$12,100 of \$12,449 ceiling/.test(L), 'consumption/ceiling missing: ' + L);
    ok(/burn \$10\.0\/min over 10 min/.test(L), 'rate missing: ' + L);
    ok(/exhausts ~2026-\d\d-\d\d \d\d:\d\d EE[SD]T/.test(L), 'Bucharest exhaustion time missing: ' + L);
    ok(/measure: list-price-equivalent window cost/.test(L), 'measure not stated: ' + L);
  });

  // A7 - re-arms once well clear AND cooled down, then fires again.
  T('A7 re-arms when clear + cooled, then fires again', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 12000, windowStart: 1 }, s, O).state;
    const a = evaluate({ nowMs: base + 10 * MIN, cost: 12100, windowStart: 1 }, s, O);
    eq(a.kind, 'alert');
    eq(a.state.armed, false);
    // 40 min later, burn has collapsed to 0.1 $/min => ~3000 min left, and cooldown passed.
    const lull = evaluate({ nowMs: base + 50 * MIN, cost: 12104, windowStart: 1 }, a.state, O);
    eq(lull.kind, 'silent');
    eq(lull.state.armed, true, 'should have re-armed:');
    const again = evaluate({ nowMs: base + 60 * MIN, cost: 12300, windowStart: 1 }, lull.state, O);
    eq(again.kind, 'alert', 'should fire again after re-arming:');
  });

  // A8 - the COOLDOWN alone must block a re-arm. The "well clear" half of the
  // condition is deliberately satisfied here (121 min >= 2 x 50), so the only
  // thing that can keep it disarmed is the 30 min cooldown - otherwise this
  // assertion would pass without ever exercising the cooldown at all.
  T('A8 clear-but-not-cooled does not re-arm', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 12000, windowStart: 1 }, s, O).state;
    const a = evaluate({ nowMs: base + 10 * MIN, cost: 12100, windowStart: 1 }, s, O);
    eq(a.kind, 'alert');
    const lull = evaluate({ nowMs: base + 35 * MIN, cost: 12101, windowStart: 1 }, a.state, O);
    ok(lull.minutes >= O.thresholdMinutes * O.rearmFactor,
       'precondition: must be well clear, got ' + lull.minutes.toFixed(1) + ' min');
    ok(base + 35 * MIN - a.state.firedAt < O.cooldownMinutes * MIN, 'precondition: must still be inside the cooldown');
    eq(lull.state.armed, false, 'cooldown must still block the re-arm:');
  });

  // A9 - a new weekly window clears samples and re-arms.
  T('A9 window rollover resets samples and re-arms', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 12000, windowStart: 1 }, s, O).state;
    const a = evaluate({ nowMs: base + 10 * MIN, cost: 12100, windowStart: 1 }, s, O);
    eq(a.state.armed, false);
    const roll = evaluate({ nowMs: base + 20 * MIN, cost: 5, windowStart: 2 }, a.state, O);
    eq(roll.state.armed, true, 'rollover must re-arm:');
    eq(roll.state.samples.length, 1, 'rollover must drop old-window samples:');
    eq(roll.kind, 'diagnostic'); eq(roll.code, 'insufficient-samples');
  });

  // A10 - zero burn projects to infinity and stays silent.
  T('A10 zero burn => silent, infinite projection', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 12400, windowStart: 1 }, s, O).state;
    const out = evaluate({ nowMs: base + 10 * MIN, cost: 12400, windowStart: 1 }, s, O);
    eq(out.kind, 'silent');
    eq(out.minutes, Infinity);
  });

  // A11 - already past the ceiling fires with 0 minutes.
  T('A11 past ceiling => alert at 0 min', () => {
    let s = withCal();
    s = evaluate({ nowMs: base, cost: 12500, windowStart: 1 }, s, O).state;
    const out = evaluate({ nowMs: base + 10 * MIN, cost: 12600, windowStart: 1 }, s, O);
    eq(out.kind, 'alert'); eq(out.minutes, 0);
  });

  // A12 - a missing source is a diagnostic, never silence.
  T('A12 missing source => source-missing diagnostic', () => {
    const r = readSource(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.js'));
    eq(r.ok, false); eq(r.code, 'source-missing');
    ok(/not found/.test(r.detail), 'detail should name the miss');
  });

  // A13 - a source that runs but prints junk is a diagnostic, not a zero.
  T('A13 unparseable source => source-unparseable diagnostic', () => {
    const p = path.join(os.tmpdir(), 'qt-junk-' + Date.now() + '.js');
    fs.writeFileSync(p, 'console.log("not json at all");', 'utf8');
    try {
      const r = readSource(p);
      eq(r.ok, false); eq(r.code, 'source-unparseable');
    } finally { try { fs.unlinkSync(p); } catch (e) {} }
  });

  // A13b - a source that exits nonzero is a diagnostic.
  T('A13b failing source => source-failed diagnostic', () => {
    const p = path.join(os.tmpdir(), 'qt-fail-' + Date.now() + '.js');
    fs.writeFileSync(p, 'process.exit(3);', 'utf8');
    try {
      const r = readSource(p);
      eq(r.ok, false); eq(r.code, 'source-failed');
    } finally { try { fs.unlinkSync(p); } catch (e) {} }
  });

  // A14 - state survives a save/load round trip.
  T('A14 state round-trips through disk', () => {
    const p = path.join(os.tmpdir(), 'qt-state-' + Date.now() + '.json');
    try {
      const s = withCal();
      s.samples = [{ t: base, cost: 1 }, { t: base + MIN, cost: 2 }];
      s.armed = false; s.firedAt = base;
      eq(saveState(p, s).ok, true);
      const back = loadState(p);
      eq(back.armed, false);
      eq(back.samples.length, 2);
      eq(back.calibration.length, 2);
      eq(back.firedAt, base);
    } finally { try { fs.unlinkSync(p); } catch (e) {} }
  });

  // A15 - a repeated diagnostic is suppressed; a DIFFERENT one prints at once.
  T('A15 diagnostic dedupes by code, a new code prints immediately', () => {
    const s0 = emptyState();                                    // no calibration
    const d1 = evaluate({ nowMs: base, cost: 100, windowStart: 1 }, s0, O);
    eq(d1.kind, 'diagnostic'); eq(d1.code, 'no-ceiling');
    const d2 = evaluate({ nowMs: base + 5 * MIN, cost: 101, windowStart: 1 }, d1.state, O);
    eq(d2.kind, 'suppressed-diagnostic', 'same code within the window must be suppressed:');
    eq(d2.line, null);
    // now give it a ceiling: the blocker changes to insufficient-samples, a NEW code
    const s2 = d2.state; s2.calibration = CAL.map((x) => Object.assign({}, x)); s2.samples = [];
    const d3 = evaluate({ nowMs: base + 10 * MIN, cost: 102, windowStart: 1 }, s2, O);
    eq(d3.kind, 'diagnostic', 'a different code must print immediately:');
    eq(d3.code, 'insufficient-samples');
  });

  // A16 - the rate is a delta of consecutive samples of the SAME measure.
  T('A16 rate is a delta of consecutive cost samples', () => {
    const r = deriveRate([{ t: base, cost: 1000 }, { t: base + 20 * MIN, cost: 1100 }], base + 20 * MIN, O);
    ok(r.ok, 'rate should derive');
    near(r.rate, 5, 1e-9, 'rate $/min');
    near(r.spanMin, 20, 1e-9, 'span');
  });

  // A17 - two samples closer together than min-span cannot yield a rate.
  T('A17 sub-minimum span => span-too-short diagnostic', () => {
    const r = deriveRate([{ t: base, cost: 1000 }, { t: base + 30000, cost: 1100 }], base + 30000, O);
    eq(r.ok, false); eq(r.code, 'span-too-short');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '\n        ' + r.err));
  console.log('');
  console.log('population: ' + results.length + ' assertions run, ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}

// ------------------------------------------------------------------ main ----

function main() {
  // `[measured 2026-09-02]` --help entered the poll loop and never returned;
  // so did a bare invocation probed by an auditor, which is by design but was
  // undocumented at the prompt. The USAGE block in the header is now printable.
  if (has('help') || argv.includes('-h')) {
    console.log([
      'quota-tripwire.js - fire before the weekly usage wall, from measured burn',
      '',
      '  node quota-tripwire.js                          # poll loop, 5 min, threshold 50 min',
      '  node quota-tripwire.js --once                   # single check, exit',
      '  node quota-tripwire.js --status                 # human readout, exit',
      '  node quota-tripwire.js --calibrate <percent>    # record app % against the live cost',
      '  node quota-tripwire.js --ceiling <cost>         # set the 100% ceiling explicitly',
      '  node quota-tripwire.js --threshold-minutes 35',
      '  node quota-tripwire.js --reset                  # clear samples / re-arm',
      '  node quota-tripwire.js --selftest',
      '',
      'Silence means "measured, and not close". A DIAGNOSTIC line means it could not measure.',
    ].join('\n'));
    return;
  }
  if (has('selftest')) return selftest();
  if (has('calibrate')) return cmdCalibrate();
  if (has('status')) return cmdStatus();
  if (has('reset')) return cmdReset();

  if (OPTS.ceiling != null) {
    const s = loadState(OPTS.statePath);
    s.ceiling = OPTS.ceiling;
    saveState(OPTS.statePath, s);
  }

  if (has('once')) { pollOnce(OPTS); return; }

  const tick = () => {
    let out = null;
    try { out = pollOnce(OPTS); }
    catch (e) { console.log(sourceDiagLine('tripwire-crashed', 'unhandled error in poll: ' + e.message)); }
    if (OPTS.verbose) console.error('[tripwire] ' + new Date().toISOString() + ' ' + (out ? out.kind : 'error'));
    setTimeout(tick, OPTS.intervalMinutes * 60000);
  };
  tick();
}

// Behind require.main so that importing this module (a test, a census) does
// not start a five-minute poll loop in the importer's process.
if (require.main === module) main();
module.exports = { main };
