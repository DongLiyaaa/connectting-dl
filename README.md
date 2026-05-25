# connectting-dl

`connectting-dl` is a lightweight Feishu to Codex CLI bridge aimed at small team deployments.

Current MVP includes:

- Feishu event callback server
- Multi-user and multi-group session isolation
- Owner command channel with explicit cross-session access controls
- `codex exec` integration for non-interactive replies
- Local SQLite session persistence
- Explicit attachment sending protocol for files and images

## Install

```bash
npm install -g connectting-dl
```

Or from a local checkout:

```bash
cd projects/connectting-dl
npm link
```

## Quick Start

1. Run the installer.

```bash
connectting-dl init
```

This creates:

- `~/.connectting-dl/config.json`
- `~/.connectting-dl/data`
- `~/.connectting-dl/workspace`

During `init`, the terminal prompts for:

- Feishu `app_id`
- Feishu `app_secret`
- owner `open_id`

2. Verify local setup.

```bash
connectting-dl doctor
```

3. Start the bridge.

```bash
connectting-dl serve
```

4. Configure Feishu event subscription callback to:

```text
http(s)://<your-host>:8787/feishu/events
```

## MVP Behavior

### Session isolation

- P2P chat: isolated by `chat_id + user_open_id`
- Group chat: isolated by `chat_id`
- The same user speaking in two different groups does not share history

### Owner controls

Owners can use chat commands:

- `/ctl help`
- `/ctl sessions`
- `/ctl health`
- `/ctl ownerlog`
- `/ctl attachlog`
- `/ctl sendimage <path>`
- `/ctl sendfile <path>`
- `/ctl show <sessionId>`

`/ctl show` is denied unless `owner.allowReadAllSessions` is explicitly enabled.

The owner identity is configured in `owner.openIds` inside `~/.connectting-dl/config.json`.

### Explicit attachments

The main reply flow supports an attachment directive appended to the assistant output:

````text
正常可见回复内容

```connectting-dl
{
  "attachments": [
    { "path": "/absolute/path/report.pdf", "type": "file" },
    { "path": "./artifacts/chart.png", "type": "image" }
  ]
}
```
````

Rules:

- visible text is sent as a normal text reply
- each attachment is uploaded and replied after the text
- relative paths are resolved from `codex.workDir`
- if `type` is omitted, common image extensions are treated as images and everything else is sent as a file

## Local commands

```bash
connectting-dl doctor
connectting-dl serve
connectting-dl init
```

Non-interactive init is also supported:

```bash
connectting-dl init \
  --owner-open-id ou_xxx \
  --app-id cli_xxx \
  --app-secret xxx
```

## Feishu scopes

The Feishu app should be allowed to:

- receive message events
- send messages
- access app credentials for tenant token exchange

Exact app permissions depend on whether you run in internal or marketplace mode.

## Notes

- This MVP focuses on text messages first.
- Encrypted Feishu callbacks are supported when `encryptKey` is configured.
- `codex exec` runs with a rolling transcript window, not a native resumed Codex session.
- default runner args are limited to `codex exec` options that are actually supported by the CLI.
- Duplicate Feishu `message_id` events are ignored after the first successful handling.
- Group messages strip leading `@mention` text before being sent to Codex.
- Legacy `sessions.json` is imported automatically on first SQLite startup.
- Owner control commands are stored in SQLite `owner_actions`, separate from normal chat transcripts.
- Attachment send results are stored in SQLite `attachment_events`.
- Feishu client helpers support image upload/reply and file upload/reply for shadow testing and future media workflows.
- Common office formats such as `pdf`, `doc/docx`, `xls/xlsx`, `ppt/pptx`, plus `txt`, `md`, and other generic files are supported. Unknown formats fall back to Feishu `stream` upload.
- Incoming messages can receive a configurable reaction emoji before processing, and outgoing text replies can include a configurable bot-name prefix.
- The default Codex CLI working directory is `~/.connectting-dl/workspace`.
