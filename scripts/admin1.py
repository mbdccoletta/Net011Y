#!/usr/bin/env python3
"""Turns Natural Earth admin-1 (states, provinces) into one small module per country, for the map's
state layer. The app imports a country's module only when it draws that country, so nothing of this
reaches the bundle of someone who never opens the view.

Source: data/geo/ne_admin1_10m.geojson (Natural Earth 10m admin_1_states_provinces, public domain).
Output: app/ui/app/data/geo/admin1/<cc>.ts, plus an index of which countries exist.

  python3 scripts/admin1.py [tolerance_degrees] [--write]

Without --write it only measures, which is the point: the size is the decision.
"""
import json, pathlib, sys, math, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data/geo/ne_admin1_10m.geojson"
OUT = ROOT / "app/ui/app/data/geo/admin1"
# Two kilometres, not five.
#
# The tolerance is the width of the error at a border, and a border is where this layer is asked its
# only question: which region is this site in. At 0.05° a site within five kilometres of a boundary
# could fall on the wrong side of it; the files cost 866 KB across 240 countries at that figure and
# 1,048 KB at 0.02°, spread over one chunk per country that nobody fetches unless they have a site
# in it. The median country is two and a half kilobytes either way.
TOL = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else 0.02
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


# Two countries whose labels Natural Earth has shifted against the geometry.
#
# The feature that covers Asmara is named "Anseba" and coded ER-AN; the GeoNames fields on that same
# feature say "Maekel Region" and ER.05, which is where Asmara is. Six cities in Eritrea and six in
# Guyana were put through the source geometry and the GeoNames name was right every time — Keren in
# Anseba, Massawa in the Northern Red Sea, Lethem in Upper Takutu-Upper Essequibo, Georgetown in
# Demerara-Mahaica. Nothing here is a judgement about the shapes: the outlines are the source's, and
# only the name and the code on them are taken from the other fields of the same record.
#
# `python3 scripts/geo_check.py` re-tests those cities, so a regeneration that loses this fails.
RELABEL = {
    "ER": {"Anseba": "AN", "Debub": "DU", "Debubawi Keyih Bahri": "DK", "Southern Red Sea": "DK",
           "Gash-Barka": "GB", "Maekel": "MA", "Semenawi Keyih Bahri": "SK", "Northern Red Sea": "SK"},
    "GY": {"Barima-Waini": "BA", "Cuyuni-Mazaruni": "CU", "Demerara-Mahaica": "DE",
           "East Berbice-Corentyne": "EB", "Essequibo Islands-West Demerara": "ES",
           "Mahaica-Berbice": "MA", "Pomeroon-Supenaam": "PM", "Potaro-Siparuni": "PT",
           "Upper Demerara-Berbice": "UD", "Upper Takutu-Upper Essequibo": "UT"},
}


def relabel(cc, props, code, name):
    """The name and code the GeoNames fields give this polygon, where those are the ones to trust."""
    table = RELABEL.get(cc)
    if not table:
        return code, name
    for field in ("gn_name", "gns_name"):
        raw = (props.get(field) or "").strip()
        if not raw:
            continue
        clean = re.sub(r"\s+(Region|Province|District)$", "", raw)
        if clean in table:
            return table[clean], clean
    return code, name


def grid_for(spans):
    """The grid a country is written on: fine enough that its smallest region is still a shape.

    Coordinates are quantised, and a region narrower than a cell collapses. The Vatican — four
    hundred metres across — came out as a single point with a bounding box of zero width, which
    `countriesOf()` can never match, so a site there got no outlines and the one region it has could
    not be drawn. One grid for the whole world cannot hold both Russia and the Vatican, so each
    country is written on its own: the default hundredth of a degree, doubled until the smallest
    region spans four cells, which is the fewest a quadrilateral can be drawn on. Only the countries
    that need it pay for it, and the file says which grid it used.

    Four and not eight because the grid is the whole country's: one small region in a large country
    would otherwise refine every outline in it. Measured over the whole world — eight cells costs
    1,149 KB and puts Russia at 75 KB, four costs 1,120 and keeps Russia at 64, for the same
    countries rescued.
    """
    smallest = min([s for s in spans if s > 0] or [1.0])
    grid = GRID
    while smallest * grid < 4 and grid < 100000:
        grid *= 2
    return grid


def tolerance_for(area):
    """How coarse a region may be drawn: a fraction of its own size, never coarser than the default.

    One tolerance for the whole world is one tolerance for Siberia and for a Maltese locality. At
    0.05° — about five kilometres — a locality a kilometre across simplifies to fewer than four
    points and is dropped, which is how sixty-four of Malta's sixty-eight regions, and Anguilla
    entirely, failed to reach the app: the bounds that decide whether a country's outlines are
    fetched at all were then computed from the four that survived, so a site in Valletta got no
    Maltese outlines. A region keeps its shape to about a twenty-fifth of its own width now, and
    nothing is simplified below a hundred metres, which is finer than the line that draws it.
    """
    return max(0.001, min(TOL, math.sqrt(max(area, 1e-9)) / 25))


def area_of(ring):
    s = 0.0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(s) / 2


