// Every question this app asks Dynatrace Assist. They are written, not improvised at the call site:
// a vague question ("Explain this device") gets a vague answer, so each prompt names the subject, the
// order the answer must follow, what counts as evidence, and what the model must not do.
//
// Three rules run through all of them, matching how the app itself works:
//   1. Status comes from the problems and alerts Dynatrace has open. Counters (CPU, utilization, errors,
//      availability) are evidence, never a verdict of their own.
//   2. The one number the app judges by itself is circuit latency against the sla_ms tag the customer set.
//   3. A field that is not in the context is "not reported" — never guessed, never averaged into a claim.
import type { AssistQuestion } from "../components/AssistPanel";
import { INSTRUCTION, INSTRUCTION_LIMIT } from "./assist";

/**
 * Appended to every prompt: the answer shape, and the four rules that make an answer checkable.
 *
 * The shape alone was not enough. Measured on this environment, answers came back fluent and
 * unverifiable — "several sites are seeing elevated latency", "traffic appears unusually high"
 * — because nothing in the instruction said a sentence has to be traceable to a field. These
 * four turn every bullet into something the reader can check against the screen in front of
 * them, and they are what separates an answer from a paraphrase.
 */
const SHAPE = [
  /* only the shape of the answer: what it must be true of is the contract in `INSTRUCTION`,
     and saying it twice cost every question four hundred characters of its own budget */
  "Use at most 5 Markdown bullets, each starting with \"- \", one line each, leading with the entity it is about.",
  "No preamble, no closing summary, no generic advice.",
  "Every bullet carries at least one figure or named element copied from the context.",
].join(" ");

/**
 * A question for Assist. Its recommender runs a guardrail that rejects text that does not read as a
 * question ("GUARDRAIL_CHECK_FAILED: this doesn't seem to be a valid question"), so the question itself
 * stays short and natural, and everything that says how to answer it — the rules, the order, the shape —
 * travels in the instruction, where the guardrail expects it.
 */
const q = (label: string, question: string, ...guide: string[]): AssistQuestion => {
  const instruction = `${guide.join(" ")} ${SHAPE}`;
  /**
   * The limit is real and it is shared.
   *
   * Assist answers 400 — "Context 'instruction' exceeds the maximum allowed limit of 2500
   * chars" — and the instruction it counts is this one appended to the contract every
   * question carries, so the budget here is 2500 less that contract. Nothing checked it:
   * two questions were over it and had been failing at click time with "Couldn't reach
   * Dynatrace Assist", which reads as the network being down. Now it says which question
   * and by how much, at the moment the question is built.
   */
  const total = INSTRUCTION.length + 1 + instruction.length;
  if (total > INSTRUCTION_LIMIT) {
    console.warn(`Assist instruction for "${label}" is ${total} chars, ${total - INSTRUCTION_LIMIT} over the ${INSTRUCTION_LIMIT} limit: Assist will refuse it.`);
  }
  return { label, prompt: question, instruction };
};

/** The map with no cause selected: the whole network. */
export const networkQuestions = (): AssistQuestion[] => [
  q("Summarize network",
    "What is the current condition of this network?",
    "State the current condition of this network in one bullet: how many sites are affected out of the total, and by how many open problems.",
    "Then one bullet per open cause, worst first: what it is, the alert or problem behind it, since when, and how many sites and sessions it costs.",
    "If no problem is open, say so plainly and name the largest group of devices that report nothing (not monitored) instead of inventing a risk.",
    "reachability, where present, is a fact about the estate and belongs in the summary: how many pinged addresses answer nothing, and under which monitoring configurations."),
  q("Prioritize fixes",
    "What should be fixed first on this network?",
    "Rank the open causes by what to fix first. Judge by sites affected, sessions lost and whether a site lost every path, not by how loud the alert sounds.",
    "One bullet per cause: rank, cause, why it outranks the next one, and the single next action (which team, which element).",
    "If two causes share a device, site or carrier, say so and treat them as one action.",
    "Addresses under reachability that belong to no known device are a configuration fix, not an outage: rank them as such."),
];

