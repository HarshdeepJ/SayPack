import { describe, expect, it } from "vitest";
import { MockProvider } from "@/ai/mock";
import type { AiProvider, InterpretInput, InterpretResult } from "./ai";
import { costMicroSgd, pricingFor, updateAiSettings, usageSummary } from "./budget";
import { getIncident } from "./incidents";
import { getItemDetail } from "./views";
import { searchItems } from "./inventory";
import { createBox, recordItem, sealBox, updateItem } from "./inventory-mutations";
import { addMember } from "./moves";
import { aid, expectDomainError, makeUser, moveFixture, testCtx, type TestCtx } from "./test-support";
import { cancelProposal, confirmProposal, submitVoice, type VoiceResult } from "./voice";

class Scripted implements AiProvider {
  readonly name = "scripted";
  readonly overheadChars = 100;
  calls: InterpretInput[] = [];
  constructor(
    readonly model: string,
    private readonly respond: (input: InterpretInput) => Promise<InterpretResult> | InterpretResult,
  ) {}
  async interpret(input: InterpretInput) {
    this.calls.push(input);
    return this.respond(input);
  }
  readonly assessOverheadChars = 100;
  async assessDamage(): Promise<InterpretResult> {
    throw new Error("not used in voice tests");
  }
}

const recordVase: InterpretResult = {
  kind: "ok",
  raw: { transcript: "blue vase", intent: "record_item", description: "Blue vase" },
  usage: { inputTokens: 1000, audioTokens: 640, outputTokens: 100 },
};

function setup() {
  const ctx = testCtx();
  const f = moveFixture(ctx);
  const boxA = createBox(ctx, f.mover, aid(), { moveId: f.move.id, label: "A" });
  const boxB = createBox(ctx, f.mover, aid(), { moveId: f.move.id, label: "B" });
  const mock = new MockProvider(undefined);
  const say = (text: string, boxId: string | null = boxA.id, extra: { clarifiesRequestId?: string } = {}) =>
    submitVoice(ctx, mock, f.mover, { moveId: f.move.id, actionId: aid(), context: { boxId }, text, ...extra });
  return { ctx, ...f, boxA, boxB, mock, say };
}

function proposalOf(result: VoiceResult) {
  if (result.kind !== "proposal") throw new Error(`expected a proposal, got ${JSON.stringify(result)}`);
  return result.proposal;
}

const itemCount = (ctx: TestCtx, actor: Parameters<typeof searchItems>[1], moveId: string) =>
  searchItems(ctx, actor, { moveId }).items.length;

