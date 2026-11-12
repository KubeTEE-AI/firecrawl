import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { config } from "../../config";
assert.deepEqual(config.SEARCH_SUPPORTED_PROVIDERS, []);
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const previousLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...args: unknown[]) {
  if (request === "./lib/mcp-action-log-config") return { getMcpActionLogConfigErrors: () => [] };
  return previousLoad.call(this, request, ...args);
};
const configPath = require.resolve("../../config");
test("invalid provider credential storage fails closed at config validation", () => {
  const previous = process.env.SEARCH_PROVIDER_KEYS_DIR;
  process.env.SEARCH_PROVIDER_KEYS_DIR = "/tmp/exfiltrated";
  process.env.SEARCH_SUPPORTED_PROVIDERS = "tavily";
  try {
    delete require.cache[configPath];
    assert.throws(() => require("../../config"), /Provider storage must be/);
  } finally {
    (Module as any)._load = previousLoad;
    if (previous === undefined) delete process.env.SEARCH_PROVIDER_KEYS_DIR;
    else process.env.SEARCH_PROVIDER_KEYS_DIR = previous;
  }
});
