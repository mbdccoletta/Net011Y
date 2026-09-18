#!/usr/bin/env python3
"""Turn raw dtctl exports from guu84124 into prototype/data.js.

Every verdict is decided here (one place), so every screen of the prototype
agrees: Critical / Warning / Healthy / Not monitored.
"""
import os
import json, re, collections, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "prototype" / "data.js"

def L(name):
    d = json.load(open(RAW / f"{name}.json"))
    return d["records"] if isinstance(d, dict) and "records" in d else []

# ---------- the single verdict definition and E2E aggregation live in shared modules ----------
from verdict import T, ORDER, worst, device_verdict
from e2e import device_hop as _device_hop, make_path

def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def clean(arr):
    return [v for v in (arr or []) if v is not None]

# ---------- tags derived from the naming convention (proposed rule) ----------
ROLE_RULES = [
    (r"core-router", "core"), (r"edge-router", "edge"), (r"firewall|asa|fortigate|paloalto", "firewall"),
    (r"wlc", "wlc"), (r"-ap-|aironet|aruba-ap", "ap"), (r"big-ip", "lb"),
    (r"switch|nexus", "switch"), (r"ucs", "compute"),
    (r"storage|printer|phone|windows|window-", "endpoint"),
]
def derive_tags(name):
    n = name.lower()
    site = "LON" if n.startswith("lon") else "NYC" if n.startswith("nyc") else "—"
    role = next((r for p, r in ROLE_RULES if re.search(p, n)), "other")
    return site, role

SITE_NAMES = {"LON": "London Data Center", "NYC": "New York Data Center"}

# ---------- devices (dedupe: Extension > Discovery; Neighbor dropped) ----------
raw_dev = L("devices")
by_name = {}
neighbor_dupes = 0
for d in raw_dev:
    if d.get("monitoring_mode") == "Neighbor":
        neighbor_dupes += 1
        continue
    cur = by_name.get(d["name"])
    if cur is None or (cur.get("monitoring_mode") != "Extension" and d.get("monitoring_mode") == "Extension"):
        by_name[d["name"]] = d
id_alias = {}  # every smartscape id (incl. dupes) -> canonical name
for d in raw_dev:
    id_alias[d["id"]] = d["name"]

devices = {}
for name, d in by_name.items():
    site, role = derive_tags(name)
    devices[name] = {
        "id": d["id"], "name": name, "site": site, "role": role,
        "vendor": d.get("device_type") or "generic", "ip": (d.get("ip") or [d.get("snmp.ip")])[0],
        "mode": d.get("monitoring_mode"), "desc": (d.get("description") or "")[:160],
        "location": d.get("location"), "chassis": d.get("chassis_mac"),
        "ifCount": int(num(d.get("interface_count")) or 0),
        "cpu": [], "cpuNow": None, "availPct": None,
        "syslog": {"ERROR": 0, "WARN": 0, "INFO": 0}, "syslogErrTs": [0] * 24,
        "traps": 0, "events": [], "interfaces": [], "reasons": [],
    }
ip_to_name = {d["ip"]: n for n, d in devices.items() if d["ip"]}
chassis_to_name = {d["chassis"]: n for n, d in devices.items() if d["chassis"] and d["mode"] == "Extension"}

def dev_of(sid):
    return devices.get(id_alias.get(sid))

# ---------- CPU / availability ----------
for r in L("cpu"):
    d = dev_of(r["dt.smartscape.ext_network_device"])
    if d:
        s = clean(r["cpu"]); d["cpu"] = [round(v, 1) for v in s]; d["cpuNow"] = round(s[-1], 1) if s else None
for r in L("uptime"):
    d = dev_of(r["dt.smartscape.ext_network_device"])
    if d:
        pts = r["c"][:24]
        seen = sum(1 for v in pts if v)
        d["availPct"] = round(100 * seen / max(1, len([v for v in pts if v is not None]) or 24), 2)
        d["availTs"] = [1 if v else 0 for v in pts]

