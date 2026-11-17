import type { AppConfig } from "./types.ts";

function extractHostname(rawUrlOrHost: string): string | null {
  const trimmed = rawUrlOrHost.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  // Strip optional port if someone wrote localhost:8787 or example.com:8443
  return trimmed.replace(/\/.*$/, "").replace(/:\d+$/, "");
}

export function matchDomainPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const cleanPattern = extractHostname(pattern);
  if (!cleanPattern) return false;

  if (cleanPattern === "*") return true;

  if (cleanPattern.startsWith("*.")) {
    const base = cleanPattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }

  if (cleanPattern.startsWith(".")) {
    const base = cleanPattern.slice(1);
    return host === base || host.endsWith(`.${base}`);
  }

  return host === cleanPattern;
}

export function checkHotlinkAllowed(request: Request, config: AppConfig): boolean {
  if (config.allowedReferers.length === 0) {
    return true;
  }

  const referer = request.headers.get("Referer")?.trim();
  if (!referer) {
    return config.allowEmptyReferer;
  }

  let refererHost: string;
  try {
    refererHost = new URL(referer).hostname.toLowerCase();
  } catch {
    return false;
  }

  // Always allow same-origin Worker host & configured PUBLIC_BASE_URL host so admin gallery works
  const reqHost = new URL(request.url).hostname.toLowerCase();
  if (refererHost === reqHost) {
    return true;
  }

  if (config.publicBaseUrl) {
    const pubHost = extractHostname(config.publicBaseUrl);
    if (pubHost && refererHost === pubHost) {
      return true;
    }
  }

  return config.allowedReferers.some((pattern) => matchDomainPattern(refererHost, pattern));
}
