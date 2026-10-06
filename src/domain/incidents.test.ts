import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Actor } from "./core";
import {
  attachPhoto,
  markPacked,
  photoForDownload,
  precheckPhoto,
  recordObservation,
  type PhotoTarget,
} from "./evidence";
import {
  cancelEvidenceRequest,
  decideIncident,
  getIncident,
  identifyIncidentItem,
  listIncidents,
  placeMoveHold,
  recordRepack,
  releaseAfterRepack,
  releaseMoveHold,
  reportDamage,
  requestEvidence,
} from "./incidents";
import { getMoveOverview, searchItems } from "./inventory";
import { assignItemToBox, createBox, recordItem, reopenBox, sealBox, updateItem } from "./inventory-mutations";
import { addMember, createMove } from "./moves";
import { aid, expectDomainError, moveFixture, testCtx, type TestCtx } from "./test-support";
import { getItemDetail } from "./views";

function setup() {
  const ctx = testCtx();
  const f = moveFixture(ctx);
  const boxA = createBox(ctx, f.mover, aid(), { moveId: f.move.id, label: "A" });
  const boxB = createBox(ctx, f.mover, aid(), { moveId: f.move.id, label: "B" });
  const vase = recordItem(ctx, f.mover, aid(), {
    moveId: f.move.id,
    boxId: boxA.id,
    description: "Blue vase",
    fragile: true,
  });
  const lamp = recordItem(ctx, f.mover, aid(), { moveId: f.move.id, boxId: boxA.id, description: "Lamp" });
  return { ctx, ...f, boxA, boxB, vase, lamp };
}

function upload(ctx: TestCtx, actor: Actor, moveId: string, target: PhotoTarget, actionId = aid()) {
  const photoId = crypto.randomUUID();
  return attachPhoto(ctx, actor, actionId, target, {
    photoId,
    storageKey: `${moveId}/${photoId}.jpg`,
    mediaType: "image/jpeg",
    sizeBytes: 1234,
    sha256: crypto.randomBytes(32).toString("hex"),
  });
}

const rev = (ctx: TestCtx, actor: Actor, incidentId: string) => getIncident(ctx, actor, incidentId).incident.revision;

describe("packing and baseline photos", () => {
  it("a fragile item needs an available baseline photo before it is packed", () => {
    const { ctx, mover, move, vase } = setup();
    expectDomainError(
      () => markPacked(ctx, mover, aid(), { itemId: vase.id, expectedRevision: vase.revision }),
      "invalid",
      "baseline_required",
    );

    const { photo } = upload(ctx, mover, move.id, { kind: "baseline", itemId: vase.id });
    ctx.missingPhotos.add(`${move.id}/${photo.id}.jpg`);
    expectDomainError(
      () => markPacked(ctx, mover, aid(), { itemId: vase.id, expectedRevision: vase.revision }),
      "invalid",
      "baseline_required",
    );
    expect(getItemDetail(ctx, mover, vase.id).baselinePhotos[0].available).toBe(false);

    ctx.missingPhotos.clear();
    expect(markPacked(ctx, mover, aid(), { itemId: vase.id, expectedRevision: vase.revision }).status).toBe("packed");
  });

  it("a standard item can be packed without a photo, but only from a box", () => {
    const { ctx, mover, move, lamp } = setup();
    expect(markPacked(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: 1 }).status).toBe("packed");
    const rug = recordItem(ctx, mover, aid(), { moveId: move.id, description: "Rug" });
    expectDomainError(() => markPacked(ctx, mover, aid(), { itemId: rug.id, expectedRevision: 1 }), "invalid", "no_box");
  });

  it("flagging an item fragile after packing leaves it packed and shows the missing baseline", () => {
    const { ctx, mover, lamp } = setup();
    markPacked(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: 1 });
    const flagged = updateItem(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: 2, fragile: true });
    expect(flagged).toMatchObject({ status: "packed", baselineMissing: true });
  });

  it("moving a packed item to another box returns it to recorded", () => {
    const { ctx, mover, lamp, boxB } = setup();
    const packed = markPacked(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: 1 });
    const moved = assignItemToBox(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: packed.revision, boxId: boxB.id });
    expect(moved.status).toBe("recorded");
  });

  it("records condition observations with their source", () => {
    const { ctx, mover, owner, vase } = setup();
    recordObservation(ctx, mover, aid(), { itemId: vase.id, stage: "packing", condition: "existing_wear", note: "Chip on base" });
    expect(getItemDetail(ctx, owner, vase.id).observations[0]).toMatchObject({
      condition: "existing_wear",
      note: "Chip on base",
      recordedByName: "Mover",
    });
    expectDomainError(
      () => recordObservation(ctx, owner, aid(), { itemId: vase.id, stage: "packing", condition: "no_visible_damage" }),
      "forbidden",
    );
  });
});

