// stands in for @dynatrace-sdk/client-state: the test drives what the tenant answers
export const calls: { get: number; set: unknown[]; userGet: string[]; userSet: { key: string; scope: string; validUntilTime?: string }[] } = { get: 0, set: [], userGet: [], userSet: [] };
export let behaviour: "ok" | "notFound" | "broken" | "brokenOnce" = "ok";
export let stored = JSON.stringify(42);
export let saveFails = false;
export const setBehaviour = (b: typeof behaviour) => { behaviour = b; };
export const setSaveFails = (v: boolean) => { saveFails = v; };
/** how long each save takes to answer, by the value written: lets a test land them out of order */
export const saveDelay: Record<string, number> = {};
export const saveRejects = new Set<string>();

/* the user-scoped half of the client, for the log cache: what was written, to whom, and until when */
export const userStore = new Map<string, string>();
export let failRead = false, failWrite = false;
export const setFailRead = (v: boolean) => { failRead = v; };
export const setFailWrite = (v: boolean) => { failWrite = v; };

export const stateClient = {
  getUserAppState: async ({ key }: { key: string }) => {
    calls.userGet.push(key);
    if (failRead || !userStore.has(key)) throw new Error("not found");
    return { value: userStore.get(key)! };
  },
  setUserAppState: async ({ key, body }: { key: string; body: { value: string; validUntilTime?: string } }) => {
    calls.userSet.push({ key, scope: "user", validUntilTime: body.validUntilTime });
    if (failWrite) throw new Error("refused");
    userStore.set(key, body.value);
    return {};
  },
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
