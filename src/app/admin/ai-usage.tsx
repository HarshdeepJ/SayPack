"use client";

import { useCallback, useState, type FormEvent } from "react";
import { Badge, SaveStatus, formatTime } from "@/components/ui";
import { apiGet, apiSend, useCommand, usePolling } from "@/lib/client-api";
import type { UsageSummary } from "@/lib/types";

type AiUsage = UsageSummary & { provider: string; model: string };

const sgd = (n: number) => `S$${n.toFixed(n < 1 ? 4 : 2)}`;

export function AiUsageCard() {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const load = useCallback(async () => {
    const result = await apiGet<AiUsage>("/api/admin/ai");
    if (result.ok) setUsage(result.data);
  }, []);
  usePolling(load, 15000);

  const update = useCommand(
    (actionId, input: { allowanceSgd: number; usdToSgd: number }) =>
      apiSend<AiUsage>("POST", "/api/admin/ai", { actionId, ...input }),
    { onSaved: (data) => setUsage(data) },
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void update.run({ allowanceSgd: Number(form.get("allowance")), usdToSgd: Number(form.get("rate")) });
  }

  if (!usage) return null;
  const spent = usage.settledSgd + usage.heldSgd;
  const pct = usage.allowanceSgd > 0 ? Math.min(100, (spent / usage.allowanceSgd) * 100) : 100;

  return (
    <section aria-labelledby="ai-heading" className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="ai-heading" className="font-semibold">
          AI usage
        </h2>
        <Badge tone={usage.provider === "mock" ? "neutral" : "ok"}>
          {usage.provider === "mock" ? "Mock (no charges)" : `Gemini · ${usage.model}`}
        </Badge>
        {usage.exhausted && <Badge tone="danger">Allowance used up</Badge>}
        {usage.breakerOpenUntil && <Badge tone="warn">Paused until {formatTime(usage.breakerOpenUntil)}</Badge>}
      </div>

      <div>
        <div className="flex justify-between text-sm">
          <span>
            {sgd(spent)} of {sgd(usage.allowanceSgd)} used
          </span>
          <strong>{sgd(usage.remainingSgd)} left</strong>
        </div>
        <div
          className="mt-1 h-2 overflow-hidden rounded bg-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label="Allowance used"
        >
          <div className={`h-full ${pct > 90 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">Settled cost</dt>
        <dd>{sgd(usage.settledSgd)}</dd>
        <dt className="text-muted">Held (in flight or unknown)</dt>
        <dd>{sgd(usage.heldSgd)}</dd>
        <dt className="text-muted">Requests</dt>
        <dd>
          {usage.requests}
          {usage.uncertainRequests > 0 ? ` (${usage.uncertainRequests} outcome unknown)` : ""}
        </dd>
      </dl>
      <p className="text-xs text-muted">
        An estimate kept by SayPack, not a billing cap enforced by Google. Prices are in USD and converted at the rate below;
        check both against your Google billing.
      </p>

      <form onSubmit={submit} className="grid grid-cols-2 gap-2" key={usage.updatedAt}>
        <div>
          <label htmlFor="ai-allowance" className="label">
            Allowance (S$)
          </label>
          <input id="ai-allowance" name="allowance" type="number" step="0.01" min="0" defaultValue={usage.allowanceSgd} className="input" />
        </div>
        <div>
          <label htmlFor="ai-rate" className="label">
            USD → SGD rate
          </label>
          <input id="ai-rate" name="rate" type="number" step="0.0001" min="0.5" defaultValue={usage.usdToSgd} className="input" />
        </div>
        <button type="submit" className="btn col-span-2" disabled={update.saving}>
          Save AI settings
        </button>
      </form>
      <SaveStatus status={update.status} error={update.error} onRetry={update.retry} />
    </section>
  );
}
