// A CSS custom property, resolved to the literal colour it stands for.
//
// Strato's charts draw to a canvas, and a 2D context does not resolve CSS custom properties:
// `ctx.fillStyle = "var(--fc)"` is an invalid colour string, which canvas drops without a
// word, so a series handed `var(--fc)` simply does not appear. Every colour this app passes
// into a chart component has to be a literal, and this is where the theme's own value is read.
//
// It reads from an element, not from `:root`, and that is the whole point of the hook rather
// than a convenience. This app declares its palette on `.lm` and refines it further down —
// `--obs` and `--fc` live on `.ahead .nf`, the comb's ramp on the themed block above it — so
// a read against `document.documentElement` comes back empty and the caller silently falls
// back to whatever literal it hard-coded, which is right in one theme and wrong in the other.
// Measured: an empty ramp reached `HoneycombChart` as `[]`, which it does not recognise as a
// custom palette, and the page went blank.
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A fallback is the token's own value, never a second opinion about it.
 *
 * The literal passed here is what the caller draws with until the node exists, and on a
 * component that paints once it is what the caller draws with for ever — measured on the
 * gauges, which had carried `#95c0ff` through two changes of the series colour. Audited
 * across the app, the fallbacks had drifted into a palette of their own: four different
 * values for the four status tokens against the theme's, and `--cap` falling back to amber
 * while the token resolves to the critical red. Every one of them is now the value its own
 * declaration in `theme.css` falls back to, so the worst a failed read can do is draw the
 * right colour of the wrong theme.
 */

/** the attributes a theme switch actually changes on the root element */
const WATCH = ["class", "data-theme", "style"];

function readFrom(el: Element | null, spec: Record<string, string>): Record<string, string> {
  const cs = el ? getComputedStyle(el) : null;
  return Object.fromEntries(Object.entries(spec).map(([k, fallback]) =>
    [k, cs?.getPropertyValue(k).trim() || fallback]));
}

/**
 * The tokens, and the ref to hang on the element they are declared under.
 *
 * The ref is returned rather than taken because the values cannot be read until the node
 * exists: the first render gets the fallbacks, and the value settles on the ref callback.
 */
export function useTokens<K extends string>(spec: Record<K, string>): [Record<K, string>, (el: Element | null) => void] {
  const node = useRef<Element | null>(null);
  const [value, setValue] = useState(() => readFrom(null, spec) as Record<K, string>);
  const sig = Object.keys(spec).join("|");

  /**
   * Nothing is set when nothing changed.
   *
   * The ref fires on every attach and the observer on every theme attribute touch, and a
   * fresh object each time is a fresh render each time — with an inline ref callback on the
   * other end that is itself new per render, which is React detaching and re-attaching it
   * forever. Measured as "Maximum update depth exceeded" and a blank page.
   */
  const reread = useCallback(() => setValue((prev) => {
    const next = readFrom(node.current, spec) as Record<K, string>;
    return (Object.keys(next) as K[]).every((k) => next[k] === prev[k]) ? prev : next;
  }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig]);

  const ref = useCallback((el: Element | null) => {
    node.current = el;
    if (el) reread();
  }, [reread]);

  // the theme can change under a mounted page, and the literals change with it
  useEffect(() => {
    const root = document.documentElement;
    const mo = new MutationObserver(reread);
    mo.observe(root, { attributes: true, attributeFilter: WATCH });
    reread();
    return () => mo.disconnect();
  }, [reread]);

  return [value, ref];
}

/** one token, same contract */
export function useToken(name: string, fallback: string): [string, (el: Element | null) => void] {
  const [map, ref] = useTokens({ [name]: fallback });
  return [map[name], ref];
}
