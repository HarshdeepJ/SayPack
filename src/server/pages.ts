import "server-only";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/domain/core";
import { getMoveOverview } from "@/domain/inventory";
import { appCtx } from "./app";
import { pageActor } from "./http";

/** Signed-in actor plus the move overview; non-members get a plain 404. */
export async function loadMovePage(moveId: string, path: string) {
  const actor = await pageActor();
  if (!actor) redirect(`/login?next=${encodeURIComponent(path)}`);
  try {
    return { actor, overview: getMoveOverview(appCtx(), actor, moveId) };
  } catch (error) {
    if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) notFound();
    throw error;
  }
}
