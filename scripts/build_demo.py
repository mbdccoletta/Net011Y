#!/usr/bin/env python3
# LEGACY: predates the alert-driven model. The app no longer judges health from thresholds;
# status comes from the problems and alerts Dynatrace raises. Kept only to rebuild the old prototype data.
"""Simulated Brazilian branch network for the NetworkPlane prototype.

Everything here is fictitious and is labelled as an example in the UI. It uses the
same verdict rules (verdict.py) and E2E aggregation (e2e.py) as the real GRU build,
so the example behaves exactly like the product would on customer data.
Naming convention: BR-<UF>-<SITE>-<ROLE><n>.
"""
import json, math, random, datetime, pathlib, unicodedata
from verdict import T, ORDER, worst, device_verdict
from e2e import device_hop, circuit_hop, app_hop, make_path

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "prototype" / "data-demo.js"
real_meta = json.loads((ROOT / "prototype" / "data.js").read_text()[len("window.NET = "):-2])["meta"]
geo = json.load(open(ROOT / "data" / "geo" / "brazil.json"))
rnd = random.Random(20260914)
NOW = datetime.datetime.strptime(real_meta["generatedAt"], "%Y-%m-%dT%H:%MZ")

def ago(minutes):
    return (NOW - datetime.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

def proj(lat, lon):
    p = geo["proj"]
    return round(p["pad"] + (lon - p["lon0"]) * p["k"] * p["scale"], 1), round(p["pad"] + (p["lat1"] - lat) * p["scale"], 1)

def km(lat1, lon1, lat2, lon2):
    a = math.sin(math.radians(lat2 - lat1) / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))

DC = {"code": "SPO1", "city": "São Paulo", "uf": "SP", "lat": -23.55, "lon": -46.63, "id": "1001"}
BRANCHES = [
    ("Rio Verde", "GO", -17.79, -50.93, "L"), ("Jataí", "GO", -17.88, -51.72, "M"), ("Itumbiara", "GO", -18.42, -49.22, "M"), ("Catalão", "GO", -18.17, -47.94, "S"),
    ("Luís Eduardo Magalhães", "BA", -12.09, -45.79, "L"), ("Barreiras", "BA", -12.15, -44.99, "M"), ("Salvador", "BA", -12.97, -38.50, "M"),
    ("Sorriso", "MT", -12.55, -55.72, "L"), ("Lucas do Rio Verde", "MT", -13.05, -55.91, "M"), ("Sinop", "MT", -11.86, -55.50, "M"),
    ("Rondonópolis", "MT", -16.47, -54.64, "L"), ("Primavera do Leste", "MT", -15.56, -54.30, "S"), ("Nova Mutum", "MT", -13.83, -56.08, "S"),
    ("Dourados", "MS", -22.22, -54.81, "M"), ("Maracaju", "MS", -21.61, -55.17, "S"), ("Chapadão do Sul", "MS", -18.79, -52.62, "S"), ("Campo Grande", "MS", -20.46, -54.62, "M"),
    ("Uberlândia", "MG", -18.92, -48.28, "L"), ("Uberaba", "MG", -19.75, -47.93, "M"), ("Patos de Minas", "MG", -18.58, -46.52, "S"), ("Unaí", "MG", -16.36, -46.90, "S"),
    ("Cascavel", "PR", -24.96, -53.46, "L"), ("Ponta Grossa", "PR", -25.10, -50.16, "M"), ("Maringá", "PR", -23.42, -51.94, "M"), ("Guarapuava", "PR", -25.39, -51.46, "S"), ("Paranaguá", "PR", -25.52, -48.51, "L"),
    ("Passo Fundo", "RS", -28.26, -52.41, "M"), ("Cruz Alta", "RS", -28.64, -53.61, "S"), ("Ijuí", "RS", -28.39, -53.91, "S"), ("Rio Grande", "RS", -32.03, -52.10, "L"),
    ("Santos", "SP", -23.96, -46.33, "L"), ("Balsas", "MA", -7.53, -46.04, "M"), ("Imperatriz", "MA", -5.53, -47.47, "S"),
    ("Barcarena", "PA", -1.51, -48.62, "L"), ("Santarém", "PA", -2.44, -54.71, "M"), ("Porto Velho", "RO", -8.76, -63.90, "M"), ("Palmas", "TO", -10.18, -48.33, "S"),
    ("Petrolina", "PE", -9.39, -40.50, "S"),
]
SCEN = {
    "Sorriso": {"circuits_down": 47, "incident": "INC-DEMO-2107"},
    "Balsas": {"router_down": 132, "incident": "INC-DEMO-2093"},
    "Rio Grande": {"switch_down": 18, "incident": "INC-DEMO-2111"},
    "Rondonópolis": {"circuit_degraded": {"latencyMs": 112, "lossPct": 7.4, "jitterMs": 38}, "app": {"p90Ms": 3100, "errPct": 1.2}},
    "Cascavel": {"wan_saturated": 97.6, "app": {"p90Ms": 4600, "errPct": 2.8}},
    "Luís Eduardo Magalhães": {"ap_down": 65, "incident": "INC-DEMO-2102"},
    "Uberlândia": {"cpu": 88},
    "Porto Velho": {"satellite": True},
    "Dourados": {"router_blind": True},
    "Barcarena": {"optic_warning": True},
    "Paranaguá": {"backup_down": 260, "incident": "INC-DEMO-2076"},
}

