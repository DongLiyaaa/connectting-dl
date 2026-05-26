import http from "node:http";
import { toConfigFile } from "./config.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { FeishuClient } from "./feishu-client.js";
import { CodexRunner } from "./codex-runner.js";
import { shortText, writeJson } from "./utils.js";

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: `${JSON.stringify(payload)}\n`
  };
}

function textResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    },
    body
  };
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function normalizeTextMessage(content) {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    const parsed = tryParseJson(content);
    if (parsed && typeof parsed.text === "string") {
      return parsed.text;
    }
    return content;
  }
  if (typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function stripLeadingMentions(text) {
  return String(text ?? "")
    .replace(/^(\s*@\S+\s*)+/, "")
    .trim();
}

function tryParseJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function buildSessionMeta(event) {
  const senderOpenId = event.sender?.sender_id?.open_id ?? "unknown";
  const senderName = event.sender?.sender_id?.user_id ?? event.sender?.sender_id?.open_id ?? "";
  const chatId = event.message?.chat_id ?? "unknown-chat";
  const chatType = event.message?.chat_type ?? "unknown";
  const chatName = event.chat?.name ?? event.message?.chat_id ?? "";
  if (chatType === "p2p") {
    return {
      sessionId: `feishu:p2p:${chatId}:${senderOpenId}`,
      scope: "p2p",
      chatId,
      chatName,
      chatType,
      userOpenId: senderOpenId,
      userName: senderName
    };
  }
  return {
    sessionId: `feishu:group:${chatId}`,
    scope: "group",
    chatId,
    chatName,
    chatType,
    userOpenId: senderOpenId,
    userName: senderName
  };
}

function isOwner(config, openId) {
  return config.owner.openIds.includes(openId);
}

function shouldProcessGroup(config, payload, allowOwnerBypass = false) {
  const event = payload.event;
  const chatType = event?.message?.chat_type;
  if (chatType !== "group") {
    return true;
  }
  if (allowOwnerBypass) {
    return true;
  }
  if (!config.feishu.groupRequireMention) {
    return true;
  }
  const mentions = event?.message?.mentions ?? event?.mentions ?? [];
  return Array.isArray(mentions) && mentions.length > 0;
}

function isChatAllowed(config, chatId) {
  if (config.feishu.blockedChatIds.includes(chatId)) {
    return false;
  }
  if (!config.feishu.allowedChatIds.length) {
    return true;
  }
  return config.feishu.allowedChatIds.includes(chatId);
}

function formatSessionList(items) {
  if (!items.length) {
    return "暂无会话。";
  }
  return items
    .slice(0, 20)
    .map(
      (item, index) =>
        `${index + 1}. ${item.sessionId}\n` +
        `   类型: ${item.scope}/${item.chatType}\n` +
        `   群聊: ${item.chatName || "-"}\n` +
        `   用户: ${item.userName || "-"}\n` +
        `   消息数: ${item.messageCount}\n` +
        `   最近: ${item.updatedAt}\n` +
        `   摘要: ${item.lastPreview || "-"}`
    )
    .join("\n\n");
}

function formatSessionDetail(session) {
  const lines = [
    `Session: ${session.sessionId}`,
    `Scope: ${session.scope}/${session.chatType}`,
    `Chat: ${session.chatName || session.chatId}`,
    `User: ${session.userName || session.userOpenId}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
    "",
    "Messages:"
  ];
  for (const item of session.messages.slice(-20)) {
    lines.push(`[${item.timestamp}] ${item.role}: ${item.text}`);
  }
  return lines.join("\n");
}

function formatHealthSummary(config, sessionStore) {
  const sessions = sessionStore.listSessions();
  return [
    "connectting-dl health",
    `listen: ${config.server.host}:${config.server.port}`,
    `storage: ${config.storage.dataDir}`,
    `sessions: ${sessions.length}`,
    `owner-actions: ${sessionStore.countOwnerActions()}`,
    `attachment-events: ${sessionStore.countAttachmentEvents()}`,
    `owners: ${config.owner.openIds.length}`,
    `cross-session-read: ${config.owner.allowReadAllSessions ? "on" : "off"}`,
    `group-require-mention: ${config.feishu.groupRequireMention ? "on" : "off"}`
  ].join("\n");
}

function formatOwnerActions(items) {
  if (!items.length) {
    return "暂无 owner 操作记录。";
  }
  return items
    .map(
      (item, index) =>
        `${index + 1}. ${item.timestamp}\n` +
        `   命令: ${item.commandText}\n` +
        `   会话: ${item.chatType}/${item.chatId}\n` +
        `   结果: ${shortText(item.responseText, 90)}`
    )
    .join("\n\n");
}

function formatAttachmentEvents(items) {
  if (!items.length) {
    return "暂无附件发送记录。";
  }
  return items
    .map(
      (item, index) =>
        `${index + 1}. ${item.timestamp}\n` +
        `   文件: ${item.fileName} (${item.attachmentType})\n` +
        `   状态: ${item.status}\n` +
        `   方向: ${item.direction}\n` +
        `   源消息: ${item.sourceMessageId}\n` +
        `   远端Key: ${item.remoteKey || "-"}`
    )
    .join("\n\n");
}

function formatAttachmentSummary(attachments) {
  if (!attachments.length) {
    return "";
  }
  return attachments.map((item) => `${item.type}:${item.name}`).join(", ");
}

function parseOwnerCommand(config, text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith(config.owner.commandPrefix)) {
    return null;
  }
  const body = trimmed.slice(config.owner.commandPrefix.length).trim();
  if (!body) {
    return { action: "help" };
  }
  const [action, ...rest] = body.split(/\s+/);
  return {
    action: action.toLowerCase(),
    args: rest
  };
}

export class BridgeServer {
  constructor(config) {
    this.config = config;
    this.logger = new Logger();
    this.sessionStore = new SessionStore(config.storage);
    this.feishuClient = new FeishuClient(config, this.logger);
    this.codexRunner = new CodexRunner(config, this.logger);
    this.sessionLocks = new Map();
    this.inflightMessageIds = new Set();
  }

  async start() {
    await this.sessionStore.load();
    this.server = http.createServer(this.handleRequest.bind(this));
    await new Promise((resolve) => {
      this.server.listen(this.config.server.port, this.config.server.host, resolve);
    });
    this.logger.info("bridge server started", {
      host: this.config.server.host,
      port: this.config.server.port
    });
  }

  async stop() {
    if (!this.server) {
      await this.sessionStore.close();
      return;
    }
    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await this.sessionStore.close();
  }

  async handleRequest(request, response) {
    try {
      const result = await this.routeRequest(request);
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
    } catch (error) {
      this.logger.error("request failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify({ error: "internal_error" })}\n`);
    }
  }

  async routeRequest(request) {
    if (request.method === "GET" && request.url === "/healthz") {
      return jsonResponse(200, { ok: true });
    }
    if (request.method === "POST" && request.url === "/feishu/events") {
      const rawBody = await collectRequestBody(request);
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
      this.feishuClient.verifySignature(rawBody, headers);
      const payload = this.feishuClient.decodePayload(rawBody);
      this.feishuClient.verifyToken(payload);
      return await this.handleFeishuPayload(payload);
    }
    return textResponse(404, "Not Found\n");
  }

  async handleFeishuPayload(payload) {
    if (payload.challenge) {
      return jsonResponse(200, { challenge: payload.challenge });
    }

    const eventType = payload.header?.event_type ?? payload.type ?? "";
    if (eventType !== "im.message.receive_v1") {
      return jsonResponse(200, { ok: true, ignored: eventType || "unknown" });
    }

    const event = payload.event;
    const messageId = event?.message?.message_id;
    const chatId = event?.message?.chat_id;
    const senderOpenId = event?.sender?.sender_id?.open_id ?? "";
    const rawText = normalizeTextMessage(event?.message?.content);
    const text = event?.message?.chat_type === "group" ? stripLeadingMentions(rawText) : rawText;

    if (!messageId || !chatId || !text) {
      return jsonResponse(200, { ok: true, ignored: "empty_message" });
    }
    if (this.sessionStore.hasProcessedMessage(messageId) || this.inflightMessageIds.has(messageId)) {
      return jsonResponse(200, { ok: true, ignored: "duplicate_message" });
    }
    if (!isChatAllowed(this.config, chatId)) {
      return jsonResponse(200, { ok: true, ignored: "chat_policy" });
    }
    this.inflightMessageIds.add(messageId);
    try {
      await this.ensureOwnerBinding(senderOpenId);
      const ownerCommand = isOwner(this.config, senderOpenId) ? parseOwnerCommand(this.config, text) : null;

      if (!shouldProcessGroup(this.config, payload, Boolean(ownerCommand))) {
        return jsonResponse(200, { ok: true, ignored: "mention_required" });
      }

      if (ownerCommand) {
        await this.tryAddProcessingReaction(messageId);
        const ownerReply = await this.handleOwnerCommand(ownerCommand, {
          messageId,
          senderOpenId,
          chatId,
          chatType: event?.message?.chat_type ?? "unknown"
        });
        await this.feishuClient.replyToMessage(messageId, ownerReply);
        await this.sessionStore.appendOwnerAction({
          messageId,
          ownerOpenId: senderOpenId,
          chatId,
          chatType: event?.message?.chat_type ?? "unknown",
          commandText: text,
          responseText: ownerReply
        });
        await this.sessionStore.markProcessedMessage(messageId);
        return jsonResponse(200, { ok: true, mode: "owner_command" });
      }

      const sessionMeta = buildSessionMeta(event);
      await this.tryAddProcessingReaction(messageId);
      const reply = await this.runSessionTurn(sessionMeta, text);
      await this.sendReplyPackage(messageId, reply, {
        sourceMessageId: messageId,
        sessionId: sessionMeta.sessionId,
        ownerOpenId: null
      });
      await this.sessionStore.markProcessedMessage(messageId);
      return jsonResponse(200, { ok: true, sessionId: sessionMeta.sessionId });
    } finally {
      this.inflightMessageIds.delete(messageId);
    }
  }

  async ensureOwnerBinding(senderOpenId) {
    if (!senderOpenId || this.config.owner.openIds.length) {
      return;
    }
    this.config.owner.openIds = [senderOpenId];
    await writeJson(this.config.configPath, toConfigFile(this.config));
    this.logger.info("owner auto-bound from first incoming message", {
      ownerOpenId: senderOpenId
    });
  }

  async handleOwnerCommand(command, context) {
    if (command.action === "help") {
      return [
        "Owner commands:",
        `${this.config.owner.commandPrefix} sessions`,
        `${this.config.owner.commandPrefix} health`,
        `${this.config.owner.commandPrefix} ownerlog`,
        `${this.config.owner.commandPrefix} attachlog`,
        `${this.config.owner.commandPrefix} sendimage <path>`,
        `${this.config.owner.commandPrefix} sendfile <path>`,
        `${this.config.owner.commandPrefix} show <sessionId>`
      ].join("\n");
    }
    if (command.action === "sessions") {
      return formatSessionList(this.sessionStore.listSessions());
    }
    if (command.action === "health") {
      return formatHealthSummary(this.config, this.sessionStore);
    }
    if (command.action === "ownerlog") {
      return formatOwnerActions(this.sessionStore.listOwnerActions(10));
    }
    if (command.action === "attachlog") {
      return formatAttachmentEvents(this.sessionStore.listAttachmentEvents(10));
    }
    if (command.action === "sendimage") {
      const filePath = command.args?.join(" ").trim();
      if (!filePath) {
        return "请提供图片路径。";
      }
      await this.sendReplyPackage(
        context.messageId,
        {
          visibleText: "",
          attachments: [
            {
              type: "image",
              path: filePath,
              resolvedPath: filePath,
              name: filePath.split("/").pop() || "image"
            }
          ],
          rawText: ""
        },
        {
          sourceMessageId: context.messageId,
          sessionId: null,
          ownerOpenId: context.senderOpenId
        }
      );
      return `图片已尝试发送：${filePath}`;
    }
    if (command.action === "sendfile") {
      const filePath = command.args?.join(" ").trim();
      if (!filePath) {
        return "请提供文件路径。";
      }
      await this.sendReplyPackage(
        context.messageId,
        {
          visibleText: "",
          attachments: [
            {
              type: "file",
              path: filePath,
              resolvedPath: filePath,
              name: filePath.split("/").pop() || "file"
            }
          ],
          rawText: ""
        },
        {
          sourceMessageId: context.messageId,
          sessionId: null,
          ownerOpenId: context.senderOpenId
        }
      );
      return `文件已尝试发送：${filePath}`;
    }
    if (command.action === "show") {
      if (!this.config.owner.allowReadAllSessions) {
        return "当前配置未开启 owner 跨会话正文读取能力。";
      }
      const sessionId = command.args?.[0];
      if (!sessionId) {
        return "请提供 sessionId。";
      }
      const session = this.sessionStore.getSession(sessionId);
      if (!session) {
        return "未找到该会话。";
      }
      return formatSessionDetail(session);
    }
    return `未知命令。发送 ${this.config.owner.commandPrefix} help 查看可用命令。`;
  }

  async runSessionTurn(sessionMeta, userText) {
    const running = this.sessionLocks.get(sessionMeta.sessionId) ?? Promise.resolve();
    const nextRun = running.then(async () => {
      const session = this.sessionStore.ensureSession(sessionMeta);
      await this.sessionStore.appendMessage(session.sessionId, "user", userText, {
        userOpenId: sessionMeta.userOpenId
      });
      if (this.sessionStore.trimSession(session.sessionId, this.config.sessionPolicy.maxMessages)) {
        await this.sessionStore.save();
      }

      let replyPackage;
      try {
        replyPackage = await this.codexRunner.run(session, userText);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        this.logger.error("codex execution failed", {
          sessionId: session.sessionId,
          message: shortText(failure, 200)
        });
        replyPackage = {
          visibleText: "处理消息时出现错误，请稍后重试。",
          attachments: [],
          rawText: "处理消息时出现错误，请稍后重试。"
        };
      }

      await this.sessionStore.appendMessage(session.sessionId, "assistant", replyPackage.visibleText, {
        attachments: replyPackage.attachments.map((item) => ({
          type: item.type,
          path: item.path,
          name: item.name
        })),
        rawText: replyPackage.rawText
      });
      if (this.sessionStore.trimSession(session.sessionId, this.config.sessionPolicy.maxMessages)) {
        await this.sessionStore.save();
      }
      return replyPackage;
    });

    const lockPromise = nextRun.finally(() => {
      if (this.sessionLocks.get(sessionMeta.sessionId) === lockPromise) {
        this.sessionLocks.delete(sessionMeta.sessionId);
      }
    });
    this.sessionLocks.set(sessionMeta.sessionId, lockPromise);
    return nextRun;
  }

  async sendReplyPackage(messageId, replyPackage, metadata) {
    const failures = [];

    if (replyPackage.visibleText) {
      await this.feishuClient.replyToMessage(messageId, replyPackage.visibleText);
    }

    for (const attachment of replyPackage.attachments) {
      try {
        if (attachment.type === "image") {
          const imageKey = await this.feishuClient.uploadImage(attachment.resolvedPath);
          await this.feishuClient.replyImage(messageId, imageKey);
          await this.sessionStore.appendAttachmentEvent({
            sourceMessageId: metadata.sourceMessageId,
            sessionId: metadata.sessionId,
            ownerOpenId: metadata.ownerOpenId,
            direction: "outbound",
            attachmentType: "image",
            fileName: attachment.name,
            localPath: attachment.resolvedPath,
            remoteKey: imageKey,
            status: "sent"
          });
        } else {
          const uploaded = await this.feishuClient.uploadFile(attachment.resolvedPath);
          await this.feishuClient.replyFile(messageId, uploaded.fileKey, attachment.name || uploaded.fileName);
          await this.sessionStore.appendAttachmentEvent({
            sourceMessageId: metadata.sourceMessageId,
            sessionId: metadata.sessionId,
            ownerOpenId: metadata.ownerOpenId,
            direction: "outbound",
            attachmentType: "file",
            fileName: attachment.name || uploaded.fileName,
            localPath: attachment.resolvedPath,
            remoteKey: uploaded.fileKey,
            status: "sent"
          });
        }
      } catch (error) {
        await this.sessionStore.appendAttachmentEvent({
          sourceMessageId: metadata.sourceMessageId,
          sessionId: metadata.sessionId,
          ownerOpenId: metadata.ownerOpenId,
          direction: "outbound",
          attachmentType: attachment.type,
          fileName: attachment.name,
          localPath: attachment.resolvedPath,
          remoteKey: null,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
        failures.push(`${attachment.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length) {
      await this.feishuClient.replyToMessage(
        messageId,
        `以下附件发送失败：\n${failures.join("\n")}`
      );
      this.logger.warn("attachment send failures", {
        messageId,
        failures
      });
    } else if (!replyPackage.visibleText && replyPackage.attachments.length) {
      this.logger.info("attachment-only reply sent", {
        messageId,
        attachments: formatAttachmentSummary(replyPackage.attachments)
      });
    }
  }

  async tryAddProcessingReaction(messageId) {
    try {
      await this.feishuClient.addReaction(messageId);
    } catch (error) {
      this.logger.warn("reaction add failed", {
        messageId,
        message: error instanceof Error ? shortText(error.message, 160) : String(error)
      });
    }
  }
}