/** A cause selected on the map. */
export const causeQuestions = (title: string): AssistQuestion[] => [
  q("Explain cause",
    `What is "${title}" and what is it based on?`,
    `Explain "${title}" to an operator on shift.`,
    "Bullet 1: what Dynatrace has open (problem id, name, category, since).",
    "Bullet 2: the network element it lands on and how the app tied it to the inventory.",
    "Bullets 3-5: the evidence that corroborates it, oldest first, as a chain: what failed first, what followed from it, and what is only a consequence — timeline carries the order and rootCause marks the element Dynatrace named. Never present a counter as the cause when an alert explains it.",
    "Close by naming what the record rules out: a layer with readings and no fault is excluded, and say so with its figure.",
    "ping, where present: an address with packetsBack 0 is not answering the monitor, and a device answering on another of its addresses is reachable — so the fault is those addresses, not the device."),
  q("Assess impact",
    `What is the impact of "${title}"?`,
    `State the impact of "${title}" in numbers only from the context:`,
    "sites affected out of the total, regions, whether any site lost every WAN path, sessions per hour lost against the normal rate, and applications named in the evidence.",
    "If a number is not reported, say it is not reported instead of estimating."),
  q("Suggest next steps",
    `What are the next steps for "${title}"?`,
    "List the actions in the order to take them.",
    "portGroups, when present, is what the app measured and did not interpret: crc or errors above zero is the physical layer (cable, optic, duplex); busiestHourPctOfLineRate at or above 70 is capacity; no error and no hour above 1% is neither, so it is a sub-hour burst or an interface policy, and the check that separates those two is the same counter at a finer interval than one hour.",
    "Name the ports and figures from portGroups.examples, never a group without them.",
    "ping, when present: packetsBack 0 means that address does not answer the monitor; a device answering on another of its addresses is reachable, so act on the silent addresses or on the monitoring configuration, not on the device.",
    "Each bullet: the action, the exact element (device, interface, circuit id or monitor) and the result that confirms it.",
    "Mark which belong to the network team and which to the carrier, with the circuit ids for a carrier ticket. Base every action on a fact in the context."),
];

/** The Sites page, with whatever filter is applied. */
export const sitesQuestions = (): AssistQuestion[] => [
  q("Summarize sites",
    "How are the listed sites doing?",
    "Summarize the sites currently listed (the filter is in the context).",
    "One bullet for the totals, then the worst sites by name with their cause and since when.",
    "Group sites that share one cause into a single bullet instead of repeating it."),
  q("Find hotspots",
    "Where do the problems concentrate?",
    "Name the region, data center or carrier where the listed problems concentrate.",
    "Give the concentration as a ratio (affected of total in that group) and compare it with the rest of the network.",
    "If the problems are spread evenly, say so — do not manufacture a hotspot."),
];

/** One site. */
export const siteQuestions = (name: string, hasBackup: boolean, hasTraffic = false): AssistQuestion[] => [
  q("Explain site",
    `What is the current state of site ${name}?`,
    "In this order: status and the open problem behind it, or that nothing is alerting;",
    "WAN links with carrier, technology, state and latency against the circuit SLA;",
    "devices carrying a problem, with the port when the alert names one, and the latest events with their times.",
    "Where a device carries ping, say how many of its addresses answer and name those that do not: it separates a device that is down from one that is only partly reachable."),
  ...(hasBackup ? [q("Check backup",
    `Is ${name} running on its backup link right now?`,
    "Compare primary and backup: status, carrier, latency against each SLA, loss.",
    "State plainly whether the site has a second path left, and what it costs in latency while it is on backup.")] : []),
  ...(hasTraffic ? [q("Explain traffic",
    `What is ${name} talking to, and is anything unusual in its traffic?`,
    "Use only traffic in the context: NetFlow of the last hour from this site's exporters.",
    "Cover where the bytes go (other sites, Internet, private ranges no site claims), the applications that carry them, and each item under insights with its numbers.",
    "Say what each insight could mean and the one check that would tell the options apart. Never call it an attack or a fault: flows show volume and pattern, not intent.")] : []),
  q("Suggest next steps",
    `Which actions would restore service at ${name}?`,
    "List the actions in the order to take them: each with the exact element and the result that confirms it.",
    "Mark which belong to the network team and which to the carrier, with the circuit id. Base every action on a fact in the context."),
];

