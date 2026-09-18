// Ask Dynatrace Assist about what is on screen. Answers are cached per subject and question.
// Follows the Dynatrace Intelligence presence pattern: AiIcon on triggers and on the feature
// label, "[verb]ing [object]..." while loading, and the AI disclaimer under every answer.
import React, { useEffect, useRef, useState } from "react";
import { AiLoadingIndicator, AiResponse } from "@dynatrace/strato-components/content";
import { ExternalLink, Text } from "@dynatrace/strato-components/typography";
import { AiIcon } from "@dynatrace/strato-icons";
import { askAssist } from "../utils/assist";
import { openAssist } from "../utils/drilldown";

/** A trigger: a short label for the button, the question sent to Assist, and how it should be answered. */
export interface AssistQuestion {
  label: string;
  /** a short, natural question: Assist's guardrail rejects anything that does not read as one */
  prompt: string;
  /** the rules and answer shape for this question, sent as instruction rather than in the question */
  instruction?: string;
}

interface Props {
  /** Stable key of what is being asked about (cause id or "network") */
  subject: string;
  questions: (AssistQuestion | string)[];
  context: () => unknown;
  /** What the AI is looking at, for the loading message ("Analyzing cause...") */
  object?: string;
}

type Entry = { state: "loading" } | { state: "done"; text: string } | { state: "error"; text: string };
const cache = new Map<string, Entry>();
const DOCS_INTELLIGENCE = "https://docs.dynatrace.com/docs/dynatrace-intelligence";

const asQuestion = (q: AssistQuestion | string): AssistQuestion => (typeof q === "string" ? { label: q, prompt: q } : q);

/**
 * Assist's guardrail is a classifier and it is not deterministic: measured on a live environment, the very
 * request it refused went through four times in a row when replayed. One quiet retry covers that, and a
 * transient network failure the same way; a missing permission or an abort is never retried.
 */
async function askOnce(q: AssistQuestion, ctx: unknown, signal: AbortSignal) {
  const flaky = (a: { status: string; text: string }) => a.status === "FAILED" && /valid question|rephras/i.test(a.text ?? "");
  try {
    const a = await askAssist(q.prompt, ctx, signal, q.instruction);
    if (!flaky(a) || signal.aborted) return a;
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (signal.aborted || /403|429|scope|permission|high demand/i.test(msg)) throw e;
  }
  await new Promise((r) => setTimeout(r, 900));
  return askAssist(q.prompt, ctx, signal, q.instruction);
}

export function AssistPanel({ subject, questions, context, object }: Props) {
  const [question, setQuestion] = useState<AssistQuestion | null>(null);
  const [, rerender] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { setQuestion(null); abort.current?.abort(); }, [subject]);

  // An open answer folds away when the user clicks anywhere outside the panel. The request is left to
  // finish and stays cached, so asking again shows it at once.
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!question) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (box.current && t && !box.current.contains(t)) setQuestion(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [question]);

  const key = question ? `${subject}|${question.prompt}` : "";
  const entry = key ? cache.get(key) : undefined;

  const ask = (q: AssistQuestion) => {
    setQuestion(q);
    const k = `${subject}|${q.prompt}`;
    const cached = cache.get(k);
    if (cached && cached.state !== "error") return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    cache.set(k, { state: "loading" });
    rerender((n) => n + 1);
    askOnce(q, context(), ctrl.signal)
      .then((a) => cache.set(k, a.status === "FAILED" || !a.text ? { state: "error", text: a.text && /valid question|rephras/i.test(a.text) ? "Dynatrace Assist did not accept this question. Try the other question, or continue in Assist." : "Couldn't get an answer. Try again." } : { state: "done", text: a.text }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) { cache.delete(k); return; }
        const msg = String((e as { message?: string })?.message ?? e);
        cache.set(k, { state: "error", text: /403|scope|permission/i.test(msg)
          ? "Explanations need the davis-copilot:conversations:execute permission. Ask your Dynatrace administrator to grant it."
          : /429|high demand/i.test(msg)
          ? "Dynatrace Assist is busy right now. Try again in a minute."
          : "Couldn't reach Dynatrace Assist. Check your connection and try again." });
      })
      .finally(() => rerender((n) => n + 1));
  };

  return (
    <section ref={box} className="lm-assist" aria-label="Dynatrace Intelligence">
      <div className="lm-assist__head"><AiIcon aria-hidden="true" /><span>Intelligence</span></div>
      <div className="lm-assist__chips">
        {questions.map(asQuestion).map((q) => (
          <button key={q.prompt} type="button" className={`lm-chip${question?.prompt === q.prompt ? " is-on" : ""}`} aria-pressed={question?.prompt === q.prompt} onClick={() => ask(q)}>
            <AiIcon aria-hidden="true" /> {q.label}
          </button>
        ))}
      </div>
      {entry?.state === "loading" && <div className="lm-assist__body"><AiLoadingIndicator>{object ? `Analyzing ${object}...` : "Analyzing..."}</AiLoadingIndicator></div>}
      {entry?.state === "done" && (
        <div className="lm-assist__body lm-assist__answer">
          <AiResponse responseState="complete">{entry.text}</AiResponse>
          <Text textStyle="small" className="lm-assist__disclaimer">
            <ExternalLink href={DOCS_INTELLIGENCE}>Dynatrace Intelligence</ExternalLink> uses AI. Always verify important information and decisions.
          </Text>
          <button type="button" className="lm-chip lm-assist__continue" onClick={() => question && openAssist(question.prompt, context())}>
            <AiIcon aria-hidden="true" /> Continue in Assist
          </button>
        </div>
      )}
      {entry?.state === "error" && <div className="lm-assist__body lm-assist__error" role="alert">{entry.text}</div>}
    </section>
  );
}
