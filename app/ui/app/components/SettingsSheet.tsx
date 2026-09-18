// Settings in three tabs: what the app shows (source and grouping), the data it reads and how to send it,
// and how the app itself is configured (permissions, tags, versions and thresholds).
import React from "react";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { Tab, Tabs } from "@dynatrace/strato-components/navigation";
import { XmarkIcon } from "@dynatrace/strato-icons";
import type { NeedKey, Need } from "../data/requirements";
import type { NetworkModel } from "../model/types";
import { AppConfigSection, DataSourceSection, PagesSection, SendDataSection, SuspicionSection } from "./DataSetup";
import { SiteHierarchySettings } from "./SiteHierarchySettings";

interface Props {
  show: boolean;
  onDismiss: () => void;
  model: NetworkModel | null;
  needs: Record<NeedKey, Need>;
  source: "live" | "example";
  onSource: (source: "live" | "example") => void;
  /** Data type the caller wants explained: opens the Data tab with that entry expanded */
  focus?: NeedKey | null;
}

export function SettingsSheet({ show, onDismiss, model, needs, source, onSource, focus }: Props) {
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
      {/* remounted per focus so a page that asks for one data type lands on the Data tab, on that entry */}
      <Tabs key={`${focus ?? "settings"}-${show}`} defaultIndex={focus ? 1 : 0} panelOverflow="scroll-y">
        <Tab title="General">
          <div className="ds">
            <DataSourceSection source={source} onSource={onSource} />
            <SiteHierarchySettings model={model} />
            <SuspicionSection />
          </div>
        </Tab>
        <Tab title="Data">
          <div className="ds">
            <PagesSection needs={needs} />
            <SendDataSection needs={needs} source={source} focus={focus} />
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
