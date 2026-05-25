# Shadow Run Guide

Use this workflow before any production callback cutover.

## Goal

Validate `connectting-dl` end to end without interrupting the active `cc-connect` path.

## Safe approach

1. Keep Feishu callback settings unchanged.
2. Start `connectting-dl` on a local-only port such as `127.0.0.1:8787`.
3. Replay synthetic or captured Feishu event payloads to `/feishu/events`.
4. Verify:
   - owner commands work
   - `codex exec` completes
   - session isolation and persistence look correct
   - SQLite state updates look correct
   - duplicate events are ignored

## Suggested checks

- P2P owner command:
  - `/ctl sessions`
  - `/ctl health`
- Normal P2P message:
  - ask for a short deterministic reply
- Group message shadow replay:
  - include a leading `@bot` mention in the text
  - confirm mention text is stripped before Codex receives it
- Duplicate replay:
  - send the same `message_id` twice
  - second response should be ignored

## Do not do during shadow mode

- do not replace the real Feishu callback URL
- do not stop `cc-connect`
- do not reuse the same port as another bridge
