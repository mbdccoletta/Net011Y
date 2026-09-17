#!/usr/bin/env python3
"""Extract a simplified Brazil outline from world-atlas (TopoJSON) as an SVG path.

Projection: equirectangular, longitude scaled by cos(15°S). The same projection
is exported so the prototype can place sites by lat/lon.
"""
import json, math, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
topo = json.load(open(ROOT / "data" / "geo" / "countries-50m.json"))
sx, sy = topo["transform"]["scale"]; tx, ty = topo["transform"]["translate"]

def arc(i):
    rev = i < 0
    pts, x, y = [], 0, 0
    for dx, dy in topo["arcs"][~i if rev else i]:
        x += dx; y += dy
        pts.append((x * sx + tx, y * sy + ty))
    return pts[::-1] if rev else pts

geom = next(g for g in topo["objects"]["countries"]["geometries"] if g.get("id") == "076")
K = math.cos(math.radians(15))
W, PAD = 600, 10
LON0, LON1, LAT0, LAT1 = -74.2, -34.6, -33.9, 5.4
scale = (W - 2 * PAD) / ((LON1 - LON0) * K)
H = round((LAT1 - LAT0) * scale + 2 * PAD)

def proj(lon, lat):
    return (PAD + (lon - LON0) * K * scale, PAD + (LAT1 - lat) * scale)

paths = []
for poly in geom["arcs"]:
    ring = []
    for a in poly[0]:
        pts = arc(a)
        ring.extend(pts if not ring else pts[1:])
    if len(ring) < 30:
        continue
    out, last = [], None
    for lon, lat in ring:
        p = proj(lon, lat)
        if last is None or math.dist(p, last) > 1.6:
            out.append(p); last = p
    paths.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in out) + "Z")

res = {"viewBox": [0, 0, W, H], "path": "".join(paths),
       "proj": {"lon0": LON0, "lat1": LAT1, "k": K, "scale": scale, "pad": PAD}}
(ROOT / "data" / "geo" / "brazil.json").write_text(json.dumps(res))
print("polygons", len(paths), "chars", len(res["path"]), "viewBox", res["viewBox"])
