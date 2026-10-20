// stands in for @dynatrace-sdk/client-state: the test drives what the tenant answers
export const calls: { get: number; set: unknown[] } = { get: 0, set: [] };
export let behaviour: "ok" | "notFound" | "broken" | "brokenOnce" = "ok";
export let stored = JSON.stringify(42);
export let saveFails = false;
export const setBehaviour = (b: typeof behaviour) => { behaviour = b; };
export const setSaveFails = (v: boolean) => { saveFails = v; };
/** how long each save takes to answer, by the value written: lets a test land them out of order */
export const saveDelay: Record<string, number> = {};
export const saveRejects = new Set<string>();

export const stateClient = {
  getAppState: async () => {
    calls.get += 1;
    if (behaviour === "notFound") { const e = new Error("not found") as Error & { response: { status: number } }; e.response = { status: 404 }; throw e; }
    if (behaviour === "broken" || (behaviour === "brokenOnce" && calls.get === 1)) {
      const e = new Error("boom") as Error & { response: { status: number } }; e.response = { status: 500 }; throw e;
    }
    return { value: stored };
  },
  setAppState: async ({ body }: { body: { value: string } }) => {
    calls.set.push(body.value);
    const wait = saveDelay[body.value] ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (saveFails || saveRejects.has(body.value)) throw new Error("refused");
    stored = body.value;
    return {};
  },
};
