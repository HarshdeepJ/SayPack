import { describe, expect, it } from "vitest";
import { getItem, getMoveOverview, listActivity, searchItems } from "./inventory";
import {
  assignItemToBox,
  createBox,
  createRoom,
  recordItem,
  reopenBox,
  sealBox,
  updateItem,
} from "./inventory-mutations";
import { addMember, createMove, removeMember } from "./moves";
import { aid, expectDomainError, moveFixture, testCtx } from "./test-support";

function setup() {
  const ctx = testCtx();
  const f = moveFixture(ctx);
  const kitchen = createRoom(ctx, f.mover, aid(), { moveId: f.move.id, name: "Kitchen" });
  const boxA = createBox(ctx, f.mover, aid(), { moveId: f.move.id, label: "A", roomId: kitchen.id });
  const boxB = createBox(ctx, f.mover, aid(), { moveId: f.move.id, label: "B" });
  return { ctx, ...f, kitchen, boxA, boxB };
}

describe("recording items", () => {
  it("replaying an action ID returns the first outcome and creates one item", () => {
    const { ctx, mover, move, boxA } = setup();
    const actionId = aid();
    const input = { moveId: move.id, boxId: boxA.id, description: "Blue ceramic vase", fragile: true };
    const first = recordItem(ctx, mover, actionId, input);
    const replay = recordItem(ctx, mover, actionId, input);

    expect(replay.id).toBe(first.id);
    expect(searchItems(ctx, mover, { moveId: move.id }).items).toHaveLength(1);
  });

  it("rejects reusing an action ID with a different payload", () => {
    const { ctx, mover, move, boxA } = setup();
    const actionId = aid();
    recordItem(ctx, mover, actionId, { moveId: move.id, boxId: boxA.id, description: "Vase" });
    expectDomainError(
      () => recordItem(ctx, mover, actionId, { moveId: move.id, boxId: boxA.id, description: "Lamp" }),
      "conflict",
      "action_id_reused",
    );
  });

  it("rejects an action ID replayed by a different user", () => {
    const { ctx, mover, reviewer, move } = setup();
    const actionId = aid();
    const input = { moveId: move.id, description: "Vase" };
    recordItem(ctx, mover, actionId, input);
    expectDomainError(() => recordItem(ctx, reviewer, actionId, input), "conflict", "action_id_reused");
  });

  it("does not accept a box from another move, even for a member of both", () => {
    const { ctx, admin, mover, move } = setup();
    const other = createMove(ctx, admin, aid(), { label: "Other", source: "X", destination: "Y" });
    addMember(ctx, admin, aid(), { moveId: other.id, userId: mover.id, role: "mover" });
    const foreignBox = createBox(ctx, mover, aid(), { moveId: other.id, label: "Z" });
    expectDomainError(
      () => recordItem(ctx, mover, aid(), { moveId: move.id, boxId: foreignBox.id, description: "Lamp" }),
      "not_found",
    );
  });

  it("validates description length and blank input", () => {
    const { ctx, mover, move } = setup();
    expectDomainError(() => recordItem(ctx, mover, aid(), { moveId: move.id, description: "   " }), "invalid");
    expectDomainError(
      () => recordItem(ctx, mover, aid(), { moveId: move.id, description: "x".repeat(201) }),
      "invalid",
    );
  });
});

