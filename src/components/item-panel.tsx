"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  BoxStatusBadge,
  ItemFlags,
  SaveStatus,
  actionLabel,
  describeChange,
  formatTime,
} from "@/components/ui";
import { apiGet, apiSend, useCommand, usePolling } from "@/lib/client-api";
import type { BoxView, HistoryEntry, ItemView } from "@/lib/types";

interface Detail {
  item: ItemView;
  history: HistoryEntry[];
}

interface EditInput {
  revision: number;
  description: string;
  category: string;
  fragile: boolean;
  valuable: boolean;
}

export function ItemPanel({
  itemId,
  boxes,
  canWrite,
  onClose,
  onChanged,
}: {
  itemId: string;
  boxes: BoxView[];
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    const result = await apiGet<Detail>(`/api/items/${itemId}`);
    if (result.ok) {
      setDetail(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.error.message);
    }
  }, [itemId]);

  usePolling(reload, 4000);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A stale revision means someone else changed the item; show their version.
  const onError = (error: { reason: string }) => {
    if (error.reason === "stale_revision") void reload();
  };

  const afterSave = () => {
    void reload();
    onChanged();
  };

  const edit = useCommand(
    (actionId, input: EditInput) =>
      apiSend<ItemView>("PATCH", `/api/items/${itemId}`, {
        actionId,
        expectedRevision: input.revision,
        description: input.description,
        category: input.category || null,
        fragile: input.fragile,
        valuable: input.valuable,
      }),
    {
      onSaved: () => {
        setEditing(false);
        afterSave();
      },
      onError,
    },
  );

  const move = useCommand(
    (actionId, input: { revision: number; boxId: string | null }) =>
      apiSend<ItemView>("POST", `/api/items/${itemId}/box`, {
        actionId,
        expectedRevision: input.revision,
        boxId: input.boxId,
      }),
    { onSaved: afterSave, onError },
  );

  function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const form = new FormData(event.currentTarget);
    void edit.run({
      revision: detail.item.revision,
      description: String(form.get("description") ?? ""),
      category: String(form.get("category") ?? ""),
      fragile: form.get("fragile") === "on",
      valuable: form.get("valuable") === "on",
    });
  }

  const item = detail?.item;
  const itemBox = boxes.find((b) => b.id === item?.boxId);

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-panel-title"
        className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-bg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
          <h2 id="item-panel-title" className="min-w-0 flex-1 truncate font-semibold">
            {item?.description ?? "Item"}
          </h2>
          <button ref={closeRef} type="button" className="btn min-h-9 px-3" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="space-y-5 p-4">
          {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
          {!item ? (
            !loadError && <p className="text-muted">Loading…</p>
          ) : (
            <>
              <dl className="card grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 p-4 text-sm">
                <dt className="text-muted">Box</dt>
                <dd className="flex items-center gap-2">
                  {item.boxLabel ?? "Not in a box"}
                  {item.boxStatus && <BoxStatusBadge status={item.boxStatus} />}
                </dd>
                <dt className="text-muted">Room</dt>
                <dd>{item.roomName ?? "—"}</dd>
                <dt className="text-muted">Category</dt>
                <dd>{item.category ?? "—"}</dd>
                <dt className="text-muted">Handling</dt>
                <dd className="flex gap-1">
                  {item.fragile || item.valuable ? (
                    <ItemFlags fragile={item.fragile} valuable={item.valuable} />
                  ) : (
                    "Standard"
                  )}
                </dd>
                <dt className="text-muted">Status</dt>
                <dd className="capitalize">{item.status}</dd>
                <dt className="text-muted">Item ID</dt>
                <dd className="truncate font-mono text-xs">{item.id}</dd>
              </dl>

              {canWrite && (
                <section aria-labelledby="edit-heading" className="space-y-3">
                  <div className="flex items-center">
                    <h3 id="edit-heading" className="font-semibold">
                      Correct this item
                    </h3>
                    {!editing && (
                      <button type="button" className="btn ml-auto min-h-9 px-3" onClick={() => setEditing(true)}>
                        Edit
                      </button>
                    )}
                  </div>
                  {itemBox?.status === "sealed" && (
                    <p className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
                      Box {itemBox.label} is sealed. Reopen it on the Pack screen to change this item.
                    </p>
                  )}
                  {editing && (
                    <form onSubmit={submitEdit} className="card space-y-3 p-4" key={item.revision}>
                      <div>
                        <label htmlFor="edit-description" className="label">
                          Description
                        </label>
                        <input
                          id="edit-description"
                          name="description"
                          className="input"
                          defaultValue={item.description}
                          required
                          maxLength={200}
                        />
                      </div>
                      <div>
                        <label htmlFor="edit-category" className="label">
                          Category (optional)
                        </label>
                        <input
                          id="edit-category"
                          name="category"
                          className="input"
                          defaultValue={item.category ?? ""}
                          maxLength={60}
                        />
                      </div>
                      <div className="flex gap-4 text-sm">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" name="fragile" defaultChecked={item.fragile} className="size-5" />
                          Fragile
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" name="valuable" defaultChecked={item.valuable} className="size-5" />
                          Valuable
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <button type="submit" disabled={edit.saving} className="btn btn-primary flex-1">
                          Save changes
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setEditing(false);
                            edit.reset();
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                  <SaveStatus status={edit.status} error={edit.error} onRetry={edit.retry} />

                  <div>
                    <label htmlFor="move-box" className="label">
                      Move to box
                    </label>
                    <select
                      id="move-box"
                      className="input"
                      value={item.boxId ?? ""}
                      disabled={move.saving}
                      onChange={(e) => void move.run({ revision: item.revision, boxId: e.target.value || null })}
                    >
                      <option value="">Not in a box</option>
                      {boxes.map((b) => (
                        <option key={b.id} value={b.id} disabled={b.status !== "open" && b.id !== item.boxId}>
                          {b.label}
                          {b.roomName ? ` (${b.roomName})` : ""}
                          {b.status !== "open" ? ` — ${b.status}` : ""}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2">
                      <SaveStatus status={move.status} error={move.error} onRetry={move.retry} savedText="Moved." />
                    </div>
                  </div>
                </section>
              )}

              <section aria-labelledby="history-heading">
                <h3 id="history-heading" className="mb-2 font-semibold">
                  History
                </h3>
                <ol className="space-y-2">
                  {detail.history.map((entry) => (
                    <li key={entry.id} className="card p-3 text-sm">
                      <p>
                        <strong>{actionLabel(entry.action)}</strong>{" "}
                        <span className="text-muted">
                          by {entry.actorName} · {formatTime(entry.createdAt)}
                        </span>
                      </p>
                      <p className="mt-1 break-words text-muted">{describeChange(entry.before, entry.after)}</p>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