describe("photos", () => {
  it("a retried upload returns the committed photo instead of storing it twice", () => {
    const { ctx, mover, move, vase } = setup();
    const actionId = aid();
    const photoId = crypto.randomUUID();
    const file = {
      photoId,
      storageKey: `${move.id}/${photoId}.jpg`,
      mediaType: "image/jpeg" as const,
      sizeBytes: 10,
      sha256: "a".repeat(64),
    };
    const target = { kind: "baseline" as const, itemId: vase.id };
    expect(precheckPhoto(ctx, mover, actionId, target, file.sha256)).toBeNull();
    const first = attachPhoto(ctx, mover, actionId, target, file);
    expect(first.replayed).toBe(false);

    expect(precheckPhoto(ctx, mover, actionId, target, file.sha256)?.id).toBe(photoId);
    const second = attachPhoto(ctx, mover, actionId, target, { ...file, photoId: crypto.randomUUID() });
    expect(second).toMatchObject({ replayed: true, photo: { id: photoId } });
    expect(getItemDetail(ctx, mover, vase.id).baselinePhotos).toHaveLength(1);
  });

  it("only members can download, and a missing file is reported as unavailable", () => {
    const { ctx, mover, outsider, owner, move, vase } = setup();
    const { photo } = upload(ctx, mover, move.id, { kind: "baseline", itemId: vase.id });
    expect(photoForDownload(ctx, owner, photo.id).mediaType).toBe("image/jpeg");
    expectDomainError(() => photoForDownload(ctx, outsider, photo.id), "forbidden");
    ctx.missingPhotos.add(`${move.id}/${photo.id}.jpg`);
    expectDomainError(() => photoForDownload(ctx, owner, photo.id), "not_found", "photo_file_missing");
  });

  it("owners cannot upload evidence", () => {
    const { ctx, owner, move, vase } = setup();
    expectDomainError(() => upload(ctx, owner, move.id, { kind: "baseline", itemId: vase.id }), "forbidden");
  });

  it("an incident photo can fulfil an open evidence request; resolved incidents take no more", () => {
    const { ctx, mover, reviewer, move, vase } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Cracked rim" });
    const request = requestEvidence(ctx, reviewer, aid(), { incidentId: incident.id, requestText: "Photo of the base" });
    upload(ctx, mover, move.id, { kind: "incident", incidentId: incident.id, evidenceRequestId: request.id });
    expect(getIncident(ctx, reviewer, incident.id).evidenceRequests[0].status).toBe("fulfilled");

    decideIncident(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: rev(ctx, reviewer, incident.id), action: "continue" });
    expectDomainError(
      () => upload(ctx, mover, move.id, { kind: "incident", incidentId: incident.id }),
      "conflict",
      "incident_resolved",
    );
  });
});

describe("damage reports", () => {
  it("a report is saved at once with an item hold, before any photo", () => {
    const { ctx, mover, reviewer, move, vase } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Cracked rim" });
    expect(incident).toMatchObject({ status: "open", holdActive: true, photoCount: 0 });
    expect(listIncidents(ctx, reviewer, { moveId: move.id }).map((i) => i.id)).toEqual([incident.id]);
    expect(searchItems(ctx, mover, { moveId: move.id, held: true }).items.map((i) => i.id)).toEqual([vase.id]);
    expectDomainError(
      () => markPacked(ctx, mover, aid(), { itemId: vase.id, expectedRevision: getItemDetail(ctx, mover, vase.id).item.revision }),
      "conflict",
      "item_on_hold",
    );
  });

  it("an unidentified report creates no hold until the item is identified", () => {
    const { ctx, mover, reviewer, move, lamp } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, report: "Something rattles in box A" });
    expect(incident.holdActive).toBe(false);
    expect(getMoveOverview(ctx, reviewer, move.id).unidentifiedIncidents).toBe(1);

    const identified = identifyIncidentItem(ctx, reviewer, aid(), {
      incidentId: incident.id,
      expectedRevision: incident.revision,
      itemId: lamp.id,
    });
    expect(identified).toMatchObject({ itemId: lamp.id, holdActive: true });
    expect(getItemDetail(ctx, mover, lamp.id).item.onHold).toBe(true);
  });

  it("cannot identify an item from another move", () => {
    const { ctx, admin, mover, reviewer, move } = setup();
    const other = createMove(ctx, admin, aid(), { label: "Other", source: "X", destination: "Y" });
    addMember(ctx, admin, aid(), { moveId: other.id, userId: mover.id, role: "mover" });
    const foreign = recordItem(ctx, mover, aid(), { moveId: other.id, description: "Foreign" });
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, report: "Unknown" });
    expectDomainError(
      () => identifyIncidentItem(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: 1, itemId: foreign.id }),
      "not_found",
    );
  });

  it("owners cannot report damage", () => {
    const { ctx, owner, move } = setup();
    expectDomainError(() => reportDamage(ctx, owner, aid(), { moveId: move.id, report: "Dent" }), "forbidden");
  });
});

