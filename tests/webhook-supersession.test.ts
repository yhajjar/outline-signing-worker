import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
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

// Mock external services
const mockOutlineGetDocument = vi.fn().mockResolvedValue({
  title: "Test Doc",
  text: "# Hello",
});
const mockOutlineGetUser = vi.fn();
const mockOutlineCreateComment = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/services/outline-client", () => ({
  getDocument: (...args: unknown[]) => mockOutlineGetDocument(...args),
  getUser: (...args: unknown[]) => mockOutlineGetUser(...args),
  createComment: (...args: unknown[]) => mockOutlineCreateComment(...args),
}));

vi.mock("../src/services/pdf-generator", () => ({
  generatePdf: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
}));

vi.mock("../src/services/email-sender", () => ({
  sendSigningRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/middleware/verify-signature", () => ({
  verifyWebhookSignature: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from "express";
import request from "supertest";
import {
  initDb,
  getDb,
  findRequestById,
  findPendingRequest,
} from "../src/services/db";
import webhookRouter from "../src/routes/webhook";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/webhook", webhookRouter);
  return app;
}

function makeWebhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "delivery-" + Date.now(),
    actorId: overrides.actorId || "author-user-id",
    event: "comments.create",
    payload: {
      id: overrides.commentId || "comment-" + Date.now(),
      model: {
        id: overrides.commentId || "comment-" + Date.now(),
        data: overrides.data || {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "/sign " },
                {
                  type: "mention",
                  attrs: {
                    type: "user",
                    modelId: overrides.signerUserId || "signer-1",
                    label: overrides.signerName || "Ahmad",
                  },
                },
              ],
            },
          ],
        },
        documentId: overrides.documentId || "doc-1",
        parentCommentId: overrides.parentCommentId || null,
        createdById: overrides.actorId || "author-user-id",
      },
    },
  };
}

