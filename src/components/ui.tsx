"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { apiSend, type ApiError, type CommandStatus } from "@/lib/client-api";

export function AppHeader({
  userName,
  isAdmin,
  title,
  back,
}: {
  userName: string;
  isAdmin: boolean;
  title?: string;
  back?: { href: string; label: string };
}) {
  const router = useRouter();
  async function signOut() {
    await apiSend("POST", "/api/auth/logout", {});
    router.replace("/login");
    router.refresh();
  }
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
        {back ? (
          <Link href={back.href} className="text-sm text-accent underline-offset-2 hover:underline">
            ← {back.label}
          </Link>
        ) : (
          <Link href="/moves" className="font-semibold">
            SayPack
          </Link>
        )}
        {title && <span className="truncate font-semibold">{title}</span>}
        <nav className="ml-auto flex items-center gap-3 text-sm">
          {isAdmin && (
            <Link href="/admin" className="text-accent underline-offset-2 hover:underline">
              Admin
            </Link>
          )}
          <span className="hidden text-muted sm:inline">{userName}</span>
          <button type="button" onClick={signOut} className="text-accent underline-offset-2 hover:underline">
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}

/** Save state in words, never colour alone. */
export function SaveStatus({
  status,
  error,
  onRetry,
  savedText = "Saved.",
}: {
  status: CommandStatus;
  error: ApiError | null;
  onRetry?: () => void;
  savedText?: string;
}) {
  if (status === "idle") return null;
  if (status === "saving") {
    return (
      <p role="status" className="text-sm text-muted">
        Saving…
      </p>
    );
  }
  if (status === "saved") {
    return (
      <p role="status" className="text-sm font-medium text-ok">
        ✓ {savedText}
      </p>
    );
  }
  if (status === "unsent") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
        <span>
          <strong>Not saved.</strong> {error?.message}
        </span>
        {onRetry && (
          <button type="button" className="font-semibold underline" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  return (
    <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
      <strong>Not saved.</strong> {error?.message}
    </p>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "danger" | "neutral"; children: ReactNode }) {
  const tones = {
    ok: "bg-ok-bg text-ok",
    warn: "bg-warn-bg text-warn",
    danger: "bg-danger-bg text-danger",
    neutral: "bg-surface-2 text-muted",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function BoxStatusBadge({ status }: { status: string }) {
  if (status === "sealed") return <Badge tone="warn">Sealed</Badge>;
  if (status === "delivered") return <Badge tone="ok">Delivered</Badge>;
  return <Badge tone="neutral">Open</Badge>;
}

export function ItemFlags({ fragile, valuable }: { fragile: boolean; valuable: boolean }) {
  return (
    <>
      {fragile && <Badge tone="danger">Fragile</Badge>}
      {valuable && <Badge tone="warn">Valuable</Badge>}
    </>
  );
}

/** Packing state in words: hold, packed, missing baseline. */
export function ItemStateBadges({
  item,
}: {
  item: { status: string; onHold: boolean; baselineMissing: boolean; openIncidents: number };
}) {
  return (
    <>
      {item.onHold && <Badge tone="danger">On hold</Badge>}
      {!item.onHold && item.openIncidents > 0 && <Badge tone="warn">Damage reported</Badge>}
      {item.status === "packed" && <Badge tone="ok">Packed</Badge>}
      {item.baselineMissing && <Badge tone="warn">Baseline missing</Badge>}
    </>
  );
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const ACTION_LABELS: Record<string, string> = {
  "item.recorded": "Recorded item",
  "item.updated": "Edited item",
  "item.box_assigned": "Moved item",
  "box.created": "Created box",
  "box.sealed": "Sealed box",
  "box.reopened": "Reopened box",
  "room.created": "Created room",
  "item.packed": "Marked packed",
  "item.condition_recorded": "Recorded condition",
  "item.damage_reported": "Damage reported",
  "item.decision_recorded": "Reviewer decision",
  "item.repacked": "Repacked",
  "photo.baseline_added": "Added baseline photo",
  "photo.incident_added": "Added damage photo",
  "incident.reported": "Reported damage",
  "incident.item_identified": "Identified damaged item",
  "incident.repacked": "Recorded repack",
  "incident.hold_released": "Released hold",
  "incident.decided_continue": "Decided: continue",
  "incident.decided_repack": "Decided: repack",
  "incident.decided_escalate": "Decided: escalate",
  "incident.decided_close": "Closed incident",
  "incident.ai_assessed": "AI checked damage photo",
  "incident.ai_assessment_failed": "AI photo check failed",
  "evidence.requested": "Requested evidence",
  "evidence.cancelled": "Cancelled evidence request",
  "hold.move_placed": "Placed whole-move hold",
  "hold.move_released": "Released whole-move hold",
};

export function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? action;
}

/** One-line summary of an audit entry's change, e.g. "description: Vase → Blue vase". */
export function describeChange(before: unknown, after: unknown): string {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
  if ("boxLabel" in a || "boxLabel" in b) return `box: ${show(b.boxLabel ?? "none")} → ${show(a.boxLabel ?? "none")}`;
  if (!before) {
    return [a.description, a.label, a.name, a.report, a.requestText, a.reason, a.note]
      .filter(Boolean)
      .map(String)
      .join(" · ");
  }
  return Object.keys(a)
    .map((k) => `${k}: ${show(b[k])} → ${show(a[k])}`)
    .join("; ");
}
