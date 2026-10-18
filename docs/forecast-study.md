# What a network capacity forecast should actually forecast

A study, written against measurements taken on two live environments rather than on a sample
dataset. It argues that utilisation-trend forecasting — the thing this app currently does, and
the thing every capacity tool advertises — is the wrong instrument for these networks, and that
the same data already in hand supports three readings that are better.

Everything below that is stated as a number was measured. Where something is inference, it says so.

---

## 1. The problem, stated honestly

The Ahead page reads 295 subjects over a fortnight of hourly buckets, fits a least-squares line
to each, and asks when it crosses the limit its owner stated. On the customer-like environment
the answer is:

| reading | value |
|---|---|
| subjects measured | 295 |
| at or over a limit, ever, in the record | **0** |
| on course to a limit inside the horizon | **0** |
| busiest subject | ~27% of its line rate |
| flat or falling | 256 |
| stepped to a new level and held | 35 |

Dynatrace's own `GenericForecastAnalyzer`, asked the same question, produced 172 valid forecasts
out of 252 and **zero** crossings, with a median predicted utilisation at +30 days of 0.000%.

So two independent implementations of the same idea agree: there is nothing to forecast. That is
not a defect in either. It is the honest output of the method, and it means the method has almost
nothing to say about this network.

A page whose central claim is "nothing is coming" has a problem that no amount of design fixes.

---

## 2. Three measurements that change the question

Taken on `gru`, 14 days of hourly buckets, 1,000 interfaces returned, 397 publishing a line rate.
The probe is committed as `scripts/grail/burst_probe.mjs` so every figure can be re-run — which
is how two of the four findings below came to be withdrawn.

### 2.1 Retracted, then explained: the busy-hour multiple

An earlier version of this study claimed the busy hour sits **2.93×** above the mean. Both halves
of that were wrong, and chasing why turned up a defect in the app itself.

*Wrong definition.* A peak lasting one hour a day is four per cent of the hours, so a 95th
percentile over hours sits *below* it. A unit test on a series peaking at 60 every day returned
20. The busy hour of a typical day is the **median of the daily maxima**; the industry's p95 is
computed over five-minute samples for billing, a different quantity with the same name.

*Wrong data underneath, and now understood.* Re-running gave 0.77× — a typical day's peak below
the fortnight's mean, which is possible but suspicious. A sanity check found that **172 of 397
interfaces on `gru` report at least one hour above 100% of their own line rate.**

That is not a conversion error. The speed agrees between the metric dimension and the Smartscape
node, and the plausible hours convert correctly: `ge-4/3/2` at 1 Gb/s shows hours of 82%, 18%,
53% and 7% — ordinary traffic. The same interface also shows an hour of 463%, which would be 2.1
terabytes across a gigabit link in sixty minutes. **An SNMP octet counter that wrapped, or a gap
in polling that let one delta cover several intervals, arrives as a single enormous bucket.**

**This was reaching the app.** `buildRealModel` converted bytes to a percentage with no ceiling,
so an artefact hour became a utilisation no cable can carry — and under the new definition of the
busy hour, one artefact a day is enough to make every daily maximum fiction. Such hours are now
dropped rather than clamped: clamping to 100 would assert saturation in an hour where nothing is
known, while a hole states what is true and every reader of the series already skips holes.

The multiple itself stays unquoted. It cannot be measured until the artefact rate is known per
environment, and on `gru` it affects 43% of the interfaces that publish a line rate.

### 2.2 The busy hour is not scattered; it has a shape

Each interface's own peak hour, by hour of day (UTC):

```
06h ███████ 12          15h ██████████████ 24
07h ████████████ 20     18h ████████████████████████████████████████ 68
10h ████████████████████████████████████ 62     19h ████████████████████████████████████ 61
12h █ 1                 21h ██ 4
                        22h ████████ 14
```

Two humps, at 10h and at 18–19h UTC, with 18h alone holding **26%** of all peaks. There is a
strong diurnal cycle, and a fortnight of hourly record is enough to see it. None of it reaches
the screen today.

### 2.3 Withdrawn: discards against utilisation

The earlier claim — 85% of discarding hours below half the line rate, at a median of 36.6% — is
withdrawn for the reason in §2.1. It is computed from the same broken conversion.

What can still be said comes from the customer-like environment, where the app's own conversion
*was* validated earlier against the published line rates: **four ports there are discarding
packets while carrying 0.0% of their rate.** One environment, four ports, and the direction of
the finding is the same — but four ports is an observation, not a distribution, and I am no
longer claiming the distribution.

### 2.4 But a discard here is a condition, not an event

This is the finding that corrected my own first reading, and it matters.

Share of its live hours in which a discarding port discards:

```
under 5% of its hours      0
5–25%                    134
25–75%                   143
75–99%                     0
99% or more                0
median: 62% of hours
```

