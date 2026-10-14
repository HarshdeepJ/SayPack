import type { IncidentSummary } from "./types";

/** What happens next for an incident, in plain words for movers and owners. */
export function nextStep(incident: IncidentSummary): string {
  if (incident.status === "resolved") {
    return incident.latestDecision === "close" ? "Closed by the reviewer." : "Resolved. Packing may continue.";
  }
  if (!incident.itemId) return "Identify which item is affected.";
  if (incident.openEvidenceRequests > 0) return "The reviewer has asked for more photos.";
  if (incident.latestDecision === "repack") {
    return incident.repackedAt
      ? "Repacked. Waiting for the reviewer to release the hold."
      : "Repack this item, then record that it's done.";
  }
  if (incident.status === "escalated") return "Escalated. Keep this item on hold until further instruction.";
  return "Waiting for a reviewer decision. Do not pack this item.";
}

export const DECISION_LABEL: Record<string, string> = {
  continue: "Continue packing",
  repack: "Repack",
  escalate: "Escalate",
  close: "Close (no item)",
};

export const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  escalated: "Escalated",
  resolved: "Resolved",
};

/** How the latest AI photo check is labelled. It describes the photo; it never decides. */
export const AI_VERDICT_BADGE: Record<string, { text: string; tone: "danger" | "warn" | "ok" }> = {
  damage_visible: { text: "AI: damage visible", tone: "danger" },
  no_damage_visible: { text: "AI: no damage seen", tone: "ok" },
  inconclusive: { text: "AI: photo unclear", tone: "warn" },
};

/** Queue badges derived from the incident's records. */
export function incidentBadges(incident: IncidentSummary): { text: string; tone: "danger" | "warn" | "neutral" | "ok" }[] {
  const badges: { text: string; tone: "danger" | "warn" | "neutral" | "ok" }[] = [];
  if (incident.status === "resolved") return [{ text: "Resolved", tone: "ok" }];
  if (!incident.itemId) badges.push({ text: "Item unidentified", tone: "danger" });
  if (incident.status === "escalated") badges.push({ text: "Escalated", tone: "danger" });
  if (incident.openEvidenceRequests > 0) badges.push({ text: "Awaiting evidence", tone: "warn" });
  if (incident.photoCount === 0) badges.push({ text: "No photos", tone: "neutral" });
  if (incident.latestDecision === "repack") {
    badges.push(incident.repackedAt ? { text: "Repacked, release pending", tone: "warn" } : { text: "Repack requested", tone: "warn" });
  }
  if (incident.aiVerdict) badges.push(AI_VERDICT_BADGE[incident.aiVerdict]);
  if (!incident.latestDecision) badges.push({ text: "Needs decision", tone: "warn" });
  return badges;
}
