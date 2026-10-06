import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { DomainError, type Actor, type Ctx } from "@/domain/core";
import { authenticate } from "@/domain/identity";
import { appCtx } from "./app";

export const SESSION_COOKIE = "saypack_session";

const STATUS: Record<DomainError["code"], number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 422,
};

export type ErrorBody = {
  error: { code: string; reason: string; message: string; details?: unknown };
};

function errorResponse(status: number, body: ErrorBody["error"]) {
  return Response.json({ error: body } satisfies ErrorBody, { status });
}

/**
 * Rejects cross-site writes. The session cookie is SameSite=Lax already;
 * this also covers same-site subdomains. Forwarded headers come from Tailscale's proxy.
 */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set(
    [request.headers.get("x-forwarded-host"), request.headers.get("host"), request.nextUrl.host].filter(
      (h): h is string => !!h,
    ),
  );
  for (const extra of (process.env.SAYPACK_ALLOWED_ORIGINS ?? "").split(",")) {
    if (extra.trim()) allowed.add(new URL(extra.trim()).host);
  }
  try {
    return allowed.has(new URL(origin).host);
  } catch {
    return false;
  }
}

export interface Handled<P> {
  request: NextRequest;
  ctx: Ctx;
  actor: Actor;
  params: P;
}

type RouteArgs<P> = { params: Promise<P> };

/**
 * Wraps a route handler: origin check for writes, authentication,
 * typed errors, and one structured log line per request (no bodies, no secrets).
 */
export function route<P = Record<string, never>>(
  operation: string,
  handler: (h: Handled<P>) => unknown,
  options: { auth?: boolean } = {},
) {
  return async (request: NextRequest, context: RouteArgs<P>) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    let actorId: string | undefined;
    let outcome = "ok";
    let status = 200;
    try {
      if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
        outcome = "bad_origin";
        status = 403;
        return errorResponse(403, { code: "forbidden", reason: "bad_origin", message: "Cross-origin request rejected." });
      }
      const ctx = appCtx();
      let actor: Actor | null = null;
      if (options.auth !== false) {
        actor = authenticate(ctx, (await cookies()).get(SESSION_COOKIE)?.value);
        if (!actor) {
          outcome = "unauthenticated";
          status = 401;
          return errorResponse(401, { code: "unauthenticated", reason: "no_session", message: "Please sign in." });
        }
        actorId = actor.id;
      }
      const params = (await context.params) as P;
      const result = await handler({ request, ctx, actor: actor as Actor, params });
      return result instanceof Response ? ((status = result.status), result) : Response.json({ data: result });
    } catch (error) {
      if (error instanceof DomainError) {
        outcome = error.reason;
        status = STATUS[error.code];
        return errorResponse(status, {
          code: error.code,
          reason: error.reason,
          message: error.message,
          details: error.details,
        });
      }
      if (error instanceof z.ZodError) {
        outcome = "invalid_request";
        status = 422;
        return errorResponse(422, {
          code: "invalid",
          reason: "invalid_request",
          message: "The request was not valid.",
          details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      outcome = "error";
      status = 500;
      console.error(JSON.stringify({ requestId, operation, error: String(error), stack: (error as Error)?.stack }));
      return errorResponse(500, {
        code: "internal",
        reason: "internal",
        message: `Something went wrong. Reference ${requestId.slice(0, 8)}.`,
      });
    } finally {
      console.log(
        JSON.stringify({
          requestId,
          operation,
          actorId,
          status,
          outcome,
          ms: Math.round(performance.now() - started),
        }),
      );
    }
  };
}

export async function readJson<T extends z.ZodType>(request: NextRequest, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  return schema.parse(body);
}

export function readQuery<T extends z.ZodType>(request: NextRequest, schema: T): z.infer<T> {
  return schema.parse(Object.fromEntries(request.nextUrl.searchParams));
}

// ---------- Shared request fields ----------

export const actionId = z.uuid();
export const revision = z.number().int().positive();
export const id = z.string().min(1).max(64);

/** Reads the actor for a server-rendered page; null when not signed in. */
export async function pageActor(): Promise<Actor | null> {
  return authenticate(appCtx(), (await cookies()).get(SESSION_COOKIE)?.value);
}
