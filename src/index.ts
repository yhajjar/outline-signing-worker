import express from "express";
import { config } from "./config";
import { initDb, expireOldRequests } from "./services/db";
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

// Periodic cleanup: expire old requests every hour
setInterval(() => {
  const expired = expireOldRequests();
  if (expired > 0) {
    log.info({ expired }, "Expired old signing requests");
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
