export const MAX_MESSAGES = 6;
export const MAX_CHARS_PER_MESSAGE = 500;
export const MAX_CHAT_BODY_BYTES = 8 * 1024;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const ALLOWED_AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"] as const;

export type ChatRole = "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// C0/C1 control characters except tab (\t) and newline (\n), plus bidi overrides and zero-width chars
// that can hide text from humans while still reaching the model.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function stripControlChars(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
}

/**
 * Validates the /api/chat body. Accepts only {messages: [{role, content}]} with
 * roles "user" | "assistant", at most 6 messages, at most 500 chars each.
 * The last message must come from the user. Unknown keys are rejected.
 */
export function validateChatBody(body: unknown): Result<ChatMessage[]> {
  if (!isPlainObject(body)) return fail("Body must be a JSON object.");
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "messages") return fail("Only a 'messages' field is allowed.");

  const messages = (body as { messages: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return fail("'messages' must be a non-empty array.");
  if (messages.length > MAX_MESSAGES) return fail(`At most ${MAX_MESSAGES} messages are allowed.`);

  const clean: ChatMessage[] = [];
  for (const m of messages) {
    if (!isPlainObject(m)) return fail("Each message must be an object.");
    const mk = Object.keys(m).sort().join(",");
    if (mk !== "content,role") return fail("Each message must have only 'role' and 'content'.");
    const { role, content } = m as { role: unknown; content: unknown };
    if (role !== "user" && role !== "assistant") return fail("Invalid role.");
    if (typeof content !== "string") return fail("Message content must be a string.");
    const text = stripControlChars(content).trim();
    if (text.length === 0) return fail("Message content cannot be empty.");
    if (text.length > MAX_CHARS_PER_MESSAGE) return fail(`Messages are limited to ${MAX_CHARS_PER_MESSAGE} characters.`);
    clean.push({ role, content: text });
  }
  if (clean[clean.length - 1].role !== "user") return fail("The last message must be from the user.");
  return { ok: true, value: clean };
}

/** Normalises "audio/webm;codecs=opus" -> "audio/webm" and checks the allow-list. */
export function normaliseAudioType(type: string | null | undefined): (typeof ALLOWED_AUDIO_TYPES)[number] | null {
  if (!type) return null;
  const base = type.split(";")[0].trim().toLowerCase();
  const mapped = base === "audio/x-wav" || base === "audio/wave" ? "audio/wav" : base;
  return (ALLOWED_AUDIO_TYPES as readonly string[]).includes(mapped)
    ? (mapped as (typeof ALLOWED_AUDIO_TYPES)[number])
    : null;
}

/**
 * Checks the file's magic bytes so a renamed non-audio file is rejected even if
 * its declared MIME type is on the allow-list.
 */
export function sniffAudio(bytes: Uint8Array, declared: (typeof ALLOWED_AUDIO_TYPES)[number]): boolean {
  if (bytes.length < 12) return false;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  switch (declared) {
    case "audio/webm":
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case "audio/ogg":
      return ascii(0, 4) === "OggS";
    case "audio/wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    case "audio/mp4":
      return ascii(4, 8) === "ftyp";
  }
}

export function validateAudioFile(
  file: unknown,
): Result<{ file: Blob; type: (typeof ALLOWED_AUDIO_TYPES)[number] }> {
  if (!(file instanceof Blob)) return fail("An audio file is required.");
  const type = normaliseAudioType(file.type);
  if (!type) return fail("Unsupported audio format.");
  if (file.size === 0) return fail("The recording is empty.");
  if (file.size > MAX_AUDIO_BYTES) return fail("The recording is too large (max 2 MB).");
  return { ok: true, value: { file, type } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
