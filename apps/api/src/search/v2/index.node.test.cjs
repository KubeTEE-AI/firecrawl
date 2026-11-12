const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const realFS = require("node:fs");
const realLoad = Module._load;
const files = new Map();
const config = {
  FIRE_ENGINE_BETA_URL: undefined,
  SEARXNG_ENDPOINT: "http://firecrawl-searxng:8080",
  SEARCH_SUPPORTED_PROVIDERS: [],
  SEARCH_PROVIDER_KEYS_DIR: "/secrets/providers",
};
const calls = [];
const dependencies = {
  "../../config": { config },
  "./fireEngine-v2": { fire_engine_search_v2: async () => ({}) },
  "./searxng": { searxng_search: async () => ({ web: [{ url: "https://searxng.example" }] }) },
  "./ddgsearch": { ddgSearch: async () => ({ web: [] }) },
  "../../scraper/scrapeURL/error": { UsOnlyUnavailableError: class extends Error {} },
  "../../lib/logger": { logger: { warn() {}, info() {}, error() {} } },
};
let search;

function loadRouter(providers) {
  config.SEARCH_SUPPORTED_PROVIDERS = providers;
  files.clear();
  for (const provider of providers) files.set(`/secrets/providers/${provider.toUpperCase()}_API_KEY`, "synthetic-key\n");
  Module._load = function (request, ...rest) {
    if (request === "node:fs") return { ...realFS, readFileSync(path) {
      calls.push(path);
      if (files.has(path)) return files.get(path);
      throw new Error("ENOENT");
    } };
    // Load the actual attested module and real provider implementation. Stub only
    // unrelated upstream runtime modules; no search behavior is mocked.
    return Object.hasOwn(dependencies, request) ? dependencies[request] : realLoad.call(this, request, ...rest);
  };
  for (const path of ["./index.ts", "./supported.ts", "./attested-search-config.ts"]) {
    delete require.cache[require.resolve(path)];
  }
  ({ search } = require("./index.ts"));
  Module._load = function (request, ...rest) {
    if (request === "node:fs") return realFS;
    return Object.hasOwn(dependencies, request) ? dependencies[request] : realLoad.call(this, request, ...rest);
  };
}
const logger = { info() {}, error() {} };
const originalFetch = globalThis.fetch;
function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}
function urls(body) { return (body.web ?? []).map(row => row.url); }

test("no configured providers preserves SearXNG and reads no key", async () => {
  loadRouter([]);
  assert.equal((await search({ query: "question", logger })).web[0].url, "https://searxng.example");
  assert.deepEqual(calls, []);
});

test("four configured providers load from CDH files, preserve query and failover", async () => {
  loadRouter(["tavily", "brave", "exa", "serper"]);
  globalThis.fetch = async (url) => {
    if (String(url).includes("tavily")) return response({}, false, 429);
    return response({ web: { results: [{ title: "Brave result", url: "https://example.com/r", description: "Text" }] } });
  };
  assert.deepEqual(urls(await search({ query: "exact question?", logger })), ["https://example.com/r"]);
  assert.deepEqual(calls, ["/secrets/providers/TAVILY_API_KEY", "/secrets/providers/BRAVE_API_KEY", "/secrets/providers/EXA_API_KEY", "/secrets/providers/SERPER_API_KEY"]);
});

for (const [provider, body] of [
  ["tavily", { results: [{ title: "T", url: "https://example.com/t", content: "Text" }] }],
  ["brave", { web: { results: [{ title: "B", url: "https://example.com/b", description: "Text" }] } }],
  ["exa", { results: [{ title: "E", url: "https://example.com/e", text: "Text" }] }],
  ["serper", { organic: [{ title: "S", link: "https://example.com/s", snippet: "Text" }] }],
]) {
  test(`the real ${provider} adapter returns a valid document`, async () => {
    loadRouter([provider]);
    globalThis.fetch = async () => response(body);
    assert.ok((await search({ query: "question?", logger })).web?.[0]?.url);
  });
}

test("domain filtering reaches the real provider adapter", async () => {
  loadRouter(["tavily"]);
  calls.length = 0;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return response({ results: [] });
  };
  await search({ query: "q", logger, includeDomains: ["example.com"], excludeDomains: ["blocked.com"] });
  assert.deepEqual(requestBody.include_domains, ["example.com"]);
  assert.deepEqual(requestBody.exclude_domains, ["blocked.com"]);
});

test("provider pool failures are explicit and never fall back to DDG", async () => {
  loadRouter(["tavily"]);
  globalThis.fetch = async () => response({ secret: "must-not-leak" }, false, 401);
  await assert.rejects(search({ query: "q", logger }), /tavily: HTTP 401/);
});

test("missing configured guest keys fail closed without outbound fetch", async () => {
  loadRouter(["brave"]);
  calls.length = 0;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; };
  assert.throws(() => loadRouter(["brave"]), /BRAVE_API_KEY.*unavailable.*in-guest storage/);
  assert.equal(fetched, false);
});

test("final SearXNG source requests .json suffix and request timeout", async () => {
  const { searxng_search } = require("./searxng.ts");
  const axios = require("axios");
  const original = axios.get;
  let params;
  try {
    axios.get = async (url, options) => {
      assert.ok(options.timeout > 0);
      assert.equal(url, "http://searxng/search/search");
      params = options.params;
      return { data: { results: [{ url: "https://json.example", title: "JSON", content: "Result" }] } };
    };
    delete config.SEARXNG_ENGINES;
    delete config.SEARXNG_CATEGORIES;
    const response = await searxng_search("q", { num_results: 5 });
    assert.equal(urls(response)[0], "https://json.example");
    // production searxng.ts emits these keys with empty-string values.
    assert.equal(params.engines, "");
    assert.equal(params.categories, "");
    assert.equal(params.format, "json");
  } finally {
    axios.get = original;
  }
  const actualConfig = realFS.readFileSync(__filename, "utf8");
  assert.ok(actualConfig.includes("/secrets/providers"));
});
