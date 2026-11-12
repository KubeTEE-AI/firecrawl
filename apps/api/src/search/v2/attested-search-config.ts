import { readFileSync } from "node:fs";
import { config } from "../config";
import {
  credentialAtPath,
  type SupportedCredentials,
  type SupportedProvider,
} from "./supported";

export function loadProviderCredentials(
  requested: SupportedProvider[],
  directory: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Partial<SupportedCredentials> {
  return credentialAtPath(requested, directory, readFile);
}

export function configuredSearchProviderCredentials():
  | Partial<SupportedCredentials>
  | undefined {
  if (config.SEARCH_SUPPORTED_PROVIDERS.length === 0) return undefined;
  return loadProviderCredentials(
    config.SEARCH_SUPPORTED_PROVIDERS as SupportedProvider[],
    config.SEARCH_PROVIDER_KEYS_DIR,
  );
}
