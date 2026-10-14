"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AssessmentCard, DamagePhotoCheck } from "@/components/damage-check";
import { PhotoGrid } from "@/components/evidence";
import { Badge, SaveStatus, formatTime } from "@/components/ui";
import { apiGet, apiSend, useCommand, usePolling, type ApiError } from "@/lib/client-api";
import { DECISION_LABEL, STATUS_LABEL, incidentBadges, nextStep } from "@/lib/incident-text";
import type { AssessmentView, IncidentDetail, IncidentSummary, ItemView } from "@/lib/types";

type Decision = "continue" | "repack" | "escalate" | "close";

export function IncidentPanel({
  incidentId,
  onClose,
  onChanged,
}: {
  incidentId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    const result = await apiGet<IncidentDetail>(`/api/incidents/${incidentId}`);
    if (result.ok) {
      setDetail(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.error.message);
    }
  }, [incidentId]);

  usePolling(reload, 4000);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changed = () => {
    void reload();
    onChanged?.();
  };
  const onError = (error: ApiError) => {
    if (error.reason === "stale_revision") void reload();
  };

  const decide = useCommand(
    (actionId, input: { revision: number; action: Decision; reason: string }) =>
      apiSend<IncidentSummary>("POST", `/api/incidents/${incidentId}/decision`, {
        actionId,
        expectedRevision: input.revision,
        action: input.action,
        reason: input.reason || null,
      }),
    { onSaved: changed, onError },
  );
  const repacked = useCommand(
    (actionId, revision: number) =>
      apiSend<IncidentSummary>("POST", `/api/incidents/${incidentId}/repacked`, { actionId, expectedRevision: revision }),
    { onSaved: changed, onError },
  );
  const release = useCommand(
    (actionId, input: { revision: number; reason: string }) =>
      apiSend<IncidentSummary>("POST", `/api/incidents/${incidentId}/release`, {
        actionId,
        expectedRevision: input.revision,
        reason: input.reason || null,
      }),
    { onSaved: changed, onError },
  );
  const requestEvidence = useCommand(
    (actionId, text: string) =>
      apiSend("POST", `/api/incidents/${incidentId}/evidence-requests`, { actionId, requestText: text }),
    { onSaved: changed },
  );
  const cancelRequest = useCommand(
    (actionId, input: { id: string; revision: number }) =>
      apiSend("POST", `/api/evidence-requests/${input.id}/cancel`, { actionId, expectedRevision: input.revision }),
    { onSaved: changed, onError },
  );

  const incident = detail?.incident;
  const openRequests = detail?.evidenceRequests.filter((r) => r.status === "open") ?? [];
  const resolved = incident?.status === "resolved";

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="incident-title"
        className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-bg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
          <h2 id="incident-title" className="min-w-0 flex-1 truncate font-semibold">
            Damage: {incident?.itemDescription ?? "item not identified"}
          </h2>
          <button ref={closeRef} type="button" className="btn min-h-9 px-3" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="space-y-5 p-4">
          {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
          {!detail || !incident ? (
            !loadError && <p className="text-muted">Loading…</p>
          ) : (
            <>
              <section className="card space-y-2 p-4">
                <div className="flex flex-wrap gap-1">
                  {incidentBadges(incident).map((b) => (
                    <Badge key={b.text} tone={b.tone}>
                      {b.text}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm">
                  <span className="text-muted">Mover report</span> ({incident.reportedByName},{" "}
                  {formatTime(incident.createdAt)}, {incident.stage}):
                </p>
                <blockquote className="border-l-4 border-border pl-3">{incident.report}</blockquote>
                <p className="text-sm">
                  <strong>Status:</strong> {STATUS_LABEL[incident.status]}
                  {incident.boxLabel ? ` · Box ${incident.boxLabel}` : ""}
                </p>
                <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm font-medium">Next: {nextStep(incident)}</p>
              </section>

              {!incident.itemId && !resolved && detail.canWrite && (
                <IdentifyItem incident={incident} onDone={changed} onError={onError} />
              )}

              <section aria-labelledby="evidence-heading" className="space-y-3">
                <h3 id="evidence-heading" className="font-semibold">
                  Evidence
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-muted">Baseline (before packing)</h4>
                    <PhotoGrid
                      photos={detail.baselinePhotos}
                      empty={incident.itemId ? "No baseline photo was taken." : "Identify the item to see its baseline."}
                    />
                  </div>
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-muted">Reported damage</h4>
                    <PhotoGrid photos={detail.incidentPhotos} empty="No damage photos yet." />
                  </div>
                </div>
                {!resolved && detail.canWrite && openRequests.length === 0 && (
                  <DamagePhotoCheck incidentId={incident.id} label="Add damage photo" showResult={false} onChanged={changed} />
                )}
              </section>

              <section aria-labelledby="ai-heading" className="space-y-2">
                <h3 id="ai-heading" className="font-semibold">
                  AI photo check
                </h3>
                <p className="text-xs text-muted">
                  The AI describes what the photos show. It cannot tell when, how or by whom damage happened, and it never
                  releases a hold. {detail.canReview ? "You decide." : "A reviewer decides."}
                </p>
                {detail.assessments.length === 0 ? (
                  <p className="text-sm text-muted">
                    {detail.incidentPhotos.length === 0 ? "Runs when a damage photo is added." : "Not checked yet."}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {detail.assessments.map((a) => (
                      <li key={a.id}>
                        <AssessmentCard assessment={a} />
                      </li>
                    ))}
                  </ul>
                )}
                {!resolved && detail.canWrite && detail.incidentPhotos.length > 0 && (
                  <RecheckButton incidentId={incident.id} onDone={changed} />
                )}
              </section>

              {(detail.evidenceRequests.length > 0 || (detail.canReview && !resolved)) && (
                <section aria-labelledby="requests-heading" className="space-y-2">
                  <h3 id="requests-heading" className="font-semibold">
                    Evidence requests
                  </h3>
                  <ul className="space-y-2">
                    {detail.evidenceRequests.map((r) => (
                      <li key={r.id} className="card space-y-2 p-3 text-sm">
                        <p>
                          <Badge tone={r.status === "open" ? "warn" : r.status === "fulfilled" ? "ok" : "neutral"}>
                            {r.status}
                          </Badge>{" "}
                          {r.requestText}{" "}
                          <span className="text-muted">
                            ({r.requestedByName}, {formatTime(r.createdAt)})
                          </span>
                        </p>
                        {r.status === "open" && detail.canWrite && (
                          <DamagePhotoCheck
                            incidentId={incident.id}
                            evidenceRequestId={r.id}
                            label="Upload requested photo"
                            showResult={false}
                            onChanged={changed}
                          />
                        )}
                        {r.status === "open" && detail.canReview && (
                          <button
                            type="button"
                            className="text-accent underline"
                            disabled={cancelRequest.saving}
                            onClick={() => void cancelRequest.run({ id: r.id, revision: r.revision })}
                          >
                            Cancel request
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <SaveStatus status={cancelRequest.status} error={cancelRequest.error} onRetry={cancelRequest.retry} />
                  {detail.canReview && !resolved && (
                    <TextCommand
                      id="request-text"
                      label="Ask for more evidence"
                      placeholder="e.g. Close-up of the base, in daylight"
                      button="Send request"
                      command={requestEvidence}
                    />
                  )}
                </section>
              )}

              {incident.latestDecision === "repack" && !incident.repackedAt && !resolved && detail.canWrite && (
                <section className="card space-y-2 border-warn p-4">
                  <p className="font-medium">The reviewer asked for this item to be repacked.</p>
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    disabled={repacked.saving}
                    onClick={() => void repacked.run(incident.revision)}
                  >
                    Record repacking done
                  </button>
                  <SaveStatus status={repacked.status} error={repacked.error} onRetry={repacked.retry} savedText="Repack recorded." />
                </section>
              )}

              {detail.canReview && !resolved && (
                <DecisionForm
                  incident={incident}
                  decide={decide}
                  release={release}
                />
              )}

              <section aria-labelledby="decisions-heading">
                <h3 id="decisions-heading" className="mb-2 font-semibold">
                  Decisions
                </h3>
                {detail.decisions.length === 0 ? (
                  <p className="text-sm text-muted">No decision yet.</p>
                ) : (
                  <ol className="space-y-2">
                    {detail.decisions.map((d) => (
                      <li key={d.id} className="card p-3 text-sm">
                        <strong>{DECISION_LABEL[d.action]}</strong>{" "}
                        <span className="text-muted">
                          by {d.reviewerName}, {formatTime(d.createdAt)}
                        </span>
                        {d.reason && <p className="mt-1">{d.reason}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {detail.holds.length > 0 && (
                <section aria-labelledby="holds-heading">
                  <h3 id="holds-heading" className="mb-2 font-semibold">
                    Holds from this incident
                  </h3>
                  <ul className="space-y-2 text-sm">
                    {detail.holds.map((h) => (
                      <li key={h.id} className="card p-3">
                        <Badge tone={h.releasedAt ? "ok" : "danger"}>{h.releasedAt ? "Released" : "Active"}</Badge>{" "}
                        {h.scope === "move" ? "Whole move: " : ""}
                        {h.reason}
                        <span className="block text-xs text-muted">
                          Placed by {h.createdByName}, {formatTime(h.createdAt)}
                          {h.releasedAt &&
                            ` · Released by ${h.releasedByName}, ${formatTime(h.releasedAt)}${h.releaseReason ? `: ${h.releaseReason}` : ""}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type Command<TIn> = ReturnType<typeof useCommand<TIn, unknown>>;

function TextCommand({
  id,
  label,
  placeholder,
  button,
  command,
}: {
  id: string;
  label: string;
  placeholder: string;
  button: string;
  command: Command<string>;
}) {
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        void command.run(String(new FormData(formEl).get("text") ?? "")).then((r) => r.ok && formEl.reset());
      }}
    >
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="flex gap-2">
        <input id={id} name="text" className="input" required maxLength={500} placeholder={placeholder} />
        <button type="submit" className="btn" disabled={command.saving}>
          {button}
        </button>
      </div>
      <SaveStatus status={command.status} error={command.error} onRetry={command.retry} />
    </form>
  );
}

function DecisionForm({
  incident,
  decide,
  release,
}: {
  incident: IncidentSummary;
  decide: Command<{ revision: number; action: Decision; reason: string }>;
  release: Command<{ revision: number; reason: string }>;
}) {
  const [reason, setReason] = useState("");
  const hasItem = !!incident.itemId;
  const awaitingRelease = incident.latestDecision === "repack" && !!incident.repackedAt;
  const run = (action: Decision) => void decide.run({ revision: incident.revision, action, reason });

  function submitRelease(event: FormEvent) {
    event.preventDefault();
    void release.run({ revision: incident.revision, reason });
  }

  return (
    <section aria-labelledby="decide-heading" className="card space-y-3 border-accent p-4">
      <h3 id="decide-heading" className="font-semibold">
        Reviewer decision
      </h3>
      <div>
        <label htmlFor="decision-reason" className="label">
          Reason / instruction to the mover {hasItem ? "(optional)" : "(required to close)"}
        </label>
        <textarea
          id="decision-reason"
          rows={2}
          maxLength={500}
          className="input py-2"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      {awaitingRelease ? (
        <form onSubmit={submitRelease} className="space-y-2">
          <p className="text-sm">Repacking was recorded {formatTime(incident.repackedAt!)}. Check it, then release the hold.</p>
          <button type="submit" className="btn btn-primary w-full" disabled={release.saving}>
            Release hold and resolve
          </button>
        </form>
      ) : hasItem ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <button type="button" className="btn btn-primary" disabled={decide.saving} onClick={() => run("continue")}>
            Continue packing
          </button>
          <button
            type="button"
            className="btn"
            disabled={decide.saving || (incident.latestDecision === "repack" && !incident.repackedAt)}
            onClick={() => run("repack")}
          >
            Repack
          </button>
          <button
            type="button"
            className="btn"
            disabled={decide.saving || incident.status === "escalated"}
            onClick={() => run("escalate")}
          >
            Escalate
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            Continue and repack need the item identified. Without an item you can escalate, or close with a reason.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="btn" disabled={decide.saving || incident.status === "escalated"} onClick={() => run("escalate")}>
              Escalate
            </button>
            <button type="button" className="btn" disabled={decide.saving || !reason.trim()} onClick={() => run("close")}>
              Close (no item)
            </button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted">
        Continue releases only this incident&apos;s hold. Other incidents&apos; holds and whole-move holds stay active.
      </p>
      <SaveStatus status={decide.status} error={decide.error} onRetry={decide.retry} savedText="Decision recorded." />
      <SaveStatus status={release.status} error={release.error} onRetry={release.retry} savedText="Hold released." />
    </section>
  );
}

function IdentifyItem({
  incident,
  onDone,
  onError,
}: {
  incident: IncidentSummary;
  onDone: () => void;
  onError: (error: ApiError) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ItemView[]>([]);
  const identify = useCommand(
    (actionId, itemId: string) =>
      apiSend<IncidentSummary>("POST", `/api/incidents/${incident.id}/identify`, {
        actionId,
        expectedRevision: incident.revision,
        itemId,
      }),
    { onSaved: onDone, onError },
  );

  async function search(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams({ q: query, limit: "10" });
    const result = await apiGet<{ items: ItemView[] }>(`/api/moves/${incident.moveId}/items?${params}`);
    if (result.ok) setResults(result.data.items);
  }

  return (
    <section className="card space-y-3 border-danger p-4">
      <h3 className="font-semibold text-danger">Which item is damaged?</h3>
      <p className="text-sm text-muted">Choosing the item puts it on hold. The system never guesses.</p>
      <form onSubmit={search} className="flex gap-2">
        <label htmlFor="identify-query" className="sr-only">
          Search items
        </label>
        <input
          id="identify-query"
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search description or box"
        />
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      {results.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {results.map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-2">
              <span className="flex-1">
                {item.description}
                <span className="text-muted">{item.boxLabel ? ` · Box ${item.boxLabel}` : " · No box"}</span>
              </span>
              <button type="button" className="btn min-h-9 px-3" disabled={identify.saving} onClick={() => void identify.run(item.id)}>
                This one
              </button>
            </li>
          ))}
        </ul>
      )}
      <SaveStatus status={identify.status} error={identify.error} onRetry={identify.retry} savedText="Item identified and put on hold." />
    </section>
  );
}

/** Runs the AI check again on the newest photos, e.g. after a failed or unclear check. */
function RecheckButton({ incidentId, onDone }: { incidentId: string; onDone: () => void }) {
  const check = useCommand(
    (actionId: string) => apiSend<AssessmentView>("POST", `/api/incidents/${incidentId}/assessments`, { actionId }),
    { onSaved: onDone },
  );
  return (
    <div className="space-y-1">
      <button type="button" className="btn w-full" disabled={check.saving} onClick={() => void check.run(null)}>
        {check.saving ? "Checking…" : "Check photos with AI again"}
      </button>
      <SaveStatus status={check.status === "saved" ? "idle" : check.status} error={check.error} onRetry={check.retry} />
    </div>
  );
}
