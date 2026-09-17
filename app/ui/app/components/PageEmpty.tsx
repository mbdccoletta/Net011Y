// A page with nothing to draw yet: the app stays usable, so only the body of this view is replaced by
// what is missing and how to send it. Views whose data did arrive keep working next to it.
import React from "react";
import { EmptyState } from "@dynatrace/strato-components/content";
import { Button } from "@dynatrace/strato-components/buttons";
import type { Need, NeedKey } from "../data/requirements";
import { DataNeeds } from "./DataNeeds";

interface Props {
  title: string;
  detail: string;
  keys: NeedKey[];
  needs: Record<NeedKey, Need>;
  /** Missing on the example network, where the data is simulated and there is nothing to send. */
  onExample?: () => void;
}

export function PageEmpty({ title, detail, keys, needs, onExample }: Props) {
  return (
    <div className="vz-body vz-empty">
      <EmptyState>
        <EmptyState.VisualPreset context="generic" type="something-missing" />
        <EmptyState.Title>{title}</EmptyState.Title>
        <EmptyState.Details>{detail}</EmptyState.Details>
        {onExample && (
          <EmptyState.Actions>
            <Button variant="emphasized" onClick={onExample}>Show example</Button>
          </EmptyState.Actions>
        )}
      </EmptyState>
      <div className="dn-empty"><DataNeeds title="What this page needs" keys={keys} needs={needs} open /></div>
    </div>
  );
}
