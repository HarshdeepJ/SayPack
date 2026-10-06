"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { MoveHoldBanner } from "@/components/evidence";
import { BoxStatusBadge, ItemFlags, ItemStateBadges } from "@/components/ui";
import { ItemPanel } from "@/components/item-panel";
import { apiGet, usePolling } from "@/lib/client-api";
import type { ItemView, MoveOverview } from "@/lib/types";

type Filter =
  | { kind: "all" }
  | { kind: "box"; id: string }
  | { kind: "room"; id: string }
  | { kind: "unboxed" }
  | { kind: "held" };

const PAGE = 50;

export function InventoryScreen({ initialOverview }: { initialOverview: MoveOverview }) {
  const moveId = initialOverview.move.id;
  const [overview, setOverview] = useState(initialOverview);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [items, setItems] = useState<ItemView[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (query.trim()) params.set("q", query.trim());
    if (filter.kind === "box") params.set("boxId", filter.id);
    if (filter.kind === "room") params.set("roomId", filter.id);
    if (filter.kind === "unboxed") params.set("unboxed", "1");
    if (filter.kind === "held") params.set("held", "1");
    const [ov, list] = await Promise.all([
      apiGet<MoveOverview>(`/api/moves/${moveId}`),
      apiGet<{ items: ItemView[]; hasMore: boolean }>(`/api/moves/${moveId}/items?${params}`),
    ]);
    if (ov.ok) setOverview(ov.data);
    if (list.ok) {
      setItems(list.data.items);
      setHasMore(list.data.hasMore);
    }
    setStale(!ov.ok || !list.ok);
  }, [moveId, query, filter, limit]);

  usePolling(load, 4000);

  const filterLabel =
    filter.kind === "box"
      ? `Box ${overview.boxes.find((b) => b.id === filter.id)?.label ?? ""}`
      : filter.kind === "room"
        ? overview.rooms.find((r) => r.id === filter.id)?.name
        : filter.kind === "unboxed"
          ? "Not in a box"
          : filter.kind === "held"
            ? "Items on hold"
            : null;

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[1fr_20rem]">
      <section aria-labelledby="items-heading" className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h1 id="items-heading" className="text-xl font-semibold">
            Inventory
          </h1>
          <span className="text-sm text-muted">
            {overview.itemCount} items · {overview.boxes.length} boxes
          </span>
          <span className="ml-auto flex gap-2">
            {overview.canReview && (
              <Link href={`/moves/${moveId}/review`} className="btn">
                Review{overview.openIncidents > 0 ? ` (${overview.openIncidents})` : ""}
              </Link>
            )}
            {overview.canWrite && (
              <Link href={`/moves/${moveId}/pack`} className="btn btn-primary">
                Pack
              </Link>
            )}
          </span>
        </div>

        <div className="mb-3 space-y-2">
          <MoveHoldBanner holds={overview.moveHolds} />
          {overview.openIncidents > 0 && (
            <button
              type="button"
              onClick={() => setFilter({ kind: "held" })}
              className="w-full rounded-lg bg-warn-bg px-3 py-2 text-left text-sm text-warn"
            >
              {overview.openIncidents} open damage report{overview.openIncidents === 1 ? "" : "s"}
              {overview.unidentifiedIncidents > 0 ? ` (${overview.unidentifiedIncidents} item unidentified)` : ""}. Show items on hold →
            </button>
          )}
        </div>

        <label htmlFor="search" className="sr-only">
          Search items, boxes and rooms
        </label>
        <input
          id="search"
          type="search"
          className="input mb-2"
          placeholder="Search items, box labels, rooms…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
        />
        {filterLabel && (
          <p className="mb-2 text-sm">
            Showing: <strong>{filterLabel}</strong>{" "}
            <button type="button" className="text-accent underline" onClick={() => setFilter({ kind: "all" })}>
              Clear filter
            </button>
          </p>
        )}
        {stale && (
          <p role="status" className="mb-2 text-sm text-warn">
            Can&apos;t reach the server. Showing the last loaded data.
          </p>
        )}

        {items === null ? (
          <p className="text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="card p-4 text-muted">No items match.</p>
        ) : (
          <ul className="card divide-y divide-border">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelected(item.id)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 font-medium">{item.description}</span>
                  <ItemFlags fragile={item.fragile} valuable={item.valuable} />
                  <ItemStateBadges item={item} />
                  <span className="text-sm text-muted">
                    {item.boxLabel ? `Box ${item.boxLabel}` : "No box"}
                    {item.roomName ? ` · ${item.roomName}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasMore && (
          <button type="button" className="btn mt-3 w-full" onClick={() => setLimit((l) => l + PAGE)}>
            Show more
          </button>
        )}
      </section>

      <aside className="space-y-6">
        <section aria-labelledby="boxes-heading">
          <h2 id="boxes-heading" className="mb-2 font-semibold">
            Boxes
          </h2>
          {overview.boxes.length === 0 ? (
            <p className="text-sm text-muted">No boxes yet.</p>
          ) : (
            <ul className="card divide-y divide-border">
              {overview.boxes.map((box) => (
                <li key={box.id}>
                  <button
                    type="button"
                    aria-pressed={filter.kind === "box" && filter.id === box.id}
                    onClick={() => setFilter({ kind: "box", id: box.id })}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2 aria-pressed:bg-surface-2"
                  >
                    <span className="font-medium">{box.label}</span>
                    <BoxStatusBadge status={box.status} />
                    <span className="ml-auto text-muted">
                      {box.itemCount} · {box.roomName ?? "no room"}
                    </span>
                  </button>
                </li>
              ))}
              {overview.unboxedCount > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => setFilter({ kind: "unboxed" })}
                    className="flex w-full px-3 py-2 text-left text-sm text-muted hover:bg-surface-2"
                  >
                    Not in a box ({overview.unboxedCount})
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>
        {overview.rooms.length > 0 && (
          <section aria-labelledby="rooms-heading">
            <h2 id="rooms-heading" className="mb-2 font-semibold">
              Rooms
            </h2>
            <ul className="flex flex-wrap gap-2">
              {overview.rooms.map((room) => (
                <li key={room.id}>
                  <button
                    type="button"
                    aria-pressed={filter.kind === "room" && filter.id === room.id}
                    onClick={() => setFilter({ kind: "room", id: room.id })}
                    className="btn min-h-9 px-3 aria-pressed:border-accent"
                  >
                    {room.name} ({room.boxCount})
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>

      {selected && (
        <ItemPanel
          itemId={selected}
          boxes={overview.boxes}
          canWrite={overview.canWrite}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </main>
  );
}
