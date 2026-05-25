import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function safeJsonParse(raw, fallbackValue) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

export class FeishuClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.tokenCache = null;
  }

  async getTenantAccessToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 30_000) {
      return this.tokenCache.token;
    }

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Failed to get tenant access token: ${JSON.stringify(data)}`);
    }
    this.tokenCache = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + Number(data.expire || 7200) * 1000
    };
    return this.tokenCache.token;
  }

  verifySignature(rawBody, headers) {
    if (!this.config.feishu.encryptKey) {
      return;
    }
    const timestamp = headers["x-lark-request-timestamp"];
    const nonce = headers["x-lark-request-nonce"];
    const signature = headers["x-lark-signature"];
    if (!timestamp || !nonce || !signature) {
      throw new Error("Missing Feishu signature headers");
    }
    const content = `${timestamp}${nonce}${this.config.feishu.encryptKey}${rawBody}`;
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    if (digest !== signature) {
      throw new Error("Feishu signature verification failed");
    }
  }

  decodePayload(rawBody) {
    const outer = safeJsonParse(rawBody, null);
    if (!outer) {
      throw new Error("Invalid JSON request body");
    }
    if (outer.encrypt) {
      return decryptEvent(outer.encrypt, this.config.feishu.encryptKey);
    }
    return outer;
  }

  verifyToken(payload) {
    if (!this.config.feishu.verificationToken) {
      return;
    }
    if (payload.token && payload.token !== this.config.feishu.verificationToken) {
      throw new Error("Feishu verification token mismatch");
    }
  }

  async replyToMessage(messageId, text) {
    return this.replyWithContent(messageId, "text", {
      text: `${buildTextPrefix(this.config)}${text}`
    });
  }

  async replyImage(messageId, imageKey) {
    return this.replyWithContent(messageId, "image", {
      image_key: imageKey
    });
  }

  async replyFile(messageId, fileKey, fileName) {
    return this.replyWithContent(messageId, "file", {
      file_key: fileKey,
      file_name: fileName
    });
  }

  async replyWithContent(messageId, msgType, content) {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        msg_type: msgType,
        content: JSON.stringify(content)
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Failed to reply message: ${JSON.stringify(data)}`);
    }
    return data;
  }

  async addReaction(messageId, emojiType = this.config.feishu.processingReactionEmoji) {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: emojiType
        }
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Failed to add reaction: ${JSON.stringify(data)}`);
    }
    return data;
  }

  async uploadImage(filePath) {
    const token = await this.getTenantAccessToken();
    const fileName = path.basename(filePath);
    const fileBytes = await fs.readFile(filePath);
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new File([fileBytes], fileName));

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0 || !data.data?.image_key) {
      throw new Error(`Failed to upload image: ${JSON.stringify(data)}`);
    }
    return data.data.image_key;
  }

  async uploadFile(filePath, fileType = inferFileType(filePath)) {
    const token = await this.getTenantAccessToken();
    const fileName = path.basename(filePath);
    const fileBytes = await fs.readFile(filePath);
    const form = new FormData();
    form.append("file_type", fileType);
    form.append("file_name", fileName);
    form.append("file", new File([fileBytes], fileName));

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0 || !data.data?.file_key) {
      throw new Error(`Failed to upload file: ${JSON.stringify(data)}`);
    }
    return {
      fileKey: data.data.file_key,
      fileName
    };
  }
}

export function inferFileType(filePath) {
  const extension = path.extname(filePath).toLowerCase().replace(/^\./, "");
  const known = new Set([
    "doc",
    "xls",
    "ppt",
    "pdf",
    "mp4",
    "docx",
    "xlsx",
    "pptx",
    "zip"
  ]);
  if (known.has(extension)) {
    return extension;
  }
  return "stream";
}

function buildTextPrefix(config) {
  const pieces = [];
  if (config.feishu.replyPrefix) {
    pieces.push(config.feishu.replyPrefix);
  }
  if (config.feishu.botName) {
    pieces.push(`[${config.feishu.botName}] `);
  }
  return pieces.join("");
}

function decryptEvent(encrypted, encryptKey) {
  if (!encryptKey) {
    throw new Error("Received encrypted Feishu payload but feishu.encryptKey is empty");
  }
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const encryptedBuffer = Buffer.from(encrypted, "base64");
  const iv = encryptedBuffer.subarray(0, 16);
  const cipherText = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted);
}
