import crypto from "node:crypto";
import { expect } from "vitest";
import { openDatabase } from "@/db/database";
import type { MoveRole } from "@/db/schema";
import { DomainError, type Actor, type Ctx } from "./core";
import { createUser } from "./identity";
import { addMember, createMove } from "./moves";

/** Fresh in-memory database with a clock that advances 1 second per call. */
export function testCtx(): Ctx {
  let t = Date.parse("2026-10-06T00:00:00.000Z");
  return {
    db: openDatabase(":memory:"),
    now: () => new Date((t += 1000)).toISOString(),
    newId: () => crypto.randomUUID(),
  };
}

export const aid = () => crypto.randomUUID();

export function makeUser(ctx: Ctx, name: string, isAdmin = false): Actor {
  const user = createUser(ctx, null, null, {
    email: `${name.toLowerCase()}@example.test`,
    displayName: name,
    passwordHash: "not-a-real-hash",
    isAdmin,
  });
  return { id: user.id, displayName: user.displayName, isAdmin };
}

/** An admin, a move, and one member per role. */
export function moveFixture(ctx: Ctx) {
  const admin = makeUser(ctx, "Admin", true);
  const mover = makeUser(ctx, "Mover");
  const reviewer = makeUser(ctx, "Reviewer");
  const owner = makeUser(ctx, "Owner");
  const outsider = makeUser(ctx, "Outsider");
  const move = createMove(ctx, admin, aid(), { label: "Tan family", source: "Clementi", destination: "Tampines" });
  const join = (user: Actor, role: MoveRole) => addMember(ctx, admin, aid(), { moveId: move.id, userId: user.id, role });
  join(mover, "mover");
  join(reviewer, "reviewer");
  join(owner, "owner");
  return { admin, mover, reviewer, owner, outsider, move, join };
}

export function expectDomainError(fn: () => unknown, code: DomainError["code"], reason?: string) {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, "expected a DomainError").toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (reason) expect((error as DomainError).reason).toBe(reason);
  return error as DomainError;
}
