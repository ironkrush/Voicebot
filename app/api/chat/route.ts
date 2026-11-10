import { PERSONA_PROMPT, PROMPT_SENTINELS } from "@/lib/persona";
import { chat } from "@/lib/llm";
import { checkRateLimit } from "@/lib/ratelimit";
import { sanitizeReply } from "@/lib/sanitize";
import { BUSY_MESSAGE, GENERIC_ERROR, clientIp, isAllowedOrigin, json } from "@/lib/security";
import { MAX_CHAT_BODY_BYTES, validateChatBody } from "@/lib/validation";
import { readTextLimited } from "@/lib/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAllowedOrigin(req.headers)) return json({ error: "Forbidden." }, 403);

  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().startsWith("application/json")) return json({ error: "Expected JSON." }, 415);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_CHAT_BODY_BYTES) return json({ error: "Request too large." }, 413);

  const limit = await checkRateLimit(clientIp(req.headers));
  if (!limit.ok) return json({ error: BUSY_MESSAGE }, 429, { "Retry-After": String(limit.retryAfter) });

  const raw = await readTextLimited(req, MAX_CHAT_BODY_BYTES);
  if (raw === null) return json({ error: "Request too large." }, 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  const parsed = validateChatBody(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  try {
    // The system prompt is always added here on the server; clients can never supply one.
    const reply = await chat(PERSONA_PROMPT, parsed.value);
    return json({ reply: sanitizeReply(reply, PROMPT_SENTINELS) });
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("chat_failed", typeof status === "number" ? status : "unknown");
    if (status === 429) return json({ error: BUSY_MESSAGE }, 503, { "Retry-After": "5" });
    return json({ error: GENERIC_ERROR }, 502);
  }
}
