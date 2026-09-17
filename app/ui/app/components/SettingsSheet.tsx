// Settings in three tabs: what the app shows (source and grouping), the data it reads and how to send it,
// and how the app itself is configured (permissions, tags, versions and thresholds).
import React from "react";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { Tab, Tabs } from "@dynatrace/strato-components/navigation";
import { XmarkIcon } from "@dynatrace/strato-icons";
import type { NeedKey, Need } from "../data/requirements";
import type { NetworkModel } from "../model/types";
import { AppConfigSection, DataSourceSection, PagesSection, SendDataSection } from "./DataSetup";
import { SiteHierarchySettings } from "./SiteHierarchySettings";

interface Props {
  show: boolean;
  onDismiss: () => void;
  model: NetworkModel | null;
  needs: Record<NeedKey, Need>;
  source: "live" | "example";
  onSource: (source: "live" | "example") => void;
}

export function SettingsSheet({ show, onDismiss, model, needs, source, onSource }: Props) {
  return (
    <Sheet
      title="Settings"
      show={show}
      onDismiss={onDismiss}
      actions={
        <Button aria-label="Close settings" onClick={onDismiss}>
          <Button.Prefix><XmarkIcon /></Button.Prefix>
        </Button>
      }
    >
      <Tabs defaultIndex={0} panelOverflow="scroll-y">
        <Tab title="General">
          <div className="ds">
            <DataSourceSection source={source} onSource={onSource} />
            <SiteHierarchySettings model={model} />
          </div>
        </Tab>
        <Tab title="Data">
          <div className="ds">
            <PagesSection needs={needs} />
            <SendDataSection needs={needs} source={source} />
          </div>
        </Tab>
        <Tab title="App">
          <div className="ds">
            <AppConfigSection />
          </div>
        </Tab>
      </Tabs>
    </Sheet>
  );
}
