'use strict';
// Runs a node script through a PIPE that nobody reads until the script has
// exited, then compares what arrived against a plain run. This is the only way
// to see the defect `[measured 2026-09-07]` in rendered-layout-gate.js on a
// script whose output is far smaller than the pipe buffer:
//
//   node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin, and
//   synchronous when it is a pipe on linux and win32. process.exit() does not
//   drain a pending async write, so a script that prints and then exits
//   delivers only what libuv wrote synchronously first and silently drops the
//   rest -- under exit status 0, because the write never failed.
//
// A few-hundred-byte report never fills a 64 KiB buffer, so a plain spawnSync
// cannot show this: the write goes through synchronously and the assertion
// passes by construction. Here the child's stdout pipe is pre-filled to
// CAPACITY before the script starts, so its very first write gets EAGAIN and
// queues -- which is exactly the state process.exit() destroys.
//
// TWO THINGS MAKE THIS PROVE SOMETHING RATHER THAN LOOK DECISIVE:
//
//  1. The fill is CALIBRATED, not guessed. A fixed 65,000-byte fill left 536
//     bytes free on this machine, and 6 of the 19 reports here are smaller
//     than that -- they passed while never touching the queued-write path.
//     controlVerdict() measures the true capacity and fills all of it, so a
//     truncating script delivers ZERO bytes whatever its size.
//  2. The reader's wait SCALES with the subject. It waits for the script to
//     exit, bounded -- and the bound is derived from a plain run of that same
//     script, not a constant. A 1 s bound let three slow scanners write into
//     an already-draining pipe, which is a pass with no backpressure in it.
//     The bound still exists because a CORRECT script blocks on that full
//     pipe until somebody reads.
//
// Every verdict is gated by a control: a fixture that prints then exits must
// arrive truncated to zero first. Where it does not -- linux and win32, where
// the pipe is synchronous and the defect cannot occur -- the result is a loud
// `skipped`, not a pass, and the macos-latest CI leg is what holds this check.
// On darwin a control that survives is `indeterminate` and the caller must
// fail: something kept the script from writing, and nothing was measured.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CALIBRATION_FILL = 65000;
const CONTROL = path.join(__dirname, 'fixtures', 'pipe-drain', 'exit-after-print.js');
const TICK_MS = 50;

// One reader on the far end: poll for the writer's status file (written only
// after the script exits), give up after PD_TICKS, then drain. `"$0" "$@"`
// carries every argument through sh without quoting.
const SH = '{ head -c "$PD_FILL" /dev/zero; "$0" "$@"; echo $? > "$PD_OUT.status"; } | '
    + '{ i=0; while [ ! -f "$PD_OUT.status" ] && [ $i -lt "$PD_TICKS" ]; do sleep 0.05; i=$((i+1)); done; cat > "$PD_OUT"; }';

