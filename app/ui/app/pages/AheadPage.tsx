// Ahead: how much room every port and every processor has left, and how high the platform says
// each could get.
//
// What this page used to open with was a census — "430 measured › 430 forecast › 91 also asked
// whether they changed" — over a strip that was four fifths grey, and three collapsing rows under
// it. The first row ranked room, which is the comb's whole subject at a coarser grain. The other
// two reported the platform's novelty verdict over the fifty tightest subjects plus anything
// discarding: ninety-one of four hundred and thirty, written as "none of the 91 analysed", which
// a reader takes as "nothing on this network is trending up". And the grey, the largest thing on
// the screen, meant "we did not ask" — this app's own per-call limit drawn as a finding.
//
// All of it is gone. The comb answers room for all four hundred and thirty without a sample.
import React, { useMemo, useState } from "react";
import type { NetworkModel } from "../model/types";
import { aheadSubjects } from "../model/ahead";
import { Tile } from "../components/Visual";
import { PageEmpty } from "../components/PageEmpty";
import { Skeleton, SkeletonText } from "@dynatrace/strato-components/content";
import { AheadConsole } from "../components/AheadConsole";
import { NfProvider, useNf, type Pick } from "../components/nf/source";
import RoomComb from "../components/nf/RoomComb";
import NfDetail from "../components/nf/NfDetail";
import NetworkDemand from "../components/nf/NetworkDemand";
import SiteDemand from "../components/nf/SiteDemand";
import { AssistPanel } from "../components/AssistPanel";
import { aheadContext } from "../utils/assist";
import { aheadQuestions } from "../utils/prompts";
import { fmtInt } from "../utils/format";
import type { Need, NeedKey } from "../data/requirements";

/**
 * A section shows whatever shape its state has a cause in.
 *
 * Changes are gathered by the day they happened, because they cluster there and because "what
 * happened on the 20th" is one question with one owner. Discards are gathered by site, because a
 * handful of ports dropping at one branch is one conversation and the same count spread over
 * forty branches is a different problem entirely. The two small states are listed as they are —
 * grouping two rows would be ceremony.
 */

/* `Section` drew a claim row per app state. The rows it drew are the platform's now, and
   nothing renders it. */

/**
 * The questions are answered from the analyzer's forecasts, so the panel has to be inside the
 * provider that holds them: a component rendering a provider cannot read it, and the context
 * handed over used to carry dates from a line this app fitted for itself.
 */
function AheadAssist({ model }: { model: NetworkModel }) {
  const { FORECASTS } = useNf();
  return <AssistPanel subject="ahead" object="forecast" questions={aheadQuestions()}
    context={() => aheadContext(model, FORECASTS)} />;
}

