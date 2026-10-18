// The list behind one cell of the comb.
//
// The comb answers "where is the estate"; this answers "which ones, and by how much", for the
// kind that was clicked. Every subject of that kind is here — the comb hides none of them, so
// neither does this.
//
// There is no chart. The panel's own chart is a daily aggregate of a set, and a set of four
// hundred subjects measured against four hundred different limits has no honest aggregate:
// per cent of a line rate and per cent of a processor do not add. What the reader gets instead
// is the four numbers the comb is drawn from, side by side, for every subject.
//
// It is the platform's `DataTable`, and the version it replaces is the argument for it: a
// hand-written `<table>` that had grown its own sort state, its own null-ordering, its own
// sticky first column, its own ellipsis-and-title and its own scroll-the-selected-row-into-
// view — every one of which is a `DataTable` prop. The three other tables in this app
// (devices, WAN links, transactions) were already on it; this was the exception.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import { Button } from "@dynatrace/strato-components/buttons";
import { Text } from "@dynatrace/strato-components/typography";
import { Flex } from "@dynatrace/strato-components/layouts";
import { ChevronRightIcon } from "@dynatrace/strato-icons";
import { DEAD, ROOM_KINDS, moveOf, type RoomCell, type RoomKind } from "./room";
import { useSel } from "./source";

/** what a cell prints when the analyzer declined to speak for it */
const NONE = "not analysed";

