import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    db: { path: ":memory:" },
    jwt: { secret: "test-jwt-secret-key-for-testing", expiresHours: 72 },
    outline: {
      url: "https://outline.test",
      apiKey: "test-key",
      botToken: "test-bot-token",
      botUserId: "bot-user-id",
    },
    smtp: {
      host: "smtp.test",
      port: 587,
      secure: false,
      user: "test",
      pass: "test",
      from: '"Document Approvals" <test@test.com>',
    },
    brand: { name: "Test Org", logoUrl: "", primaryColor: "#1a73e8" },
    worker: { url: "https://worker.test" },
    port: 3100,
    webhook: { secret: "" },
  },
}));

const mockCreateComment = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/services/outline-client", () => ({
  getUser: vi.fn().mockResolvedValue({ name: "Signer", email: "signer@test.com" }),
  createComment: (...args: unknown[]) => mockCreateComment(...args),
  createAttachment: vi.fn().mockResolvedValue({
    uploadUrl: "https://upload.test",
    form: {},
    attachment: { id: "att-1" },
  }),
  uploadAttachment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/pdf-generator", () => ({
  generatePdf: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
  hashPdf: vi.fn().mockReturnValue("abc123def456"),
}));

vi.mock("../src/services/email-sender", () => ({
  sendSigningRequest: vi.fn().mockResolvedValue(undefined),
  sendApprovalConfirmation: vi.fn().mockResolvedValue(undefined),
  sendRejectionNotice: vi.fn().mockResolvedValue(undefined),
  sendApprovedCopyToSigner: vi.fn().mockResolvedValue(undefined),
}));

import express from "express";
import request from "supertest";
import { createApprovalToken } from "../src/utils/jwt";
import {
  initDb,
  getDb,
  createSigningRequest,
  updateRequestStatus,
  findRequestById,
} from "../src/services/db";
import approvalRouter from "../src/routes/approval";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/", approvalRouter);
  return app;
}

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
    trigger_comment_id: overrides.trigger_comment_id || "comment-1",
    expires_at: overrides.expires_at || new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
  };
}

async function createTokenAndRequest(overrides: Record<string, string> = {}) {
  const req = makeRequest(overrides);
  createSigningRequest(req);

  const token = createApprovalToken({
    signingRequestId: req.id,
    documentId: req.document_id,
    signerUserId: req.signer_user_id,
    authorUserId: req.author_user_id,
  });

  return { req, token };
}

describe("Approval route - superseded status handling", () => {
  let app: express.Application;

  beforeEach(() => {
    initDb();
    getDb().exec("DELETE FROM signing_requests");
    app = makeApp();
    vi.clearAllMocks();
    mockCreateComment.mockResolvedValue(undefined);
  });

  it("should show 'Request Superseded' page when approving a superseded request", async () => {
    const { req, token } = await createTokenAndRequest();
    updateRequestStatus(req.id, "superseded");

    const res = await request(app).get(`/approve/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Request Superseded");
    expect(res.text).toContain("replaced by a newer one");
    expect(res.text).not.toContain("Already Processed");
  });

  it("should show 'Request Superseded' page when rejecting a superseded request", async () => {
    const { req, token } = await createTokenAndRequest();
    updateRequestStatus(req.id, "superseded");

    const res = await request(app).get(`/reject/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Request Superseded");
    expect(res.text).toContain("replaced by a newer one");
    expect(res.text).not.toContain("Already Processed");
  });

  it("should show 'Already Processed' for approved request (not superseded)", async () => {
    const { req, token } = await createTokenAndRequest();
    updateRequestStatus(req.id, "approved", {
      pdf_hash: "abc",
      attachment_id: "att-1",
    });

    const res = await request(app).get(`/approve/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Already Processed");
    expect(res.text).toContain("approved");
    expect(res.text).not.toContain("Superseded");
  });

  it("should show 'Already Processed' for rejected request (not superseded)", async () => {
    const { req, token } = await createTokenAndRequest();
    updateRequestStatus(req.id, "rejected");

    const res = await request(app).get(`/approve/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Already Processed");
    expect(res.text).toContain("rejected");
  });

  it("should show 'Already Processed' for expired request", async () => {
    const { req, token } = await createTokenAndRequest();
    updateRequestStatus(req.id, "expired");

    const res = await request(app).get(`/approve/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Already Processed");
    expect(res.text).toContain("expired");
  });

  it("should successfully approve a pending request", async () => {
    const { req, token } = await createTokenAndRequest();

    const res = await request(app).get(`/approve/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Document Approved");

    const updated = findRequestById(req.id);
    expect(updated!.status).toBe("approved");
  });

  it("should successfully reject a pending request", async () => {
    const { req, token } = await createTokenAndRequest();

    const res = await request(app).get(`/reject/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Document Rejected");

    const updated = findRequestById(req.id);
    expect(updated!.status).toBe("rejected");
  });

  it("should still return approval success if posting the reply comment fails", async () => {
    const { req, token } = await createTokenAndRequest();
    mockCreateComment.mockRejectedValueOnce(new Error("HTTP 403"));

    const res = await request(app).get(`/approve/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Document Approved");

    const updated = findRequestById(req.id);
    expect(updated!.status).toBe("approved");
    expect(updated!.attachment_id).toBe("att-1");
  });

  it("should still return rejection success if posting the reply comment fails", async () => {
    const { req, token } = await createTokenAndRequest();
    mockCreateComment.mockRejectedValueOnce(new Error("HTTP 403"));

    const res = await request(app).get(`/reject/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Document Rejected");

    const updated = findRequestById(req.id);
    expect(updated!.status).toBe("rejected");
  });

  it("should return 400 for invalid token", async () => {
    const res = await request(app).get(`/approve/invalid-token`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("Invalid or Expired Link");
  });

  it("should return 404 for valid token but missing request", async () => {
    const token = createApprovalToken({
      signingRequestId: "nonexistent-id",
      documentId: "doc-1",
      signerUserId: "signer-1",
      authorUserId: "author-1",
    });

    const res = await request(app).get(`/approve/${token}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain("Not Found");
  });
});
