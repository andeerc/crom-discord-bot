import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const { DatabaseSync } = require("node:sqlite");

export type SummaryCheckpoint = {
  channelId: string;
  guildId: string | null;
  lastMessageId: string | null;
  lastMessageTimestamp: string | null;
  lastSummaryAt: string | null;
};

export type SaveSummaryInput = {
  channelId: string;
  guildId: string | null;
  fromMessageId: string | null;
  toMessageId: string;
  fromTimestamp: string;
  toTimestamp: string;
  messageCount: number;
  summary: string;
};

export type StoredSummary = {
  id: number;
  channelId: string;
  guildId: string | null;
  fromMessageId: string | null;
  toMessageId: string;
  fromTimestamp: string;
  toTimestamp: string;
  messageCount: number;
  summary: string;
  createdAt: string;
};

export type SaveMessageInput = {
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  content: string;
  createdAt: string;
};


export type IngestCheckpoint = {
  channelId: string;
  guildId: string | null;
  lastMessageId: string;
  lastMessageTimestamp: string | null;
  updatedAt: string;
};

export type StoredMessage = {
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  content: string;
  createdAt: string;
};

@Injectable()
export class SummaryStoreService {
  private db: any;
  private retentionDays: number;

  constructor(private config: ConfigService) {
    const dbPath = resolve(
      this.config.get("SQLITE_PATH") || "data/summaries.sqlite",
    );
    this.retentionDays = Number(this.config.get("MESSAGE_RETENTION_DAYS") || 3);

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summary_checkpoints (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT,
        last_message_id TEXT,
        last_message_timestamp TEXT,
        last_summary_at TEXT
      );

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        guild_id TEXT,
        from_message_id TEXT,
        to_message_id TEXT NOT NULL,
        from_timestamp TEXT NOT NULL,
        to_timestamp TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS channel_messages (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_username TEXT NOT NULL,
        author_display_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingest_checkpoints (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT,
        last_message_id TEXT NOT NULL,
        last_message_timestamp TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    this.pruneOldMessages();
  }

  getCheckpoint(channelId: string): SummaryCheckpoint | null {
    const row = this.db
      .prepare(
        `
          SELECT
            channel_id as channelId,
            guild_id as guildId,
            last_message_id as lastMessageId,
            last_message_timestamp as lastMessageTimestamp,
            last_summary_at as lastSummaryAt
          FROM summary_checkpoints
          WHERE channel_id = ?
        `,
      )
      .get(channelId);

    return row || null;
  }

  getLatestSummary(channelId: string): StoredSummary | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            channel_id as channelId,
            guild_id as guildId,
            from_message_id as fromMessageId,
            to_message_id as toMessageId,
            from_timestamp as fromTimestamp,
            to_timestamp as toTimestamp,
            message_count as messageCount,
            summary,
            created_at as createdAt
          FROM summaries
          WHERE channel_id = ?
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(channelId);

    return row || null;
  }

  saveSummary(input: SaveSummaryInput): void {
    const now = new Date().toISOString();

    try {
      this.db.exec("BEGIN");

      this.db
        .prepare(
          `
            INSERT INTO summaries (
              channel_id,
              guild_id,
              from_message_id,
              to_message_id,
              from_timestamp,
              to_timestamp,
              message_count,
              summary,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.channelId,
          input.guildId,
          input.fromMessageId,
          input.toMessageId,
          input.fromTimestamp,
          input.toTimestamp,
          input.messageCount,
          input.summary,
          now,
        );

      this.db
        .prepare(
          `
            INSERT INTO summary_checkpoints (
              channel_id,
              guild_id,
              last_message_id,
              last_message_timestamp,
              last_summary_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET
              guild_id = excluded.guild_id,
              last_message_id = excluded.last_message_id,
              last_message_timestamp = excluded.last_message_timestamp,
              last_summary_at = excluded.last_summary_at
          `,
        )
        .run(
          input.channelId,
          input.guildId,
          input.toMessageId,
          input.toTimestamp,
          now,
        );

      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors after a failed transaction.
      }

      throw error;
    }
  }

  saveMessage(input: SaveMessageInput): void {
    this.db
      .prepare(
        `
          INSERT INTO channel_messages (
            message_id,
            guild_id,
            channel_id,
            author_id,
            author_username,
            author_display_name,
            content,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            guild_id = excluded.guild_id,
            channel_id = excluded.channel_id,
            author_id = excluded.author_id,
            author_username = excluded.author_username,
            author_display_name = excluded.author_display_name,
            content = excluded.content,
            created_at = excluded.created_at
        `,
      )
      .run(
        input.messageId,
        input.guildId,
        input.channelId,
        input.authorId,
        input.authorUsername,
        input.authorDisplayName,
        input.content,
        input.createdAt,
      );
  }

  saveMessages(inputs: SaveMessageInput[]): void {
    if (inputs.length === 0) {
      return;
    }

    try {
      this.db.exec("BEGIN");

      for (const input of inputs) {
        this.saveMessage(input);
      }

      this.db.exec("COMMIT");
      this.pruneOldMessages();
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors after a failed transaction.
      }

      throw error;
    }
  }

  getStoredMessages(
    channelId: string,
    sinceIso: string,
    limit: number,
  ): StoredMessage[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            guild_id as guildId,
            channel_id as channelId,
            message_id as messageId,
            author_id as authorId,
            author_username as authorUsername,
            author_display_name as authorDisplayName,
            content,
            created_at as createdAt
          FROM channel_messages
          WHERE channel_id = ?
            AND created_at >= ?
          ORDER BY created_at ASC
          LIMIT ?
        `,
      )
      .all(channelId, sinceIso, limit);

    return rows || [];
  }

  getIngestCheckpoint(channelId: string): IngestCheckpoint | null {
    const row = this.db
      .prepare(
        `
          SELECT
            channel_id as channelId,
            guild_id as guildId,
            last_message_id as lastMessageId,
            last_message_timestamp as lastMessageTimestamp,
            updated_at as updatedAt
          FROM ingest_checkpoints
          WHERE channel_id = ?
        `,
      )
      .get(channelId);

    return row || null;
  }

  upsertIngestCheckpoint(
    channelId: string,
    guildId: string | null,
    lastMessageId: string,
    lastMessageTimestamp: string | null,
  ): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
          INSERT INTO ingest_checkpoints (
            channel_id,
            guild_id,
            last_message_id,
            last_message_timestamp,
            updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(channel_id) DO UPDATE SET
            guild_id = excluded.guild_id,
            last_message_id = excluded.last_message_id,
            last_message_timestamp = excluded.last_message_timestamp,
            updated_at = excluded.updated_at
        `,
      )
      .run(channelId, guildId, lastMessageId, lastMessageTimestamp, now);
  }

  pruneOldMessages(): void {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    this.db
      .prepare(
        `
          DELETE FROM channel_messages
          WHERE created_at < ?
        `,
      )
      .run(cutoff);
  }
}
