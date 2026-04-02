import jwt from "jsonwebtoken";
import { config } from "../config";

export interface ApprovalToken {
  signingRequestId: string;
  documentId: string;
  signerUserId: string;
  authorUserId: string;
}

/**
 * Create a JWT approval token.
 */
export function createApprovalToken(payload: ApprovalToken): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: `${config.jwt.expiresHours}h`,
  });
}

/**
 * Verify and decode a JWT approval token.
 * Returns null if invalid or expired.
 */
export function verifyApprovalToken(token: string): ApprovalToken | null {
  try {
    return jwt.verify(token, config.jwt.secret) as ApprovalToken;
  } catch {
    return null;
  }
}