def encode(ring, grid=None):
    """Quantised deltas as a string: one signed varint per value, six bits a character."""
    grid = grid or GRID
    out = []
    px = py = 0
    for x, y in ring:
        qx, qy = round(x * grid), round(y * grid)
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
    return [[math.floor(b[0] * 1e4) / 1e4, math.floor(b[1] * 1e4) / 1e4,
             math.ceil(b[2] * 1e4) / 1e4, math.ceil(b[3] * 1e4) / 1e4] for b in boxes]


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
        outers = [[(float(x), float(y)) for x, y in poly[0]] for poly in polys]
        if not outers:
            continue
        # the region's own size sets how finely it is drawn, and its largest piece is never dropped:
        # a region that reaches the app as nothing at all takes its name, its code and its share of
        # the country's bounds with it
        main = max(outers, key=area_of)
        tol = tolerance_for(area_of(main))
        rings = []
        for outer in outers:
            a_outer = area_of(outer)
            if outer is not main and a_outer < tol * tol * 4:   # an island smaller than the pen that draws it
                continue
            simplified = simplify(outer, tol)
            if len(simplified) < 4:
                # whatever is left of a shape this small is still where the region is
                simplified = outer if len(outer) >= 4 else None
            if simplified:
                rings.append(simplified)
        if not rings:
            continue
        big = max(rings, key=area_of)
        cx = sum(x for x, _ in big) / len(big)
        cy = sum(y for _, y in big) / len(big)
        code = (p.get("iso_3166_2") or "").split("-")[-1] or p.get("postal") or ""
        code, feature_name = relabel(cc, p, code, p.get("name") or code)
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
            "code": code, "name": feature_name,
            "postal": (p.get("postal") or "").strip(), "hasc": (p.get("code_hasc") or "").strip(),
            "adm1": (p.get("adm1_code") or "").strip(),
            "lon": round(cx, 4), "lat": round(cy, 4),
            # the box is rounded outward: it decides whether a region is even looked at, and a box
            # that rounds inward can exclude a point the region contains
            "b": [math.floor(min(xs) * 1e4) / 1e4, math.floor(min(ys) * 1e4) / 1e4,
                  math.ceil(max(xs) * 1e4) / 1e4, math.ceil(max(ys) * 1e4) / 1e4],
            "p": [[math.floor(q[0] * 1e4) / 1e4, math.floor(q[1] * 1e4) / 1e4,
                   math.ceil(q[2] * 1e4) / 1e4, math.ceil(q[3] * 1e4) / 1e4] for q in parts],
            "rings": rings,
        })

    # Natural Earth gives two of the Solomon Islands' provinces the same iso_3166_2 (Western and
    # Choiseul are both SB-CH), and the same happens in a handful of other countries. The map prints
    # the code on the region and counts how many distinct ones a view holds, so a repeat hides a
    # province and undercounts the estate. Where the right answer is known it is written down; where
    # it is not, the duplicate falls back to the other identifiers the source carries.
    ISO_FIX = {("SB", "Western"): "WE"}

    def unique_codes(cc, regions):
        seen = {}
        for r in regions:
            fixed = ISO_FIX.get((cc, r["name"]))
            if fixed:
                r["code"] = fixed
            code = r["code"]
            if code not in seen:
                seen[code] = r
                continue
            # the postal abbreviation, then the source's own admin-1 id, then a number: whatever
            # separates them, as long as two regions never answer to one code
            for candidate in (r.get("postal") or "", (r.get("hasc") or "").split(".")[-1], (r.get("adm1") or "")[-4:]):
                c = candidate.strip()
                if c and c not in seen:
                    r["code"] = c
                    break
            else:
                n = 2
                while f"{code}{n}" in seen:
                    n += 1
                r["code"] = f"{code}{n}"
            seen[r["code"]] = r
        return regions

    total = 0
    rows = []
    boxes = {}
    for cc, regions in sorted(by_cc.items()):
        regions = unique_codes(cc, regions)
        # Smallest first, because the app returns the first outline a point falls inside and an
        # enclave is inside the region around it: holes are not carried (they would cost more than
        # they are worth here), so Vienna sat inside Lower Austria, the Australian Capital Territory
        # inside New South Wales, and Botswana's three cities inside their districts. Ordered this
        # way the enclave is asked about first and answers for itself.
        regions.sort(key=lambda r: (r["b"][2] - r["b"][0]) * (r["b"][3] - r["b"][1]))
        boxes[cc] = cluster_boxes([q for r in regions for q in r["p"]])
        grid = grid_for([span for r in regions for span in (r["b"][2] - r["b"][0], r["b"][3] - r["b"][1])])
        for r in regions:
            r["d"] = [encode(ring, grid) for ring in r["rings"]]
        drop = ("p", "postal", "hasc", "adm1", "rings")
        doc = {"cc": cc, "regions": [{k: v for k, v in r.items() if k not in drop} for r in regions]}
        if grid != GRID:
            doc["g"] = grid
        body = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
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
            "/** coordinates are quantised to 1/g of a degree; absent means the default hundredth */\n"
            "export interface Admin1Country { cc: string; g?: number; regions: readonly Admin1Region[] }\n\n"
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
