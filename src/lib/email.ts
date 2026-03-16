/**
 * Go - Email Module (AgentMail)
 *
 * Provides email capabilities via AgentMail API.
 * Email: aimee@agentmail.to
 *
 * Usage:
 *   import { sendEmail, listEmails, readEmail, replyToEmail } from "./lib/email";
 */

import { AgentMailClient } from "agentmail";

let client: AgentMailClient | null = null;
let inboxId: string | null = null;

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY;
const AGENTMAIL_INBOX_ID = process.env.AGENTMAIL_INBOX_ID;
const EMAIL_ADDRESS = process.env.AGENTMAIL_EMAIL || "aimee@agentmail.to";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function getClient(): AgentMailClient {
  if (!client) {
    if (!AGENTMAIL_API_KEY) throw new Error("AGENTMAIL_API_KEY not set in .env");
    client = new AgentMailClient({ apiKey: AGENTMAIL_API_KEY });
  }
  return client;
}

/** Find or cache the inbox ID for our email address. */
async function getInboxId(): Promise<string> {
  if (inboxId) return inboxId;
  if (AGENTMAIL_INBOX_ID) {
    inboxId = AGENTMAIL_INBOX_ID;
    return inboxId;
  }

  const c = getClient();
  const response = await c.inboxes.list();
  const inbox = response.inboxes?.find((i: any) =>
    i.email === EMAIL_ADDRESS || i.displayName?.toLowerCase().includes("aimee")
  );

  if (inbox) {
    inboxId = inbox.inboxId;
    return inboxId!;
  }

  throw new Error(`No inbox found for ${EMAIL_ADDRESS}. Set AGENTMAIL_INBOX_ID in .env.`);
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: { filename: string; content: string }[];
}

export async function sendEmail(params: SendEmailParams): Promise<{ messageId: string; threadId: string }> {
  const c = getClient();
  const id = await getInboxId();

  const toArray = Array.isArray(params.to) ? params.to : [params.to];
  const ccArray = params.cc ? (Array.isArray(params.cc) ? params.cc : [params.cc]) : undefined;
  const bccArray = params.bcc ? (Array.isArray(params.bcc) ? params.bcc : [params.bcc]) : undefined;

  const result = await c.inboxes.messages.send(id, {
    to: toArray,
    subject: params.subject,
    text: params.text,
    html: params.html,
    cc: ccArray,
    bcc: bccArray,
    attachments: params.attachments,
  });

  return { messageId: result.messageId, threadId: result.threadId };
}

// ---------------------------------------------------------------------------
// List / Read
// ---------------------------------------------------------------------------

export interface EmailSummary {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  timestamp: Date;
  labels: string[];
}

export async function listEmails(options?: {
  limit?: number;
  after?: Date;
  includeSpam?: boolean;
}): Promise<EmailSummary[]> {
  const c = getClient();
  const id = await getInboxId();

  const response = await c.inboxes.messages.list(id, {
    limit: options?.limit || 20,
    after: options?.after,
    includeSpam: options?.includeSpam ?? false,
  });

  return (response.messages || []).map((msg: any) => ({
    messageId: msg.messageId,
    threadId: msg.threadId,
    from: msg.from?.email || msg.from || "unknown",
    to: (msg.to || []).map((t: any) => t.email || t),
    subject: msg.subject || "(no subject)",
    preview: msg.preview || "",
    timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
    labels: msg.labels || [],
  }));
}

export interface EmailFull extends EmailSummary {
  text?: string;
  html?: string;
  cc?: string[];
  attachments?: { attachmentId: string; filename: string; size: number }[];
}

export async function readEmail(messageId: string): Promise<EmailFull> {
  const c = getClient();
  const id = await getInboxId();

  const msg = await c.inboxes.messages.get(id, messageId);

  return {
    messageId: msg.messageId,
    threadId: msg.threadId,
    from: msg.from?.email || "unknown",
    to: (msg.to || []).map((t: any) => t.email || t),
    subject: msg.subject || "(no subject)",
    preview: msg.preview || "",
    timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
    labels: msg.labels || [],
    text: msg.text || msg.extractedText,
    html: msg.html || msg.extractedHtml,
    cc: msg.cc?.map((c: any) => c.email || c),
    attachments: msg.attachments?.map((a: any) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      size: a.size,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reply / Forward
// ---------------------------------------------------------------------------

export async function replyToEmail(
  messageId: string,
  body: { text?: string; html?: string },
  replyAll?: boolean,
): Promise<{ messageId: string; threadId: string }> {
  const c = getClient();
  const id = await getInboxId();

  const method = replyAll ? c.inboxes.messages.replyAll : c.inboxes.messages.reply;
  const result = await method.call(c.inboxes.messages, id, messageId, {
    text: body.text,
    html: body.html,
  });

  return { messageId: result.messageId, threadId: result.threadId };
}

export async function forwardEmail(
  messageId: string,
  to: string | string[],
  body?: { text?: string; html?: string },
): Promise<{ messageId: string; threadId: string }> {
  const c = getClient();
  const id = await getInboxId();

  const toArray = Array.isArray(to) ? to : [to];
  const result = await c.inboxes.messages.forward(id, messageId, {
    to: toArray,
    text: body?.text,
    html: body?.html,
  });

  return { messageId: result.messageId, threadId: result.threadId };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export async function listThreads(options?: {
  limit?: number;
  after?: Date;
}): Promise<any[]> {
  const c = getClient();

  const response = await c.threads.list({
    limit: options?.limit || 20,
    after: options?.after,
  });

  return response.threads || [];
}

export async function getThread(threadId: string): Promise<any> {
  const c = getClient();
  return c.threads.get(threadId);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export async function labelMessage(
  messageId: string,
  addLabels?: string[],
  removeLabels?: string[],
): Promise<void> {
  const c = getClient();
  const id = await getInboxId();

  await c.inboxes.messages.update(id, messageId, {
    addLabels,
    removeLabels,
  });
}

// ---------------------------------------------------------------------------
// Status check
// ---------------------------------------------------------------------------

export function isEmailEnabled(): boolean {
  return !!AGENTMAIL_API_KEY;
}

export function getEmailAddress(): string {
  return EMAIL_ADDRESS;
}
