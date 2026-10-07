#!/usr/bin/env python3
"""Turns Natural Earth admin-1 (states, provinces) into one small module per country, for the map's
state layer. The app imports a country's module only when it draws that country, so nothing of this
reaches the bundle of someone who never opens the view.

Source: data/geo/ne_admin1_10m.geojson (Natural Earth 10m admin_1_states_provinces, public domain).
Output: app/ui/app/data/geo/admin1/<cc>.ts, plus an index of which countries exist.

  python3 scripts/admin1.py [tolerance_degrees] [--write]

Without --write it only measures, which is the point: the size is the decision.
"""
import json, pathlib, sys, math

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data/geo/ne_admin1_10m.geojson"
OUT = ROOT / "app/ui/app/data/geo/admin1"
TOL = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else 0.05
WRITE = "--write" in sys.argv
# coordinates are kept to a hundredth of a degree: about a kilometre, under the width of the line
# that draws them at any zoom this map reaches
GRID = 100


def simplify(points, tol):
    """Douglas-Peucker. The ring keeps its first and last point, so it still closes."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        (x1, y1), (x2, y2) = points[a], points[b]
        dx, dy = x2 - x1, y2 - y1
        den = math.hypot(dx, dy)
        worst, wi = -1.0, a
        for i in range(a + 1, b):
            x, y = points[i]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / den if den else math.hypot(x - x1, y - y1)
            if d > worst:
                worst, wi = d, i
        if worst > tol:
            keep[wi] = True
            stack.append((a, wi))
            stack.append((wi, b))
    return [p for p, k in zip(points, keep) if k]


def area_of(ring):
    s = 0.0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(s) / 2


def encode(ring):
    """Quantised deltas as a string: one signed varint per value, six bits a character."""
    out = []
    px = py = 0
    for x, y in ring:
        qx, qy = round(x * GRID), round(y * GRID)
        for d in (qx - px, qy - py):
            v = (abs(d) << 1) | (1 if d < 0 else 0)
            while True:
                c = v & 31
                v >>= 5
                out.append(chr(63 + c + (32 if v else 0)))
                if not v:
                    break
        px, py = qx, qy
    return "".join(out)


def cluster_boxes(bs, gap=1.0, cap=14):
    """A country is not one box. France reaches from French Guiana to Réunion, and that rectangle holds
    Brazil, Africa and two oceans — so a site in São Paulo was fetching the hundred and one regions of
    France and drawing them over Europe. Overseas territories get boxes of their own."""
    boxes = [list(b) for b in bs]
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] - gap <= b[2] and b[0] - gap <= a[2] and a[1] - gap <= b[3] and b[1] - gap <= a[3]:
                    boxes[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    boxes.pop(j)
                    merged = True
                    break
            if merged:
                break
    while len(boxes) > cap:   # the smallest join whatever is nearest, so the list stays short
        boxes.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
        a = boxes.pop(0)
        k = min(range(len(boxes)), key=lambda i: abs(boxes[i][0] - a[0]) + abs(boxes[i][1] - a[1]))
        b = boxes[k]
        boxes[k] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
    return [[round(v, 2) for v in b] for b in boxes]


def main():
    data = json.load(open(SRC))
    by_cc = {}
    for f in data["features"]:
        p = f["properties"]
        cc = (p.get("iso_a2") or p.get("adm0_a3") or "").strip()
        if not cc or cc in ("-99", "-1"):
            continue
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        rings = []
        for poly in polys:
            outer = [(float(x), float(y)) for x, y in poly[0]]
            if area_of(outer) < TOL * TOL * 4:   # an island smaller than the pen that draws it
                continue
            s = simplify(outer, TOL)
            if len(s) >= 4:
                rings.append(s)
        if not rings:
            continue
        big = max(rings, key=area_of)
        cx = sum(x for x, _ in big) / len(big)
        cy = sum(y for _, y in big) / len(big)
        code = (p.get("iso_3166_2") or "").split("-")[-1] or p.get("postal") or ""
        xs = [x for r in rings for x, _ in r]
        ys = [y for r in rings for _, y in r]
        # A region that crosses the antimeridian — Chukotka, the Aleutians, Fiji — has points at both
        # ends of the scale, and a plain min/max turns its box into the whole planet. Russia then
        # matched a site in Seattle and fetched sixty kilobytes to draw nothing.
        if max(xs) - min(xs) > 180:
            west = [x for x in xs if x > 0]
            east = [x for x in xs if x <= 0]
            parts = [[min(west), min(ys), 180.0, max(ys)], [-180.0, min(ys), max(east), max(ys)]]
        else:
            parts = [[min(xs), min(ys), max(xs), max(ys)]]
        by_cc.setdefault(cc, []).append({
            "code": code, "name": p.get("name") or code,
            "lon": round(cx, 2), "lat": round(cy, 2),
            "b": [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
            "p": [[round(v, 2) for v in q] for q in parts],
            "d": [encode(r) for r in rings],
        })

    total = 0
    rows = []
    boxes = {}
    for cc, regions in sorted(by_cc.items()):
        boxes[cc] = cluster_boxes([q for r in regions for q in r["p"]])
        body = json.dumps({"cc": cc, "regions": [{k: v for k, v in r.items() if k != "p"} for r in regions]}, separators=(",", ":"), ensure_ascii=False)
        size = len(body.encode())
        total += size
        rows.append((cc, len(regions), size))
        if WRITE:
            OUT.mkdir(parents=True, exist_ok=True)
            (OUT / f"{cc}.ts").write_text(
                "// Generated by scripts/admin1.py from Natural Earth 10m admin-1. Do not edit.\n"
                f"export default {body} as const;\n", encoding="utf8")
    if WRITE:
        loaders = ",\n  ".join(f'"{cc}": () => import("./{cc}")' for cc, _, _ in sorted(rows))
        (OUT / "index.ts").write_text(
            "// Generated by scripts/admin1.py from Natural Earth 10m admin-1. Do not edit.\n"
            "// A country's outlines are a chunk of their own: the bounding boxes say which countries the\n"
            "// sites fall in, and only those are fetched. Nobody who never opens the view downloads any.\n"
            "export interface Admin1Region { code: string; name: string; lon: number; lat: number; b: readonly number[]; d: readonly string[] }\n"
            "export interface Admin1Country { cc: string; regions: readonly Admin1Region[] }\n\n"
            "/** lon/lat boxes per country, west, south, east, north. More than one where a country\n"
            " *  has territories far from the rest of it. */\n"
            "export const ADMIN1_BOXES: Record<string, readonly (readonly number[])[]> = "
            + json.dumps(boxes, separators=(",", ":")) + ";\n\n"
            "export const ADMIN1_LOADERS: Record<string, () => Promise<{ default: Admin1Country }>> = {\n  "
            + loaders + ",\n};\n", encoding="utf8")

    rows.sort(key=lambda r: -r[2])
    print(f"tolerance {TOL}°  ·  {len(by_cc)} countries  ·  {sum(r[1] for r in rows)} regions  ·  {total/1024:.0f} KB total")
    print("biggest:", ", ".join(f"{cc} {size/1024:.0f}KB/{n}" for cc, n, size in rows[:8]))
    print("median country:", f"{sorted(r[2] for r in rows)[len(rows)//2]/1024:.1f} KB")


main()
