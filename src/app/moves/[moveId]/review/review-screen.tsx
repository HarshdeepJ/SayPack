"use client";

import { useCallback, useState } from "react";
import { MoveHoldBanner } from "@/components/evidence";
import { IncidentPanel } from "@/components/incident-panel";
import { Badge, SaveStatus, formatTime } from "@/components/ui";
import { apiGet, apiSend, useCommand, usePolling } from "@/lib/client-api";
import { incidentBadges } from "@/lib/incident-text";
import type { HoldView, IncidentSummary, MoveHoldBrief, MoveOverview } from "@/lib/types";

type Tab = "unresolved" | "resolved";

export function ReviewScreen({ initialOverview }: { initialOverview: MoveOverview }) {
  const moveId = initialOverview.move.id;
  const [overview, setOverview] = useState(initialOverview);
  const [tab, setTab] = useState<Tab>("unresolved");
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ov, list] = await Promise.all([
      apiGet<MoveOverview>(`/api/moves/${moveId}`),
      apiGet<IncidentSummary[]>(`/api/moves/${moveId}/incidents?filter=${tab}`),
    ]);
    if (ov.ok) setOverview(ov.data);
    if (list.ok) setIncidents(list.data);
  }, [moveId, tab]);

  usePolling(load, 4000);

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[1fr_20rem]">
      <section aria-labelledby="queue-heading" className="min-w-0 space-y-3">
        <MoveHoldBanner holds={overview.moveHolds} />
        <div className="flex flex-wrap items-center gap-2">
          <h1 id="queue-heading" className="text-xl font-semibold">
            {overview.canReview ? "Incident queue" : "Damage reports"}
          </h1>
          <div role="tablist" aria-label="Incident filter" className="ml-auto flex gap-1">
            {(["unresolved", "resolved"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                aria-selected={tab === t}
                onClick={() => {
                  setTab(t);
                  setIncidents(null);
                }}
                className="btn min-h-9 px-3 capitalize aria-selected:border-accent aria-selected:font-semibold"
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {tab === "unresolved" && <p className="text-sm text-muted">Oldest first, so nothing waits unseen.</p>}

        {incidents === null ? (
          <p className="text-muted">Loading…</p>
        ) : incidents.length === 0 ? (
          <p className="card p-4 text-muted">{tab === "unresolved" ? "Nothing waiting for review." : "No resolved incidents yet."}</p>
        ) : (
          <ul className="space-y-2">
            {incidents.map((incident) => (
              <li key={incident.id}>
                <button
                  type="button"
                  onClick={() => setOpen(incident.id)}
                  className="card w-full space-y-1 p-4 text-left hover:bg-surface-2"
                >
                  <span className="flex flex-wrap gap-1">
                    {incidentBadges(incident).map((b) => (
                      <Badge key={b.text} tone={b.tone}>
                        {b.text}
                      </Badge>
                    ))}
                  </span>
                  <span className="block font-medium">
                    {incident.itemDescription ?? "Unidentified item"}
                    {incident.boxLabel && <span className="font-normal text-muted"> · Box {incident.boxLabel}</span>}
                  </span>
                  <span className="block text-sm">{incident.report}</span>
                  <span className="block text-xs text-muted">
                    Reported by {incident.reportedByName}, {formatTime(incident.createdAt)} · {incident.photoCount} photo
                    {incident.photoCount === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside>{overview.canReview && <MoveHolds moveId={moveId} holds={overview.moveHolds} onChanged={load} />}</aside>

      {open && <IncidentPanel incidentId={open} onClose={() => setOpen(null)} onChanged={load} />}
    </main>
  );
}

function MoveHolds({ moveId, holds, onChanged }: { moveId: string; holds: MoveHoldBrief[]; onChanged: () => void }) {
  const place = useCommand(
    (actionId, reason: string) => apiSend<HoldView>("POST", `/api/moves/${moveId}/holds`, { actionId, reason }),
    { onSaved: onChanged },
  );
  const release = useCommand(
    (actionId, input: { hold: MoveHoldBrief; reason: string }) =>
      apiSend<HoldView>("POST", `/api/holds/${input.hold.id}/release`, {
        actionId,
        expectedRevision: input.hold.revision,
        reason: input.reason,
      }),
    { onSaved: onChanged },
  );

  return (
    <section aria-labelledby="move-holds-heading" className="card space-y-3 p-4">
      <h2 id="move-holds-heading" className="font-semibold">
        Whole-move hold
      </h2>
      <p className="text-sm text-muted">
        Stops packing and sealing for every item. Use it when a problem can&apos;t be tied to one item safely.
      </p>
      {holds.map((hold) => (
        <form
          key={hold.id}
          className="space-y-2 rounded-lg bg-danger-bg p-3 text-sm text-danger"
          onSubmit={(e) => {
            e.preventDefault();
            void release.run({ hold, reason: String(new FormData(e.currentTarget).get("reason") ?? "") });
          }}
        >
          <p>
            <strong>Active:</strong> {hold.reason}
          </p>
          <label htmlFor={`release-${hold.id}`} className="label">
            Reason for release
          </label>
          <input id={`release-${hold.id}`} name="reason" className="input" required maxLength={500} />
          <button type="submit" className="btn w-full" disabled={release.saving}>
            Release whole-move hold
          </button>
        </form>
      ))}
      <SaveStatus status={release.status} error={release.error} onRetry={release.retry} savedText="Hold released." />
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const formEl = e.currentTarget;
          void place.run(String(new FormData(formEl).get("reason") ?? "")).then((r) => r.ok && formEl.reset());
        }}
      >
        <label htmlFor="hold-reason" className="label">
          Place a new whole-move hold
        </label>
        <input id="hold-reason" name="reason" className="input" required maxLength={500} placeholder="Reason" />
        <button type="submit" className="btn w-full border-danger text-danger" disabled={place.saving}>
          Hold the whole move
        </button>
      </form>
      <SaveStatus status={place.status} error={place.error} onRetry={place.retry} savedText="Move put on hold." />
    </section>
  );
}
