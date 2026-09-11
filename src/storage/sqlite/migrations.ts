import type { DatabaseSync } from "node:sqlite";

interface SqliteMigration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "create_order_payment_storage",
    sql: `
      CREATE TABLE orders (
        id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
        status TEXT NOT NULL CHECK (
          status IN (
            'draft',
            'awaiting_payment',
            'paid',
            'submitted_to_poster',
            'cancelled'
          )
        ),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE payments (
        checkout_id TEXT PRIMARY KEY CHECK (length(trim(checkout_id)) > 0),
        provider TEXT NOT NULL CHECK (provider = 'sumup'),
        order_id TEXT NOT NULL UNIQUE,
        checkout_reference TEXT NOT NULL UNIQUE
          CHECK (length(trim(checkout_reference)) > 0),
        merchant_code TEXT NOT NULL CHECK (length(trim(merchant_code)) > 0),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        currency TEXT NOT NULL CHECK (currency = 'EUR'),
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'paid', 'failed', 'expired')
        ),
        successful_transaction_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paid_at TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
        CHECK (
          (
            status = 'paid'
            AND successful_transaction_id IS NOT NULL
            AND length(trim(successful_transaction_id)) > 0
            AND paid_at IS NOT NULL
          )
          OR
          (
            status != 'paid'
            AND successful_transaction_id IS NULL
            AND paid_at IS NULL
          )
        )
      ) STRICT;

      CREATE INDEX payments_status_idx ON payments(status);
    `,
  },
  {
    version: 2,
    name: "create_poster_handoff_storage",
    sql: `
      CREATE TABLE poster_handoffs (
        order_id TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL UNIQUE
          CHECK (length(trim(correlation_id)) > 0),
        payload_fingerprint TEXT NOT NULL CHECK (
          length(payload_fingerprint) = 64
          AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        status TEXT NOT NULL CHECK (
          status IN ('submitting', 'submitted', 'uncertain')
        ),
        poster_order_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
        CHECK (
          (
            status = 'submitted'
            AND poster_order_id IS NOT NULL
            AND length(trim(poster_order_id)) > 0
            AND submitted_at IS NOT NULL
          )
          OR
          (
            status != 'submitted'
            AND poster_order_id IS NULL
            AND submitted_at IS NULL
          )
        )
      ) STRICT;

      CREATE INDEX poster_handoffs_status_idx ON poster_handoffs(status);
    `,
  },
  {
    version: 3,
    name: "create_conversation_storage",
    sql: `
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY
          CHECK (length(trim(conversation_id)) > 0),
        channel TEXT NOT NULL CHECK (length(trim(channel)) > 0),
        user_id TEXT NOT NULL CHECK (length(trim(user_id)) > 0),
        order_id TEXT NOT NULL UNIQUE CHECK (length(trim(order_id)) > 0),
        checkout_id TEXT UNIQUE,
        checkout_reference TEXT UNIQUE,
        checkout_link TEXT,
        status TEXT NOT NULL CHECK (
          status IN (
            'collecting_order',
            'awaiting_payment',
            'payment_not_confirmed',
            'payment_confirmed',
            'submission_pending',
            'submission_uncertain',
            'order_submitted'
          )
        ),
        payment_status TEXT NOT NULL CHECK (
          payment_status IN (
            'not_requested',
            'awaiting_payment',
            'payment_not_confirmed',
            'payment_confirmed'
          )
        ),
        order_submission_status TEXT NOT NULL CHECK (
          order_submission_status IN (
            'not_started',
            'submission_pending',
            'submission_uncertain',
            'order_submitted'
          )
        ),
        last_processed_message_id TEXT,
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (
            checkout_id IS NULL
            AND checkout_reference IS NULL
            AND checkout_link IS NULL
          )
          OR
          (
            checkout_id IS NOT NULL
            AND checkout_reference IS NOT NULL
            AND checkout_link IS NOT NULL
            AND
            length(trim(checkout_id)) > 0
            AND length(trim(checkout_reference)) > 0
            AND length(trim(checkout_link)) > 0
          )
        ),
        CHECK (
          last_processed_message_id IS NULL
          OR length(trim(last_processed_message_id)) > 0
        )
      ) STRICT;

      CREATE INDEX conversations_channel_user_idx
        ON conversations(channel, user_id);
      CREATE INDEX conversations_status_idx ON conversations(status);
    `,
  },
];

export class SqliteMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteMigrationError";
  }
}

export function applySqliteMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  for (const migration of MIGRATIONS) {
    runMigration(database, migration);
  }
}

function runMigration(
  database: DatabaseSync,
  migration: SqliteMigration,
): void {
  database.exec("BEGIN IMMEDIATE");

  try {
    const existing = database
      .prepare("SELECT name FROM schema_migrations WHERE version = ?")
      .get(migration.version) as { name: unknown } | undefined;

    if (existing !== undefined) {
      if (existing.name !== migration.name) {
        throw new SqliteMigrationError(
          `Migration ${migration.version} has an unexpected name`,
        );
      }

      database.exec("COMMIT");
      return;
    }

    database.exec(migration.sql);
    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (?, ?, ?)`,
      )
      .run(migration.version, migration.name, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original migration error if SQLite already rolled back.
  }
}
