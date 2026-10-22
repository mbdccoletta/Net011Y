// How full each one is: every subject on the estate, one tile each, drawn by Strato's
// `HoneycombChart`.
//
// This replaces a ranking that was wrong twice over. Sorted across all three kinds by "per cent
// of its own limit", every one of its fifty rows was memory — a switch's memory sits at eighty
// per cent because that is what memory does, while a port at eighty would be an emergency — so
// the page's own subject never appeared in it. And fifty of four hundred and fourteen is not a
// view of an estate; the other three hundred and sixty-four were simply absent.
//
// So nothing is ranked away and nothing is aggregated away: one tile per subject, grouped by
// kind because the three are not comparable, shaded by how much of its own limit each one uses.
//
// Ordering inside a group is by the value shown, which makes a block of one shade a block of
// equals — and that is how the estate's shape finally becomes visible: twenty-four switches
// report 57.4% of their memory to the decimal and thirteen report 81.2%. Those are models and
// firmwares, not twenty-four findings, and no ranking this card has had ever showed it.
//
// What the platform's component gives and what it costs is written against each piece below.
import React, { useMemo, useRef, useState } from "react";
import { HoneycombChart } from "@dynatrace/strato-components/charts";
import { useTokens } from "../../hooks/useToken";
import { DEAD, NEAR, ROOM_KINDS, useRoom, type RoomCell, type RoomKind } from "./room";
import { useNf, useSel } from "./source";

/**
 * The ramp is the platform's tokens, in the order the reader asked for: darker is fuller.
 *
 * `colorPalette` takes a plain array as well as a name, so this is still the component
 * drawing it — the array is `--comb-1` to `--comb-9` from the theme, which are the same
 * `charts-sequential-blue` tokens, palest at nought and deepest navy at a hundred on both
 * grounds.
 *
 * What that costs on a dark page is worth writing down, because it is not a detail of taste.
 * The deepest step is also the one closest to the background, so the subjects nearest their
 * limit are drawn in the quietest colour on the card while the empty ones are the loudest —
 * on this estate that is a hundred and twenty-six uplinks under a quarter of their line rate
 * painted near-white, over the memories at eighty per cent that are the actual finding. The
 * other direction trades that away and reads backwards against the convention that darker is
 * worse. This is the one that was asked for; reversing it is reversing the nine lines in the
 * theme's dark block.
 *
 * They are read as computed literals because the tiles are painted to a canvas, where a
 * `var()` is an invalid fillStyle and is dropped without a word.
 */
const RAMP_VARS = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [`--comb-${i + 1}`, ""]),
) as Record<string, string>;


/**
 * Below the floor, so the component draws it in its own neutral tile colour.
 *
 * A subject the analyzer declined has no "could reach", and there is no null in a numeric hive.
 * `getBaseColor` paints anything outside [min, max] with `DEFAULT_HONEYCOMB_TILE_COLOR`, so a
 * sentinel under zero is the documented way to say "no value" and costs no colour rule.
 */
const NO_VALUE = -1;

const med = (a: number[]) => {
  const v = a.slice().sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};
const r1 = (v: number) => Math.round(v * 10) / 10;

/** what the whole kind did, in one clause, computed rather than written */
function verdict(cells: RoomCell[]): string {
  const ans = cells.filter((c) => c.reach != null);
  if (!ans.length) return "not analysed yet";
  const d = r1(med(ans.map((c) => c.reach!)) - med(ans.map((c) => c.now)));
  if (Math.abs(d) < DEAD) return "the fleet stays where it is";
  return `the fleet ${d > 0 ? "moves up" : "eases"} ${Math.abs(d)} points at the median`;
}

/** the datapoint the hive reads, plus the fields only this app's tooltip and rules read */
type Tile = {
  name: string; value: number;
  key: string; now: number; reach: number | null; owner: string; sel: boolean;
};