describe("decisions and holds", () => {
  it("continue releases only this incident's hold", () => {
    const { ctx, mover, reviewer, move, vase } = setup();
    const first = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Chip" });
    const second = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Crack" });
    placeMoveHold(ctx, reviewer, aid(), { moveId: move.id, reason: "Check all glassware" });

    const decided = decideIncident(ctx, reviewer, aid(), { incidentId: first.id, expectedRevision: first.revision, action: "continue" });
    expect(decided).toMatchObject({ status: "resolved", holdActive: false });
    expect(getIncident(ctx, reviewer, second.id).incident.holdActive).toBe(true);
    const detail = getItemDetail(ctx, mover, vase.id);
    expect(detail.item).toMatchObject({ onHold: true, moveOnHold: true });
    expect(detail.holds.map((h) => h.scope).sort()).toEqual(["item", "move"]);
  });

  it("repack keeps the hold until repacking is recorded and a reviewer releases it", () => {
    const { ctx, mover, reviewer, move, lamp } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: lamp.id, report: "Shade loose" });
    decideIncident(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: 1, action: "repack", reason: "Wrap the shade" });

    expectDomainError(
      () => releaseAfterRepack(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: rev(ctx, reviewer, incident.id) }),
      "conflict",
      "repack_not_recorded",
    );
    const repacked = recordRepack(ctx, mover, aid(), { incidentId: incident.id, expectedRevision: rev(ctx, mover, incident.id) });
    expect(repacked).toMatchObject({ holdActive: true, status: "open" });
    expectDomainError(
      () => releaseAfterRepack(ctx, mover, aid(), { incidentId: incident.id, expectedRevision: repacked.revision }),
      "forbidden",
    );

    const released = releaseAfterRepack(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: repacked.revision });
    expect(released).toMatchObject({ status: "resolved", holdActive: false });
    expect(markPacked(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: getItemDetail(ctx, mover, lamp.id).item.revision }).status).toBe("packed");
  });

  it("escalate keeps the hold until a later decision", () => {
    const { ctx, mover, reviewer, move, lamp } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: lamp.id, report: "Base cracked" });
    const escalated = decideIncident(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: 1, action: "escalate" });
    expect(escalated).toMatchObject({ status: "escalated", holdActive: true });
    const resolved = decideIncident(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: escalated.revision, action: "continue" });
    expect(resolved.holdActive).toBe(false);
  });

  it("continue and repack need an identified item; close needs no item and a reason", () => {
    const { ctx, mover, reviewer, move, vase } = setup();
    const unknown = reportDamage(ctx, mover, aid(), { moveId: move.id, report: "Noise" });
    expectDomainError(
      () => decideIncident(ctx, reviewer, aid(), { incidentId: unknown.id, expectedRevision: 1, action: "continue" }),
      "invalid",
      "item_required",
    );
    expectDomainError(
      () => decideIncident(ctx, reviewer, aid(), { incidentId: unknown.id, expectedRevision: 1, action: "close" }),
      "invalid",
      "reason_required",
    );
    expect(
      decideIncident(ctx, reviewer, aid(), { incidentId: unknown.id, expectedRevision: 1, action: "close", reason: "Not a move item" }).status,
    ).toBe("resolved");

    const known = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Chip" });
    expectDomainError(
      () => decideIncident(ctx, reviewer, aid(), { incidentId: known.id, expectedRevision: 1, action: "close", reason: "x" }),
      "invalid",
      "item_identified",
    );
  });

  it("only reviewers decide, and a stale revision is rejected", () => {
    const { ctx, mover, reviewer, owner, move, vase } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Chip" });
    expectDomainError(() => decideIncident(ctx, mover, aid(), { incidentId: incident.id, expectedRevision: 1, action: "continue" }), "forbidden");
    expectDomainError(() => decideIncident(ctx, owner, aid(), { incidentId: incident.id, expectedRevision: 1, action: "continue" }), "forbidden");
    decideIncident(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: 1, action: "escalate" });
    expectDomainError(
      () => decideIncident(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: 1, action: "continue" }),
      "conflict",
      "stale_revision",
    );
  });

  it("a replayed decision is recorded once", () => {
    const { ctx, mover, reviewer, move, vase } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Chip" });
    const actionId = aid();
    const input = { incidentId: incident.id, expectedRevision: 1, action: "repack" as const };
    decideIncident(ctx, reviewer, actionId, input);
    decideIncident(ctx, reviewer, actionId, input);
    expect(getIncident(ctx, reviewer, incident.id).decisions).toHaveLength(1);
  });

  it("whole-move holds block packing and sealing until explicitly released", () => {
    const { ctx, mover, reviewer, move, lamp, boxB } = setup();
    const hold = placeMoveHold(ctx, reviewer, aid(), { moveId: move.id, reason: "Truck delayed" });
    expectDomainError(() => markPacked(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: 1 }), "conflict", "move_on_hold");
    expectDomainError(() => sealBox(ctx, mover, aid(), { boxId: boxB.id, expectedRevision: boxB.revision }), "conflict", "move_on_hold");
    expectDomainError(() => releaseMoveHold(ctx, mover, aid(), { holdId: hold.id, expectedRevision: 1, reason: "ok" }), "forbidden");

    releaseMoveHold(ctx, reviewer, aid(), { holdId: hold.id, expectedRevision: 1, reason: "Truck arrived" });
    expect(markPacked(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: 1 }).status).toBe("packed");
  });

  it("item holds cannot be released as move holds", () => {
    const { ctx, mover, reviewer, move, vase } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Chip" });
    const itemHold = getIncident(ctx, reviewer, incident.id).holds[0];
    expectDomainError(
      () => releaseMoveHold(ctx, reviewer, aid(), { holdId: itemHold.id, expectedRevision: 1, reason: "x" }),
      "invalid",
      "item_hold",
    );
  });

  it("a box with a held item cannot be sealed but a sealed box can be reopened for repacking", () => {
    const { ctx, mover, move, vase, boxA, lamp } = setup();
    markPacked(ctx, mover, aid(), { itemId: lamp.id, expectedRevision: 1 });
    const sealed = sealBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: boxA.revision });
    reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Heard a crack" });
    const reopened = reopenBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: sealed.revision });
    expectDomainError(
      () => sealBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: reopened.revision }),
      "conflict",
      "items_on_hold",
    );
  });

  it("evidence requests are reviewer-only and can be cancelled", () => {
    const { ctx, mover, reviewer, move, vase } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Chip" });
    expectDomainError(() => requestEvidence(ctx, mover, aid(), { incidentId: incident.id, requestText: "More" }), "forbidden");
    const request = requestEvidence(ctx, reviewer, aid(), { incidentId: incident.id, requestText: "Close-up of the rim" });
    expect(getIncident(ctx, mover, incident.id).incident.openEvidenceRequests).toBe(1);
    cancelEvidenceRequest(ctx, reviewer, aid(), { requestId: request.id, expectedRevision: 1 });
    expect(getIncident(ctx, mover, incident.id).incident.openEvidenceRequests).toBe(0);
  });

  it("history on the item shows report and decision", () => {
    const { ctx, mover, reviewer, owner, move, vase } = setup();
    const incident = reportDamage(ctx, mover, aid(), { moveId: move.id, itemId: vase.id, report: "Chip" });
    decideIncident(ctx, reviewer, aid(), { incidentId: incident.id, expectedRevision: 1, action: "continue", reason: "Cosmetic only" });
    const actions = getItemDetail(ctx, owner, vase.id).history.map((h) => h.action);
    expect(actions).toEqual(expect.arrayContaining(["item.damage_reported", "item.decision_recorded"]));
  });
});
