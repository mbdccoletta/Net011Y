// Width of a container in CSS pixels, so a chart can be drawn at 1 SVG unit = 1 pixel instead of being
// scaled up with the window. Type keeps its size on a large monitor; the drawing uses the extra space.
import { useEffect, useRef, useState } from "react";

export function useElementWidth<T extends HTMLElement>(fallback = 760): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
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
  }, []);
  return [ref, width];
}
