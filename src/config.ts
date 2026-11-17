import type { AppConfig, Env, NamingStrategy } from "./types.ts";

const VALID_STRATEGIES = new Set<NamingStrategy>([
  "date-random",
  "date-original",
  "flat-random",
  "original",
]);

export class ConfigError extends Error {
  public readonly missingKeys: string[];

  constructor(message: string, missingKeys: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.missingKeys = missingKeys;
  }
}

export function normalizePrefix(raw?: string): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/");
}

export function parseNamingStrategy(raw?: string, fallback: NamingStrategy = "date-random"): NamingStrategy {
  const normalized = (raw || "").trim().toLowerCase() as NamingStrategy;
  return VALID_STRATEGIES.has(normalized) ? normalized : fallback;
}

export function parseEndpointAndRegion(
  rawEndpoint: string,
  bucket: string,
  explicitRegion?: string,
): {
  origin: string;
  host: string;
  region: string;
  isVirtualHosted: boolean;
} {
  let trimmed = rawEndpoint.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`B2_ENDPOINT 格式无效: "${rawEndpoint}"，示例: s3.us-west-004.backblazeb2.com`);
  }

  const host = parsed.host;
  const hostname = parsed.hostname.toLowerCase();
  const bucketLower = bucket.trim().toLowerCase();
  const isVirtualHosted = Boolean(bucketLower && hostname.startsWith(`${bucketLower}.`));

  let region = (explicitRegion || "").trim();
  if (!region) {
    // Match s3.<region>.backblazeb2.com or <bucket>.s3.<region>.backblazeb2.com
    const b2Match = hostname.match(/(?:^|\.)s3\.([a-z0-9-]+)\.backblazeb2\.com$/i);
    if (b2Match?.[1]) {
      region = b2Match[1];
    } else {
      region = "us-west-004";
    }
  }

  return {
    origin: parsed.origin,
    host,
    region,
    isVirtualHosted,
  };
}

export function getAuthToken(env: Env): string | null {
  const token = (env.AUTH_TOKEN || "").trim();
  return token.length > 0 ? token : null;
}

export function loadConfig(env: Env, options: { requireB2?: boolean } = {}): AppConfig {
  const requireB2 = options.requireB2 ?? true;

  const b2KeyId = (env.B2_KEY_ID || "").trim();
  const b2ApplicationKey = (env.B2_APPLICATION_KEY || "").trim();
  const b2Bucket = (env.B2_BUCKET || "").trim();
  const rawEndpoint = (env.B2_ENDPOINT || "").trim();
  const authToken = (env.AUTH_TOKEN || "").trim();

  const missing: string[] = [];
  if (!authToken) missing.push("AUTH_TOKEN");
  if (requireB2) {
    if (!b2KeyId) missing.push("B2_KEY_ID");
    if (!b2ApplicationKey) missing.push("B2_APPLICATION_KEY");
    if (!b2Bucket || b2Bucket === "your-b2-bucket-name") missing.push("B2_BUCKET");
    if (!rawEndpoint) missing.push("B2_ENDPOINT");
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `服务端缺少必要环境变量配置: ${missing.join(", ")}。请在 wrangler.toml 或 Cloudflare Worker Secrets 中完成配置。`,
      missing,
    );
  }

  const endpointInfo = rawEndpoint
    ? parseEndpointAndRegion(rawEndpoint, b2Bucket, env.B2_REGION)
    : {
        origin: "https://s3.us-west-004.backblazeb2.com",
        host: "s3.us-west-004.backblazeb2.com",
        region: (env.B2_REGION || "us-west-004").trim(),
        isVirtualHosted: false,
      };

  const maxFileSizeMbRaw = Number.parseFloat(env.MAX_FILE_SIZE_MB || "25");
  const maxFileSizeMb = Number.isFinite(maxFileSizeMbRaw) && maxFileSizeMbRaw > 0 ? maxFileSizeMbRaw : 25;
  const maxFileSizeBytes = Math.floor(maxFileSizeMb * 1024 * 1024);

  const cacheTtlRaw = Number.parseInt(env.CACHE_TTL_SECONDS || "31536000", 10);
  const cacheTtlSeconds = Number.isFinite(cacheTtlRaw) && cacheTtlRaw >= 0 ? cacheTtlRaw : 31536000;

  const allowedReferers = (env.ALLOWED_REFERERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const allowEmptyReferer = (env.ALLOW_EMPTY_REFERER ?? "true").trim().toLowerCase() !== "false";

  const publicBaseUrl = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");

  return {
    b2KeyId,
    b2ApplicationKey,
    b2Bucket,
    b2EndpointOrigin: endpointInfo.origin,
    b2EndpointHost: endpointInfo.host,
    b2Region: endpointInfo.region,
    isVirtualHostedEndpoint: endpointInfo.isVirtualHosted,
    authToken,
    publicBaseUrl,
    uploadPrefix: normalizePrefix(env.UPLOAD_PREFIX),
    pathStrategy: parseNamingStrategy(env.PATH_STRATEGY, "date-random"),
    maxFileSizeBytes,
    maxFileSizeMb,
    cacheTtlSeconds,
    allowedReferers,
    allowEmptyReferer,
  };
}
