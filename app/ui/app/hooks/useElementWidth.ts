// Width of a container in CSS pixels, so a chart can be drawn at 1 SVG unit = 1 pixel instead of being
// scaled up with the window. Type keeps its size on a large monitor; the drawing uses the extra space.
import { useCallback, useEffect, useState } from "react";

export function useElementWidth<T extends HTMLElement>(fallback = 760): [(node: T | null) => void, number] {
  // a callback ref, not a RefObject: these charts mount after their data arrives, and an effect that ran
  // once on an empty ref would keep drawing at the fallback width and scale the whole drawing — including
  // its type — up to the container
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((node: T | null) => setEl(node), []);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [el]);
  return [ref, width];
}