describe("Webhook handler - supersession flow", () => {
  let app: express.Application;
  let commentCounter = 0;

  beforeEach(() => {
    initDb();
    getDb().exec("DELETE FROM signing_requests");
    app = makeApp();
    vi.clearAllMocks();
    commentCounter = 0;

    // Default user lookups
    mockOutlineGetUser.mockImplementation((userId: string) => {
      if (userId === "author-user-id") {
        return Promise.resolve({ name: "Yasser", email: "yasser@test.com" });
      }
      return Promise.resolve({
        name: userId === "signer-1" ? "Ahmad" : "Test User",
        email: userId === "signer-1" ? "ahmad@test.com" : "user@test.com",
      });
    });
  });

  it("should create a signing request on first /sign", async () => {
    const payload = makeWebhookPayload();
    const res = await request(app).post("/webhook/outline").send(payload);
    expect(res.status).toBe(200);

    const pending = findPendingRequest("doc-1", "signer-1");
    expect(pending).toBeDefined();
    expect(pending!.status).toBe("pending");
  });

  it("should supersede an existing pending request on re-send", async () => {
    // First request
    const payload1 = makeWebhookPayload({ commentId: "comment-first" });
    await request(app).post("/webhook/outline").send(payload1);

    const firstReq = findPendingRequest("doc-1", "signer-1");
    expect(firstReq).toBeDefined();

    // Second request (same doc+signer, different comment)
    const payload2 = makeWebhookPayload({ commentId: "comment-second" });
    await request(app).post("/webhook/outline").send(payload2);

    // Old request should be superseded
    const oldReq = findRequestById(firstReq!.id);
    expect(oldReq!.status).toBe("superseded");
    expect(oldReq!.superseded_by).not.toBeNull();

    // New pending request exists
    const newPending = findPendingRequest("doc-1", "signer-1");
    expect(newPending).toBeDefined();
    expect(newPending!.id).not.toBe(firstReq!.id);
    expect(newPending!.status).toBe("pending");

    // Old request's superseded_by points to new request
    expect(oldReq!.superseded_by).toBe(newPending!.id);
  });

  it("should post audit comment on superseded trigger comment", async () => {
    // First request
    await request(app)
      .post("/webhook/outline")
      .send(makeWebhookPayload({ commentId: "comment-old" }));

    // Second request triggers supersession
    await request(app)
      .post("/webhook/outline")
      .send(makeWebhookPayload({ commentId: "comment-new" }));

    // Should have posted a superseded audit comment
    // First call: superseded audit comment on old trigger
    // Second call: confirmation reply on new trigger
    const supersedeCall = mockOutlineCreateComment.mock.calls.find(
      (call: unknown[]) => {
        const text = (call as unknown[])[1] as string;
        return text && text.includes("Superseded");
      }
    );
    expect(supersedeCall).toBeDefined();
    // The audit comment should be posted under the OLD trigger comment
    expect((supersedeCall as unknown[])[2]).toBe("comment-old");
  });

  it("should include supersession note in confirmation reply", async () => {
    // First request
    await request(app)
      .post("/webhook/outline")
      .send(makeWebhookPayload({ commentId: "comment-1st" }));

    // Second request
    await request(app)
      .post("/webhook/outline")
      .send(makeWebhookPayload({ commentId: "comment-2nd" }));

    // Find the confirmation reply (posted under the NEW comment)
    const confirmCall = mockOutlineCreateComment.mock.calls.find(
      (call: unknown[]) => {
        const text = (call as unknown[])[1] as string;
        return text && text.includes("Signature request registered") && text.includes("supersedes");
      }
    );
    expect(confirmCall).toBeDefined();
    const replyText = (confirmCall as unknown[])[1] as string;
    expect(replyText).toContain("supersedes previous request from");
  });

  it("should NOT include supersession note on first request", async () => {
    await request(app)
      .post("/webhook/outline")
      .send(makeWebhookPayload({ commentId: "comment-only" }));

    const confirmCall = mockOutlineCreateComment.mock.calls.find(
      (call: unknown[]) => {
        const text = (call as unknown[])[1] as string;
        return text && text.includes("Signature request registered");
      }
    );
    expect(confirmCall).toBeDefined();
    const replyText = (confirmCall as unknown[])[1] as string;
    expect(replyText).not.toContain("supersedes");
  });

  it("should ignore bot's own comments", async () => {
    const payload = makeWebhookPayload({ actorId: "bot-user-id" });
    const res = await request(app).post("/webhook/outline").send(payload);
    expect(res.status).toBe(200);

    // No request should be created
    const all = getDb().prepare("SELECT * FROM signing_requests").all();
    expect(all).toHaveLength(0);
  });

  it("should ignore reply comments", async () => {
    const payload = makeWebhookPayload({ parentCommentId: "parent-123" });
    const res = await request(app).post("/webhook/outline").send(payload);
    expect(res.status).toBe(200);

    const all = getDb().prepare("SELECT * FROM signing_requests").all();
    expect(all).toHaveLength(0);
  });

  it("should ignore non-comment events", async () => {
    const payload = makeWebhookPayload();
    payload.event = "comments.update";
    const res = await request(app).post("/webhook/outline").send(payload);
    expect(res.status).toBe(200);

    const all = getDb().prepare("SELECT * FROM signing_requests").all();
    expect(all).toHaveLength(0);
  });

  it("should skip duplicate trigger comment (idempotency)", async () => {
    const payload = makeWebhookPayload({ commentId: "comment-dup" });

    // First call
    await request(app).post("/webhook/outline").send(payload);
    const first = findPendingRequest("doc-1", "signer-1");
    expect(first).toBeDefined();

    // Reset to see if second call creates anything new
    const countBefore = getDb().prepare("SELECT COUNT(*) as c FROM signing_requests").get() as { c: number };

    // Second call with same comment ID
    await request(app).post("/webhook/outline").send(payload);

    const countAfter = getDb().prepare("SELECT COUNT(*) as c FROM signing_requests").get() as { c: number };
    expect(countAfter.c).toBe(countBefore.c);
  });

  it("should handle superseding a request that was already approved", async () => {
    // Create and approve a request directly
    await request(app)
      .post("/webhook/outline")
      .send(makeWebhookPayload({ commentId: "comment-approved" }));

    const first = findPendingRequest("doc-1", "signer-1");
    expect(first).toBeDefined();

    // Approve it
    getDb().prepare("UPDATE signing_requests SET status = 'approved' WHERE id = ?").run(first!.id);

    // Now send a new /sign - should NOT supersede the approved one
    await request(app)
      .post("/webhook/outline")
      .send(makeWebhookPayload({ commentId: "comment-after-approve" }));

    // Original should still be approved
    const original = findRequestById(first!.id);
    expect(original!.status).toBe("approved");

    // New request should exist
    const newReq = getDb()
      .prepare("SELECT * FROM signing_requests WHERE trigger_comment_id = ?")
      .get("comment-after-approve") as { id: string; status: string } | undefined;
    expect(newReq).toBeDefined();
    expect(newReq!.status).toBe("pending");
  });

  it("should still create and email a request when confirmation reply fails", async () => {
    mockOutlineCreateComment.mockRejectedValueOnce(new Error("HTTP 403"));

    const payload = makeWebhookPayload({ commentId: "comment-reply-fails" });
    const res = await request(app).post("/webhook/outline").send(payload);

    expect(res.status).toBe(200);

    const pending = findPendingRequest("doc-1", "signer-1");
    expect(pending).toBeDefined();
    expect(pending!.trigger_comment_id).toBe("comment-reply-fails");
  });
});
