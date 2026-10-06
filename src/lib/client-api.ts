"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface ApiError {
  code: string;
  reason: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const NETWORK_ERROR: ApiError = {
  code: "network",
  reason: "network",
  message: "Could not reach the server. Nothing was confirmed as saved.",
};

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth/login")) {
    // A full page load on purpose: it discards all client state from the expired session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  if (!response.ok || !body || !("data" in body)) {
    return { ok: false, error: body?.error ?? { ...NETWORK_ERROR, code: "internal", reason: "internal" } };
  }
  return { ok: true, data: body.data as T };
}

export const apiGet = <T>(url: string) => call<T>(url, { cache: "no-store" });

/**
 * Sends a multipart form. The browser sets the multipart content type, so the
 * JSON content-type default is removed here.
 */
export async function apiUpload<T>(url: string, form: FormData): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: form });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !("data" in body)) {
    return { ok: false, error: body?.error ?? { ...NETWORK_ERROR, code: "internal", reason: "internal" } };
  }
  return { ok: true, data: body.data as T };
}

const MAX_PHOTO_EDGE = 2000;

/**
 * Shrinks a camera photo to at most 2000px on its long edge as JPEG, which keeps
 * uploads quick on mobile data and disk use modest. Falls back to the original file.
 */
export async function preparePhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === "image/jpeg") {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

export const apiSend = <T>(method: "POST" | "PATCH" | "DELETE", url: string, body: unknown) =>
  call<T>(url, { method, body: JSON.stringify(body) });

export type CommandStatus = "idle" | "saving" | "saved" | "failed" | "unsent";

/**
 * Sends a mutation with a client action ID.
 * If the network fails, the same action ID is kept for retry(), so a request
 * the server did commit is returned rather than applied twice.
 * Any server answer (success or error) ends the attempt; the next run() gets a new ID.
 */
export function useCommand<TIn, TOut>(
  send: (actionId: string, input: TIn) => Promise<ApiResult<TOut>>,
  options: {
    onSaved?: (data: TOut, input: TIn) => void;
    onError?: (error: ApiError, input: TIn) => void;
  } = {},
) {
  const [status, setStatus] = useState<CommandStatus>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const pending = useRef<{ actionId: string; input: TIn } | null>(null);
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });

  const attempt = useCallback(
    async (actionId: string, input: TIn) => {
      pending.current = { actionId, input };
      setStatus("saving");
      setError(null);
      const result = await send(actionId, input);
      if (result.ok) {
        pending.current = null;
        setStatus("saved");
        callbacks.current.onSaved?.(result.data, input);
        return result;
      }
      if (result.error.code === "network") {
        setStatus("unsent");
      } else {
        pending.current = null;
        setStatus("failed");
      }
      setError(result.error);
      callbacks.current.onError?.(result.error, input);
      return result;
    },
    [send],
  );

  const run = useCallback((input: TIn) => attempt(crypto.randomUUID(), input), [attempt]);
  const retry = useCallback(() => {
    const p = pending.current;
    return p ? attempt(p.actionId, p.input) : undefined;
  }, [attempt]);
  const reset = useCallback(() => {
    pending.current = null;
    setStatus("idle");
    setError(null);
  }, []);

  return { run, retry, reset, status, error, saving: status === "saving" };
}

/** Polls while the tab is visible; refreshes immediately when it becomes visible again. */
export function usePolling(load: () => void | Promise<void>, intervalMs = 4000) {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await loadRef.current();
      if (!stopped) timer = setTimeout(tick, document.hidden ? intervalMs * 4 : intervalMs);
    };
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void tick();
      }
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
}

const LOCAL_EVENT = "saypack-local-storage";

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * A per-device preference kept in localStorage (e.g. the active box).
 * Renders the fallback on the server and when storage is unavailable.
 */
export function useLocalValue(key: string): [string | null, (value: string) => void] {
  const value = useSyncExternalStore(
    (notify) => {
      window.addEventListener("storage", notify);
      window.addEventListener(LOCAL_EVENT, notify);
      return () => {
        window.removeEventListener("storage", notify);
        window.removeEventListener(LOCAL_EVENT, notify);
      };
    },
    () => readLocal(key),
    () => null,
  );
  const set = useCallback(
    (next: string) => {
      try {
        localStorage.setItem(key, next);
      } catch {
        // Storage unavailable: the value just won't persist.
      }
      window.dispatchEvent(new Event(LOCAL_EVENT));
    },
    [key],
  );
  return [value, set];
}
