import type { AppConfig } from "./types.ts";

const encoder = new TextEncoder();

export class B2ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "B2ApiError";
    this.status = status;
    this.code = code;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", toBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(keyData: Uint8Array | CryptoKey, message: string): Promise<ArrayBuffer> {
  const cryptoKey =
    keyData instanceof CryptoKey
      ? keyData
      : await crypto.subtle.importKey(
          "raw",
          toBuffer(keyData),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
  return crypto.subtle.sign("HMAC", cryptoKey, toBuffer(encoder.encode(message)));
}

const signingKeyCache = new Map<string, Promise<CryptoKey>>();

async function getAwsSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service = "s3",
): Promise<CryptoKey> {
  const cacheId = `${secretAccessKey}|${dateStamp}|${region}|${service}`;
  const existing = signingKeyCache.get(cacheId);
  if (existing) return existing;

  if (signingKeyCache.size >= 8) {
    signingKeyCache.clear();
  }

  const promise = (async () => {
    const kSecret = encoder.encode(`AWS4${secretAccessKey}`);
    const kDate = new Uint8Array(await hmacSha256(kSecret, dateStamp));
    const kRegion = new Uint8Array(await hmacSha256(kDate, region));
    const kService = new Uint8Array(await hmacSha256(kRegion, service));
    const kSigningRaw = await hmacSha256(kService, "aws4_request");
    return crypto.subtle.importKey(
      "raw",
      kSigningRaw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  })();

  signingKeyCache.set(cacheId, promise);
  return promise;
}

function isUnreservedByte(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2d || // -
    b === 0x5f || // _
    b === 0x2e || // .
    b === 0x7e // ~
  );
}

/**
 * Strict RFC 3986 URI encoding required by AWS Signature Version 4.
 * Unlike JS encodeURIComponent, this also percent-encodes ! ' ( ) * in uppercase hex.
 */
export function awsUriEncode(input: string, encodeSlash = true): string {
  const bytes = encoder.encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (isUnreservedByte(b) || (!encodeSlash && b === 0x2f)) {
      out += String.fromCharCode(b);
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

export function buildCanonicalQueryString(params: Array<[string, string]>): string {
  if (params.length === 0) return "";
  const encoded = params.map(
    ([k, v]) => [awsUriEncode(k, true), awsUriEncode(v, true)] as const,
  );
  encoded.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

export function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate,
    dateStamp: amzDate.slice(0, 8),
  };
}

export interface SignS3Options {
  method: string;
  origin: string;
  host: string;
  canonicalUri: string;
  queryParams?: Array<[string, string]>;
  headers?: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now?: Date;
}

export interface SignedS3RequestInfo {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export async function signS3Request(options: SignS3Options): Promise<SignedS3RequestInfo> {
  const { amzDate, dateStamp } = formatAmzDate(options.now ?? new Date());
  const canonicalQuery = buildCanonicalQueryString(options.queryParams ?? []);

  const normalizedHeaders: Array<[string, string]> = [];
  const finalHeaders: Record<string, string> = {};

  const rawHeaders: Record<string, string> = {
    ...(options.headers ?? {}),
    host: options.host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDate,
  };

  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined || v === null) continue;
    const lowerKey = k.toLowerCase().trim();
    const trimmedVal = String(v).trim().replace(/\s+/g, " ");
    normalizedHeaders.push([lowerKey, trimmedVal]);
    if (lowerKey !== "host") {
      finalHeaders[lowerKey] = trimmedVal;
    }
  }

  normalizedHeaders.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = normalizedHeaders.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = normalizedHeaders.map(([k]) => k).join(";");

  const canonicalRequest = [
    options.method.toUpperCase(),
    options.canonicalUri || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashedCanonicalRequest,
  ].join("\n");

  const signingKey = await getAwsSigningKey(
    options.secretAccessKey,
    dateStamp,
    options.region,
    "s3",
  );
  const signatureBytes = new Uint8Array(await hmacSha256(signingKey, stringToSign));
  const signature = bytesToHex(signatureBytes);

  finalHeaders["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${options.origin}${options.canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  return {
    url,
    headers: finalHeaders,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

function buildBucketCanonicalUri(config: AppConfig, objectKey?: string): string {
  const encodedBucket = awsUriEncode(config.b2Bucket, true);
  if (config.isVirtualHostedEndpoint) {
    if (!objectKey) return "/";
    return `/${awsUriEncode(objectKey, false)}`;
  }
  if (!objectKey) {
    return `/${encodedBucket}`;
  }
  return `/${encodedBucket}/${awsUriEncode(objectKey, false)}`;
}

export function decodeXmlEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractXmlTag(xmlBlock: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = xmlBlock.match(regex);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

async function parseS3Error(res: Response, fallbackContext: string): Promise<B2ApiError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // ignore body read failures
  }
  const code = extractXmlTag(text, "Code") || `HTTP_${res.status}`;
  const message =
    extractXmlTag(text, "Message") ||
    `${fallbackContext} 失败 (HTTP ${res.status} ${res.statusText})`;
  return new B2ApiError(res.status, code, `${message} [${code}]`);
}

export interface B2PutObjectParams {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
  originalName?: string;
}

export async function b2PutObject(
  config: AppConfig,
  params: B2PutObjectParams,
  fetchImpl: typeof fetch = fetch,
): Promise<{ etag?: string }> {
  const payloadHash = await sha256Hex(params.body);
  const headers: Record<string, string> = {
    "content-type": params.contentType,
    "content-length": String(params.body.byteLength),
  };
  if (params.cacheControl) {
    headers["cache-control"] = params.cacheControl;
  }
  if (params.originalName) {
    headers["x-amz-meta-original-name"] = encodeURIComponent(params.originalName.slice(0, 200));
  }

  const signed = await signS3Request({
    method: "PUT",
    origin: config.b2EndpointOrigin,
    host: config.b2EndpointHost,
    canonicalUri: buildBucketCanonicalUri(config, params.key),
    headers,
    payloadHash,
    accessKeyId: config.b2KeyId,
    secretAccessKey: config.b2ApplicationKey,
    region: config.b2Region,
  });

  const res = await fetchImpl(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: toBuffer(params.body),
  });

  if (!res.ok) {
    throw await parseS3Error(res, "上传至 Backblaze B2");
  }

  return {
    etag: res.headers.get("etag") ?? undefined,
  };
}

