// Settings: which levels group the sites in the list next to the map, and in which order.
// Changes are edited as a draft and only reach the environment when the user saves them, as the
// settings standard requires for configurations that affect other users.
import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import { Menu } from "@dynatrace/strato-components/navigation";
import { Modal } from "@dynatrace/strato-components/overlays";
import { showToast } from "@dynatrace/strato-components/notifications";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { ArrowDownIcon, ArrowUpIcon, DeleteIcon, PlusIcon } from "@dynatrace/strato-icons";
import type { NetworkModel } from "../model/types";
import { availableTagKeys, fitsUnder, isPrimaryTag, suggestHierarchyDetail, tagLabel, useSiteHierarchy } from "../hooks/useSiteHierarchy";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function SiteHierarchySettings({ model }: { model: NetworkModel | null }) {
  const { levels, setLevels, saveState } = useSiteHierarchy();
  const keys = availableTagKeys(model);
  const sites = model ? Object.keys(model.sites).length : 0;
  // the suggestion follows whatever primary tags this environment carries, so it changes with the data
  const suggestion = useMemo(() => suggestHierarchyDetail(model), [model]);

  // the draft is what the user edits; the environment only sees it after Save
  const saved = levels.join();
  const [draft, setDraft] = useState<string[]>(levels);
  useEffect(() => { setDraft(levels); }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const [confirm, setConfirm] = useState<null | { title: string; detail: string; apply: () => void }>(null);

  const dirty = draft.join() !== saved;
  const unused = keys
    .filter((k) => !draft.includes(k.key))
    .sort((a, b) => Number(isPrimaryTag(b.key)) - Number(isPrimaryTag(a.key)) || a.values - b.values);
  // levels that really are sub-levels of what the user picked come first, whatever the tag is called
  const fitting = unused.filter((k) => fitsUnder(model, draft, k.key));
  const others = unused.filter((k) => !fitting.includes(k));
  const sameAsSuggestion = suggestion.levels.length > 0 && suggestion.levels.join() === draft.join();
  const move = (i: number, d: number) => setDraft((prev) => { const next = [...prev]; [next[i], next[i + d]] = [next[i + d], next[i]]; return next; });

  const save = () => {
    setLevels(draft);
    showToast({
      title: "Site hierarchy saved",
      message: draft.length ? `Sites are grouped by ${draft.map(tagLabel).join(" › ")} for everyone in this environment.` : "Sites are no longer grouped.",
      type: "success",
    });
  };

  return (
    <section className="ds-block" aria-labelledby="sh-title">
      <Heading level={5} id="sh-title">Site hierarchy</Heading>
      <Text textStyle="small">
        Choose the levels that group sites in the list next to the map, from the broadest to the most specific, for example country, federative unit and site. Primary tags come from your data; levels named region, type, hub, state and city are derived by the app when tags are missing. Sites without a value are grouped under &quot;Not tagged&quot;. Saved in this environment for everyone who uses the app.
      </Text>

      {saveState === "no-permission" && <Text textStyle="small" className="sh-state">Your user can&apos;t save settings for the environment (state:app-states:write). Changes apply to you in this browser only.</Text>}
      {saveState === "local-only" && <Text textStyle="small" className="sh-state">Couldn&apos;t save to the environment. Changes apply to you in this browser until they save.</Text>}

      {suggestion.levels.length > 0 && !sameAsSuggestion && (
        <div className="sh-suggest">
          <span className="sh-suggest__text">
            <Text textStyle="base-emphasized">
              Suggested: <span className="sh-chain">{suggestion.levels.map(tagLabel).join(" › ")}</span>
            </Text>
            <Text textStyle="small">
              {suggestion.source === "primary-tags"
                ? `From the ${plural(suggestion.considered.length, "primary tag")} your devices carry (${suggestion.considered.map(tagLabel).join(", ")}). Each level covers most sites and fits inside the one before it, so tagging the devices differently changes the suggestion.`
                : "No primary tags on the sites yet, so these levels come from what the app derives from the site codes. As soon as the devices carry primary tags, the suggestion is built from them."}
            </Text>
          </span>
          <Button onClick={() => setDraft(suggestion.levels)}>Use suggestion</Button>
        </div>
      )}

      {suggestion.levels.length === 0 && !draft.length && (
        <Text textStyle="small" className="sh-state">
          {sites < 2
            ? "Nothing to suggest yet: the app needs at least two sites to see how they group."
            : keys.length === 0
              ? "Nothing to suggest yet: the sites carry no primary tags, and the app could not derive a level from their codes."
              : `No level groups these ${sites} sites into more than one group, so the app has nothing to propose. Add a level below to group them yourself.`}
        </Text>
      )}

      {draft.length ? (
        <ol className="sh-levels" aria-label="Hierarchy levels">
          {draft.map((k, i) => {
            const info = keys.find((x) => x.key === k);
            return (
              <li key={k} className="sh-level" style={{ paddingLeft: 12 + i * 16 }}>
                <span className="sh-level__name">
                  <Text textStyle="base-emphasized">{tagLabel(k)}</Text>
                  <Text textStyle="small" className="ds-code">{k}{info ? ` · ${plural(info.values, "value")} · ${plural(info.sites, "site")}` : " · not found in current data"}</Text>
                </span>
                <span className="sh-level__actions">
                  <Button aria-label={`Move ${tagLabel(k)} up`} disabled={i === 0} onClick={() => move(i, -1)}><Button.Prefix><ArrowUpIcon /></Button.Prefix></Button>
                  <Button aria-label={`Move ${tagLabel(k)} down`} disabled={i === draft.length - 1} onClick={() => move(i, 1)}><Button.Prefix><ArrowDownIcon /></Button.Prefix></Button>
                  <Button aria-label={`Remove ${tagLabel(k)}`} onClick={() => setConfirm({
                    title: `Remove ${tagLabel(k)}?`,
                    detail: `Sites will no longer be grouped by ${tagLabel(k)}. Other users keep the current hierarchy until you save.`,
                    apply: () => setDraft((prev) => prev.filter((x) => x !== k)),
                  })}><Button.Prefix><DeleteIcon /></Button.Prefix></Button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <Text textStyle="small">No levels yet: the list shows the open problems only.</Text>
      )}

      {keys.length ? (
        <div className="sh-add">
          <Menu>
            <Menu.Trigger>
              <Button disabled={!unused.length}><Button.Prefix><PlusIcon /></Button.Prefix>{unused.length ? "Add level" : "All levels are in use"}</Button>
            </Menu.Trigger>
            <Menu.Content>
              {[
                { label: draft.length ? `Fits under ${tagLabel(draft[draft.length - 1])}` : "Group sites by", items: fitting },
                { label: draft.length ? "Other levels" : "", items: others },
              ].filter((g) => g.items.length).map((g) => (
                <React.Fragment key={g.label || "all"}>
                  {g.label && <Menu.Label>{g.label}</Menu.Label>}
                  {g.items.map((k) => (
                    <Menu.Item key={k.key} onSelect={() => setDraft((prev) => [...prev, k.key])}>
                      {tagLabel(k.key)} — {isPrimaryTag(k.key) ? k.key : "derived by the app"} · {plural(k.values, "value")}
                    </Menu.Item>
                  ))}
                </React.Fragment>
              ))}
            </Menu.Content>
          </Menu>
          {draft.length > 0 && (
            <Button onClick={() => setConfirm({
              title: "Remove all levels?",
              detail: "The list next to the map stops grouping sites. Other users keep the current hierarchy until you save.",
              apply: () => setDraft([]),
            })}>Clear</Button>
          )}
        </div>
      ) : (
        <Text textStyle="small">
          {sites === 0
            ? "No sites in this environment yet. Sites appear once the SNMP extensions monitor network devices; then their primary tags can group the list."
            : "The sites of this environment carry no primary tags. Add them to the SNMP monitoring configurations (see Data › How to send each data type › Sites, regions and locations)."}
        </Text>
      )}

      {dirty && (
        <div className="sh-save" role="group" aria-label="Unsaved changes">
          <Text textStyle="small">Not saved yet: <span className="sh-chain">{draft.length ? draft.map(tagLabel).join(" › ") : "no grouping"}</span></Text>
          <span className="sh-save__actions">
            <Button onClick={() => setDraft(levels)}>Cancel</Button>
            <Button variant="accent" onClick={save} disabled={saveState === "saving"}>{saveState === "saving" ? "Saving" : "Save"}</Button>
          </span>
        </div>
      )}

      {confirm && (
        <Modal title={confirm.title} show onDismiss={() => setConfirm(null)}
          footer={
            <span className="sh-save__actions">
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="accent" color="critical" onClick={() => { confirm.apply(); setConfirm(null); }}>Remove</Button>
            </span>
          }>
          <Text>{confirm.detail}</Text>
        </Modal>
      )}
    </section>
  );
}
