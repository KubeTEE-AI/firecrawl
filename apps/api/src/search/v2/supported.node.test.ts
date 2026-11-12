import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { credentialAtPath, supported_search } from "./supported.ts";

test("provider credentials come only from attested in-guest files", () => {
  const files: Record<string, string> = {
    "/secrets/providers/TAVILY_API_KEY": "tavily-unit-secret\n",
    "/secrets/providers/BRAVE_API_KEY": "brave-unit-secret\n",
  };
  const credentials = credentialAtPath(["tavily", "brave"], "/secrets/providers", path => {
    if (!files[path]) throw new Error("ENOENT");
    return files[path];
  });
  assert.deepEqual(credentials, { tavily: "tavily-unit-secret", brave: "brave-unit-secret" });
  assert.throws(() => credentialAtPath(["exa"], "/secrets/providers", () => ""), /EXA_API_KEY/);
  assert.throws(() => credentialAtPath(["tavily"], "/tmp", () => "never"), /attested/i);
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const options = { num_results: 5, categories: [], timeout: 15_000, lang: "en", country: "us", type: "web" as const };
const health = () => ({ failures: 0, retryAt: 0 });
const jsonResponse = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as Response;

test("all four configured provider adapters return valid search documents", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push([url, init]);
    if (url.includes("tavily")) return jsonResponse({ results: [{ title: "Tavily", url: "https://example.com/t", content: "Result T" }] });
    if (url.includes("brave")) return jsonResponse({ web: { results: [{ title: "Brave", url: "https://example.com/b", description: "Result B" }] } });
    if (url.includes("exa")) return jsonResponse({ results: [{ title: "Exa", url: "https://example.com/e", text: "Result E" }] });
    return jsonResponse({ organic: [{ title: "Serper", link: "https://example.com/s", snippet: "Result S" }] });
  };
  for (const provider of ["tavily", "brave", "exa", "serper"]) {
    const response = await supported_search("question", options, { [provider]: "test-credential" }, health());
    assert.equal(response.web?.length, 1);
    assert.ok(response.web?.[0].url);
    assert.ok(response.web?.[0].description);
    assert.equal(response.web?.[0].position, 1);
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.some(([url]) => url.includes("brave")));
  assert.equal((calls.find(([url]) => url.includes("brave"))?.[1]?.headers as Record<string, string>)["X-Subscription-Token"], "test-credential");
  assert.ok(calls.some(([url, init]) => url.includes("exa") && JSON.parse(String(init?.body)).numResults === 5));
  assert.ok(calls.some(([url, init]) => url.includes("serper") && JSON.parse(String(init?.body)).q === "question"));
});

test("the first working configured provider preserves the exact question", async () => {
  let body: any;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return jsonResponse({ results: [] }); };
  await supported_search("unchanged question?", options, { tavily: "test-credential" }, health());
  assert.equal(body.query, "unchanged question?");
  assert.deepEqual(body.include_domains, []);
});

test("empty results are returned without retries or errors", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse({ results: [] }); };
  assert.deepEqual(await supported_search("nothing", options, { tavily: "test-credential" }, health()), { web: [] });
  assert.equal(calls, 1);
});

test("a failing first provider fails over to the next one", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse({ error: "timeout" }, false, 504);
    return jsonResponse({ organic: [{ link: "https://example.com", title: "Good", snippet: "Text" }] });
  };
  const result = await supported_search("q", options, { tavily: "test-credential", serper: "test-credential" }, health());
  assert.equal(result.web?.[0].url, "https://example.com");
  assert.equal(calls, 2);
});

test("repeated failures trip a circuit with a later half-open probe", async () => {
  const h = health();
  let now = 10;
  globalThis.fetch = async () => jsonResponse({}, false, 429);
  await assert.rejects(supported_search("q", options, { tavily: "test-credential", serper: "test-credential" }, h, () => now));
  assert.ok((h.tavily?.retryAt ?? 0) > now);
  await assert.rejects(supported_search("q", options, { tavily: "test-credential", serper: "test-credential" }, h, () => now));
  assert.equal(h.tavily?.failures, 1);
  now = h.tavily!.retryAt;
  globalThis.fetch = async () => jsonResponse({ results: [{ url: "https://example.com", title: "Recovered", content: "Text" }] });
  assert.equal((await supported_search("q", options, { tavily: "test-credential", serper: "test-credential" }, h, () => now)).web?.length, 1);
});

test("requests have an actual timeout signal", async () => {
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.signal.aborted, false);
    return jsonResponse({ results: [] });
  };
  await supported_search("q", { ...options, timeout: 1 }, { tavily: "test-credential" }, health());
});

test("missing and malformed keys fail before any outbound request", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse({}); };
  await assert.rejects(supported_search("q", options, {}, health()), /configured/);
  await assert.rejects(supported_search("q", options, { tavily: 123 as unknown as string }, health()), /credential/);
  await assert.rejects(supported_search("q", options, { fake: "x" } as any, health()), /provider/);
  assert.equal(calls, 0);
});

test("malformed results and final failures expose safe errors without keys", async () => {
  globalThis.fetch = async () => jsonResponse({ response: "wrong" });
  await assert.rejects(supported_search("q", options, { tavily: "test-secret-key" }, health()), /tavily/);
  await assert.rejects(supported_search("q", options, { tavily: "test-secret-key" }, health()), error => {
    assert.ok(!String(error).includes("test-secret-key"));
    assert.equal(error instanceof Error && error.name, "Error");
    assert.match(String(error), /tavily/);
    return true;
  });
});

test("supported search can leave non-web sources to upstream federation", async () => {
  await assert.rejects(supported_search("q", { ...options, categories: [{ type: "images" }] }, { tavily: "test-credential" }, health()), /web search/);
});
