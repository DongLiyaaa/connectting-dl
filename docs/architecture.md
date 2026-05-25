# Lightweight Team Edition Architecture

## Positioning

This project is not a personal toy bridge and not a full enterprise platform.
It targets a middle ground:

- one operator-owned deployment
- multiple Feishu users
- multiple Feishu groups
- Codex CLI as the execution backend

## Core flow

```text
Feishu callback -> HTTP bridge -> session router -> Codex runner -> Feishu reply
```

## Session isolation rules

### P2P chats

- key format: `feishu:p2p:<chat_id>:<user_open_id>`
- a user's direct messages are isolated from group conversations

### Group chats

- key format: `feishu:group:<chat_id>`
- all members of the same group share that group's session
- the same user speaking in two different groups gets two different contexts

## Owner model

Owners are configured by Feishu `open_id`.

### Allowed by default

- list all session metadata
- inspect health and routing state
- use control commands from Feishu

### Denied by default

- read other sessions' message bodies
- silently take over another session

Cross-session transcript reading must be enabled explicitly through:

```json
{
  "owner": {
    "allowReadAllSessions": true
  }
}
```

## Group reply policy

Recommended MVP defaults:

- require `@bot` in groups
- keep P2P always available
- allow owner control commands even without mention

## Codex integration

MVP uses `codex exec` rather than native session resume.

Implications:

- transport is simpler
- deployment is easier
- rolling transcript context is controlled locally
- native Codex session continuity is not yet preserved

## Storage

Current storage is local SQLite:

- `connectting-dl.sqlite`

The deployment model is still single-node and lightweight.
SQLite is used only to make session history, de-duplication, and owner inspection more reliable.

Main persisted entities:

- `sessions`
- `messages`
- `processed_receipts`
- `owner_actions`
- `attachment_events`
