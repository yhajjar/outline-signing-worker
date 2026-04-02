import { Router, Request, Response } from "express";
import crypto from "crypto";
import { parseSignCommands } from "../services/mention-parser";
import {
  createSigningRequest,
  findPendingRequest,
  findByDeliveryId,
} from "../services/db";
import * as outline from "../services/outline-client";
import { generatePdf, hashPdf } from "../services/pdf-generator";
import { sendSigningRequest } from "../services/email-sender";
import { createApprovalToken } from "../utils/jwt";
import { config } from "../config";
import pino from "pino";

const log = pino();
const router = Router();

interface WebhookPayload {
  id: string;
  actorId: string;
  event: string;
  payload: {
    id: string;
    model: {
      id: string;
      title: string;
      text: string;
      url: string;
    };
  };
}

router.post("/outline", async (req: Request, res: Response) => {
  // Always acknowledge immediately
  res.status(200).send("OK");

  const body = req.body as WebhookPayload;

  if (body.event !== "documents.update") {
    log.info({ event: body.event }, "Ignoring non-update event");
    return;
  }

  const documentId = body.payload?.id;
  const actorId = body.actorId;
  const markdown = body.payload?.model?.text;
  const title = body.payload?.model?.title || "Untitled";

  if (!documentId || !actorId || !markdown) {
    log.warn({ body }, "Incomplete webhook payload");
    return;
  }

  log.info({ documentId, actorId }, "Processing document update");

  try {
    // Parse /sign @mention commands
    const result = parseSignCommands(markdown);
    if (!result.found) {
      log.info({ documentId }, "No /sign commands found");
      return;
    }

    log.info(
      { documentId, signerCount: result.signers.length },
      "Found signing requests"
    );

    // Check idempotency via delivery ID
    if (body.id) {
      const existing = findByDeliveryId(body.id);
      if (existing) {
        log.info({ deliveryId: body.id }, "Already processed this delivery");
        return;
      }
    }

    // Fetch author info
    const author = await outline.getUser(actorId);
    log.info({ authorName: author.name }, "Resolved author");

    for (const signer of result.signers) {
      // Check if there's already a pending request for this doc+signer
      const existing = findPendingRequest(documentId, signer.userId);
      if (existing) {
        log.info(
          { documentId, signerUserId: signer.userId },
          "Pending request already exists, skipping"
        );
        continue;
      }

      // Fetch signer user info (email)
      const signerUser = await outline.getUser(signer.userId);
      log.info(
        { signerName: signerUser.name, signerEmail: signerUser.email },
        "Resolved signer"
      );

      const requestId = crypto.randomUUID();
      const expiresAt = new Date(
        Date.now() + config.jwt.expiresHours * 60 * 60 * 1000
      ).toISOString();

      // Create signing request in database
      createSigningRequest({
        id: requestId,
        document_id: documentId,
        document_title: title,
        document_text: result.cleanMarkdown,
        author_user_id: actorId,
        signer_user_id: signer.userId,
        signer_email: signerUser.email,
        signer_name: signerUser.name,
        status: "pending",
        webhook_delivery_id: body.id || null,
        expires_at: expiresAt,
      });

      // Generate pending PDF
      const pdfBuffer = await generatePdf({
        title,
        markdown: result.cleanMarkdown,
        signerName: signerUser.name,
        status: "PENDING",
        authorName: author.name,
      });

      // Create JWT approval token
      const token = createApprovalToken({
        signingRequestId: requestId,
        documentId,
        signerUserId: signer.userId,
        authorUserId: actorId,
      });

      const approveUrl = `${config.worker.url}/approve/${token}`;
      const rejectUrl = `${config.worker.url}/reject/${token}`;
      const documentUrl = `${config.outline.url}${body.payload.model.url}`;

      // Send signing request email
      await sendSigningRequest({
        to: signerUser.email,
        signerName: signerUser.name,
        documentTitle: title,
        authorName: author.name,
        approveUrl,
        rejectUrl,
        pdfBuffer,
        documentUrl,
      });

      log.info(
        { requestId, signerEmail: signerUser.email },
        "Signing request email sent"
      );
    }

    // Update Outline document: remove /sign commands, add status block
    const signerNames = result.signers.map((s) => s.displayName).join(", ");
    const statusBlock = `\n\n---\n> **Awaiting Approval** from ${signerNames}\n> Status: Pending\n> Requested: ${new Date().toISOString().split("T")[0]}`;

    await outline.updateDocument(documentId, result.cleanMarkdown + statusBlock);

    log.info({ documentId }, "Document updated with status block");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, documentId }, "Error processing webhook");
  }
});

export default router;
