import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Use a fixed temp path — vi.mock is hoisted and can't reference runtime variables
vi.mock("../src/config", () => ({
  config: {
    db: { path: "/tmp/signing-db-test/test.db" },
    jwt: { secret: "test-secret", expiresHours: 72 },
    outline: { url: "https://outline.test", apiKey: "key", botToken: "bot", botUserId: "bot-id" },
    smtp: { host: "smtp.test", port: 587, secure: false, user: "u", pass: "p", from: "test@test.com" },
    brand: { name: "Test", logoUrl: "", primaryColor: "#000" },
    worker: { url: "https://worker.test" },
    port: 3100,
    webhook: { secret: "" },
  },
}));

import fs from "fs";
import {
  initDb,
  getDb,
  createSigningRequest,
  findPendingRequest,
  findRequestById,
  updateRequestStatus,
  supersedePendingRequests,
} from "../src/services/db";

const TMP_DIR = "/tmp/signing-db-test";

function makeRequest(overrides: Record<string, string> = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    document_id: overrides.document_id || "doc-1",
    document_title: overrides.document_title || "Test Document",
    document_text: overrides.document_text || "# Hello",
    author_user_id: overrides.author_user_id || "author-1",
    signer_user_id: overrides.signer_user_id || "signer-1",
    signer_email: overrides.signer_email || "signer@test.com",
    signer_name: overrides.signer_name || "Test Signer",
    status: overrides.status || "pending",
    webhook_delivery_id: overrides.webhook_delivery_id || null,
    trigger_comment_id: overrides.trigger_comment_id || `comment-${Date.now()}-${Math.random()}`,
    expires_at: overrides.expires_at || new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
  };
}

