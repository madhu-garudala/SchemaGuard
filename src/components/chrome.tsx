"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { formatAgo } from "@/lib/format";
import { Status } from "./primitives";
import { isMock, useWorker } from "./use-poll";

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    setTheme(attr === "dark" || attr === "light" ? attr : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("sg-theme", next);
    } catch {
      /* private mode */
    }
    setTheme(next);
  };
  return (
    <button type="button" className="btn btn-sm" onClick={flip} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

function WorkerStatus() {
  const { worker, unreachable } = useWorker();
  if (unreachable && !worker) return <Status tone="bad">API unreachable</Status>;
  if (!worker) return <span className="faint">Worker…</span>;
  if (!worker.online) {
    return (
      <span title="Start it with: npm run worker">
        <Status tone="bad">Worker offline</Status> <span className="muted">· last heartbeat {formatAgo(worker.seconds_since_heartbeat)}</span>
      </span>
    );
  }
  return (
    <span title={[worker.model_ref, worker.openclaw_version && `OpenClaw ${worker.openclaw_version}`].filter(Boolean).join(" · ")}>
      <Status tone="good">Worker online</Status>
      {worker.agent_mode && <span className="muted"> · agents: {worker.agent_mode}</span>}
    </span>
  );
}

export function TopBar() {
  const path = usePathname() ?? "/";
  // ?mock=1 is only known in the browser; apply it after hydration so server and client markup agree.
  const [mock, setMock] = useState(false);
  useEffect(() => setMock(isMock()), []);
  const withMock = (href: string) => (mock ? `${href}?mock=1` : href);
  const items = [
    { href: "/", label: "Overview", on: path === "/" || path.startsWith("/runs") },
    { href: "/scenarios", label: "Scenarios", on: path.startsWith("/scenarios") },
  ];
  return (
    <header className="topbar">
      <div className="wrap topbar-in">
        <Link href={withMock("/")} className="brand">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1 14 3.4v4.2c0 3.5-2.4 6.1-6 7.4-3.6-1.3-6-3.9-6-7.4V3.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M5.2 8.1 7.2 10l3.6-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Schema Guard
        </Link>
        <nav className="nav" aria-label="Primary">
          {items.map((i) => (
            <Link key={i.href} href={withMock(i.href)} aria-current={i.on ? "page" : undefined}>
              {i.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          <span aria-live="polite">
            <WorkerStatus />
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function WorkerOfflineNotice({ online, seconds }: { online: boolean; seconds: number | null }) {
  if (online) return null;
  return (
    <div className="notice notice-warn" role="status">
      <strong>Worker offline</strong> — last heartbeat {formatAgo(seconds)}. What you see is the last recorded state, not a live investigation. New runs
      will queue until <code>npm run worker</code> is running.
    </div>
  );
}
