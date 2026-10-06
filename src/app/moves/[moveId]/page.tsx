import { AppHeader } from "@/components/ui";
import { loadMovePage } from "@/server/pages";
import { InventoryScreen } from "./inventory-screen";

export default async function MoveInventoryPage({ params }: PageProps<"/moves/[moveId]">) {
  const { moveId } = await params;
  const { actor, overview } = await loadMovePage(moveId, `/moves/${moveId}`);
  return (
    <>
      <AppHeader
        userName={actor.displayName}
        isAdmin={actor.isAdmin}
        title={overview.move.label}
        back={{ href: "/moves", label: "Moves" }}
      />
      <InventoryScreen initialOverview={overview} />
    </>
  );
}
