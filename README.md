# Feishu/Lark OMP plugin — patched build

A patched redistribution of [**AX1202/pi-feishu-lark**](https://github.com/AX1202/pi-feishu-lark)
(v0.2.4, MIT) that runs against SDK `@oh-my-pi/pi-coding-agent@17.2.10`, plus a
self-contained installer.

Upstream targets `@earendil-works/pi-coding-agent`; on the newer SDK the plugin
fails to load (`Export named 'ModelRuntime' not found`). The `extension/` files
here are upstream sources with the adapter layer rewritten — see
[Patches in this build](#patches-in-this-build). The Bun installer and
`support/feishu-supervisor.mjs` are included.

All credit for the plugin itself goes to the upstream author. Bugs in the
patches are not upstream's problem; report plugin bugs upstream and packaging
bugs here.

## Install

Install Bun and omp first, then run this once. Nothing else afterwards.

```bash
bunx @caichengle/omp-feishu-lark
```

The bin launcher is Node-compatible and resolves Bun from `BUN_BIN_PATH`, the
standard `~/.bun/bin` / `%USERPROFILE%\.bun\bin`, or PATH, so `npx` and npm
scripts also work even when Bun is not on the current PATH.

The Bun installer supports Windows, Linux, and macOS. It installs runtime state under
`~/.omp` (or `PI_CODING_AGENT_DIR` when set), uses the package-compatible OMP CLI, migrates an existing legacy
`~/.pi/agent/feishu/config.json`, and waits until the gateway reports
`connected`, then starts a disposable OMP RPC worker and requires its `ready`
frame. Installation fails with a direct diagnostic if Feishu can connect but
OMP conversations cannot start.

Optional arguments:

```bash
bunx @caichengle/omp-feishu-lark /path/to/feishu
bunx @caichengle/omp-feishu-lark --reconfigure
bunx @caichengle/omp-feishu-lark --no-restart
bunx @caichengle/omp-feishu-lark --workspace DIR
```

To update an existing installation to the newest published version, run:

```bash
bunx @caichengle/omp-feishu-lark@latest
```

The updater keeps `config.json`, conversation mappings, model configuration,
and logs. It stops the old supervisor, prepares and compile-checks the complete
new plugin in a staging directory, atomically replaces the old plugin
directory, removes staging and backup files, then starts the new supervisor and
verifies both the Feishu gateway and an OMP RPC worker.

It resolves `bun`/`omp` off PATH, installs runtime dependencies inside the
plugin directory, asks for credentials, starts the daemon, and
exits once the gateway reports `connected`. At that point the bot answers in
Feishu.

The daemon log rotates at 5 MiB and keeps one previous file as
`daemon.log.1`; the structured debug log keeps its most recent 1000 entries.
Debug events are batched into asynchronous writes so card updates do not block
message handling on slow disks.
CI runs the type check, tests, and Bun build on Windows, Linux, and macOS.

Every path derives from `$HOME`, so a non-root install works unchanged. The
extension itself uses OMP's `getAgentDir()` API, so OMP profiles resolve to the
same directory as the host. The installer forwards OMP 17's historical
`PI_CODING_AGENT_DIR` environment name only when launching detached workers;
this is an OMP compatibility variable, not a Pi plugin dependency.

### Architecture (arm64 / x86_64)

The package is architecture-independent and needs no per-arch variant. It ships
TypeScript/JavaScript source files plus this README — zero plugin binaries, and
the installer downloads no prebuilt plugin artifacts. Everything arch-specific
already lives in the `bun`/`omp` you installed beforehand.

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
wherever the installer happened to run.

`PI_FEISHU_DAEMON=1` is set on the launch so the plugin does not autostart a
second daemon on top of the one the installer just started.

During an upgrade the installer stops the existing supervisor, prepares the
new plugin and its runtime dependencies in a staging directory, compile-checks
it, then swaps the directory and removes the old copy. Failed preparation keeps
the previous plugin intact; successful upgrades remove the staging/backup
directories. Configuration, sessions, models, and logs remain under the OMP
agent directory. The installer then starts the new supervisor and waits up to
90s for `connected`.

### Interactive setup

`config.json` and `models.yml` carry secrets and are excluded from the tarball,
so the installer asks for them when they are missing:

| Prompt | Notes |
|---|---|
| App ID | from 开放平台 > 你的应用 > 凭证与基础信息 |
| App Secret | not echoed |
| domain | `feishu` or `lark`, default `feishu` |
| group policy | `open` or `mention`, default `mention` |

Credentials are checked against
`/open-apis/auth/v3/tenant_access_token/internal` before anything is written; a
rejected pair re-prompts instead of leaving a daemon that cannot connect.
`config.json` is written with mode 600.

The installer does not overwrite `models.yml`; create or edit the OMP model
catalog separately when you need a provider. The daemon reloads that file after
an atomic save, so new model entries become available without reinstalling.

Existing `config.json` / `models.yml` are never overwritten — the run reports
`keeping credentials` and moves on. Use `--reconfigure` to redo them.

### Webhook / CI proactive notifications

The daemon can expose a token-protected HTTP endpoint for CI systems and other
automation. It is disabled by default and listens only on `127.0.0.1` unless
you explicitly choose another host. Add these fields to
`~/.omp/agent/feishu/config.json`:

```json
{
  "notificationWebhookEnabled": true,
  "notificationWebhookHost": "127.0.0.1",
  "notificationWebhookPort": 3002,
  "notificationWebhookPath": "/webhook/notify",
  "notificationWebhookToken": "replace-with-a-long-random-token"
}
```

Then run `/feishu restart`. Send a notification to a conversation that has
already messaged the bot at least once:

```bash
curl -X POST http://127.0.0.1:3002/webhook/notify \
  -H "Authorization: Bearer replace-with-a-long-random-token" \
  -H "Content-Type: application/json" \
  -d '{"sessionKey":"group:oc_xxx","text":"CI failed","eventId":"github-run-123"}'
```

`sessionKey` is the existing route key stored in
`~/.omp/agent/feishu/bridge.json`. `eventId` is optional; when supplied it is
used to suppress repeat delivery. The same settings can be supplied through
`FEISHU_NOTIFY_WEBHOOK_ENABLED`, `FEISHU_NOTIFY_WEBHOOK_HOST`,
`FEISHU_NOTIFY_WEBHOOK_PORT`, `FEISHU_NOTIFY_WEBHOOK_PATH`, and
`FEISHU_NOTIFY_WEBHOOK_TOKEN`.

### Commands

Run `/feishu help` in OMP, or send `/feishu help` or `/help` to the bot, for a
Chinese description of every plugin and chat command.

In Feishu, send `/send PATH` to upload a file from the current chat workspace.
Supported images are sent as image messages; other files are uploaded through the
bot file API. Group chats require an administrator. Administrators can inspect
masked settings with `/feishu config` in OMP or Feishu.

When an OMP task succeeds, generated images, documents, and audio files are
automatically sent back to the current Feishu conversation. `/send PATH` remains
available as a manual fallback. Group chats require an administrator for manual
sends.

New installations reply in groups only when the bot is mentioned. Choose
`open` only for a trusted group: group messages can invoke OMP tools in the
configured workspace.

`/resume` only lists session files previously created or selected by the current
Feishu conversation. Action cards are bound to the user and chat that opened them.

Remote administrative commands such as `/feishu upgrade` are denied by
default. Add the administrator's Feishu Open ID to `adminOpenIds` in
`config.json`, or set a comma-separated `FEISHU_ADMIN_OPEN_IDS` environment
variable. A denied command replies with the caller's Open ID.

### Upgrading older installs

The installer migrates older Windows, Linux, and macOS layouts before starting
the shared supervisor. It stops the legacy watcher, removes its launcher files,
disables a verified legacy `omp-feishu.service` on Linux, removes only plugin
directories whose manifest or source identifies this package, and upgrades an
older OMP npm plugin registration. Runtime data under `~/.omp/agent/feishu`
and `models.yml` are preserved. `--no-restart` skips process migration so an
existing daemon is left running exactly as requested.

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

## Contents

```
extension/   Feishu/Lark plugin sources
support/     feishu-supervisor.mjs — cross-platform daemon supervisor
src/cli.ts   interactive install + configure + restart + verify
```

## What is NOT in this package

Machine-local state, deliberately excluded:

| File | Why |
|---|---|
| `~/.omp/agent/feishu/config.json` | contains `appId` / `appSecret` (or `$PI_CODING_AGENT_DIR/feishu/config.json`) |
| `~/.omp/agent/feishu/state.json` | per-chat session and model bindings |
| `~/.omp/agent/models.yml` | model catalog + API keys |

On a machine that has never run the plugin, the installer's credential prompts
create the same `config.json` that `/feishu setup` writes. Inside OMP, run
`/feishu setup` at any time to create or replace that file interactively.

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

### 7. Cross-platform daemon supervisor (`support/feishu-supervisor.mjs`)

The installer and `/feishu start|restart|stop` use the same Bun supervisor on
Windows, Linux, and macOS. It starts OMP without a shell, keeps RPC stdin open,
restarts crashed daemons with capped exponential backoff, and shuts down through
a portable control file before upgrades replace plugin files.

Gateway ownership includes a random launch token and a Linux process-start
fingerprint. File and spawn locks use renewable leases and never continue
without mutual exclusion. A restart waits for the old supervisor and gateway
to exit before starting a replacement, and startup succeeds only when the
daemon created by that exact launch reports `connected`.

### 8. Isolated concurrent conversations (`rpc-worker-pool.ts`)

Each Feishu conversation owns a separate OMP RPC worker, session file, model,
abort target, and prompt queue. Different conversations run concurrently while
messages in the same conversation remain ordered. Idle workers are reclaimed
and restored from their saved session files when needed.

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
remain under their original MIT terms; the patches, Bun installer, and
`support/feishu-supervisor.mjs` are released under the same license.