# ---------- interfaces ----------
iface_nodes = {x["id"]: x for x in L("interfaces")}
errs = {}
for f in ("err_juniper", "err_cisco", "err_generic"):
    for r in L(f):
        errs[r["dt.smartscape.ext_network_interface"]] = {k: int(sum(clean(r.get(k)))) for k in ("ie", "oe", "crc", "idc", "odc") if k in r}

def is_uplink(name, speed):
    n = (name or "").lower()
    return (speed or 0) >= 10000 or bool(re.match(r"(te|xe-|et-|po|lc-|hundred|fortygig|tengig)", n))

seen_if = set()
def add_iface(dname, sid, ifname, speed, i, o):
    d = devices.get(dname)
    if not d: return
    node = iface_nodes.get(sid, {})
    seen_if.add(sid)
    i5, o5 = clean(i), clean(o)
    bps_in = [round(v * 8 / 300) for v in i5]
    bps_out = [round(v * 8 / 300) for v in o5]
    util = None
    if speed and (bps_in or bps_out):
        util = round(max(bps_in + bps_out) / (speed * 1e6) * 100, 1)
    e = errs.get(sid, {})
    oper = node.get("operational_status") or "unknown"
    admin = node.get("admin_status") or "unknown"
    flag = None
    if util is not None and util > 100: flag = "inconsistent"
    elif util is not None and util >= T["util_crit"]: flag = "saturated"
    elif util is not None and util >= T["util_warn"]: flag = "high"
    d["interfaces"].append({
        "name": ifname or node.get("name"), "speed": speed, "oper": oper, "admin": admin,
        "type": node.get("interface_type"), "util": util,
        "in": bps_in, "out": bps_out,
        "errors": e.get("ie", 0) + e.get("oe", 0), "discards": e.get("idc", 0) + e.get("odc", 0), "crc": e.get("crc", 0),
        "uplink": is_uplink(ifname, speed), "flag": flag,
    })

for r in L("tr_juniper"):
    add_iface(id_alias.get(r["dt.smartscape.ext_network_device"]), r["dt.smartscape.ext_network_interface"], r.get("if.name"), num(r.get("if.speed")), r["i"], r["o"])
for f in ("tr_cisco", "tr_generic"):
    for r in L(f):
        sp = clean(r.get("s")); add_iface(id_alias.get(r["dt.smartscape.ext_network_device"]), r["dt.smartscape.ext_network_interface"], r.get("if.name"), sp[-1] if sp else None, r["i"], r["o"])
for sid, node in iface_nodes.items():  # interfaces without traffic series
    if sid in seen_if: continue
    dname = chassis_to_name.get(node.get("device.chassis_mac"))
    if dname:
        add_iface(dname, sid, node.get("name"), num(node.get("speed")), [], [])

# ---------- syslog ----------
for r in L("syslog_sum"):
    n = ip_to_name.get(r["ip"])
    if n and r["loglevel"] in devices[n]["syslog"]:
        devices[n]["syslog"][r["loglevel"]] += int(r["n"])
for r in L("syslog_ts"):
    n = ip_to_name.get(r["ip"])
    if n: devices[n]["syslogErrTs"] = [int(v or 0) for v in r["n"][:24]]
for r in L("syslog_recent"):
    n = ip_to_name.get(r["ip"])
    if not n: continue
    app = r.get("app") or ""
    m = re.match(r"%([A-Z0-9_]+)-(\d)-([A-Z0-9_]+)", app)
    sev = int(m.group(2)) if m else None
    ev = {"t": r["timestamp"][:19] + "Z", "kind": "syslog", "level": r["loglevel"], "mnemonic": app or None, "sev": sev, "text": r["content"][:180]}
    if len(devices[n]["events"]) < 30: devices[n]["events"].append(ev)

