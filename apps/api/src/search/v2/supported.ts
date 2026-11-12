import type {
  SearchResultType,
  SearchV2Response,
  WebSearchResult,
} from "../../lib/entities";
import { logger } from "../../lib/logger";

export type SupportedProvider = "tavily" | "brave" | "exa" | "serper";
type ProviderFileReader = (path: string) => string;

export type SupportedCredentials = Record<SupportedProvider, string>;
export function credentialAtPath(
  selected: SupportedProvider[],
  directory: string,
  readFile: ProviderFileReader,
): Partial<SupportedCredentials> {
  if (directory !== "/secrets/providers") {
    throw new Error("Attested provider credential directory must be /secrets/providers.");
  }
  return Object.fromEntries(selected.map(name => {
    try {
      const credential = readFile(`${directory}/${name.toUpperCase()}_API_KEY`).trim();
      if (credential.length === 0) throw new Error("empty");
      return [name, credential];
    } catch {
      // A path or read error must never be decorated with sensitive contents.
      throw new Error(`${name.toUpperCase()}_API_KEY is unavailable in attested in-guest storage.`);
    }
  })) as Partial<SupportedCredentials>;
}

export type ProviderHealth = Partial<
  Record<SupportedProvider, { failures: number; retryAt: number; latencyMs?: number; pending?: boolean }>
>;

export type SupportedOptions = {
  num_results: number;
  categories: unknown[];
  timeout: number;
  type?: SearchResultType | SearchResultType[];
  safe?: boolean;
  lang?: string;
  country?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export class SupportedSearchError extends Error {
  status = 502;
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
  }
}

const healthMaxFailures = 5;

// Credentials are loaded only through credentialAtPath after CDH attestation.

async function request(
  provider: SupportedProvider,
  url: string,
  init: RequestInit,
  timeout: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeout, 1));
  timer.unref();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SupportedSearchError(provider, "invalid JSON response");
    }
    if (!response.ok) {
      // Never include provider response bodies: they can reflect credentials.
      throw new SupportedSearchError(provider, `HTTP ${response.status}`);
    }
    return body;
  } catch (error) {
    if (error instanceof SupportedSearchError) throw error;
    throw new SupportedSearchError(
      provider,
      error instanceof Error ? error.name : "request failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

function rows(
  provider: SupportedProvider,
  raw: unknown[],
  limit: number,
): WebSearchResult[] {
  return raw.flatMap((record: any, index): WebSearchResult[] => {
    if (index >= limit) return [];
    const url = provider === "serper" ? record?.link : record?.url;
    if (typeof url !== "string" || url.length === 0) return [];
    const text = provider === "tavily"
      ? record.content
      : provider === "exa"
        ? record.text ?? record.summary ?? ""
        : provider === "serper"
          ? record.snippet ?? ""
          : record.description;
    return [{
      url,
      title: typeof record.title === "string" ? record.title : url,
      description: typeof text === "string" ? text : "",
      position: index + 1,
    }];
  });
}

/** Official supported API backends only; SearXNG remains the unconfigured fallback. */
export async function supported_search(
  query: string,
  options: SupportedOptions,
  credentials: Partial<SupportedCredentials> | undefined,
  state: ProviderHealth = {},
  now: () => number = Date.now,
): Promise<SearchV2Response> {
  if (options.categories.length > 0) {    throw new Error("Supported search providers accept web search only.");
  }
  if (!credentials) throw new Error("No supported search provider is initialized from attested storage.");
  const names = Object.keys(credentials);
  if (names.length === 0) {
    throw new Error("No supported search provider configured.");
  }
  names.forEach(name => {
    if (!["tavily", "brave", "exa", "serper"].includes(name)) {
      throw new SupportedSearchError("configuration", "Unknown configured supported search provider.");
    }
  });
  const errors: string[] = [];
  const limit = Math.min(Math.max(options.num_results, 1), 20);

  for (const name of names as SupportedProvider[]) {
    const credential = credentials[name];
    if (typeof credential !== "string" || credential.length === 0) {
      throw new Error(`${name} has no supported search credential.`);
    }
    const health = state[name] ??= { failures: 0, retryAt: 0, latencyMs: 0 };
    if (health.pending || health.retryAt > now()) {
      // Concurrent callers must not bypass a cooling provider or fire a herd
      // of half-open recovery probes against an already rate-limited API.
      continue;
    }
    health.pending = true;
    let url: string;
    let init: RequestInit;
    if (name === "brave") {
      url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
        q: query,
        count: String(limit),
        country: options.country ?? "us",
        search_lang: options.lang ?? "en",
        safesearch: options.safe ? "strict" : "off",
      })}`;
      init = {
        headers: { "X-Subscription-Token": credential, Accept: "application/json" },
      };
    } else {
      const body = name === "tavily" ? {
        query,
        search_depth: "fast",
        topic: "general",
        max_results: limit,
        include_domains: options.includeDomains ?? [],
        include_domains_mode: options.includeDomains?.length ? "restrict" : "auto",
        exclude_domains: options.excludeDomains ?? [],
        include_answer: false,
        include_raw_content: false,
      } : name === "exa" ? {
        query,
        numResults: limit,
        type: "fast",
        includeDomains: options.includeDomains,
        excludeDomains: options.excludeDomains,
      } : {
        q: query,
        num: limit,
        gl: options.country ?? "us",
        hl: options.lang ?? "en",
      };
      url = name === "tavily"
        ? "https://api.tavily.com/search"
        : name === "exa"
          ? "https://api.exa.ai/search"
          : "https://google.serper.dev/search";
      init = {
        method: "POST",
        headers: {
          [name === "tavily" ? "Authorization" : name === "exa" ? "x-api-key" : "X-API-KEY"]:
            name === "tavily" ? `Bearer ${credential}` : credential,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      };
    }
    const started = now();
    try {
      // Construct only this provider's request inside the pending guard so a
      // future adapter error cannot leave its circuit latched forever.
      const raw: any = await request(name, url, init, options.timeout);
      const items = name === "brave" ? raw?.web?.results : name === "serper" ? raw?.organic : raw?.results;
      if (!Array.isArray(items)) throw new SupportedSearchError(name, "malformed response");
      health.failures = 0;
      health.retryAt = 0;
      health.latencyMs = now() - started;
      return { web: rows(name, items, limit) };
    } catch (error) {
      health.failures++;
      health.retryAt = now() + Math.min(300_000, 1000 * 2 ** Math.min(health.failures, 8));
      logger.warn(`Supported search provider failed: ${name}`);
      if (health.failures >= healthMaxFailures) logger.warn(`Supported search circuit opens: ${name}`);
      errors.push(error instanceof Error ? error.message : `${name} failed`);
    } finally {
      health.pending = false;
    }
  }
  throw new SupportedSearchError(
    "pool",
    errors.join("; ") || "All configured providers are cooling down.",
  );
}
