import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_PATH, ensureStorageLayout, loadConfig } from "./config.js";
import { BridgeServer } from "./server.js";
import { expandHome, writeJson } from "./utils.js";

function printHelp() {
  process.stdout.write(
    [
      "connectting-dl",
      "",
      "Usage:",
      "  connectting-dl init [--config <path>] [--owner-open-id <open_id>] [--app-id <id>] [--app-secret <secret>] [--workspace <path>] [--force]",
      "  connectting-dl doctor [--config <path>]",
      "  connectting-dl serve [--config <path>]",
      ""
    ].join("\n")
  );
}

function getOptionValue(args, flag, fallbackValue = undefined) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallbackValue;
  }
  return args[index + 1] ?? fallbackValue;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function promptConfirm(rl, label, defaultValue = false) {
  while (true) {
    const suffix = defaultValue ? " [Y/n]" : " [y/N]";
    const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (["y", "yes"].includes(answer)) {
      return true;
    }
    if (["n", "no"].includes(answer)) {
      return false;
    }
  }
}

function getDefaultPaths(configPath) {
  const resolvedConfigPath = path.resolve(expandHome(configPath));
  const appHome = path.dirname(resolvedConfigPath);
  return {
    resolvedConfigPath,
    appHome,
    dataDir: path.join(appHome, "data"),
    dbPath: path.join(appHome, "data", "connectting-dl.sqlite"),
    workspaceDir: path.join(appHome, "workspace")
  };
}

function buildInitConfig(options) {
  return {
    server: {
      host: "0.0.0.0",
      port: 8787
    },
    storage: {
      dataDir: options.dataDir,
      dbPath: options.dbPath
    },
    feishu: {
      appId: options.appId,
      appSecret: options.appSecret,
      verificationToken: options.verificationToken,
      encryptKey: options.encryptKey,
      botName: "connectting-dl",
      processingReactionEmoji: "WINK",
      groupRequireMention: true,
      allowedChatIds: [],
      blockedChatIds: [],
      replyPrefix: ""
    },
    owner: {
      openIds: [options.ownerOpenId],
      commandPrefix: "/ctl",
      allowReadAllSessions: false,
      allowTakeover: true
    },
    codex: {
      command: "codex",
      workDir: options.workspaceDir,
      timeoutMs: 900000,
      historyWindow: 12,
      extraArgs: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      promptPreamble:
        "You are responding through a Feishu bridge for a lightweight team deployment. Keep answers concise and action-oriented."
    },
    sessionPolicy: {
      maxMessages: 50
    }
  };
}

async function promptValue(rl, label, fallbackValue, { secret = false, required = false } = {}) {
  while (true) {
    const answer = await rl.question(`${label}${fallbackValue ? ` [${fallbackValue}]` : ""}: `, {
      hideEchoBack: secret
    });
    const value = answer.trim() || fallbackValue || "";
    if (!required || value) {
      return value;
    }
  }
}

async function ensureWorkspaceScaffold(workspaceDir) {
  await fs.mkdir(workspaceDir, { recursive: true });
  const readmePath = path.join(workspaceDir, "README.md");
  const gitignorePath = path.join(workspaceDir, ".gitignore");

  try {
    await fs.access(readmePath);
  } catch {
    await fs.writeFile(
      readmePath,
      [
        "# connectting-dl workspace",
        "",
        "This directory is the default Codex CLI working directory used by connectting-dl.",
        "Put project files here or switch `codex.workDir` in `~/.connectting-dl/config.json`."
      ].join("\n") + "\n",
      "utf8"
    );
  }

  try {
    await fs.access(gitignorePath);
  } catch {
    await fs.writeFile(gitignorePath, ".DS_Store\n", "utf8");
  }
}

