import { describe, expect, it } from "vitest";
import {
  authenticate,
  createUser,
  hashPassword,
  login,
  logout,
  resetPassword,
  setUserActive,
} from "./identity";
import { addMember, listMyMoves } from "./moves";
import { aid, expectDomainError, makeUser, moveFixture, testCtx } from "./test-support";

describe("sessions", () => {
  it("logs in, authenticates the token, and logs out", async () => {
    const ctx = testCtx();
    const admin = makeUser(ctx, "Admin", true);
    createUser(ctx, admin, aid(), {
      email: "Mover@Example.test",
      displayName: "Mover",
      passwordHash: await hashPassword("correct horse"),
      isAdmin: false,
    });

    const { token } = await login(ctx, "  mover@example.TEST ", "correct horse");
    expect(authenticate(ctx, token)?.displayName).toBe("Mover");

    logout(ctx, token);
    expect(authenticate(ctx, token)).toBeNull();
  });

  it("rejects a wrong password and an unknown email the same way", async () => {
    const ctx = testCtx();
    createUser(ctx, null, null, {
      email: "a@example.test",
      displayName: "A",
      passwordHash: await hashPassword("correct horse"),
      isAdmin: false,
    });
    await expect(login(ctx, "a@example.test", "wrong password")).rejects.toMatchObject({
      reason: "bad_credentials",
    });
    await expect(login(ctx, "nobody@example.test", "correct horse")).rejects.toMatchObject({
      reason: "bad_credentials",
    });
  });

  it("deactivating a user revokes their sessions and blocks login", async () => {
    const ctx = testCtx();
    const admin = makeUser(ctx, "Admin", true);
    const user = createUser(ctx, admin, aid(), {
      email: "m@example.test",
      displayName: "M",
      passwordHash: await hashPassword("correct horse"),
      isAdmin: false,
    });
    const { token } = await login(ctx, "m@example.test", "correct horse");

    setUserActive(ctx, admin, aid(), { userId: user.id, active: false });
    expect(authenticate(ctx, token)).toBeNull();
    await expect(login(ctx, "m@example.test", "correct horse")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("resetting a password replaces it and ends existing sessions", async () => {
    const ctx = testCtx();
    createUser(ctx, null, null, {
      email: "m@example.test",
      displayName: "M",
      passwordHash: await hashPassword("forgotten one"),
      isAdmin: false,
    });
    const { token } = await login(ctx, "m@example.test", "forgotten one");

    resetPassword(ctx, { email: " M@example.TEST ", passwordHash: await hashPassword("brand new one") });
    expect(authenticate(ctx, token)).toBeNull();
    await expect(login(ctx, "m@example.test", "forgotten one")).rejects.toMatchObject({
      reason: "bad_credentials",
    });
    await expect(login(ctx, "m@example.test", "brand new one")).resolves.toBeTruthy();
    expectDomainError(
      () => resetPassword(ctx, { email: "nobody@example.test", passwordHash: "x" }),
      "not_found",
    );
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toMatchObject({ reason: "weak_password" });
  });
});

describe("administration", () => {
  it("only administrators manage users and memberships", () => {
    const ctx = testCtx();
    const { mover, outsider, move } = moveFixture(ctx);
    expectDomainError(
      () => createUser(ctx, mover, aid(), { email: "x@example.test", displayName: "X", passwordHash: "h", isAdmin: false }),
      "forbidden",
    );
    expectDomainError(
      () => addMember(ctx, mover, aid(), { moveId: move.id, userId: outsider.id, role: "mover" }),
      "forbidden",
    );
  });

  it("rejects duplicate emails regardless of case", () => {
    const ctx = testCtx();
    const admin = makeUser(ctx, "Admin", true);
    expectDomainError(
      () => createUser(ctx, admin, aid(), { email: "ADMIN@example.test", displayName: "B", passwordHash: "h", isAdmin: false }),
      "conflict",
      "email_exists",
    );
  });

  it("lists a member's moves with every role they hold", () => {
    const ctx = testCtx();
    const { mover, move, join } = moveFixture(ctx);
    join(mover, "reviewer");
    const moves = listMyMoves(ctx, mover);
    expect(moves).toHaveLength(1);
    expect(moves[0].id).toBe(move.id);
    expect([...moves[0].roles].sort()).toEqual(["mover", "reviewer"]);
  });
});
