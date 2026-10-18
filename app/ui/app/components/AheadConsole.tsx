// The Ahead page as an operations console: a status strip, two charts that carry the whole
// finding at a glance, and everything else a click away.
//
// What this replaced was one chart in the middle of a wide screen with a paragraph under it. On
// an estate where nothing is near a limit that is a true picture and an empty one — the reader
// saw the busiest port and had to take the other hundred and sixty-eight on trust, and the page
// read as a chart that failed to fill rather than as a network with room to spare.
//
// Two charts, not a wall of them. A grid of a hundred and sixty-nine cards is dense and grey,
// and density is not the same as impact: what carries across a room is one map saying where this
// network is, and one chart drawn floor to ceiling saying how much of its capacity is spoken for.
// The cards are still here, behind a disclosure, for the reader who wants to go through them.
//
// The two never share a scale — one is geography, the other is per cent of a limit — so they are
// two drawings. Never one plot carrying both: the alignment between them would be invented.
//
// Nothing here is drawn that the record cannot support. There is no "confidence ratio" and no
// topology globe; the honest equivalents are the backtest grade and the distribution, which are
// measurements rather than ornament.
import React from "react";
import type { NetworkModel } from "../model/types";
import { HORIZON, hrs, type Subject } from "../model/ahead";
import { fmtInt } from "../utils/format";


/**
 * One scale for load, everywhere on this page: 0 to 100 per cent of whatever limit the owner
 * stated. It runs against the limit and never against the data — on a network whose busiest port
 * sits at thirty per cent that leaves every mark at the cool end, and that is the finding.
 * Rescaling the ramp to the data would paint an idle estate in alarm colours.
 */
const RAMP: [number, [number, number, number]][] = [
  [0, [34, 211, 238]], [25, [57, 217, 138]], [50, [215, 224, 74]],
  [75, [255, 161, 74]], [100, [255, 95, 158]],
];
/* STATE_IN and worstState were a colour-per-state map for the panels this console used to
   hold. Nothing imports them now, and two of their five slots name categorical 02 and 04 —
   which this tenant serves as a grey (#e0e2e3) and a magenta (#ff41af), not the green and
   violet their fallback hexes promised. Dead code that would have mis-coloured whatever
   picked it up next. */

/**
 * The metrics of the type in these drawings, measured in the browser rather than guessed.
 *
 * At the 9.5-unit mono size both label classes use, a glyph advances 5.7 user units and the
 * text box is 13 units tall. Both numbers were wrong in the first version — an advance of 4.3
 * let a long site name start 57 units outside the frame, and a line gap of 11 under a 13-unit
 * box made every name overlap its own second line. Between them they accounted for 37 of the
 * 37 collisions the audit found.
 */
export const GLYPH = 5.7;
export const LINE_H = 14;
/** as many characters as `w` user units will hold, with an ellipsis when it does not fit */
export function fitText(t: string, w: number) {
  const max = Math.floor(w / GLYPH);
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}

