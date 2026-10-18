// The platform's detail region, lent to a page.
//
// PageLayout has four regions and the fourth is Details — the documented place to "show
// additional information related to main view content without users having to navigate to a new
// page". App owns it, because what usually fills it is the entity in the URL, and that selection
// is App's. A page with its own kind of detail borrows the region through this slot instead of
// building an overlay of its own: App keeps a host node inside the region, the page renders into
// it, and the page registers how to close itself so the region's own close button — and its
// collapse — reach the page's state.
//
// Why a portal and not a prop: the content is the page's, and it has to re-render with the
// page's state. Handing App a React node would freeze it at the moment it was handed over.
import { createContext, useContext, useEffect, useRef } from "react";

export type DetailsSlot = {
  /** where to render; App keeps this node mounted inside PageLayout.Details */
  host: HTMLElement | null;
  /** take the region (passing how to close) or give it back (null) */
  claim: (close: (() => void) | null) => void;
};

const Ctx = createContext<DetailsSlot | null>(null);
export const DetailsSlotProvider = Ctx.Provider;

/**
 * Borrow the region while `open`, and return the node to render into.
 *
 * Null means draw nothing: either the page is not asking, or there is no slot — a page rendered
 * outside a PageLayout, which is a developer's mistake and not a reader's problem.
 *
 * `onClose` is read through a ref so a fresh closure on every render does not re-claim the
 * region on every render.
 */
export function useDetailsSlot(open: boolean, onClose: () => void): HTMLElement | null {
  const slot = useContext(Ctx);
  const latest = useRef(onClose);
  latest.current = onClose;
  const stable = useRef(() => latest.current());
  useEffect(() => {
    if (!slot) return;
    slot.claim(open ? stable.current : null);
    return () => slot.claim(null);
  }, [slot, open]);
  return open ? slot?.host ?? null : null;
}
