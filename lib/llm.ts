import "server-only";
import type { ChatMessage } from "./validation";

const TIMEOUT_MS = 15_000;
const GROQ_BASE = "https://api.groq.com/openai/v1";
// llama-3.3-70b-versatile was retired by Groq. Each Groq model has its own free-tier quota
// (8k tokens/min), so on a 429 we fall through to the next model instead of failing.
// GROQ_CHAT_MODEL (optional) puts a specific model first. gpt-oss-20b is deliberately excluded:
// in testing it invented resume details (tools never used), which is worse than a "busy" reply.
const DEFAULT_CHAT_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"];
const CHAT_MODELS = [...new Set([process.env.GROQ_CHAT_MODEL, ...DEFAULT_CHAT_MODELS].filter(Boolean) as string[])];
const STT_MODEL = "whisper-large-v3-turbo";
const GEMINI_MODEL = "gemini-2.5-flash";

export class UpstreamError extends Error {
  constructor(public readonly status: number) {
    super(`upstream_${status}`);
  }
}

/**
 * fetch with a 15 s timeout and one retry on 429 / 5xx / network errors.
 * With failFastOn429, a 429 is thrown immediately so the caller can switch models.
 */
async function fetchWithRetry(url: string, init: () => RequestInit, failFastOn429 = false): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init(), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status === 429 && failFastOn429) break;
      if (res.status !== 429 && res.status < 500) break;
    } catch {
      lastStatus = 504;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
  }
  throw new UpstreamError(lastStatus);
}

function groqKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new UpstreamError(500);
  return key;
}

export async function transcribe(file: Blob, filename: string): Promise<string> {
  const res = await fetchWithRetry(`${GROQ_BASE}/audio/transcriptions`, () => {
    const form = new FormData();
    form.append("file", file, filename);
    form.append("model", STT_MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");
    return { method: "POST", headers: { Authorization: `Bearer ${groqKey()}` }, body: form };
  });
  const data = (await res.json()) as { text?: unknown };
  return typeof data.text === "string" ? data.text.trim() : "";
}

/** Reasoning settings per model family so no hidden reasoning is returned or spoken. */
function reasoningParams(model: string): Record<string, unknown> {
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low", include_reasoning: false };
  if (model.startsWith("qwen/")) return { reasoning_effort: "none" };
  return {};
}

async function groqChat(model: string, system: string, messages: ChatMessage[]): Promise<string> {
  const res = await fetchWithRetry(
    `${GROQ_BASE}/chat/completions`,
    () => ({
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages],
        // Reasoning models count hidden reasoning tokens toward this budget, so it is larger than
        // the visible-reply target. The spoken reply is still capped at 900 chars server-side.
        max_completion_tokens: 500,
        temperature: 0.6,
        ...reasoningParams(model),
      }),
    }),
    true,
  );
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new UpstreamError(502);
  return text;
}

async function geminiChat(system: string, messages: ChatMessage[], key: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetchWithRetry(url, () => ({
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 250, temperature: 0.6, thinkingConfig: { thinkingBudget: 0 } },
    }),
  }));
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
}

/** Groq models in order (each has its own quota), then Gemini Flash when GEMINI_API_KEY is set. */
export async function chat(system: string, messages: ChatMessage[]): Promise<string> {
  let lastErr: unknown = new UpstreamError(502);
  for (const model of CHAT_MODELS) {
    try {
      return await groqChat(model, system, messages);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // A missing key or bad request will fail the same way on every Groq model.
      if (status === 400 || status === 401 || status === 403) break;
    }
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw lastErr;
  return await geminiChat(system, messages, geminiKey);
}
