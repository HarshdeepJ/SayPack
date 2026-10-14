"use client";

import { useRef, useState, type FormEvent } from "react";
import { DamagePhotoCheck } from "@/components/damage-check";
import { SaveStatus, formatTime } from "@/components/ui";
import { apiSend, apiUpload, preparePhoto, useCommand } from "@/lib/client-api";
import type { HoldView, IncidentSummary, MoveHoldBrief, PhotoView } from "@/lib/types";

export function PhotoGrid({ photos, empty }: { photos: PhotoView[]; empty: string }) {
  if (photos.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="grid grid-cols-3 gap-2">
      {photos.map((photo) => (
        <li key={photo.id}>
          {photo.available ? (
            <a href={`/api/photos/${photo.id}`} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element -- private, authorized endpoint; next/image would proxy it */}
              <img
                src={`/api/photos/${photo.id}`}
                alt={`${photo.kind === "baseline" ? "Baseline" : "Incident"} photo by ${photo.uploadedByName}, ${formatTime(photo.createdAt)}`}
                loading="lazy"
                className="aspect-square w-full rounded-lg border border-border object-cover"
              />
            </a>
          ) : (
            <div className="flex aspect-square items-center justify-center rounded-lg border border-danger bg-danger-bg p-2 text-center text-xs text-danger">
              File missing — not valid evidence
            </div>
          )}
          <p className="mt-1 truncate text-xs text-muted">{formatTime(photo.createdAt)}</p>
        </li>
      ))}
    </ul>
  );
}

export interface UploadTarget {
  kind: "baseline" | "incident";
  itemId?: string;
  incidentId?: string;
  evidenceRequestId?: string;
}

/**
 * Camera/file button. The upload keeps its action ID across a network failure,
 * so Retry cannot store the same photo twice.
 */
export function PhotoUpload({
  target,
  label,
  onUploaded,
}: {
  target: UploadTarget;
  label: string;
  onUploaded: (photo: PhotoView) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useCommand(
    async (actionId, blob: Blob) => {
      const form = new FormData();
      form.set("actionId", actionId);
      form.set("kind", target.kind);
      if (target.itemId) form.set("itemId", target.itemId);
      if (target.incidentId) form.set("incidentId", target.incidentId);
      if (target.evidenceRequestId) form.set("evidenceRequestId", target.evidenceRequestId);
      form.set("file", blob, "photo.jpg");
      return apiUpload<PhotoView>("/api/photos", form);
    },
    { onSaved: (photo) => onUploaded(photo) },
  );

  async function choose(file: File | undefined) {
    if (!file) return;
    const blob = await preparePhoto(file);
    if (inputRef.current) inputRef.current.value = "";
    void upload.run(blob);
  }

  return (
    <div className="space-y-2">
      <label className={`btn w-full cursor-pointer ${upload.saving ? "pointer-events-none opacity-50" : ""}`}>
        <span aria-hidden>📷</span> {upload.saving ? "Uploading…" : label}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="sr-only"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </label>
      <SaveStatus status={upload.status} error={upload.error} onRetry={upload.retry} savedText="Photo saved." />
    </div>
  );
}

/** Damage is saved first; the photo prompt appears only after the report is committed. */
export function ReportDamageForm({
  moveId,
  itemId,
  itemLabel,
  onReported,
  onCancel,
}: {
  moveId: string;
  itemId: string | null;
  itemLabel: string | null;
  onReported: (incident: IncidentSummary) => void;
  onCancel: () => void;
}) {
  const [saved, setSaved] = useState<IncidentSummary | null>(null);
  const report = useCommand(
    (actionId, text: string) =>
      apiSend<IncidentSummary>("POST", `/api/moves/${moveId}/incidents`, { actionId, itemId, report: text }),
    {
      onSaved: (incident) => {
        setSaved(incident);
        onReported(incident);
      },
    },
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void report.run(String(new FormData(event.currentTarget).get("report") ?? ""));
  }

  if (saved) {
    return (
      <div className="card space-y-3 border-danger p-4">
        <p role="status" className="font-medium text-ok">
          ✓ Damage report saved{saved.itemId ? " and the item is on hold" : ""}. Reviewers can see it now.
        </p>
        {!saved.itemId && (
          <p className="text-sm text-muted">No item was selected, so a reviewer will identify it.</p>
        )}
        <DamagePhotoCheck incidentId={saved.id} label="Add a photo of the damage" />
        <button type="button" className="btn w-full" onClick={onCancel}>
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-3 border-danger p-4">
      <h3 className="font-semibold text-danger">Report damage{itemLabel ? `: ${itemLabel}` : ""}</h3>
      <div>
        <label htmlFor="damage-report" className="label">
          What is damaged?
        </label>
        <textarea
          id="damage-report"
          name="report"
          required
          maxLength={1000}
          rows={3}
          className="input py-2"
          placeholder="e.g. Dent on the lid, found while wrapping"
        />
      </div>
      <p className="text-xs text-muted">The report is saved before any photo, so reviewers see it straight away.</p>
      <div className="flex gap-2">
        <button type="submit" className="btn flex-1 border-danger bg-danger text-white" disabled={report.saving}>
          Save report
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <SaveStatus status={report.status} error={report.error} onRetry={report.retry} />
    </form>
  );
}

/** Whole-move holds, shown wherever packing happens. */
export function MoveHoldBanner({ holds }: { holds: MoveHoldBrief[] }) {
  if (holds.length === 0) return null;
  return (
    <div role="alert" className="rounded-xl border-2 border-danger bg-danger-bg p-4 text-danger">
      <p className="font-semibold">⛔ Whole move on hold — do not pack or seal boxes</p>
      <ul className="mt-1 list-disc pl-5 text-sm">
        {holds.map((h) => (
          <li key={h.id}>
            {h.reason} <span className="opacity-80">({h.createdByName}, {formatTime(h.createdAt)})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HoldList({ holds }: { holds: HoldView[] }) {
  if (holds.length === 0) return null;
  return (
    <div role="alert" className="rounded-xl border-2 border-danger bg-danger-bg p-3 text-sm text-danger">
      <p className="font-semibold">⛔ On hold — do not pack</p>
      <ul className="mt-1 list-disc pl-5">
        {holds.map((h) => (
          <li key={h.id}>
            {h.scope === "move" ? "Whole move: " : ""}
            {h.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
