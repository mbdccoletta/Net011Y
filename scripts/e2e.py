"""End-to-end path aggregation shared by the real (GRU) and simulated builds.

A path is an ordered list of hops (devices, WAN circuits, internet, application)
joined by links. Hop verdicts come from verdict.py; a hop whose only reasons are
consequences of an upstream outage is never reported as the probable cause.
"""
from verdict import T, ORDER, worst, circuit_verdict, app_verdict


def _root_first(reasons):
    return sorted(reasons, key=lambda r: (bool(r.get("consequence")), ORDER[r["level"]]))


def device_hop(devices, layer, title, site, roles):
    ds = [d for d in devices.values() if d["site"] == site and d["role"] in roles]
    mon = [d for d in ds if d["mode"] == "Extension"]
    icmps = [d["icmp"] for d in ds if d.get("icmp")]
    upl = [i for d in mon for i in d["interfaces"] if i["uplink"]]
    utils = [i["util"] for i in upl if i["util"] is not None and i["flag"] != "inconsistent"]
    cpus = [d["cpuNow"] for d in mon if d["cpuNow"] is not None]
    reasons = _root_first([dict(r, device=d["name"]) for d in mon for r in d["reasons"]])
    st = {
        "rttMax": max([i["rttMs"] for i in icmps if i["rttMs"] is not None], default=None),
        "lossMax": max([i["loss"] for i in icmps if i["loss"] is not None], default=None),
        "cpuMax": max(cpus, default=None), "utilMax": max(utils, default=None),
        "uplErr": sum(1 for i in upl if i["errors"] or i["crc"]),
        "uplDown": sum(1 for i in upl if i["oper"].startswith("down") and i["admin"].startswith("up")),
        "availMin": min([d["availPct"] for d in mon if d["availPct"] is not None], default=None),
        "monitored": len(mon), "total": len(ds), "blind": [d["name"] for d in ds if d["mode"] != "Extension"],
        "unreachable": sum(1 for d in ds if d.get("unreachableSince")),
        "critEvents": sum(1 for d in ds for e in d["events"] if e["kind"] == "syslog" and e["sev"] is not None and e["sev"] <= T["syslog_sev_warn"]),
    }
    top = reasons[0] if reasons else None
    txt = (top or {}).get("text", "")
    if top and txt.startswith(("No response", "No ICMP")):
        head = {"value": st["unreachable"], "unit": "", "label": "no response"}
    elif top and txt.startswith("CPU"):
        head = {"value": f"{st['cpuMax']:.0f}", "unit": "%", "label": "max CPU"}
    elif top and txt.startswith("ICMP packet loss"):
        head = {"value": st["lossMax"], "unit": "%", "label": "ICMP loss"}
    elif top and "utilization" in txt:
        head = {"value": st["utilMax"], "unit": "%", "label": "max uplink"}
    elif top and "down while admin up" in txt:
        head = {"value": st["uplDown"], "unit": "", "label": "uplinks down"}
    elif top and "interface errors" in txt:
        head = {"value": st["uplErr"], "unit": "", "label": "uplinks with errors"}
    elif top and txt.startswith("Syslog"):
        head = {"value": st["critEvents"], "unit": "", "label": "syslog severity ≤ 3"}
    elif st["rttMax"] is not None:
        head = {"value": st["rttMax"], "unit": "ms", "label": "max ICMP RTT"}
    else:
        head = {"value": "—", "unit": "", "label": "no visibility"}
    return {"kind": "devices", "layer": layer, "title": title, "site": site, "verdict": worst([d["verdict"] for d in ds]),
            "headline": head, "stats": st, "devices": [d["name"] for d in sorted(ds, key=lambda d: ORDER[d["verdict"]])],
            "topReason": (f"{top['device']}: {top['text']}" if top else None),
            "consequenceOnly": bool(reasons) and all(r.get("consequence") for r in reasons),
            "incidents": [d["incident"] for d in ds if d.get("incident")]}


