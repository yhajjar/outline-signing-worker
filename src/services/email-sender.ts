import nodemailer from "nodemailer";
import { config } from "../config";
import { SigningRequest } from "./db";

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

export interface SignRequestEmailData {
  to: string;
  signerName: string;
  documentTitle: string;
  authorName: string;
  approveUrl: string;
  rejectUrl: string;
  pdfBuffer: Buffer;
  documentUrl: string;
}

export async function sendSigningRequest(data: SignRequestEmailData): Promise<void> {
  const { to, signerName, documentTitle, authorName, approveUrl, rejectUrl, pdfBuffer, documentUrl } = data;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Document Approval Request</h2>
      <p>Hello ${signerName},</p>
      <p>You have been requested to review and approve a document:</p>
      <table style="margin: 16px 0; padding: 12px; background: #f8f9fa; border-radius: 4px;">
        <tr><td style="padding: 4px 12px;"><strong>Document:</strong></td><td>${documentTitle}</td></tr>
        <tr><td style="padding: 4px 12px;"><strong>Requested by:</strong></td><td>${authorName}</td></tr>
      </table>
      <p style="margin: 20px 0;">
        <a href="${documentUrl}" style="color: ${config.brand.primaryColor};">View in Outline</a>
      </p>
      <p>Please review the attached PDF and choose one of the following:</p>
      <div style="margin: 24px 0; text-align: center;">
        <a href="${approveUrl}"
           style="background: #28a745; color: white; padding: 12px 32px; text-decoration: none; border-radius: 4px; margin: 0 8px; font-weight: bold;">
          Approve Document
        </a>
        <a href="${rejectUrl}"
           style="background: #dc3545; color: white; padding: 12px 32px; text-decoration: none; border-radius: 4px; margin: 0 8px; font-weight: bold;">
          Reject Document
        </a>
      </div>
      <p style="color: #666; font-size: 12px;">
        This link expires in ${config.jwt.expiresHours} hours.
        <br>If the buttons don't work, copy and paste the URL into your browser.
      </p>
    </div>
  `;

  const safeTitle = documentTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);

  await transporter.sendMail({
    from: config.smtp.from,
    to,
    subject: `[Action Required] Document Approval: ${documentTitle}`,
    html,
    attachments: [
      {
        filename: `pending_${safeTitle}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });
}

export async function sendApprovalConfirmation(data: {
  authorEmail: string;
  authorName: string;
  signerName: string;
  documentTitle: string;
  documentUrl: string;
  pdfBuffer: Buffer;
}): Promise<void> {
  const { authorEmail, authorName, signerName, documentTitle, documentUrl, pdfBuffer } = data;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #28a745;">Document Approved</h2>
      <p>Hello ${authorName},</p>
      <p><strong>${signerName}</strong> has approved document <strong>${documentTitle}</strong>.</p>
      <p>The signed PDF has been archived to the document.</p>
      <p>
        <a href="${documentUrl}" style="background: ${config.brand.primaryColor}; color: white; padding: 10px 24px; text-decoration: none; border-radius: 4px;">
          View in Outline
        </a>
      </p>
    </div>
  `;

  const safeTitle = documentTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);

  await transporter.sendMail({
    from: config.smtp.from,
    to: authorEmail,
    subject: `[Approved] ${signerName} signed: ${documentTitle}`,
    html,
    attachments: [
      {
        filename: `signed_${safeTitle}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });
}

export async function sendRejectionNotice(data: {
  authorEmail: string;
  authorName: string;
  signerName: string;
  documentTitle: string;
  documentUrl: string;
  reason?: string;
}): Promise<void> {
  const { authorEmail, authorName, signerName, documentTitle, documentUrl, reason } = data;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc3545;">Document Rejected</h2>
      <p>Hello ${authorName},</p>
      <p><strong>${signerName}</strong> has rejected document <strong>${documentTitle}</strong>.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
      <p>
        <a href="${documentUrl}" style="background: ${config.brand.primaryColor}; color: white; padding: 10px 24px; text-decoration: none; border-radius: 4px;">
          View in Outline
        </a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: config.smtp.from,
    to: authorEmail,
    subject: `[Rejected] ${signerName} rejected: ${documentTitle}`,
    html,
  });
}

export async function sendApprovedCopyToSigner(data: {
  signerEmail: string;
  signerName: string;
  documentTitle: string;
  authorName: string;
  pdfBuffer: Buffer;
  documentUrl: string;
}): Promise<void> {
  const { signerEmail, signerName, documentTitle, authorName, pdfBuffer, documentUrl } = data;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #28a745;">Document Approved - Copy</h2>
      <p>Hello ${signerName},</p>
      <p>You have approved document <strong>${documentTitle}</strong> requested by <strong>${authorName}</strong>.</p>
      <p>Please find the signed copy attached.</p>
      <p>
        <a href="${documentUrl}" style="color: ${config.brand.primaryColor};">View in Outline</a>
      </p>
    </div>
  `;

  const safeTitle = documentTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);

  await transporter.sendMail({
    from: config.smtp.from,
    to: signerEmail,
    subject: `[Signed Copy] ${documentTitle}`,
    html,
    attachments: [
      {
        filename: `signed_${safeTitle}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });
}
