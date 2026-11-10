"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "listening" | "thinking" | "speaking";
type Msg = { role: "user" | "assistant"; content: string };

const MAX_RECORD_MS = 30_000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_CHARS = 500;
const HISTORY_LIMIT = 6;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

// Voice activity detection (hands-free mode)
const VAD_INTERVAL_MS = 50;
const CALIBRATE_MS = 300; // measure background noise first
const MIN_SPEECH_MS = 250; // this much voice before we count it as speech
const END_SILENCE_MS = 1300; // pause length that ends a turn
const NO_SPEECH_MS = 8000; // nobody spoke: pause the conversation
const RELISTEN_DELAY_MS = 350;

const SAMPLES = [
  "Tell me about your life story.",
  "What's your number one superpower?",
  "What are the top three areas you'd like to grow in?",
  "What misconception do your coworkers have about you?",
  "How do you push your boundaries and limits?",
];

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
  const [handsFree, setHandsFree] = useState(true);
  const [inConversation, setInConversation] = useState(false);
  const [level, setLevel] = useState(0);
  const [hearing, setHearing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timersRef = useRef<{ stop?: number; tick?: number; vad?: number; speak?: number; relisten?: number }>({});
  const abortRef = useRef<AbortController | null>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const cancelledRef = useRef(false);
  const messagesRef = useRef<Msg[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const handsFreeRef = useRef(true);
  const conversationRef = useRef(false); // hands-free loop is running
  const emptyTurnsRef = useRef(0);
  const startRecordingRef = useRef<() => void>(() => {});

  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

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

  const setConversation = (on: boolean) => {
    conversationRef.current = on;
    setInConversation(on);
    if (!on) emptyTurnsRef.current = 0;
  };

  const clearRecordTimers = () => {
    const t = timersRef.current;
    window.clearTimeout(t.stop);
    window.clearInterval(t.tick);
    window.clearInterval(t.vad);
    t.stop = t.tick = t.vad = undefined;
  };

  const clearSpeakTimers = () => {
    const t = timersRef.current;
    window.clearInterval(t.speak);
    window.clearTimeout(t.relisten);
    t.speak = t.relisten = undefined;
  };

  const releaseMic = () => {
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevel(0);
    setHearing(false);
  };

  useEffect(
    () => () => {
      conversationRef.current = false;
      clearRecordTimers();
      clearSpeakTimers();
      releaseMic();
      abortRef.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      void audioCtxRef.current?.close().catch(() => {});
    },
    [],
  );

  /** Pause the hands-free loop with a message; the user taps the mic to resume. */
  const pauseConversation = (message: string | null) => {
    setConversation(false);
    if (message) setNotice(message);
  };

  /** Called when the bot has finished speaking (or nothing was spoken). Re-opens the mic in hands-free mode. */
  const afterReply = useCallback(() => {
    clearSpeakTimers();
    setStatus("idle");
    if (conversationRef.current) {
      timersRef.current.relisten = window.setTimeout(() => {
        if (conversationRef.current) startRecordingRef.current();
      }, RELISTEN_DELAY_MS);
    }
  }, []);

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

  const speak = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window)) {
        setTtsAvailable(false);
        afterReply();
        return;
      }
      const synth = window.speechSynthesis;
      synth.cancel();
      clearSpeakTimers();
      if (!voicesRef.current.length) voicesRef.current = synth.getVoices();
      const voice = pickVoice(text);
      if (!voice && !voicesRef.current.length) {
        setNotice("No speech voices are available in this browser, so replies are shown as text.");
      }
      setStatus("speaking");
      for (const chunk of splitSentences(text)) {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        u.rate = 1.02;
        synth.speak(u);
      }
      // Poll instead of relying on onend, which some browsers fail to fire.
      const startedAt = Date.now();
      let seen = false;
      timersRef.current.speak = window.setInterval(() => {
        if (synth.speaking || synth.pending) {
          seen = true;
          return;
        }
        if (!seen && Date.now() - startedAt < 1500) return; // not started yet
        afterReply();
      }, 250);
    },
    [afterReply],
  );

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim().slice(0, MAX_INPUT_CHARS);
      if (!text) return;
      setNotice(null);
      clearSpeakTimers();
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
          pauseConversation(data.error ?? "Something went wrong. Please try again.");
          setStatus("idle");
          return;
        }
        setMessages((m) => [...m, { role: "assistant", content: data.reply! }]);
        speak(data.reply);
      } catch (err) {
        if ((err as Error).name !== "AbortError") pauseConversation("Network problem. Please check your connection and try again.");
        setStatus("idle");
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [speak],
  );

  /** In hands-free mode an unclear turn just re-opens the mic, up to twice in a row. */
  const unclearTurn = useCallback(
    (message: string) => {
      if (conversationRef.current && emptyTurnsRef.current < 2) {
        emptyTurnsRef.current += 1;
        setNotice(message);
        afterReply();
        return;
      }
      pauseConversation(message);
      setStatus("idle");
    },
    [afterReply],
  );

  const sendAudio = useCallback(
    async (blob: Blob, mime: string) => {
      if (blob.size < 1200) {
        unclearTurn("I didn't catch that. Please try again.");
        return;
      }
      if (blob.size > MAX_AUDIO_BYTES) {
        pauseConversation("That recording was too long. Please keep questions under 30 seconds.");
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
          pauseConversation(data.error ?? "Transcription failed. Please try again.");
          setStatus("idle");
          return;
        }
        if (!data.text) {
          unclearTurn("I didn't catch that. Could you repeat the question?");
          return;
        }
        emptyTurnsRef.current = 0;
        if (abortRef.current === ctrl) abortRef.current = null;
        await ask(data.text);
      } catch (err) {
        if ((err as Error).name !== "AbortError") pauseConversation("Network problem. Please check your connection and try again.");
        setStatus("idle");
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [ask, unclearTurn],
  );

  const stopRecording = useCallback(() => {
    clearRecordTimers();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  /** Shared AudioContext, created on a user tap so iOS lets it run during later automatic turns. */
  const ensureAudioContext = () => {
    if (audioCtxRef.current) {
      void audioCtxRef.current.resume().catch(() => {});
      return audioCtxRef.current;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      audioCtxRef.current = new AC();
      void audioCtxRef.current.resume().catch(() => {});
    } catch {
      audioCtxRef.current = null;
    }
    return audioCtxRef.current;
  };

  /** Watches mic volume: ends the turn after a pause, or pauses the conversation if nobody speaks. */
  const startVad = (stream: MediaStream) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    let analyser: AnalyserNode;
    try {
      const source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      sourceRef.current = source;
    } catch {
      return; // no VAD: the user can still tap to stop, and the 30 s cap applies
    }
    const buf = new Float32Array(analyser.fftSize);
    const t0 = performance.now();
    let last = t0;
    let floorSum = 0;
    let floorN = 0;
    let voiceMs = 0;
    let lastVoiceAt = 0;
    let started = false;

    timersRef.current.vad = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      const dt = now - last;
      last = now;
      setLevel(Math.min(1, rms * 12));

      if (now - t0 < CALIBRATE_MS) {
        floorSum += rms;
        floorN += 1;
        return;
      }
      const floor = Math.min(floorN ? floorSum / floorN : 0.005, 0.02);
      const threshold = Math.max(0.012, floor * 3);

      if (rms > threshold) {
        voiceMs += dt;
        lastVoiceAt = now;
        if (voiceMs >= MIN_SPEECH_MS && !started) {
          started = true;
          setHearing(true);
        }
      } else if (!started) {
        voiceMs = Math.max(0, voiceMs - dt / 2);
      }

      if (!handsFreeRef.current) return; // tap-to-talk: meter only
      if (started && now - lastVoiceAt > END_SILENCE_MS) {
        stopRecording();
      } else if (!started && now - t0 > NO_SPEECH_MS) {
        cancelledRef.current = true;
        stopRecording();
        pauseConversation("Conversation paused. Tap the mic whenever you want to keep talking.");
      }
    }, VAD_INTERVAL_MS);
  };

  const startRecording = useCallback(async () => {
    clearSpeakTimers();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      pauseConversation("Voice input needs a secure (https) page and a modern browser. You can type your question below.");
      return;
    }
    const mime = pickMimeType();
    if (mime === null) {
      pauseConversation("This browser can't record audio. Please type your question below.");
      return;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = (err as DOMException).name;
      pauseConversation(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was blocked. Allow it in your browser's site settings, or type your question below."
          : name === "NotFoundError"
            ? "No microphone was found. You can type your question below."
            : "Couldn't start the microphone. Tap the mic to try again, or type your question below.",
      );
      setStatus("idle");
      return;
    }

    let rec: MediaRecorder;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      pauseConversation("This browser can't record audio in a supported format. Please type your question below.");
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
      clearRecordTimers();
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
    setHearing(false);
    startVad(stream);
    const startedAt = Date.now();
    timersRef.current.tick = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    timersRef.current.stop = window.setTimeout(() => stopRecording(), MAX_RECORD_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendAudio, stopRecording]);

  useEffect(() => {
    startRecordingRef.current = () => void startRecording();
  }, [startRecording]);

  const stopAll = useCallback(() => {
    setConversation(false);
    cancelledRef.current = true;
    clearSpeakTimers();
    stopRecording();
    releaseMic();
    abortRef.current?.abort();
    abortRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setStatus("idle");
  }, [stopRecording]);

  const onMic = () => {
    ensureAudioContext();
    setNotice(null);
    if (status === "listening") {
      stopRecording(); // send now without waiting for the pause
    } else if (status === "idle" || status === "speaking") {
      setConversation(handsFree);
      emptyTurnsRef.current = 0;
      void startRecording();
    }
  };

  const busy = status === "thinking" || status === "listening";

  const statusLabel = (() => {
    if (status === "listening") {
      if (handsFree) return hearing ? "Listening... just pause when you're done" : "Listening... go ahead";
      return "Listening... tap again when you're done";
    }
    if (status === "thinking") return "Thinking...";
    if (status === "speaking") return inConversation ? "Speaking... I'll listen again right after" : "Speaking...";
    return handsFree ? "Tap the mic to start a conversation" : "Tap the mic and ask me anything";
  })();

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
            aria-label={status === "listening" ? "Send now" : handsFree ? "Start conversation" : "Start recording"}
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

        {/* Mic level meter so people can see they are being heard */}
        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden="true">
          <div
            className={`h-full rounded-full transition-[width] duration-75 ${hearing ? "bg-emerald-500" : "bg-rose-400"}`}
            style={{ width: `${status === "listening" ? Math.round(level * 100) : 0}%` }}
          />
        </div>

        <p className="min-h-6 text-center text-sm font-medium text-slate-700 dark:text-slate-300" role="status" aria-live="polite">
          {statusLabel}
          {status === "listening" && ` (${seconds}s / 30s)`}
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {(status !== "idle" || inConversation) && (
            <button
              type="button"
              onClick={stopAll}
              className="rounded-full border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {inConversation ? "End conversation" : "Stop"}
            </button>
          )}
          <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              checked={handsFree}
              onChange={(e) => {
                setHandsFree(e.target.checked);
                if (!e.target.checked) setConversation(false);
              }}
              className="h-4 w-4 accent-indigo-600"
            />
            Hands-free (auto-detect when I stop talking)
          </label>
        </div>

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