describe("Database - supersession", () => {
  beforeEach(() => {
    initDb();
    getDb().exec("DELETE FROM signing_requests");
  });

  afterAll(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("should create a signing request", () => {
    const req = makeRequest();
    createSigningRequest(req);
    const found = findRequestById(req.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(req.id);
    expect(found!.status).toBe("pending");
    expect(found!.superseded_by).toBeNull();
  });

  it("should find a pending request by document+signer", () => {
    const req = makeRequest({ document_id: "doc-A", signer_user_id: "user-X" });
    createSigningRequest(req);
    const found = findPendingRequest("doc-A", "user-X");
    expect(found).toBeDefined();
    expect(found!.id).toBe(req.id);
  });

  it("should NOT find pending request for different signer", () => {
    const req = makeRequest({ document_id: "doc-A", signer_user_id: "user-X" });
    createSigningRequest(req);
    const found = findPendingRequest("doc-A", "user-Y");
    expect(found).toBeUndefined();
  });

  it("should NOT find pending request after status change to approved", () => {
    const req = makeRequest();
    createSigningRequest(req);
    updateRequestStatus(req.id, "approved");
    const found = findPendingRequest(req.document_id, req.signer_user_id);
    expect(found).toBeUndefined();
  });

  describe("supersedePendingRequests", () => {
    it("should return empty array when no pending requests exist", () => {
      const result = supersedePendingRequests("doc-1", "signer-1", "new-id");
      expect(result).toEqual([]);
    });

    it("should supersede a single pending request", () => {
      const oldReq = makeRequest({ document_id: "doc-X", signer_user_id: "user-Y" });
      createSigningRequest(oldReq);

      const newId = crypto.randomUUID();
      const result = supersedePendingRequests("doc-X", "user-Y", newId);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(oldReq.id);
      expect(result[0].triggerCommentId).toBe(oldReq.trigger_comment_id);
      expect(result[0].createdAt).toBeDefined();

      const updated = findRequestById(oldReq.id);
      expect(updated!.status).toBe("superseded");
      expect(updated!.superseded_by).toBe(newId);
      expect(updated!.resolved_at).not.toBeNull();

      const pending = findPendingRequest("doc-X", "user-Y");
      expect(pending).toBeUndefined();
    });

    it("should supersede multiple pending requests for same doc+signer", () => {
      const req1 = makeRequest({
        document_id: "doc-M",
        signer_user_id: "user-M",
        trigger_comment_id: "comment-multi-1",
      });
      const req2 = makeRequest({
        document_id: "doc-M",
        signer_user_id: "user-M",
        trigger_comment_id: "comment-multi-2",
      });
      createSigningRequest(req1);
      createSigningRequest(req2);

      const newId = crypto.randomUUID();
      const result = supersedePendingRequests("doc-M", "user-M", newId);

      expect(result).toHaveLength(2);
      expect(findRequestById(req1.id)!.status).toBe("superseded");
      expect(findRequestById(req2.id)!.status).toBe("superseded");
    });

    it("should NOT supersede requests for a different signer", () => {
      const req = makeRequest({ document_id: "doc-Z", signer_user_id: "user-A" });
      createSigningRequest(req);

      const result = supersedePendingRequests("doc-Z", "user-B", "new-id");
      expect(result).toHaveLength(0);
      expect(findRequestById(req.id)!.status).toBe("pending");
    });

    it("should NOT supersede already approved requests", () => {
      const req = makeRequest({ document_id: "doc-Q", signer_user_id: "user-Q" });
      createSigningRequest(req);
      updateRequestStatus(req.id, "approved");

      const result = supersedePendingRequests("doc-Q", "user-Q", "new-id");
      expect(result).toHaveLength(0);
      expect(findRequestById(req.id)!.status).toBe("approved");
    });

    it("should NOT supersede already rejected requests", () => {
      const req = makeRequest({ document_id: "doc-R", signer_user_id: "user-R" });
      createSigningRequest(req);
      updateRequestStatus(req.id, "rejected");

      const result = supersedePendingRequests("doc-R", "user-R", "new-id");
      expect(result).toHaveLength(0);
      expect(findRequestById(req.id)!.status).toBe("rejected");
    });

    it("should NOT supersede already expired requests", () => {
      const req = makeRequest({ document_id: "doc-E", signer_user_id: "user-E" });
      createSigningRequest(req);
      updateRequestStatus(req.id, "expired");

      const result = supersedePendingRequests("doc-E", "user-E", "new-id");
      expect(result).toHaveLength(0);
    });

    it("should NOT supersede already superseded requests", () => {
      const req = makeRequest({ document_id: "doc-S", signer_user_id: "user-S" });
      createSigningRequest(req);
      updateRequestStatus(req.id, "superseded");

      const result = supersedePendingRequests("doc-S", "user-S", "new-id-2");
      expect(result).toHaveLength(0);
    });

    it("should set superseded_by to the new request ID", () => {
      const oldReq = makeRequest({ document_id: "doc-BY", signer_user_id: "user-BY" });
      createSigningRequest(oldReq);

      const newId = "new-request-uuid";
      supersedePendingRequests("doc-BY", "user-BY", newId);

      const updated = findRequestById(oldReq.id);
      expect(updated!.superseded_by).toBe(newId);
    });

    it("should return the creation timestamp for audit", () => {
      const oldReq = makeRequest({ document_id: "doc-TS", signer_user_id: "user-TS" });
      createSigningRequest(oldReq);

      const newId = crypto.randomUUID();
      const result = supersedePendingRequests("doc-TS", "user-TS", newId);

      expect(result[0].createdAt).toBeDefined();
      expect(new Date(result[0].createdAt).getTime()).not.toBeNaN();
    });

    it("should allow creating a new pending request after superseding", () => {
      const oldReq = makeRequest({ document_id: "doc-NEW", signer_user_id: "user-NEW" });
      createSigningRequest(oldReq);

      const newId = crypto.randomUUID();
      supersedePendingRequests("doc-NEW", "user-NEW", newId);

      const newReq = makeRequest({
        id: newId,
        document_id: "doc-NEW",
        signer_user_id: "user-NEW",
        trigger_comment_id: "comment-new",
      });
      createSigningRequest(newReq);

      const found = findPendingRequest("doc-NEW", "user-NEW");
      expect(found).toBeDefined();
      expect(found!.id).toBe(newId);
      expect(found!.status).toBe("pending");
    });
  });

  describe("full supersession lifecycle", () => {
    it("supersede -> approve new request -> old link shows superseded", () => {
      const oldReq = makeRequest({ document_id: "doc-LC", signer_user_id: "user-LC" });
      createSigningRequest(oldReq);

      const newId = crypto.randomUUID();
      supersedePendingRequests("doc-LC", "user-LC", newId);

      const oldFound = findRequestById(oldReq.id);
      expect(oldFound!.status).toBe("superseded");

      const newReq = makeRequest({
        id: newId,
        document_id: "doc-LC",
        signer_user_id: "user-LC",
        trigger_comment_id: "comment-lc-new",
      });
      createSigningRequest(newReq);

      updateRequestStatus(newId, "approved", { pdf_hash: "abc123", attachment_id: "att-1" });
      const newFound = findRequestById(newId);
      expect(newFound!.status).toBe("approved");
      expect(newFound!.pdf_hash).toBe("abc123");
    });

    it("supersede -> reject new request -> both are terminal", () => {
      const oldReq = makeRequest({ document_id: "doc-RJ", signer_user_id: "user-RJ" });
      createSigningRequest(oldReq);

      const newId = crypto.randomUUID();
      supersedePendingRequests("doc-RJ", "user-RJ", newId);

      const newReq = makeRequest({
        id: newId,
        document_id: "doc-RJ",
        signer_user_id: "user-RJ",
        trigger_comment_id: "comment-rj-new",
      });
      createSigningRequest(newReq);

      updateRequestStatus(newId, "rejected");
      expect(findRequestById(oldReq.id)!.status).toBe("superseded");
      expect(findRequestById(newId)!.status).toBe("rejected");
    });
  });

  describe("schema migration", () => {
    it("should handle superseded_by column on existing DB", () => {
      const req = makeRequest();
      createSigningRequest(req);
      const found = findRequestById(req.id);
      expect(found).toHaveProperty("superseded_by");
      expect(found!.superseded_by).toBeNull();
    });
  });
});