# ---------- traps ----------
traps = []
for r in L("traps"):
    n = ip_to_name.get(r["device.address"])
    traps.append({"t": r["timestamp"][:19] + "Z", "ip": r["device.address"], "device": n, "oid": r["snmp.trap_oid"]})
    if n:
        devices[n]["traps"] += 1
        if sum(1 for e in devices[n]["events"] if e["kind"] == "trap") < 5:
            devices[n]["events"].append({"t": r["timestamp"][:19] + "Z", "kind": "trap", "level": "INFO", "mnemonic": r["snmp.trap_oid"], "sev": None, "text": r["content"].replace("\n", " ")[:160]})
for d in devices.values():
    d["events"].sort(key=lambda e: e["t"], reverse=True)

# ---------- links ----------
links = []
for r in L("lldp"):
    if r.get("neighbor.sys.name"):
        links.append({"a": r["sys.name"], "b": r["neighbor.sys.name"], "kind": "LLDP", "label": f"porta remota {r.get('neighbor.port.id')}"})
bgp = {}
for r in L("routing"):
    if r.get("cbgp.remote.identifier"):
        bgp[(r["sys.name"], r["cbgp.remote.identifier"])] = r
peers = []
for (sysname, rid), r in bgp.items():
    peers.append({"device": sysname, "proto": "BGP", "peer": rid, "remoteAs": r.get("cbgp.remote.as"), "state": r.get("cbgp.peer.state")})
for r in L("routing"):
    if "ospf" in r.get("metric.key", ""):
        peers.append({"device": r.get("sys.name"), "proto": "OSPF", "peer": r.get("ospf.nbr.ip.addr") or r.get("ospf.nbr.rtr.id") or "vizinho", "remoteAs": None, "state": r.get("ospf.nbr.state")})

# ---------- ICMP synthetic + Davis ----------
icmp = []
for r in L("synth"):
    sent, recv = sum(clean(r["loss_sent"])), sum(clean(r["loss_recv"]))
    rtt = clean(r["rtt"]); av = clean(r["av"])
    loss = round(100 * (1 - recv / sent), 1) if sent else None
    icmp.append({"name": r["dt.synthetic.monitor.name"], "rttMs": round(rtt[-1], 2) if rtt else None,
                 "rtt": [round(v, 2) for v in rtt], "availability": av[-1] if av else None, "loss": loss,
                 "verdict": "Critical" if (loss or 0) >= T["icmp_loss_crit"] or (av and av[-1] < 100) else "Healthy"})
problems = []
for r in L("problems"):
    nm = r["event.name"]
    if "Network availability" in nm or "Palo" in nm:
        problems.append({"id": r["display_id"], "name": nm, "status": r["event.status"], "category": r["event.category"], "start": r["event.start"][:19] + "Z"})

# ---------- ICMP reachability per device (synthetic network availability) ----------
loc_names = {x["id"]: x["name"] for x in L("synth_locations")}
probe_locs = set()
icmp_by_ip = {}
for r in L("icmp_targets"):
    if "Network coverage" not in r["dt.synthetic.monitor.name"]:
        continue
    rtt = clean(r["rtt"]); sent = sum(clean(r["sent"])); recv = sum(clean(r["recv"]))
    icmp_by_ip[r["request.target_address"]] = {
        "rttMs": round(rtt[-1], 2) if rtt else None, "rtt": [round(v, 3) for v in rtt],
        "loss": round(100 * (1 - recv / sent), 2) if sent else None, "sent": int(sent)}
    probe_locs.add(loc_names.get(r["dt.smartscape.synthetic_location"], "localização privada"))
for d in devices.values():
    d["icmp"] = icmp_by_ip.get(d["ip"])

# ---------- verdicts (rules live in verdict.py) ----------
for d in devices.values():
    d["verdict"], d["reasons"], d["impact"] = device_verdict(d)

