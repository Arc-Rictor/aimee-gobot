/**
 * Go - Discord Helpers
 *
 * Send messages, sanitize markdown for Discord, cross-channel messaging.
 */

import type { Client, TextChannel } from "discord.js";
import { ChannelType } from "discord.js";

export interface CrossChannelMessage {
  channel: string; // channel name (without #) or channel ID
  message: string;
}

/** Extract [SEND:#channel|message] tags from a response. */
export function extractCrossChannelMessages(text: string): CrossChannelMessage[] {
  const matches: CrossChannelMessage[] = [];
  const regex = /\[SEND:#([^|]+)\|([^\]]+)\]/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ channel: match[1].trim(), message: match[2].trim() });
  }
  return matches;
}

/** Send a message to a channel by name or ID. Returns true on success. */
export async function sendToChannel(
  client: Client,
  nameOrId: string,
  message: string,
): Promise<boolean> {
  try {
    // Try by ID first
    const byId = client.channels.cache.get(nameOrId);
    if (byId && byId.type === ChannelType.GuildText) {
      await (byId as TextChannel).send(message);
      return true;
    }

    // Search by name across all guilds
    for (const guild of client.guilds.cache.values()) {
      const ch = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === nameOrId,
      );
      if (ch) {
        await (ch as TextChannel).send(message);
        return true;
      }
    }

    console.error(`[DISCORD] Channel not found: ${nameOrId}`);
    return false;
  } catch (err) {
    console.error(`[DISCORD] Failed to send to #${nameOrId}:`, err);
    return false;
  }
}

/** Process all [SEND:#channel|message] tags, delivering each message. */
export async function processCrossChannelMessages(
  client: Client,
  responseText: string,
): Promise<void> {
  const sends = extractCrossChannelMessages(responseText);
  for (const { channel, message } of sends) {
    const ok = await sendToChannel(client, channel, message);
    if (ok) console.log(`[DISCORD] Sent cross-channel message to #${channel}`);
  }
}

export function sanitizeForDiscord(text: string): string {
  let result = text;
  result = result.replace(/\[GOAL:\s*[^\]]+\]/gi, "");
  result = result.replace(/\[DONE:\s*[^\]]+\]/gi, "");
  result = result.replace(/\[CANCEL:\s*[^\]]+\]/gi, "");
  result = result.replace(/\[REMEMBER:\s*[^\]]+\]/gi, "");
  result = result.replace(/\[FORGET:\s*[^\]]+\]/gi, "");
  result = result.replace(/\[KNOWLEDGE:\s*[^\]]+\]/gi, "");
  result = result.replace(/\[SEND:#[^|]+\|[^\]]+\]/gi, "");
  result = result.replace(/\[EMAIL:[^\]]+\]/gi, "");
  result = result.replace(/\[OVERNIGHT:[^\]]+\]/gi, "");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

export function splitMessage(text: string, maxLength: number = 2000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5)
      splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(". ", maxLength);
      if (splitIndex !== -1) splitIndex += 1;
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5)
      splitIndex = maxLength;
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  return chunks;
}
