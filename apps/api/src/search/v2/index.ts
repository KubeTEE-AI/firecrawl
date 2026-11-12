import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";
import { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";
import { configuredSearchProviderCredentials } from "./attested-search-config";
import { SupportedSearchError, supported_search } from "./supported";

const supportedHealth = {};
export const supportedCredentials = configuredSearchProviderCredentials();

export async function search({
  query,
  logger,
  requestId,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  safe = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  type = undefined,
  enterprise = undefined,
  includeDomains = undefined,
  excludeDomains = undefined,
  usOnly = false,
}: {
  query: string;
  logger: Logger;
  requestId?: string;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: "past_hour" | "past_day" | "past_week" | "past_month" | "past_year";
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
  includeDomains?: string[];
  excludeDomains?: string[];
  usOnly?: boolean;
}): Promise<SearchV2Response> {
  // The fallback backends below take no US-only routing.
  if (usOnly && !config.FIRE_ENGINE_BETA_URL) {
    throw new UsOnlyUnavailableError(
      "Search is not available for teams restricted to US-only processing on this deployment.",
    );
  }
  try {
    if (config.FIRE_ENGINE_BETA_URL) {
      logger.info("Using fire engine search");
      const results = await fire_engine_search_v2(query, {
        requestId,
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
        type,
        enterprise,
        includeDomains,
        excludeDomains,
        usOnly,
      });
      return results;
    }

    const searchTypes = type === undefined ? ["web"] : Array.isArray(type) ? type : [type];
    if (!usOnly && searchTypes.every(t => t === "web") && config.SEARCH_SUPPORTED_PROVIDERS.length > 0) {
      logger.info("Using supported API search providers");
      return await supported_search(query, {
        num_results, categories: [], timeout, lang, country, safe, type,
        includeDomains, excludeDomains,
      }, supportedCredentials, supportedHealth);
    }

    // includeDomains/excludeDomains are enforced on returned URLs only on
    // the fire engine path above; the fallback providers below receive them
    // solely as the site: chain baked into the query.
    if (config.SEARXNG_ENDPOINT) {
      logger.info("Using searxng search");
      const results = await searxng_search(query, {
        num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
      });
      if (results.web && results.web.length > 0) return results;
    }

    logger.info("Using DuckDuckGo search");
    const ddgResults = await ddgSearch(query, num_results, {
      tbs,
      lang,
      country,
      proxy,
      timeout,
    });
    if (ddgResults.web && ddgResults.web.length > 0) return ddgResults;
    return {};
  } catch (error) {
    if (error instanceof SupportedSearchError) throw error;
    logger.error(`Error in search function`, { error });
    return {};
  }
}
