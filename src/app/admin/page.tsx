import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/ui";
import { pageActor } from "@/server/http";
import { AdminScreen } from "./admin-screen";

export default async function AdminPage() {
  const actor = await pageActor();
  if (!actor) redirect("/login?next=/admin");
  if (!actor.isAdmin) notFound();
  return (
    <>
      <AppHeader userName={actor.displayName} isAdmin title="Administration" back={{ href: "/moves", label: "Moves" }} />
      <AdminScreen selfId={actor.id} />
    </>
  );
}
