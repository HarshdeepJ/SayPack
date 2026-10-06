import { route } from "@/server/http";

export const GET = route("auth.me", ({ actor }) => actor);
