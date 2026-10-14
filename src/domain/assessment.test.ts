import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockProvider } from "@/ai/mock";
import type { Actor } from "./core";
import type { AiProvider, AssessInput, InterpretResult } from "./ai";
import { assessIncident, MAX_ASSESSMENTS_PER_INCIDENT } from "./assessment";
import { updateAiSettings, usageSummary } from "./budget";
import { attachPhoto, type PhotoTarget } from "./evidence";
import { decideIncident, getIncident, reportDamage } from "./incidents";
import { createBox, recordItem } from "./inventory-mutations";
import { aid, moveFixture, testCtx, type TestCtx } from "./test-support";

class Scripted implements AiProvider {
  readonly name = "scripted";
  readonly overheadChars = 100;
  readonly assessOverheadChars = 100;
  calls: AssessInput[] = [];
  constructor(
    readonly model: string,
    private readonly respond: (input: AssessInput) => Promise<InterpretResult> | InterpretResult,
  ) {}
  async interpret(): Promise<InterpretResult> {
    throw new Error("not used in assessment tests");
  }
  async assessDamage(input: AssessInput) {
    this.calls.push(input);
    return this.respond(input);
  }
}

const crack: InterpretResult = {
  kind: "ok",
  raw: {
    verdict: "damage_visible",
    summary: "A crack about 3 cm long is visible on the rim.",
    observations: ["Crack on the rim, about 3 cm"],
    severity: "moderate",
    matches_report: "yes",
    limitations: null,
    retake_request: null,
  },
  usage: { inputTokens: 1500, audioTokens: 0, outputTokens: 120 },
};

function upload(ctx: TestCtx, actor: Actor, moveId: string, target: PhotoTarget) {
  const photoId = crypto.randomUUID();
  return attachPhoto(ctx, actor, aid(), target, {
    photoId,
    storageKey: `${moveId}/${photoId}.jpg`,
    mediaType: "image/jpeg",
    sizeBytes: 1234,
    sha256: crypto.randomBytes(32).toString("hex"),
  }).photo;
}

function setup() {
  const ctx = testCtx();
  const f = moveFixture(ctx);
  const box = createBox(ctx, f.mover, aid(), { moveId: f.move.id, label: "A" });
  const vase = recordItem(ctx, f.mover, aid(), { moveId: f.move.id, boxId: box.id, description: "Blue vase" });
  const incident = reportDamage(ctx, f.mover, aid(), { moveId: f.move.id, itemId: vase.id, report: "Crack on the rim" });
  const addDamagePhoto = () => upload(ctx, f.mover, f.move.id, { kind: "incident", incidentId: incident.id });
  return { ctx, ...f, vase, incident, addDamagePhoto };
}

