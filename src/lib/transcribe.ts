/**
 * Go - Audio Transcription
 *
 * Primary: OpenAI Whisper API (best quality, $0.006/min)
 * Fallback: Gemini (free tier)
 */

import { readFile } from "fs/promises";

const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY || "";

/**
 * Transcribe audio using OpenAI Whisper API.
 */
async function transcribeWithWhisper(audioBuffer: Buffer, mimeType: string): Promise<string> {
  // Map mime type to file extension for the form data
  const extMap: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
  };
  const cleanMime = mimeType.split(";")[0].trim();
  const ext = extMap[cleanMime] || "ogg";

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: cleanMime });
  formData.append("file", blob, `voice.${ext}`);
  formData.append("model", "whisper-1");

  console.log(`[TRANSCRIBE] Whisper: ${audioBuffer.length} bytes, mime: ${cleanMime}`);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY()}`,
    },
    body: formData,
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("[TRANSCRIBE] Whisper API error:", JSON.stringify(result));
    throw new Error(`Whisper API error: ${result.error?.message || response.status}`);
  }

  const text = result.text?.trim();
  if (!text) {
    throw new Error("Whisper returned empty text");
  }

  console.log(`[TRANSCRIBE] Whisper success: "${text.substring(0, 100)}"`);
  return text;
}

/**
 * Transcribe audio using Gemini.
 */
async function transcribeWithGemini(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const base64Audio = audioBuffer.toString("base64");
  let cleanMimeType = mimeType.split(";")[0].trim();
  if (!cleanMimeType || cleanMimeType === "application/octet-stream") {
    cleanMimeType = "audio/ogg";
  }

  console.log(`[TRANSCRIBE] Gemini: ${audioBuffer.length} bytes, mime: ${cleanMimeType}`);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: "Transcribe this audio message accurately. Only output the transcription, nothing else. If the audio is very short or unclear, transcribe what you can hear." },
            { inline_data: { mime_type: cleanMimeType, data: base64Audio } },
          ],
        }],
      }),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    console.error("[TRANSCRIBE] Gemini API error:", JSON.stringify(result));
    throw new Error(`Gemini API error: ${result.error?.message || response.status}`);
  }

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty text");
  }

  console.log(`[TRANSCRIBE] Gemini success: "${text.substring(0, 100)}"`);
  return text;
}

/**
 * Transcribe an audio file. Tries Whisper first, falls back to Gemini.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!isTranscriptionEnabled()) {
    return "[Voice transcription unavailable - no API key configured]";
  }

  const audioBuffer = await readFile(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() || "ogg";
  const mimeMap: Record<string, string> = {
    ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav",
    m4a: "audio/mp4", webm: "audio/webm",
  };
  return transcribeAudioBuffer(audioBuffer, mimeMap[ext] || "audio/ogg");
}

/**
 * Transcribe audio from an in-memory buffer.
 * Whisper (primary) → Gemini (fallback)
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  mimeType: string = "audio/ogg"
): Promise<string> {
  if (!isTranscriptionEnabled()) {
    return "[Voice transcription unavailable - no API key configured]";
  }

  // Try Whisper first (better quality)
  if (OPENAI_API_KEY()) {
    try {
      return await transcribeWithWhisper(audioBuffer, mimeType);
    } catch (err) {
      console.error("[TRANSCRIBE] Whisper failed, trying Gemini fallback:", err);
    }
  }

  // Fall back to Gemini
  if (GEMINI_API_KEY()) {
    try {
      return await transcribeWithGemini(audioBuffer, mimeType);
    } catch (err) {
      console.error("[TRANSCRIBE] Gemini also failed:", err);
      return "[Transcription failed - both Whisper and Gemini errored]";
    }
  }

  return "[Transcription failed - no working API]";
}

/**
 * Check if transcription is configured (either Whisper or Gemini).
 */
export function isTranscriptionEnabled(): boolean {
  return !!(OPENAI_API_KEY() || GEMINI_API_KEY());
}
