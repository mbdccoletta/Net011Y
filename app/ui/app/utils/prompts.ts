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
const SHAPE = "Answer in at most 5 Markdown bullets, one line each, max 20 words. Start each bullet with the entity it is about. Quote every number with its unit and every time as it appears in the context. No preamble, no restating the question, no generic advice.";

const q = (label: string, ...parts: string[]): AssistQuestion => ({ label, prompt: `${parts.join(" ")} ${SHAPE}` });

/** The map with no cause selected: the whole network. */
export const networkQuestions = (): AssistQuestion[] => [
  q("Summarize network",
    "State the current condition of this network in one bullet: how many sites are affected out of the total, and by how many open problems.",
    "Then one bullet per open cause, worst first: what it is, the alert or problem behind it, since when, and how many sites and sessions it costs.",
    "If no problem is open, say so plainly and name the largest group of devices that report nothing (not monitored) instead of inventing a risk."),
  q("Prioritize fixes",
    "Rank the open causes by what to fix first. Judge by sites affected, sessions lost and whether a site lost every path, not by how loud the alert sounds.",
    "One bullet per cause: rank, cause, why it outranks the next one, and the single next action (which team, which element).",
    "If two causes share a device, site or carrier, say so and treat them as one action."),
];

/** A cause selected on the map. */
export const causeQuestions = (title: string): AssistQuestion[] => [
  q("Explain cause",
    `Explain "${title}" to an operator on shift.`,
    "Bullet 1: what Dynatrace has open (problem id, name, category, since).",
    "Bullet 2: the network element it lands on and how the app tied it to the inventory.",
    "Bullets 3-5: the evidence that corroborates it, oldest first. Never present a counter as the cause when an alert explains it."),
  q("Assess impact",
    `State the impact of "${title}" in numbers only from the context:`,
    "sites affected out of the total, regions, whether any site lost every WAN path, sessions per hour lost against the normal rate, and applications named in the evidence.",
    "If a number is not reported, say it is not reported instead of estimating."),
  q("Suggest next steps",
    `Give the next steps for "${title}", in the order an operator should take them.`,
    "Each bullet: the action, the exact element (device, interface, circuit id, monitor), and what result confirms it worked.",
    "Separate what the network team can do now from what needs the carrier. If a carrier ticket is needed, say which circuit ids go on it.",
    "Do not suggest anything the context does not support, and do not suggest checking data the app already has."),
];

/** The Sites page, with whatever filter is applied. */
export const sitesQuestions = (): AssistQuestion[] => [
  q("Summarize sites",
    "Summarize the sites currently listed (the filter is in the context).",
    "One bullet for the totals, then the worst sites by name with their cause and since when.",
    "Group sites that share one cause into a single bullet instead of repeating it."),
  q("Find hotspots",
    "Name the region, data center or carrier where the listed problems concentrate.",
    "Give the concentration as a ratio (affected of total in that group) and compare it with the rest of the network.",
    "If the problems are spread evenly, say so — do not manufacture a hotspot."),
];

/** One site. */
export const siteQuestions = (name: string, hasBackup: boolean): AssistQuestion[] => [
  q("Explain site",
    `Explain the current state of site ${name}.`,
    "Bullet 1: its status and the open problem that sets it, or that nothing is alerting on it.",
    "Bullet 2: its WAN links — carrier, technology, up or down, latency against the SLA tagged on the circuit.",
    "Bullet 3: the devices that carry a problem, with the port when the alert names one.",
    "Bullets 4-5: the most recent events that corroborate, with their timestamps."),
  ...(hasBackup ? [q("Check backup",
    `Say whether ${name} is running on its backup link right now.`,
    "Compare primary and backup: status, carrier, latency against each SLA, loss.",
    "State plainly whether the site has a second path left, and what it costs in latency while it is on backup.")] : []),
  q("Suggest next steps",
    `Give the next steps for ${name}.`,
    "Each bullet: action, exact element, and the result that confirms it.",
    "Say which are for the network team and which need the carrier, with the circuit id."),
];

/** One device. */
export const deviceQuestions = (name: string, healthy: boolean): AssistQuestion[] => [
  q("Explain device",
    `Explain the state of ${name}.`,
    healthy
      ? "It has no open problem: say that first, then give the measurements that support it (availability, CPU, interface errors, syslog), and name the one closest to its limit as the thing to watch."
      : "Name the open alert first (id, name, category, and the interface when the alert names one), then the measurements that corroborate it.",
    "Then state how many sites depend on this device."),
  q("Suggest next steps",
    `Give the next steps for ${name}.`,
    "Each bullet: the check or action, the exact interface or counter to look at, and what would confirm the fault.",
    "If nothing is alerting on it, say that no action is warranted and give the one measurement worth watching instead of inventing work."),
];

/** WAN links, for one carrier or all of them. */
export const carrierQuestions = (carrier: string | null): AssistQuestion[] => carrier ? [
  q("Summarize carrier",
    `Summarize how ${carrier} is performing.`,
    "Bullet 1: circuits, how many are down, how many are above the SLA tagged on them.",
    "Bullet 2: median and worst latency against that SLA, in milliseconds.",
    "Bullets 3-5: the worst sites by name, with latency, loss and since when."),
  q("Draft ticket",
    `Draft the body of a ticket for ${carrier}.`,
    "Include: affected circuit ids with their sites, what each one shows (down since, or latency against the contracted SLA, with loss), the time the problem started, and what is being asked of the carrier.",
    "Write it as the ticket text itself, no commentary, and use only circuit ids present in the context."),
] : [
  q("Compare carriers",
    "Compare the carriers against each other, each one against the SLA tagged on its own circuits — never against another carrier's SLA.",
    "One bullet per carrier: links, down, over SLA, median latency as a percentage of its SLA.",
    "Close with which carrier is worst and by which measure."),
  q("Draft ticket",
    "Draft the body of a ticket for the carrier with the most circuits down or over SLA.",
    "Include the circuit ids with their sites, what each shows, and what is being asked.",
    "Write the ticket text itself, using only ids present in the context."),
];
