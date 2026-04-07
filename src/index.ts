import express from "express";
import { config } from "./config";
import { initDb, expireOldRequests, findExpiredUnnotified, markExpiryNotified } from "./services/db";
import * as outline from "./services/outline-client";
import { verifyWebhookSignature } from "./middleware/verify-signature";
import webhookRouter from "./routes/webhook";
import approvalRouter from "./routes/approval";
import healthRouter from "./routes/health";
import pino from "pino";

const log = pino();

const app = express();

// Parse raw body for webhook signature verification, then JSON
app.use("/webhook", express.raw({ type: "*/*", limit: "10mb" }));
app.use("/webhook", (req, _res, next) => {
  // Convert raw body back to JSON for route handlers
  if (Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString("utf-8"));
    } catch {
      // Will be caught by route handlers
    }
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/webhook", verifyWebhookSignature, webhookRouter);
app.use("/", approvalRouter);
app.use("/", healthRouter);

// Initialize database
initDb();
log.info("Database initialized");

// Periodic cleanup: expire old requests and notify via comments
setInterval(async () => {
  const expired = expireOldRequests();
  if (expired > 0) {
    log.info({ expired }, "Expired old signing requests");
  }

  // Post expiry notification comments for newly expired requests
  const unnotified = findExpiredUnnotified();
  for (const req of unnotified) {
    try {
      await outline.createComment(
        req.document_id,
        "\u23F0 Signature request expired without response",
        req.trigger_comment_id!
      );
      markExpiryNotified(req.id);
      log.info({ requestId: req.id }, "Expiry notification posted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, requestId: req.id }, "Failed to post expiry notification");
    }
  }
}, 60 * 60 * 1000);

// Start server
app.listen(config.port, () => {
  log.info(
    { port: config.port, workerUrl: config.worker.url },
    "Outline Signing Worker started"
  );
});

export default app;
