import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { ensureDir, expandHome } from "./utils.js";

const execFileAsync = promisify(execFile);
const LAUNCHD_LABEL = "ai.connectting-dl";
const SYSTEMD_UNIT = "connectting-dl.service";

function daemonHelp() {
  return [
    "Daemon commands:",
    "  connectting-dl daemon install [--config <path>]",
    "  connectting-dl daemon uninstall [--config <path>]",
    "  connectting-dl daemon status",
    "",
    "Behavior:",
    "  macOS -> launchd LaunchAgent",
    "  Linux -> systemd --user service"
  ].join("\n");
}

function getPlatformKind() {
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  throw new Error(`Unsupported platform for daemon install: ${process.platform}`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function quoteXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildLaunchdPlist({ nodePath, scriptPath, configPath, workDir, stdoutLogPath, stderrLogPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${quoteXml(LAUNCHD_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${quoteXml(nodePath)}</string>
      <string>${quoteXml(scriptPath)}</string>
      <string>serve</string>
      <string>--config</string>
      <string>${quoteXml(configPath)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${quoteXml(workDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${quoteXml(stdoutLogPath)}</string>
    <key>StandardErrorPath</key>
    <string>${quoteXml(stderrLogPath)}</string>
  </dict>
</plist>
`;
}

function buildSystemdUnit({ nodePath, scriptPath, configPath, workDir }) {
  return `[Unit]
Description=connectting-dl bridge service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} serve --config ${configPath}
WorkingDirectory=${workDir}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

async function runCommand(command, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      env: process.env,
      maxBuffer: 1024 * 1024
    });
    return {
      ok: true,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: 0
    };
  } catch (error) {
    if (!allowFailure) {
      throw new Error(
        `${command} ${args.join(" ")} failed: ${error.stderr || error.stdout || error.message || String(error)}`
      );
    }
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: Number(error.code ?? 1)
    };
  }
}

async function resolveScriptPath(currentArgv1) {
  const currentPath = currentArgv1 ? path.resolve(currentArgv1) : "";
  const repoBinPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/connectting-dl.js");

  if (currentPath && (await pathExists(currentPath))) {
    const basename = path.basename(currentPath);
    if (basename === "connectting-dl" || basename === "connectting-dl.js") {
      return currentPath;
    }
    if (basename === "cli.js" && (await pathExists(repoBinPath))) {
      return repoBinPath;
    }
  }

  const whichResult = await runCommand("which", ["connectting-dl"], { allowFailure: true });
  const resolved = whichResult.stdout.trim();
  if (resolved) {
    return resolved;
  }

  if (await pathExists(repoBinPath)) {
    return repoBinPath;
  }

  throw new Error("Unable to resolve connectting-dl executable path for daemon install.");
}

function getCommonPaths(configPath) {
  const resolvedConfigPath = path.resolve(expandHome(configPath));
  const appHome = path.dirname(resolvedConfigPath);
  return {
    resolvedConfigPath,
    appHome,
    logsDir: path.join(appHome, "logs"),
    stdoutLogPath: path.join(appHome, "logs", "serve.stdout.log"),
    stderrLogPath: path.join(appHome, "logs", "serve.stderr.log"),
    workDir: path.join(appHome, "workspace")
  };
}

async function installMacosDaemon({ nodePath, scriptPath, configPath, workDir, stdoutLogPath, stderrLogPath }) {
  const plistDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(plistDir, `${LAUNCHD_LABEL}.plist`);
  await ensureDir(plistDir);
  await ensureDir(path.dirname(stdoutLogPath));
  await fs.writeFile(
    plistPath,
    buildLaunchdPlist({ nodePath, scriptPath, configPath, workDir, stdoutLogPath, stderrLogPath }),
    "utf8"
  );

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!uid) {
    throw new Error("Unable to determine current user id for launchd install.");
  }
  const domain = `gui/${uid}`;

  await runCommand("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  await runCommand("launchctl", ["bootstrap", domain, plistPath]);
  await runCommand("launchctl", ["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);

  return [
    "Daemon installed with launchd.",
    `plist: ${plistPath}`,
    `stdout: ${stdoutLogPath}`,
    `stderr: ${stderrLogPath}`
  ].join("\n");
}

async function uninstallMacosDaemon() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!uid) {
    throw new Error("Unable to determine current user id for launchd uninstall.");
  }
  const domain = `gui/${uid}`;

  await runCommand("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  if (await pathExists(plistPath)) {
    await fs.rm(plistPath, { force: true });
  }

  return `Daemon uninstalled from launchd.\nplist: ${plistPath}`;
}

async function statusMacosDaemon() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!uid) {
    throw new Error("Unable to determine current user id for launchd status.");
  }
  const result = await runCommand("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], { allowFailure: true });
  if (!result.ok) {
    return `launchd status: not loaded\n${result.stderr || result.stdout}`.trim();
  }
  return result.stdout.trim() || `launchd status: loaded (${LAUNCHD_LABEL})`;
}

async function installLinuxDaemon({ nodePath, scriptPath, configPath, workDir }) {
  const systemdDir = path.join(os.homedir(), ".config", "systemd", "user");
  const unitPath = path.join(systemdDir, SYSTEMD_UNIT);
  await ensureDir(systemdDir);
  await fs.writeFile(unitPath, buildSystemdUnit({ nodePath, scriptPath, configPath, workDir }), "utf8");

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);

  return [
    "Daemon installed with systemd --user.",
    `unit: ${unitPath}`,
    "Hint: run `loginctl enable-linger <user>` if you need it to survive logout."
  ].join("\n");
}

async function uninstallLinuxDaemon() {
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
  await runCommand("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { allowFailure: true });
  if (await pathExists(unitPath)) {
    await fs.rm(unitPath, { force: true });
  }
  await runCommand("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  return `Daemon uninstalled from systemd --user.\nunit: ${unitPath}`;
}

async function statusLinuxDaemon() {
  const result = await runCommand("systemctl", ["--user", "status", SYSTEMD_UNIT, "--no-pager"], { allowFailure: true });
  if (!result.ok) {
    return `systemd status: not active\n${result.stderr || result.stdout}`.trim();
  }
  return result.stdout.trim();
}

export async function handleDaemon(args, configPath, currentArgv1) {
  const [action = "help"] = args;
  if (action === "help" || action === "--help" || action === "-h") {
    process.stdout.write(`${daemonHelp()}\n`);
    return;
  }

  const platformKind = getPlatformKind();
  const commonPaths = getCommonPaths(configPath);

  if (action === "install") {
    const scriptPath = await resolveScriptPath(currentArgv1);
    const nodePath = process.execPath;
    const config = await loadConfig(commonPaths.resolvedConfigPath);
    await ensureDir(commonPaths.logsDir);
    const message =
      platformKind === "macos"
        ? await installMacosDaemon({
            nodePath,
            scriptPath,
            configPath: commonPaths.resolvedConfigPath,
            workDir: config.codex.workDir,
            stdoutLogPath: commonPaths.stdoutLogPath,
            stderrLogPath: commonPaths.stderrLogPath
          })
        : await installLinuxDaemon({
            nodePath,
            scriptPath,
            configPath: commonPaths.resolvedConfigPath,
            workDir: config.codex.workDir
          });
    process.stdout.write(`${message}\n`);
    return;
  }

  if (action === "uninstall") {
    const message = platformKind === "macos" ? await uninstallMacosDaemon() : await uninstallLinuxDaemon();
    process.stdout.write(`${message}\n`);
    return;
  }

  if (action === "status") {
    const message = platformKind === "macos" ? await statusMacosDaemon() : await statusLinuxDaemon();
    process.stdout.write(`${message}\n`);
    return;
  }

  throw new Error(`Unknown daemon action: ${action}`);
}
