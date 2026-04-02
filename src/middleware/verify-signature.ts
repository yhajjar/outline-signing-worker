import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "../config";

/**
 * Express middleware to verify Outline webhook HMAC-SHA256 signatures.
 *
 * Outline sends the header: `Outline-Signature: t=<timestamp>,s=<hmac-hex>`
 * The signature is computed as: HMAC-SHA256(secret, `${timestamp}.${payload}`)
 */
export function verifyWebhookSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!config.webhook.secret) {
    // No secret configured, skip verification
    next();
    return;
  }

  const sigHeader = req.headers["outline-signature"] as string;
  if (!sigHeader) {
    res.status(401).json({ error: "Missing Outline-Signature header" });
    return;
  }

  // Parse header: "t=1234567890,s=abcdef..."
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      parts[part.substring(0, eqIdx)] = part.substring(eqIdx + 1);
    }
  }

  const timestamp = parts["t"];
  const signature = parts["s"];

  if (!timestamp || !signature) {
    res.status(401).json({ error: "Invalid signature format" });
    return;
  }

  // Verify timestamp is not too old (5 minute tolerance)
  const now = Date.now();
  const sigTime = parseInt(timestamp, 10);
  if (Math.abs(now - sigTime) > 5 * 60 * 1000) {
    res.status(401).json({ error: "Signature timestamp expired" });
    return;
  }

  // Compute expected signature
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const expectedSig = crypto
    .createHmac("sha256", config.webhook.secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  // Constant-time comparison
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  } catch {
    res.status(401).json({ error: "Invalid signature format" });
    return;
  }

  next();
}