describe("boxes", () => {
  it("rejects duplicate box labels within a move, ignoring case", () => {
    const { ctx, mover, move } = setup();
    expectDomainError(
      () => createBox(ctx, mover, aid(), { moveId: move.id, label: "a" }),
      "conflict",
      "box_label_exists",
    );
  });

  it("allows the same label in a different move", () => {
    const { ctx, admin, mover } = setup();
    const other = createMove(ctx, admin, aid(), { label: "Other", source: "X", destination: "Y" });
    addMember(ctx, admin, aid(), { moveId: other.id, userId: mover.id, role: "mover" });
    expect(createBox(ctx, mover, aid(), { moveId: other.id, label: "A" }).label).toBe("A");
  });

  it("a sealed box rejects adding, editing and removing items until reopened", () => {
    const { ctx, mover, move, boxA, boxB } = setup();
    const item = recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Vase" });
    const sealed = sealBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: boxA.revision });
    expect(sealed.status).toBe("sealed");

    expectDomainError(
      () => recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Cup" }),
      "conflict",
      "box_sealed",
    );
    expectDomainError(
      () => updateItem(ctx, mover, aid(), { itemId: item.id, expectedRevision: 1, description: "Jar" }),
      "conflict",
      "box_sealed",
    );
    expectDomainError(
      () => assignItemToBox(ctx, mover, aid(), { itemId: item.id, expectedRevision: 1, boxId: boxB.id }),
      "conflict",
      "box_sealed",
    );

    reopenBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: sealed.revision });
    expect(
      recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Cup" }).boxLabel,
    ).toBe("A");
  });

  it("moving an item into a sealed box is rejected", () => {
    const { ctx, mover, move, boxA, boxB } = setup();
    const item = recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Vase" });
    sealBox(ctx, mover, aid(), { boxId: boxB.id, expectedRevision: boxB.revision });
    expectDomainError(
      () => assignItemToBox(ctx, mover, aid(), { itemId: item.id, expectedRevision: 1, boxId: boxB.id }),
      "conflict",
      "box_sealed",
    );
  });

  it("sealing with a stale revision is a conflict", () => {
    const { ctx, mover, boxA } = setup();
    sealBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: 1 });
    expectDomainError(
      () => sealBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: 1 }),
      "conflict",
      "stale_revision",
    );
  });
});

describe("corrections and concurrency", () => {
  it("edits keep the previous values in history", () => {
    const { ctx, mover, owner, move, boxA } = setup();
    const item = recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Vase" });
    const updated = updateItem(ctx, mover, aid(), {
      itemId: item.id,
      expectedRevision: item.revision,
      description: "Blue vase",
      fragile: true,
    });
    expect(updated.revision).toBe(2);

    const { history } = getItem(ctx, owner, item.id);
    expect(history[0]).toMatchObject({
      action: "item.updated",
      actorName: "Mover",
      before: { description: "Vase", fragile: false },
      after: { description: "Blue vase", fragile: true },
    });
    expect(history[1].action).toBe("item.recorded");
  });

  it("a stale revision is rejected with the current state, not overwritten", () => {
    const { ctx, mover, reviewer, move } = setup();
    const item = recordItem(ctx, mover, aid(), { moveId: move.id, description: "Vase" });
    updateItem(ctx, reviewer, aid(), { itemId: item.id, expectedRevision: 1, description: "Urn" });
    const error = expectDomainError(
      () => updateItem(ctx, mover, aid(), { itemId: item.id, expectedRevision: 1, description: "Pot" }),
      "conflict",
      "stale_revision",
    );
    expect((error.details as { current: { description: string } }).current.description).toBe("Urn");
  });

  it("box reassignment is audited with both labels", () => {
    const { ctx, mover, move, boxA, boxB } = setup();
    const item = recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Vase" });
    const moved = assignItemToBox(ctx, mover, aid(), { itemId: item.id, expectedRevision: 1, boxId: boxB.id });
    expect(moved.boxLabel).toBe("B");
    expect(getItem(ctx, mover, item.id).history[0]).toMatchObject({
      action: "item.box_assigned",
      before: { boxLabel: "A" },
      after: { boxLabel: "B" },
    });
  });

  it("a no-op edit does not bump the revision", () => {
    const { ctx, mover, move } = setup();
    const item = recordItem(ctx, mover, aid(), { moveId: move.id, description: "Vase" });
    const same = updateItem(ctx, mover, aid(), { itemId: item.id, expectedRevision: 1, description: "Vase" });
    expect(same.revision).toBe(1);
  });
});

