"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkerView } from "@/lib/api-types";

export function isMock(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "1";
}

/** Keeps ?mock=1 on internal links while previewing with canned data. */
export function withMock(href: string): string {
  return isMock() ? `${href}${href.includes("?") ? "&" : "?"}mock=1` : href;
}

async function mockFor(url: string, method: string): Promise<unknown> {
  const m = await import("@/lib/mock-data");
  return m.mockResponse(url, method);
}

export async function api<T>(url: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  const method = init?.method ?? "GET";
  if (isMock()) return (await mockFor(url, method)) as T;
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = json && typeof json === "object" && "error" in json ? String((json as { error: unknown }).error) : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return json as T;
}

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** True when the last attempt failed but older data is still shown. */
  stale: boolean;
  refresh: () => void;
}

/**
 * Bounded polling. `nextDelay` decides the wait after each response; return
 * null to stop. Polling pauses while the tab is hidden and resumes on return.
 */
export function usePoll<T>(url: string | null, nextDelay: (data: T | null) => number | null): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const delayRef = useRef(nextDelay);
  delayRef.current = nextDelay;
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let again = false;
    let latest: T | null = null;
    // A different URL is a different resource: do not show the previous one while it loads.
    setData(null);
    setError(null);
    setLoading(true);

    const schedule = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      const d = delayRef.current(latest);
      if (d == null) return;
      timer = setTimeout(tick, d);
    };

    const tick = async () => {
      if (cancelled) return;
      if (inFlight) {
        again = true; // a refresh asked for during a request runs right after it
        return;
      }
      if (document.hidden) return; // resumed by visibilitychange
      inFlight = true;
      try {
        const next = await api<T>(url);
        if (cancelled) return;
        latest = next;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
          if (again) {
            again = false;
            void tick();
          } else schedule();
        }
      }
    };

    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    kick.current = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url]);

  const refresh = useCallback(() => kick.current(), []);
  return { data, error, loading, stale: error != null && data != null, refresh };
}

/* Worker status shared with the top bar, so pages that already poll don't trigger a second request. */
type WorkerSnapshot = { worker: WorkerView | null; at: number; unreachable: boolean };
let workerState: WorkerSnapshot = { worker: null, at: 0, unreachable: false };
const workerSubs = new Set<() => void>();

export function publishWorker(worker: WorkerView | null, unreachable = false): void {
  workerState = { worker: worker ?? workerState.worker, at: Date.now(), unreachable };
  workerSubs.forEach((f) => f());
}

export function useWorker(): WorkerSnapshot {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    workerSubs.add(f);
    // Pages that poll overview or scenarios publish the worker themselves; this only fills the gap elsewhere.
    const check = async () => {
      if (document.hidden || Date.now() - workerState.at < 12_000) return;
      try {
        const o = await api<{ worker: WorkerView }>("/api/health");
        publishWorker(o.worker);
      } catch {
        publishWorker(null, true);
      }
    };
    const first = setTimeout(check, 1_200);
    const id = setInterval(check, 5_000);
    return () => {
      workerSubs.delete(f);
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  return workerState;
}