def site_code(city, used):
    words = [w for w in unicodedata.normalize("NFKD", city).encode("ascii", "ignore").decode().upper().split() if len(w) > 2]
    base = (words[0][0] + words[-1][:2]) if len(words) > 1 else words[0][:3]
    n = 1
    while f"{base}{n}" in used: n += 1
    used.add(f"{base}{n}")
    return f"{base}{n}"

def series(base, jitter, n=25):
    return [round(max(0, base + rnd.uniform(-jitter, jitter)), 1) for _ in range(n)]

def iface(name, speed, util_pct, uplink, oper="up(1)", admin="up(1)"):
    bps = speed * 1e6 * util_pct / 100
    inn = [round(bps * rnd.uniform(0.55, 0.97)) for _ in range(24)]
    out = [round(bps * rnd.uniform(0.25, 0.6)) for _ in range(24)]
    if util_pct: inn[rnd.randrange(12, 24)] = round(bps)
    util = round(max(inn + out) / (speed * 1e6) * 100, 1)
    flag = "saturated" if util >= T["util_crit"] else "high" if util >= T["util_warn"] else None
    return {"name": name, "speed": speed, "oper": oper, "admin": admin, "type": "ethernetCsmacd(6)", "util": util,
            "in": inn, "out": out, "errors": 0, "discards": 0, "crc": 0, "uplink": uplink, "flag": flag}

def ev(minutes, level, mnemonic, sev, text):
    return {"t": ago(minutes), "kind": "syslog", "level": level, "mnemonic": mnemonic, "sev": sev, "text": text}

devices, traps = {}, []