describe("voice proposals", () => {
  it("nothing is saved until the mover confirms", async () => {
    const { ctx, mover, move, boxA, say } = setup();
    const proposal = proposalOf(await say("Blue vase, box A, fragile, no visible damage"));
    expect(proposal.readback).toBe("Record Blue vase, fragile, box A, no visible damage. Save?");
    expect(itemCount(ctx, mover, move.id)).toBe(0);

    const outcome = confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id });
    expect(outcome.message).toBe("Saved: Blue vase in box A.");
    if (outcome.operation !== "record_item") throw new Error("wrong operation");
    const detail = getItemDetail(ctx, mover, outcome.item.id);
    expect(detail.item).toMatchObject({ fragile: true, boxLabel: "A" });
    expect(detail.observations[0].condition).toBe("no_visible_damage");
  });

  it("confirming twice saves once", async () => {
    const { ctx, mover, move, boxA, say } = setup();
    const proposal = proposalOf(await say("Lamp"));
    const first = confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id });
    const second = confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id });
    expect(second).toEqual(first);
    expect(itemCount(ctx, mover, move.id)).toBe(1);
  });

  it("asks which box when the spoken box differs from the active box", async () => {
    const { say } = setup();
    const result = await say("Lamp, box B");
    expect(result).toMatchObject({ kind: "clarification", question: "You said box B, but your active box is A. Which box?" });
  });

  it("asks when a named box does not exist", async () => {
    const { say } = setup();
    expect(await say("Lamp, box Z", null)).toMatchObject({ kind: "clarification", question: "I couldn't find box Z. Which box?" });
  });

  it("refuses to propose into a sealed box", async () => {
    const { ctx, mover, boxA, say } = setup();
    sealBox(ctx, mover, aid(), { boxId: boxA.id, expectedRevision: boxA.revision });
    expect(await say("Lamp")).toMatchObject({ kind: "failed", reason: "box_sealed" });
  });

  it("asks which item when a reference matches several, and moves a unique match", async () => {
    const { ctx, mover, move, boxA, boxB, say } = setup();
    recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxB.id, description: "Red mug" });
    recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxB.id, description: "Blue mug" });
    const ambiguous = await say("move mug to box A");
    expect(ambiguous.kind).toBe("clarification");
    if (ambiguous.kind === "clarification") expect(ambiguous.question).toContain("Which one do you mean");

    const proposal = proposalOf(await say("move red mug to box A"));
    expect(proposal.readback).toBe("Move Red mug in box B to box A. Save?");
    const outcome = confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id });
    expect(outcome.message).toBe("Saved: Red mug moved to box A.");
  });

  it("moving an item that does not exist offers to record it as new", async () => {
    const { ctx, mover, move, boxA, say } = setup();
    const proposal = proposalOf(await say("move lamp to box A"));
    expect(proposal.readback).toBe("I couldn't find an existing lamp. Record a new item: Lamp, box A. Save?");
    expect(proposal.operation).toBe("record_item");
    expect(itemCount(ctx, mover, move.id)).toBe(0);
    confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id });
    expect(itemCount(ctx, mover, move.id)).toBe(1);
  });

  it("the new-item fallback still reconciles the box", async () => {
    const { say } = setup();
    expect(await say("move lamp to box B")).toMatchObject({
      kind: "clarification",
      question: "You said box B, but your active box is A. Which box?",
    });
  });

  it("a damage report with no matching item opens an unidentified incident", async () => {
    const { ctx, mover, reviewer, boxA, say } = setup();
    const proposal = proposalOf(await say("damage: something rattles"));
    expect(proposal.readback).toContain("item not identified");
    const outcome = confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id });
    if (outcome.operation !== "report_damage") throw new Error("wrong operation");
    expect(getIncident(ctx, reviewer, outcome.incident.id).incident.itemId).toBeNull();
  });

  it("a damage report on a known item puts it on hold", async () => {
    const { ctx, mover, move, boxA, say } = setup();
    const vase = recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Blue vase" });
    const proposal = proposalOf(await say("damage blue vase: crack on the rim"));
    confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id });
    expect(getItemDetail(ctx, mover, vase.id).item.onHold).toBe(true);
  });

  it("an expired proposal cannot be confirmed", async () => {
    const { ctx, mover, move, boxA, say } = setup();
    const proposal = proposalOf(await say("Lamp"));
    for (let i = 0; i < 130; i++) ctx.now(); // the test clock advances 1s per call
    expectDomainError(
      () => confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id }),
      "conflict",
      "proposal_expired",
    );
    expect(itemCount(ctx, mover, move.id)).toBe(0);
  });

  it("changing the active box cancels the proposal", async () => {
    const { ctx, mover, move, boxA, boxB, say } = setup();
    const proposal = proposalOf(await say("Lamp"));
    expectDomainError(
      () => confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxB.id }),
      "conflict",
      "context_changed",
    );
    expectDomainError(
      () => confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id }),
      "conflict",
      "proposal_closed",
    );
    expect(itemCount(ctx, mover, move.id)).toBe(0);
  });

  it("only the mover who spoke can answer", async () => {
    const { ctx, reviewer, boxA, say } = setup();
    const proposal = proposalOf(await say("Lamp"));
    expectDomainError(() => confirmProposal(ctx, reviewer, aid(), { proposalId: proposal.id, contextBoxId: boxA.id }), "forbidden");
  });

  it("a stale item at confirmation is a conflict, not an overwrite", async () => {
    const { ctx, mover, reviewer, move, boxA, boxB, say } = setup();
    const mug = recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxB.id, description: "Red mug" });
    const proposal = proposalOf(await say("move red mug to box A"));

    updateItem(ctx, reviewer, aid(), { itemId: mug.id, expectedRevision: 1, description: "Red mug, chipped" });
    expectDomainError(
      () => confirmProposal(ctx, mover, aid(), { proposalId: proposal.id, contextBoxId: boxA.id }),
      "conflict",
      "stale_revision",
    );
  });

  it("a new command replaces an unanswered proposal; cancel saves nothing", async () => {
    const { ctx, mover, move, boxA, say } = setup();
    const first = proposalOf(await say("Lamp"));
    const second = proposalOf(await say("Rug"));
    expectDomainError(
      () => confirmProposal(ctx, mover, aid(), { proposalId: first.id, contextBoxId: boxA.id }),
      "conflict",
      "proposal_closed",
    );
    expect(cancelProposal(ctx, mover, { proposalId: second.id }).status).toBe("cancelled");
    expect(itemCount(ctx, mover, move.id)).toBe(0);
  });

  it("a clarification answer is sent with the earlier question as context", async () => {
    const { ctx, mover, move, boxA } = setup();
    const provider = new Scripted("mock", (input) =>
      input.text === "lamp"
        ? { kind: "ok", raw: { transcript: "lamp", intent: "clarify", question: "Which lamp?" }, usage: null }
        : recordVase,
    );
    const first = await submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "lamp" });
    await submitVoice(ctx, provider, mover, {
      moveId: move.id,
      actionId: aid(),
      context: { boxId: boxA.id },
      text: "the desk one",
      clarifiesRequestId: first.requestId,
    });
    expect(provider.calls[1].context).toContain('You asked: "Which lamp?"');
  });

  it("owners cannot use voice", async () => {
    const { ctx, owner, move, mock } = setup();
    await expect(
      submitVoice(ctx, mock, owner, { moveId: move.id, actionId: aid(), context: { boxId: null }, text: "Lamp" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("requests, replays and limits", () => {
  it("replaying an action ID returns the stored result without calling the provider again", async () => {
    const { ctx, mover, move, boxA } = setup();
    const provider = new Scripted("mock", () => recordVase);
    const input = { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "blue vase" };
    const first = await submitVoice(ctx, provider, mover, input);
    const again = await submitVoice(ctx, provider, mover, input);
    expect(again).toEqual(first);
    expect(provider.calls).toHaveLength(1);
  });

  it("a retry while the first call is in flight is refused, never re-dispatched", async () => {
    const { ctx, mover, move, boxA } = setup();
    let finish!: (r: InterpretResult) => void;
    const provider = new Scripted("mock", () => new Promise((resolve) => (finish = resolve)));
    const input = { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "blue vase" };
    const inFlight = submitVoice(ctx, provider, mover, input);
    await expect(submitVoice(ctx, provider, mover, input)).rejects.toMatchObject({ reason: "action_in_progress" });
    await expect(
      submitVoice(ctx, provider, mover, { ...input, actionId: aid() }),
    ).rejects.toMatchObject({ reason: "ai_busy" });
    finish(recordVase);
    expect((await inFlight).kind).toBe("proposal");
    expect(provider.calls).toHaveLength(1);
  });

  it("at most two AI requests run at once across the app", async () => {
    const { ctx, admin, mover, reviewer, move, boxA } = setup();
    const resolvers: ((r: InterpretResult) => void)[] = [];
    const provider = new Scripted("mock", () => new Promise((resolve) => resolvers.push(resolve)));
    const other = makeUser(ctx, "Second");
    addMember(ctx, admin, aid(), { moveId: move.id, userId: other.id, role: "mover" });
    const a = submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "x" });
    const b = submitVoice(ctx, provider, reviewer, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "y" });
    await expect(
      submitVoice(ctx, provider, other, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "z" }),
    ).rejects.toMatchObject({ reason: "ai_busy" });
    resolvers.forEach((r) => r(recordVase));
    await Promise.all([a, b]);
  });
});

describe("budget and provider failures", () => {
  const paid = "gemini-3.5-flash-lite";

  it("settles the real cost from provider usage", async () => {
    const { ctx, mover, move, boxA } = setup();
    const provider = new Scripted(paid, () => recordVase);
    await submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "blue vase" });
    const expected = costMicroSgd(pricingFor(paid), 1.35, recordVase.kind === "ok" ? recordVase.usage! : null!) / 1e6;
    const summary = usageSummary(ctx);
    expect(summary.settledSgd).toBeCloseTo(expected, 6);
    expect(summary.heldSgd).toBe(0);
    expect(summary.remainingSgd).toBeCloseTo(5 - expected, 6);
  });

  it("stops new AI calls when the allowance is used up, while manual entry still works", async () => {
    const { ctx, admin, mover, move, boxA } = setup();
    updateAiSettings(ctx, admin, aid(), { allowanceSgd: 0.0001, usdToSgd: 1.35 });
    const provider = new Scripted(paid, () => recordVase);
    await expect(
      submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "blue vase" }),
    ).rejects.toMatchObject({ code: "unavailable", reason: "allowance_exhausted" });
    expect(provider.calls).toHaveLength(0);
    expect(recordItem(ctx, mover, aid(), { moveId: move.id, boxId: boxA.id, description: "Manual lamp" }).boxLabel).toBe("A");
  });

  it("a timeout keeps the reservation charged and saves nothing", async () => {
    const { ctx, mover, move, boxA } = setup();
    const provider = new Scripted(paid, (input) =>
      new Promise((resolve) => input.signal.addEventListener("abort", () => resolve({ kind: "unknown", reason: "timeout" }))),
    );
    const result = await submitVoice(
      ctx,
      provider,
      mover,
      { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "blue vase" },
      { timeoutMs: 20 },
    );
    expect(result).toMatchObject({ kind: "failed", reason: "provider_unavailable" });
    const summary = usageSummary(ctx);
    expect(summary.uncertainRequests).toBe(1);
    expect(summary.heldSgd).toBeGreaterThan(0);
    expect(itemCount(ctx, mover, move.id)).toBe(0);
  });

  it("a refused call is not charged", async () => {
    const { ctx, mover, move, boxA } = setup();
    const provider = new Scripted(paid, () => ({ kind: "rejected", reason: "HTTP 503" }));
    await submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "x" });
    expect(usageSummary(ctx)).toMatchObject({ settledSgd: 0, heldSgd: 0 });
  });

  it("an unusable answer is charged but saves nothing", async () => {
    const { ctx, mover, move, boxA } = setup();
    const provider = new Scripted(paid, () => ({ kind: "ok", raw: { foo: 1 }, usage: { inputTokens: 500, audioTokens: 0, outputTokens: 50 } }));
    const result = await submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "x" });
    expect(result).toMatchObject({ kind: "failed", reason: "invalid_result" });
    expect(usageSummary(ctx).settledSgd).toBeGreaterThan(0);
  });

  it("three failures in a row pause the provider", async () => {
    const { ctx, mover, move, boxA } = setup();
    const provider = new Scripted(paid, () => ({ kind: "rejected", reason: "HTTP 500" }));
    for (let i = 0; i < 3; i++) {
      await submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: `x${i}` });
    }
    await expect(
      submitVoice(ctx, provider, mover, { moveId: move.id, actionId: aid(), context: { boxId: boxA.id }, text: "x4" }),
    ).rejects.toMatchObject({ reason: "provider_unavailable" });
    expect(provider.calls).toHaveLength(3);
  });

  it("only administrators change the allowance", () => {
    const { ctx, mover } = setup();
    expectDomainError(() => updateAiSettings(ctx, mover, aid(), { allowanceSgd: 100, usdToSgd: 1.35 }), "forbidden");
  });
});