# ---------- flows ----------
flow_exporters = []
fts = {r["exp"]: r for r in L("flow_ts")}
proto = collections.defaultdict(list)
for r in L("flow_proto"):
    proto[r["exp"]].append({"proto": r["proto"], "gb": round(r["gb"]), "flows": int(r["flows"])})
for exp, r in fts.items():
    flow_exporters.append({"ip": exp, "device": ip_to_name.get(exp), "flows5m": [int(v or 0) for v in clean(r["flows"])],
                           "protocols": sorted(proto.get(exp, []), key=lambda x: -x["flows"])[:8]})
top_conv = [{"exp": r["exp"], "device": ip_to_name.get(r["exp"]), "src": r["src"], "dst": r["dst"], "proto": r["proto"], "dport": r["dport"], "gb": round(r["gb"], 1), "flows": int(r["flows"])} for r in L("flow_top")[:25]]

oa = []
for r in L("oa_flows"):
    rtt = r.get("rtt")
    oa.append({"host": r["host"], "cluster": r.get("cluster"), "ns": r.get("ns"), "proc": r["proc"], "dst": r["dst"], "dport": r["dport"],
               "cc": r.get("cc"), "bytes": r["bytes"], "tx": r["tx"], "rx": r["rx"],
               "rttMs": round(rtt / 1000, 1) if rtt else None, "retr": r["retr"], "resets": r["resets"]})

# ---------- end-to-end paths ----------
def device_hop(*args):
    return _device_hop(devices, *args)

bgp_peers = [p for p in peers if p["proto"] == "BGP"]
bgp_up = sum(1 for p in bgp_peers if (p["state"] or "").startswith("established"))
internet_hop = {"kind": "internet", "layer": "Internet", "title": f"Operadora AS {bgp_peers[0]['remoteAs'] if bgp_peers else '—'}", "site": "WAN",
                "verdict": "Healthy" if bgp_peers and bgp_up == len(bgp_peers) else "Critical" if bgp_peers else "Not monitored",
                "headline": {"value": f"{bgp_up}/{len(bgp_peers)}", "unit": "", "label": "peers BGP established"},
                "stats": {}, "peers": bgp_peers, "devices": [], "topReason": None}

oa_rows = L("oa_summary")
tot_pk = sum(r["pkts"] or 0 for r in oa_rows); tot_rt = sum(r["retr"] or 0 for r in oa_rows)
retr_pct = round(100 * tot_rt / tot_pk, 3) if tot_pk else None
clusters = [{"name": r["cluster"] or (f"hosts {r['cloud']}" if r["cloud"] else "hosts on-prem"), "cloud": r["cloud"], "conv": int(r["conv"]), "hosts": int(r["hosts"]),
             "procs": int(r["procs"]), "bytes": r["bytes"], "retrPct": round(100 * (r["retr"] or 0) / r["pkts"], 3) if r["pkts"] else None,
             "rttMs": round(r["rttAvg"] / 1000, 1) if r["rttAvg"] else None} for r in oa_rows]
cloud_hop = {"kind": "cloud", "layer": "Aplicação", "title": "Workloads com OneAgent", "site": "Nuvem",
             "verdict": "Critical" if (retr_pct or 0) >= T["retr_crit"] else "Warning" if (retr_pct or 0) >= T["retr_warn"] else "Healthy",
             "headline": {"value": retr_pct, "unit": "%", "label": "retransmissão TCP"},
             "stats": {"conv": sum(c["conv"] for c in clusters), "hosts": sum(c["hosts"] for c in clusters), "procs": sum(c["procs"] for c in clusters)},
             "clusters": clusters, "devices": [], "topReason": None}

lldp_wan = next((l for l in links if {l["a"], l["b"]} >= {"NYC-Cisco-ASR9000-Edge-Router", "LON-Juniper-MX960-Edge-Router"}), None)
ospf = next((p for p in peers if p["proto"] == "OSPF"), None)
def lan(): return {"kind": "lan", "verdict": "Not monitored", "label": "LAN do site", "facts": ["sem vizinho LLDP descoberto"]}
wan_link = {"kind": "wan", "verdict": "Healthy" if lldp_wan and ospf and (ospf["state"] or "").startswith("full") else "Warning",
            "label": "WAN", "facts": [f"LLDP {'1 enlace' if lldp_wan else 'ausente'}", f"OSPF {ospf['state'] if ospf else '—'}"]}
