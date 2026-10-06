import { getIncident } from "@/domain/incidents";
import { route } from "@/server/http";

export const GET = route<{ incidentId: string }>("incident.get", ({ ctx, actor, params, note }) => {
  const detail = getIncident(ctx, actor, params.incidentId);
  note({ moveId: detail.incident.moveId });
  return detail;
});
