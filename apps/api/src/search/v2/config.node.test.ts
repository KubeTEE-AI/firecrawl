import { test } from "node:test";
import assert from "node:assert/strict";

// The isolated CI validation installs only zod; config.js is transpiled by tsx
// and loads this exact helper, so its external dependencies are unnecessary.
test("no supported search credentials means no extra provider selection", async () => {
  const { config } = await import("../../config.ts");
  assert.deepEqual(config.SEARCH_SUPPORTED_PROVIDERS, []);
});

test("a provider without a KBS-backed env credential fails startup validation", async () => {
  process.env.SEARCH_SUPPORTED_PROVIDERS = "tavily";
  process.env.SEARCH_PROVIDER_KEYS_DIR = "/secrets/providers.missing";
  delete require.cache[require.resolve("../../config.ts")];
  await assert.rejects(import("../../config.ts?provider-invalid"), /SEARCH_PROVIDER_KEYS_DIR/);
});
