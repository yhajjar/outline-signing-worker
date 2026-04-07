import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    db: { path: ":memory:" },
    jwt: { secret: "test", expiresHours: 72 },
    outline: {
      url: "https://outline.test",
      apiKey: "admin-api-key",
      botToken: "restricted-bot-token",
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

const fetchMock = vi.fn();

vi.mock("node-fetch", () => ({
  default: (...args: unknown[]) => fetchMock(...args),
}));

describe("outline-client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "comment-1" } }),
    });
  });

  it("uses the admin api key for worker reply comments", async () => {
    const { createComment } = await import("../src/services/outline-client");

    await createComment("doc-1", "hello", "comment-parent");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://outline.test/api/comments.create");
    expect(options.headers.Authorization).toBe("Bearer admin-api-key");
  });
});
