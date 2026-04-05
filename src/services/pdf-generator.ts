import { PDFDocument, rgb, StandardFonts, PDFFont, PDFImage } from "pdf-lib";
import MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import crypto from "crypto";
import fetch from "node-fetch";
import { config } from "../config";

const md = new MarkdownIt();

interface PdfGenOptions {
  title: string;
  markdown: string;
  signerName: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  authorName: string;
  approvedAt?: string;
}

// Page constants
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 50;
const MARGIN_Y = 60;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const HEADER_HEIGHT = 40;
const FOOTER_HEIGHT = 30;

// Rendering state
let doc: PDFDocument;
let fontRegular: PDFFont;
let fontBold: PDFFont;
let fontItalic: PDFFont;
let fontMono: PDFFont;
let logoImage: PDFImage | null = null;
let currentPage: ReturnType<PDFDocument["addPage"]>;
let yPos: number;
let brandColor: { r: number; g: number; b: number };

export async function generatePdf(options: PdfGenOptions): Promise<Buffer> {
  const { title, markdown, signerName, status, authorName, approvedAt } = options;

  doc = await PDFDocument.create();
  fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
  fontMono = await doc.embedFont(StandardFonts.Courier);
  brandColor = hexToRgb(config.brand.primaryColor);

  // Try to fetch logo
  logoImage = await fetchLogo();

  // Start first page
  currentPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawPageHeader(currentPage);
  yPos = PAGE_HEIGHT - HEADER_HEIGHT - 30;

  // --- DOCUMENT TITLE ---
  ensureSpace(40);
  const titleLines = wrapText(title, fontBold, 18, CONTENT_WIDTH);
  for (const line of titleLines) {
    ensureSpace(24);
    currentPage.drawText(line, {
      x: MARGIN_X,
      y: yPos,
      size: 18,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.15),
    });
    yPos -= 24;
  }
  yPos -= 5;

  // --- SEPARATOR ---
  ensureSpace(15);
  currentPage.drawLine({
    start: { x: MARGIN_X, y: yPos },
    end: { x: PAGE_WIDTH - MARGIN_X, y: yPos },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  yPos -= 15;

  // --- BODY CONTENT ---
  const tokens = md.parse(markdown, {});
  renderTokens(tokens, 0, tokens.length, 0);

  // --- SIGNATURE BLOCK ---
  ensureSpace(130);
  yPos -= 20;
  currentPage.drawLine({
    start: { x: MARGIN_X, y: yPos },
    end: { x: PAGE_WIDTH - MARGIN_X, y: yPos },
    thickness: 1,
    color: rgb(0.6, 0.6, 0.6),
  });
  yPos -= 20;

  currentPage.drawText("DOCUMENT APPROVAL", {
    x: MARGIN_X,
    y: yPos,
    size: 12,
    font: fontBold,
    color: rgb(0.3, 0.3, 0.3),
  });
  yPos -= 20;

  const sigLines = [
    `Requested by: ${authorName}`,
    `Signer: ${signerName}`,
  ];
  for (const line of sigLines) {
    currentPage.drawText(line, {
      x: MARGIN_X,
      y: yPos,
      size: 10,
      font: fontRegular,
      color: rgb(0.3, 0.3, 0.3),
    });
    yPos -= 16;
  }

  const statusColor =
    status === "APPROVED"
      ? rgb(0.1, 0.6, 0.1)
      : status === "REJECTED"
        ? rgb(0.8, 0.1, 0.1)
        : rgb(0.8, 0.6, 0);

  currentPage.drawText(`Status: ${status}`, {
    x: MARGIN_X,
    y: yPos,
    size: 11,
    font: fontBold,
    color: statusColor,
  });
  yPos -= 16;

  currentPage.drawText(`Date: ${approvedAt || new Date().toISOString()}`, {
    x: MARGIN_X,
    y: yPos,
    size: 10,
    font: fontRegular,
    color: rgb(0.3, 0.3, 0.3),
  });

  // --- FOOTER ON EVERY PAGE ---
  const totalPages = doc.getPageCount();
  for (let i = 0; i < totalPages; i++) {
    drawPageFooter(doc.getPage(i), i + 1, totalPages);
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

// ============================================================
// TOKEN RENDERER
// ============================================================

function renderTokens(tokens: Token[], start: number, end: number, listDepth: number): void {
  let i = start;
  while (i < end) {
    const token = tokens[i];

    switch (token.type) {
      case "heading_open": {
        const level = parseInt(token.tag.replace("h", ""), 10);
        // Find the inline content token
        const contentToken = tokens[i + 1];
        if (contentToken && contentToken.type === "inline") {
          const fontSize = level === 1 ? 16 : level === 2 ? 14 : level === 3 ? 12 : 11;
          const spacing = fontSize + 8;
          ensureSpace(spacing + 10);
          renderInline(contentToken, MARGIN_X, fontSize, fontBold, rgb(0.15, 0.15, 0.15));
          yPos -= 4;
        }
        i += 3; // heading_open, inline, heading_close
        continue;
      }

      case "paragraph_open": {
        const contentToken = tokens[i + 1];
        if (contentToken && contentToken.type === "inline") {
          ensureSpace(20);
          renderInline(contentToken, MARGIN_X, 11, fontRegular, rgb(0.2, 0.2, 0.2));
          yPos -= 8;
        }
        i += 3; // paragraph_open, inline, paragraph_close
        continue;
      }

      case "bullet_list_open": {
        i++;
        const closeIdx = findMatchingClose(tokens, i, "bullet_list_close");
        renderListItems(tokens, i, closeIdx, listDepth, "bullet");
        i = closeIdx + 1;
        continue;
      }

      case "ordered_list_open": {
        i++;
        const closeIdx = findMatchingClose(tokens, i, "ordered_list_close");
        renderListItems(tokens, i, closeIdx, listDepth, "ordered");
        i = closeIdx + 1;
        continue;
      }

      case "blockquote_open": {
        i++;
        const closeIdx = findMatchingClose(tokens, i, "blockquote_close");
        renderBlockquote(tokens, i, closeIdx);
        i = closeIdx + 1;
        continue;
      }

      case "fence":
      case "code_block": {
        renderCodeBlock(token.content);
        i++;
        continue;
      }

      case "table_open": {
        const closeIdx = findMatchingClose(tokens, i, "table_close");
        renderTable(tokens, i, closeIdx);
        i = closeIdx + 1;
        continue;
      }

      case "hr": {
        ensureSpace(20);
        currentPage.drawLine({
          start: { x: MARGIN_X, y: yPos },
          end: { x: PAGE_WIDTH - MARGIN_X, y: yPos },
          thickness: 1,
          color: rgb(0.85, 0.85, 0.85),
        });
        yPos -= 15;
        i++;
        continue;
      }

      default:
        i++;
    }
  }
}

// ============================================================
// INLINE RENDERING (bold, italic, mixed)
// ============================================================

function renderInline(
  token: Token,
  startX: number,
  fontSize: number,
  defaultFont: PDFFont,
  color: ReturnType<typeof rgb>,
  maxWidth: number = CONTENT_WIDTH - (startX - MARGIN_X)
): void {
  const children = token.children || [];
  let xPos = startX;
  let lineHeight = fontSize + 6;

  // Collect all segments first to handle line wrapping
  const segments: { text: string; font: PDFFont }[] = [];

  for (let c = 0; c < children.length; c++) {
    const child = children[c];
    if (child.type === "text" || child.type === "code_inline") {
      const segFont = child.type === "code_inline" ? fontMono : defaultFont;
      segments.push({ text: stripMentions(child.content), font: segFont });
    } else if (child.type === "softbreak" || child.type === "hardbreak") {
      segments.push({ text: "\n", font: defaultFont });
    } else if (child.type === "strong_open" || child.type === "strong_close") {
      // Handled by toggling font below
    } else if (child.type === "em_open" || child.type === "em_close") {
      // Handled by toggling font below
    } else if (child.type === "link_open") {
      // Skip link markers, just render text
    } else if (child.type === "link_close") {
      // Skip
    } else if (child.type === "image") {
      segments.push({ text: `[image: ${child.attrGet("alt") || ""}]`, font: fontItalic });
    }
  }

  // Re-parse with font switching
  let currentFont = defaultFont;
  const finalSegments: { text: string; font: PDFFont }[] = [];
  for (let c = 0; c < children.length; c++) {
    const child = children[c];
    if (child.type === "strong_open") {
      currentFont = fontBold;
    } else if (child.type === "strong_close") {
      currentFont = defaultFont;
    } else if (child.type === "em_open") {
      currentFont = fontItalic;
    } else if (child.type === "em_close") {
      currentFont = defaultFont;
    } else if (child.type === "text" || child.type === "code_inline") {
      const segFont = child.type === "code_inline" ? fontMono : currentFont;
      const text = stripMentions(child.content);
      // Split on newlines
      const parts = text.split("\n");
      for (let p = 0; p < parts.length; p++) {
        if (p > 0) finalSegments.push({ text: "\n", font: segFont });
        if (parts[p]) finalSegments.push({ text: parts[p], font: segFont });
      }
    } else if (child.type === "softbreak" || child.type === "hardbreak") {
      finalSegments.push({ text: "\n", font: defaultFont });
    } else if (child.type === "image") {
      finalSegments.push({ text: `[image: ${child.attrGet("alt") || ""}]`, font: fontItalic });
    } else if (child.type === "code_inline") {
      finalSegments.push({ text: stripMentions(child.content), font: fontMono });
    }
  }

  // Render segments with word wrapping
  let currentLineWords: { text: string; font: PDFFont }[] = [];
  let currentLineWidth = 0;

  const flushLine = () => {
    if (currentLineWords.length === 0) return;
    let drawX = xPos;
    for (const word of currentLineWords) {
      currentPage.drawText(word.text, {
        x: drawX,
        y: yPos,
        size: fontSize,
        font: word.font,
        color,
      });
      drawX += word.font.widthOfTextAtSize(word.text, fontSize);
    }
    yPos -= lineHeight;
    xPos = startX;
    currentLineWords = [];
    currentLineWidth = 0;
  };

  for (const seg of finalSegments) {
    if (seg.text === "\n") {
      flushLine();
      continue;
    }

    const words = seg.text.split(/\s+/).filter(Boolean);
    for (const word of words) {
      const spaceWidth = currentLineWords.length > 0
        ? currentFont.widthOfTextAtSize(" ", fontSize)
        : 0;
      const wordWidth = seg.font.widthOfTextAtSize(word, fontSize);
      const totalWidth = currentLineWidth + spaceWidth + wordWidth;

      if (totalWidth > maxWidth && currentLineWords.length > 0) {
        flushLine();
        ensureSpace(lineHeight);
      }

      if (currentLineWords.length > 0) {
        // Add space as a separate segment using the current line's last font
        currentLineWidth += currentLineWords[currentLineWords.length - 1].font.widthOfTextAtSize(" ", fontSize);
      }
      currentLineWords.push({ text: word, font: seg.font });
      currentLineWidth += wordWidth;
    }
  }
  flushLine();
}

// ============================================================
// LIST RENDERING
// ============================================================

function renderListItems(
  tokens: Token[],
  start: number,
  end: number,
  depth: number,
  type: "bullet" | "ordered"
): void {
  let counter = 1;
  let i = start;

  while (i < end) {
    if (tokens[i].type === "list_item_open") {
      const indent = MARGIN_X + depth * 20;
      const marker = type === "bullet" ? "•  " : `${counter}.  `;
      const markerWidth = fontBold.widthOfTextAtSize(marker, 11);

      // Find content within this list item
      const itemClose = findMatchingClose(tokens, i + 1, "list_item_close");

      // Check for nested lists or inline content
      let j = i + 1;
      let foundParagraph = false;

      while (j < itemClose) {
        if (tokens[j].type === "paragraph_open") {
          const contentToken = tokens[j + 1];
          if (contentToken && contentToken.type === "inline") {
            ensureSpace(20);
            // Draw marker
            currentPage.drawText(marker, {
              x: indent,
              y: yPos,
              size: 11,
              font: fontBold,
              color: rgb(0.2, 0.2, 0.2),
            });
            // Render text after marker
            renderInline(
              contentToken,
              indent + markerWidth,
              11,
              fontRegular,
              rgb(0.2, 0.2, 0.2),
              CONTENT_WIDTH - (indent + markerWidth - MARGIN_X)
            );
            foundParagraph = true;
          }
          j += 3;
          continue;
        }
        if (tokens[j].type === "bullet_list_open") {
          const nestedClose = findMatchingClose(tokens, j + 1, "bullet_list_close");
          renderListItems(tokens, j + 1, nestedClose, depth + 1, "bullet");
          j = nestedClose + 1;
          continue;
        }
        if (tokens[j].type === "ordered_list_open") {
          const nestedClose = findMatchingClose(tokens, j + 1, "ordered_list_close");
          renderListItems(tokens, j + 1, nestedClose, depth + 1, "ordered");
          j = nestedClose + 1;
          continue;
        }
        j++;
      }

      if (!foundParagraph) {
        // Empty list item, just draw the marker
        ensureSpace(16);
        currentPage.drawText(marker, {
          x: indent,
          y: yPos,
          size: 11,
          font: fontBold,
          color: rgb(0.2, 0.2, 0.2),
        });
        yPos -= 16;
      }

      yPos -= 4;
      counter++;
      i = itemClose + 1;
    } else {
      i++;
    }
  }
}

// ============================================================
// CODE BLOCK
// ============================================================

function renderCodeBlock(content: string): void {
  if (!content) return;
  const lines = content.split("\n");
  const fontSize = 9;
  const lineHeight = 12;
  const padding = 8;
  const totalHeight = lines.length * lineHeight + padding * 2;

  ensureSpace(Math.min(totalHeight, 100));

  // Draw background
  const startY = yPos + padding;
  let remainingLines = [...lines];
  let blockStart = true;

  while (remainingLines.length > 0) {
    // Calculate how many lines fit on current page
    const availableHeight = yPos - MARGIN_Y - FOOTER_HEIGHT;
    const fittingCount = Math.max(1, Math.floor((availableHeight - padding * 2) / lineHeight));
    const chunk = remainingLines.slice(0, fittingCount);
    const chunkHeight = chunk.length * lineHeight + padding * 2;

    // Draw background rectangle
    currentPage.drawRectangle({
      x: MARGIN_X,
      y: yPos - chunkHeight + padding,
      width: CONTENT_WIDTH,
      height: chunkHeight,
      color: rgb(0.96, 0.96, 0.96),
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 0.5,
    });

    // Draw code lines
    yPos -= padding;
    for (let l = 0; l < chunk.length; l++) {
      const lineNum = blockStart ? l + 1 : l + (lines.length - remainingLines.length) + 1;
      const lineText = truncateText(chunk[l], fontMono, fontSize, CONTENT_WIDTH - 30);
      currentPage.drawText(lineText, {
        x: MARGIN_X + 8,
        y: yPos,
        size: fontSize,
        font: fontMono,
        color: rgb(0.3, 0.3, 0.3),
      });
      yPos -= lineHeight;
    }
    yPos -= padding;

    remainingLines = remainingLines.slice(fittingCount);
    if (remainingLines.length > 0) {
      newPage();
    }
  }
  yPos -= 8;
}

// ============================================================
// BLOCKQUOTE
// ============================================================

function renderBlockquote(tokens: Token[], start: number, end: number): void {
  let i = start;
  const indent = MARGIN_X + 20;
  const borderWidth = 3;

  while (i < end) {
    if (tokens[i].type === "paragraph_open") {
      const contentToken = tokens[i + 1];
      if (contentToken && contentToken.type === "inline") {
        ensureSpace(30);
        // Draw left border
        currentPage.drawRectangle({
          x: MARGIN_X + 5,
          y: yPos - 2,
          width: borderWidth,
          height: 18,
          color: rgb(brandColor.r, brandColor.g, brandColor.b),
        });
        renderInline(
          contentToken,
          indent + 5,
          10,
          fontItalic,
          rgb(0.4, 0.4, 0.4),
          CONTENT_WIDTH - (indent + 5 - MARGIN_X)
        );
      }
      i += 3;
      continue;
    }
    i++;
  }
  yPos -= 4;
}

// ============================================================
// TABLE
// ============================================================

function renderTable(tokens: Token[], start: number, end: number): void {
  // Parse table structure
  interface TableCell {
    text: string;
    width: number;
  }
  interface TableRow {
    cells: TableCell[];
    isHeader: boolean;
  }

  const rows: TableRow[] = [];
  let i = start;

  while (i < end) {
    if (tokens[i].type === "tr_open") {
      const row: TableRow = { cells: [], isHeader: false };
      i++;
      while (i < end && tokens[i].type !== "tr_close") {
        if (tokens[i].type === "th_open") {
          row.isHeader = true;
          i++;
          if (tokens[i] && tokens[i].type === "inline") {
            row.cells.push({
              text: stripMentions(tokens[i].content),
              width: 0,
            });
            i++;
          } else if (tokens[i] && tokens[i].type === "th_close") {
            row.cells.push({ text: "", width: 0 });
          }
          // skip th_close
          if (i < end && tokens[i].type === "th_close") i++;
          continue;
        }
        if (tokens[i].type === "td_open") {
          i++;
          if (tokens[i] && tokens[i].type === "inline") {
            row.cells.push({
              text: stripMentions(tokens[i].content),
              width: 0,
            });
            i++;
          } else if (tokens[i] && tokens[i].type === "td_close") {
            row.cells.push({ text: "", width: 0 });
          }
          if (i < end && tokens[i].type === "td_close") i++;
          continue;
        }
        i++;
      }
      if (row.cells.length > 0) rows.push(row);
    }
    if (i < end && tokens[i].type === "tr_close") i++;
    i++;
  }

  if (rows.length === 0) return;

  const numCols = Math.max(...rows.map(r => r.cells.length));
  if (numCols === 0) return;

  // Calculate column widths
  const colWidths: number[] = [];
  for (let c = 0; c < numCols; c++) {
    let maxWidth = 40; // minimum width
    for (const row of rows) {
      if (c < row.cells.length) {
        const text = row.cells[c].text;
        const width = fontRegular.widthOfTextAtSize(text, 9) + 16;
        if (width > maxWidth) maxWidth = width;
      }
    }
    colWidths.push(maxWidth);
  }

  // Scale to fit page width
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  if (totalWidth > CONTENT_WIDTH) {
    const scale = CONTENT_WIDTH / totalWidth;
    for (let c = 0; c < colWidths.length; c++) {
      colWidths[c] *= scale;
    }
  }

  const rowHeight = 20;
  const fontSize = 9;

  for (const row of rows) {
    ensureSpace(rowHeight + 5);

    // Draw row background
    if (row.isHeader) {
      currentPage.drawRectangle({
        x: MARGIN_X,
        y: yPos - rowHeight + 4,
        width: colWidths.reduce((a, b) => a + b, 0),
        height: rowHeight,
        color: rgb(0.94, 0.94, 0.96),
      });
    }

    // Draw cell borders and text
    let cellX = MARGIN_X;
    for (let c = 0; c < row.cells.length && c < numCols; c++) {
      const cellText = c < row.cells.length ? row.cells[c].text : "";
      const font = row.isHeader ? fontBold : fontRegular;
      const truncated = truncateText(cellText, font, fontSize, colWidths[c] - 12);

      currentPage.drawText(truncated, {
        x: cellX + 6,
        y: yPos - 10,
        size: fontSize,
        font,
        color: row.isHeader ? rgb(0.15, 0.15, 0.15) : rgb(0.3, 0.3, 0.3),
      });

      // Cell border
      currentPage.drawRectangle({
        x: cellX,
        y: yPos - rowHeight + 4,
        width: colWidths[c],
        height: rowHeight,
        borderColor: rgb(0.8, 0.8, 0.8),
        borderWidth: 0.5,
      });

      cellX += colWidths[c];
    }

    yPos -= rowHeight;
  }
  yPos -= 10;
}

// ============================================================
// PAGE MANAGEMENT
// ============================================================

function ensureSpace(needed: number): void {
  if (yPos - needed < MARGIN_Y + FOOTER_HEIGHT) {
    newPage();
  }
}

function newPage(): void {
  currentPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawPageHeader(currentPage);
  yPos = PAGE_HEIGHT - HEADER_HEIGHT - 30;
}

function drawPageHeader(page: ReturnType<PDFDocument["addPage"]>): void {
  // Brand color bar
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - HEADER_HEIGHT,
    width: PAGE_WIDTH,
    height: HEADER_HEIGHT,
    color: rgb(brandColor.r, brandColor.g, brandColor.b),
  });

  let textX = MARGIN_X;

  // Logo
  if (logoImage) {
    const logoHeight = 22;
    const logoWidth = (logoImage.width / logoImage.height) * logoHeight;
    page.drawImage(logoImage, {
      x: MARGIN_X,
      y: PAGE_HEIGHT - HEADER_HEIGHT + (HEADER_HEIGHT - logoHeight) / 2,
      width: Math.min(logoWidth, 100),
      height: logoHeight,
    });
    textX = MARGIN_X + Math.min(logoWidth, 100) + 10;
  }

  // Org name
  page.drawText(config.brand.name, {
    x: textX,
    y: PAGE_HEIGHT - HEADER_HEIGHT + (HEADER_HEIGHT - 12) / 2,
    size: 12,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  // Date
  page.drawText(`Generated: ${new Date().toISOString().split("T")[0]}`, {
    x: PAGE_WIDTH - MARGIN_X - 140,
    y: PAGE_HEIGHT - HEADER_HEIGHT + (HEADER_HEIGHT - 10) / 2,
    size: 10,
    font: fontRegular,
    color: rgb(1, 1, 1),
  });
}

function drawPageFooter(
  page: ReturnType<PDFDocument["addPage"]>,
  pageNum: number,
  totalPages: number
): void {
  const text = `Page ${pageNum} of ${totalPages}`;
  const textWidth = fontRegular.widthOfTextAtSize(text, 8);
  page.drawText(text, {
    x: PAGE_WIDTH / 2 - textWidth / 2,
    y: 20,
    size: 8,
    font: fontRegular,
    color: rgb(0.6, 0.6, 0.6),
  });
}

// ============================================================
// LOGO FETCHING
// ============================================================

async function fetchLogo(): Promise<PDFImage | null> {
  if (!config.brand.logoUrl) return null;
  try {
    const response = await fetch(config.brand.logoUrl, { timeout: 5000 } as never);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("png")) {
      return await doc.embedPng(buffer);
    } else if (contentType.includes("jpeg") || contentType.includes("jpg")) {
      return await doc.embedJpg(buffer);
    } else {
      // Try PNG first, then JPG
      try {
        return await doc.embedPng(buffer);
      } catch {
        try {
          return await doc.embedJpg(buffer);
        } catch {
          return null;
        }
      }
    }
  } catch {
    return null;
  }
}

// ============================================================
// UTILITIES
// ============================================================

export function hashPdf(pdfBuffer: Buffer): string {
  return crypto.createHash("sha256").update(pdfBuffer).digest("hex");
}

function wrapText(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number
): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);

    if (width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

function truncateText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string {
  if (!text) return "";
  const width = font.widthOfTextAtSize(text, fontSize);
  if (width <= maxWidth) return text;

  let truncated = text;
  while (truncated.length > 0 && font.widthOfTextAtSize(truncated + "...", fontSize) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "...";
}

function stripMentions(text: string): string {
  return text.replace(
    /@\[([^\]]+)\]\(mention:\/\/[^)]+\)/g,
    "@$1"
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.substring(0, 2), 16) / 255,
    g: parseInt(clean.substring(2, 4), 16) / 255,
    b: parseInt(clean.substring(4, 6), 16) / 255,
  };
}

function findMatchingClose(tokens: Token[], start: number, closeType: string): number {
  let depth = 1;
  const openType = closeType.replace("_close", "_open");
  let i = start;
  while (i < tokens.length && depth > 0) {
    if (tokens[i].type === openType) depth++;
    if (tokens[i].type === closeType) depth--;
    if (depth > 0) i++;
  }
  return i;
}
