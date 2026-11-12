import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const config = { FIRE_ENGINE_BETA_URL: undefined, SEARXNG_ENDPOINT: "http://searxng", SEARCH_SUPPORTED_PROVIDERS: [], SEARCH_PROVIDER_KEYS_DIR: "/secrets/providers" };
class SupportedSearchError extends Error { status = 502; }
const dependencies = {
  "../../config": { config },
  "./fireEngine-v2": { fire_engine_search_v2: async () => ({}) },
  "./searxng": { searxng_search: async () => ({ web: [{ url: "https://searxng.example" }] }) },
  "./ddgsearch": { ddgSearch: async () => ({ web: undefined }) },
  "../../scraper/scrapeURL/error": { UsOnlyUnavailableError: Error },
  "./supported": { SupportedSearchError, supported_search: async () => { throw new SupportedSearchError("Provider outage detail"); }, credentialAtPath: () => ({ tavily: "unit-test-key" }) },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  if (request === "../../config") return fileURLToPath(new URL("./stub.config.cjs", import.meta.url));
  return originalResolve.call(this, request, ...args);
};
const loader = Module._load;
Module._load = function(request, parent, ...args) {
  return dependencies[request] ?? loader.call(this, request, parent, ...args);
};
const configStub = fileURLToPath(new URL("./stub.config.cjs", import.meta.url));
require.cache[configStub] = { id: configStub, filename: configStub, loaded: true, exports: { config } };
const { search } = require("./index.js");
Module._load = loader;
Module._resolveFilename = originalResolve;

test("no additional provider keeps upstream SearXNG fallback", async () => {
  const logger = { info() {}, error() {} };
  const response = await search({ query: "q", logger });
  assert.equal(response.web?.[0].url, "https://searxng.example");
});

test("selected-provider error does not get swallowed as no results", async () => {
  config.SEARCH_SUPPORTED_PROVIDERS = ["tavily"];
  Module._load = function(request, parent, ...args) {
    return dependencies[request] ?? loader.call(this, request, parent, ...args);
  };
  Module._resolveFilename = function(request, ...args) {
    if (request === "../../config") return fileURLToPath(new URL("./stub.config.cjs", import.meta.url));
    return originalResolve.call(this, request, ...args);
  };
  const source = require.resolve("./index.js"); delete require.cache[source];
  const routed = require("./index.js");
  Module._load = loader; Module._resolveFilename = originalResolve;
  await assert.rejects(routed.search({ query: "q", logger: { info() {}, error() {} } }), /Provider outage detail/);
  config.SEARCH_SUPPORTED_PROVIDERS = [];
});
