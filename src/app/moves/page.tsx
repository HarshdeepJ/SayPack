import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/ui";
import { listMyMoves } from "@/domain/moves";
import { appCtx } from "@/server/app";
import { pageActor } from "@/server/http";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  packing: "Packing",
  in_transit: "In transit",
  delivered: "Delivered",
  completed: "Completed",
};

export default async function MovesPage() {
  const actor = await pageActor();
  if (!actor) redirect("/login?next=/moves");
  const moves = listMyMoves(appCtx(), actor);

  return (
    <>
      <AppHeader userName={actor.displayName} isAdmin={actor.isAdmin} />
      <main className="mx-auto w-full max-w-5xl px-4 py-6">
        <h1 className="mb-4 text-xl font-semibold">Your moves</h1>
        {moves.length === 0 ? (
          <p className="card p-5 text-muted">
            You are not a member of any move yet.
            {actor.isAdmin && (
              <>
                {" "}
                Create one and add members on the{" "}
                <Link href="/admin" className="text-accent underline">
                  admin page
                </Link>
                .
              </>
            )}
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {moves.map((move) => (
              <li key={move.id} className="card flex flex-col gap-3 p-4">
                <div>
                  <h2 className="font-semibold">{move.label}</h2>
                  <p className="text-sm text-muted">
                    {move.source} → {move.destination}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {STATUS_LABEL[move.status]} · Your role: {move.roles.join(", ")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link href={`/moves/${move.id}`} className="btn flex-1">
                    Inventory
                  </Link>
                  {move.roles.some((r) => r === "mover" || r === "reviewer") && (
                    <Link href={`/moves/${move.id}/pack`} className="btn btn-primary flex-1">
                      Pack
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
