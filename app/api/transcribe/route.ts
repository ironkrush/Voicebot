import { transcribe } from "@/lib/llm";
import { checkRateLimit } from "@/lib/ratelimit";
import { BUSY_MESSAGE, GENERIC_ERROR, clientIp, isAllowedOrigin, json } from "@/lib/security";
import { MAX_AUDIO_BYTES, MAX_CHARS_PER_MESSAGE, sniffAudio, stripControlChars, validateAudioFile } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Allow some room for multipart boundaries and headers on top of the 2 MB file.
const MAX_MULTIPART_BYTES = MAX_AUDIO_BYTES + 16 * 1024;
const EXT: Record<string, string> = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav" };

export async function POST(req: Request) {
  if (!isAllowedOrigin(req.headers)) return json({ error: "Forbidden." }, 403);

  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ctype.startsWith("multipart/form-data")) return json({ error: "Expected an audio upload." }, 415);

  const lenHeader = req.headers.get("content-length");
  if (!lenHeader) return json({ error: "Content-Length required." }, 411);
  const len = Number(lenHeader);
  if (!Number.isFinite(len) || len <= 0) return json({ error: "Invalid upload." }, 400);
  if (len > MAX_MULTIPART_BYTES) return json({ error: "The recording is too large (max 2 MB)." }, 413);

  const limit = await checkRateLimit(clientIp(req.headers));
  if (!limit.ok) return json({ error: BUSY_MESSAGE }, 429, { "Retry-After": String(limit.retryAfter) });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Invalid upload." }, 400);
  }

  const keys = [...new Set(form.keys())];
  if (keys.length !== 1 || keys[0] !== "audio" || form.getAll("audio").length !== 1) {
    return json({ error: "Send exactly one 'audio' field." }, 400);
  }

  const checked = validateAudioFile(form.get("audio"));
  if (!checked.ok) return json({ error: checked.error }, 400);

  const { file, type } = checked.value;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffAudio(bytes, type)) return json({ error: "Unsupported audio format." }, 400);

  try {
    const text = await transcribe(new Blob([bytes], { type }), `speech.${EXT[type]}`);
    const clean = stripControlChars(text).trim().slice(0, MAX_CHARS_PER_MESSAGE);
    return json({ text: clean });
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("transcribe_failed", typeof status === "number" ? status : "unknown");
    if (status === 429) return json({ error: BUSY_MESSAGE }, 503, { "Retry-After": "5" });
    return json({ error: GENERIC_ERROR }, 502);
  }
}
