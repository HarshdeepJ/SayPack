"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { ItemPanel } from "@/components/item-panel";
import {
  BoxStatusBadge,
  ItemFlags,
  SaveStatus,
  actionLabel,
  describeChange,
  formatTime,
} from "@/components/ui";
import { apiGet, apiSend, useCommand, useLocalValue, usePolling } from "@/lib/client-api";
import type { ActivityEntry, BoxView, ItemView, MoveOverview, RoomView } from "@/lib/types";

interface Selection {
  roomId: string;
  boxId: string;
}

function parseSelection(raw: string | null): Selection {
  try {
    const value = JSON.parse(raw ?? "");
    return { roomId: String(value?.roomId ?? ""), boxId: String(value?.boxId ?? "") };
  } catch {
    return { roomId: "", boxId: "" };
  }
}

interface ItemInput {
  boxId: string | null;
  description: string;
  category: string;
  fragile: boolean;
  valuable: boolean;
}

export function PackScreen({ initialOverview }: { initialOverview: MoveOverview }) {
  const moveId = initialOverview.move.id;
  const [overview, setOverview] = useState(initialOverview);
  // The active room and box are a per-device convenience; milestone 3 adds
  // server-side packing sessions for voice context.
  const [rawSelection, setRawSelection] = useLocalValue(`saypack.pack.${moveId}`);
  const { roomId, boxId } = parseSelection(rawSelection);
  const [contents, setContents] = useState<ItemView[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<ItemView | null>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const select = (next: Selection) => setRawSelection(JSON.stringify(next));

  const activeBox = overview.boxes.find((b) => b.id === boxId) ?? null;
  const roomBoxes = roomId ? overview.boxes.filter((b) => b.roomId === roomId) : overview.boxes;

  const load = useCallback(async () => {
    const [ov, act, box] = await Promise.all([
      apiGet<MoveOverview>(`/api/moves/${moveId}`),
      apiGet<ActivityEntry[]>(`/api/moves/${moveId}/activity?mine=1&limit=10`),
      boxId
        ? apiGet<{ items: ItemView[] }>(`/api/moves/${moveId}/items?boxId=${boxId}&limit=100`)
        : Promise.resolve(null),
    ]);
    if (ov.ok) setOverview(ov.data);
    if (act.ok) setActivity(act.data);
    setContents(box?.ok ? box.data.items : []);
  }, [moveId, boxId]);

  usePolling(load, 4000);

  const record = useCommand(
    (actionId, input: ItemInput) =>
      apiSend<ItemView>("POST", `/api/moves/${moveId}/items`, {
        actionId,
        boxId: input.boxId,
        description: input.description,
        category: input.category || null,
        fragile: input.fragile,
        valuable: input.valuable,
      }),
    {
      onSaved: (item) => {
        setLastSaved(item);
        formRef.current?.reset();
        descriptionRef.current?.focus();
        void load();
      },
    },
  );

  const changeBox = useCommand(
    (actionId, input: { box: BoxView; to: "seal" | "reopen" }) =>
      apiSend<BoxView>("POST", `/api/boxes/${input.box.id}/${input.to}`, {
        actionId,
        expectedRevision: input.box.revision,
      }),
    { onSaved: () => void load() },
  );

  function submitItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLastSaved(null);
    void record.run({
      boxId: boxId || null,
      description: String(form.get("description") ?? ""),
      category: String(form.get("category") ?? ""),
      fragile: form.get("fragile") === "on",
      valuable: form.get("valuable") === "on",
    });
  }

  const sealed = activeBox?.status === "sealed";

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-4 lg:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-4">
        <section aria-labelledby="context-heading" className="card space-y-3 p-4">
          <h1 id="context-heading" className="sr-only">
            Packing context
          </h1>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="room" className="label">
                Room
              </label>
              <select
                id="room"
                className="input"
                value={roomId}
                onChange={(e) => {
                  const nextRoom = e.target.value;
                  const keepBox = overview.boxes.find((b) => b.id === boxId && (!nextRoom || b.roomId === nextRoom));
                  select({ roomId: nextRoom, boxId: keepBox ? boxId : "" });
                }}
              >
                <option value="">All rooms</option>
                {overview.rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="box" className="label">
                Active box
              </label>
              <select
                id="box"
                className="input"
                value={boxId}
                onChange={(e) => select({ roomId, boxId: e.target.value })}
              >
                <option value="">No box (record unboxed)</option>
                {roomBoxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                    {b.status !== "open" ? ` — ${b.status}` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <NewRoom moveId={moveId} onCreated={(room) => { select({ roomId: room.id, boxId: "" }); void load(); }} />
            <NewBox
              moveId={moveId}
              rooms={overview.rooms}
              defaultRoomId={roomId}
              onCreated={(box) => {
                select({ roomId: box.roomId ?? roomId, boxId: box.id });
                void load();
              }}
            />
          </div>
        </section>

        <section aria-labelledby="active-box-heading" className="card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="active-box-heading" className="text-lg font-semibold">
              {activeBox ? `Box ${activeBox.label}` : "No box selected"}
            </h2>
            {activeBox && <BoxStatusBadge status={activeBox.status} />}
            {activeBox && (
              <span className="text-sm text-muted">
                {activeBox.itemCount} items{activeBox.roomName ? ` · ${activeBox.roomName}` : ""}
              </span>
            )}
            {activeBox && activeBox.status !== "delivered" && (
              <button
                type="button"
                className="btn ml-auto"
                disabled={changeBox.saving}
                onClick={() => void changeBox.run({ box: activeBox, to: sealed ? "reopen" : "seal" })}
              >
                {sealed ? "Reopen box" : "Seal box"}
              </button>
            )}
          </div>
          <div className="mt-2">
            <SaveStatus status={changeBox.status} error={changeBox.error} onRetry={changeBox.retry} />
          </div>

          {sealed ? (
            <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
              This box is sealed. Reopen it to add, edit or remove items.
            </p>
          ) : (
            <form ref={formRef} onSubmit={submitItem} className="mt-3 space-y-3">
              <div>
                <label htmlFor="description" className="label">
                  Item description
                </label>
                <input
                  ref={descriptionRef}
                  id="description"
                  name="description"
                  className="input"
                  placeholder="e.g. Blue ceramic vase"
                  required
                  maxLength={200}
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor="category" className="label">
                  Category (optional)
                </label>
                <input id="category" name="category" className="input" maxLength={60} autoComplete="off" />
              </div>
              <div className="flex gap-5 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="fragile" className="size-5" /> Fragile
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="valuable" className="size-5" /> Valuable
                </label>
              </div>
              <button type="submit" disabled={record.saving} className="btn btn-primary min-h-14 w-full text-base">
                {activeBox ? `Add to box ${activeBox.label}` : "Record without a box"}
              </button>
              <SaveStatus
                status={record.status}
                error={record.error}
                onRetry={record.retry}
                savedText={
                  lastSaved
                    ? `Saved: ${lastSaved.description}${lastSaved.boxLabel ? ` in box ${lastSaved.boxLabel}` : ""}.`
                    : "Saved."
                }
              />
            </form>
          )}

          {activeBox && contents.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium">
                In this box ({contents.length})
              </summary>
              <ul className="mt-2 divide-y divide-border text-sm">
                {contents.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(item.id)}
                      className="flex w-full items-center gap-2 py-2 text-left"
                    >
                      <span className="flex-1">{item.description}</span>
                      <ItemFlags fragile={item.fragile} valuable={item.valuable} />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>

      <aside aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="mb-2 font-semibold">
          Your recent actions
        </h2>
        {activity.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <ol className="space-y-2">
            {activity.map((entry) => (
              <li key={entry.id} className="card p-3 text-sm">
                {entry.recordType === "item" ? (
                  <button type="button" onClick={() => setSelected(entry.recordId)} className="text-left">
                    <strong>{actionLabel(entry.action)}</strong> {describeChange(entry.before, entry.after)}
                  </button>
                ) : (
                  <span>
                    <strong>{actionLabel(entry.action)}</strong> {describeChange(entry.before, entry.after)}
                  </span>
                )}
                <span className="block text-xs text-muted">{formatTime(entry.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </aside>

      {selected && (
        <ItemPanel
          itemId={selected}
          boxes={overview.boxes}
          canWrite
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </main>
  );
}

function NewRoom({ moveId, onCreated }: { moveId: string; onCreated: (room: RoomView) => void }) {
  const [open, setOpen] = useState(false);
  const create = useCommand(
    (actionId, name: string) => apiSend<RoomView>("POST", `/api/moves/${moveId}/rooms`, { actionId, name }),
    {
      onSaved: (room) => {
        setOpen(false);
        onCreated(room);
      },
    },
  );
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => { create.reset(); setOpen(true); }}>
        + Room
      </button>
    );
  }
  return (
    <form
      className="flex w-full flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void create.run(String(new FormData(e.currentTarget).get("name") ?? ""));
      }}
    >
      <div className="min-w-40 flex-1">
        <label htmlFor="new-room" className="label">
          New room name
        </label>
        <input id="new-room" name="name" className="input" required maxLength={60} autoFocus />
      </div>
      <button type="submit" className="btn btn-primary" disabled={create.saving}>
        Create
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <div className="w-full">
        <SaveStatus status={create.status} error={create.error} onRetry={create.retry} />
      </div>
    </form>
  );
}

function NewBox({
  moveId,
  rooms,
  defaultRoomId,
  onCreated,
}: {
  moveId: string;
  rooms: RoomView[];
  defaultRoomId: string;
  onCreated: (box: BoxView) => void;
}) {
  const [open, setOpen] = useState(false);
  const create = useCommand(
    (actionId, input: { label: string; roomId: string | null }) =>
      apiSend<BoxView>("POST", `/api/moves/${moveId}/boxes`, { actionId, ...input }),
    {
      onSaved: (box) => {
        setOpen(false);
        onCreated(box);
      },
    },
  );
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => { create.reset(); setOpen(true); }}>
        + Box
      </button>
    );
  }
  return (
    <form
      className="flex w-full flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        void create.run({
          label: String(form.get("label") ?? ""),
          roomId: String(form.get("roomId") ?? "") || null,
        });
      }}
    >
      <div className="min-w-28 flex-1">
        <label htmlFor="new-box" className="label">
          Box label
        </label>
        <input id="new-box" name="label" className="input" required maxLength={40} autoFocus />
      </div>
      <div className="min-w-36 flex-1">
        <label htmlFor="new-box-room" className="label">
          Room
        </label>
        <select id="new-box-room" name="roomId" className="input" defaultValue={defaultRoomId}>
          <option value="">No room</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-primary" disabled={create.saving}>
        Create
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <div className="w-full">
        <SaveStatus status={create.status} error={create.error} onRetry={create.retry} />
      </div>
    </form>
  );
}
