# Exact-binary no-model hook inspection route

**Supported discovery protocol found; no live hooks/list response obtained.** The default running-daemon endpoint is absent. No daemon was started, no native hooks were executed, no model call was made, and no installed configuration/cache was changed. This is not an admission pass.

## Actually executed

1. `codex app-server proxy --help` exited 0 and advertises a stdio proxy to the running app-server control socket, with `--sock <SOCKET_PATH>`. `codex app-server daemon --help` separately lists version/start/bootstrap/restart.
2. `codex app-server daemon version` exited **1**: `failed to connect to <home>/.codex/app-server-control/app-server-control.sock`, caused by `No such file or directory (os error 2)`. The endpoint was not created and no start/bootstrap/restart was attempted. This proves only that the documented default endpoint was unavailable, not that the desktop app has no internal server or that another explicit socket could not exist.
3. The exact installed binary successfully generated its protocol schema, without starting an app-server:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-json-schema --out <audit-worktree>/.claude/reports/brain-live-audit/host-compatibility-native-schema
```

Exit **0**, empty stdout/stderr; **304 JSON schema files**, including `v2/HooksListParams.json`, `v2/HooksListResponse.json`, `v1/InitializeParams.json` and `v1/InitializeResponse.json`. Exact hashes and schema objects are retained in `host-compatibility-native-schema-evidence.json`. This confirms this executable's protocol shapes, not plugin parsing or command execution. Its CLI dispatch directly calls protocol generation (`cli/src/main.rs` following line 1365); it does not enter the standalone server startup path.

## Read-only existing-server route: exact proposed invocation

For a separately verified existing endpoint, the native client invocation is:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex app-server proxy --sock /absolute/verified/existing/control.sock
```

Use argv directly, not a shell interpolation. The socket must already exist and belong to the intended host. The standard endpoint above currently does not. The proxy implementation (`cli/src/main.rs:1344–1353`) resolves the supplied/default socket and calls `codex_stdio_to_uds::run`; it does not start a server or construct a modified server configuration. **Passing `-c` to this proxy does not create a disposable server-side config override**; this branch does not forward CLI overrides into the existing server's config manager.

Send newline-delimited JSON and wait for each response before the next dependent message:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"autodev_hook_audit","version":"0.1.0"}}}
```

After response id 1 succeeds, read back `userAgent`, `platformOs` and `platformFamily`; retain only whether the returned host/version matches the intended native binary. An executable proxy version is not the receiver's version. Do not expose `codexHome` or other unrelated session state. Then send:

```json
{"method":"initialized"}
{"id":2,"method":"hooks/list","params":{"cwds":["<audit-worktree>"]}}
```

Await response id 2 with a bounded timeout, then close only this proxy connection. Never send `thread/start`, `turn/start`, archive, config-write, plugin install/trust or execution requests. No prompt is supplied. Reject an error response; do not interpret empty hooks as successful admission. Retain only autodev hook metadata: handler type, command identity/hash, event, source path/hash, timeout, enabled/trust state, warnings/errors. Exclude unrelated plugin names, raw user hook commands and all prompts/secrets. Keep error text only when it describes the inspected autodev source; summarize other errors by category/count.

The version-pinned protocol defines `hooks/list` as `global_shared_read("config")` (`app-server-protocol/src/protocol/common.rs:819–822`). The actual request processor (`app-server/src/request_processors/catalog_processor.rs:570–635`) reloads effective configuration for each cwd, obtains plugin hook sources, calls `codex_hooks::list_hooks`, and returns hook metadata/warnings. It does not call the command runner, create a thread or begin a turn. The native test `hooks_list_shows_discovered_hook` (`app-server/tests/suite/v2/hooks_list.rs:188–244`) lists an **untrusted** command and asserts its nonempty metadata without running a model or requiring a hook side effect.

Caveat: listing warms plugin capabilities (`hooks_list_warms_plugin_capabilities_for_thread_start` in the same suite). A shared-read request class is not a blanket guarantee of no internal cache activity. The persistent versus process-local effects of `plugins_for_config` were not exhaustively audited here. Under the current strict no-cache-mutation restriction, a real connection should proceed only after that concern is resolved for the chosen existing host; no live hooks/list call occurred in this pass.

## Why a fresh stdio server is not a read-only substitute

Do **not** simply run `codex app-server --stdio` against the current host to get around the missing daemon. The exact source (`app-server/src/lib.rs:470–515,570–620`) resolves the live Codex home, builds configuration/auth/environment managers, installs telemetry and initializes SQLite state before serving requests. Source explicitly includes corruption recovery for that SQLite initialization. Even with no model turn, startup is not established as inert.

The source's test user-config-file override is guarded by `debug_assertions` (`app-server/src/lib.rs:1338–1370`); release builds return None. It is not a supported way to point the installed release binary at a disposable config file. No HOME or CODEX_HOME environment variable was reassigned. A `-c` override changes named TOML values; it does not by itself isolate every runtime/cache/settings write or change default plugin-file discovery.

A future fresh-server fixture must first establish complete write containment and explicit local runtime destinations, or use an isolated OS environment; do not invent a magic no-write flag. Use disposable plugin copies and native test fixtures there. Do not turn the current constraint into a permission to edit the real plugin cache. No such fresh-server invocation is certified safe by this pass.

## Parser and runner oracle, and the actual args finding

Version-pinned official source is commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (tag rust-v0.153.4). `config/src/hook_config.rs:163–183` defines command, commandWindows, timeout, async, statusMessage and additionalContextLimit, but **no args field**. The command runner `hooks/src/engine/command_runner.rs:391–423` receives one command_line and passes it to the shell. That is a source-grounded inference that separate plugin args do not supply the script invocation on this host; it is not an observed native command launch. A matching live hooks/list record showing only command `node` would verify normalization, still not execution.

The parent comparison `host-event-source-comparison.json` records native 12 event declarations; core 20/20 and memory 4/4 handlers use separate args; three core handler events are unlisted. This is a static source comparison.

For the native parser fixture, keep four copies: current core (unknown modules must reject), core command-only projection (must disclose missing Claude function protections and unsupported events), current memory (timeout clamp plus normalized command metadata), and corrected fixed-command memory projection. Assert nonempty expected hooks and semantic command/path identity, not just empty errors. Preserve separate unsupported-event outcomes even if deserialization ignores unknown event names. All future projections leave the Claude source unchanged.

For the runner, the existing native `codex-hooks` engine tests are the appropriate no-model oracle on an isolated pinned source build. The existing public proxy/discovery protocol is **not** a hook execution API. Do not repurpose `command/exec` as a hook-runner proof. Native host initialization/session events can execute hooks without a model, but doing so requires an explicitly isolated host containing only synthetic canaries; that is outside this pass. Use one canary whose expected side effect proves the actual script received the payload and one invalid/missing-script control; after that, test native tool aliases/input shapes and timeout/blocked-side-effect behavior separately.

## Verdict and retained evidence

There is a supported no-model metadata discovery method and an exact native schema-generation command. The current accessible default daemon route is unavailable; no parser/discovery or runner success is claimed for installed autodev. Existing source strongly supports args loss and unsupported-event gaps, but actual command invocation is still unproven. Code-generation success remains insufficient for Brain harness admission.

Read-only/ignored outputs: `host-compatibility-native-route-evidence.json`, generated native schema/evidence, and the pinned source files. Source tree cleanliness was checked after this pass.
