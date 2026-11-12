import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const loader = (Module as any)._load;
const config: Record<string, unknown> = {
  FIRE_ENGINE_BETA_URL: undefined,
  SEARXNG_ENDPOINT: "http://searxng",
  SEARCH_SUPPORTED_PROVIDERS: [],
  SEARCH_PROVIDER_KEYS_DIR: "/secrets/providers",
};
const dependencies: Record<string, any> = {
  "../../config": { config },
  "./fireEngine-v2": { fire_engine_search_v2: async () => ({}) },
  "./searxng": { searxng_search: async () => ({ web: [{ url: "https://searxng.example" }] }) },
  "./ddgsearch": { ddgSearch: async () => ({ web: undefined }) },
  "../../scraper/scrapeURL/error": { UsOnlyUnavailableError: Error },
  "./supported": {
    SupportedSearchError: class SupportedSearchError extends Error {},
    supported_search: async () => { throw new dependencies["./supported"].SupportedSearchError("Provider outage detail"); },
    credentialAtPath: () => ({ tavily: "unit-test-key" }),
  },
};
(Module as any)._load = function(request, parent, isMain) {
  return dependencies[request] ?? loader.call(this, request, parent, isMain);
};
const { search } = require("./index.ts");
(Module as any)._load = loader;

const logger: any = { info() {}, error() {} };
test("no additional provider keeps upstream SearXNG fallback", async () => {
  const logger: any = { info() {}, error() {} };
  const response = await search({ query: "q", logger });
  assert.equal(response.web?.[0].url, "https://searxng.example");
});

test("selected-provider error does not get swallowed as no results", async () => {
  // Resolve the module after selecting the test-provided attested credential.
  config.SEARCH_SUPPORTED_PROVIDERS = ["tavily"];
  const source = require.resolve("./index.ts");
  delete require.cache[source];
  (Module as any)._load = function(request, parent, isMain) {
    return dependencies[request] ?? loader.call(this, request, parent, isMain);
  };
  const routed = require("./index.ts");
  (Module as any)._load = loader;
  await assert.rejects(routed.search({ query: "q", logger: { info() {}, error() {} } }), /Provider outage detail/);
  config.SEARCH_SUPPORTED_PROVIDERS = [];
});
