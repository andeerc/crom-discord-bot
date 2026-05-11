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

@Injectable()
export class SummaryStoreService {
  private db: any;

  constructor(private config: ConfigService) {
    const dbPath = resolve(
      this.config.get("SQLITE_PATH") || "data/summaries.sqlite",
    );

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
    `);
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
}
