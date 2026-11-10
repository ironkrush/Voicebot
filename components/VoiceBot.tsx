"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "listening" | "thinking" | "speaking";
type Msg = { role: "user" | "assistant"; content: string };

const MAX_RECORD_MS = 30_000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_CHARS = 500;
const HISTORY_LIMIT = 6;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

const SAMPLES = [
  "Tell me about your life story.",
  "What's your number one superpower?",
  "What are the top three areas you'd like to grow in?",
  "What misconception do your coworkers have about you?",
  "How do you push your boundaries and limits?",
];

const STATUS_LABEL: Record<Status, string> = {
  idle: "Tap the mic and ask me anything",
  listening: "Listening... tap again when you're done",
  thinking: "Thinking...",
  speaking: "Speaking...",
};

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function extFor(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?।]+[.!?।]*\s*/g) ?? [text];
  // Group short sentences so speech flows; keep chunks under ~200 chars (Chrome cuts long utterances).
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > 200 && cur) {
      out.push(cur.trim());
      cur = p;
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export default function VoiceBot() {
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [ttsAvailable, setTtsAvailable] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timersRef = useRef<{ stop?: number; tick?: number }>({});
  const abortRef = useRef<AbortController | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const cancelledRef = useRef(false);
  const messagesRef = useRef<Msg[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Load speech synthesis voices (they arrive asynchronously in most browsers).
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setTtsAvailable(false);
      return;
    }
    const load = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const clearTimers = () => {
    window.clearTimeout(timersRef.current.stop);
    window.clearInterval(timersRef.current.tick);
    timersRef.current = {};
  };

  const releaseMic = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(
    () => () => {
      clearTimers();
      releaseMic();
      abortRef.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    },
    [],
  );

  const pickVoice = (text: string): SpeechSynthesisVoice | undefined => {
    const voices = voicesRef.current;
    if (!voices.length) return undefined;
    const hindi = /[ऀ-ॿ]/.test(text);
    const prefs = hindi ? ["hi-IN"] : ["en-IN", "en-GB", "en-US", "en"];
    for (const p of prefs) {
      const v = voices.find((x) => x.lang?.replace("_", "-").startsWith(p));
      if (v) return v;
    }
    return voices[0];
  };

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) {
      setTtsAvailable(false);
      setStatus("idle");
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const chunks = splitSentences(text);
    if (!voicesRef.current.length) voicesRef.current = synth.getVoices();
    const voice = pickVoice(text);
    if (!voice && !voicesRef.current.length) {
      setNotice("No speech voices are available in this browser, so replies are shown as text.");
    }
    setStatus("speaking");
    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = 1.02;
      if (i === chunks.length - 1) {
        u.onend = () => setStatus((s) => (s === "speaking" ? "idle" : s));
        u.onerror = () => setStatus((s) => (s === "speaking" ? "idle" : s));
      }
      synth.speak(u);
    });
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim().slice(0, MAX_INPUT_CHARS);
      if (!text) return;
      setNotice(null);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();

      const history = [...messagesRef.current, { role: "user" as const, content: text }];
      setMessages(history);
      setStatus("thinking");

      const payload = history.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, content: m.content.slice(0, MAX_INPUT_CHARS) }));
      // The API requires the window to start with a user turn after trimming.
      while (payload.length && payload[0].role !== "user") payload.shift();

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload }),
          signal: ctrl.signal,
        });
        const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
        if (!res.ok || typeof data.reply !== "string") {
          setNotice(data.error ?? "Something went wrong. Please try again.");
          setStatus("idle");
          return;
        }
        setMessages((m) => [...m, { role: "assistant", content: data.reply! }]);
        speak(data.reply);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setNotice("Network problem. Please check your connection and try again.");
        setStatus("idle");
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [speak],
  );

  const sendAudio = useCallback(
    async (blob: Blob, mime: string) => {
      if (blob.size < 1200) {
        setNotice("I didn't catch that. Please hold the mic a little longer and try again.");
        setStatus("idle");
        return;
      }
      if (blob.size > MAX_AUDIO_BYTES) {
        setNotice("That recording was too long. Please keep questions under 30 seconds.");
        setStatus("idle");
        return;
      }
      setStatus("thinking");
      const form = new FormData();
      form.append("audio", new Blob([blob], { type: mime }), `question.${extFor(mime)}`);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch("/api/transcribe", { method: "POST", body: form, signal: ctrl.signal });
        const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) {
          setNotice(data.error ?? "Transcription failed. Please try again.");
          setStatus("idle");
          return;
        }
        if (!data.text) {
          setNotice("I didn't catch that. Could you repeat the question?");
          setStatus("idle");
          return;
        }
        if (abortRef.current === ctrl) abortRef.current = null;
        await ask(data.text);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setNotice("Network problem. Please check your connection and try again.");
        setStatus("idle");
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [ask],
  );

  const stopRecording = useCallback(() => {
    clearTimers();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const startRecording = useCallback(async () => {
    setNotice(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice("Voice input needs a secure (https) page and a modern browser. You can type your question below.");
      return;
    }
    const mime = pickMimeType();
    if (mime === null) {
      setNotice("This browser can't record audio. Please type your question below.");
      return;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const name = (err as DOMException).name;
      setNotice(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was blocked. Allow it in your browser's site settings, or type your question below."
          : name === "NotFoundError"
            ? "No microphone was found. You can type your question below."
            : "Couldn't start the microphone. You can type your question below.",
      );
      return;
    }

    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setNotice("This browser can't record audio in a supported format. Please type your question below.");
      return;
    }

    streamRef.current = stream;
    recorderRef.current = rec;
    chunksRef.current = [];
    cancelledRef.current = false;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      releaseMic();
      clearTimers();
      setSeconds(0);
      if (cancelledRef.current) {
        setStatus("idle");
        return;
      }
      const type = (rec.mimeType || mime || "audio/webm").split(";")[0];
      void sendAudio(new Blob(chunksRef.current, { type }), type);
    };

    rec.start(250);
    setStatus("listening");
    setSeconds(0);
    const startedAt = Date.now();
    timersRef.current.tick = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    timersRef.current.stop = window.setTimeout(() => stopRecording(), MAX_RECORD_MS);
  }, [sendAudio, stopRecording]);

  const stopAll = useCallback(() => {
    cancelledRef.current = true;
    stopRecording();
    releaseMic();
    abortRef.current?.abort();
    abortRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setStatus("idle");
  }, [stopRecording]);

  const onMic = () => {
    if (status === "listening") stopRecording();
    else if (status === "idle" || status === "speaking") void startRecording();
  };

  const busy = status === "thinking" || status === "listening";

  const ringColor =
    status === "listening" ? "text-rose-500" : status === "speaking" ? "text-emerald-500" : status === "thinking" ? "text-amber-500" : "";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 py-8 sm:py-12">
      <header className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Talk to Krushil</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          AI voice version of Krushil Patel. Ask about my background, projects and how I work.
        </p>
      </header>

      <section className="flex flex-col items-center gap-4">
        <div className="relative">
          <button
            type="button"
            onClick={onMic}
            disabled={status === "thinking"}
            aria-label={status === "listening" ? "Stop recording and send" : "Start recording"}
            aria-pressed={status === "listening"}
            className={`relative z-10 grid h-24 w-24 place-items-center rounded-full text-white shadow-lg transition focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-400/60 disabled:cursor-not-allowed disabled:opacity-60 ${
              status === "listening" ? "bg-rose-600 hover:bg-rose-500" : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {status === "listening" ? (
              <svg viewBox="0 0 24 24" className="h-9 w-9" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <path d="M12 17v5" />
              </svg>
            )}
          </button>
          {status !== "idle" && <span className={`pulse-ring pointer-events-none absolute inset-0 rounded-full ${ringColor}`} aria-hidden="true" />}
        </div>

        <p className="min-h-6 text-sm font-medium text-slate-700 dark:text-slate-300" role="status" aria-live="polite">
          {STATUS_LABEL[status]}
          {status === "listening" && ` (${seconds}s / 30s)`}
        </p>

        {status !== "idle" && (
          <button
            type="button"
            onClick={stopAll}
            className="rounded-full border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Stop
          </button>
        )}

        {notice && (
          <p role="alert" className="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
            {notice}
          </p>
        )}
        {!ttsAvailable && (
          <p className="text-xs text-slate-500">Speech playback isn&apos;t supported in this browser, so replies are shown as text.</p>
        )}
      </section>

      <section aria-label="Sample questions" className="mt-6 flex flex-wrap justify-center gap-2">
        {SAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            disabled={busy}
            onClick={() => void ask(q)}
            className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-left text-xs text-slate-700 transition hover:border-indigo-400 hover:text-indigo-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-500 dark:hover:text-indigo-300"
          >
            {q}
          </button>
        ))}
      </section>

      <section
        ref={logRef}
        aria-label="Conversation transcript"
        aria-live="polite"
        className="mt-6 flex max-h-[45vh] min-h-32 flex-1 flex-col gap-3 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60"
      >
        {messages.length === 0 ? (
          <p className="m-auto text-center text-sm text-slate-500">Your conversation will appear here.</p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <p
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                }`}
              >
                {m.content}
              </p>
            </div>
          ))
        )}
        {status === "thinking" && <p className="text-xs text-slate-500">Krushil is thinking...</p>}
      </section>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const q = input;
          setInput("");
          void ask(q);
        }}
      >
        <label htmlFor="q" className="sr-only">
          Type a question
        </label>
        <input
          id="q"
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_INPUT_CHARS))}
          maxLength={MAX_INPUT_CHARS}
          autoComplete="off"
          placeholder="Or type a question..."
          className="min-w-0 flex-1 rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Send
        </button>
      </form>

      <footer className="mt-6 space-y-1 text-center text-xs text-slate-500">
        <p>This is an AI voice bot built by Krushil Patel. Answers are generated from his background and may not be perfect.</p>
        <p>Your audio is sent to a speech-to-text provider for transcription. Nothing is stored and no cookies are used.</p>
      </footer>
    </main>
  );
}
