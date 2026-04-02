import { Router, Request, Response } from "express";
import { verifyApprovalToken, ApprovalToken } from "../utils/jwt";
import {
  findRequestById,
  updateRequestStatus,
  SigningRequest,
} from "../services/db";
import * as outline from "../services/outline-client";
import { generatePdf, hashPdf } from "../services/pdf-generator";
import {
  sendApprovalConfirmation,
  sendRejectionNotice,
  sendApprovedCopyToSigner,
} from "../services/email-sender";
import { config } from "../config";
import pino from "pino";

const log = pino();
const router = Router();

function renderResultPage(
  title: string,
  message: string,
  isSuccess: boolean
): string {
  const color = isSuccess ? "#28a745" : "#dc3545";
  return `
    <!DOCTYPE html>
    <html>
    <head><title>${title}</title></head>
    <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 80px;">
      <h1 style="color: ${color};">${title}</h1>
      <p style="color: #333; font-size: 16px;">${message}</p>
      <p style="color: #666; font-size: 12px; margin-top: 40px;">
        ${config.brand.name} Document Approval System
      </p>
    </body>
    </html>
  `;
}

async function resolveSignerAndAuthor(req: SigningRequest) {
  const signer = await outline.getUser(req.signer_user_id);
  const author = await outline.getUser(req.author_user_id);
  return { signer, author };
}

router.get("/approve/:token", async (req: Request<{ token: string }>, res: Response) => {
  const tokenPayload = verifyApprovalToken(req.params.token as string);
  if (!tokenPayload) {
    res.status(400).send(
      renderResultPage(
        "Invalid or Expired Link",
        "This approval link is invalid or has expired. Please request a new one.",
        false
      )
    );
    return;
  }

  const signingReq = findRequestById(tokenPayload.signingRequestId);
  if (!signingReq) {
    res.status(404).send(
      renderResultPage("Not Found", "Signing request not found.", false)
    );
    return;
  }

  if (signingReq.status !== "pending") {
    res.status(200).send(
      renderResultPage(
        "Already Processed",
        `This document has already been ${signingReq.status}.`,
        signingReq.status === "approved"
      )
    );
    return;
  }

  try {
    const { signer, author } = await resolveSignerAndAuthor(signingReq);
    const documentUrl = `${config.outline.url}/doc/${signingReq.document_id}`;

    // Generate approved PDF
    const pdfBuffer = await generatePdf({
      title: signingReq.document_title,
      markdown: signingReq.document_text,
      signerName: signer.name,
      status: "APPROVED",
      authorName: author.name,
      approvedAt: new Date().toISOString(),
    });

    const pdfHash = hashPdf(pdfBuffer);

    // Upload PDF as attachment to Outline
    const attachmentResult = await outline.createAttachment(
      `signed_${signingReq.document_title.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`,
      signingReq.document_id,
      "application/pdf",
      pdfBuffer.length
    );

    await outline.uploadAttachment(
      attachmentResult.uploadUrl,
      attachmentResult.form,
      pdfBuffer,
      `signed_${signingReq.document_title.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`
    );

    // Update signing request
    updateRequestStatus(signingReq.id, "approved", {
      pdf_hash: pdfHash,
      attachment_id: attachmentResult.attachment.id,
    });

    // Update Outline document with approval notice
    const approvedBlock = `\n\n---\n> **Approved** by ${signer.name}\n> Date: ${new Date().toISOString()}\n> Document Hash: \`${pdfHash.substring(0, 16)}...\``;
    await outline.updateDocument(signingReq.document_id, signingReq.document_text + approvedBlock);

    // Send confirmation email to author
    await sendApprovalConfirmation({
      authorEmail: author.email,
      authorName: author.name,
      signerName: signer.name,
      documentTitle: signingReq.document_title,
      documentUrl,
      pdfBuffer,
    });

    // Send signed copy to signer
    await sendApprovedCopyToSigner({
      signerEmail: signer.email,
      signerName: signer.name,
      documentTitle: signingReq.document_title,
      authorName: author.name,
      pdfBuffer,
      documentUrl,
    });

    log.info(
      { requestId: signingReq.id, documentId: signingReq.document_id },
      "Document approved and archived"
    );

    res.status(200).send(
      renderResultPage(
        "Document Approved",
        `You have approved "${signingReq.document_title}". A signed copy has been sent to you and the author.`,
        true
      )
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, requestId: signingReq.id }, "Error processing approval");
    res.status(500).send(
      renderResultPage(
        "Error",
        "An error occurred while processing your approval. Please try again later.",
        false
      )
    );
  }
});

router.get("/reject/:token", async (req: Request<{ token: string }>, res: Response) => {
  const tokenPayload = verifyApprovalToken(req.params.token as string);
  if (!tokenPayload) {
    res.status(400).send(
      renderResultPage(
        "Invalid or Expired Link",
        "This link is invalid or has expired.",
        false
      )
    );
    return;
  }

  const signingReq = findRequestById(tokenPayload.signingRequestId);
  if (!signingReq) {
    res.status(404).send(
      renderResultPage("Not Found", "Signing request not found.", false)
    );
    return;
  }

  if (signingReq.status !== "pending") {
    res.status(200).send(
      renderResultPage(
        "Already Processed",
        `This document has already been ${signingReq.status}.`,
        false
      )
    );
    return;
  }

  try {
    const { signer, author } = await resolveSignerAndAuthor(signingReq);
    const documentUrl = `${config.outline.url}/doc/${signingReq.document_id}`;

    // Update signing request
    updateRequestStatus(signingReq.id, "rejected");

    // Update Outline document with rejection notice
    const rejectedBlock = `\n\n---\n> **Rejected** by ${signer.name}\n> Date: ${new Date().toISOString()}`;
    await outline.updateDocument(signingReq.document_id, signingReq.document_text + rejectedBlock);

    // Notify author
    await sendRejectionNotice({
      authorEmail: author.email,
      authorName: author.name,
      signerName: signer.name,
      documentTitle: signingReq.document_title,
      documentUrl,
    });

    log.info(
      { requestId: signingReq.id, documentId: signingReq.document_id },
      "Document rejected"
    );

    res.status(200).send(
      renderResultPage(
        "Document Rejected",
        `You have rejected "${signingReq.document_title}". The author has been notified.`,
        false
      )
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, requestId: signingReq.id }, "Error processing rejection");
    res.status(500).send(
      renderResultPage(
        "Error",
        "An error occurred while processing your rejection. Please try again later.",
        false
      )
    );
  }
});

export default router;
