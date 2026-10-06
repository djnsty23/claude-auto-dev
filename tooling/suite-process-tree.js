// Owned suite processes only. An identity is PID plus creation time, not a PID.
'use strict';
const { spawn } = require('node:child_process');

// Toolhelp works without WMI/CIM permissions. Creation times prevent stale
// parent IDs from recruiting a reused PID into this suite's cleanup tree.
const WINDOWS_SNAPSHOT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long born, out long exited, out long kernel, out long user);
  public static void Print() {
    IntPtr handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new Exception("process snapshot unavailable");
    try {
      Entry e = new Entry(); e.size = (uint)Marshal.SizeOf(e);
      if (!Process32FirstW(handle, ref e)) throw new Exception("empty process snapshot");
      do {
        try {
          // Query limited information directly. Process.StartTime builds a
          // managed process wrapper for every entry in the system table.
          IntPtr p = OpenProcess(0x1000, false, e.pid);
          if (p == IntPtr.Zero) continue;
          try {
            long born, exited, kernel, user;
            if (GetProcessTimes(p, out born, out exited, out kernel, out user))
              Console.WriteLine(e.pid + " " + e.parent + " " + (born / 10000 - 11644473600000));
          } finally { CloseHandle(p); }
        } catch { /* protected or already exited */ }
      } while (Process32NextW(handle, ref e));
    } finally { CloseHandle(handle); }
  }
}
'@
[SuiteSnapshot]::Print()
`;

function snapshot(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const args = windows
      ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SNAPSHOT, 'utf16le').toString('base64')]
      : ['-A', '-o', 'pid=,ppid=,stat=,lstart='];
    const child = spawn(windows ? 'powershell.exe' : 'ps', args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
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

function remember(rows, owned, root, started, exitedAt, seenAt) {
  // Root may have exited while a Windows pipe holder still retains its parent ID.
  const precision = process.platform === 'win32' ? 0 : 1000;
  const rootRow = rows.find(row => row.pid === root);
  // Learn the OS identity while the suite is live, rather than comparing clocks
  // from Node and GetProcessTimes. Once learned, even a delayed exit event cannot
  // authorize a replacement root identity. After exit an unfamiliar PID is refused.
  const rootValid = !rootRow || (owned.has(root)
    ? owned.get(root).born === rootRow.born : exitedAt === Infinity);
  const rootBorn = rootValid && rootRow ? rootRow.born : owned.get(root)?.born ?? started - precision;
  const rootCeiling = Math.min(exitedAt, rootRow ? Infinity : owned.get(root)?.lastSeen ?? exitedAt);
  const parents = new Map(rootValid ? [[root, { born: rootBorn, ceiling: rootCeiling }]] : []);
  for (const row of owned.values()) {
    const current = rows.find(r => r.pid === row.pid);
    if (current && current.born === row.born) row.lastSeen = seenAt;
    if (!current || current.born === row.born) {
      // A dead process's PID can become somebody else's parent. Only children
      // born before our last observation of the original identity are safe.
      const ceiling = current ? Infinity : row.lastSeen;
      parents.set(row.pid, { born: row.born, ceiling: row.pid === root ? Math.min(ceiling, exitedAt) : ceiling });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.pid === process.pid || owned.has(row.pid)) continue;
      const parent = row.pid === root && rootValid
        ? { born: rootBorn, ceiling: exitedAt } : parents.get(row.parent);
      if (parent && row.born >= parent.born && row.born <= parent.ceiling) {
        owned.set(row.pid, { ...row, lastSeen: seenAt });
        parents.set(row.pid, { born: row.born, ceiling: row.pid === root ? exitedAt : Infinity });
        changed = true;
      }
    }
  }
}

function trackTree(root, started) {
  const owned = new Map();
  let stopped = false, active = null, poll = null;
  let exitedAt = Infinity;
  const scan = (timeoutMs = 3000) => {
    if (active) return active;
    // Timestamp the start of observation, conservatively preceding collection.
    const seenAt = Date.now();
    active = snapshot(timeoutMs).then(rows => { remember(rows, owned, root, started, exitedAt, seenAt); return rows; })
      .finally(() => { active = null; });
    return active;
  };
  // Learn the live root identity before an exit races the teardown snapshot.
  // Windows retains parent IDs and needs no further normal-path polling.
  scan().catch(() => {});
  // POSIX reparents orphans. A one-second ancestry scan retains detached
  // descendants observed before their parents exit, including pipe holders.
  // Deadline-only discovery loses that relationship after reparenting.
  if (process.platform !== 'win32') {
    const tick = () => {
      if (stopped) return;
      scan().catch(() => {}).finally(() => { if (!stopped) poll = setTimeout(tick, 1000); });
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
        let rows;
        try { rows = await scan(Math.min(3000, Math.max(1, end - Date.now()))); }
        catch (e) {
          // One overloaded snapshot must not consume the whole cleanup chance.
          // Each retry shares the original deadline, including its kill cap.
          if (Date.now() >= end) throw new Error('process snapshot unavailable within 7000 ms: ' + e.message);
          await new Promise(resolve => setTimeout(resolve, Math.min(100, end - Date.now())));
          continue;
        }
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
        await new Promise(resolve => setTimeout(resolve, Math.min(100, end - Date.now())));
        if (Date.now() - termAt >= 500) force = true;
      }
    },
  };
}

module.exports = { trackTree, snapshot };