bgp_link = {"kind": "bgp", "verdict": internet_hop["verdict"], "label": "BGP", "facts": [f"{bgp_up}/{len(bgp_peers)} established"]}
flow_link = {"kind": "flow", "verdict": cloud_hop["verdict"], "label": "Flows", "facts": [f"{cloud_hop['stats']['conv']:,} conversas".replace(",", ".")]}

paths = [
    make_path("lon-nyc", "Filial London → Data Center New York", [
        device_hop("Acesso", "Wireless", "LON", ["ap", "wlc"]),
        device_hop("Acesso", "Switching", "LON", ["switch", "compute"]),
        device_hop("Core", "Roteador core", "LON", ["core"]),
        device_hop("Borda", "Roteador de borda", "LON", ["edge"]),
        device_hop("Borda", "Roteador de borda", "NYC", ["edge"]),
        device_hop("Core", "Roteador core", "NYC", ["core"]),
        device_hop("Segurança", "Firewall e LB", "NYC", ["firewall", "lb"]),
        device_hop("Data center", "Switching e compute", "NYC", ["switch", "compute"]),
    ], [lan(), lan(), lan(), wan_link, lan(), lan(), lan()]),
    make_path("nyc-cloud", "Usuários New York → Internet → Aplicações na nuvem", [
        device_hop("Acesso", "Wireless", "NYC", ["ap", "wlc"]),
        device_hop("Acesso", "Switching e compute", "NYC", ["switch", "compute"]),
        device_hop("Segurança", "Firewall e LB", "NYC", ["firewall", "lb"]),
        device_hop("Core", "Roteador core", "NYC", ["core"]),
        internet_hop, cloud_hop,
    ], [lan(), lan(), lan(), bgp_link, flow_link]),
]

# ---------- tag preview & sources ----------
tag_preview = [{"name": n, "site": d["site"], "role": d["role"], "mode": d["mode"]} for n, d in sorted(devices.items())]

data = {
    "meta": {"tenant": os.environ.get("DT_CONTEXT", "live"), "generatedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"),
             "windows": {"metrics": "2h @5m", "availability": "24h @1h", "syslog": "24h", "flows": "1h", "oneagent": "24h"},
             "thresholds": T, "neighborDupes": neighbor_dupes},
    "sites": {k: {"code": k, "name": v} for k, v in SITE_NAMES.items()},
    "devices": sorted(devices.values(), key=lambda d: (ORDER[d["verdict"]], -d.get("impact", 0), d["name"])),
    "links": links, "peers": peers, "icmp": icmp, "problems": problems[:12], "traps": traps[:60],
    "flows": {"exporters": flow_exporters, "top": top_conv,
              "quality": {"oldStartPct": 100, "pktGtBytesPct": 46, "unknownProtoPct": 20, "zeroPortPct": 10, "ifIndex": False, "sampling": 0}},
    "oneagent": oa, "tagPreview": tag_preview,
    "e2e": {"probe": ", ".join(sorted(probe_locs)) or "—", "paths": paths},
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text("window.NET = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
print("wrote", OUT, OUT.stat().st_size, "bytes")
print(collections.Counter(d["verdict"] for d in devices.values()))
for d in data["devices"]:
    print(f"{d['verdict']:<14} {d['name']:<34} {d['role']:<9} ifs={len(d['interfaces']):<4} cpu={d['cpuNow']} " + " | ".join(r["text"] for r in d["reasons"])[:160])
print("links", links, "peers", peers[:4])
print("icmp", [(i["name"], i["verdict"], i["loss"]) for i in icmp])
