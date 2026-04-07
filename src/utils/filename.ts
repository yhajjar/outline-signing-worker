/**
 * Strip only filesystem-illegal characters, preserving spaces and unicode.
 * Illegal chars: / \ : * ? " < > |
 */
export function sanitizeFilename(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, "").substring(0, 120);
}
