import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || "3100", 10),
  outline: {
    url: required("OUTLINE_URL").replace(/\/+$/, ""),
    apiKey: required("OUTLINE_API_KEY"),
  },
  webhook: {
    secret: process.env.WEBHOOK_SECRET || "",
  },
  worker: {
    url: required("WORKER_URL").replace(/\/+$/, ""),
  },
  jwt: {
    secret: required("JWT_SECRET"),
    expiresHours: parseInt(process.env.JWT_EXPIRES_HOURS || "72", 10),
  },
  db: {
    path: process.env.SQLITE_PATH || "./data/signing-worker.db",
  },
  smtp: {
    host: required("SMTP_HOST"),
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
    from: process.env.EMAIL_FROM || '"Document Approvals" <noreply@company.com>',
  },
  brand: {
    name: process.env.BRAND_NAME || "My Organization",
    logoUrl: process.env.BRAND_LOGO_URL || "",
    primaryColor: process.env.BRAND_PRIMARY_COLOR || "#1a73e8",
  },
};
