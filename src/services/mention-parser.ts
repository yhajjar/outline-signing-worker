export interface ParsedSigner {
  displayName: string;
  userId: string;
  fullMatch: string;
}

export interface ParseResult {
  found: boolean;
  signers: ParsedSigner[];
  cleanMarkdown: string;
}

const SIGN_COMMAND_REGEX =
  /\/sign\s+(@\[[^\]]+\]\(mention:\/\/(?:[a-z0-9-]+\/)?user\/[a-z0-9-]+\))/gi;

const MENTION_REGEX =
  /@\[([^\]]+)\]\(mention:\/\/(?:[a-z0-9-]+\/)?user\/([a-z0-9-]+)\)/i;

/**
 * Parse `/sign @mention` commands from Outline document markdown.
 *
 * Outline user mentions use the format:
 *   @[Display Name](mention://<nodeId>/user/<userId>)
 *   @[Display Name](mention://user/<userId>)
 *
 * The `/sign` command must precede the mention.
 */
export function parseSignCommands(markdown: string): ParseResult {
  const signers: ParsedSigner[] = [];
  const lines = markdown.split("\n");
  const cleanLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let match: RegExpExecArray | null;

    // Check if this line contains /sign
    SIGN_COMMAND_REGEX.lastIndex = 0;
    if (SIGN_COMMAND_REGEX.test(trimmed)) {
      // Extract all mentions on this line
      const mentionRegex = new RegExp(
        /@\[([^\]]+)\]\(mention:\/\/(?:[a-z0-9-]+\/)?user\/([a-z0-9-]+)\)/,
        "gi"
      );
      let mentionMatch: RegExpExecArray | null;
      while ((mentionMatch = mentionRegex.exec(trimmed)) !== null) {
        signers.push({
          displayName: mentionMatch[1],
          userId: mentionMatch[2],
          fullMatch: mentionMatch[0],
        });
      }
      // Skip this line (don't include in clean markdown)
      continue;
    }

    cleanLines.push(line);
  }

  return {
    found: signers.length > 0,
    signers,
    cleanMarkdown: cleanLines.join("\n").trim(),
  };
}