def circuit_hop(circuits, site="WAN"):
    for c in circuits:
        c["verdict"], c["reasons"] = circuit_verdict(c)
    up = [c for c in circuits if c["status"] == "up"]
    reasons = _root_first([dict(r, circuit=c["id"]) for c in circuits for r in c["reasons"] if r["level"] != "Not monitored"])
    v = worst([c["verdict"] for c in circuits])
    measured_up = [c for c in up if c.get("latencyMs") is not None]
    primary_down = next((c for c in circuits if c["kind"] == "primary" and c["status"] == "down"), None)
    if v == "Critical" and primary_down and measured_up:
        v = "Warning"
        reasons.insert(0, {"level": "Warning", "circuit": measured_up[0]["id"],
                           "text": f"running on backup; primary down since {primary_down['since'][11:16]} UTC"})
    by_id = {c["id"]: c for c in circuits}
    lat = [c["latencyMs"] for c in measured_up]
    st = {"rttMax": max(lat, default=None),
          "lossMax": max([c["lossPct"] for c in circuits if c.get("lossPct") is not None], default=None),
          "jitterMax": max([c["jitterMs"] for c in measured_up if c.get("jitterMs") is not None], default=None),
          "up": len(up), "links": len(circuits), "availMin": None, "blind": [], "critEvents": 0, "total": 0}
    top = reasons[0] if reasons else None
    txt = (top or {}).get("text", "")
    if not measured_up and not up:
        head = {"value": f"0/{len(circuits)}", "unit": "", "label": "active links"}
    elif not measured_up:
        head = {"value": "—", "unit": "", "label": "not measured"}
    elif top and ("down since" in txt or "backup" in txt):
        head = {"value": f"{len(up)}/{len(circuits)}", "unit": "", "label": "active links"}
    elif top and txt.startswith("packet loss"):
        head = {"value": st["lossMax"], "unit": "%", "label": "link loss"}
    else:
        active = next((c for c in measured_up if c["kind"] == "primary"), measured_up[0])
        head = {"value": active["latencyMs"], "unit": "ms", "label": f"latency · SLA {active['slaMs']} ms"}
    def name(cid):
        c = by_id[cid]
        return f"{'Primary link' if c['kind'] == 'primary' else 'Backup link'} ({c['carrier']} · {c['tech']})"
    lat_levels = [r["level"] for r in reasons if "latency" in r["text"]]
    return {"kind": "circuit", "layer": "Carrier", "title": "WAN links", "site": site, "verdict": v, "headline": head, "stats": st,
            "circuits": circuits, "devices": [], "topReason": (f"{name(top['circuit'])}: {txt}" if top else None),
            "consequenceOnly": False, "incidents": [c["incident"] for c in circuits if c.get("incident")],
            "latVerdict": worst(lat_levels) if lat_levels else "Healthy"}


def app_hop(title, site, app):
    v, reasons = app_verdict(app)
    p90 = app.get("p90Ms")
    head = ({"value": round(p90 / 1000, 1), "unit": "s", "label": "p90 from the site"} if p90 is not None
            else {"value": "—", "unit": "", "label": "no sessions from the site"})
    st = {"p90Ms": p90, "errPct": app.get("errPct"), "sessions": app.get("sessions"),
          "rttMax": None, "lossMax": None, "availMin": None, "blind": [], "critEvents": 0, "total": 0}
    return {"kind": "app", "layer": "Application", "title": title, "site": site, "verdict": v, "headline": head, "stats": st,
            "app": app, "devices": [], "topReason": reasons[0]["text"] if reasons else None,
            "consequenceOnly": bool(reasons) and all(r.get("consequence") for r in reasons), "incidents": []}


def make_path(pid, name, hops, plinks, site=None):
    bad = [i for i, h in enumerate(hops) if h["verdict"] in ("Critical", "Warning")]
    root = next((i for i in bad if not hops[i].get("consequenceOnly")), bad[0] if bad else None)
    stats = [h.get("stats") or {} for h in hops]
    circuits = [h for h in hops if h["kind"] == "circuit"]
    return {"id": pid, "name": name, "site": site, "hops": hops, "links": plinks, "summary": {
        "verdict": worst([h["verdict"] for h in hops] + [l["verdict"] for l in plinks]),
        "firstBad": root, "consequenceHops": sum(1 for i in bad if hops[i].get("consequenceOnly")),
        "hops": len(hops), "healthyHops": sum(1 for h in hops if h["verdict"] == "Healthy"),
        "rttMax": max([s["rttMax"] for s in stats if s.get("rttMax") is not None], default=None),
        "lossMax": max([s["lossMax"] for s in stats if s.get("lossMax") is not None], default=None),
        "availMin": min([s["availMin"] for s in stats if s.get("availMin") is not None], default=None),
        "blind": [b for s in stats for b in s.get("blind", [])],
        "critEvents": sum(s.get("critEvents", 0) for s in stats),
        "devices": sum(s.get("total", 0) for s in stats),
        "incident": next((x for h in hops for x in h.get("incidents", [])), None),
        "latVerdict": worst([h["latVerdict"] for h in circuits]) if circuits else "Healthy"}}