function Comb({ kind, cells, view, width, picked, onPick, sel, palette }: {
  kind: typeof ROOM_KINDS[number]; cells: RoomCell[]; view: "now" | "reach"; width: number;
  picked: string | null; onPick: (key: string) => void; sel: string;
  palette: string[] | "blue";
}) {
  const data: Tile[] = useMemo(() => {
    const val = (c: RoomCell) => (view === "reach" ? c.reach : c.now);
    /* ordered by what the tiles are showing, so a run of one shade is a run of equals and the
       dark end is together rather than scattered through the hive */
    return cells.slice().sort((a, b) => (val(b) ?? -1) - (val(a) ?? -1)).map((c) => ({
      name: c.s.name,
      value: val(c) ?? NO_VALUE,
      key: c.s.key,
      now: c.now,
      reach: c.reach,
      /* a memory and a processor are named after their device, so repeating the device under
         them reads "X on X"; what they have that the name does not is the site */
      owner: kind.id === "port" ? (c.s.device?.name ?? c.s.sub) : (c.s.site || "untagged"),
      sel: c.s.key === picked,
    }));
  }, [cells, view, kind.id, picked]);

  /**
   * The tile the pointer is on, recorded by the tooltip that is already rendering for it.
   *
   * `HoneycombChart` draws its tiles to a canvas with the stroke hard-coded transparent and
   * exposes no per-tile click — `seriesActions` is the sanctioned route and it puts the action
   * two steps away, inside a menu inside the tooltip, for a card whose whole point is that a
   * tile opens the list. The tooltip render function runs for exactly the tile under the
   * pointer and is handed the datapoint, so it is the hive's own answer to "which one is
   * this"; parking it in a ref lets a plain click on the hive open that one.
   */
  const over = useRef<Tile | null>(null);

  if (!cells.length) return null;
  const near = cells.filter((c) => c.reach != null && c.reach >= NEAR).length;
  /* the hive fits its tiles to the box, so the height is what sets the tile size: this keeps a
     tile near twenty pixels across whatever the card's width and however many subjects there are */
  const height = Math.min(340, Math.max(84, Math.round((cells.length * 430) / Math.max(240, width))));

  return (
    <div className="rc-comb">
      <div className="rc-comb-head">
        <b>{kind.name}</b>
        <span>{kind.unit} · {cells.length} {kind.noun}
          {near ? ` · ${near} could reach ${NEAR}%` : ""}</span>
        <em>{verdict(cells)}</em>
      </div>
      <div className="rc-hive" onClick={() => over.current && onPick(over.current.key)}
        onMouseLeave={() => { over.current = null; }}>
        <HoneycombChart data={data} valueAccessor="value" colorPalette={palette}
          min={0} max={100} height={height} shape="hexagon"
          formatter={(v) => (v < 0 ? "not analysed" : `${v}%`)}
          aria-label={`${cells.length} ${kind.noun}, ${kind.unit}`}>
          {/* The open tile, in the one channel the component leaves open.
              A ring is not available — the canvas renderer passes `strokeColor: "transparent"`
              for every tile — and a reader who opens the list has to be able to see which tile
              it belongs to, so the selection is a colour rule on a field of this app's own.
              `value` is a forbidden accessor for a rule, which is why this is `sel`. */}
          <HoneycombChart.ColorRule valueAccessor="sel" comparator="equals" matchValue={true}
            color={sel} />
          {/* The component's legend cannot read a custom palette: it builds its items from the
              named-palette map and throws on an array ("Cannot read properties of undefined
              (reading 'toString')"), which took out whichever hive carried it. The scale is
              drawn once for the card instead, from the same ten literals. */}
          <HoneycombChart.Legend hidden />
          <HoneycombChart.Tooltip>
            {({ data: d }) => {
              const t = d as unknown as Tile;
              over.current = t;
              return (
                <div className="rc-tip">
                  <b>{t.name}</b> <i>{t.owner}</i><br />
                  {t.now}% <i>today</i>
                  {t.reach == null ? <i> · no curve the quantity allows</i>
                    : <> · <u>{t.reach}%</u> <i>could reach</i></>}
                </div>
              );
            }}
          </HoneycombChart.Tooltip>
        </HoneycombChart>
      </div>
    </div>
  );
}