/** Traffic, for the whole network or one site. */
export const trafficQuestions = (where: string): AssistQuestion[] => [
  /* The page no longer prints a list called "findings", so the questions stop naming one.
     They ask about what is on screen: the paths, their volume, and what stands out in them. */
  q("Explain traffic",
    `What is ${where} talking to, and is anything unusual in its traffic?`,
    "Use only traffic in the context: the last hour, from the sources it names (NetFlow, OneAgent).",
    "Start with the heaviest paths — from, through, to — each with its volume.",
    "Then anything that stands out, with the numbers that make it stand out: how many sources, how many hosts, which port, over what window.",
    "For each, say what it could mean and the one check that would tell the options apart.",
    "Never call it an attack or a fault, and never say a volume is high without the figure it is high against: flows show volume and pattern, not intent."),
  q("What to fix first",
    `What in the traffic of ${where} should be looked at first?`,
    "Rank what stands out by how many hosts, sites or applications it touches and how long it has lasted, using only the counts in the context.",
    "One bullet each: what it is, the figure that puts it at that rank, the team it belongs to, and the exact element — device name, interface name, workload or site — as the context spells it.",
    "If two of them involve the same device, port or /24, say so and treat them as one action."),
  q("What is missing",
    `What data would make the traffic picture of ${where} complete?`,
    "Name only gaps the context shows: a source not received, devices not tied to a site, an address range no site claims, a query that reached its limit.",
    "One bullet each: the gap, the figure that measures it (how many exporters, how many bytes, how many devices), what it hides today, and where it is configured.",
    "Do not list a source as missing if the context shows it reporting."),
];

/** One device. */
/**
 * The Devices page. Three questions, because the page draws three things.
 *
 * It carried one — "What changed", about syslog — and so the two readings the page actually
 * leads with could not be asked about: which of the alerted devices matters most, and the
 * twenty that are discovered and never polled. A page whose single question is about a
 * different subject than the page is a page with no question on it.
 */
export const devicesQuestions = (): AssistQuestion[] => [
  q("What needs attention",
    "Which of these devices should be looked at first, and why that one?",
    "Rank the devices in alerting[] by what sits behind them — sitesBehindIt — and not by how severe the alert sounds.",
    "One bullet each: the device as spelled, its site and role, the alert (id, name, category, since), and how many sites depend on it.",
    "Where aboutTheMonitorNotTheDevice is true, say the alert is about the monitor that watches the device and not about the device: the device may be answering perfectly. Where rootCause is true, say Dynatrace named this device as the cause.",
    "If alerting[] is empty, say plainly that nothing is alerting and name the devices in carryingInterfaceErrors[] as the only present-tense fault evidence the page holds, or say there is none.",
    "reachability counts the addresses pinged with no answer: onNoKnownDevice are addresses in a monitoring configuration that match nothing in the inventory, which is a configuration fix and not a fault."),
  q("What is not polled",
    "Which devices are discovered but never polled, and what would it take to cover them?",
    "Answer from discoveredNotPolled: give the count against the total, then one bullet per extension in byExtension with how many devices it would cover.",
    "Name examples with their site and role so the reader can recognise them, and say what the gap hides — the fields listed in whatItHides — rather than describing it as a risk.",
    "An extension listed as \"no extension named\" is a discovery configuration with nothing to poll with: say that it needs one chosen, not that the devices are broken.",
    "If the count is zero, say every discovered device is polled and stop."),
  q("What changed",
    "What changed on these devices in the last 24 hours?",
    "Answer from changes: busiest[] holds one row per port or device with how many times it did it.",
    "Lead with the single busiest change — the port or device, how many times, and since when.",
    "Then at most three more, worst first. Group by kind (links going up and down, ports shut by the switch, configuration written, routing neighbours).",
    "A port that transitioned once is housekeeping: say so rather than listing it. If nothing of substance changed, say that in one line."),
];

