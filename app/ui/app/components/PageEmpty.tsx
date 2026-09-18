// A page with nothing to draw yet: the app stays usable, so only the body of this view is replaced by
// what is missing and where it is configured. Views whose data did arrive keep working next to it.
// The steps themselves live in Settings › Data, so this points there instead of repeating them.
import React from "react";
import { EmptyState } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import type { Need, NeedKey } from "../data/requirements";

interface Props {
  title: string;
  detail: string;
  keys: NeedKey[];
  needs: Record<NeedKey, Need>;
  /** The data type this page is waiting for: Settings opens on that entry. */
  configure?: NeedKey;
  onSettings?: (key: NeedKey) => void;
  /** Missing on the example network, where the data is simulated and there is nothing to send. */
  onExample?: () => void;
}

export function PageEmpty({ title, detail, keys, needs, configure, onSettings, onExample }: Props) {
  // whatever the caller names, or the first thing this view needs that is not arriving
  const target = configure ?? keys.find((k) => needs[k] && (needs[k].status === "missing" || needs[k].status === "partial"));
  return (
    <div className="vz-body vz-empty">
      <EmptyState>
        <EmptyState.VisualPreset context="generic" type="something-missing" />
        <EmptyState.Title>{title}</EmptyState.Title>
        <EmptyState.Details>{detail}</EmptyState.Details>
        <EmptyState.Actions>
          {onSettings && target && (
            <Button variant="emphasized" onClick={() => onSettings(target)}>Settings › {needs[target]?.label ?? "Data"}</Button>
          )}
          {onExample && <Button onClick={onExample}>Show example</Button>}
        </EmptyState.Actions>
      </EmptyState>
    </div>
  );
}
