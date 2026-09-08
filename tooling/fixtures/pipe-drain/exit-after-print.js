// The control for tooling/pipe-drain.js: prints ~9 KB then calls process.exit()
// with the write still queued. Through a stalled pipe on macOS this MUST arrive
// truncated; if it arrives whole, the harness is not exercising the async path
// and no verdict it gives about a real script means anything.
console.log(JSON.stringify({ control: 'exit-after-print', pad: 'x'.repeat(9000) }));
process.exit(0);