export interface B2GetObjectOptions {
  method?: "GET" | "HEAD";
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
  range?: string | null;
}

export async function b2GetObject(
  config: AppConfig,
  key: string,
  options: B2GetObjectOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
  if (options.ifModifiedSince) headers["if-modified-since"] = options.ifModifiedSince;
  if (options.range) headers["range"] = options.range;

  const signed = await signS3Request({
    method,
    origin: config.b2EndpointOrigin,
    host: config.b2EndpointHost,
    canonicalUri: buildBucketCanonicalUri(config, key),
    headers,
    payloadHash: "UNSIGNED-PAYLOAD",
    accessKeyId: config.b2KeyId,
    secretAccessKey: config.b2ApplicationKey,
    region: config.b2Region,
  });

  const res = await fetchImpl(signed.url, {
    method,
    headers: signed.headers,
  });

  if (
    res.status === 200 ||
    res.status === 206 ||
    res.status === 304 ||
    res.status === 404
  ) {
    return res;
  }

  throw await parseS3Error(res, "从 Backblaze B2 读取图片");
}

export async function b2DeleteObject(
  config: AppConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const signed = await signS3Request({
    method: "DELETE",
    origin: config.b2EndpointOrigin,
    host: config.b2EndpointHost,
    canonicalUri: buildBucketCanonicalUri(config, key),
    payloadHash: "UNSIGNED-PAYLOAD",
    accessKeyId: config.b2KeyId,
    secretAccessKey: config.b2ApplicationKey,
    region: config.b2Region,
  });

  const res = await fetchImpl(signed.url, {
    method: "DELETE",
    headers: signed.headers,
  });

  if (!res.ok && res.status !== 404) {
    throw await parseS3Error(res, "从 Backblaze B2 删除图片");
  }
}

export interface S3ListedObject {
  key: string;
  size: number;
  lastModified: string;
  etag?: string;
}

export interface S3ListResult {
  objects: S3ListedObject[];
  prefixes: string[];
  isTruncated: boolean;
  nextCursor?: string;
}

export function parseListObjectsXml(xml: string): S3ListResult {
  const objects: S3ListedObject[] = [];
  const prefixes: string[] = [];

  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsRegex.exec(xml)) !== null) {
    const block = match[1];
    const key = extractXmlTag(block, "Key");
    if (!key) continue;
    // Skip folder markers and Backblaze B2's hidden .bzEmpty placeholder files
    if (key.endsWith("/") || key === ".bzEmpty" || key.endsWith("/.bzEmpty")) {
      continue;
    }
    const sizeStr = extractXmlTag(block, "Size") || "0";
    const lastModified = extractXmlTag(block, "LastModified") || "";
    const etag = extractXmlTag(block, "ETag");
    objects.push({
      key,
      size: Number.parseInt(sizeStr, 10) || 0,
      lastModified,
      etag,
    });
  }

  const prefixRegex = /<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
  while ((match = prefixRegex.exec(xml)) !== null) {
    const p = decodeXmlEntities(match[1]);
    if (p) prefixes.push(p);
  }

  const isTruncated = extractXmlTag(xml, "IsTruncated")?.toLowerCase() === "true";
  const nextCursor = extractXmlTag(xml, "NextContinuationToken");

  return {
    objects,
    prefixes,
    isTruncated,
    nextCursor: isTruncated ? nextCursor : undefined,
  };
}

export interface B2ListObjectsParams {
  prefix?: string;
  cursor?: string;
  maxKeys?: number;
  delimiter?: string;
}

export async function b2ListObjects(
  config: AppConfig,
  params: B2ListObjectsParams = {},
  fetchImpl: typeof fetch = fetch,
): Promise<S3ListResult> {
  const maxKeys = Math.min(Math.max(params.maxKeys ?? 1000, 1), 1000);
  const queryParams: Array<[string, string]> = [
    ["list-type", "2"],
    ["max-keys", String(maxKeys)],
  ];
  if (params.prefix) {
    queryParams.push(["prefix", params.prefix]);
  }
  if (params.cursor) {
    queryParams.push(["continuation-token", params.cursor]);
  }
  if (params.delimiter) {
    queryParams.push(["delimiter", params.delimiter]);
  }

  const signed = await signS3Request({
    method: "GET",
    origin: config.b2EndpointOrigin,
    host: config.b2EndpointHost,
    canonicalUri: buildBucketCanonicalUri(config),
    queryParams,
    payloadHash: "UNSIGNED-PAYLOAD",
    accessKeyId: config.b2KeyId,
    secretAccessKey: config.b2ApplicationKey,
    region: config.b2Region,
  });

  const res = await fetchImpl(signed.url, {
    method: "GET",
    headers: signed.headers,
  });

  if (!res.ok) {
    throw await parseS3Error(res, "获取 Backblaze B2 文件列表");
  }

  const xml = await res.text();
  return parseListObjectsXml(xml);
}
