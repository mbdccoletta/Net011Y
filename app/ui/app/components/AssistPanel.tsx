// Ask Dynatrace Assist about what is on screen. Answers are cached per subject and question.
// Follows the Dynatrace Intelligence presence pattern: AiIcon on triggers and on the feature
// label, "[verb]ing [object]..." while loading, and the AI disclaimer under every answer.
import React, { useEffect, useRef, useState } from "react";
import { AiLoadingIndicator, AiResponse } from "@dynatrace/strato-components/content";
import { ExternalLink, Text } from "@dynatrace/strato-components/typography";
import { AiIcon } from "@dynatrace/strato-icons";
import { askAssist } from "../utils/assist";
import { openAssist } from "../utils/drilldown";

/** A trigger: a short imperative label for the button and the full question sent to Assist. */
export interface AssistQuestion {
  label: string;
  prompt: string;
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

export function AssistPanel({ subject, questions, context, object }: Props) {
  const [question, setQuestion] = useState<AssistQuestion | null>(null);
  const [, rerender] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { setQuestion(null); abort.current?.abort(); }, [subject]);

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
    askAssist(q.prompt, context(), ctrl.signal)
      .then((a) => cache.set(k, a.status === "FAILED" || !a.text ? { state: "error", text: "Couldn't get an answer. Try again." } : { state: "done", text: a.text }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) { cache.delete(k); return; }
        const msg = String((e as { message?: string })?.message ?? e);
        cache.set(k, { state: "error", text: /403|scope|permission/i.test(msg)
          ? "Explanations need the davis-copilot:conversations:execute permission. Ask your Dynatrace administrator to grant it."
          : "Couldn't reach Dynatrace Assist. Check your connection and try again." });
      })
      .finally(() => rerender((n) => n + 1));
  };

  return (
    <section className="lm-assist" aria-label="Dynatrace Intelligence">
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
