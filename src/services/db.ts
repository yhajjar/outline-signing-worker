import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "../config";

let db: Database.Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS signing_requests (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    document_title TEXT NOT NULL,
    document_text TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    signer_user_id TEXT NOT NULL,
    signer_email TEXT NOT NULL,
    signer_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    webhook_delivery_id TEXT,
    trigger_comment_id TEXT UNIQUE,
    pdf_hash TEXT,
    attachment_id TEXT,
    rejection_reason TEXT,
    expiry_notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_status ON signing_requests(status);
  CREATE INDEX IF NOT EXISTS idx_delivery ON signing_requests(webhook_delivery_id);
  CREATE INDEX IF NOT EXISTS idx_trigger_comment ON signing_requests(trigger_comment_id);
  CREATE INDEX IF NOT EXISTS idx_document_signer ON signing_requests(document_id, signer_user_id);
`;

export function initDb(): Database.Database {
  const dir = path.dirname(config.db.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.db.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  // Migration: add trigger_comment_id column if missing (existing databases)
  try {
    db.exec("ALTER TABLE signing_requests ADD COLUMN trigger_comment_id TEXT UNIQUE");
  } catch {
    // Column already exists — safe to ignore
  }
  try {
    db.exec("ALTER TABLE signing_requests ADD COLUMN expiry_notified INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — safe to ignore
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    return initDb();
  }
  return db;
}

export interface SigningRequest {
  id: string;
  document_id: string;
  document_title: string;
  document_text: string;
  author_user_id: string;
  signer_user_id: string;
  signer_email: string;
  signer_name: string;
  status: string;
  webhook_delivery_id: string | null;
  trigger_comment_id: string | null;
  pdf_hash: string | null;
  attachment_id: string | null;
  rejection_reason: string | null;
  expiry_notified: number;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
}

export function createSigningRequest(
  req: Omit<SigningRequest, "created_at" | "resolved_at" | "pdf_hash" | "attachment_id" | "rejection_reason" | "expiry_notified">
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO signing_requests
      (id, document_id, document_title, document_text, author_user_id,
       signer_user_id, signer_email, signer_name, status, webhook_delivery_id,
       trigger_comment_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.id,
    req.document_id,
    req.document_title,
    req.document_text,
    req.author_user_id,
    req.signer_user_id,
    req.signer_email,
    req.signer_name,
    req.status,
    req.webhook_delivery_id,
    req.trigger_comment_id,
    req.expires_at
  );
}

export function findPendingRequest(
  documentId: string,
  signerUserId: string
): SigningRequest | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM signing_requests WHERE document_id = ? AND signer_user_id = ? AND status = 'pending'"
    )
    .get(documentId, signerUserId) as SigningRequest | undefined;
}

export function findRequestById(id: string): SigningRequest | undefined {
  return getDb()
    .prepare("SELECT * FROM signing_requests WHERE id = ?")
    .get(id) as SigningRequest | undefined;
}

export function findByDeliveryId(deliveryId: string): SigningRequest | undefined {
  return getDb()
    .prepare("SELECT * FROM signing_requests WHERE webhook_delivery_id = ?")
    .get(deliveryId) as SigningRequest | undefined;
}

export function findByCommentId(commentId: string): SigningRequest | undefined {
  return getDb()
    .prepare("SELECT * FROM signing_requests WHERE trigger_comment_id = ?")
    .get(commentId) as SigningRequest | undefined;
}

export function markExpiryNotified(id: string): void {
  getDb()
    .prepare("UPDATE signing_requests SET expiry_notified = 1 WHERE id = ?")
    .run(id);
}

export function findExpiredUnnotified(): SigningRequest[] {
  return getDb()
    .prepare(
      "SELECT * FROM signing_requests WHERE status = 'expired' AND expiry_notified = 0 AND trigger_comment_id IS NOT NULL"
    )
    .all() as SigningRequest[];
}

export function updateRequestStatus(
  id: string,
  status: string,
  extra?: { pdf_hash?: string; attachment_id?: string; rejection_reason?: string }
): void {
  const db = getDb();
  const resolvedAt = new Date().toISOString();

  if (extra) {
    db.prepare(
      `UPDATE signing_requests
       SET status = ?, resolved_at = ?, pdf_hash = COALESCE(?, pdf_hash),
           attachment_id = COALESCE(?, attachment_id), rejection_reason = COALESCE(?, rejection_reason)
       WHERE id = ?`
    ).run(
      status,
      resolvedAt,
      extra.pdf_hash || null,
      extra.attachment_id || null,
      extra.rejection_reason || null,
      id
    );
  } else {
    db.prepare(
      "UPDATE signing_requests SET status = ?, resolved_at = ? WHERE id = ?"
    ).run(status, resolvedAt, id);
  }
}

export function expireOldRequests(): number {
  const result = getDb()
    .prepare(
      "UPDATE signing_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at < datetime('now')"
    )
    .run(new Date().toISOString());
  return result.changes;
}