export default function RoomList({ of, cells, focus }: {
  of: RoomKind; cells: RoomCell[]; focus: string;
}) {
  const kind = ROOM_KINDS.find((k) => k.id === of)!;
  const { setPick, onDevice } = useSel();
  const answered = cells.filter((c) => c.reach != null).length;
  /* the base order, and the order the table falls back to when a column ties */
  const data = useMemo(() => cells.slice().sort((a, b) => b.now - a.now), [cells]);
  const row = data.findIndex((c) => c.s.key === focus);
  /* read at fire time, not at render time: the rows re-sort as the analyzer answers */
  const dataRef = useRef(data);
  dataRef.current = data;
  const rowOf = (key: string) => dataRef.current.findIndex((c) => c.s.key === key);

  /**
   * The row the comb opened is scrolled to, and the component cannot be the one to do it.
   *
   * `activeRow` marks the row and nothing more: a subject picked out of a hundred and
   * thirty-five is marked at a scroll position nobody is looking at — measured on a tile
   * reading 23.1%, which under the "Today" sort sits ninety-three rows down, and the panel
   * opened on a list that looked like it had selected nothing.
   *
   * `DataTableRef.scrollToRow` is the component's own answer and it is inert here. It drives
   * the row virtualizer's container, and that container only overflows when the table owns a
   * height; inside `PageLayout.Details` the table grows to its full length and the *panel* is
   * what scrolls. Measured with and without `fullHeight`: the active row sat 3,633 px down
   * and the virtualizer's `scrollTop` stayed 0 both times.
   *
   * So the scroll is set on whichever ancestor actually overflows, and on that one alone —
   * `scrollIntoView` would take the page behind the panel with it, moving the comb the reader
   * is still looking at.
   */
  /**
   * The row that is open, which a click anywhere on the row sets.
   *
   * The caret was the only way in, and a reader who clicks the name, the site or the reading
   * — the whole width of the row — got a highlight and no numbers, while the three readings
   * the card is about sat one click away behind a glyph eight pixels wide. Clicking the row
   * selects it and opens it, so the same gesture does both; the caret stays for closing it
   * again and for opening a row without moving the comb's selection.
   *
   * One at a time, keyed off the active row: the panel is for the subject the reader picked,
   * and a list with nine paragraphs open in it is a different thing.
   */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { if (row >= 0) setOpen({ [String(row)]: true }); }, [row]);

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    /* A frame is not enough and a cleanup is actively harmful here. Keyed on `data` the
       effect re-ran on every forecast reply — four hundred and twenty-nine of them — and
       each cleanup cancelled the frame the previous run had queued, so the scroll never
       happened once. It is keyed on the pick alone, and it looks the row up when it fires,
       by key rather than by an index that the re-sort has since moved. */
    const t = setTimeout(() => {
      const el = box.current?.querySelector<HTMLElement>(`[data-rowid="${rowOf(focus)}"]`);
      if (!el) return;
      let sc: HTMLElement | null = el.parentElement;
      while (sc && sc.scrollHeight <= sc.clientHeight + 4) sc = sc.parentElement;
      if (!sc) return;
      const r = el.getBoundingClientRect(), b = sc.getBoundingClientRect();
      const want = sc.scrollTop + (r.top - b.top) - (b.height - r.height) / 2;
      sc.scrollTop = Math.max(0, Math.min(want, sc.scrollHeight - sc.clientHeight));
    }, 80);
    return () => clearTimeout(t);
  }, [focus]);

  /**
   * Three columns, and the forecast readings in the row itself.
   *
   * Six columns do not fit in the detail panel: measured at its own width, "Could reach",
   * "Expected" and "Move" were all past the right edge, so the panel showed a subject, a site
   * and today's reading and nothing the card is actually about. They are not dropped and they
   * are not pushed behind a sideways scroll — the row opens on them, which is the component's
   * own `ExpandableRow` and the shape a reader reaches for.
   *
   * The three that stay are narrow on purpose. The expander takes a column of its own and the
   * row action takes another, and at the panel's width the reading was the first thing pushed
   * off the edge — which is the one number a reader is scanning the list for. The names give
   * way instead: both end in an ellipsis, both carry the whole of it on hover, and the owner
   * is repeated in full inside the expansion.
   */
  const columns = useMemo<DataTableColumnDef<RoomCell>[]>(() => [
    {
      id: "name", header: "Subject", accessor: (c: RoomCell) => c.s.name, width: 132,
      /* the full name on hover: pinned and narrow, it ends in an ellipsis, and what the
         ellipsis eats is the domain suffix every row shares */
      cell: ({ rowData }) => <span className="np-mono" title={rowData.s.name}>{rowData.s.name}</span>,
    },
    {
      id: "owner", header: kind.owner, width: 92,
      /* a memory and a processor are named after their device, so repeating the device under
         them reads "X on X"; what they have that the name does not is the site */
      accessor: (c: RoomCell) => (of === "port" ? (c.s.device?.name ?? c.s.sub) : (c.s.site || "—")),
      cell: ({ rowData }) => {
        const owner = of === "port" ? (rowData.s.device?.name ?? rowData.s.sub) : (rowData.s.site || "—");
        return <span title={owner}>{owner}</span>;
      },
    },
    {
      /* the heading carries the unit: a column of bare per cents says how full, never of what */
      id: "now", header: `Today · ${kind.short}`, accessor: (c: RoomCell) => c.now,
      width: 132, alignment: "right",
      cell: ({ rowData }) => <span className="np-mono">{rowData.now}%</span>,
    },
  ], [kind.owner, kind.short, of]);

  return (
    <div ref={box}>
      <div className="rl-head">
        <Text textStyle="small">{kind.unit} · {cells.length} measured · {answered} answered by Dynatrace</Text>
      </div>
      {/**
        * `activeRow` is the comb's selection, so the two stay the same thing.
        *
        * A cell picked out of a hundred and sixty-nine lands wherever the current sort puts it,
        * which is usually below the fold; handing the table the id scrolls it into view and
        * marks it, which the hand-written version did with a `requestAnimationFrame` and
        * `getBoundingClientRect`. Row ids are indices into `data`, which is why the click
        * handler reads `cells[Number(rowId)]`.
        */}
      <DataTable data={data} columns={columns} sortable fullWidth resizable
        columnPinning defaultPinnedColumns={{ left: ["name"] }}
        defaultSortBy={[{ id: "now", desc: true }]}
        interactiveRows
        activeRow={row < 0 ? null : String(row)}
        onActiveRowChange={(rowId) => {
          const c = rowId == null ? null : data[Number(rowId)];
          if (c) setPick({ kind: "room", of, key: c.s.key });
        }}
      >
        {/* the chevron the hand-written table carried in a last column: the platform puts
            row actions in their own menu, and "open the device" is the only one there is */}
        <DataTable.RowActions>
          {(row: RoomCell) => {
            const dev = row.s.device?.name;
            return dev
              ? (
                <Button size="condensed" aria-label={`Open ${dev}`} onClick={() => onDevice(dev)}>
                  <Button.Prefix><ChevronRightIcon /></Button.Prefix>
                </Button>
              )
              : <></>;
          }}
        </DataTable.RowActions>
        {/* what the header row has no width for, in the row the reader opened */}
        <DataTable.ExpandableRow expandedRows={open} onExpandedRowsChange={setOpen}>
          {({ row }: { row: RoomCell }) => {
            const m = moveOf(row);
            return (
              <Flex flexDirection="row" gap={32} flexWrap="wrap" className="rl-more">
                {/* every figure says what it is a figure of: the three per cents are per cents
                    of this kind's own limit, and the move is in points of that same scale */}
                <span><b>Could reach</b>{row.reach == null
                  ? <i className="rl-none">{NONE}</i>
                  : <u className="rl-fc">{row.reach}% <em>{kind.short.replace("% of ", "of ")}</em></u>}</span>
                <span><b>Expected</b>{row.expected == null
                  ? <i className="rl-none">—</i>
                  : <u className="rl-fc">{row.expected}% <em>{kind.short.replace("% of ", "of ")}</em></u>}</span>
                <span><b>Move</b>{m == null ? <i className="rl-none">—</i>
                  /* under the dead band the forecast's own width is wider than the change */
                  : Math.abs(m) < DEAD ? <i className="rl-none">flat</i>
                  : <u className="rl-fc">{m > 0 ? "+" : "−"}{Math.abs(m)} <em>points</em></u>}</span>
                <span><b>{of === "port" ? "Device" : "Site"}</b>
                  <u>{of === "port" ? (row.s.device?.name ?? row.s.sub) : (row.s.site || "—")}</u></span>
              </Flex>
            );
          }}
        </DataTable.ExpandableRow>
      </DataTable>
      <div className="note">
        Today is the busy hour of the record. <b>Could reach</b> is the top of the analyzer&rsquo;s
        band over the horizon — how high it could get; <b>expected</b> is its point forecast, which
        is the same cycle with the spikes taken out and reads lower on anything that spikes.
      </div>
    </div>
  );
}
