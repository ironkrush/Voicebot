export const SAFE_LINE = "I'm here to talk about my background, so ask me anything about my work or experience.";
export const MAX_REPLY_CHARS = 900;

/** Removes markdown so the text reads naturally through speech synthesis. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/[*_~#|]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Caps length at a sentence boundary where possible. */
export function capLength(text: string, max = MAX_REPLY_CHARS): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (lastStop > max * 0.5) return slice.slice(0, lastStop + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 0 ? lastSpace : max).trim()}...`;
}

function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function containsSentinel(text: string, sentinels: readonly string[]): boolean {
  const hay = normaliseForMatch(text);
  return sentinels.some((s) => {
    const needle = normaliseForMatch(s);
    return needle.length > 0 && hay.includes(needle);
  });
}

/** Full server-side post-processing of a model reply. */
export function sanitizeReply(raw: string, sentinels: readonly string[]): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return SAFE_LINE;
  if (containsSentinel(raw, sentinels)) return SAFE_LINE;
  const cleaned = capLength(stripMarkdown(raw));
  return cleaned.length > 0 ? cleaned : SAFE_LINE;
}
