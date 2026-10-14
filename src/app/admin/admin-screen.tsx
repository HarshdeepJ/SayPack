"use client";

import { useCallback, useState, type FormEvent } from "react";
import { Badge, SaveStatus } from "@/components/ui";
import { apiGet, apiSend, useCommand, usePolling } from "@/lib/client-api";
import type { AdminMoveSummary, UserSummary } from "@/lib/types";
import { AiUsageCard } from "./ai-usage";

type Role = "mover" | "reviewer" | "owner";

export function AdminScreen({ selfId }: { selfId: string }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [moves, setMoves] = useState<AdminMoveSummary[]>([]);

  const load = useCallback(async () => {
    const [u, m] = await Promise.all([
      apiGet<UserSummary[]>("/api/admin/users"),
      apiGet<AdminMoveSummary[]>("/api/admin/moves"),
    ]);
    if (u.ok) setUsers(u.data);
    if (m.ok) setMoves(m.data);
  }, []);

  usePolling(load, 10000);

  const createUser = useCommand(
    (actionId, input: { email: string; displayName: string; password: string; isAdmin: boolean }) =>
      apiSend<UserSummary>("POST", "/api/admin/users", { actionId, ...input }),
    { onSaved: () => void load() },
  );

  const setActive = useCommand(
    (actionId, input: { userId: string; active: boolean }) =>
      apiSend("POST", `/api/admin/users/${input.userId}/active`, { actionId, active: input.active }),
    { onSaved: () => void load() },
  );

  const createMove = useCommand(
    (actionId, input: { label: string; source: string; destination: string }) =>
      apiSend<AdminMoveSummary>("POST", "/api/admin/moves", { actionId, ...input }),
    { onSaved: () => void load() },
  );

  function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    void createUser
      .run({
        email: String(form.get("email") ?? ""),
        displayName: String(form.get("displayName") ?? ""),
        password: String(form.get("password") ?? ""),
        isAdmin: form.get("isAdmin") === "on",
      })
      .then((r) => r.ok && formEl.reset());
  }

  function submitMove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    void createMove
      .run({
        label: String(form.get("label") ?? ""),
        source: String(form.get("source") ?? ""),
        destination: String(form.get("destination") ?? ""),
      })
      .then((r) => r.ok && formEl.reset());
  }

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-8 px-4 py-6 lg:grid-cols-2">
      <section aria-labelledby="moves-heading" className="space-y-4">
        <h1 id="moves-heading" className="text-xl font-semibold">
          Moves
        </h1>
        <form onSubmit={submitMove} className="card space-y-3 p-4">
          <h2 className="font-semibold">New move</h2>
          <div>
            <label htmlFor="move-label" className="label">
              Label
            </label>
            <input id="move-label" name="label" className="input" required maxLength={120} placeholder="e.g. Tan family" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="move-source" className="label">
                From
              </label>
              <input id="move-source" name="source" className="input" required maxLength={200} />
            </div>
            <div>
              <label htmlFor="move-destination" className="label">
                To
              </label>
              <input id="move-destination" name="destination" className="input" required maxLength={200} />
            </div>
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={createMove.saving}>
            Create move
          </button>
          <SaveStatus status={createMove.status} error={createMove.error} onRetry={createMove.retry} savedText="Move created." />
        </form>

        {moves.map((move) => (
          <MoveMembers key={move.id} move={move} users={users} onChanged={load} />
        ))}
      </section>

      <section aria-labelledby="users-heading" className="space-y-4">
        <AiUsageCard />
        <h2 id="users-heading" className="text-xl font-semibold">
          Users
        </h2>
        <form onSubmit={submitUser} className="card space-y-3 p-4">
          <h3 className="font-semibold">New user</h3>
          <div>
            <label htmlFor="user-name" className="label">
              Display name
            </label>
            <input id="user-name" name="displayName" className="input" required maxLength={80} />
          </div>
          <div>
            <label htmlFor="user-email" className="label">
              Email
            </label>
            <input id="user-email" name="email" type="email" className="input" required autoComplete="off" />
          </div>
          <div>
            <label htmlFor="user-password" className="label">
              Initial password (at least 10 characters)
            </label>
            <input
              id="user-password"
              name="password"
              type="password"
              className="input"
              required
              minLength={10}
              autoComplete="new-password"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isAdmin" className="size-5" /> Administrator
          </label>
          <button type="submit" className="btn btn-primary w-full" disabled={createUser.saving}>
            Create user
          </button>
          <SaveStatus status={createUser.status} error={createUser.error} onRetry={createUser.retry} savedText="User created." />
        </form>

        <SaveStatus status={setActive.status} error={setActive.error} onRetry={setActive.retry} />
        <ul className="card divide-y divide-border">
          {users.map((user) => (
            <li key={user.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
              <span className="font-medium">{user.displayName}</span>
              <span className="text-muted">{user.email}</span>
              {user.isAdmin && <Badge tone="neutral">Admin</Badge>}
              {!user.active && <Badge tone="danger">Deactivated</Badge>}
              {user.id !== selfId && (
                <button
                  type="button"
                  className="ml-auto text-accent underline"
                  disabled={setActive.saving}
                  onClick={() => void setActive.run({ userId: user.id, active: !user.active })}
                >
                  {user.active ? "Deactivate" : "Reactivate"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function MoveMembers({
  move,
  users,
  onChanged,
}: {
  move: AdminMoveSummary;
  users: UserSummary[];
  onChanged: () => void;
}) {
  const membership = (method: "POST" | "DELETE") => (actionId: string, input: { userId: string; role: Role }) =>
    apiSend(method, `/api/admin/moves/${move.id}/members`, { actionId, ...input });
  const add = useCommand(membership("POST"), { onSaved: onChanged });
  const remove = useCommand(membership("DELETE"), { onSaved: onChanged });

  return (
    <article className="card space-y-3 p-4">
      <div>
        <h3 className="font-semibold">{move.label}</h3>
        <p className="text-sm text-muted">
          {move.source} → {move.destination}
        </p>
      </div>
      {move.members.length === 0 ? (
        <p className="text-sm text-muted">No members yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {move.members.map((m) => (
            <li key={`${m.userId}:${m.role}`} className="flex items-center gap-2 py-2">
              <span>{m.displayName}</span>
              <Badge tone="neutral">{m.role}</Badge>
              <button
                type="button"
                className="ml-auto text-accent underline"
                disabled={remove.saving}
                onClick={() => void remove.run({ userId: m.userId, role: m.role })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          void add.run({ userId: String(form.get("userId")), role: String(form.get("role")) as Role });
        }}
      >
        <div className="min-w-36 flex-1">
          <label htmlFor={`member-${move.id}`} className="label">
            Add member
          </label>
          <select id={`member-${move.id}`} name="userId" className="input" required defaultValue="">
            <option value="" disabled>
              Choose a user
            </option>
            {users
              .filter((u) => u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor={`role-${move.id}`} className="label">
            Role
          </label>
          <select id={`role-${move.id}`} name="role" className="input">
            <option value="mover">Mover</option>
            <option value="reviewer">Reviewer</option>
            <option value="owner">Owner</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={add.saving}>
          Add
        </button>
      </form>
      <SaveStatus status={add.status} error={add.error} onRetry={add.retry} />
      <SaveStatus status={remove.status} error={remove.error} onRetry={remove.retry} savedText="Member removed." />
    </article>
  );
}
