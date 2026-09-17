"""The single verdict definition for NetworkPlane.

Every build (real GRU data and the simulated example) and therefore every
screen of the prototype judges health through these functions only.
Vocabulary: Critical / Warning / Healthy / Not monitored.
"""
# LEGACY: predates the alert-driven model. The app no longer judges health from thresholds;
# status comes from the problems and alerts Dynatrace raises. Kept only to rebuild the old prototype data.

T = {
    "cpu_crit": 85, "cpu_warn": 70,
    "util_warn": 80, "util_crit": 95,
    "avail_crit": 99.0,
    "syslog_sev_warn": 3,                         # mnemonic severity 0..3 = emergency..error
    "icmp_loss_crit": 20, "icmp_loss_warn": 2,    # % packet loss (synthetic ICMP)
    "retr_crit": 3, "retr_warn": 1,               # % TCP retransmitted packets (OneAgent flows)
    "circuit_loss_crit": 10, "circuit_loss_warn": 2,
    "sla_warn": 1.0, "sla_crit": 1.5,             # circuit latency as a multiple of its contracted SLA
    "app_p90_warn": 2000, "app_p90_crit": 4000,   # ms, application response time seen from a site
    "app_err_warn": 2, "app_err_crit": 5,         # % failed requests
}

ORDER = {"Critical": 0, "Warning": 1, "Healthy": 2, "Not monitored": 3}
ROLE_WEIGHT = {"core": 5, "edge": 5, "firewall": 4, "lb": 4, "switch": 3, "wlc": 3, "compute": 3, "ap": 2, "endpoint": 1}


def worst(verdicts):
    vs = [v for v in verdicts if v and v != "Not monitored"]
    return min(vs, key=lambda v: ORDER[v]) if vs else "Not monitored"


def _fold(reasons):
    levels = [r["level"] for r in reasons]
    v = "Critical" if "Critical" in levels else "Warning" if "Warning" in levels else "Healthy"
    return v, sorted(reasons, key=lambda r: ORDER[r["level"]])


def device_verdict(d):
    """Return (verdict, reasons, impact) for a network device."""
    if d["mode"] != "Extension":
        return "Not monitored", [{"level": "Not monitored", "text": "Discovered, but no polling extension is active"}], 0
    if d.get("suppressedBy"):
        return "Warning", [{"level": "Warning", "consequence": True,
                            "text": f"No response: consequence of {d['suppressedBy']}"}], ROLE_WEIGHT.get(d["role"], 1)
    reasons = []
    hit = lambda level, text, **kw: reasons.append(dict(level=level, text=text, **kw))

    ic = d.get("icmp") or {}
    if d.get("unreachableSince"):
        hit("Critical", f"No ICMP or SNMP response since {d['unreachableSince'][11:16]} UTC")
    elif ic.get("loss") is not None and ic["loss"] >= T["icmp_loss_warn"]:
        level = "Critical" if ic["loss"] >= T["icmp_loss_crit"] else "Warning"
        if d.get("lossCause"):
            hit("Warning", f"ICMP packet loss {ic['loss']}%: consequence of {d['lossCause']}", consequence=True)
        else:
            hit(level, f"ICMP packet loss {ic['loss']}% in 24h")
    if d["availPct"] is not None and d["availPct"] < T["avail_crit"] and not d.get("unreachableSince"):
        hit("Critical", f"SNMP availability {d['availPct']}% in 24h")
    if d["cpuNow"] is not None and d["cpuNow"] >= T["cpu_crit"]:
        hit("Critical", f"CPU {d['cpuNow']:.0f}% (limit {T['cpu_crit']}%)")
    elif d["cpuNow"] is not None and d["cpuNow"] >= T["cpu_warn"]:
        hit("Warning", f"CPU {d['cpuNow']:.0f}% (limit {T['cpu_warn']}%)")
    ifs = d["interfaces"]
    sat = [i for i in ifs if i["flag"] == "saturated"]
    high = [i for i in ifs if i["flag"] == "high"]
    inc = [i for i in ifs if i["flag"] == "inconsistent"]
    if sat: hit("Critical", f"{len(sat)} interface(s) above {T['util_crit']}% utilization")
    if high: hit("Warning", f"{len(high)} interface(s) above {T['util_warn']}%")
    if inc: hit("Warning", f"{len(inc)} interface(s) report traffic above their speed (counter or ifHighSpeed inconsistent)")
    upl_down = [i for i in ifs if i["uplink"] and i["oper"].startswith("down") and i["admin"].startswith("up")]
    if upl_down: hit("Warning", f"{len(upl_down)} uplink(s) down while admin up")
    upl_err = [i for i in ifs if i["uplink"] and (i["errors"] or i["crc"])]
    if upl_err: hit("Warning", f"{len(upl_err)} uplink(s) with interface errors")
    sev = [e for e in d["events"] if e["kind"] == "syslog" and "changed state to up" not in e["text"]
           and ((e["sev"] is not None and e["sev"] <= T["syslog_sev_warn"]) or "BREAKIN" in e["text"])]
    if sev:
        e = sev[0]
        hit("Warning", f"Syslog {e['mnemonic'] or e['level']}: {e['text'][:70]}")
    v, reasons = _fold(reasons)
    impact = ROLE_WEIGHT.get(d["role"], 1) * (3 if v == "Critical" else 1 if v == "Warning" else 0)
    return v, reasons, impact