function stalled(argv, opts, fill, waitMs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-drain-'));
    const out = path.join(dir, 'out');
    try {
        const r = spawnSync('sh', ['-c', SH, process.execPath].concat(argv), {
            cwd: opts.cwd,
            env: Object.assign({}, opts.env || process.env, {
                PD_OUT: out,
                PD_FILL: String(fill),
                PD_TICKS: String(Math.max(20, Math.ceil(waitMs / TICK_MS))),
            }),
            encoding: 'utf8',
            timeout: opts.timeout || 60000,
        });
        if (r.error) return { error: String(r.error) };
        const raw = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
        const st = fs.existsSync(out + '.status') ? Number(fs.readFileSync(out + '.status', 'utf8').trim()) : null;
        return {
            status: st,
            bytes: Math.max(0, raw.length - fill),
            stdout: raw.subarray(Math.min(fill, raw.length)).toString('utf8'),
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function plain(argv, opts) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, argv, {
        cwd: opts.cwd, env: opts.env || process.env, encoding: 'utf8', timeout: opts.timeout || 60000,
    });
    return { status: r.status, bytes: Buffer.byteLength(r.stdout || '', 'utf8'), stdout: r.stdout || '', ms: Date.now() - t0 };
}

// The reader must still be waiting when the subject writes, and must give up
// before a correctly-draining subject waits on it forever. Twice the plain
// run plus half a second satisfies both, and never less than one second.
const waitFor = (ms) => Math.max(1000, ms * 2 + 500);

let control = null;
function controlVerdict() {
    if (control) return control;
    if (process.platform === 'win32') {
        control = { usable: false, skipped: 'win32: no sh, and stdout to a pipe is synchronous there; the darwin CI leg holds this check' };
        return control;
    }
    const whole = plain([CONTROL], {});
    const wait = waitFor(whole.ms);
    // Calibrate: what arrives from a script that prints then exits is exactly
    // what fit in the pipe, so capacity = fill + arrived. Only meaningful
    // while the control IS truncated; a whole one means it never filled.
    const cal = stalled([CONTROL], {}, CALIBRATION_FILL, wait);
    if (cal.error) { control = { usable: false, skipped: 'the control could not run: ' + cal.error }; return control; }
    if (cal.bytes >= whole.bytes) {
        control = process.platform === 'darwin'
            ? { usable: false, indeterminate: 'darwin, but the control survived whole (' + cal.bytes + ' of ' + whole.bytes + ' bytes): its write never queued, so nothing below would be measured' }
            : { usable: false, skipped: process.platform + ': the control survived whole (' + cal.bytes + ' bytes), so stdout to a pipe is synchronous here and the defect cannot occur. The darwin CI leg holds this check' };
        return control;
    }
    // Fill ALL of it. With no free space, a script that exits before draining
    // delivers zero bytes whatever its size; leave any free and every report
    // smaller than that passes without exercising the queued-write path.
    const capacity = CALIBRATION_FILL + cal.bytes;
    const full = stalled([CONTROL], {}, capacity, wait);
    if (full.bytes !== 0) {
        control = { usable: false, indeterminate: 'the calibrated fill (' + capacity + ' bytes) still left room: the control delivered ' + full.bytes + ' bytes rather than 0, so a small report would pass here untested' };
        return control;
    }
    control = { usable: true, capacity, wholeBytes: whole.bytes, freeAtFixedFill: cal.bytes };
    return control;
}

/**
 * run({ argv, cwd, env, timeout }) -> { ok, detail, skipped?, indeterminate?, plain, stalled }
 * ok when the stalled run delivered the same bytes and status as a plain one,
 * or when the platform cannot show the defect at all.
 */
function run(opts) {
    const cv = controlVerdict();
    if (cv.skipped) return { ok: true, skipped: cv.skipped, detail: 'SKIPPED: ' + cv.skipped };
    if (cv.indeterminate) return { ok: false, indeterminate: cv.indeterminate, detail: 'INDETERMINATE: ' + cv.indeterminate };
    const p = plain(opts.argv, opts);
    if (p.bytes === 0) {
        return { ok: false, plain: p, detail: 'the subject printed NOTHING on a plain run (exit ' + p.status + '), so a drain check on it would assert nothing' };
    }
    const s = stalled(opts.argv, opts, cv.capacity, waitFor(p.ms));
    if (s.error) return { ok: false, detail: s.error, plain: p, stalled: s };
    const ok = s.bytes === p.bytes && s.status === p.status;
    return {
        ok,
        detail: ok
            ? s.bytes + ' bytes both ways, exit ' + p.status + ' (control: a full ' + cv.capacity + '-byte pipe delivered 0 of ' + cv.wholeBytes + ')'
            : 'stalled pipe delivered ' + s.bytes + ' of ' + p.bytes + ' bytes (exit ' + s.status + ' vs ' + p.status + '): the process ended before stdout drained',
        plain: p,
        stalled: s,
    };
}

module.exports = { run, controlVerdict, CALIBRATION_FILL };
