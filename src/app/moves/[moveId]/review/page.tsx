import { AppHeader } from "@/components/ui";
import { loadMovePage } from "@/server/pages";
import { ReviewScreen } from "./review-screen";

export default async function ReviewPage({ params }: PageProps<"/moves/[moveId]/review">) {
  const { moveId } = await params;
  const { actor, overview } = await loadMovePage(moveId, `/moves/${moveId}/review`);
  return (
    <>
      <AppHeader
        userName={actor.displayName}
        isAdmin={actor.isAdmin}
        title={`${overview.canReview ? "Review" : "Damage reports"} · ${overview.move.label}`}
        back={{ href: `/moves/${moveId}`, label: "Inventory" }}
      />
      <ReviewScreen initialOverview={overview} />
    </>
  );
}
