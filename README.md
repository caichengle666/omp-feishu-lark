# Feishu/Lark plugin — patched build

A patched redistribution of [**AX1202/pi-feishu-lark**](https://github.com/AX1202/pi-feishu-lark)
(v0.2.4, MIT) that runs against SDK `@oh-my-pi/pi-coding-agent@17.2.10`, plus a
self-contained installer.

Upstream targets `@earendil-works/pi-coding-agent`; on the newer SDK the plugin
fails to load (`Export named 'ModelRuntime' not found`). The `extension/` files
here are upstream sources with the adapter layer rewritten — see
[Patches in this build](#patches-in-this-build). `install.sh` and
`support/feishu-watcher.mjs` are new.

All credit for the plugin itself goes to the upstream author. Bugs in the
patches are not upstream's problem; report plugin bugs upstream and packaging
bugs here.

## Install

Install Bun and omp first, then run this once. Nothing else afterwards.

```bash
bunx @caichengle/omp-feishu-lark
```

The Bun installer supports Windows and Linux. It installs runtime state under
`~/.omp`, uses the package-compatible OMP CLI, migrates an existing legacy
`~/.pi/agent/feishu/config.json`, and waits until the gateway reports
`connected`.

Optional arguments:

```bash
bunx @caichengle/omp-feishu-lark /path/to/feishu
bunx @caichengle/omp-feishu-lark --reconfigure
bunx @caichengle/omp-feishu-lark --no-restart
bunx @caichengle/omp-feishu-lark --workspace DIR
```

For an offline tarball install:

```bash
tar xzf pi-feishu-plugin-patched-20260808-005848.tar.gz
cd pi-feishu-plugin-patched-20260808-005848
./install.sh
```

It resolves `bun`/`omp` off PATH, installs `@larksuiteoapi/node-sdk` into
`~/.omp/plugins` when missing, asks for credentials, starts the daemon, and
exits once the gateway reports `connected`. At that point the bot answers in
Feishu.

```
./install.sh                     # default dir ~/.pi/extensions/feishu
./install.sh /path/to/feishu     # explicit plugin dir
./install.sh --reconfigure       # re-enter credentials over an existing config
./install.sh --no-restart        # install sources only, leave the daemon alone
./install.sh --workspace DIR     # override the daemon's default workspace
```

Every path derives from `$HOME`, so a non-root install works unchanged.

### Architecture (arm64 / x86_64)

The package is architecture-independent and needs no per-arch variant. It ships
21 `.ts`/`.mjs` source files plus this README — zero binaries, and the installer
downloads no prebuilt artifacts. Everything arch-specific already lives in the
`bun`/`omp` you installed beforehand.

The one runtime dependency, `@larksuiteoapi/node-sdk`, is pure JavaScript
(`axios`, `ws`, `protobufjs`, `lodash.*`, `qs`) with no `.node` addons and no
`cpu`/`os` restrictions in its manifest, so `bun add` resolves the same package
on either platform. Step 2 still proves it by importing the SDK and asserting
`WSClient` exists, printing the detected `uname -m`; a truncated or
wrong-platform install fails there instead of at the first Feishu message.

The compile gate's output filter is likewise arch-neutral. It suppresses the
unresolved `@oh-my-pi/*` imports (supplied by the omp runtime, never resolvable
from the plugin directory on any platform) and the `pi_natives` probe warning.
Real syntax errors survive the filter — verified on aarch64 by injecting one.

### Workspace

The daemon is launched with `--cwd <workspace> --allow-home`. Both matter:
omp auto-relocates to a temp dir when started in a bare home, and the cwd is
the default workspace for new sessions. The workspace is derived from
`PLUGIN_DIR` (`<root>/.pi/extensions/feishu` → `<root>`), never inherited from
wherever the installer happened to run — unpacking to a temp dir and deleting
it would otherwise strand every session. The watcher applies the same rule.

`PI_FEISHU_DAEMON=1` is set on the launch so the plugin does not autostart a
second daemon on top of the one the installer just started.

The installer snapshots an existing plugin dir to
`<dir>.before-restore-<timestamp>` before copying, compile-checks the sources,
and waits up to 90s for `connected`.

### Interactive setup

`config.json` and `models.yml` carry secrets and are excluded from the tarball,
so the installer asks for them when they are missing:

| Prompt | Notes |
|---|---|
| App ID | from 开放平台 > 你的应用 > 凭证与基础信息 |
| App Secret | not echoed |
| domain | `feishu` or `lark`, default `feishu` |
| group policy | `open` or `mention`, default `open` |

Credentials are checked against
`/open-apis/auth/v3/tenant_access_token/internal` before anything is written; a
rejected pair re-prompts instead of leaving a daemon that cannot connect.
`config.json` is written with mode 600.

When `models.yml` is absent the installer offers to write a single-provider
catalog (name, baseUrl, apiKey, default model id). Decline and the plugin still
starts, just with no usable model.

Existing `config.json` / `models.yml` are never overwritten — the run reports
`keeping credentials` and moves on. Use `--reconfigure` to redo them.

### Optional voice transcription

Voice messages are disabled unless both Tencent Cloud credentials are present.
The plugin uses Tencent Cloud's `SentenceRecognition` API and does not install
local Whisper or other model runtimes. Set these variables in the environment
of the process that starts the daemon:

```powershell
$env:TENCENTCLOUD_SECRET_ID="your-secret-id"
$env:TENCENTCLOUD_SECRET_KEY="your-secret-key"
```

On Linux/macOS use `export` instead. Feishu audio is downloaded and sent to
Tencent as a short Chinese voice message; the resulting text is then handled
like a normal prompt. Without these variables, text, image, and file messages
continue to work normally and voice messages receive a configuration error.

Prompts read from stdin, so a scripted install works too:

```bash
printf 'cli_xxx\nsecret\nfeishu\nopen\n' | ./install.sh
```

## Contents

```
extension/   20 plugin .ts sources (4 patched, 16 untouched)
support/     feishu-watcher.mjs — hot-reload watcher
install.sh   interactive setup + restore + restart + verify
```

## What is NOT in this package

Machine-local state, deliberately excluded:

| File | Why |
|---|---|
| `~/.omp/agent/feishu/config.json` | contains `appId` / `appSecret` |
| `~/.omp/agent/feishu/state.json` | per-chat session and model bindings |
| `~/.omp/agent/models.yml` | model catalog + API keys |

On a machine that has never run the plugin, the installer's credential prompts
cover everything `/feishu setup` would have written.

These files are also listed in `.gitignore`: they must never be committed, and
the installer writes them with mode `600`.

## Patches in this build

### 1. SDK 17.2.10 adapter (`conversation-manager.ts`, `index.ts`, `setup.ts`)

- `ModelRuntime` no longer exists → `discoverModels(discoverAuthStorage(agentDir), agentDir)`
  returning a `ModelRegistry`.
- `DefaultResourceLoader` removed → system prompt moved into
  `createAgentSession({ systemPrompt: [...] })`.
- Package rename `@earendil-works` → `@oh-my-pi`.

### 2. `SessionManager.open` signature fix (`conversation-manager.ts`)

The 17.2.10 signature is
`open(filePath, sessionDir?, storage?, options?: { initialCwd?, suppressBreadcrumb? })`
and returns a Promise. The old call passed the workspace cwd into the `storage`
slot, producing `storage.statSync is not a function`. Now:

```ts
await SessionManager.open(existingFile, undefined, undefined, { initialCwd: workspaceCwd })
```

`getWorkspaceFromSessionFile` became async and reads
`(await SessionManager.peekSessionInit(path))?.cwd`.

### 3. Provider errors surfaced instead of swallowed (`conversation-manager.ts`)

The SDK records provider failures on the assistant message's `errorMessage`
field — it does **not** throw. The old `extractLastAssistantText` only read
`content`, so a failed turn produced an empty string and the user saw a bare
`"No response."` with no clue why.

`extractLastAssistantOutcome` now returns `{ text, error }`; an empty turn
carrying an error replies `模型调用失败：<reason>` and marks the status card
`failed`. Text extraction moved into `extractTextContent`, written against
`unknown` with `in`/`typeof` narrowing (no `any`).

This surfaced the actual incident: model `hy3-free` returns
`401 Model hy3-free is not supported`, which had been masked as `"No response."`.

### 4. Case-insensitive bot commands (`messages.ts`)

`parseBotCommand` lowercases input, so `/MODEL` and `/model` both work.

### 5. models.yml auto-refresh (`index.ts`)

The daemon watches `~/.omp/agent/models.yml` (`fs.watch`, 1s debounce) and
calls `conversations.refreshModels()` on change. Necessary because `/feishu
refresh` runs in a one-shot RPC session that exits without touching the
long-lived daemon's cached registry.

### 6. Model warmup (`conversation-manager.ts`)

`warmupModels()` primes the `ModelRegistry` during daemon startup so the first
`/model` command does not block on provider discovery timeouts.

### 7. Real watcher restarts (`support/feishu-watcher.mjs`)

The previous `doRestart()` spawned a one-shot RPC session running
`-p "/feishu restart"`. It logged success while the daemon pid never changed —
the reload silently did nothing. It now manages the process directly: SIGKILL
the locked pid, delete `locks.json`, respawn, and poll the lock until
`connected` (60s cap).

Note the spawn keeps stdin open via `tail -f /dev/null | exec omp --mode rpc …`.
RPC mode exits immediately on stdin EOF; without the pipe the daemon dies at
startup.

## Provider reliability

The plugin performs **no retries**. A transient upstream 502/503 surfaces to the
user as a hard failure rather than being silently retried, which keeps a real
outage distinguishable from a slow model. Adding backoff is a deliberate
follow-up, not an oversight.

If a model stops answering, check the daemon log for the recorded
`errorMessage` before assuming the plugin is at fault:

```bash
tail -f ~/.omp/agent/feishu/debug.log
```

## License

MIT — see [LICENSE](LICENSE). The plugin sources under `extension/` originate
from [AX1202/pi-feishu-lark](https://github.com/AX1202/pi-feishu-lark) and
remain under their original MIT terms; the patches, `install.sh`, and
`support/feishu-watcher.mjs` are released under the same license.
