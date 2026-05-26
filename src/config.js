import fs from "node:fs/promises";
import path from "node:path";
import { expandHome, ensureDir } from "./utils.js";

export const DEFAULT_CONFIG_PATH = expandHome("~/.connectting-dl/config.json");

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolvedConfigPath = path.resolve(expandHome(configPath));
  const raw = await fs.readFile(resolvedConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const config = normalizeConfig(parsed, resolvedConfigPath);
  validateConfig(config);
  return config;
}

export function normalizeConfig(input, configPath) {
  const storageDir = expandHome(input?.storage?.dataDir ?? "~/.connectting-dl/data");
  const workDir = expandHome(input?.codex?.workDir ?? process.cwd());
  return {
    configPath,
    server: {
      host: input?.server?.host ?? "0.0.0.0",
      port: Number(input?.server?.port ?? 8787)
    },
    storage: {
      dataDir: path.resolve(storageDir),
      dbPath: path.resolve(expandHome(input?.storage?.dbPath ?? path.join(storageDir, "connectting-dl.sqlite")))
    },
    feishu: {
      appId: String(input?.feishu?.appId ?? ""),
      appSecret: String(input?.feishu?.appSecret ?? ""),
      verificationToken: String(input?.feishu?.verificationToken ?? ""),
      encryptKey: String(input?.feishu?.encryptKey ?? ""),
      botName: String(input?.feishu?.botName ?? ""),
      processingReactionEmoji: String(input?.feishu?.processingReactionEmoji ?? "DONE"),
      groupRequireMention: Boolean(input?.feishu?.groupRequireMention ?? true),
      allowedChatIds: Array.isArray(input?.feishu?.allowedChatIds) ? input.feishu.allowedChatIds.map(String) : [],
      blockedChatIds: Array.isArray(input?.feishu?.blockedChatIds) ? input.feishu.blockedChatIds.map(String) : [],
      replyPrefix: String(input?.feishu?.replyPrefix ?? "")
    },
    owner: {
      openIds: Array.isArray(input?.owner?.openIds) ? input.owner.openIds.map(String) : [],
      commandPrefix: String(input?.owner?.commandPrefix ?? "/ctl"),
      allowReadAllSessions: Boolean(input?.owner?.allowReadAllSessions ?? false),
      allowTakeover: Boolean(input?.owner?.allowTakeover ?? true)
    },
    codex: {
      command: String(input?.codex?.command ?? "codex"),
      workDir: path.resolve(workDir),
      timeoutMs: Number(input?.codex?.timeoutMs ?? 900000),
      historyWindow: Number(input?.codex?.historyWindow ?? 12),
      extraArgs: Array.isArray(input?.codex?.extraArgs)
        ? input.codex.extraArgs.map(String)
        : ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"],
      promptPreamble: String(
        input?.codex?.promptPreamble ??
          "You are responding through a Feishu bridge for a lightweight team deployment. Keep answers concise and action-oriented."
      )
    },
    sessionPolicy: {
      maxMessages: Number(input?.sessionPolicy?.maxMessages ?? 50)
    }
  };
}

export function toConfigFile(config) {
  return {
    server: {
      host: config.server.host,
      port: config.server.port
    },
    storage: {
      dataDir: config.storage.dataDir,
      dbPath: config.storage.dbPath
    },
    feishu: {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      verificationToken: config.feishu.verificationToken,
      encryptKey: config.feishu.encryptKey,
      botName: config.feishu.botName,
      processingReactionEmoji: config.feishu.processingReactionEmoji,
      groupRequireMention: config.feishu.groupRequireMention,
      allowedChatIds: [...config.feishu.allowedChatIds],
      blockedChatIds: [...config.feishu.blockedChatIds],
      replyPrefix: config.feishu.replyPrefix
    },
    owner: {
      openIds: [...config.owner.openIds],
      commandPrefix: config.owner.commandPrefix,
      allowReadAllSessions: config.owner.allowReadAllSessions,
      allowTakeover: config.owner.allowTakeover
    },
    codex: {
      command: config.codex.command,
      workDir: config.codex.workDir,
      timeoutMs: config.codex.timeoutMs,
      historyWindow: config.codex.historyWindow,
      extraArgs: [...config.codex.extraArgs],
      promptPreamble: config.codex.promptPreamble
    },
    sessionPolicy: {
      maxMessages: config.sessionPolicy.maxMessages
    }
  };
}

export function validateConfig(config) {
  const failures = [];
  if (!config.feishu.appId) {
    failures.push("feishu.appId is required");
  }
  if (!config.feishu.appSecret) {
    failures.push("feishu.appSecret is required");
  }
  if (!Number.isInteger(config.server.port) || config.server.port <= 0) {
    failures.push("server.port must be a positive integer");
  }
  if (!config.codex.extraArgs.length || config.codex.extraArgs[0] !== "exec") {
    failures.push("codex.extraArgs must start with \"exec\"");
  }
  if (!Number.isFinite(config.codex.timeoutMs) || config.codex.timeoutMs <= 0) {
    failures.push("codex.timeoutMs must be greater than 0");
  }
  if (!Number.isFinite(config.codex.historyWindow) || config.codex.historyWindow <= 0) {
    failures.push("codex.historyWindow must be greater than 0");
  }
  if (!Number.isFinite(config.sessionPolicy.maxMessages) || config.sessionPolicy.maxMessages < 10) {
    failures.push("sessionPolicy.maxMessages must be at least 10");
  }
  if (failures.length) {
    throw new Error(`Invalid config:\n- ${failures.join("\n- ")}`);
  }
}

export async function ensureStorageLayout(config) {
  await ensureDir(config.storage.dataDir);
  await ensureDir(path.join(config.storage.dataDir, "tmp"));
  await ensureDir(config.codex.workDir);
}
