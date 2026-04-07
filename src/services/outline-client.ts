import fetch from "node-fetch";
import FormData from "form-data";
import { config } from "../config";

interface OutlineResponse<T> {
  data: T;
  error?: { message: string; status: number };
}

interface DocumentData {
  id: string;
  title: string;
  text: string;
  url: string;
}

interface UserData {
  id: string;
  name: string;
  email: string;
}

interface AttachmentCreateResult {
  uploadUrl: string;
  form: Record<string, string>;
  attachment: { id: string; url: string; [key: string]: unknown };
}

async function outlinePost<T>(endpoint: string, body: object, token?: string): Promise<T> {
  const url = `${config.outline.url}/api/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token || config.outline.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as OutlineResponse<T>;

  if (!res.ok || json.error) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    throw new Error(`Outline API ${endpoint} failed: ${msg}`);
  }

  return json.data;
}

export async function getDocument(documentId: string): Promise<DocumentData> {
  return outlinePost<DocumentData>("documents.info", { id: documentId });
}

export async function getUser(userId: string): Promise<UserData> {
  return outlinePost<UserData>("users.info", { id: userId });
}

export async function updateDocument(
  documentId: string,
  text: string,
  options?: { title?: string }
): Promise<DocumentData> {
  return outlinePost<DocumentData>("documents.update", {
    id: documentId,
    text,
    ...options,
  });
}

export async function createAttachment(
  name: string,
  documentId: string,
  contentType: string,
  size: number
): Promise<AttachmentCreateResult> {
  return outlinePost<AttachmentCreateResult>("attachments.create", {
    name,
    documentId,
    contentType,
    size,
    preset: "documentAttachment",
  });
}

export async function uploadAttachment(
  uploadUrl: string,
  form: Record<string, string>,
  fileBuffer: Buffer,
  fileName: string
): Promise<void> {
  const formObj = new FormData();

  for (const [key, value] of Object.entries(form)) {
    formObj.append(key, value);
  }
  formObj.append("file", fileBuffer, { filename: fileName });

  const fullUrl = uploadUrl.startsWith("http")
    ? uploadUrl
    : `${config.outline.url}${uploadUrl}`;

  const headers: Record<string, string> = {
    ...formObj.getHeaders(),
  };

  // If uploading to Outline's own API, add auth
  if (fullUrl.startsWith(config.outline.url)) {
    headers["Authorization"] = `Bearer ${config.outline.apiKey}`;
  }

  const res = await fetch(fullUrl, {
    method: "POST",
    body: formObj as unknown as Buffer,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`File upload failed (${res.status}): ${body}`);
  }
}

interface CommentData {
  id: string;
}

/**
 * Create a comment on an Outline document using the bot token.
 * Sends ProseMirror JSON data since the text field is not supported
 * for programmatic API usage.
 */
export async function createComment(
  documentId: string,
  text: string,
  parentCommentId?: string
): Promise<CommentData> {
  // Build minimal ProseMirror JSON: a single paragraph with the text
  const data = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };

  const body: Record<string, unknown> = { documentId, data };
  if (parentCommentId) {
    body.parentCommentId = parentCommentId;
  }
  return outlinePost<CommentData>("comments.create", body, config.outline.botToken);
}
