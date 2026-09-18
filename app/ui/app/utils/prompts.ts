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

/** Appended to every prompt: the answer shape the panel can actually display. */
const SHAPE = "Use at most 5 Markdown bullets, each starting with \"- \", one line each, leading with the entity it is about. No preamble, no generic advice.";

/**
 * A question for Assist. Its recommender runs a guardrail that rejects text that does not read as a
 * question ("GUARDRAIL_CHECK_FAILED: this doesn't seem to be a valid question"), so the question itself
 * stays short and natural, and everything that says how to answer it — the rules, the order, the shape —
 * travels in the instruction, where the guardrail expects it.
 */
const q = (label: string, question: string, ...guide: string[]): AssistQuestion => ({ label, prompt: question, instruction: `${guide.join(" ")} ${SHAPE}` });

/** The map with no cause selected: the whole network. */
export const networkQuestions = (): AssistQuestion[] => [
  q("Summarize network",
    "What is the current condition of this network?",
    "State the current condition of this network in one bullet: how many sites are affected out of the total, and by how many open problems.",
    "Then one bullet per open cause, worst first: what it is, the alert or problem behind it, since when, and how many sites and sessions it costs.",
    "If no problem is open, say so plainly and name the largest group of devices that report nothing (not monitored) instead of inventing a risk."),
  q("Prioritize fixes",
    "What should be fixed first on this network?",
    "Rank the open causes by what to fix first. Judge by sites affected, sessions lost and whether a site lost every path, not by how loud the alert sounds.",
    "One bullet per cause: rank, cause, why it outranks the next one, and the single next action (which team, which element).",
    "If two causes share a device, site or carrier, say so and treat them as one action."),
];

/** A cause selected on the map. */
export const causeQuestions = (title: string): AssistQuestion[] => [
  q("Explain cause",
    `What is "${title}" and what is it based on?`,
    `Explain "${title}" to an operator on shift.`,
    "Bullet 1: what Dynatrace has open (problem id, name, category, since).",
    "Bullet 2: the network element it lands on and how the app tied it to the inventory.",
    "Bullets 3-5: the evidence that corroborates it, oldest first. Never present a counter as the cause when an alert explains it."),
  q("Assess impact",
    `What is the impact of "${title}"?`,
    `State the impact of "${title}" in numbers only from the context:`,
    "sites affected out of the total, regions, whether any site lost every WAN path, sessions per hour lost against the normal rate, and applications named in the evidence.",
    "If a number is not reported, say it is not reported instead of estimating."),
  q("Suggest next steps",
    `What are the next steps for "${title}"?`,
    "List the actions in the order to take them.",
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
export const siteQuestions = (name: string, hasBackup: boolean): AssistQuestion[] => [
  q("Explain site",
    `What is the current state of site ${name}?`,
    "Cover, in this order: its status and the open problem behind it, or that nothing is alerting;",
    "its WAN links with carrier, technology, state and latency against the circuit SLA;",
    "the devices carrying a problem, with the port when the alert names one; the latest corroborating events with their times."),
  ...(hasBackup ? [q("Check backup",
    `Is ${name} running on its backup link right now?`,
    "Compare primary and backup: status, carrier, latency against each SLA, loss.",
    "State plainly whether the site has a second path left, and what it costs in latency while it is on backup.")] : []),
  q("Suggest next steps",
    `Which actions would restore service at ${name}?`,
    "List the actions in the order to take them: each with the exact element and the result that confirms it.",
    "Mark which belong to the network team and which to the carrier, with the circuit id. Base every action on a fact in the context."),
];

/** One device. */
export const deviceQuestions = (name: string, healthy: boolean): AssistQuestion[] => [
  q("Explain device",
    `What is the state of ${name}?`,
    healthy
      ? "It has no open problem: say that first, then give the measurements that support it (availability, CPU, interface errors, syslog), and name the one closest to its limit as the thing to watch."
      : "Name the open alert first (id, name, category, and the interface when the alert names one), then the measurements that corroborate it.",
    "Then state how many sites depend on this device."),
  q("Suggest next steps",
    `What should be checked next on ${name}?`,
    "Each bullet: the check or action, the exact interface or counter to look at, and what would confirm the fault.",
    "If nothing is alerting on it, say that no action is warranted and give the one measurement worth watching instead of inventing work."),
];

/**
 * The isolation question. This is the one place where the app hands over a judgement it deliberately does
 * not make itself, so the prompt spells out how to make it: by order of events, not by coincidence.
 */
export const isolationQuestions = (where: string): AssistQuestion[] => [
  q("Analyse",
    `Does the network explain what is degraded in ${where}?`,
    "networkAlertCount is how many network alerts are open; if it is 0 there is none, and nothing in outsideNetwork is a network alert. networkBurst, when present, is the app's own finding of a burst of network alerts just before an impact: take the order of events from it. networkAlertsSample is only a sample.",
    "If demandFell is false, demand did not fall: say it is within its normal range and never describe it as falling. Hourly values that follow the usual column are the normal daily curve.",
    "Use the hour and openedAt labels as given.",
    "Decide by order of events: a fall after a network alert opened supports the network; a fall before it rules the network out; alerts only outside the network point outside it.",
    "Reply with four bullets: Conclusion (network implicated, not the network, contained, or nothing to isolate); Evidence (ids and times); Against (the one fact that would argue for a different conclusion, or none); Next step (action and team).",
    "If trafficAnomalyAlertFired is false the fall is the app's own measurement: call it weaker evidence. Demand counted for the whole environment is never attributed to one site."),
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
