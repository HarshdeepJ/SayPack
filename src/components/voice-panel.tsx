"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { DamagePhotoCheck } from "@/components/damage-check";
import { SaveStatus } from "@/components/ui";
import { apiGet, apiSend, apiUpload, useCommand, useLocalValue, usePolling } from "@/lib/client-api";
import { speak } from "@/lib/speech";
import type { AiStatus, ConfirmOutcome, VoiceResult } from "@/lib/types";

const MAX_SECONDS = 20;

// Minimal typing for the browser speech-recognition API (Chrome exposes it prefixed).
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Listens briefly for "yes" or "no". Anything else counts as no answer; the buttons stay. */
function listenYesNo(timeoutMs = 6000): Promise<"yes" | "no" | null> {
  const Ctor = recognitionCtor();
  if (!Ctor) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: "yes" | "no" | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        recognition.stop();
      } catch {
        // already stopped
      }
      resolve(answer);
    };
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    recognition.onresult = (event) => {
      const heard = Array.from(event.results)
        .flatMap((r) => Array.from(r).map((a) => a.transcript.toLowerCase()))
        .join(" ");
      if (/\b(no|nope|cancel|wrong|stop)\b/.test(heard)) done("no");
      else if (/\b(yes|yeah|yep|confirm|correct|save|ok|okay)\b/.test(heard)) done("yes");
      else done(null);
    };
    recognition.onerror = () => done(null);
    recognition.onend = () => done(null);
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      recognition.start();
    } catch {
      done(null);
    }
  });
}

type Phase =
  | { kind: "idle" }
  | { kind: "proposal"; result: Extract<VoiceResult, { kind: "proposal" }>; listening: boolean }
  | { kind: "clarification"; result: Extract<VoiceResult, { kind: "clarification" }> }
  | { kind: "failed"; message: string }
  /** incidentId is set after a damage report, so the panel can ask for a photo. */
  | { kind: "saved"; message: string; incidentId: string | null };

type Submission = { audio?: Blob; seconds?: number; text?: string };

