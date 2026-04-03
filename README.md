# Outline Document Signing Worker

A Node.js integration worker that enables document approval/signing workflows inside a self-hosted [Outline](https://github.com/outline/outline) wiki. No external e-signature platforms (DocuSign, Documenso, etc.) are used.

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│  Author types /sign @UserName in an Outline document and saves it   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               │  Outline fires documents.update webhook
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Signing Worker receives webhook                                     │
│  1. Verifies HMAC-SHA256 signature                                   │
│  2. Parses /sign @mention from markdown                              │
│  3. Resolves signer email via Outline API                            │
│  4. Generates branded PDF from document                              │
│  5. Stores request in SQLite                                         │
│  6. Emails signer with PDF attachment + Approve/Reject links         │
│  7. Updates Outline document with "Awaiting Approval" status         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                  ┌────────────┴────────────┐
                  │                         │
                  ▼                         ▼
┌─────────────────────────┐  ┌─────────────────────────┐
│  Signer clicks APPROVE  │  │  Signer clicks REJECT   │
│  1. Regenerates PDF     │  │  1. Updates doc status   │
│     with APPROVED stamp │  │  2. Notifies author     │
│  2. Archives PDF to     │  │  3. Returns HTML page   │
│     Outline attachment  │  └─────────────────────────┘
│  3. Emails signed copy  │
│     to signer + author  │
│  4. Returns HTML page   │
└─────────────────────────┘
```

## Usage

In any Outline document, type:

```
/sign @[Yasser Hajjar](mention://9a17c1c8-d178-4350-9001-203a73070fcb/user/abc-123-def)
```

The `@mention` part is handled by Outline's native mention autocomplete — just type `/sign ` followed by `@` and select the user.

For multiple signers, use one line per signer:

```
/sign @[Yasser Hajjar](mention://uuid/user/user-id-1)
/sign @[Sara Ali](mention://uuid/user/user-id-2)
```

## Architecture

```
src/
  index.ts                        # Express server entry point
  config.ts                       # Environment variable loading & validation
  routes/
    webhook.ts                    # POST /webhook/outline — receives Outline webhooks
    approval.ts                   # GET /approve/:token — approval handler
    approval.ts                   # GET /reject/:token — rejection handler
    health.ts                     # GET /health — health check
  services/
    outline-client.ts             # Outline API wrapper (documents, users, attachments)
    mention-parser.ts             # Parses /sign @mention commands from markdown
    pdf-generator.ts              # Markdown → branded PDF (markdown-it + pdf-lib)
    email-sender.ts               # Nodemailer email dispatch with HTML templates
    db.ts                         # SQLite database init + schema + queries
  middleware/
    verify-signature.ts           # HMAC-SHA256 webhook signature verification
  utils/
    jwt.ts                        # JWT creation & verification for approval links
```

**Key design decisions:**
- **No Puppeteer** — uses `markdown-it` + `pdf-lib` for PDF generation, keeping the Docker image under 200MB
- **SQLite** — lightweight state tracking, no external database needed
- **JWT approval links** — no login required from signers, links expire after 72 hours
- **Idempotent** — duplicate webhooks are detected and skipped

## Stack

| Component | Technology |
|---|---|
| Server | Express.js |
| Database | SQLite via better-sqlite3 |
| PDF Generation | markdown-it + pdf-lib |
| Email | Nodemailer |
| Auth tokens | JWT (jsonwebtoken) |
| Logging | Pino |
| API client | node-fetch |

## Prerequisites

- **Self-hosted Outline wiki** (already deployed at `https://outline-pdf.myapps.mylabs.click`)
- **Coolify** v4.0.0-beta.442 (running on this VPS)
- **Corporate SMTP** credentials for sending emails
- **Domain** for the worker (e.g. `sign.myapps.mylabs.click`)
- **GitHub** repository: `yhajjar/outline-signing-worker`

---

## Deployment Guide: Coolify

This guide covers deploying the signing worker alongside your existing Outline instance on a Coolify-managed VPS.

### Step 1: Create an Outline API Key

The worker needs an Outline API key to read documents, resolve user info, and upload attachments.

1. Log into Outline at `https://outline-pdf.myapps.mylabs.click`
2. Go to **Settings** → **API Keys**
3. Click **New API Key**
4. Name it: `Signing Worker`
5. The key **must belong to an admin user** — this is required to read user emails via the `users.info` endpoint
6. Copy the key value (it starts with `ol_api_`)
7. Save it — you'll need it for the environment variables

### Step 2: Create the Coolify Application

1. Log into **Coolify** at `https://<your-coolify-url>:8000`
2. Navigate to your **Project** (e.g. `my-apps`)
3. Click **Add New Resource** → **Application**
4. Configure:
   - **Name**: `outline-signing-worker`
   - **Source**: GitHub → select `yhajjar/outline-signing-worker`
   - **Branch**: `master`
   - **Build Pack**: Dockerfile (auto-detected from the repo)

### Step 3: Configure the Domain

1. In the Coolify application settings, go to **Domains**
2. Enter your worker domain: `sign.myapps.mylabs.click`
3. Coolify automatically configures:
   - Traefik reverse proxy routing
   - Let's Encrypt SSL certificate
   - HTTP → HTTPS redirect
   - Gzip compression

   The Traefik labels will be applied automatically (same pattern as your existing Outline app):
   ```
   traefik.enable=true
   traefik.http.routers.https-0-<uuid>-worker.rule=Host(`sign.myapps.mylabs.click`)
   traefik.http.routers.https-0-<uuid>-worker.tls=true
   traefik.http.routers.https-0-<uuid>-worker.tls.certresolver=letsencrypt
   ```

### Step 4: Configure Port

1. In Coolify → **Configuration** → **Ports**
2. Set the container port to **3100**
3. Coolify maps this through Traefik automatically (no manual host port mapping needed)

### Step 5: Add Persistent Volume

The SQLite database must persist across container restarts and deployments.

1. In Coolify → **Volumes** → **Add Volume**
2. **Container Path**: `/data`
3. Coolify will create a named volume or bind mount on the host
4. The SQLite database will be at `/data/signing-worker.db` inside the container

### Step 6: Configure Environment Variables

In Coolify → **Environment**, add the following variables. Replace the placeholder values with your actual credentials.

#### Outline Connection

```env
OUTLINE_URL=https://outline-pdf.myapps.mylabs.click
OUTLINE_API_KEY=ol_api_YOUR_API_KEY_HERE
```

#### Webhook Security

Generate a webhook secret:
```bash
openssl rand -hex 24
```

```env
WEBHOOK_SECRET=<paste the generated secret>
```

#### Worker Configuration

Generate a JWT secret:
```bash
openssl rand -hex 32
```

```env
PORT=3100
WORKER_URL=https://sign.myapps.mylabs.click
JWT_SECRET=<paste the 64-char hex string>
JWT_EXPIRES_HOURS=72
```

#### Database

```env
SQLITE_PATH=/data/signing-worker.db
```

#### Email (Corporate SMTP)

```env
SMTP_HOST=mail.yourcompany.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@yourcompany.com
SMTP_PASS=your_smtp_password
EMAIL_FROM="Document Approvals <noreply@yourcompany.com>"
```

#### PDF Branding

```env
BRAND_NAME=Your Organization Name
BRAND_LOGO_URL=https://outline-pdf.myapps.mylabs.click/logo.png
BRAND_PRIMARY_COLOR=#1a73e8
```

### Step 7: Deploy

1. Click **Deploy** in Coolify
2. Coolify will:
   - Pull the latest code from GitHub
   - Build the Dockerfile (`node:20-slim` + TypeScript compilation)
   - Start the container
   - Register the domain with Traefik
   - Provision the SSL certificate
3. Watch the deployment logs for any errors
4. When the container shows **Running**, proceed to verification

### Step 8: Verify Health

```bash
curl https://sign.myapps.mylabs.click/health
```

Expected response:
```json
{"status":"ok","timestamp":"2026-04-03T12:00:00.000Z"}
```

### Step 9: Register the Webhook in Outline

Use the Outline API to create the webhook subscription. Replace the placeholder values with your actual API key and webhook secret.

```bash
curl -X POST https://outline-pdf.myapps.mylabs.click/api/webhookSubscriptions.create \
  -H "Authorization: Bearer ol_api_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Document Signing Worker",
    "url": "https://sign.myapps.mylabs.click/webhook/outline",
    "secret": "YOUR_WEBHOOK_SECRET",
    "events": ["documents.update"]
  }'
```

Expected response:
```json
{
  "data": {
    "id": "webhook-subscription-uuid",
    "name": "Document Signing Worker",
    "url": "https://sign.myapps.mylabs.click/webhook/outline",
    "events": ["documents.update"],
    "enabled": true
  }
}
```

### Step 10: Test the Full Flow

1. **Create a test document** in Outline
2. **Type the signing command**: `/sign ` then `@` and select a user from the autocomplete
3. **Save** the document
4. **Check the worker logs** in Coolify:
   ```
   Coolify → outline-signing-worker → Logs
   ```
   Look for:
   ```
   INFO: Processing document update
   INFO: Found signing requests
   INFO: Resolved signer (signerName=..., signerEmail=...)
   INFO: Signing request email sent
   INFO: Document updated with status block
   ```
5. **Check your email** — the signer should receive an email with:
   - A PDF attachment of the document
   - An **Approve Document** button (green)
   - A **Reject Document** button (red)
6. **Click Approve** — verify:
   - HTML confirmation page appears ("Document Approved")
   - Signed PDF is archived as an attachment in the Outline document
   - The author receives a confirmation email with the signed PDF
   - The signer receives a copy of the signed PDF
7. **Test rejection** similarly — create a new document, sign, click Reject, verify author is notified

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `OUTLINE_URL` | Yes | — | Base URL of your Outline wiki |
| `OUTLINE_API_KEY` | Yes | — | Outline API key (admin user, starts with `ol_api_`) |
| `WEBHOOK_SECRET` | No | — | Secret for HMAC-SHA256 webhook verification (set in Outline webhook config) |
| `PORT` | No | `3100` | HTTP port the worker listens on |
| `WORKER_URL` | Yes | — | Public URL of this worker (used for approval/reject links in emails) |
| `JWT_SECRET` | Yes | — | Secret for signing approval JWT tokens (generate with `openssl rand -hex 32`) |
| `JWT_EXPIRES_HOURS` | No | `72` | Hours before approval links expire |
| `SQLITE_PATH` | No | `./data/signing-worker.db` | Path to SQLite database file (use `/data/` inside Docker for persistence) |
| `SMTP_HOST` | Yes | — | SMTP server hostname |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `SMTP_SECURE` | No | `false` | Use TLS for SMTP |
| `SMTP_USER` | Yes | — | SMTP username |
| `SMTP_PASS` | Yes | — | SMTP password |
| `EMAIL_FROM` | No | `"Document Approvals"` | From name and address for outgoing emails |
| `BRAND_NAME` | No | `My Organization` | Organization name shown in PDF header |
| `BRAND_LOGO_URL` | No | — | URL to logo image for PDF header |
| `BRAND_PRIMARY_COLOR` | No | `#1a73e8` | Primary brand color for PDF header bar |

---

## SQLite Schema

```sql
CREATE TABLE signing_requests (
  id TEXT PRIMARY KEY,                -- UUID
  document_id TEXT NOT NULL,          -- Outline document UUID
  document_title TEXT NOT NULL,
  document_text TEXT NOT NULL,         -- Markdown snapshot at request time
  author_user_id TEXT NOT NULL,        -- Outline user who authored/saved the document
  signer_user_id TEXT NOT NULL,        -- Outline user who should sign
  signer_email TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  webhook_delivery_id TEXT UNIQUE,     -- Outline delivery ID (idempotency key)
  pdf_hash TEXT,                       -- SHA-256 of the generated PDF
  attachment_id TEXT,                  -- Outline attachment ID after upload
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  expires_at TEXT NOT NULL
);
```

---

## Outline Webhook Payload

The worker expects webhook deliveries in this format (Outline's standard format):

```json
{
  "id": "delivery-uuid",
  "actorId": "user-uuid-who-triggered-event",
  "event": "documents.update",
  "payload": {
    "id": "document-uuid",
    "model": {
      "id": "document-uuid",
      "title": "Document Title",
      "text": "markdown content with /sign @mention...",
      "url": "/doc/slug-uuid"
    }
  }
}
```

The `Outline-Signature` header contains: `t=<timestamp>,s=<hmac-sha256-hex>`

---

## Troubleshooting

### Webhook not received
- Verify the webhook URL is correct in Outline: `https://sign.myapps.mylabs.click/webhook/outline`
- Check Traefik routing: the domain `sign.myapps.mylabs.click` must point to this VPS
- Check Coolify deployment logs for startup errors
- Verify the container is running and healthy: `curl https://sign.myapps.mylabs.click/health`

### Email not sent
- Check SMTP credentials in environment variables
- Look for SMTP errors in the worker logs
- Test SMTP connectivity from the container:
  ```bash
  docker exec -it <container> node -e "
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({host:'SMTP_HOST',port:587,auth:{user:'SMTP_USER',pass:'SMTP_PASS'}});
    t.verify().then(() => console.log('SMTP OK')).catch(e => console.error(e));
  "
  ```

### User email not resolved
- The API key must belong to an **admin user** in Outline
- Non-admin API keys cannot read user emails via `users.info`
- Verify: `curl -X POST https://outline-pdf.myapps.mylabs.click/api/users.info -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"id":"some-user-id"}'`

### Attachment upload fails
- Check Outline's `FILE_STORAGE` setting — if `local`, uploads go to `/api/files.create`
- If `s3`, uploads go to the configured S3-compatible endpoint
- Check the worker logs for the upload response status

### JWT expired / invalid token
- Approval links expire after 72 hours by default (`JWT_EXPIRES_HOURS`)
- Generate a new signing request by editing the Outline document again
- Ensure `JWT_SECRET` matches across container restarts

### Duplicate signing requests
- The worker is idempotent — if a pending request already exists for a document + signer, it is skipped
- Clear stale requests by waiting for expiry or manually updating the SQLite database

---

## Local Development

```bash
# Clone the repo
git clone https://github.com/yhajjar/outline-signing-worker.git
cd outline-signing-worker

# Install dependencies
npm install

# Create .env from example
cp .env.example .env
# Edit .env with your values

# Build and run
npm run build
npm start
```

---

## License

MIT
