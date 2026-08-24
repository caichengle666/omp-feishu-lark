# Feishu/Lark OMP plugin — patched build

A patched redistribution of [**AX1202/pi-feishu-lark**](https://github.com/AX1202/pi-feishu-lark)
(v0.2.4, MIT) that supports SDK `@oh-my-pi/pi-coding-agent >=17.2.12`, plus a
self-contained installer.

Upstream targets `@earendil-works/pi-coding-agent`; on the newer SDK the plugin
fails to load (`Export named 'ModelRuntime' not found`). The `extension/` files
here are upstream sources with the adapter layer rewritten — see
[Patches in this build](#patches-in-this-build). The Bun installer and
`support/feishu-supervisor.mjs` are included.

All credit for the plugin itself goes to the upstream author. Bugs in the
patches are not upstream's problem; report plugin bugs upstream and packaging
bugs here.

## v0.4.62 highlights

- RPC launches ignore interactive `approvalMode` flags because the OMP RPC channel does not expose tool-permission responses; this prevents permanent approval waits. Tool approval-card support remains an OMP upstream responsibility.
- Provider commands accept `api: auto` and persist `openai-completions` only after a successful `/models` probe; explicit protocols are preserved.

## v0.4.60 highlights

- Active Feishu task cards are persisted and recovered after daemon restarts.
- Interrupted tasks are marked explicitly instead of remaining stuck on
  “仍在处理”.
- Normal daemon shutdown finalizes active task cards before closing transport.

- Model configuration management is named `Provider` consistently; the old
  `/feishu gateway ...` model commands are no longer accepted.
- Added `/feishu provider sync <名称>` and `/feishu provider sync-all` to persist
  upstream OpenAI-compatible model changes into `models.yml`.
- Only providers with `feishuManaged: true` are synchronized; Anthropic models
  remain manually managed because Anthropic has no standard model-list endpoint.

To enable persistent upstream model synchronization, edit
`~/.omp/agent/models.yml` (on Windows, usually
`C:\\Users\\<用户名>\\.omp\\agent\\models.yml`) and set
`feishuManaged: true` for the Provider:

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: your-api-key
    api: openai-completions
    feishuManaged: true
```

Then run `/feishu provider sync my-provider`, or
`/feishu provider sync-all` to synchronize every managed Provider. Providers
without `feishuManaged: true` are never rewritten by automatic synchronization.

## v0.4.57 highlights

## v0.4.55 highlights

- Combines the administrator Skill controls from v0.4.54 with Feishu model
  Provider management from the local branch.
- Feishu administrators can use `/feishu provider list|add|test|remove` and
  `/feishu skills on|off`; both command families are included in the help card,
  completions, authorization checks, and regression tests.
- Provider changes preserve the existing model configuration, enable online
  discovery, and refresh the active OMP model registry.

For persistent model synchronization, a managed provider looks like this:

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: your-key
    api: openai-completions
    feishuManaged: true
```

## v0.4.54 highlights

- Help cards now provide administrator-only Skill on/off buttons.
- `/feishu skills on|off` persists the setting and restarts the daemon so new RPC workers apply it.
- RPC workers now inherit the configured OMP Skill, tool, approval, timeout, prompt, and directory policy.

## v0.4.53 highlights

- `/feishu refresh` now forces an online model registry refresh instead of only refreshing a prewarmed cache, and reports the resulting model count.
- The internal OMP model database is refreshed; hand-edited `models.yml` remains untouched.
- Remaining Feishu-facing fallback labels now use the OMP brand.
- Feishu administrators can manage multiple OMP model providers with `/feishu provider list`, `/feishu provider add <名称> <baseUrl> <API Key> [api] [modelId...]`, `/feishu provider test <名称>`, and `/feishu provider remove <名称> confirm`. Set `api` to `auto` to probe the OpenAI-compatible `/models` endpoint and persist `openai-completions`; existing explicit protocols are never changed. Anthropic still requires `anthropic-messages` and static model IDs.
- OpenAI providers use OMP's `openai-models-list` discovery. Anthropic providers use the `anthropic-messages` API and require one or more static model IDs. API keys are never shown in provider listings.

## v0.4.52 highlights


- `/help` now returns an interactive Feishu card with the complete plugin/chat
  command reference, common one-click actions, parameter-prefill buttons, and a
  command input form. Card actions remain bound to the originating user and chat.
- `/feishu upgrade <x.y.z>` now accepts both upgrades and downgrades; omitting the
  version still follows the npm latest tag.
- Duplicate Feishu deliveries of the same command are suppressed within the
  existing five-second content window, preventing one `/help` message from
  producing two cards when event IDs differ.
- OMP daemon launch behavior can be configured through `ompLaunch`, including
  skills, tools, approval mode, maximum session time, appended system prompt,
  and additional workspace directories.
- Installer startup, OS auto-start, daemon recovery, and the disposable RPC
  readiness check now use the same normalized OMP launch options.
- The OMP peer range accepts 17.2.12 and newer releases.

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
bunx @caichengle/omp-feishu-lark --install-service
```

`--install-service` registers the OS auto-start entry after files are in place.
The same entry is toggled later with `/feishu autostart`: Linux uses systemd,
macOS uses launchd, and Windows uses Task Scheduler. In every case the OS starts
`feishu-supervisor.mjs`, which then starts the OMP daemon, so reboot recovery
keeps the same supervisor lifecycle as a normal start. A daemon that detects a
missing supervisor also starts one replacement through the same launch spec and
exits, which is a cross-platform runtime fallback for orphaned processes.
Disabling OS auto-start does not stop an already running Feishu connection.

To update an existing installation to the newest published version, run:

```bash
bunx @caichengle/omp-feishu-lark@latest
```

To install a specific published version, including a downgrade, run:

```text
/feishu upgrade 0.4.14
```

When a version is specified, the installer pins that exact version. The command
accepts both newer and older versions; omit the version to use the npm latest tag.

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

### OMP daemon launch options

Add an optional `ompLaunch` object to `~/.omp/agent/feishu/config.json` when the
remote OMP workers need a non-default tool or skill policy:

```json
{
  "ompLaunch": {
    "enableSkills": true,
    "skills": ["git-*", "docker"],
    "tools": ["read", "bash", "edit", "write"],
    "approvalMode": "write",
    "maxTime": "30m",
    "appendSystemPrompt": "Keep tests green before finishing.",
    "addDirs": ["/srv/shared-project"]
  }
}
```

`approvalMode` accepts `always-ask`, `write`, or `yolo`. `maxTime` accepts a
number with an optional `s`, `m`, or `h` suffix. Skills remain disabled by
default; a non-empty `skills` list enables them automatically. Set
`enableSkills` to `false` to explicitly keep skills disabled.

Environment-only configurations can use `FEISHU_OMP_ENABLE_SKILLS`,
`FEISHU_OMP_SKILLS`, `FEISHU_OMP_TOOLS`, `FEISHU_OMP_APPROVAL_MODE`,
`FEISHU_OMP_MAX_TIME`, `FEISHU_OMP_APPEND_SYSTEM_PROMPT`, and
`FEISHU_OMP_ADD_DIRS`. List values are comma-separated.

### Commands

Run `/feishu help` in OMP, or send `/feishu help` or `/help` to the bot, for a
Chinese description of every plugin and chat command. In Feishu, the response
is an interactive card: common commands execute directly, parameterized
commands can prefill the form, and the current OMP session's available slash
commands are appended below the static reference.

Administrators can send `/send PATH` in Feishu to upload a file from the current chat workspace.
Supported images are sent as image messages; other files are uploaded through the
bot file API. Administrators can inspect
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

### 1. SDK 17 adapter (`conversation-manager.ts`, `index.ts`, `setup.ts`)

- `ModelRuntime` no longer exists → `discoverModels(discoverAuthStorage(agentDir), agentDir)`
  returning a `ModelRegistry`.
- `DefaultResourceLoader` removed → system prompt moved into
  `createAgentSession({ systemPrompt: [...] })`.
- Package rename `@earendil-works` → `@oh-my-pi`.

### 2. `SessionManager.open` signature fix (`conversation-manager.ts`)

The supported SDK range uses the signature
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