export function AheadPage({ model, needs, onSettings, onDevice, onExample, hourlyReady = true }: {
  model: NetworkModel;
  needs: Record<NeedKey, Need>;
  onSettings: (focus: NeedKey | null) => void;
  onDevice: (name: string) => void;
  onExample?: () => void;
  /** every hourly read has landed, so the estate is whole enough to forecast */
  hourlyReady?: boolean;
}) {
  /**
   * Nothing is derived until the record is whole.
   *
   * Every hook on this page sits above its early returns, which is right — React counts hooks,
   * and the version that returned early crashed with "Rendered more hooks than during the
   * previous render". But the rule says the hooks must *run*, not that they must work: this
   * one walked twenty thousand devices and their ports to build sixty thousand subjects, and
   * then the page returned the "reading the record" placeholder anyway. Measured on the
   * twenty-thousand-device example estate, opening Ahead froze the browser for 6.1 seconds in
   * a single task to draw a sentence.
   *
   * So the hook still runs and the work does not. Everything below derives from this, so one
   * gate here empties the whole chain.
   */
  /**
   * Derived once the record is whole, and not again for reads that are not in it.
   *
   * The dependency was the model, and the model is rebuilt every time any query changes
   * state — including the last wave, which belongs to other pages. Measured: `aheadSubjects`
   * costs 1.45 seconds over four hundred and thirty subjects and three hundred and thirty-six
   * hourly points each, and it ran **sixteen times** on one load. Twenty-three seconds of
   * blocked main thread, of which about twenty-two recomputed an answer that had not changed:
   * `hourlyReady` means every hourly read has landed, so after it flips the series this reads
   * are fixed, and the later rebuilds carry flows, logs and alerts it never looks at.
   *
   * The device count is in the key because the inventory is what else it reads, and that one
   * does settle before the record does.
   */
  const subjectKey = `${hourlyReady}|${model.devices.length}`;
  const subjects = useMemo(() => (hourlyReady ? aheadSubjects(model) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subjectKey]);
  /**
   * One selection for the page.
   *
   * The console kept a `scope` of its own and the dashboard kept a `pick`, and neither could
   * reach the other — so the masthead offered a scope that nothing could set while the cards
   * below were already resolving exactly that. They are the same idea and are now the same
   * state: picking a site anywhere scopes the verdict to it, and the crumb is the way back.
   */
  const [pick, setPick] = useState<Pick | null>(null);
  const scope = pick?.kind === "site" ? pick.id : null;
  /**
   * Everything the reader counts is counted over the same set.
   *
   * Scoping only the verdict put two populations on one screen: a masthead reading 58 subjects
   * at LEM above claim rows still reading 295, with nothing saying which was which. The census,
   * the claims and the Intelligence tile all read the scope; the dashboard below stays the whole
   * estate and says so, because its subject is the estate's shape and not one site's.
   */
  const inScope = useMemo(() => (scope ? subjects.filter((s) => s.site === scope) : subjects),
    [subjects, scope]);
  /**
   * Which extension families reported an hourly record, and how deep it goes.
   *
   * Both feed the estate forecast — the families build its DQL expression, the depth sizes its
   * horizon. They sat beside the rest of that work, which is below this component's early
   * return for an empty estate, and React counted a different number of hooks on the render
   * where the estate was empty: "Rendered more hooks than during the previous render", and a
   * blank page. Every hook belongs above every return.
   */
  const families = useMemo(() => [...new Set(model.devices
    .flatMap((d) => d.interfaces.map((i) => i.family)).filter((f): f is string => !!f))], [model]);
  const recordHours = useMemo(() => Math.max(48, ...subjects.map((x) => x.reading.hist.length)), [subjects]);
  const anySubjects = subjects.length;
  // the empty state is about the estate, never about a site the reader narrowed to

  /* This is read before the empty-estate branch below, and the order matters: deriving the
     subjects now waits for the record, so an empty set while the reads are still landing is
     not an estate with nothing in it. At twenty thousand devices the page said "the
     extensions are not reporting yet" about an estate whose extensions were reporting fine. */
  /**
   * The page is drawn once, from the whole record.
   *
   * Measured on a reload: at 15 s the page read "172 ports and processors" and "29 rising
   * inside the noise"; at 23 s the same page read 295 and 51. For eight seconds it was
   * complete, confident and wrong, because the subjects are built from the hourly reads as
   * they land and nothing on the page said so. The estate chart already waited for this; the
   * counts did not. A page that corrects itself in front of the reader has already told them
   * something false — so nothing numeric is drawn until every hourly read has settled.
   */
  if (hourlyReady === false) {   // the prop is optional; only an explicit "not yet" holds the page

    return (
      <div className="lm vz ahead">
        <div className="acx"><header className="acx-mast">
          <h2>Ahead · how much room is left before each one&rsquo;s own limit <b>// reading the record</b></h2>
          <div className="acx-crumb"><b>Whole network</b>
            <em>Every port&rsquo;s and every processor&rsquo;s last fortnight, hour by hour. It is the
              heaviest read this app makes, and the one this page is entirely built from, so the page
              waits for all of it rather than counting what has arrived so far.</em></div>
        </header></div>
        {/* A skeleton, not a spinner. The platform's loading pattern reserves progress
            indicators for one part of a page and says they distract when the whole page is
            waiting; a skeleton is the documented answer for a first load, and it also says
            what is coming — a strip of counts, then the charts. */}
        <div className="card" aria-busy="true" aria-label="Reading the hourly record">
          <div className="card-head"><span className="card-title">Nothing is drawn yet</span></div>
          <div className="nfd-empty">A partial record is a true answer about a handful of
            interfaces and a false one about the network.</div>
          <Skeleton height="26px" />
          <div style={{ height: 10 }} />
          <SkeletonText lines={4} />
          <div style={{ height: 14 }} />
          <Skeleton height="220px" />
        </div>
      </div>
    );
  }
  if (!anySubjects) {
    return (
      <PageEmpty title="Nothing to look ahead with yet"
        detail={"Ahead reads a month of daily traffic for every uplink and a month of daily processor samples for"
          + " every device. Neither has arrived — either the extensions are not reporting yet, or the ports that"
          + " are reporting publish no line rate, which is the limit the percentage is measured against."}
        keys={["devices"]} needs={needs} configure="devices" onSettings={onSettings} onExample={onExample} />
    );
  }

  /**
   * Three bands, in the order a reader needs them.
   *
   * The chart first and whole, because it is the only thing here that answers how much and when,
   * and because it is the way in — pointing along it reads a day and clicking opens what that day
   * holds. Then one forecast drawn properly, so the reader learns what a forecast on this page is
   * before meeting forty an inch wide. Then everything else behind a click.
   *
   * What this replaced was a pile: a headline that repeated the chart's own caption, a row of
   * chips that repeated the counts below them, a table of twenty-five rows, four accordions and
   * the counts again. Each piece had been right when it arrived and wrong once the next one did.
   */
  return (
    <div className="lm vz ahead">
      <NfProvider model={model} subjects={subjects} onDevice={onDevice} pick={pick} onPick={setPick}>
      <AheadConsole model={model} subjects={subjects} scope={scope}
        onScope={(site) => setPick(site ? { kind: "site", id: site, col: null } : null)}
        />

      {/* Positioned against what it explains.
          It used to sit in the footer, under four charts and five collapsed rows, where its
          offer — "ask about what this page found" — named nothing and arrived after the reader
          had already given up or worked it out. Directly beneath the verdict it is unambiguous:
          the sentence above states the findings, and this is where to ask about those. */}
      {/* The same frame as every other page: `vz-assist-row`, no tone, no title of its own.
          It was `TONE.accent` with the heading "Ask about what is ahead" — a different colour
          and a different shape from Sites, Devices, WAN links and Traffic, and a heading that
          said what the "Intelligence" label inside it already says. What is kept is the note
          on the right, because that one carries a fact the others do not have: which subjects
          the answers are drawn from. */}
      <Tile className="vz-assist-row"
        right={<span className="ahead-note">{scope
          ? `Scoped to ${model.sites[scope]?.name || scope} · ${fmtInt(inScope.length)} of ${fmtInt(subjects.length)} ports and processors`
          : `Answers are drawn from these ${fmtInt(inScope.length)} ports and processors only, never from outside the page`}</span>}>
        <AheadAssist model={model} />
      </Tile>

      {/* Macro to micro, and the unit changes once.
          Measured before this order: the grain went network → one port → network → one port →
          site → fifty ports → network, and the unit went Gb/s → per cent → Gb/s → points. The
          reader was asked to change altitude four times and change ruler four times on one
          page. Now the shape of the estate is stated where the title promises it, demand runs
          network → site in the unit it is carried in, and only then does the page change ruler
      {/* The dashboard, as its components arrived, over this environment's own numbers. The
          layout is theirs too: four tiles, the forecast across the top, the runway and the
          matrix side by side, the heatmap across the bottom. */}
      <div className="nf">
          {scope && <p className="ahead-note-in">The four cards below read the whole estate, not
            just {model.sites[scope]?.name || scope} — their subject is the shape of the network.
            Everything above and below them is scoped to what you picked.</p>}
          <div className="grid">
            {/* The estate first: it is the only forecast here that is never empty, because
                absolute demand has no stated limit to be far from. Then one subject in full. */}
            <div className="span-12"><NetworkDemand families={families} hours={recordHours} ready={hourlyReady} /></div>
            {/* The matrix is twice the height of the runway — a chart plus a table of every
                site — so a row holding one of each left four hundred pixels of empty page
                beside it. Two short cards stack into the height the tall one needs. */}
            {/* Network → site → ports → device, each step a real forecast. The two cards that
                used to sit here measured a site against the sum of its ports' line rates, which
                is a capacity nobody carries — they read 0–3% on every cell and the 85% line was
                never touched. A site publishes no limit, so what it gets is the same reading
                the estate gets: demand, in the unit it is actually carried in. */}
            <div className="span-12"><SiteDemand families={families} hours={recordHours}
              ready={hourlyReady} nameOf={(c) => model.sites[c]?.name || c}
              siteCount={Object.keys(model.sites).length} /></div>
            <div className="span-12"><RoomComb /></div>
            {/* The forecast card that stood here drew the five subjects the ranking already
                listed, on an axis where they were not comparable — four ports at one per cent
                of a line rate beside a memory at eighty-four. Each row carries its own curve
                now, against its own ceiling, and the full one with its band is a click away in
                the detail panel. */}
          </div>
        </div>

      {/* "The nearest, in full" stood here: one subject at full height, with a change, a
          chance of crossing, a probable day and the room left. Two of those were measured and
          two came from this app's own fit — and on the one subject it named, the census two
          screens above said the platform found no trend at all. It is folded into the row now,
          where the subject is, with the crossing taken from the platform's own curve. */}

      {/* The detail renders into PageLayout.Details — the region the platform documents for
          exactly this, and the one every other page in the app already selects into. It is not
          rendered here: this element claims the region and portals into it, so the panel is the
          platform's 44% and the page under it keeps its own width. */}
      <NfDetail />
      </NfProvider>
    </div>
  );
}

