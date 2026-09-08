// session-carrier.js — how autodev-memory's hooks find each other's state.
//
// Every hook runs in its own process, so nothing can be passed between them in
// memory or in environment variables. Two earlier attempts at this failed
// silently and are worth naming, because the code still reads as if they worked:
//
//   * `AUTO_DEV_SESSION_ID` was assigned in the SessionStart hook. It died with
//     that process, so capture never saw it.
//   * A single `.claude/memory-session-id` file per project was the fallback.
//     It works for one session, but two Claude sessions open on the same project
//     overwrite each other's id, and whichever ends first deletes the file — so
//     the surviving session captures nothing for the rest of its life.
//
// The carrier is therefore keyed by the harness session id, which every hook
// payload carries. One directory, one file per live session, each removed by
// its own SessionEnd.

const fs = require('fs');
const path = require('path');

const DIR_NAME = 'memory-sessions';

function carrierDir(cwd) {
    return path.join(cwd, '.claude', DIR_NAME);
}

// This directory holds per-session state, and until 2026-09-08 it held the
// user's verbatim prompts. Projects do not reliably ignore all of .claude/ —
// this repo itself ignores only four specific paths inside it — so the
// directory excludes ITSELF the moment it is created. That holds no matter what
// the surrounding project's .gitignore says, which is the only version of this
// guarantee worth having when the repo might be public, and it stays now the
// prompts are gone: a stale `.prompt` from an older build is still a prompt.
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) {
        fs.writeFileSync(ignore, '# Session state and verbatim user prompts. Never commit.\n*\n');
    }
}

// The harness session id is untrusted as a path segment — reduce it to a safe
// slug so it can never escape the carrier directory.
function slug(harnessSessionId) {
    return String(harnessSessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function carrierPath(cwd, harnessSessionId) {
    return path.join(carrierDir(cwd), slug(harnessSessionId));
}

function write(cwd, harnessSessionId, memorySessionId) {
    const file = carrierPath(cwd, harnessSessionId);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, memorySessionId);
    return file;
}

function read(cwd, harnessSessionId) {
    try {
        const v = fs.readFileSync(carrierPath(cwd, harnessSessionId), 'utf8').trim();
        return v || null;
    } catch {
        return null;
    }
}

function clear(cwd, harnessSessionId) {
    try { fs.unlinkSync(carrierPath(cwd, harnessSessionId)); } catch { /* already gone */ }
    // A `.prompt` sibling written by a pre-2026-09-08 build holds verbatim user
    // text; remove it with the session so an upgrade never leaves one behind.
    try { fs.unlinkSync(carrierPath(cwd, harnessSessionId) + '.prompt'); } catch { /* none */ }
    // Remove the directory when this was the last live session. The self-ignore
    // file is ours, so it does not count as "still in use" — drop it only when
    // nothing else remains, and never touch a directory another session is using.
    try {
        const dir = carrierDir(cwd);
        const left = fs.readdirSync(dir).filter((f) => f !== '.gitignore');
        if (left.length === 0) {
            try { fs.unlinkSync(path.join(dir, '.gitignore')); } catch {}
            fs.rmdirSync(dir);
        }
    } catch { /* other sessions still live, or already gone */ }
}

// Until 2026-09-08 a `<id>.prompt` file sat beside each session id, written by
// a UserPromptSubmit hook and read by the observation classifier to derive an
// observation's type and concept. The classifier stopped reading the prompt
// (docs/evidence-memory-recall-2026-09-08.md: it produced a keyword guess and a
// concept column full of other sessions' messages), so the hook, this file and
// the three functions that carried it were removed together. A stale
// `.prompt` file from an older plugin build is deleted by clear() below along
// with the session id, so nothing verbatim outlives its session.

module.exports = { carrierDir, carrierPath, write, read, clear };