export const deviceQuestions = (name: string, healthy: boolean): AssistQuestion[] => [
  q("Explain device",
    `What is the state of ${name}?`,
    healthy
      ? "It has no open problem: say that first, then give the measurements that support it (availability, CPU, interface errors, syslog), and name the one closest to its limit as the thing to watch."
      : "Name the open alert first (id, name, category, and the interface when the alert names one), then the measurements that corroborate it, and say which of them contradict it — a device alerting on hardware while answering every packet is a different situation from one that stopped answering.",
    "ping, where present: give addressesAnswering of addressesPinged, and name the addresses under notAnswering with their packet counts.",
    "Then state how many sites depend on this device."),
  q("Suggest next steps",
    `What should be checked next on ${name}?`,
    "Each bullet: the check or action, the exact interface or counter to look at, and what would confirm the fault.",
    "Where ping shows addresses not answering while others on the same device do, the action is on those addresses or on the monitoring configuration that pings them, never on the device.",
    "If nothing is alerting on it, say that no action is warranted and give the one measurement worth watching instead of inventing work."),
];

/**
 * The isolation question. This is the one place where the app hands over a judgement it deliberately does
 * not make itself, so the prompt spells out how to make it: by order of events, not by coincidence.
 */
export const isolationQuestions = (where: string): AssistQuestion[] => [
  q("Analyse",
    `Does the network explain what is degraded in ${where}?`,
    "networkAlertCount 0 means none is open; nothing in outsideNetwork is one. networkBurst is network alerts before an impact: take the order from it. reachability, where present, is direct network evidence: addresses pinged with no answer.",
    "demandFell is the seasonal baseline detector. False means within range: never write fall, drop or outage of demand. Null means unjudged. The percentage under demand is a median comparison, not a verdict. Use the hour and openedAt labels as given.",
    "Decide by order: a fall after a network alert opened supports the network, one before it rules the network out, alerts only outside point outside.",
    "Four bullets: Conclusion (network implicated, not the network, contained, nothing to isolate); Evidence (ids and times); Against (the one fact for a different conclusion, or none); Next step (action and team).",
    "Demand counted for the environment is never attributed to one site.",
    "retransmissionsRose and roundTripRose are the adaptive detector: true is direct evidence the applications feel the network — with a networkBurst it supports the network, with no network alert it points to an unmonitored segment or the hosts. False means within range: never say they rose. Null means unjudged."),
  q("What is missing",
    `What data is missing to decide whether the network explains what is degraded in ${where}?`,
    "Name only items the context marks as missing or partial under sources, and anything else it states is absent.",
    "One bullet each: what it is, what it would settle for this decision, and where it is configured.",
    "If nothing is missing, say the decision rests on complete data."),
];

