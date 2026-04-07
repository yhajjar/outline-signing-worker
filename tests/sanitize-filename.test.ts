import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "../src/utils/filename";

describe("sanitizeFilename", () => {
  it("should preserve spaces and unicode", () => {
    expect(sanitizeFilename("E2E Test - Signing Request")).toBe(
      "E2E Test - Signing Request"
    );
  });

  it("should strip forward slashes", () => {
    expect(sanitizeFilename("path/to/file")).toBe("pathtofile");
  });

  it("should strip backslashes", () => {
    expect(sanitizeFilename("path\\to\\file")).toBe("pathtofile");
  });

  it("should strip colons", () => {
    expect(sanitizeFilename("Report: Q1 2025")).toBe("Report Q1 2025");
  });

  it("should strip asterisks", () => {
    expect(sanitizeFilename("Important *Draft*")).toBe("Important Draft");
  });

  it("should strip question marks", () => {
    expect(sanitizeFilename("What? When?")).toBe("What When");
  });

  it("should strip double quotes", () => {
    expect(sanitizeFilename('The "Final" Version')).toBe("The Final Version");
  });

  it("should strip angle brackets", () => {
    expect(sanitizeFilename("<template>")).toBe("template");
  });

  it("should strip pipe characters", () => {
    expect(sanitizeFilename("option A | option B")).toBe("option A  option B");
  });

  it("should strip all illegal characters at once", () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
  });

  it("should truncate to 120 characters", () => {
    const long = "a".repeat(200);
    expect(sanitizeFilename(long).length).toBe(120);
  });

  it("should not truncate short strings", () => {
    expect(sanitizeFilename("Short Title")).toBe("Short Title");
  });

  it("should handle empty string", () => {
    expect(sanitizeFilename("")).toBe("");
  });

  it("should preserve unicode characters", () => {
    expect(sanitizeFilename("Téléchargement — Rapport")).toBe(
      "Téléchargement — Rapport"
    );
  });

  it("should handle Arabic text", () => {
    expect(sanitizeFilename("تقرير الاختبار")).toBe("تقرير الاختبار");
  });

  it("should handle emoji in titles", () => {
    expect(sanitizeFilename("Report 📊 Q1")).toBe("Report 📊 Q1");
  });

  it("should produce different output than old regex sanitizer", () => {
    const title = "E2E Test - Signing Request";
    const oldStyle = title.replace(/[^a-zA-Z0-9]/g, "_");
    const newStyle = sanitizeFilename(title);
    expect(newStyle).not.toBe(oldStyle);
    expect(newStyle).toBe("E2E Test - Signing Request");
    expect(oldStyle).toBe("E2E_Test___Signing_Request");
  });
});
