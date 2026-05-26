# connectting-dl daemon deployment

`connectting-dl` does not currently include a built-in daemon supervisor or self-restart loop.
Run it under the native service manager for your OS if you want:

- auto-start on login or boot
- automatic restart after crashes
- background execution
- persistent logs

This project ships example templates for:

- macOS `launchd`
- Linux `systemd --user`

## Common assumptions

1. `connectting-dl` is already installed and callable from your shell.
2. You have already run:

```bash
connectting-dl init
```

3. Your config lives at:

```text
~/.connectting-dl/config.json
```

4. Your runtime logs directory is:

```bash
mkdir -p ~/.connectting-dl/logs
```

## macOS: launchd

Template:

- [launchd.connectting-dl.plist](./launchd.connectting-dl.plist)

Install it as a per-user LaunchAgent:

```bash
mkdir -p ~/Library/LaunchAgents
cp docs/launchd.connectting-dl.plist ~/Library/LaunchAgents/ai.connectting-dl.plist
```

Then edit the copied plist and replace these placeholders with absolute paths:

- `__CONNECTTING_DL_BIN__`
- `__CONFIG_PATH__`
- `__WORKDIR__`
- `__STDOUT_LOG__`
- `__STDERR_LOG__`

Typical values:

```text
__CONNECTTING_DL_BIN__ => /usr/local/bin/connectting-dl
__CONFIG_PATH__ => /Users/<you>/.connectting-dl/config.json
__WORKDIR__ => /Users/<you>/.connectting-dl/workspace
__STDOUT_LOG__ => /Users/<you>/.connectting-dl/logs/serve.stdout.log
__STDERR_LOG__ => /Users/<you>/.connectting-dl/logs/serve.stderr.log
```

Load and start:

```bash
launchctl unload ~/Library/LaunchAgents/ai.connectting-dl.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/ai.connectting-dl.plist
launchctl kickstart -k gui/$(id -u)/ai.connectting-dl
```

Check status:

```bash
launchctl print gui/$(id -u)/ai.connectting-dl
```

Stop:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.connectting-dl.plist
```

## Linux: systemd user service

Template:

- [connectting-dl.service](./connectting-dl.service)

Install it as a user service:

```bash
mkdir -p ~/.config/systemd/user
cp docs/connectting-dl.service ~/.config/systemd/user/connectting-dl.service
```

Then edit the copied unit and replace:

- `__CONNECTTING_DL_BIN__`
- `__CONFIG_PATH__`
- `__WORKDIR__`

Typical values:

```text
__CONNECTTING_DL_BIN__ => /usr/local/bin/connectting-dl
__CONFIG_PATH__ => /home/<you>/.connectting-dl/config.json
__WORKDIR__ => /home/<you>/.connectting-dl/workspace
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now connectting-dl.service
```

Check status:

```bash
systemctl --user status connectting-dl.service
```

View logs:

```bash
journalctl --user -u connectting-dl.service -f
```

Stop:

```bash
systemctl --user disable --now connectting-dl.service
```

If you need the service to keep running after logout:

```bash
loginctl enable-linger <your-user>
```

## Restart behavior

Both provided templates are configured to restart automatically after unexpected exits:

- macOS: `KeepAlive`
- Linux: `Restart=always`

Neither template restarts on clean manual shutdown loops unless the service manager is told to bring it back.

## Validation

After enabling the service, verify:

```bash
connectting-dl doctor
```

Then confirm the service manager shows the process as healthy and running.
