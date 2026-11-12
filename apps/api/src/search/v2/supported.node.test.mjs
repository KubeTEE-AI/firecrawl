import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const loader = Module._load;
Module._load = function(request, parent, ...rest) {
  if (request === "../../lib/logger") return { Logger: process.stderr };
  return loader.call(this, request, parent, ...rest);
};
const { credentialAtPath, supported_search } = require("./supported.js");
Module._load = loader;

test("provider credentials come only from attested in-guest files", () => {
  const files = { "/secrets/providers/TAVILY_API_KEY": "tavily-unit-secret\n", "/secrets/providers/BRAVE_API_KEY": "brave-unit-secret\n" };
  const credentials = credentialAtPath(["tavily", "brave"], "/secrets/providers", path => {
    if (!files[path]) throw new Error("ENOENT");
    return files[path];
  });
  assert.deepEqual(credentials, { tavily: "tavily-unit-secret", brave: "brave-unit-secret" });
  assert.throws(() => credentialAtPath(["exa"], "/secrets/providers", () => { throw new Error("ENOENT"); }), /EXA_API_KEY/);
  assert.throws(() => credentialAtPath(["tavily"], "/tmp", () => "never"), /attested/i);
});
const options = { num_results: 5, categories: [], timeout: 15_000, lang: "en", country: "us", type: "web" };
const health = () => ({ failures: 0, retryAt: 0 });
const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const mockFetch = fn => { globalThis.fetch = fn; };

test("all four configured provider adapters return valid search documents", async () => {
  const calls = [];
  mockFetch(async (input, init) => {
    const url = String(input); calls.push([url, init]);
    if (url.includes("tavily")) return jsonResponse({ results: [{ title: "Tavily", url: "https://example.com/t", content: "Result T" }] });
    if (url.includes("brave")) return jsonResponse({ web: { results: [{ title: "Brave", url: "https://example.com/b", description: "Result B" }] } });
    if (url.includes("exa")) return jsonResponse({ results: [{ title: "Exa", url: "https://example.com/e", text: "Result E" }] });
    return jsonResponse({ organic: [{ title: "Serper", link: "https://example.com/s", snippet: "Result S" }] });
  });
  for (const provider of ["tavily", "brave", "exa", "serper"]) {
    const response = await supported_search("question", options, { [provider]: "test-credential" }, health());
    assert.equal(response.web?.length, 1);
    assert.equal(response.web?.[0].description, `Result ${provider[0].toUpperCase()}`);
  }
  assert.equal(calls.length, 4);
});

test("the first working adapter preserves the question; empty results need no retries", async () => {
  let calls = 0;
  mockFetch(async (_url, init) => { calls++; assert.equal(JSON.parse(String(init?.body)).query, "unchanged question?"); return jsonResponse({ results: [] }); });
  await supported_search("unchanged question?", options, { tavily: "test-credential" }, health());
  assert.equal(calls, 1);
});

test("failure fails over and a five-failure circuit half-opens later", async () => {
  const h = { tavily: { failures: 0, retryAt: 0 }, serper: { failures: 0, retryAt: 0 } };
  let now = 10, calls = 0;
  mockFetch(async () => { calls++; return jsonResponse({}, false, 429); });
  await assert.rejects(supported_search("q", options, { tavily: "test-credential", serper: "test-credential" }, h, () => now));
  assert.ok(h.tavily.retryAt > now);
  await assert.rejects(supported_search("q", options, { tavily: "test-credential", serper: "test-credential" }, h, () => now));
  assert.equal(calls, 2);
  mockFetch(async () => jsonResponse({ results: [{ url: "https://example.com", title: "Recovered", content: "Text" }] }));
  assert.equal((await supported_search("q", options, { tavily: "test-credential", serper: "test-credential" }, h, () => h.tavily.retryAt)).web?.length, 1);
});

test("concurrent recovery cannot bypass the provider circuit", async () => {
  const h = { tavily: { failures: 0, retryAt: 0 }, exa: { failures: 0, retryAt: 0 } };
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let calls = 0;
  mockFetch(async input => {
    calls++;
    if (String(input).includes("tavily")) { await wait; return jsonResponse({}, false, 429); }
    return jsonResponse({ results: [] });
  });
  const requests = Promise.allSettled(Array.from({ length: 4 }, () => supported_search("q", options, { tavily: "test-credential", exa: "test-credential" }, h)));
  await new Promise(resolve => setTimeout(resolve, 20));
  release(); await requests;
  assert.equal(calls, 2, "only one in-flight call per provider");
});

test("malformed and unauthorized responses are safe bounded errors", async () => {
  mockFetch(async () => jsonResponse({ secretURL: "https://upstream.invalid/?token=private" }, false, 401));
  await assert.rejects(supported_search("q", options, { tavily: "test-credential" }, health()), error => {
    assert.ok(!String(error).includes("secretURL"));
    assert.ok(!String(error).includes("test-credential"));
    assert.match(String(error), /HTTP 401/);
    return true;
  });
});