def add_device(name, site, role, ip, model, ifs, cpu=12.0, vendor="cisco", mode="Extension", rtt=1.0, loss=0.0,
               down_min=None, suppressed_by=None, incident=None, loss_cause=None, events=None, location=""):
    d = {"id": "DEMO-" + name, "name": name, "site": site, "role": role, "vendor": vendor, "ip": ip, "mode": mode,
         "desc": f"{model} · simulated device", "location": location, "chassis": None, "ifCount": len(ifs),
         "cpu": [], "cpuNow": None, "availPct": None, "availTs": None,
         "syslog": {"ERROR": rnd.randint(0, 6), "WARN": rnd.randint(2, 15), "INFO": rnd.randint(40, 160)},
         "syslogErrTs": [rnd.randint(0, 1) for _ in range(24)], "traps": 0, "events": events or [],
         "interfaces": ifs if mode == "Extension" else [], "reasons": [], "icmp": None}
    offline_min = down_min
    if mode == "Extension":
        s = series(cpu, 2.5); s[-1] = cpu
        avail = [1] * 24
        if offline_min:
            k = max(1, math.ceil(offline_min / 60)); avail[-k:] = [0] * k
            s = s[:-max(1, offline_min // 5)]
        d.update(cpu=s, cpuNow=None if offline_min else cpu, availTs=avail, availPct=round(100 * sum(avail) / 24, 2))
    rtts = [round(max(0.2, (rtt or 1) * rnd.uniform(0.9, 1.12)), 1) for _ in range(24)]
    d["icmp"] = {"rttMs": None if offline_min else rtt, "rtt": rtts[:-1] if offline_min else rtts,
                 "loss": round(100 * min(offline_min, 1440) / 1440, 2) if offline_min else loss, "sent": 1440}
    if offline_min:
        d["unreachableSince"] = ago(offline_min)
        d["syslogErrTs"][-math.ceil(offline_min / 60):] = [0] * math.ceil(offline_min / 60)
    if suppressed_by: d["suppressedBy"] = suppressed_by
    if incident: d["incident"] = incident
    if loss_cause: d["lossCause"] = loss_cause
    devices[name] = d
    return d

# ---------- data center ----------
used = {"SPO1"}
dx, dy = proj(DC["lat"], DC["lon"])
sites = {"SPO1": {"code": "SPO1", "name": "Data Center São Paulo", "city": "São Paulo", "uf": "SP", "id": DC["id"], "dc": True, "x": dx, "y": dy, "lat": DC["lat"], "lon": DC["lon"]}}
dc_events = {"CON1": [ev(9, "INFO", "%SYS-5-CONFIG_I", 5, "Configured from console by netops on vty0")]}
DCP = "BR-SP-SPO1"
dc_specs = [
    ("CON1", "core", "Cisco ASR 1002-HX", 52.0), ("CON2", "core", "Cisco ASR 1002-HX", 41.0), ("COR1", "core", "Cisco Nexus 9336C", 23.0),
    ("FWL1", "firewall", "Palo Alto PA-5220", 34.0), ("FWL2", "firewall", "Palo Alto PA-5220", 31.0), ("LBL1", "lb", "F5 BIG-IP i5800", 18.0),
    ("SWT1", "switch", "Cisco Nexus 93180YC", 9.0), ("SWT2", "switch", "Cisco Nexus 93180YC", 8.0),
]

# ---------- branches ----------
circuits_all, apps = [], {}
branch_meta = []
for i, (city, uf, lat, lon, size) in enumerate(BRANCHES):
    sc = SCEN.get(city, {})
    code = site_code(city, used)
    x, y = proj(lat, lon)
    sites[code] = {"code": code, "name": city, "city": city, "uf": uf, "id": str(2100 + i * 7), "dc": False, "x": x, "y": y, "lat": lat, "lon": lon}
    P = f"BR-{uf}-{code}"
    net = f"10.{20 + i}.0"
    dist = km(lat, lon, DC["lat"], DC["lon"])
    base_lat = round(6 + dist * 0.011 + rnd.uniform(0, 4), 1)
    wan = {"L": 100, "M": 50, "S": 20}[size]

    circ = []
    if sc.get("satellite"):
        wan = 10
        circ.append({"kind": "primary", "carrier": "Carrier C", "tech": "Satellite VSAT 10 Mbps", "slaMs": 700,
                     "latencyMs": round(610 + rnd.uniform(0, 40)), "lossPct": 0.8, "jitterMs": 42.0, "status": "up"})
    else:
        circ.append({"kind": "primary", "carrier": "Carrier A", "tech": f"MPLS {wan} Mbps", "slaMs": 80,
                     "latencyMs": base_lat, "lossPct": round(rnd.uniform(0, 0.3), 2), "jitterMs": round(rnd.uniform(0.8, 4), 1), "status": "up"})
        if size != "S":
            circ.append({"kind": "backup", "carrier": "Carrier B", "tech": "Internet 20 Mbps · VPN", "slaMs": 150,
                         "latencyMs": round(base_lat * 1.4 + 12, 1), "lossPct": round(rnd.uniform(0, 0.6), 2), "jitterMs": round(rnd.uniform(3, 9), 1), "status": "up"})
    for c in circ:
        c.update(site=code, siteName=city, id=f"{code}-{c['kind']}")
    if "circuits_down" in sc:
        for c in circ:
            c.update(status="down", latencyMs=None, lossPct=100, jitterMs=None, since=ago(sc["circuits_down"]))
        circ[0]["incident"] = sc["incident"]
    if "backup_down" in sc:
        b = next(c for c in circ if c["kind"] == "backup")
        b.update(status="down", latencyMs=None, lossPct=100, jitterMs=None, since=ago(sc["backup_down"]), incident=sc["incident"])
    if "circuit_degraded" in sc:
        circ[0].update(sc["circuit_degraded"])
    if "router_down" in sc:
        for c in circ:
            c.update(latencyMs=None, lossPct=None, jitterMs=None, note="not measured: the branch router is not responding")
    circuits_all += circ

    all_links_down = "circuits_down" in sc
    router_down = "router_down" in sc
    switch_down = "switch_down" in sc
    offline_min = sc.get("circuits_down") or sc.get("router_down")
    root = "Links WAN" if all_links_down else f"{P}-RTR1" if router_down else None
    active = next((c for c in circ if c["status"] == "up" and c.get("latencyMs") is not None), None)
    lat_ms = active["latencyMs"] if active else None
    loss = circ[0]["lossPct"] if circ[0].get("lossPct") not in (None, 100) else 0.0
    loss_cause = "Links WAN" if loss >= T["icmp_loss_warn"] else None
    loc = f"{city} · {uf}"

    # router
    rtr_ifs = [iface("Gi0/0/0", wan, sc.get("wan_saturated", round(rnd.uniform(28, 62), 1)), True,
                     oper="down(2)" if all_links_down else "up(1)")]
    if any(c["kind"] == "backup" for c in circ):
        rtr_ifs.append(iface("Gi0/0/1", 20, round(rnd.uniform(1, 4), 1), True,
                             oper="down(2)" if ("backup_down" in sc or all_links_down) else "up(1)"))
    rtr_ifs.append(iface("Gi0/1/0", 1000, round(rnd.uniform(2, 8), 1), False))
    rtr_ev = [ev(rnd.randint(30, 170), "INFO", "%SYS-5-CONFIG_I", 5, "Configured from console by netops on vty0")]
    if router_down:
        rtr_ev.insert(0, ev(sc["router_down"] + 1, "ERROR", "%PLATFORM-2-PS_FAIL", 2, "Power supply 0 failed: input voltage lost"))
    if "backup_down" in sc:
        rtr_ev.insert(0, ev(sc["backup_down"], "ERROR", "%LINK-3-UPDOWN", 3, "Interface GigabitEthernet0/0/1, changed state to down"))
    if sc.get("wan_saturated"):
        rtr_ev.insert(0, ev(12, "WARN", "%QOS-4-POLICER_DROP", 4, "Gi0/0/0 output policer dropping packets in class BULK"))
    add_device(f"{P}-RTR1", code, "edge", f"{net}.1", "Cisco ISR 4331", rtr_ifs, cpu=float(sc.get("cpu", round(rnd.uniform(8, 35)))),
               mode="Discovery" if sc.get("router_blind") else "Extension", rtt=lat_ms, loss=loss,
               down_min=offline_min, suppressed_by="Links WAN" if all_links_down else None,
               incident=sc["incident"] if router_down else None, loss_cause=loss_cause, events=rtr_ev, location=loc)

    # switch
    ports = {"L": 24, "M": 16, "S": 8}[size]
    sw_ifs = [iface("Te1/1/1", 10000, round(rnd.uniform(1, 5), 1), True)] + \
             [iface(f"Gi1/0/{p}", 1000, round(rnd.uniform(0, 12), 1), False, oper="down(2)" if rnd.random() < 0.25 else "up(1)") for p in range(1, ports + 1)]
    sw_ev = []
    if sc.get("optic_warning"):
        sw_ev.append(ev(21, "ERROR", "%SFF8472-3-THRESHOLD_VIOLATION", 3, "Te1/1/1: Rx power low warning; Operating value: -17.8 dBm, Threshold value: -16.0 dBm"))
    add_device(f"{P}-SWT1", code, "switch", f"{net}.2", "Cisco Catalyst 9200L", sw_ifs, cpu=float(round(rnd.uniform(4, 18))), rtt=lat_ms, loss=loss,
               down_min=offline_min or sc.get("switch_down"), suppressed_by=root,
               incident=sc["incident"] if switch_down else None, loss_cause=loss_cause, events=sw_ev, location=loc)

    # access points
    for a in range(1, {"L": 3, "M": 2, "S": 1}[size] + 1):
        ap_down = sc.get("ap_down") if a == 2 else None
        add_device(f"{P}-APW{a}", code, "ap", f"{net}.{10 + a}", "Cisco Catalyst 9120AX", [iface("Gi0", 1000, round(rnd.uniform(1, 9), 1), False)],
                   cpu=float(round(rnd.uniform(3, 12))), rtt=lat_ms, loss=loss,
                   down_min=offline_min or sc.get("switch_down") or ap_down,
                   suppressed_by=root or (f"{P}-SWT1" if switch_down else None),
                   incident=sc["incident"] if ap_down else None, loss_cause=loss_cause, location=loc)
    # branch firewall on large sites
    if size == "L":
        add_device(f"{P}-FWL1", code, "firewall", f"{net}.3", "Fortinet FortiGate 100F", [iface("port1", 1000, round(rnd.uniform(10, 30), 1), True)],
                   vendor="fortinet", cpu=float(round(rnd.uniform(10, 30))), rtt=lat_ms, loss=loss, down_min=offline_min, suppressed_by=root,
                   loss_cause=loss_cause, location=loc)

    if all_links_down or router_down:
        dc_events["CON1"].insert(0, ev(offline_min, "WARN", "%BGP-5-ADJCHANGE", 5, f"neighbor {net}.1 Down BGP Notification sent (hold time expired) · {code}"))
        traps.append({"t": ago(offline_min), "ip": "10.0.0.11", "device": f"{DCP}-CON1", "oid": "IF-MIB::linkDown"})

    # application as seen from the branch
    sessions = {"L": rnd.randint(180, 260), "M": rnd.randint(70, 140), "S": rnd.randint(20, 50)}[size]
    p90 = sc.get("app", {}).get("p90Ms", 1850 if sc.get("satellite") else rnd.randint(850, 1450))
    err = sc.get("app", {}).get("errPct", round(rnd.uniform(0.1, 0.7), 2))
    offline = all_links_down or router_down or switch_down
    tx = []
    for tname, mult, share in [("Login SAP GUI", 0.6, 0.9), ("Consulta de estoque · MMBE", 0.9, 2.2), ("Pedido de compra · ME21N", 1.2, 0.8), ("Faturamento · VF01", 1.0, 0.5)]:
        hist = [round(p90 * mult * rnd.uniform(0.85, 1.08)) for _ in range(24)]
        if sc.get("app"): hist[-3:] = [round(p90 * mult)] * 3
        tx.append({"name": tname, "p90Ms": None if offline else round(p90 * mult), "errPct": None if offline else round(err * rnd.uniform(0.6, 1.4), 2),
                   "count": 0 if offline else round(sessions * share), "p90Ts": hist[:-1] if offline else hist})
    apps[code] = {"name": "SAP ERP", "sessions": 0 if offline else sessions, "p90Ms": None if offline else p90,
                  "errPct": None if offline else err, "consequenceOf": (root or f"{P}-SWT1") if offline else None, "transactions": tx}
    branch_meta.append((code, city, uf, size, circ))

for key, role, model, cpu in dc_specs:
    ifs = [iface("Hu1/0/1", 100000, round(rnd.uniform(5, 30), 1), True), iface("Hu1/0/2", 100000, round(rnd.uniform(5, 30), 1), True)]
    add_device(f"{DCP}-{key}", "SPO1", role, f"10.0.0.{11 + len([d for d in devices if d.startswith(DCP)])}", model, ifs, cpu=cpu,
               vendor="paloalto" if role == "firewall" else "f5" if role == "lb" else "cisco", rtt=0.4, events=dc_events.get(key), location="São Paulo · SP")

# ---------- verdicts (verdict.py) ----------
for d in devices.values():
    d["events"].sort(key=lambda e: e["t"], reverse=True)
    d["traps"] = sum(1 for t in traps if t["device"] == d["name"])
    d["verdict"], d["reasons"], d["impact"] = device_verdict(d)

# ---------- end-to-end paths (e2e.py) ----------
paths = []
for code, city, uf, size, circ in branch_meta:
    has_fw = any(d["site"] == code and d["role"] == "firewall" for d in devices.values())
    ch = circuit_hop(circ)
    ah = app_hop("SAP ERP", "SPO1", apps[code])
    prim = circ[0]
    hops = [
        device_hop(devices, "Access", "Switching and Wi-Fi", code, ["switch", "ap"]),
        device_hop(devices, "Edge", "Router and firewall" if has_fw else "Branch router", code, ["edge", "firewall"]),
        ch,
        device_hop(devices, "Data center", "Concentrator and core", "SPO1", ["core"]),
        device_hop(devices, "Security", "Firewall and LB", "SPO1", ["firewall", "lb"]),
        ah,
    ]
    tunnel_up = any(c["status"] == "up" and c.get("latencyMs") is not None for c in circ)
    links = [
        {"kind": "lan", "verdict": "Not monitored", "label": "LAN", "facts": []},
        {"kind": "wan", "verdict": ch["verdict"], "label": "Access", "facts": [prim["tech"].split(" ")[0]]},
        {"kind": "wan", "verdict": "Healthy" if tunnel_up else "Critical", "label": "Tunnel", "facts": ["BGP " + ("established" if tunnel_up else "down")]},
        {"kind": "lan", "verdict": "Not monitored", "label": "LAN", "facts": []},
        {"kind": "flow", "verdict": ah["verdict"], "label": "Sessions", "facts": [f"{apps[code]['sessions']}/h"]},
    ]
    paths.append(make_path(f"site-{code}", f"Branch {city} ({code}) → SAP at Data Center São Paulo", hops, links, site=code))

site_verdicts = {p["site"]: p["summary"]["verdict"] for p in paths}
site_verdicts["SPO1"] = worst([d["verdict"] for d in devices.values() if d["site"] == "SPO1"])
for p in paths:
    sites[p["site"]]["wanVerdict"] = next(h["verdict"] for h in p["hops"] if h["kind"] == "circuit")
paths.sort(key=lambda p: (ORDER[p["summary"]["verdict"]], p["name"]))

data = {
    "demo": True,
    "meta": {"tenant": "exemplo", "generatedAt": real_meta["generatedAt"], "thresholds": T, "neighborDupes": 0,
             "windows": real_meta["windows"]},
    "sites": sites, "siteVerdicts": site_verdicts, "map": {"viewBox": geo["viewBox"], "path": geo["path"]},
    "devices": sorted(devices.values(), key=lambda d: (ORDER[d["verdict"]], -d.get("impact", 0), d["name"])),
    "circuits": circuits_all, "links": [], "peers": [], "icmp": [], "problems": [], "traps": traps,
    "flows": {"exporters": [], "top": [], "quality": {}}, "oneagent": [],
    "tagPreview": [{"name": d["name"], "site": d["site"], "role": d["role"], "mode": d["mode"]} for d in sorted(devices.values(), key=lambda d: d["name"])],
    "e2e": {"probe": "Data Center São Paulo (simulated)", "paths": paths},
}
OUT.write_text("window.NET_DEMO = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
print("wrote", OUT, OUT.stat().st_size, "bytes ·", len(sites), "sites ·", len(devices), "devices ·", len(circuits_all), "circuits")
import collections
print("devices", collections.Counter(d["verdict"] for d in devices.values()))
print("sites", collections.Counter(site_verdicts.values()))
for p in paths:
    s = p["summary"]
    if s["verdict"] != "Healthy":
        root = p["hops"][s["firstBad"]] if s["firstBad"] is not None else None
        print(f"  {s['verdict']:<9} {p['name'][:48]:<48} causa: {root['title'] if root else '-'} · {(root or {}).get('topReason') or ''} · consequências {s['consequenceHops']}")
