"use strict";
const Module = require("node:module");

// CI-only: isolate unrelated production transitive imports. The provider and
// attested file-reading modules are never stubbed. Production uses real imports.
const originalLoad = Module._load;
const stubs = {
  "../../config": { config: { SEARXNG_ENDPOINT: "http://firecrawl-searxng:8080/search" } },
  "../../lib/entities": {},
  "../../scraper/scrapeURL/error": { UsOnlyUnavailableError: class extends Error {} },
  "./fireEngine-v2": { fire_engine_search_v2: async () => ({}) },
  "./ddgsearch": { ddgSearch: async () => ({}) },
  "../../lib/mcp-action-log-config": { getMcpActionLogConfigErrors: () => [] },
};
Module._load = function (request, parent, ...rest) {
  return Object.hasOwn(stubs, request)
    ? stubs[request]
    : originalLoad.call(this, request, parent, ...rest);
};
