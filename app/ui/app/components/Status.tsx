import React from "react";
import { HealthIndicator } from "@dynatrace/strato-components/content";
import type { Verdict } from "../model/types";

const STATUS = { Critical: "critical", Warning: "warning", Healthy: "ideal", "Not monitored": "neutral" } as const;

export const VERDICT_LABEL: Record<Verdict, string> = {
  Critical: "Critical", Warning: "Warning", Healthy: "Healthy", "Not monitored": "Not monitored",
};

/** Status shape plus label — never color alone (Dynatrace status and health pattern). */
export function Status({ verdict, label }: { verdict: Verdict; label?: string | false }) {
  const text = label === false ? undefined : label ?? VERDICT_LABEL[verdict];
  return (
    <HealthIndicator status={STATUS[verdict]} visual="shape" aria-label={text ? undefined : VERDICT_LABEL[verdict]}>
      {text && <HealthIndicator.Label>{text}</HealthIndicator.Label>}
    </HealthIndicator>
  );
}
