import crypto from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { runAction, recordAudit } from "./actions";
import { DomainError, forbidden, invalid, notFound, sha256, type Actor, type Ctx } from "./core";

export const SESSION_TTL_DAYS = 30;
const MIN_PASSWORD_LENGTH = 10;

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  active: boolean;
  createdAt: string;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/** Hashing is slow and async, so it happens before any transaction starts. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw invalid("weak_password", `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return hash(password);
}

// Verified against when the email is unknown, so response time does not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;

export async function login(
  ctx: Ctx,
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: string }> {
  const { db } = ctx;
  const user = db.get(
    db.q.selectFrom("users").selectAll().where("email", "=", normalizeEmail(email)),
  );
  dummyHash ??= hash("saypack-timing-equalizer");
  const ok = await verify(user?.password_hash ?? (await dummyHash), password).catch(() => false);
  if (!user || !ok || user.active !== 1) {
    throw new DomainError("unauthenticated", "bad_credentials", "Email or password is incorrect.");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const now = ctx.now();
  const expiresAt = new Date(Date.parse(now) + SESSION_TTL_DAYS * 86_400_000).toISOString();
  db.run(
    db.q.insertInto("sessions").values({
      id: sha256(token),
      user_id: user.id,
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
    }),
  );
  return { token, expiresAt };
}

export function logout(ctx: Ctx, token: string) {
  const { db } = ctx;
  db.run(
    db.q
      .updateTable("sessions")
      .set({ revoked_at: ctx.now() })
      .where("id", "=", sha256(token))
      .where("revoked_at", "is", null),
  );
}

/** Returns the actor for a valid, unexpired, unrevoked session of an active user. */
export function authenticate(ctx: Ctx, token: string | undefined): Actor | null {
  if (!token) return null;
  const { db } = ctx;
  const row = db.get(
    db.q
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.user_id")
      .select(["users.id", "users.display_name", "users.is_admin"])
      .where("sessions.id", "=", sha256(token))
      .where("sessions.revoked_at", "is", null)
      .where("sessions.expires_at", ">", ctx.now())
      .where("users.active", "=", 1),
  );
  return row ? { id: row.id, displayName: row.display_name, isAdmin: row.is_admin === 1 } : null;
}

export function requireAdmin(actor: Actor) {
  if (!actor.isAdmin) throw forbidden("Only an administrator can do this.");
}

function toUserSummary(row: {
  id: string;
  email: string;
  display_name: string;
  is_admin: number;
  active: number;
  created_at: string;
}): UserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function listUsers(ctx: Ctx, actor: Actor): UserSummary[] {
  requireAdmin(actor);
  const { db } = ctx;
  return db
    .all(
      db.q
        .selectFrom("users")
        .select(["id", "email", "display_name", "is_admin", "active", "created_at"])
        .orderBy("display_name"),
    )
    .map(toUserSummary);
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  passwordHash: string;
  isAdmin: boolean;
}

/** Creates a user. actor null is the bootstrap path used by the create-admin script. */
export function createUser(
  ctx: Ctx,
  actor: Actor | null,
  actionId: string | null,
  input: CreateUserInput,
): UserSummary {
  if (actor) requireAdmin(actor);
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid("bad_email", "Enter a valid email address.");
  if (!displayName) throw invalid("missing_name", "Enter a display name.");

  const mutate = () => {
    const { db } = ctx;
    if (db.get(db.q.selectFrom("users").select("id").where("email", "=", email))) {
      throw new DomainError("conflict", "email_exists", "A user with this email already exists.");
    }
    const row = {
      id: ctx.newId(),
      email,
      display_name: displayName,
      password_hash: input.passwordHash,
      is_admin: input.isAdmin ? 1 : 0,
      active: 1,
      created_at: ctx.now(),
    };
    db.run(db.q.insertInto("users").values(row));
    const user = toUserSummary(row);
    recordAudit(ctx, {
      moveId: null,
      actorId: actor?.id ?? row.id,
      action: "user.created",
      recordType: "user",
      recordId: row.id,
      after: { email: user.email, displayName: user.displayName, isAdmin: user.isAdmin },
      actionId: actionId ?? undefined,
    });
    return user;
  };

  if (!actor || !actionId) return ctx.db.transaction(mutate);
  return runAction(
    ctx,
    actor,
    { actionId, operation: "user.create", fingerprint: { email, displayName, isAdmin: input.isAdmin } },
    mutate,
  ).outcome;
}

/** Deactivating a user ends all of their sessions immediately. */
export function setUserActive(
  ctx: Ctx,
  actor: Actor,
  actionId: string,
  input: { userId: string; active: boolean },
): UserSummary {
  requireAdmin(actor);
  if (input.userId === actor.id && !input.active) {
    throw invalid("self_deactivation", "You cannot deactivate your own account.");
  }
  return runAction(
    ctx,
    actor,
    { actionId, operation: "user.set_active", fingerprint: input },
    () => {
      const { db } = ctx;
      const user = db.get(db.q.selectFrom("users").selectAll().where("id", "=", input.userId));
      if (!user) throw notFound("User");
      db.run(
        db.q.updateTable("users").set({ active: input.active ? 1 : 0 }).where("id", "=", user.id),
      );
      if (!input.active) {
        db.run(
          db.q
            .updateTable("sessions")
            .set({ revoked_at: ctx.now() })
            .where("user_id", "=", user.id)
            .where("revoked_at", "is", null),
        );
      }
      recordAudit(ctx, {
        moveId: null,
        actorId: actor.id,
        action: input.active ? "user.activated" : "user.deactivated",
        recordType: "user",
        recordId: user.id,
        before: { active: user.active === 1 },
        after: { active: input.active },
        actionId,
      });
      return toUserSummary({ ...user, active: input.active ? 1 : 0 });
    },
  ).outcome;
}
