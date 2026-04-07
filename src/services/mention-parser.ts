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

// --- ProseMirror JSON types ---

export interface ProsemirrorNode {
  type: string;
  text?: string;
  attrs?: Record<string, string | null>;
  content?: ProsemirrorNode[];
}

export interface ProsemirrorDoc {
  type: string;
  content?: ProsemirrorNode[];
}

/**
 * Parse `/sign @mention` commands from Outline comment ProseMirror JSON.
 *
 * Outline comments deliver content as ProseMirror JSON. A `/sign @User` comment
 * looks like:
 *   { type: "doc", content: [{ type: "paragraph", content: [
 *     { type: "text", text: "/sign " },
 *     { type: "mention", attrs: { type: "user", modelId: "<uuid>", label: "Name" } }
 *   ]}]}
 */
export function parseSignCommandsFromProsemirror(data: ProsemirrorDoc): ParseResult {
  const signers: ParsedSigner[] = [];
  let foundSignCommand = false;

  function walk(nodes: ProsemirrorNode[]): void {
    for (const node of nodes) {
      if (node.type === "text" && node.text) {
        if (node.text.trim().startsWith("/sign")) {
          foundSignCommand = true;
        }
      }
      if (node.type === "mention" && node.attrs) {
        if (node.attrs.type === "user" && node.attrs.modelId) {
          signers.push({
            displayName: node.attrs.label || node.attrs.modelId,
            userId: node.attrs.modelId,
            fullMatch: `@${node.attrs.label}`,
          });
        }
      }
      if (node.content) {
        walk(node.content);
      }
    }
  }

  if (data?.content) {
    walk(data.content);
  }

  return {
    found: foundSignCommand && signers.length > 0,
    signers,
    cleanMarkdown: "",
  };
}
