import { z } from "zod";
import { createUser, hashPassword, listUsers, requireAdmin } from "@/domain/identity";
import { actionId, readJson, route } from "@/server/http";

export const GET = route("user.list", ({ ctx, actor }) => listUsers(ctx, actor));

const Body = z.object({
  actionId,
  email: z.string().max(254),
  displayName: z.string().max(80),
  password: z.string().max(1024),
  isAdmin: z.boolean().default(false),
});

export const POST = route("user.create", async ({ request, ctx, actor }) => {
  requireAdmin(actor);
  const { actionId: aid, password, ...input } = await readJson(request, Body);
  // Hash before the transaction: it is slow and async.
  const passwordHash = await hashPassword(password);
  return createUser(ctx, actor, aid, { ...input, passwordHash });
});
