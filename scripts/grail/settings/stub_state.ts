// stands in for @dynatrace-sdk/client-state: the test drives what the tenant answers
export const calls: { get: number; set: unknown[] } = { get: 0, set: [] };
export let behaviour: "ok" | "notFound" | "broken" | "brokenOnce" = "ok";
export let stored = JSON.stringify(42);
export let saveFails = false;
export const setBehaviour = (b: typeof behaviour) => { behaviour = b; };
export const setSaveFails = (v: boolean) => { saveFails = v; };
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
    if (saveFails) throw new Error("refused");
    stored = body.value;
    return {};
  },
};
