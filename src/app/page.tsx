import { redirect } from "next/navigation";
import { pageActor } from "@/server/http";

export default async function Home() {
  redirect((await pageActor()) ? "/moves" : "/login");
}
