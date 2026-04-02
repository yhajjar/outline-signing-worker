import { PDFDocument, rgb, StandardFonts, PDFFont } from "pdf-lib";
import MarkdownIt from "markdown-it";
import crypto from "crypto";
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

/**
 * Generate a branded PDF from Outline document markdown.
 *
 * Uses pdf-lib to construct the PDF programmatically.
 * Markdown is parsed with markdown-it for structure extraction,
 * then rendered as text onto PDF pages.
 */
export async function generatePdf(options: PdfGenOptions): Promise<Buffer> {
  const { title, markdown, signerName, status, authorName, approvedAt } = options;
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4 width
  const pageHeight = 841.89; // A4 height
  const marginX = 50;
  const marginY = 60;
  const contentWidth = pageWidth - marginX * 2;

  let page = doc.addPage([pageWidth, pageHeight]);
  let yPos = pageHeight - marginY;

  // --- HEADER ---
  const brandColor = hexToRgb(config.brand.primaryColor);
  page.drawRectangle({
    x: 0,
    y: pageHeight - 40,
    width: pageWidth,
    height: 40,
    color: rgb(brandColor.r, brandColor.g, brandColor.b),
  });

  page.drawText(config.brand.name, {
    x: marginX,
    y: pageHeight - 28,
    size: 12,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  page.drawText(`Generated: ${new Date().toISOString().split("T")[0]}`, {
    x: pageWidth - marginX - 140,
    y: pageHeight - 28,
    size: 10,
    font: fontRegular,
    color: rgb(1, 1, 1),
  });

  yPos = pageHeight - 80;

  // --- DOCUMENT TITLE ---
  const titleLines = wrapText(title, fontBold, 18, contentWidth);
  for (const line of titleLines) {
    page.drawText(line, {
      x: marginX,
      y: yPos,
      size: 18,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.15),
    });
    yPos -= 24;
  }
  yPos -= 10;

  // --- SEPARATOR ---
  page.drawLine({
    start: { x: marginX, y: yPos },
    end: { x: pageWidth - marginX, y: yPos },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  yPos -= 20;

  // --- BODY CONTENT ---
  const tokens = md.parse(markdown, {});
  for (const token of tokens) {
    if (yPos < marginY + 120) {
      // Not enough space for signature block, add new page
      page = doc.addPage([pageWidth, pageHeight]);
      yPos = pageHeight - marginY;
    }

    if (token.type === "heading_open") {
      const level = parseInt(token.tag.replace("h", ""), 10);
      // Next token is the heading content
      continue;
    }

    if (token.type === "inline" && token.level === 0) {
      // Check parent to determine heading level
      const parentIdx = tokens.indexOf(token) - 1;
      const parent = parentIdx >= 0 ? tokens[parentIdx] : null;
      const isHeading = parent?.type === "heading_open";
      const headingLevel = isHeading
        ? parseInt(parent.tag.replace("h", ""), 10)
        : 0;

      let fontSize = 11;
      let lineFont = fontRegular;
      if (headingLevel === 1) { fontSize = 16; lineFont = fontBold; }
      else if (headingLevel === 2) { fontSize = 14; lineFont = fontBold; }
      else if (headingLevel === 3) { fontSize = 12; lineFont = fontBold; }
      else if (headingLevel >= 4) { fontSize = 11; lineFont = fontBold; }

      const text = stripMentions(token.content);
      const lines = wrapText(text, lineFont, fontSize, contentWidth);
      for (const line of lines) {
        if (yPos < marginY + 20) {
          page = doc.addPage([pageWidth, pageHeight]);
          yPos = pageHeight - marginY;
        }
        page.drawText(line, {
          x: marginX,
          y: yPos,
          size: fontSize,
          font: lineFont,
          color: rgb(0.15, 0.15, 0.15),
        });
        yPos -= fontSize + 6;
      }
      if (!isHeading) yPos -= 4;
    } else if (token.type === "paragraph_close") {
      yPos -= 6;
    } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      yPos -= 2;
    }
  }

  // --- SIGNATURE BLOCK ---
  // Ensure enough space for the signature block
  if (yPos < marginY + 120) {
    page = doc.addPage([pageWidth, pageHeight]);
    yPos = pageHeight - marginY;
  }

  yPos -= 20;
  page.drawLine({
    start: { x: marginX, y: yPos },
    end: { x: pageWidth - marginX, y: yPos },
    thickness: 1,
    color: rgb(0.6, 0.6, 0.6),
  });
  yPos -= 20;

  page.drawText("DOCUMENT APPROVAL", {
    x: marginX,
    y: yPos,
    size: 12,
    font: fontBold,
    color: rgb(0.3, 0.3, 0.3),
  });
  yPos -= 20;

  page.drawText(`Requested by: ${authorName}`, {
    x: marginX,
    y: yPos,
    size: 10,
    font: fontRegular,
    color: rgb(0.3, 0.3, 0.3),
  });
  yPos -= 16;

  page.drawText(`Signer: ${signerName}`, {
    x: marginX,
    y: yPos,
    size: 10,
    font: fontRegular,
    color: rgb(0.3, 0.3, 0.3),
  });
  yPos -= 16;

  // Status with color
  const statusColor =
    status === "APPROVED"
      ? rgb(0.1, 0.6, 0.1)
      : status === "REJECTED"
        ? rgb(0.8, 0.1, 0.1)
        : rgb(0.8, 0.6, 0);

  page.drawText(`Status: ${status}`, {
    x: marginX,
    y: yPos,
    size: 11,
    font: fontBold,
    color: statusColor,
  });
  yPos -= 16;

  const timestampText = approvedAt || new Date().toISOString();
  page.drawText(`Date: ${timestampText}`, {
    x: marginX,
    y: yPos,
    size: 10,
    font: fontRegular,
    color: rgb(0.3, 0.3, 0.3),
  });

  // --- FOOTER ON EVERY PAGE ---
  const totalPages = doc.getPageCount();
  for (let i = 0; i < totalPages; i++) {
    const p = doc.getPage(i);
    p.drawText(`Page ${i + 1} of ${totalPages}`, {
      x: pageWidth / 2 - 30,
      y: 25,
      size: 8,
      font: fontRegular,
      color: rgb(0.6, 0.6, 0.6),
    });
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Compute SHA-256 hash of a PDF buffer.
 */
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

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function stripMentions(text: string): string {
  // Replace @[Name](mention://...) with @Name
  return text.replace(
    /@\[([^\]]+)\]\(mention:\/\/[^)]+\)/g,
    "@$1"
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return { r, g, b };
}