No port discards rarely, and none discards always. The mass sits between 5% and 75%, with a
median of 62%. So these are not occasional microbursts on an otherwise healthy port — 277 ports
are dropping packets in most of their hours, at a third of their rated speed.

That is a fault class, not a capacity class. Calling it "congestion" would be the comfortable
reading and the wrong one. What can be said from the record: these ports lose traffic routinely,
and nothing about their utilisation predicts it.

---

## 3. What follows

### 3.1 Report the busy hour, and say which one it is

The reading should be taken on the busy hour of a typical day — the median of the daily maxima —
rather than on the central tendency, because that is the hour capacity is sized against. This is
implemented (`busyHour` in `model/ahead.ts`) and tested, including the case that caught the first
wrong definition.

What is **not** claimed any more is the multiple. How much higher the busy hour sits than the mean
on these estates is unknown until §2.1's conversion is fixed.

### 3.2 The limit should be the one the interface demonstrates, not the one on the box

A port that discards at a third of its line rate does not have two thirds of its capacity
available, whatever the line rate says. Where a port has both discarding and clean hours, the
utilisation at which discarding begins is a ceiling the port itself demonstrated, and it is a
better denominator than the rated speed.

**Caveat, measured:** on `gru` this is computable for fewer ports than I first assumed — 142
ports both discard and publish a line rate, but with discards in a median 62% of hours, "the
utilisation at which it starts discarding" is not well separated for most of them. This works as
a reading for the minority with a clean/dirty split, and should say so rather than invent a
ceiling for the rest.

### 3.3 The estate's dynamic is steps, so model the steps

35 of 295 subjects stepped to a new level and held; essentially none trend. A slope model fitted
to a step is wrong about both regimes, which is why this app already refits after a detected
break — the right instinct, applied to the wrong target.

The forecastable quantity here is not a slope but an **arrival rate**: this estate produces N
level changes per week, of median size X points. From that, and today's headroom distribution,
one can say how long the estate as a whole has before the first subject runs out of room, without
claiming to know which subject it will be. That is a statement the record supports and a date for
an individual port is not.

### 3.4 The honest headline

Combining 3.1 and 3.2 gives one number per subject that always exists, where "time to exhaustion"
usually does not — and it stands on its own definition rather than on the withdrawn figures:

> **busy-hour headroom** = (the ceiling it has demonstrated, else its line rate) − (its busy hour)

It is defined for every subject, it is ranked, and it degrades gracefully to the line rate when
there is no discard evidence. An estate with zero crossings still has a worst subject by this measure, and that subject
is worth a reader's attention in a way that "nothing is coming" is not.

---

## 4. What I am not claiming

- **Not the two withdrawn figures.** §2.1 and §2.3 were published in the first version of this
  document and are wrong. They are left in place, struck, rather than deleted: a study that
  quietly edits out its errors is worth less than one that shows them. Chasing the first of them
  is what found the counter-artefact defect, which was the most valuable thing here.

- **Not that bursts are proven here.** Confirming a microburst needs sub-second telemetry, which
  these environments do not collect. What is measured is that discards occur overwhelmingly at
  low hourly utilisation, which the hour average cannot explain. The burst is the standard
  explanation, not an observation.
- **Not that the demonstrated ceiling generalises.** It is computable on a minority of ports here
  (§3.2) and should be presented only where it is.
- **Not that the existing forecast is wrong.** It is correct and almost always silent. The
  argument is that it is aimed at the wrong quantity, not that it computes its quantity badly.
- **Not a new algorithm.** Percentile-based planning, changepoint-first fitting and discard-aware
  capacity are each established practice. What is new here is the combination, and the evidence
  that on these particular networks the trend model finds nothing while the other three find
  something in every scope.

---

## Sources

- [Microbursts: catching sub-second congestion that minute averages hide](https://www.netdata.cloud/guides/network/network-microbursts/)
- [Microburst Detection: sub-second traffic spikes standard monitoring misses](https://www.kentik.com/kentipedia/microburst-detection/)
- [What Is 95th Percentile Bandwidth Metering and How It Works](https://www.ninjaone.com/blog/what-is-95th-percentile-bandwidth-metering/)
- [The 95th Percentile: How to Manage Capacity Before You Run Out](https://www.auvik.com/franklyit/blog/95th-percentile-bandwidth-metering/)
- [Revealing Utilization at Internet Interconnection Points](https://arxiv.org/pdf/1603.03656)
- [Forecasting link utilization between points of presence in an IP network (US 8,949,394)](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8949394)
- [A Hybrid Algorithm for Changepoint Aware Long-Term Seasonality Detection of Mobile Network Base Stations](https://dergipark.org.tr/en/pub/ejosat/article/931099)
- [Infrastructure Utilization and Capacity Planning — Statseeker](https://statseeker.com/network-performance-monitoring/infrastructure-utilization-and-capacity-planning/)
