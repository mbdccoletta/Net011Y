// The single verdict definition. The app does not judge health on its own: a device, an interface or a
// site is unhealthy when Dynatrace has an open problem or alert on it — from Davis, from an alert
// template or from a custom alert. The only threshold the app applies itself is the SLA the customer
// configured on the circuit (primary tag sla_ms), because that number is the customer's input.
import type { Circuit, AppExperience, Device, DeviceProblem, Reason, Verdict } from "./types";

/**
 * Reference marks for the charts and for descriptive labels ("saturated", "high") — never a verdict.
 * What turns a device red is an open problem in Dynatrace, not a number in this file.
 */
export const T = {
  util_warn: 80, util_crit: 95,
  cpu_warn: 70, cpu_crit: 85,
  avail_crit: 99,
  icmp_loss_warn: 2,
  retr_warn: 1, retr_crit: 3,
  syslog_sev_warn: 3,
};

export const ORDER: Record<Verdict, number> = { Critical: 0, Warning: 1, Healthy: 2, "Not monitored": 3 };
const ROLE_WEIGHT: Record<string, number> = { core: 5, edge: 5, firewall: 4, lb: 4, switch: 3, wlc: 3, compute: 3, ap: 2, endpoint: 1 };

export const isBad = (v: Verdict | undefined | null) => v === "Critical" || v === "Warning";

export function worst(verdicts: (Verdict | undefined | null)[]): Verdict {
  const vs = verdicts.filter((v): v is Verdict => !!v && v !== "Not monitored");
  if (!vs.length) return "Not monitored";
  return vs.reduce((a, b) => (ORDER[a] <= ORDER[b] ? a : b));
}

function fold(reasons: Reason[]): [Verdict, Reason[]] {
  const levels = reasons.map((r) => r.level);
  const v: Verdict = levels.includes("Critical") ? "Critical" : levels.includes("Warning") ? "Warning" : "Healthy";
  return [v, [...reasons].sort((a, b) => ORDER[a.level] - ORDER[b.level])];
}

const hhmm = (iso?: string) => (iso || "").slice(11, 16);

/** Problems Dynatrace is currently raising: muted ones are ignored here exactly as they are there. */
export const openProblems = (problems: DeviceProblem[] | undefined): DeviceProblem[] => (problems ?? []).filter((p) => !p.muted);

/**
 * How a problem shows up in the app. This is presentation of the category Davis already assigned,
 * not a severity the app invents: a slowdown or a resource contention is a warning, anything else
 * (availability, error, a custom alert the customer wrote) is critical.
 */
export const problemLevel = (p: DeviceProblem): Verdict =>
  p.category === "SLOWDOWN" || p.category === "RESOURCE_CONTENTION" ? "Warning" : "Critical";

export const problemReason = (p: DeviceProblem): Reason => ({
  level: problemLevel(p),
  text: `${p.name}${p.on ? ` · ${p.on}` : ""}${p.displayId ? ` (${p.displayId})` : ""}`,
});

export function deviceVerdict(d: Device): [Verdict, Reason[], number] {
  const open = openProblems(d.problems);
  // an alert counts even on a device nobody polls: Dynatrace is watching it through something else
  // (an extension of its own, a synthetic monitor), and hiding that behind "not monitored" loses it
  if (!open.length && d.mode !== "Extension") {
    return ["Not monitored", [{ level: "Not monitored", text: "Discovered, but no polling extension is active" }], 0];
  }
  if (!open.length) return ["Healthy", [], 0];
  const [v, reasons] = fold(open.map(problemReason));
  const impact = (ROLE_WEIGHT[d.role] ?? 1) * (v === "Critical" ? 3 : v === "Warning" ? 1 : 0);
  return [v, reasons, impact];
}

export function circuitVerdict(c: Circuit): [Verdict, Reason[]] {
  const reasons: Reason[] = openProblems(c.problems).map(problemReason);
  if (c.status === "down") {
    reasons.push({ level: "Critical", text: `The network availability monitor gets no answer since ${hhmm(c.since)} UTC` });
  } else if (c.latencyMs == null) {
    if (!reasons.length) return ["Not monitored", [{ level: "Not monitored", text: c.note || "not measured" }]];
  } else if (c.latencyMs > c.slaMs) {
    // the one number the app checks itself, because the customer configured it on the monitor
    reasons.push({ level: "Warning", text: `Latency ${c.latencyMs} ms above the ${c.slaMs} ms SLA you configured` });
  }
  return fold(reasons);
}

export function appVerdict(a: AppExperience): [Verdict, Reason[]] {
  // No thresholds here either: the only statement the data makes by itself is that the site stopped
  // sending sessions. Slowness and errors are numbers the screens show; alerting on them is Davis's job.
  if (!a.sessions) {
    // a site that used to send sessions and stopped is a statement; one that never sent any is simply
    // not measured, and colouring it red would invent a fault where there is only missing data
    // not through fold(), which reads anything short of a warning as healthy
    if (!a.baselineSessions) return ["Not monitored", [{ level: "Not monitored", text: "No sessions reported for this site" }]];
    return fold([{ level: "Critical", text: "No sessions from the site in the last hour" }]);
  }
  return ["Healthy", []];
}
