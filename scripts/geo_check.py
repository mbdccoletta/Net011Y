#!/usr/bin/env python3
"""Does the map's state layer say the same thing the source says?

The outlines under the Regions view are generated (scripts/admin1.py) from Natural Earth 10m
admin-1, simplified to about five kilometres and quantised to a hundredth of a degree. Three things
can go wrong between the source and the file the app loads, and the app cannot tell them apart:

  * a region drops out — the area filter and the simplifier both discard what is small, and a
    country whose regions are all small (Malta: sixty-eight localities, four survived) loses most of
    itself, including the bounds that decide whether its outlines are fetched at all;
  * a region moves — simplification can push an outline far enough that a point inside the real
    region falls inside a different one, so a site is counted under its neighbour;
  * two regions carry the same code — the label on the map and the count of regions both read the
    code, so one province hides the other.

And one thing goes wrong before the source reaches us: Natural Earth's own `name` and `iso_3166_2`
are shifted against the geometry in a few countries, which the GeoNames fields on the same feature
(`gn_name`, `woe_label`) disagree with. That is not something regenerating can fix, so it is counted
and named rather than silently carried.

  python3 scripts/geo_check.py [cc ...]

Exits non-zero if anything in the first three classes is found.
"""
import json, pathlib, sys, math, re, unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data/geo/ne_admin1_10m.geojson"
GEN = ROOT / "app/ui/app/data/geo/admin1"
ONLY = [a for a in sys.argv[1:] if not a.startswith("-")]


