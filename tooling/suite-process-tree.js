// Owned suite processes only. An identity is PID plus creation time, not a PID.
'use strict';
const { spawn } = require('node:child_process');

// Toolhelp works without WMI/CIM permissions. Creation times prevent stale
// parent IDs from recruiting a reused PID into this suite's cleanup tree.
const WINDOWS_SNAPSHOT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class SuiteSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Print() {
    IntPtr handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new Exception("process snapshot unavailable");
    try {
      Entry e = new Entry(); e.size = (uint)Marshal.SizeOf(e);
      if (!Process32FirstW(handle, ref e)) throw new Exception("empty process snapshot");
      do {
        try {
          using (Process p = Process.GetProcessById((int)e.pid)) {
            long born = new DateTimeOffset(p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
            Console.WriteLine(e.pid + " " + e.parent + " " + born);
          }
        } catch { /* protected or already exited */ }
      } while (Process32NextW(handle, ref e));
    } finally { CloseHandle(handle); }
  }
}
'@
[SuiteSnapshot]::Print()
`;

function snapshot() {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const args = windows
      ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SNAPSHOT, 'utf16le').toString('base64')]
      : ['-A', '-o', 'pid=,ppid=,stat=,lstart='];
    const child = spawn(windows ? 'powershell.exe' : 'ps', args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('process snapshot failed: ' + err.trim()));
      const rows = out.trim().split(/\r?\n/).map(line => {
        const m = (windows ? /^\s*(\d+)\s+(\d+)\s+(.+)$/ : /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/).exec(line);
        if (!m || (!windows && m[3].startsWith('Z'))) return null;
        return { pid: Number(m[1]), parent: Number(m[2]), born: windows ? Number(m[3]) : Date.parse(m[4]) };
      }).filter(row => row && Number.isFinite(row.born));
      if (!rows.some(row => row.pid === process.pid)) return reject(new Error('process snapshot omitted its live owner'));
      resolve(rows);
    });
  });
}

function remember(rows, owned, root, started, launched, exitedAt) {
  // Root may have exited while a Windows pipe holder still retains its parent ID.
  const precision = process.platform === 'win32' ? 0 : 1000;
  const rootRow = rows.find(row => row.pid === root);
  const rootValid = !rootRow || (rootRow.born >= started - precision && rootRow.born <= launched);
  const parents = new Map(rootValid ? [[root, started - precision]] : []);
  for (const row of owned.values()) {
    const current = rows.find(r => r.pid === row.pid);
    if (!current || current.born === row.born) parents.set(row.pid, row.born);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.pid === process.pid || owned.has(row.pid)) continue;
      const floor = row.pid === root && rootValid ? started - precision : parents.get(row.parent);
      const ceiling = row.pid === root ? launched : row.parent === root ? exitedAt : Infinity;
      if (floor !== undefined && row.born >= floor && row.born <= ceiling) {
        owned.set(row.pid, row);
        parents.set(row.pid, row.born);
        changed = true;
      }
    }
  }
}

function trackTree(root, started, launched) {
  const owned = new Map();
  let stopped = false, active = null, poll = null;
  let exitedAt = Infinity;
  const scan = () => {
    if (active) return active;
    active = snapshot().then(rows => { remember(rows, owned, root, started, launched, exitedAt); return rows; })
      .finally(() => { active = null; });
    return active;
  };
  // POSIX reparents orphans. Remember detached descendants while their owner
  // lives. Windows retains parent IDs and only needs snapshots at teardown.
  if (process.platform !== 'win32') {
    const tick = () => {
      if (stopped) return;
      scan().catch(() => {}).finally(() => { if (!stopped) poll = setTimeout(tick, 100); });
    };
    tick();
  }
  const stop = () => { stopped = true; if (poll) clearTimeout(poll); };
  return {
    stop,
    exited() { exitedAt = Date.now(); },
    async terminate() {
      stop();
      const end = Date.now() + 7000;
      let force = process.platform === 'win32';
      const termAt = Date.now();
      for (;;) {
        const rows = await scan();
        if (exitedAt === Infinity && !owned.has(root)) throw new Error('live suite identity missing from process snapshot');
        const live = rows.filter(row => owned.get(row.pid)?.born === row.born);
        if (!live.length) return;
        // Descendants first so a cooperative root cannot orphan them during TERM.
        const depth = row => {
          const seen = new Set();
          while (row && !seen.has(row.pid)) { seen.add(row.pid); row = owned.get(row.parent); }
          return seen.size;
        };
        for (const row of live.sort((a, b) => depth(b) - depth(a))) {
          try { process.kill(row.pid, force ? 'SIGKILL' : 'SIGTERM'); }
          catch (e) { if (e.code !== 'ESRCH') throw e; }
        }
        if (Date.now() >= end) throw new Error('owned process tree did not terminate within 7000 ms');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (Date.now() - termAt >= 500) force = true;
      }
    },
  };
}

module.exports = { trackTree, snapshot };