describe("access", () => {
  it("non-members cannot read or write a move", () => {
    const { ctx, outsider, mover, move } = setup();
    const item = recordItem(ctx, mover, aid(), { moveId: move.id, description: "Vase" });
    expectDomainError(() => getMoveOverview(ctx, outsider, move.id), "forbidden");
    expectDomainError(() => searchItems(ctx, outsider, { moveId: move.id }), "forbidden");
    expectDomainError(() => getItem(ctx, outsider, item.id), "forbidden");
    expectDomainError(
      () => recordItem(ctx, outsider, aid(), { moveId: move.id, description: "Lamp" }),
      "forbidden",
    );
  });

  it("an administrator without membership cannot see inventory", () => {
    const { ctx, admin, move } = setup();
    expectDomainError(() => searchItems(ctx, admin, { moveId: move.id }), "forbidden");
  });

  it("owners can read but not write", () => {
    const { ctx, owner, move } = setup();
    expect(getMoveOverview(ctx, owner, move.id).canWrite).toBe(false);
    expectDomainError(() => recordItem(ctx, owner, aid(), { moveId: move.id, description: "Lamp" }), "forbidden");
    expectDomainError(() => createBox(ctx, owner, aid(), { moveId: move.id, label: "C" }), "forbidden");
  });

  it("removing a membership takes effect on the next request", () => {
    const { ctx, admin, mover, move } = setup();
    removeMember(ctx, admin, aid(), { moveId: move.id, userId: mover.id, role: "mover" });
    expectDomainError(() => recordItem(ctx, mover, aid(), { moveId: move.id, description: "Lamp" }), "forbidden");
  });
});

describe("search", () => {
  it("finds items by description, box label and room name", () => {
    const { ctx, mover, owner, move, boxA, boxB } = setup();
    recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Blue vase" });
    recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxB.id, description: "Desk lamp" });
    recordItem(ctx, mover, aid(), { moveId: move.id, description: "Rug" });

    const find = (query: string) =>
      searchItems(ctx, owner, { moveId: move.id, query }).items.map((i) => i.description);
    expect(find("VASE")).toEqual(["Blue vase"]);
    expect(find("kitchen")).toEqual(["Blue vase"]);
    expect(searchItems(ctx, owner, { moveId: move.id, boxId: boxB.id }).items[0].description).toBe("Desk lamp");
    expect(searchItems(ctx, owner, { moveId: move.id, unboxed: true }).items[0].description).toBe("Rug");
  });

  it("treats % and _ in the query literally", () => {
    const { ctx, mover, move } = setup();
    recordItem(ctx, mover, aid(), { moveId: move.id, description: "100% wool rug" });
    recordItem(ctx, mover, aid(), { moveId: move.id, description: "Wool blanket" });
    expect(searchItems(ctx, mover, { moveId: move.id, query: "100%" }).items).toHaveLength(1);
    expect(searchItems(ctx, mover, { moveId: move.id, query: "%" }).items).toHaveLength(1);
  });

  it("paginates", () => {
    const { ctx, mover, move } = setup();
    for (let i = 0; i < 5; i++) recordItem(ctx, mover, aid(), { moveId: move.id, description: `Item ${i}` });
    const page1 = searchItems(ctx, mover, { moveId: move.id, limit: 3 });
    const page2 = searchItems(ctx, mover, { moveId: move.id, limit: 3, offset: 3 });
    expect(page1.hasMore).toBe(true);
    expect(page2.items).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
  });

  it("overview counts boxes, items and unboxed items", () => {
    const { ctx, mover, move, boxA } = setup();
    recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Vase" });
    recordItem(ctx, mover, aid(), { moveId: move.id, description: "Rug" });
    const overview = getMoveOverview(ctx, mover, move.id);
    expect(overview.itemCount).toBe(2);
    expect(overview.unboxedCount).toBe(1);
    expect(overview.boxes.find((b) => b.label === "A")).toMatchObject({ itemCount: 1, roomName: "Kitchen" });
    expect(overview.rooms[0]).toMatchObject({ name: "Kitchen", boxCount: 1 });
  });

  it("recent activity can be limited to the actor's own actions", () => {
    const { ctx, mover, reviewer, move } = setup();
    recordItem(ctx, reviewer, aid(), { moveId: move.id, description: "Rug" });
    const mine = listActivity(ctx, mover, { moveId: move.id, mineOnly: true });
    expect(mine.every((e) => e.actorName === "Mover")).toBe(true);
    expect(mine.some((e) => e.action === "item.recorded")).toBe(false);
  });
});