def rings_of(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    return [[(float(x), float(y)) for x, y in p[0]] for p in polys]


def area_of(ring):
    s = 0.0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(s) / 2


def in_ring(ring, x, y):
    inside = False
    for i in range(len(ring) - 1):
        xi, yi = ring[i]
        xj, yj = ring[i + 1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
    return inside


def inside_points(ring):
    """Points the region certainly contains — several of them, because one is not a fair test.

    A county with a city inside it has that city at its centre: Debrecen sits where the vertex
    average of Hajdú-Bihar lands, so a single point would report the county as lost when the only
    thing that happened is that the point belongs to the enclave. The scan takes the middle of each
    span it crosses at several heights, and the region is judged by whether *any* of them finds it.
    """
    out = []
    cx = sum(x for x, _ in ring) / len(ring)
    cy = sum(y for _, y in ring) / len(ring)
    if in_ring(ring, cx, cy):
        out.append((cx, cy))
    xs = [x for x, _ in ring]
    ys = [y for _, y in ring]
    for f in (0.5, 0.35, 0.65, 0.2, 0.8, 0.45, 0.55):
        y = min(ys) + (max(ys) - min(ys)) * f
        xi = sorted(x1 + (x2 - x1) * (y - y1) / (y2 - y1)
                    for (x1, y1), (x2, y2) in zip(ring, ring[1:]) if (y1 > y) != (y2 > y))
        for a, b in zip(xi[0::2], xi[1::2]):
            if b - a > 1e-9:
                out.append(((a + b) / 2, y))
    return out[:9] or [(cx, cy)]


def decode(s):
    """The app's own decoder, in Python: five bits a character, quantised deltas."""
    out = []
    x = y = 0
    i = 0
    while i < len(s):
        vals = []
        for _ in range(2):
            v = shift = 0
            while True:
                c = ord(s[i]) - 63
                i += 1
                v |= (c & 31) << shift
                shift += 5
                if c < 32:
                    break
            vals.append(-(v >> 1) if v & 1 else v >> 1)
        x += vals[0]
        y += vals[1]
        out.append((x / 100, y / 100))
    return out


NEAR = 0.3   # load.ts: how far outside an outline a site may sit and still belong to it


def region_at(regions, lon, lat):
    """load.ts `regionAt`, including the nearest-outline fallback, so this measures what the app does."""
    near, best = None, NEAR * NEAR
    for r in regions:
        b = r["b"]
        if lon < b[0] - NEAR or lon > b[2] + NEAR or lat < b[1] - NEAR or lat > b[3] + NEAR:
            continue
        if b[0] <= lon <= b[2] and b[1] <= lat <= b[3] and any(in_ring(ring, lon, lat) for ring in r["rings"]):
            return r
        for ring in r["rings"]:
            for (x, y) in ring:
                d = (x - lon) ** 2 + (y - lat) ** 2
                if d < best:
                    best, near = d, r
    return near


def generated():
    out = {}
    for path in sorted(GEN.glob("*.ts")):
        if path.stem == "index" or path.stem == "load":
            continue
        text = path.read_text(encoding="utf8")
        m = re.search(r"export default (\{.*\}) as const;", text, re.S)
        if not m:
            continue
        doc = json.loads(m.group(1))
        for r in doc["regions"]:
            r["rings"] = [decode(d) for d in r["d"]]
        out[doc["cc"]] = doc["regions"]
    return out


def strip(s):
    """Names to compare: "Maekel Region" and "Ma'akel" are the same answer, "Anseba" is not."""
    # accents fold rather than vanish: stripping them as "not a letter" turns Gədəbəy into gdby,
    # which matches nothing and reports every accented name in the world as a disagreement
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = re.sub(r"[^a-z]+", "", s)
    for suffix in ("region", "province", "district", "state", "governorate", "prefecture", "department"):
        s = s.replace(suffix, "")
    return s


# Places whose region is not in dispute, each one a city the app would put on the map. Eritrea and
# Guyana are here because Natural Earth's own labels are shifted against its geometry there and the
# generator takes those two countries' names from the GeoNames fields instead; the rest are the
# enclaves and small states where simplification used to lose the answer.
PLACES = [
    ("ER", "Asmara", 38.9251, 15.3229, "Maekel"),
    ("ER", "Keren", 38.4511, 15.7778, "Anseba"),
    ("ER", "Massawa", 39.4521, 15.6097, "Northern Red Sea"),
    ("ER", "Mendefera", 38.8158, 14.8869, "Debub"),
    ("GY", "Georgetown", -58.1553, 6.8013, "Demerara-Mahaica"),
    ("GY", "Lethem", -59.7968, 3.3833, "Upper Takutu-Upper Essequibo"),
    ("GY", "Linden", -58.3000, 6.0000, "Upper Demerara-Berbice"),
    ("GY", "New Amsterdam", -57.5208, 6.2482, "East Berbice-Corentyne"),
    ("MT", "Valletta", 14.5146, 35.8989, "Valletta"),
    ("MT", "Victoria, Gozo", 14.2394, 36.0444, "Victoria"),
    ("SB", "Honiara", 159.9556, -9.4456, "Capital Territory (Honiara)"),
    ("SB", "Gizo", 156.8419, -8.1031, "Western"),
    ("AT", "Vienna", 16.3738, 48.2082, "Wien"),
    ("AU", "Canberra", 149.1300, -35.2809, "Australian Capital Territory"),
    ("HU", "Debrecen", 21.6273, 47.5316, "Debrecen"),
    ("KR", "Seoul", 126.9780, 37.5665, "Seoul"),
    ("BW", "Francistown", 27.5143, -21.1700, "Francistown"),
    ("BR", "São Paulo", -46.6333, -23.5505, "São Paulo"),
    ("US", "Seattle", -122.3321, 47.6062, "Washington"),
    ("DE", "Berlin", 13.4050, 52.5200, "Berlin"),
]


def main():
    src = json.load(open(SRC))
    gen = generated()
    by_cc = {}
    for f in src["features"]:
        p = f["properties"]
        cc = (p.get("iso_a2") or "").strip()
        if not cc or cc in ("-99", "-1") or (ONLY and cc not in ONLY):
            continue
        by_cc.setdefault(cc, []).append(f)

    # Coordinates are written on a hundredth-of-a-degree grid — about a kilometre — so a region
    # narrower than a couple of grid cells cannot be told from its neighbour by any point inside it.
    # It is still drawn and still labelled; what it cannot do is claim a site. That is a property of
    # the format, stated here, and not a defect to be reported as one.
    GRID_DEG = 0.01
    missing, moved, dupes, mislabelled, subgrid = [], [], [], [], []
    checked = 0
    for cc, feats in sorted(by_cc.items()):
        regions = gen.get(cc)
        if regions is None:
            missing.append((cc, "the whole country", len(feats)))
            continue
        # the generator may rewrite a code to keep it unique within its country, so a region is
        # followed by the name it carries, and the code only where the name is not in the file
        have = {r["code"] for r in regions} | {r["name"] for r in regions}
        seen = {}
        for r in regions:
            seen.setdefault(r["code"], []).append(r["name"])
        for code, names in seen.items():
            if len(names) > 1:
                dupes.append((cc, code, names))
        for f in feats:
            p = f["properties"]
            code = (p.get("iso_3166_2") or "").split("-")[-1] or p.get("postal") or ""
            name = p.get("name") or code
            # Eritrea and Guyana are generated from the GeoNames fields, because Natural Earth's
            # own labels are shifted there (see RELABEL in scripts/admin1.py); this has to follow
            # the same rule or it reports the correction as the error.
            if cc in ("ER", "GY"):
                for field in ("gn_name", "gns_name"):
                    raw = (p.get(field) or "").strip()
                    if raw:
                        name = re.sub(r"\s+(Region|Province|District)$", "", raw)
                        break
            rs = rings_of(f["geometry"])
            if not rs:
                continue
            big = max(rs, key=area_of)
            # the source's own identifiers, cross-checked against the GeoNames fields beside them
            # One disagreement is a spelling or a language. The signature worth reporting is the
            # one Eritrea has: both GeoNames fields on the feature agree with each other and
            # neither is the name Natural Earth put on it, which is what a shifted label looks like.
            # "Kagoshima" and "Kagoshima-ken", "Pskov" and "Pskovskaya Oblast'" are the same place
            # said twice; what is worth reporting is a name with nothing of the other in it.
            def same(a, b):
                return bool(a) and bool(b) and (a in b or b in a) and min(len(a), len(b)) >= 4
            gn, gns = strip(p.get("gn_name")), strip(p.get("gns_name"))
            if strip(name) and gn and gns and same(gn, gns) and not same(gn, strip(name)):
                mislabelled.append((cc, code, name, [p.get("gn_name"), p.get("gns_name")]))
            if name not in have and code not in have:
                missing.append((cc, f"{code} {name}", round(area_of(big), 3)))
                continue
            checked += 1
            tried = []
            for x, y in inside_points(big):
                got = region_at(regions, x, y)
                if got is not None and (got["name"] == name or got["code"] == code):
                    break
                tried.append((got["name"] if got else "nothing", round(x, 3), round(y, 3)))
            else:
                xs = [x for x, _ in big]
                ys = [y for _, y in big]
                row = (cc, code, name, tried[0][0], tried[0][1], tried[0][2])
                if max(xs) - min(xs) < 2 * GRID_DEG or max(ys) - min(ys) < 2 * GRID_DEG:
                    subgrid.append(row)
                else:
                    moved.append(row)

    print(f"checked {checked} regions in {len(by_cc)} countries\n")
    print(f"missing from the generated files : {len(missing)}")
    for row in missing[:12]:
        print("   ", row)
    if len(missing) > 12:
        print(f"    … and {len(missing) - 12} more")
    worst = {}
    for cc, what, _ in missing:
        worst[cc] = worst.get(cc, 0) + 1
    if worst:
        print("    by country:", ", ".join(f"{cc} {n}" for cc, n in sorted(worst.items(), key=lambda kv: -kv[1])[:10]))

    print(f"\nregions smaller than the coordinate grid, which no point can resolve: {len(subgrid)}")
    for row in subgrid[:8]:
        print("   ", row)

    print(f"\nregions a point of their own no longer lands in: {len(moved)}")
    for row in moved[:12]:
        print("   ", row)
    if len(moved) > 12:
        print(f"    … and {len(moved) - 12} more")

    print(f"\ncodes used twice in one country: {len(dupes)}")
    for row in dupes[:10]:
        print("   ", row)

    print(f"\nsource features whose name disagrees with their own GeoNames fields: {len(mislabelled)}")
    bycc = {}
    for cc, code, name, others in mislabelled:
        bycc.setdefault(cc, []).append(f"{code}:{name}≠{(others or ['?'])[0]}")
    for cc, items in sorted(bycc.items(), key=lambda kv: -len(kv[1]))[:8]:
        print(f"    {cc}: {len(items)} —", "; ".join(items[:3]))

    wrong_place, on_the_line = [], []
    for cc, city, lon, lat, expect in PLACES:
        regions = gen.get(cc)
        if regions is None:
            wrong_place.append((cc, city, "no outlines for the country", expect))
            continue
        got = region_at(regions, lon, lat)
        if got is not None and got["name"] == expect:
            continue
        # A place within one grid cell of the drawn boundary is the format's resolution, not a
        # misplacement: New Amsterdam sits on the Berbice, the river is the border, and the line
        # here lands about thirty metres west of the town.
        if any((n := region_at(regions, lon + dx, lat + dy)) is not None and n["name"] == expect
               for dx, dy in ((GRID_DEG, 0), (-GRID_DEG, 0), (0, GRID_DEG), (0, -GRID_DEG))):
            on_the_line.append((cc, city, got["name"] if got else "nothing", expect))
            continue
        wrong_place.append((cc, city, got["name"] if got else "nothing", expect))
    if on_the_line:
        print(f"\nplaces within a grid cell of the line they sit on: {len(on_the_line)}")
        for row in on_the_line:
            print("   ", row)
    print(f"\nplaces that land in the wrong region: {len(wrong_place)} of {len(PLACES)}")
    for row in wrong_place:
        print("   ", row)

    bad = len(missing) + len(moved) + len(dupes) + len(wrong_place)
    print(f"\n{'OK' if not bad else str(bad) + ' to answer for'}")
    sys.exit(1 if bad else 0)


main()
