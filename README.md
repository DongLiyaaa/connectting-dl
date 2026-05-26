# connectting-dl

[English](#english) | [中文](#中文)

---

## English

`connectting-dl` is a lightweight Feishu to Codex CLI bridge aimed at small team deployments.

### Project overview

Current MVP includes:

- Feishu event callback server
- Feishu long connection event receiver
- Multi-user and multi-group session isolation
- Owner command channel with explicit cross-session access controls
- `codex exec` integration for non-interactive replies
- Local SQLite session persistence
- Explicit attachment sending protocol for files and images

### Features / MVP scope

- Text-message-first bridge between Feishu and Codex CLI
- Per-session transcript isolation for P2P and group chats
- Owner-only operational commands for inspection and media sending
- File and image reply support through an explicit attachment directive
- Configurable reaction emoji and outgoing bot-name prefix

### Install

Registry install command for the future published package:

```bash
npm install -g connectting-dl
```

### Connect To Codex CLI

After `connectting-dl` is installed, it talks to the local `codex` executable on your machine.

Recommended setup flow:

1. Install and log in to Codex CLI first.

```bash
codex --help
codex login
```

2. Confirm Codex CLI is callable from your shell.

```bash
which codex
codex exec "Reply with: ok"
```

3. Run `connectting-dl init` and fill in the Feishu app credentials.

```bash
connectting-dl init
```

4. Check or edit `~/.connectting-dl/config.json`.

Key fields:

- `codex.command`: path to the Codex CLI executable
- `codex.workDir`: default project/workspace directory passed to Codex
- `codex.extraArgs`: default `codex exec` arguments used by the bridge

Example:

```json
{
  "codex": {
    "command": "/usr/local/bin/codex",
    "workDir": "/Users/<you>/codex-cli/workspace",
    "extraArgs": [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write"
    ]
  }
}
```

5. Verify the bridge config.

```bash
connectting-dl doctor
```

6. Start the bridge.

```bash
connectting-dl serve
```

Or install it as a background service:

```bash
connectting-dl daemon install
```

7. Open the bot chat and send the first message.

```bash
connectting-dl bind --open
```

That first real Feishu message will:

- verify the Feishu -> connectting-dl ingress path
- trigger `codex exec`
- auto-bind the sender as owner when `owner.openIds` is empty

Notes:

- For daemon mode, using an absolute `codex.command` such as `/usr/local/bin/codex` is more reliable than relying on `PATH`.
- The bridge does not embed Codex. It is only a wrapper around your existing local Codex CLI installation.

### Quick start

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

Owner binding is automatic by default. If `owner.openIds` is empty, the first incoming Feishu sender is persisted as the owner.

2. Verify local setup.

```bash
connectting-dl doctor
```

3. Start the bridge.

```bash
connectting-dl serve
```

4. Choose either Feishu ingress mode:

- Long connection: keep the Feishu app configured for long connection event delivery.
- HTTP callback: configure the Feishu event subscription callback to:

```text
http(s)://<your-host>:8787/feishu/events
```

5. Open the bot chat and trigger owner auto-binding:

```bash
connectting-dl bind --open
```

Then send any message to the bot. If `owner.openIds` is empty, that first sender becomes the owner automatically.

### Default directory layout

- `~/.connectting-dl/config.json`: primary runtime configuration
- `~/.connectting-dl/data`: SQLite database and local state
- `~/.connectting-dl/workspace`: default Codex CLI working directory

### Owner configuration

By default, `owner.openIds` can be left empty during setup. The first incoming Feishu sender is auto-bound and then persisted into `~/.connectting-dl/config.json`.

If you need to pin or change the owner manually later, edit `owner.openIds` directly.

`/ctl show` is denied unless `owner.allowReadAllSessions` is explicitly enabled.

### Session isolation

- P2P chat: isolated by `chat_id + user_open_id`
- Group chat: isolated by `chat_id`
- The same user speaking in two different groups does not share history

### Owner commands

Owners can use chat commands:

- `/ctl help`
- `/ctl sessions`
- `/ctl health`
- `/ctl ownerlog`
- `/ctl attachlog`
- `/ctl sendimage <path>`
- `/ctl sendfile <path>`
- `/ctl show <sessionId>`

### Attachment directive

The main reply flow supports an attachment directive appended to the assistant output:

````text
Normal visible reply text

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

### Local commands

```bash
connectting-dl doctor
connectting-dl serve
connectting-dl init
connectting-dl bind --open
connectting-dl send --open-id ou_xxx --text "hello"
```

`connectting-dl bind` prints an AppLink that opens the bot chat:

```text
https://applink.feishu.cn/client/bot/open?appId=<your_app_id>
```

`connectting-dl send` can proactively send a text message as the bot to either:

- `--open-id <open_id>`
- `--chat-id <chat_id>`

Non-interactive init is also supported:

```bash
connectting-dl init \
  --owner-open-id ou_xxx \
  --app-id cli_xxx \
  --app-secret xxx
```

### Daemon / background running

`connectting-dl` does not currently include a built-in process supervisor.

If you want background running and crash auto-restart:

- `connectting-dl daemon install`: install the native per-user daemon for the current OS
- `connectting-dl daemon status`: show a friendly runtime summary
- `connectting-dl daemon logs --lines 100`: tail recent daemon logs
- `connectting-dl daemon uninstall`: remove the native per-user daemon

See:

- [docs/daemon.md](./docs/daemon.md)
- [docs/launchd.connectting-dl.plist](./docs/launchd.connectting-dl.plist)
- [docs/connectting-dl.service](./docs/connectting-dl.service)

The CLI automatically chooses the host service manager:

- macOS: `launchd`
- Linux: `systemd --user`

### Feishu scopes

The Feishu app should be allowed to:

- receive message events
- send messages
- access app credentials for tenant token exchange

Exact app permissions depend on whether you run in internal or marketplace mode.

### Notes / caveats

- This MVP focuses on text messages first.
- `verificationToken` and `encryptKey` are optional. Leave them empty unless your Feishu ingress mode specifically requires callback verification or encrypted callback payloads.
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

---

## 中文

`connectting-dl` 是一个面向小团队部署的轻量级 Feishu 到 Codex CLI 桥接工具。

### 项目简介

当前 MVP 包含：

- 飞书事件回调服务
- 飞书长连接事件接收
- 多用户、多群组会话隔离
- 带显式跨会话访问控制的 owner 命令通道
- 基于 `codex exec` 的非交互式回复集成
- 基于本地 SQLite 的会话持久化
- 面向文件和图片的显式附件发送协议

### 功能 / MVP 范围

- 以文本消息为主的 Feishu 与 Codex CLI 桥接
- 针对私聊和群聊的按会话隔离 transcript
- 仅 owner 可用的运维命令，用于检查状态和发送媒体
- 通过显式附件指令支持文件和图片回复
- 可配置的 reaction 表情和机器人名前缀

### 安装

面向未来 npm 发布版本的安装命令：

```bash
npm install -g connectting-dl
```

### 如何对接 Codex CLI

`connectting-dl` 安装完成后，真正执行模型回复的是你本机上的 `codex` 可执行文件。

推荐接入流程：

1. 先安装并登录 Codex CLI。

```bash
codex --help
codex login
```

2. 先确认 shell 里能直接调用 `codex`。

```bash
which codex
codex exec "Reply with: ok"
```

3. 运行 `connectting-dl init`，填入飞书应用凭证。

```bash
connectting-dl init
```

4. 检查或编辑 `~/.connectting-dl/config.json`。

关键字段：

- `codex.command`：Codex CLI 可执行文件路径
- `codex.workDir`：传给 Codex 的默认项目目录
- `codex.extraArgs`：bridge 调用 `codex exec` 时附带的默认参数

示例：

```json
{
  "codex": {
    "command": "/usr/local/bin/codex",
    "workDir": "/Users/<you>/codex-cli/workspace",
    "extraArgs": [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write"
    ]
  }
}
```

5. 检查 bridge 配置。

```bash
connectting-dl doctor
```

6. 启动 bridge。

```bash
connectting-dl serve
```

或者安装成后台守护：

```bash
connectting-dl daemon install
```

7. 打开 bot 会话并发送第一条消息。

```bash
connectting-dl bind --open
```

这第一条真实飞书消息会同时完成：

- 验证 Feishu -> connectting-dl 的接入链路
- 触发 `codex exec`
- 如果 `owner.openIds` 为空，则自动把发送者绑定为 owner

说明：

- 如果你用守护方式运行，`codex.command` 最好写绝对路径，例如 `/usr/local/bin/codex`，比依赖 `PATH` 更稳。
- `connectting-dl` 本身并不内置 Codex，它只是包装你本机已有的 Codex CLI。

### 快速开始

1. 运行初始化安装。

```bash
connectting-dl init
```

会创建：

- `~/.connectting-dl/config.json`
- `~/.connectting-dl/data`
- `~/.connectting-dl/workspace`

执行 `init` 时，终端会提示输入：

- 飞书 `app_id`
- 飞书 `app_secret`

默认会自动绑定 owner。如果 `owner.openIds` 为空，系统会把第一条进入的飞书消息发送者持久化为 owner。

2. 检查本地配置。

```bash
connectting-dl doctor
```

3. 启动桥接服务。

```bash
connectting-dl serve
```

4. 飞书接入方式二选一：

- 长连接：在飞书后台保持“使用长连接接收事件”即可。
- HTTP 回调：将飞书事件订阅回调地址配置为：

```text
http(s)://<your-host>:8787/feishu/events
```

5. 打开 bot 会话并触发 owner 自动绑定：

```bash
connectting-dl bind --open
```

随后给 bot 发任意一条消息。如果 `owner.openIds` 为空，这个首条发送者就会被自动绑定为 owner。

### 默认目录结构

- `~/.connectting-dl/config.json`：主运行配置
- `~/.connectting-dl/data`：SQLite 数据库和本地状态
- `~/.connectting-dl/workspace`：默认 Codex CLI 工作目录

### owner 配置

默认初始化时可以不填写 `owner.openIds`。如果这里为空，系统会把第一条进入的飞书消息发送者自动绑定为 owner，并写回 `~/.connectting-dl/config.json`。

如果后续需要手动指定或切换 owner，可以直接编辑 `owner.openIds`。

除非显式启用 `owner.allowReadAllSessions`，否则 `/ctl show` 会被拒绝。

### 会话隔离

- 私聊：按 `chat_id + user_open_id` 隔离
- 群聊：按 `chat_id` 隔离
- 同一个用户在两个不同群里发言不会共享历史

### owner 命令

owner 可以使用以下聊天命令：

- `/ctl help`
- `/ctl sessions`
- `/ctl health`
- `/ctl ownerlog`
- `/ctl attachlog`
- `/ctl sendimage <path>`
- `/ctl sendfile <path>`
- `/ctl show <sessionId>`

### 附件协议

主回复流程支持在 assistant 输出末尾追加附件指令：

````text
Normal visible reply text

```connectting-dl
{
  "attachments": [
    { "path": "/absolute/path/report.pdf", "type": "file" },
    { "path": "./artifacts/chart.png", "type": "image" }
  ]
}
```
````

规则：

- 可见文本会先作为普通文本消息发送
- 每个附件都会在文本之后单独上传并回复
- 相对路径基于 `codex.workDir` 解析
- 如果省略 `type`，常见图片扩展名会按图片处理，其余文件按普通文件发送

### 本地命令

```bash
connectting-dl doctor
connectting-dl serve
connectting-dl init
connectting-dl bind --open
connectting-dl send --open-id ou_xxx --text "hello"
```

`connectting-dl bind` 会输出一个可直接打开 bot 会话的 AppLink：

```text
https://applink.feishu.cn/client/bot/open?appId=<your_app_id>
```

`connectting-dl send` 可以让 bot 主动发一条文本消息到：

- `--open-id <open_id>`
- `--chat-id <chat_id>`

也支持非交互式初始化：

```bash
connectting-dl init \
  --owner-open-id ou_xxx \
  --app-id cli_xxx \
  --app-secret xxx
```

### 守护 / 后台运行

`connectting-dl` 当前没有内建进程守护器。

如果你需要后台运行和异常退出自动拉起：

- `connectting-dl daemon install`：按当前系统自动安装用户级守护
- `connectting-dl daemon status`：输出更友好的运行摘要
- `connectting-dl daemon logs --lines 100`：查看最近守护日志
- `connectting-dl daemon uninstall`：卸载用户级守护

见：

- [docs/daemon.md](./docs/daemon.md)
- [docs/launchd.connectting-dl.plist](./docs/launchd.connectting-dl.plist)
- [docs/connectting-dl.service](./docs/connectting-dl.service)

CLI 会自动选择宿主系统的服务管理器：

- macOS：`launchd`
- Linux：`systemd --user`

### 飞书权限

飞书应用应至少具备以下能力：

- 接收消息事件
- 发送消息
- 访问租户 token 交换所需的应用凭证

具体权限会因你使用内部应用模式还是应用市场模式而不同。

### 注意事项

- 这个 MVP 当前优先处理文本消息。
- `verificationToken` 和 `encryptKey` 都是可选项。只有在你的飞书接入模式明确需要回调验签或加密回调体时才需要填写。
- `codex exec` 使用滚动 transcript 窗口，而不是原生恢复的 Codex 会话。
- 默认 runner 参数只会保留 CLI 实际支持的 `codex exec` 选项。
- 重复的飞书 `message_id` 事件在首次成功处理后会被忽略。
- 群消息在发送给 Codex 之前会去掉开头的 `@mention` 文本。
- 旧版 `sessions.json` 会在第一次启动 SQLite 时自动导入。
- owner 控制命令会单独存入 SQLite 的 `owner_actions`，与普通聊天 transcript 分离。
- 附件发送结果会存入 SQLite 的 `attachment_events`。
- 飞书客户端辅助逻辑已支持图片上传/回复和文件上传/回复，便于 shadow testing 和后续媒体工作流扩展。
- 常见办公文件格式如 `pdf`、`doc/docx`、`xls/xlsx`、`ppt/pptx`，以及 `txt`、`md` 等通用文件都支持；未知格式会回退到飞书 `stream` 上传。
- 收到的消息可以在处理前添加可配置的 reaction 表情，发出的文本回复可以添加可配置的机器人名前缀。