describe("AI damage photo checks", () => {
  it("records what the AI sees without touching the hold", async () => {
    const { ctx, mover, reviewer, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    const provider = new Scripted("gemini-3.5-flash-lite", () => crack);

    const view = await assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id });

    expect(view).toMatchObject({ status: "completed", verdict: "damage_visible", matchesReport: "yes", photoCount: 1 });
    expect(provider.calls[0]).toMatchObject({ report: "Crack on the rim", itemDescription: "Blue vase", baseline: null });
    const detail = getIncident(ctx, reviewer, incident.id);
    expect(detail.incident).toMatchObject({ aiVerdict: "damage_visible", holdActive: true, status: "open" });
    expect(detail.assessments).toHaveLength(1);
    expect(usageSummary(ctx).settledSgd).toBeGreaterThan(0);
  });

  it("a 'no damage' verdict still leaves the item held for the reviewer", async () => {
    const { ctx, mover, reviewer, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    const provider = new MockProvider();
    const noDamage = reportDamage(ctx, mover, aid(), {
      moveId: incident.moveId,
      itemId: incident.itemId,
      report: "simulate no damage",
    });
    upload(ctx, mover, incident.moveId, { kind: "incident", incidentId: noDamage.id });

    const view = await assessIncident(ctx, provider, mover, aid(), { incidentId: noDamage.id });

    expect(view.verdict).toBe("no_damage_visible");
    expect(getIncident(ctx, reviewer, noDamage.id).incident).toMatchObject({ holdActive: true, status: "open" });
  });

  it("sends the item's baseline photo and only the newest damage photos", async () => {
    const { ctx, mover, move, vase, incident, addDamagePhoto } = setup();
    upload(ctx, mover, move.id, { kind: "baseline", itemId: vase.id });
    for (let i = 0; i < 4; i++) addDamagePhoto();
    const provider = new Scripted("gemini-3.5-flash-lite", () => crack);

    const view = await assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id });

    expect(view).toMatchObject({ photoCount: 3, usedBaseline: true });
    expect(provider.calls[0].photos).toHaveLength(3);
    expect(provider.calls[0].baseline).not.toBeNull();
  });

  it("needs a photo first", async () => {
    const { ctx, mover, incident } = setup();
    await expect(assessIncident(ctx, new MockProvider(), mover, aid(), { incidentId: incident.id })).rejects.toMatchObject({
      code: "invalid",
      reason: "no_photo",
    });
  });

  it("owners cannot run checks, and resolved incidents are not checked", async () => {
    const { ctx, owner, reviewer, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    await expect(assessIncident(ctx, new MockProvider(), owner, aid(), { incidentId: incident.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    decideIncident(ctx, reviewer, aid(), {
      incidentId: incident.id,
      expectedRevision: getIncident(ctx, reviewer, incident.id).incident.revision,
      action: "continue",
      reason: null,
    });
    await expect(assessIncident(ctx, new MockProvider(), reviewer, aid(), { incidentId: incident.id })).rejects.toMatchObject({
      reason: "incident_resolved",
    });
  });

  it("retrying with the same action ID returns the first result without a second call", async () => {
    const { ctx, mover, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    const provider = new Scripted("gemini-3.5-flash-lite", () => crack);
    const actionId = aid();
    const first = await assessIncident(ctx, provider, mover, actionId, { incidentId: incident.id });
    const second = await assessIncident(ctx, provider, mover, actionId, { incidentId: incident.id });
    expect(second).toEqual(first);
    expect(provider.calls).toHaveLength(1);
  });

  it("a timeout keeps the estimate charged and stores a visible failure", async () => {
    const { ctx, mover, reviewer, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    const provider = new Scripted("gemini-3.5-flash-lite", ({ signal }) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "unknown", reason: "timeout" }))),
    );

    const view = await assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id }, { timeoutMs: 10 });

    expect(view).toMatchObject({ status: "failed", verdict: null });
    expect(view.errorMessage).toMatch(/A reviewer will look at the photo/);
    expect(usageSummary(ctx)).toMatchObject({ uncertainRequests: 1 });
    expect(getIncident(ctx, reviewer, incident.id).incident).toMatchObject({ aiVerdict: null, holdActive: true });
  });

  it("an unusable answer is billed but stored as a failure", async () => {
    const { ctx, mover, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    const provider = new Scripted("gemini-3.5-flash-lite", () => ({
      kind: "ok",
      raw: { verdict: "probably" },
      usage: { inputTokens: 1000, audioTokens: 0, outputTokens: 10 },
    }));
    const view = await assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id });
    expect(view).toMatchObject({ status: "failed", verdict: null });
    expect(usageSummary(ctx).settledSgd).toBeGreaterThan(0);
  });

  it("a missing photo file releases the reservation and does not trip the breaker", async () => {
    const { ctx, mover, incident, addDamagePhoto } = setup();
    const photo = addDamagePhoto();
    const row = ctx.db.get(ctx.db.q.selectFrom("photos").select("storage_key").where("id", "=", photo.id))!;
    // Exists for the pre-check but fails to read.
    ctx.photos.read = async () => {
      throw new Error(`gone ${row.storage_key}`);
    };
    const provider = new Scripted("gemini-3.5-flash-lite", () => crack);
    const view = await assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id });
    expect(view.errorMessage).toMatch(/could not be read/);
    expect(provider.calls).toHaveLength(0);
    expect(usageSummary(ctx)).toMatchObject({ heldSgd: 0, settledSgd: 0, breakerOpenUntil: null });
  });

  it("refuses when the allowance is used up; the incident is unaffected", async () => {
    const { ctx, admin, mover, reviewer, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    updateAiSettings(ctx, admin, aid(), { allowanceSgd: 0, usdToSgd: 1.35 });
    const provider = new Scripted("gemini-3.5-flash-lite", () => crack);
    await expect(assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id })).rejects.toMatchObject({
      code: "unavailable",
      reason: "allowance_exhausted",
    });
    expect(provider.calls).toHaveLength(0);
    const detail = getIncident(ctx, reviewer, incident.id);
    expect(detail.assessments).toHaveLength(0);
    expect(detail.incident.holdActive).toBe(true);
  });

  it(`limits each incident to ${MAX_ASSESSMENTS_PER_INCIDENT} checks`, async () => {
    const { ctx, mover, incident, addDamagePhoto } = setup();
    addDamagePhoto();
    const provider = new MockProvider();
    for (let i = 0; i < MAX_ASSESSMENTS_PER_INCIDENT; i++) {
      await assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id });
    }
    await expect(assessIncident(ctx, provider, mover, aid(), { incidentId: incident.id })).rejects.toMatchObject({
      reason: "assessment_limit",
    });
  });

  it("works for incidents whose item is not identified yet", async () => {
    const { ctx, mover, move } = setup();
    const unknown = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: null, report: "Something rattles" });
    upload(ctx, mover, move.id, { kind: "incident", incidentId: unknown.id });
    const provider = new Scripted("gemini-3.5-flash-lite", () => crack);
    const view = await assessIncident(ctx, provider, mover, aid(), { incidentId: unknown.id });
    expect(view.status).toBe("completed");
    expect(provider.calls[0]).toMatchObject({ itemDescription: null, baseline: null });
  });

});