export default function RoomComb() {
  /* the same list the panel reads, from the provider rather than a prop: a comb drawn from one
     set and a list drawn from another agree until the day they do not */
  const { ALL } = useNf();
  const { cells, answered, loading, error } = useRoom(ALL);
  const { pick, setPick } = useSel();
  const [view, setView] = useState<"now" | "reach">("now");
  const box = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(900);
  const total = ROOM_KINDS.reduce((n, k) => n + cells[k.id].length, 0);
  const near = ROOM_KINDS.reduce((n, k) =>
    n + cells[k.id].filter((c) => c.reach != null && c.reach >= NEAR).length, 0);
  const picked = pick?.kind === "room" ? pick.key : null;
  /**
   * The subject the forecast puts highest, whichever kind it belongs to.
   *
   * The count below used to do one thing: switch the hive to the forecast shading and leave
   * the reader to find the dark end by eye, across three hives of four hundred tiles. On an
   * estate where nothing reaches ninety it did not even do that — the sentence read "0 could
   * reach 90% of their own limit — the dark end below", pointing at a dark end that does not
   * exist, on a button that was disabled so the click did nothing at all.
   *
   * A count is only worth printing if it is a way to the subjects it counts, so the click
   * opens one: the highest the band goes over the horizon. That is a pick like any other, so
   * the panel scrolls to its row and opens the three forecast readings under it.
   */
  const highest = useMemo(() => {
    let best: { of: RoomKind; c: RoomCell } | null = null;
    for (const k of ROOM_KINDS) {
      for (const c of cells[k.id]) {
        if (c.reach == null) continue;
        if (!best || c.reach > (best.c.reach as number)) best = { of: k.id, c };
      }
    }
    return best;
  }, [cells]);
  /* read off this card, because the ramp is declared on the themed block above it and not
     on :root; `inkRef` goes on the card, and `--sel` comes from the same read */
  const [ink, inkRef] = useTokens({ ...RAMP_VARS, "--sel": "#ff8643" });
  const sel = ink["--sel"];
  /**
   * The ten steps, and the named palette if the read has not landed yet.
   *
   * A partial or empty array is not a palette: handed `[]`, `HoneycombChart` does not take it
   * for a custom one, looks the name up in its own map, and throws — the page went blank on
   * the first render, before the ref had an element to read from.
   */
  const palette = useMemo(() => {
    const steps = Array.from({ length: 9 }, (_, i) => ink[`--comb-${i + 1}`]).filter(Boolean);
    return steps.length === 9 ? steps : "blue";
  }, [ink]);
  /* one stable callback: an inline arrow is a new ref every render, which React re-attaches
     every render, which re-reads the tokens every render */
  const cardRef = React.useCallback((el: HTMLDivElement | null) => {
    box.current = el;
    inkRef(el);
  }, [inkRef]);

  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!total) {
    return (
      <div className="card">
        <div className="card-head"><span className="card-title">How full every uplink, processor and memory is</span></div>
        <div className="nfd-empty">Nothing here publishes a limit to measure room against.</div>
      </div>
    );
  }

  return (
    <div className="card rc" ref={cardRef}>
      <div className="card-head">
        <span className="card-title">How full every uplink, processor and memory is</span>
        <span className="card-unit">{total} subjects · {answered} answered by Dynatrace
          {loading ? " · asking…" : ""}{error ? ` · ${error.slice(0, 80)}` : ""}</span>
      </div>

      <div className="rc-bar">
        <div className="rc-seg" role="group" aria-label="What the tiles show">
          {([["now", "Measured today"], ["reach", "Could reach by the horizon"]] as const).map(([v, t]) => (
            <button key={v} type="button" className={view === v ? "is-on" : ""}
              aria-pressed={view === v} onClick={() => setView(v)}>{t}</button>
          ))}
        </div>
        {/* The ring these used to wear is gone with the hand-rolled hive, so this is the way
            to them: it shades the hive by the forecast and opens the one that goes highest.
            An estate where nothing is near its limit says so and still offers the way in,
            because "nothing reaches ninety" is only believable next to what the top of the
            estate actually is. */}
        {highest && (
          <div className="rc-near">
            <button type="button" onClick={() => {
              setView("reach");
              setPick({ kind: "room", of: highest.of, key: highest.c.s.key });
            }}>
              {near
                ? <><b>{near}</b> could reach {NEAR}% of their own limit — open the highest</>
                : <>Nothing reaches {NEAR}% of its own limit · the highest is{" "}
                  <b>{highest.c.s.name}</b> at {highest.c.reach}%</>}
            </button>
          </div>
        )}
      </div>

      {ROOM_KINDS.map((k) => (
        <Comb key={k.id} kind={k} cells={cells[k.id]} view={view} width={W} picked={picked}
          sel={sel} palette={palette}
          onPick={(key) => setPick(picked === key ? null : { kind: "room", of: k.id, key })} />
      ))}

      {/* One scale for the three hives, drawn from the same ten steps they are painted with. */}
      {Array.isArray(palette) && (
        <div className="rc-key">
          <span>0%</span>
          <i style={{ background: `linear-gradient(to right, ${palette.join(",")})` }} />
          <span>100% of its own limit</span>
        </div>
      )}
    </div>
  );
}
