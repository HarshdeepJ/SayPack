import Link from "next/link";
import { AppHeader } from "@/components/ui";
import { loadMovePage } from "@/server/pages";
import { PackScreen } from "./pack-screen";

export default async function PackPage({ params }: PageProps<"/moves/[moveId]/pack">) {
  const { moveId } = await params;
  const { actor, overview } = await loadMovePage(moveId, `/moves/${moveId}/pack`);
  return (
    <>
      <AppHeader
        userName={actor.displayName}
        isAdmin={actor.isAdmin}
        title={`Pack · ${overview.move.label}`}
        back={{ href: `/moves/${moveId}`, label: "Inventory" }}
      />
      {overview.canWrite ? (
        <PackScreen initialOverview={overview} />
      ) : (
        <main className="mx-auto w-full max-w-xl px-4 py-6">
          <p className="card p-5">
            Your role in this move is view-only.{" "}
            <Link href={`/moves/${moveId}`} className="text-accent underline">
              Open the inventory
            </Link>
            .
          </p>
        </main>
      )}
    </>
  );
}
