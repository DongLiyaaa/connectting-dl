import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { nowIso, shortText } from "./utils.js";
import { parseReplyPackage, validateReplyPackage } from "./reply-package.js";

function buildTranscript(messages) {
  return messages
    .map((item) => {
      const role = item.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${item.text}`;
    })
    .join("\n\n");
}

export class CodexRunner {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async run(session, userMessage) {
    const transcript = buildTranscript(session.messages.slice(-this.config.codex.historyWindow));
    const prompt = [
      this.config.codex.promptPreamble,
      `Session ID: ${session.sessionId}`,
      `Scope: ${session.scope}`,
      `Chat Type: ${session.chatType}`,
      session.chatName ? `Chat Name: ${session.chatName}` : "",
      session.userName ? `User Name: ${session.userName}` : "",
      transcript ? `Recent Transcript:\n${transcript}` : "Recent Transcript: <empty>",
      `Latest User Message:\n${userMessage}`,
      "Reply to the latest user message only. Keep references to internal tooling minimal.",
      "If you need to send attachments, append one fenced block exactly like ```connectting-dl {\"attachments\":[{\"path\":\"/absolute/or/relative/path.ext\",\"type\":\"file|image\"}]} ```.",
      "Do not mention the directive in visible prose. Relative paths are resolved from the Codex work directory."
    ]
      .filter(Boolean)
      .join("\n\n");

    const tmpFile = path.join(this.config.storage.dataDir, "tmp", `codex-${Date.now()}.txt`);
    const args = [...this.config.codex.extraArgs, "-C", this.config.codex.workDir, "-o", tmpFile, prompt];
    const startedAt = Date.now();

    this.logger.info("starting codex exec", {
      sessionId: session.sessionId,
      command: this.config.codex.command,
      args: args.map((item) => shortText(item, 80))
    });

    const child = spawn(this.config.codex.command, args, {
      cwd: this.config.codex.workDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, this.config.codex.timeoutMs);

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    clearTimeout(timeout);

    let reply = "";
    try {
      reply = (await fs.readFile(tmpFile, "utf8")).trim();
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
    }

    if (exitCode !== 0) {
      throw new Error(
        [
          `codex exec failed with exit code ${exitCode}`,
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : ""
        ]
          .filter(Boolean)
          .join("\n\n")
      );
    }

    if (!reply) {
      reply = stdout.trim();
    }

    this.logger.info("codex exec finished", {
      sessionId: session.sessionId,
      elapsedMs: Date.now() - startedAt,
      replyPreview: shortText(reply, 120),
      completedAt: nowIso()
    });

    const normalizedReply = reply || "收到消息了，但这次没有生成可见回复。";
    const replyPackage = parseReplyPackage(normalizedReply, this.config.codex.workDir);
    await validateReplyPackage(replyPackage);
    return replyPackage;
  }
}