export function VoicePanel({
  moveId,
  activeBox,
  onSaved,
}: {
  moveId: string;
  activeBox: { id: string; label: string } | null;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [muted, setMuted] = useLocalValue("saypack.voice.muted");
  const speechOn = muted !== "1";
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const loadStatus = useCallback(async () => {
    const result = await apiGet<AiStatus>(`/api/moves/${moveId}/voice`);
    if (result.ok) setStatus(result.data);
  }, [moveId]);
  usePolling(loadStatus, 30000);

  const confirm = useCommand(
    (actionId, proposalId: string) =>
      apiSend<ConfirmOutcome>("POST", `/api/voice-proposals/${proposalId}/confirm`, {
        actionId,
        contextBoxId: activeBox?.id ?? null,
      }),
    {
      onSaved: (outcome) => {
        const incidentId = outcome.operation === "report_damage" ? outcome.incident.id : null;
        setPhase({ kind: "saved", message: outcome.message, incidentId });
        if (speechOn) void speak(outcome.message);
        onSaved();
      },
      onError: (error) => {
        if (error.code !== "network") setPhase({ kind: "failed", message: error.message });
      },
    },
  );

  async function cancel(proposalId: string) {
    await apiSend("POST", `/api/voice-proposals/${proposalId}/cancel`, {});
    setPhase({ kind: "failed", message: "Cancelled. Nothing was saved." });
    if (speechOn) void speak("Cancelled.");
  }

  async function handleResult(result: VoiceResult) {
    void loadStatus();
    if (result.kind === "failed") {
      setPhase({ kind: "failed", message: result.message });
      if (speechOn) void speak("Not saved. " + result.message);
      return;
    }
    if (result.kind === "clarification") {
      setPhase({ kind: "clarification", result });
      if (speechOn) void speak(result.question);
      return;
    }
    setPhase({ kind: "proposal", result, listening: false });
    if (!speechOn) return;
    await speak(`${result.proposal.readback.replace(/ Save\?$/, "")}. Say yes or no.`);
    setPhase((p) => (p.kind === "proposal" && p.result.proposal.id === result.proposal.id ? { ...p, listening: true } : p));
    const answer = await listenYesNo();
    setPhase((p) => (p.kind === "proposal" && p.result.proposal.id === result.proposal.id ? { ...p, listening: false } : p));
    if (answer === "yes") void confirm.run(result.proposal.id);
    if (answer === "no") void cancel(result.proposal.id);
  }

  const submit = useCommand(
    (actionId, input: Submission) => {
      const form = new FormData();
      form.set("actionId", actionId);
      if (activeBox) form.set("boxId", activeBox.id);
      if (phase.kind === "clarification") form.set("clarifiesRequestId", phase.result.requestId);
      if (input.audio) {
        form.set("audio", input.audio, "command.webm");
        form.set("seconds", String(input.seconds ?? 1));
      } else {
        form.set("text", input.text ?? "");
      }
      return apiUpload<VoiceResult>(`/api/moves/${moveId}/voice`, form);
    },
    {
      onSaved: (result) => void handleResult(result),
      onError: (error) => {
        if (error.code !== "network") setPhase({ kind: "failed", message: error.message });
        void loadStatus();
      },
    },
  );

  async function startRecording() {
    setMicError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setMicError("Microphone access was blocked. Allow it in the browser, or type the command.");
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(tick.current);
      setRecording(false);
      const seconds = Math.min((Date.now() - startedAt.current) / 1000, MAX_SECONDS);
      if (seconds < 0.5) return;
      void submit.run({ audio: new Blob(chunks, { type: rec.mimeType || "audio/webm" }), seconds: Math.max(seconds, 1) });
    };
    recorder.current = rec;
    startedAt.current = Date.now();
    setElapsed(0);
    setRecording(true);
    window.speechSynthesis?.cancel();
    rec.start();
    tick.current = setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000;
      setElapsed(Math.floor(s));
      if (s >= MAX_SECONDS) rec.stop();
    }, 250);
  }

  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  useEffect(
    () => () => {
      clearInterval(tick.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
    },
    [],
  );

  function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const text = String(new FormData(formEl).get("command") ?? "").trim();
    if (!text) return;
    void submit.run({ text }).then((r) => r.ok && formEl.reset());
  }

  const unavailable = status && !status.available;
  const busy = submit.saving || confirm.saving;

  return (
    <section aria-labelledby="voice-heading" className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h2 id="voice-heading" className="font-semibold">
          Voice
        </h2>
        {status && (
          <span className="text-xs text-muted">
            {status.provider === "mock" ? "Practice mode" : `Gemini · S$${status.remainingSgd.toFixed(2)} left`}
          </span>
        )}
        <label className="ml-auto flex items-center gap-1 text-xs">
          <input type="checkbox" checked={speechOn} onChange={(e) => setMuted(e.target.checked ? "0" : "1")} />
          Spoken replies
        </label>
      </div>

      {status?.provider === "mock" && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          The assistant is simulated and can&apos;t hear audio. Type commands like &quot;Blue vase, box A, fragile, no
          visible damage&quot;, &quot;move blue vase to box B&quot; or &quot;damage blue vase: crack on rim&quot;.
        </p>
      )}

      {unavailable ? (
        <p role="alert" className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
          {status.message} Use manual entry below.
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={recording ? stopRecording : () => void startRecording()}
            disabled={busy && !recording}
            aria-pressed={recording}
            className={`btn min-h-20 w-full text-lg ${recording ? "border-danger bg-danger text-white" : "btn-primary"}`}
          >
            {recording
              ? `● Recording ${elapsed}s — tap to send`
              : submit.saving
                ? "Thinking…"
                : phase.kind === "clarification"
                  ? "🎤 Tap to answer"
                  : "🎤 Tap to speak"}
          </button>
          {micError && <p role="alert" className="text-sm text-danger">{micError}</p>}

          <form onSubmit={submitText} className="flex gap-2">
            <label htmlFor="voice-text" className="sr-only">
              Type a command instead
            </label>
            <input
              id="voice-text"
              name="command"
              className="input"
              maxLength={300}
              autoComplete="off"
              placeholder={phase.kind === "clarification" ? "Type your answer" : "Or type a command"}
            />
            <button type="submit" className="btn" disabled={busy}>
              Send
            </button>
          </form>
          <SaveStatus status={submit.status === "unsent" ? "unsent" : "idle"} error={submit.error} onRetry={submit.retry} />
        </>
      )}

      {phase.kind === "proposal" && (
        <div className="space-y-2 rounded-xl border-2 border-accent p-3" role="status">
          <p className="text-xs text-muted">Heard: &ldquo;{phase.result.transcript}&rdquo;</p>
          <p className="text-lg font-medium">{phase.result.proposal.readback}</p>
          <p className="text-sm text-muted">{phase.listening ? "Listening for yes or no…" : "Not saved yet."}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary min-h-14 flex-1 text-base"
              disabled={confirm.saving}
              onClick={() => void confirm.run(phase.result.proposal.id)}
            >
              Yes, save
            </button>
            <button
              type="button"
              className="btn min-h-14 flex-1 text-base"
              disabled={confirm.saving}
              onClick={() => void cancel(phase.result.proposal.id)}
            >
              No
            </button>
          </div>
          <SaveStatus status={confirm.status === "unsent" ? "unsent" : "idle"} error={confirm.error} onRetry={confirm.retry} />
        </div>
      )}

      {phase.kind === "clarification" && (
        <div className="rounded-xl border-2 border-warn bg-warn-bg p-3 text-warn" role="status">
          <p className="text-xs">Heard: &ldquo;{phase.result.transcript}&rdquo;</p>
          <p className="font-medium">{phase.result.question}</p>
          <button type="button" className="mt-1 text-sm underline" onClick={() => setPhase({ kind: "idle" })}>
            Start over
          </button>
        </div>
      )}

      {phase.kind === "failed" && (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          <strong>Not saved.</strong> {phase.message} You can also use manual entry below.
        </p>
      )}

      {phase.kind === "saved" && (
        <p role="status" className="rounded-lg bg-ok-bg px-3 py-2 font-medium text-ok">
          ✓ {phase.message}
        </p>
      )}
      {phase.kind === "saved" && phase.incidentId && (
        <DamagePhotoCheck
          key={phase.incidentId}
          incidentId={phase.incidentId}
          label="Take a photo of the damage"
          speakResult={speechOn}
          onChanged={onSaved}
        />
      )}

      <p className="text-xs text-muted">
        Voice clips and typed commands are sent to Google Gemini to interpret. Spoken yes/no answers use the
        browser&apos;s speech recognition, which may also send audio to Google. Nothing is saved until you confirm.
      </p>
    </section>
  );
}
