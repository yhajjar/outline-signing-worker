import { Router, Request, Response } from "express";
import crypto from "crypto";
import { parseSignCommandsFromProsemirror, ProsemirrorDoc } from "../services/mention-parser";
import {
  createSigningRequest,
  findPendingRequest,
  findByCommentId,
} from "../services/db";
import * as outline from "../services/outline-client";
import { generatePdf } from "../services/pdf-generator";
import { sendSigningRequest } from "../services/email-sender";
import { createApprovalToken } from "../utils/jwt";
import { config } from "../config";
import pino from "pino";

const log = pino();
const router = Router();

interface CommentWebhookPayload {
  id: string;
  actorId: string;
  event: string;
  payload: {
    id: string;
    model: {
      id: string;
      data: ProsemirrorDoc;
      documentId: string;
      parentCommentId: string | null;
      createdById: string;
    };
  };
}

router.post("/outline", async (req: Request, res: Response) => {
  // Always acknowledge immediately
  res.status(200).send("OK");

  const body = req.body as CommentWebhookPayload;

  // Only handle comments.create events
  if (body.event !== "comments.create") {
    log.info({ event: body.event }, "Ignoring non-comment event");
    return;
  }

  // Prevent self-triggering loops from bot's own reply comments
  if (body.actorId === config.outline.botUserId) {
    log.info({ actorId: body.actorId }, "Ignoring bot's own comment");
    return;
  }

  const commentId = body.payload?.id;
  const commentData = body.payload?.model?.data;
  const documentId = body.payload?.model?.documentId;
  const parentCommentId = body.payload?.model?.parentCommentId;
  const actorId = body.actorId;

  // Only process top-level comments (not threaded replies)
  if (parentCommentId) {
    log.info({ commentId, parentCommentId }, "Ignoring reply comment");
    return;
  }

  if (!commentId || !commentData || !documentId || !actorId) {
    log.warn({ body }, "Incomplete webhook payload");
    return;
  }

  log.info({ commentId, documentId, actorId }, "Processing comment.create");

  try {
    // Parse /sign @mention from ProseMirror JSON
    const result = parseSignCommandsFromProsemirror(commentData);
    if (!result.found) {
      log.info({ commentId }, "No /sign commands found in comment");
      return;
    }

    log.info(
      { commentId, signerCount: result.signers.length },
      "Found signing requests in comment"
    );

    // Idempotency check via trigger comment ID
    const existing = findByCommentId(commentId);
    if (existing) {
      log.info({ commentId }, "Already processed this trigger comment");
      return;
    }

    // Fetch document info
    const document = await outline.getDocument(documentId);
    log.info({ documentTitle: document.title }, "Resolved document");

    // Fetch author info
    const author = await outline.getUser(actorId);
    log.info({ authorName: author.name }, "Resolved author");

    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 5);

    for (const signer of result.signers) {
      // Check if there's already a pending request for this doc+signer
      const pending = findPendingRequest(documentId, signer.userId);
      if (pending) {
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
        document_title: document.title,
        document_text: document.text,
        author_user_id: actorId,
        signer_user_id: signer.userId,
        signer_email: signerUser.email,
        signer_name: signerUser.name,
        status: "pending",
        webhook_delivery_id: body.id || null,
        trigger_comment_id: commentId,
        expires_at: expiresAt,
      });

      // Generate pending PDF
      const pdfBuffer = await generatePdf({
        title: document.title,
        markdown: document.text,
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
      const documentUrl = `${config.outline.url}/doc/${documentId}`;

      // Send signing request email
      await sendSigningRequest({
        to: signerUser.email,
        signerName: signerUser.name,
        documentTitle: document.title,
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

    // Post bot reply confirming registration
    const signerEmails = result.signers
      .map((s) => s.displayName)
      .join(", ");
    const replyText = `\u{1F4CB} Signature request registered \u00B7 \u2709\uFE0F Email sent to ${signerEmails} \u00B7 ${timeStr}`;

    await outline.createComment(documentId, replyText, commentId);

    log.info({ commentId, documentId }, "Bot reply posted");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, commentId }, "Error processing webhook");
  }
});

export default router;
