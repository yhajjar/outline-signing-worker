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

async function outlinePost<T>(endpoint: string, body: object): Promise<T> {
  const url = `${config.outline.url}/api/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.outline.apiKey}`,
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

  const res = await fetch(fullUrl, {
    method: "POST",
    body: formObj as unknown as Buffer,
    headers: formObj.getHeaders(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`File upload failed (${res.status}): ${body}`);
  }
}
