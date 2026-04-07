import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
vi.mock("../src/config", () => ({
  config: {
    db: { path: ":memory:" },
    jwt: { secret: "test", expiresHours: 72 },
    outline: { url: "https://outline.test", apiKey: "k", botToken: "b", botUserId: "bot" },
    smtp: { host: "smtp.test", port: 587, secure: false, user: "u", pass: "p", from: '"Document Approvals" <test@test.com>' },
    brand: { name: "Test", logoUrl: "", primaryColor: "#000" },
    worker: { url: "https://worker.test" },
    port: 3100,
    webhook: { secret: "" },
  },
}));

// Mock nodemailer — the transporter is created at module-level in email-sender,
// so we must mock createTransport BEFORE importing email-sender.
const sendMailMock = vi.fn().mockResolvedValue({ messageId: "msg-1" });

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: sendMailMock,
    }),
  },
}));

import { sanitizeFilename } from "../src/utils/filename";

describe("Email sender - filename sanitization", () => {
  beforeEach(() => {
    sendMailMock.mockClear();
  });

  it("sendSigningRequest should use sanitizeFilename for attachment", async () => {
    const { sendSigningRequest } = await import("../src/services/email-sender");

    await sendSigningRequest({
      to: "signer@test.com",
      signerName: "Ahmad",
      documentTitle: "E2E Test - Signing Request",
      authorName: "Yasser",
      approveUrl: "https://worker.test/approve/token",
      rejectUrl: "https://worker.test/reject/token",
      pdfBuffer: Buffer.from("pdf"),
      documentUrl: "https://outline.test/doc/doc-1",
    });

    expect(sendMailMock).toHaveBeenCalledOnce();
    const call = sendMailMock.mock.calls[0][0];
    expect(call.subject).toBe("[ACTION REQUIRED] Document Approval: E2E Test - Signing Request");
    expect(call.attachments[0].filename).toBe("pending_E2E Test - Signing Request.pdf");
  });

  it("sendApprovalConfirmation should use sanitizeFilename", async () => {
    const { sendApprovalConfirmation } = await import("../src/services/email-sender");

    sendMailMock.mockClear();

    await sendApprovalConfirmation({
      authorEmail: "author@test.com",
      authorName: "Yasser",
      signerName: "Ahmad",
      documentTitle: 'Report: "Q1 2025"',
      documentUrl: "https://outline.test/doc/doc-1",
      pdfBuffer: Buffer.from("pdf"),
    });

    expect(sendMailMock).toHaveBeenCalledOnce();
    const call = sendMailMock.mock.calls[0][0];
    expect(call.subject).toBe('[Approved] Ahmad signed: Report: "Q1 2025"');
    expect(call.attachments[0].filename).toBe("signed_Report Q1 2025.pdf");
  });

  it("sendApprovedCopyToSigner should use sanitizeFilename", async () => {
    const { sendApprovedCopyToSigner } = await import("../src/services/email-sender");

    sendMailMock.mockClear();

    await sendApprovedCopyToSigner({
      signerEmail: "signer@test.com",
      signerName: "Ahmad",
      documentTitle: "Path/To/File",
      authorName: "Yasser",
      pdfBuffer: Buffer.from("pdf"),
      documentUrl: "https://outline.test/doc/doc-1",
    });

    expect(sendMailMock).toHaveBeenCalledOnce();
    const call = sendMailMock.mock.calls[0][0];
    expect(call.attachments[0].filename).toBe("signed_PathToFile.pdf");
  });

  it("sendRejectionNotice should not have attachments", async () => {
    const { sendRejectionNotice } = await import("../src/services/email-sender");

    sendMailMock.mockClear();

    await sendRejectionNotice({
      authorEmail: "author@test.com",
      authorName: "Yasser",
      signerName: "Ahmad",
      documentTitle: "Some Doc",
      documentUrl: "https://outline.test/doc/doc-1",
    });

    expect(sendMailMock).toHaveBeenCalledOnce();
    const call = sendMailMock.mock.calls[0][0];
    expect(call.subject).toBe("[Rejected] Ahmad rejected: Some Doc");
    expect(call.attachments).toBeUndefined();
  });

  it("verify sanitizeFilename strips illegal chars but preserves spaces", () => {
    // Cross-check: verify the sanitizer behavior matches what we expect in filenames
    expect(sanitizeFilename("E2E Test - Signing Request")).toBe("E2E Test - Signing Request");
    expect(sanitizeFilename('Report: "Q1 2025"')).toBe("Report Q1 2025");
    expect(sanitizeFilename("Path/To\\File")).toBe("PathToFile");
    expect(sanitizeFilename("a*b?c<d>e|f")).toBe("abcdef");
  });
});
