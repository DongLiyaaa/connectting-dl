import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso, readJson, shortText } from "./utils.js";

function createLegacyState() {
  return {
    sessions: {},
    counter: 0,
    receipts: {
      processedMessageIds: []
    }
  };
}

function parseJson(value, fallbackValue) {
  if (!value) {
    return fallbackValue;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallbackValue;
  }
}

export class SessionStore {
  constructor(storage) {
    this.dataDir = storage.dataDir;
    this.dbPath = storage.dbPath;
    this.legacyJsonPath = path.join(storage.dataDir, "sessions.json");
    this.db = null;
  }

  async load() {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.createSchema();
    await this.importLegacyJsonIfNeeded();
  }

  async save() {
    return;
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        user_open_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_preview TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        extra_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id_id
      ON messages(session_id, id);

      CREATE TABLE IF NOT EXISTS processed_receipts (
        message_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS owner_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        owner_open_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        command_text TEXT NOT NULL,
        response_text TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_owner_actions_timestamp
      ON owner_actions(timestamp DESC);

      CREATE TABLE IF NOT EXISTS attachment_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_message_id TEXT NOT NULL,
        session_id TEXT,
        owner_open_id TEXT,
        direction TEXT NOT NULL,
        attachment_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        local_path TEXT NOT NULL,
        remote_key TEXT,
        status TEXT NOT NULL,
        error_message TEXT NOT NULL DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_events_timestamp
      ON attachment_events(timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
      ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async importLegacyJsonIfNeeded() {
    const imported = this.db
      .prepare("SELECT value FROM meta WHERE key = 'legacy_json_imported_at'")
      .get();
    if (imported) {
      return;
    }

    const sessionCount = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count;
    const messageCount = this.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
    const receiptCount = this.db.prepare("SELECT COUNT(*) AS count FROM processed_receipts").get().count;
    if (sessionCount > 0 || messageCount > 0 || receiptCount > 0) {
      this.db
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('legacy_json_imported_at', ?)")
        .run(nowIso());
      return;
    }

    const legacy = await readJson(this.legacyJsonPath, createLegacyState());
    if (!legacy || (!legacy.sessions && !legacy.receipts)) {
      this.db
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('legacy_json_imported_at', ?)")
        .run(nowIso());
      return;
    }

    const insertSession = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        session_id, scope, chat_id, chat_name, chat_type, user_open_id, user_name,
        created_at, updated_at, last_preview, tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMessage = this.db.prepare(`
      INSERT INTO messages (session_id, role, text, timestamp, extra_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertReceipt = this.db.prepare(`
      INSERT OR IGNORE INTO processed_receipts (message_id, timestamp)
      VALUES (?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      for (const session of Object.values(legacy.sessions ?? {})) {
        insertSession.run(
          session.sessionId,
          session.scope ?? "unknown",
          session.chatId ?? "",
          session.chatName ?? "",
          session.chatType ?? "unknown",
          session.userOpenId ?? "",
          session.userName ?? "",
          session.createdAt ?? nowIso(),
          session.updatedAt ?? nowIso(),
          session.lastPreview ?? "",
          JSON.stringify(session.tags ?? [])
        );

        for (const message of session.messages ?? []) {
          const { role, text, timestamp, ...extra } = message;
          insertMessage.run(
            session.sessionId,
            role ?? "user",
            text ?? "",
            timestamp ?? nowIso(),
            JSON.stringify(extra)
          );
        }
      }

      for (const receipt of legacy.receipts?.processedMessageIds ?? []) {
        insertReceipt.run(receipt.messageId, receipt.timestamp ?? nowIso());
      }

      this.db
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('legacy_json_imported_at', ?)")
        .run(nowIso());
      this.db.exec("COMMIT");
      await this.archiveLegacyJson();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureSession(meta) {
    const existing = this.db
      .prepare(`
        SELECT session_id
        FROM sessions
        WHERE session_id = ?
      `)
      .get(meta.sessionId);

    const timestamp = nowIso();
    if (existing) {
      this.db
        .prepare(`
          UPDATE sessions
          SET scope = ?,
              chat_id = ?,
              chat_name = ?,
              chat_type = ?,
              user_open_id = ?,
              user_name = ?,
              updated_at = ?
          WHERE session_id = ?
        `)
        .run(
          meta.scope,
          meta.chatId,
          meta.chatName ?? "",
          meta.chatType,
          meta.userOpenId,
          meta.userName ?? "",
          timestamp,
          meta.sessionId
        );
    } else {
      this.db
        .prepare(`
          INSERT INTO sessions (
            session_id, scope, chat_id, chat_name, chat_type, user_open_id, user_name,
            created_at, updated_at, last_preview, tags_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '[]')
        `)
        .run(
          meta.sessionId,
          meta.scope,
          meta.chatId,
          meta.chatName ?? "",
          meta.chatType,
          meta.userOpenId,
          meta.userName ?? "",
          timestamp,
          timestamp
        );
    }

    return this.getSession(meta.sessionId);
  }

  async appendMessage(sessionId, role, text, extra = {}) {
    const sessionExists = this.db
      .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
      .get(sessionId);
    if (!sessionExists) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const timestamp = nowIso();
    this.db
      .prepare(`
        INSERT INTO messages (session_id, role, text, timestamp, extra_json)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(sessionId, role, text, timestamp, JSON.stringify(extra));

    this.db
      .prepare(`
        UPDATE sessions
        SET updated_at = ?, last_preview = ?
        WHERE session_id = ?
      `)
      .run(timestamp, shortText(text, 80), sessionId);
  }

  trimSession(sessionId, maxMessages) {
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
      .get(sessionId);
    const excess = Number(countRow?.count ?? 0) - maxMessages;
    if (excess <= 0) {
      return false;
    }

    this.db
      .prepare(`
        DELETE FROM messages
        WHERE id IN (
          SELECT id
          FROM messages
          WHERE session_id = ?
          ORDER BY id ASC
          LIMIT ?
        )
      `)
      .run(sessionId, excess);
    return true;
  }

  listSessions() {
    const rows = this.db
      .prepare(`
        SELECT
          s.session_id AS sessionId,
          s.scope AS scope,
          s.chat_name AS chatName,
          s.user_name AS userName,
          s.chat_type AS chatType,
          s.updated_at AS updatedAt,
          s.last_preview AS lastPreview,
          COUNT(m.id) AS messageCount
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.session_id
        GROUP BY s.session_id
        ORDER BY s.updated_at DESC
      `)
      .all();

    return rows.map((row) => ({
      sessionId: row.sessionId,
      scope: row.scope,
      chatName: row.chatName,
      userName: row.userName,
      chatType: row.chatType,
      updatedAt: row.updatedAt,
      messageCount: Number(row.messageCount ?? 0),
      lastPreview: row.lastPreview ?? ""
    }));
  }

  getSession(sessionId) {
    const session = this.db
      .prepare(`
        SELECT
          session_id AS sessionId,
          scope,
          chat_id AS chatId,
          chat_name AS chatName,
          chat_type AS chatType,
          user_open_id AS userOpenId,
          user_name AS userName,
          created_at AS createdAt,
          updated_at AS updatedAt,
          last_preview AS lastPreview,
          tags_json AS tagsJson
        FROM sessions
        WHERE session_id = ?
      `)
      .get(sessionId);
    if (!session) {
      return null;
    }

    const messages = this.db
      .prepare(`
        SELECT role, text, timestamp, extra_json AS extraJson
        FROM messages
        WHERE session_id = ?
        ORDER BY id ASC
      `)
      .all(sessionId)
      .map((row) => ({
        role: row.role,
        text: row.text,
        timestamp: row.timestamp,
        ...parseJson(row.extraJson, {})
      }));

    return {
      sessionId: session.sessionId,
      scope: session.scope,
      chatId: session.chatId,
      chatName: session.chatName,
      chatType: session.chatType,
      userOpenId: session.userOpenId,
      userName: session.userName,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastPreview: session.lastPreview,
      tags: parseJson(session.tagsJson, []),
      messages
    };
  }

  hasProcessedMessage(messageId) {
    const row = this.db
      .prepare("SELECT 1 AS found FROM processed_receipts WHERE message_id = ?")
      .get(messageId);
    return Boolean(row);
  }

  async markProcessedMessage(messageId) {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO processed_receipts (message_id, timestamp)
        VALUES (?, ?)
      `)
      .run(messageId, nowIso());

    this.db
      .prepare(`
        DELETE FROM processed_receipts
        WHERE message_id IN (
          SELECT message_id
          FROM processed_receipts
          ORDER BY timestamp DESC
          LIMIT -1 OFFSET 500
        )
      `)
      .run();
  }

  async appendOwnerAction(entry) {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO owner_actions (
          message_id, owner_open_id, chat_id, chat_type, command_text, response_text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.messageId,
        entry.ownerOpenId,
        entry.chatId,
        entry.chatType,
        entry.commandText,
        entry.responseText,
        entry.timestamp ?? nowIso()
      );
  }

  listOwnerActions(limit = 20) {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          message_id AS messageId,
          owner_open_id AS ownerOpenId,
          chat_id AS chatId,
          chat_type AS chatType,
          command_text AS commandText,
          response_text AS responseText,
          timestamp
        FROM owner_actions
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(limit);
    return rows.map((row) => ({
      id: Number(row.id),
      messageId: row.messageId,
      ownerOpenId: row.ownerOpenId,
      chatId: row.chatId,
      chatType: row.chatType,
      commandText: row.commandText,
      responseText: row.responseText,
      timestamp: row.timestamp
    }));
  }

  countOwnerActions() {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM owner_actions").get();
    return Number(row?.count ?? 0);
  }

  async appendAttachmentEvent(entry) {
    this.db
      .prepare(`
        INSERT INTO attachment_events (
          source_message_id, session_id, owner_open_id, direction, attachment_type,
          file_name, local_path, remote_key, status, error_message, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.sourceMessageId,
        entry.sessionId ?? null,
        entry.ownerOpenId ?? null,
        entry.direction,
        entry.attachmentType,
        entry.fileName,
        entry.localPath,
        entry.remoteKey ?? null,
        entry.status,
        entry.errorMessage ?? "",
        entry.timestamp ?? nowIso()
      );
  }

  listAttachmentEvents(limit = 20) {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          source_message_id AS sourceMessageId,
          session_id AS sessionId,
          owner_open_id AS ownerOpenId,
          direction,
          attachment_type AS attachmentType,
          file_name AS fileName,
          local_path AS localPath,
          remote_key AS remoteKey,
          status,
          error_message AS errorMessage,
          timestamp
        FROM attachment_events
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(limit);
    return rows.map((row) => ({
      id: Number(row.id),
      sourceMessageId: row.sourceMessageId,
      sessionId: row.sessionId,
      ownerOpenId: row.ownerOpenId,
      direction: row.direction,
      attachmentType: row.attachmentType,
      fileName: row.fileName,
      localPath: row.localPath,
      remoteKey: row.remoteKey,
      status: row.status,
      errorMessage: row.errorMessage,
      timestamp: row.timestamp
    }));
  }

  countAttachmentEvents() {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM attachment_events").get();
    return Number(row?.count ?? 0);
  }

  async exportState() {
    return {
      sessions: this.listSessions(),
      ownerActions: this.countOwnerActions(),
      attachmentEvents: this.countAttachmentEvents(),
      dbPath: this.dbPath
    };
  }

  async archiveLegacyJson() {
    try {
      await fs.access(this.legacyJsonPath);
    } catch {
      return;
    }
    const archivedPath = `${this.legacyJsonPath}.migrated`;
    await fs.rename(this.legacyJsonPath, archivedPath).catch(() => {});
  }
}