/** WAN links, for one carrier or all of them. */
export const carrierQuestions = (carrier: string | null): AssistQuestion[] => carrier ? [
  q("Summarize carrier",
    `How is ${carrier} performing?`,
    "Bullet 1: circuits, how many are down, how many are above the SLA tagged on them.",
    "Bullet 2: median and worst latency against that SLA, in milliseconds.",
    "Bullets 3-5: the worst sites by name, with latency, loss and since when."),
  q("Draft ticket",
    `Can you draft a ticket for ${carrier}?`,
    `Draft the body of a ticket for ${carrier}.`,
    "Include: affected circuit ids with their sites, what each one shows (down since, or latency against the contracted SLA, with loss), the time the problem started, and what is being asked of the carrier.",
    "Write it as the ticket text itself, no commentary, and use only circuit ids present in the context."),
] : [
  q("Compare carriers",
    "Which carrier is doing worst against its own SLA?",
    "Compare the carriers against each other, each one against the SLA tagged on its own circuits — never against another carrier's SLA.",
    "One bullet per carrier: links, down, over SLA, median latency as a percentage of its SLA.",
    "Close with which carrier is worst and by which measure."),
  q("Draft ticket",
    "Can you draft a ticket for the carrier with the most issues?",
    "Draft the body of a ticket for the carrier with the most circuits down or over SLA.",
    "Include the circuit ids with their sites, what each shows, and what is being asked.",
    "Write the ticket text itself, using only ids present in the context."),
];

/**
 * Ahead. Four questions, all of them about getting ahead of something.
 *
 * The first set was not. "What changed, and when" reads a log of events with dates in the past;
 * "Why is so much silent" explains the method; "How far can you see" is about trusting the page
 * rather than about the network. Three of four asked the panel to describe, and this page exists
 * to anticipate — so each one now has to be answerable only by looking forward, and each is
 * grounded in `room`, which is the one forward-looking quantity defined for every subject here.
 *
 * Each still guards a distinction the numbers do not carry alone: that room is not a date, that
 * a jump a subject has already made is the best evidence of a jump it can make again, and that
 * an estate with no crossings has not been proven safe — only unproven dangerous.
 */
export const aheadQuestions = (): AssistQuestion[] => [
  q("What runs out first",
    "Which subject will run out of room first, and what does the record actually support about when?",
    "Rank by room.pointsOfRoomLeft, smallest first, and say what each is measured against — a port's line rate and a processor's saturation are both room and are not the same risk.",
    "Give a date only where climbing[] has one. Everywhere else say plainly that the record supports an order of arrival and not a date, and that this is the honest answer rather than a missing one.",
    "Where a subject carries a forecast, give its horizon and its confidence band, and its forecastQualityAssessment: a forecast the analyzer did not call VALID is reported with that word beside it and never as a date.",
    "Close with the one check that would change the ranking: a longer record, or a published line rate on the ports that have none."),
  q("What is one jump away",
    "Which subjects could reach a limit on a single rise of a size they have already shown?",
    "Use room[] where roomSmallerThanItsOwnJump is true, and oneJumpAway. Compare pointsOfRoomLeft against biggestRiseItHasShown for each and say both numbers.",
    "This is the strongest anticipation on the page: it needs no trend and no forecast, only arithmetic on a rise the subject has already demonstrated. Say that.",
    "If none qualifies, say so and name the subject that comes closest, with both numbers."),
  q("Where should capacity go next",
    "If I could add capacity in one place, where would it buy the most?",
    "Use sites[]: it carries every site with the count of subjects that have a room reading and the least room among them, tightest first. A site holding several of the tightest is worth more than one holding the single tightest.",
    "Weigh how fast each is moving: pointsPerDay against pointsOfRoomLeft. A subject with little room that is flat is a different decision from one with more room that is rising.",
    "Name the place, the subjects behind it, and what would have to be true for the answer to change.",
    "Room does not add up across a site — the sum of a site's line rates is a capacity no network carries at once — so rank sites by the least room among their subjects and by how many are tight, never by a site-wide percentage."),
  q("What would have to change for this to become urgent",
    "Nothing is on course to a limit — so what would have to start happening for that to change?",
    "Work backwards from room[]: for the tightest few, say how many points a day of growth would bring each to its limit inside the horizon, and compare that with the pointsPerDay each shows now.",
    "Use method.horizon: the page never draws further than twice its record, so a slow rise can be real and still have no date here. Distinguish 'not coming' from 'not visible yet'.",
    "Be explicit that an estate with no crossings has not been shown to be safe — it has been shown that nothing has yet risen fast enough to be seen."),
];