def circuit_verdict(c):
    """Return (verdict, reasons) for a WAN circuit, judged against its own SLA."""
    reasons = []
    if c["status"] == "down":
        reasons.append({"level": "Critical" if c["kind"] == "primary" else "Warning", "text": f"down since {c['since'][11:16]} UTC"})
    elif c.get("latencyMs") is None:
        return "Not monitored", [{"level": "Not monitored", "text": c.get("note") or "not measured"}]
    else:
        loss = c.get("lossPct") or 0
        if loss >= T["circuit_loss_crit"]:
            reasons.append({"level": "Critical", "text": f"packet loss {loss}%"})
        elif loss >= T["circuit_loss_warn"]:
            reasons.append({"level": "Warning", "text": f"packet loss {loss}%"})
        ratio = c["latencyMs"] / c["slaMs"]
        if ratio >= T["sla_crit"]:
            reasons.append({"level": "Critical", "text": f"latency {c['latencyMs']} ms, SLA {c['slaMs']} ms"})
        elif ratio >= T["sla_warn"]:
            reasons.append({"level": "Warning", "text": f"latency {c['latencyMs']} ms above the {c['slaMs']} ms SLA"})
    return _fold(reasons)


def app_verdict(a):
    """Return (verdict, reasons) for an application as experienced from one site."""
    reasons = []
    if not a.get("sessions"):
        if a.get("consequenceOf"):
            reasons.append({"level": "Warning", "consequence": True, "text": f"no sessions from the site: consequence of {a['consequenceOf']}"})
        else:
            reasons.append({"level": "Critical", "text": "no sessions from the site in the last hour"})
    else:
        p90, err = a.get("p90Ms") or 0, a.get("errPct") or 0
        if p90 >= T["app_p90_crit"]:
            reasons.append({"level": "Critical", "text": f"p90 {p90 / 1000:.1f} s (limit {T['app_p90_crit'] / 1000:.0f} s)"})
        elif p90 >= T["app_p90_warn"]:
            reasons.append({"level": "Warning", "text": f"p90 {p90 / 1000:.1f} s (limit {T['app_p90_warn'] / 1000:.0f} s)"})
        if err >= T["app_err_crit"]:
            reasons.append({"level": "Critical", "text": f"{err}% errors"})
        elif err >= T["app_err_warn"]:
            reasons.append({"level": "Warning", "text": f"{err}% errors"})
    return _fold(reasons)
