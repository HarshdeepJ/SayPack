import { redirect } from "next/navigation";
import { pageActor } from "@/server/http";
import { LoginForm } from "./login-form";

/** Only same-site paths, so the next parameter cannot redirect off-site. */
function safeNext(next: string | string[] | undefined) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/moves";
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = safeNext((await searchParams).next);
  if (await pageActor()) redirect(next);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold">SayPack</h1>
      <p className="mb-6 text-sm text-muted">Sign in to record and find packed items.</p>
      <LoginForm next={next} />
    </main>
  );
}