async function handleInit(configPath) {
  const args = process.argv.slice(2);
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
  const force = hasFlag(args, "--force");
  let existingConfig = null;
  const paths = getDefaultPaths(configPath);
  let configExists = false;
  try {
    await fs.access(paths.resolvedConfigPath);
    configExists = true;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  if (configExists) {
    existingConfig = await loadConfig(paths.resolvedConfigPath);
    if (!force && !isInteractive) {
      throw new Error(
        `Config already exists: ${paths.resolvedConfigPath}\nRe-run with --force to overwrite, or run interactively to update existing values.`
      );
    }
  }

  const ownerOpenIdArg = getOptionValue(args, "--owner-open-id", "").trim();
  const appIdArg = getOptionValue(args, "--app-id", "").trim();
  const appSecretArg = getOptionValue(args, "--app-secret", "").trim();
  const verificationTokenArg = getOptionValue(args, "--verification-token", "").trim();
  const encryptKeyArg = getOptionValue(args, "--encrypt-key", "").trim();
  const workspaceFallback = existingConfig?.codex?.workDir || paths.workspaceDir;
  const workspaceArg = getOptionValue(args, "--workspace", workspaceFallback);
  const workspaceDir = path.resolve(expandHome(workspaceArg));

  let ownerOpenId = ownerOpenIdArg || existingConfig?.owner?.openIds?.[0] || "";
  let appId = appIdArg || existingConfig?.feishu?.appId || "";
  let appSecret = appSecretArg || existingConfig?.feishu?.appSecret || "";
  let verificationToken = verificationTokenArg || existingConfig?.feishu?.verificationToken || "";
  let encryptKey = encryptKeyArg || existingConfig?.feishu?.encryptKey || "";

  if (isInteractive) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    try {
      process.stdout.write("connectting-dl init\n");
      process.stdout.write(`Config home: ${paths.appHome}\n`);
      process.stdout.write(`Default workspace: ${workspaceDir}\n\n`);
      if (configExists && !force) {
        const shouldOverwrite = await promptConfirm(
          rl,
          `Config already exists at ${paths.resolvedConfigPath}. Update it using current values as defaults?`
        );
        if (!shouldOverwrite) {
          process.stdout.write("Init cancelled.\n");
          return;
        }
        process.stdout.write("\n");
      }
      ownerOpenId = await promptValue(rl, "Owner Feishu open_id", ownerOpenId, { required: true });
      appId = await promptValue(rl, "Feishu app_id", appId, { required: true });
      appSecret = await promptValue(rl, "Feishu app_secret", appSecret, { required: true, secret: true });
      verificationToken = await promptValue(rl, "Feishu verification token", verificationToken);
      encryptKey = await promptValue(rl, "Feishu encrypt key", encryptKey);
    } finally {
      rl.close();
    }
  }

  if (!ownerOpenId) {
    throw new Error("Owner Feishu open_id is required. Pass --owner-open-id or run init in a TTY.");
  }
  if (!appId) {
    throw new Error("Feishu app_id is required. Pass --app-id or run init in a TTY.");
  }
  if (!appSecret) {
    throw new Error("Feishu app_secret is required. Pass --app-secret or run init in a TTY.");
  }

  const config = buildInitConfig({
    dataDir: paths.dataDir,
    dbPath: paths.dbPath,
    workspaceDir,
    ownerOpenId,
    appId,
    appSecret,
    verificationToken,
    encryptKey
  });

  await fs.mkdir(paths.appHome, { recursive: true });
  await ensureWorkspaceScaffold(workspaceDir);
  await writeJson(paths.resolvedConfigPath, config);
  process.stdout.write(
    [
      `Created config: ${paths.resolvedConfigPath}`,
      `App home: ${paths.appHome}`,
      `Workspace: ${workspaceDir}`,
      `Owner open_id: ${ownerOpenId}`,
      "",
      "Next steps:",
      "  1. connectting-dl doctor",
      "  2. connectting-dl serve",
      "  3. Point Feishu event callback to /feishu/events"
    ].join("\n") + "\n"
  );
}

async function handleDoctor(configPath) {
  const config = await loadConfig(configPath);
  await ensureStorageLayout(config);
  process.stdout.write(
    [
      "connectting-dl doctor: ok",
      `config: ${config.configPath}`,
      `listen: ${config.server.host}:${config.server.port}`,
      `storage: ${config.storage.dataDir}`,
      `sqlite: ${config.storage.dbPath}`,
      `codex command: ${config.codex.command}`,
      `codex workdir: ${config.codex.workDir}`,
      `owner count: ${config.owner.openIds.length}`
    ].join("\n") + "\n"
  );
}

async function handleServe(configPath) {
  const config = await loadConfig(configPath);
  await ensureStorageLayout(config);
  const server = new BridgeServer(config);
  const shutdown = async () => {
    await server.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.start();
}

export async function main(argv) {
  const [command = "help"] = argv;
  const configPath = getOptionValue(argv, "--config", DEFAULT_CONFIG_PATH);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "init") {
    await handleInit(configPath);
    return;
  }
  if (command === "doctor") {
    await handleDoctor(configPath);
    return;
  }
  if (command === "serve") {
    await handleServe(configPath);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFile = fileURLToPath(import.meta.url);

if (executedFile === currentFile) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
