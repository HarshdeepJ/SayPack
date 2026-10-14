"use client";

import { useState } from "react";
import { PhotoUpload } from "@/components/evidence";
import { Badge, formatTime } from "@/components/ui";
import { apiSend, useCommand } from "@/lib/client-api";
import { AI_VERDICT_BADGE } from "@/lib/incident-text";
import { speak } from "@/lib/speech";
import type { AssessmentView } from "@/lib/types";

const SEVERITY: Record<string, string> = { minor: "Minor", moderate: "Moderate", severe: "Severe" };
const MATCHES: Record<string, string> = { yes: "Matches the report", no: "Does not match the report", unclear: "Unclear if it matches the report" };

/** One AI photo check. Shown to movers and reviewers; it is an observation, never a decision. */
export function AssessmentCard({ assessment }: { assessment: AssessmentView }) {
  if (assessment.status !== "completed") {
    return (
      <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
        {assessment.status === "pending" ? "AI check in progress…" : assessment.errorMessage}
        <span className="block text-xs">{formatTime(assessment.createdAt)}</span>
      </div>
    );
  }
  const badge = AI_VERDICT_BADGE[assessment.verdict!];
  return (
    <div className="card space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={badge.tone}>{badge.text}</Badge>
        {assessment.severity && <Badge tone="neutral">{SEVERITY[assessment.severity]}</Badge>}
        {assessment.matchesReport && <span className="text-xs text-muted">{MATCHES[assessment.matchesReport]}</span>}
      </div>
      <p className="font-medium">{assessment.summary}</p>
      {assessment.observations.length > 0 && (
        <ul className="list-disc pl-5">
          {assessment.observations.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      )}
      {assessment.limitations && <p className="text-muted">Limits: {assessment.limitations}</p>}
      {assessment.retakeRequest && (
        <p className="rounded-lg bg-warn-bg px-3 py-2 text-warn">Better photo needed: {assessment.retakeRequest}</p>
      )}
      <p className="text-xs text-muted">
        {assessment.model} · {assessment.photoCount} photo{assessment.photoCount === 1 ? "" : "s"}
        {assessment.usedBaseline ? " + baseline" : ""} · {formatTime(assessment.createdAt)}
      </p>
    </div>
  );
}

/**
 * Damage photo button that sends each new photo to the AI check automatically.
 * The photo is saved first; if the check fails or the allowance is used up,
 * the photo still reaches the reviewer.
 */
export function DamagePhotoCheck({
  incidentId,
  evidenceRequestId,
  label,
  speakResult = false,
  showResult = true,
  onChanged,
}: {
  incidentId: string;
  evidenceRequestId?: string;
  label: string;
  speakResult?: boolean;
  /** False where the caller already lists the incident's checks. */
  showResult?: boolean;
  onChanged?: () => void;
}) {
  const [latest, setLatest] = useState<AssessmentView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const check = useCommand(
    (actionId: string) => apiSend<AssessmentView>("POST", `/api/incidents/${incidentId}/assessments`, { actionId }),
    {
      onSaved: (view) => {
        setLatest(view);
        onChanged?.();
        if (!speakResult) return;
        if (view.status === "completed") {
          void speak(`${view.summary} ${view.retakeRequest ? `Please take another photo: ${view.retakeRequest}` : "A reviewer will decide."}`);
        } else if (view.errorMessage) {
          void speak(view.errorMessage);
        }
      },
      onError: (error) => {
        if (error.code === "network") return;
        setUnavailable(error.message);
        onChanged?.();
      },
    },
  );

  return (
    <div className="space-y-2">
      <PhotoUpload
        target={{ kind: "incident", incidentId, evidenceRequestId }}
        label={latest?.retakeRequest ? "Take another photo" : label}
        onUploaded={() => {
          setUnavailable(null);
          onChanged?.();
          void check.run(null);
        }}
      />
      {check.saving && (
        <p role="status" className="text-sm text-muted">
          Checking the photo with AI…
        </p>
      )}
      {check.status === "unsent" && (
        <p role="alert" className="text-sm text-warn">
          The photo is saved, but the AI check didn&apos;t reach the server.{" "}
          <button type="button" className="font-semibold underline" onClick={check.retry}>
            Retry check
          </button>
        </p>
      )}
      {unavailable && (
        <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
          Photo saved. No AI check: {unavailable} A reviewer will look at the photo.
        </p>
      )}
      {latest && showResult && <AssessmentCard assessment={latest} />}
    </div>
  );
}