export function heat(v: number) {
  const x = Math.max(0, Math.min(100, v));
  for (let i = 1; i < RAMP.length; i++) {
    const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i];
    if (x <= b) {
      const t = (x - a) / (b - a);
      return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * t)).join(",")})`;
    }
  }
  return "rgb(255,95,158)";
}

/* The shared tooltip went with the panels it served.
   Tip, TipFns, TipBox and PanelFx described a contract between this console and the eight charts
   it used to hold: a mark says what it is, the console decides where to put it. Those charts were
   removed and nothing replaced them here, so nothing could ever call show() — the state existed,
   the box was never rendered, and the type was exported to no importer. The dashboard's own
   charts carry their tooltips with them. */

export function AheadConsole({ model, subjects, scope, onScope }: {
  model: NetworkModel;
  subjects: Subject[];
  /** the site the page is scoped to, picked on any mark below; null is the whole network */
  scope: string | null;
  onScope: (site: string | null) => void;
}) {

  const all = subjects.filter((s) => s.reading.hist.filter((v) => Number.isFinite(v)).length >= 6);
  const measured = scope ? all.filter((s) => s.site === scope) : all;

  if (!all.length) return null;
  const depth = (() => {
    const d = measured.map((x) => x.reading.hist.filter((v) => Number.isFinite(v)).length).sort((a, b) => a - b);
    return d[d.length >> 1] ?? 0;
  })();
  /**
   * The furthest this page will ever draw: twice the record behind it, capped.
   *
   * It was computed off the fits — `max(fit.far)` — which is zero on an estate where nothing
   * fits, and it was never rendered anywhere either way. Taken from the rule instead it is
   * always defined, and it is the reason the record length is in the masthead at all: a reader
   * asked what "13 d of record" meant, and the answer that matters is what it buys them.
   */
  const horizon = Math.min(HORIZON, depth * 2);
  /** the only subjects that have a forecast: a rise that beats its noise and arrives in the horizon */
  // the right-hand column shows forecasts when there are any, and says what it is showing when
  // there are none — three flat lines under a heading that says "forecast" is the lie that made
  // a reader go looking for charts the record cannot support
  // With no forecast, "busiest right now" was the fallback — a weak ranking, because the busiest
  // port may be the one with the most room. Busy-hour headroom is defined for every subject and
  // ranks them by how little room they have at the hour that matters.
  const here = scope ? model.sites[scope]?.name || scope : null;
  const procs = all.filter((s) => s.kind === "device").length;
  const mems = all.filter((s) => s.kind === "memory").length;
  const ports = all.length - procs - mems;
  const circuits = model.circuits?.length ?? 0;

  return (
    <div className="acx">
      <header className="acx-mast">
        {/* "13 d of record" abbreviated the unit and named the quantity in this page's own
            jargon. Both are spelled out: it is how far back the measurements go. */}
        {/* The page was named after the thing it almost never finds. Measured on this estate
            over an hour and a half: zero subjects on course, every reading, and Dynatrace's own
            analyzer agrees — 172 valid forecasts, no crossings. Room is the reading that exists
            for every subject with a published limit, so room is what the title says. */}
        {/* The total was here, in the census strip below and in the room row's own figure —
            three statements of one number within two hundred pixels. It belongs where it is
            clickable, which is the census. */}
        <h2>Ahead · how much room is left <b>// {hrs(depth).replace(" d", " days").replace(" h", " hours")} of record</b></h2>
        {/* The verdict, in the words a reader would use, before any drawing.
            A console that opens with six charts and no sentence makes the reader assemble the
            answer themselves — and on an estate where the answer is "nothing is coming" they
            assemble it wrongly, because an elaborate picture implies there is something in it. */}
        {/**
          * The order is the order of what the record supports.
          *
          * It used to open on the discards and make its centrepiece "No subject is on course to
          * a limit" — the absence of a finding, stated as the finding. Room comes first now
          * because it is measured rather than absent; the discards follow because they are
          * happening; and the forecast closes, where a true-and-empty sentence belongs.
          */}
        {/**
          * The verdict, drawn rather than written.
          *
          * It was sixty words of prose carrying four numbers. The census is a strip now — each
          * state a width proportional to its count — because that is the one thing the five
          * rows below cannot do: show at a glance that two hundred and fifty of two hundred
          * and ninety-five are silent. Each key opens the row it names.
          */}
        {/* The census that stood here has moved down to sit with the rows it summarises.
            Clicking a key here scrolled 2,596 pixels — nearly three screens, past eight other
            components — to open a row the reader then had to scroll back from. A summary and
            its detail at opposite ends of a page is not navigation, it is a teleport. */}
        <div className="acx-crumb">
          {here ? (
            <>
              <button type="button" onClick={() => onScope(null)}>← whole network</button>
              <i>›</i><b>{here}</b>
              <em>{fmtInt(measured.length)} of {fmtInt(all.length)} ports and processors</em>
            </>
          ) : (
            <>
              <b>Whole network</b>
              {/* "one uplink and one processor per device" is the rule, and a reader multiplies
                  it by the device count: 181 devices would be 362. It is 295, because 12
                  devices report no processor and 55 no uplink the record can use. The sentence
                  says what was actually found. */}
              <em>{fmtInt(ports)} uplinks · {fmtInt(procs)} processors · {fmtInt(mems)} memories
                {" "}· {fmtInt(model.devices.length)} devices · {hrs(depth).replace(" d", " days").replace(" h", " hours")} of record
                {" "}· drawn no further than {hrs(horizon).replace(" d", " days").replace(" h", " hours")} ahead</em>
              {/* The gap this reading has, in a clause. What it means and what would close it
                  is a question for the Assist, which has the whole method in its context. */}
              <em className="acx-gap">{circuits === 0
                ? "WAN circuits: none tagged here, so none measured"
                : `WAN circuits: ${fmtInt(circuits)} here, none publishing a contracted rate`}</em>
            </>
          )}
        </div>
      </header>

      {/* Nothing is drawn here any more.
          The page carried thirteen panels: five from the dashboard that was asked for and eight
          built here beforehand. Stacked, they were worse than either alone — the second half
          had voids its charts could not fill, a scatter squashed into one band because almost
          every subject sits near zero growth, and titles wrapping onto two lines. The verdict
          above is the part of this component that was pulling its weight, so it is the part
          that stays, and the charts are the ones that were asked for. */}
    </div>
  );
}
