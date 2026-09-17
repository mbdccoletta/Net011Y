import type { Verdict } from "../model/types";

export const fmtInt = (n?: number | null) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));

export const fmtNum = (v: number | string | null | undefined, digits = 2) =>
  v == null || v === "—" ? "—" : typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: digits }) : String(v);

export function fmtBytes(b?: number | null) {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
}

export function fmtBps(b?: number | null) {
  if (b == null) return "—";
  const u = ["bps", "kbps", "Mbps", "Gbps", "Tbps"];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return `${b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
}

export const speedLabel = (s?: number | null) => (!s ? "—" : s >= 1000 ? `${+(s / 1000).toFixed(1)} Gbps` : `${s} Mbps`);

export const hhmm = (iso?: string | null) => (iso ? `${iso.slice(11, 16)} UTC` : "—");

/** "BR-MT-SOR1-RTR1: No ICMP…" → "No ICMP…" */
export const stripDevice = (t?: string | null) => (t || "").replace(/^[A-Z0-9][A-Za-z0-9-]+: /, "");

/** CSS color for a verdict, always a Strato status token. */
export const toneVar = (v?: Verdict | null) =>
  v === "Critical" ? "var(--np-crit)" : v === "Warning" ? "var(--np-warn)" : v === "Healthy" ? "var(--np-good)" : "var(--np-neutral)";

/** Animation period encodes health: slow when healthy, fast when critical. */
export const PULSE: Partial<Record<Verdict, string>> = { Critical: "1.7s", Warning: "3.2s", Healthy: "6s" };

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function onActivate(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  };
}
