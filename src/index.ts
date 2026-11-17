import {
  buildClearSessionCookie,
  buildSessionSetCookie,
  isAuthorized,
  timingSafeEqualString,
} from "./auth.ts";
import { ConfigError, loadConfig, normalizePrefix, parseNamingStrategy } from "./config.ts";
import { checkHotlinkAllowed } from "./hotlink.ts";
import {
  B2ApiError,
  b2DeleteObject,
  b2GetObject,
  b2ListObjects,
  b2PutObject,
} from "./s3.ts";
import type {
  AppConfig,
  Env,
  GalleryImageItem,
  UploadedImageItem,
  WorkerExecutionContext,
} from "./types.ts";
import {
  buildImageLinks,
  buildObjectKey,
  detectImageMime,
  encodeKeyForPublicPath,
  guessMimeFromKey,
  jsonResponse,
  normalizeObjectKey,
  resolvePublicBaseUrl,
} from "./utils.ts";

interface EdgeCacheStorage {
  default?: Cache;
}

function getEdgeCache(): Cache | null {
  try {
    const c = (globalThis as unknown as { caches?: EdgeCacheStorage }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

function buildInternalCacheKey(requestUrl: URL, objectKey: string): Request {
  const canonical = `${requestUrl.origin}/__b2_edge_cache__/v1/${encodeKeyForPublicPath(objectKey)}`;
  return new Request(canonical, { method: "GET" });
}

async function purgeEdgeCacheForKey(requestUrl: URL, objectKey: string): Promise<void> {
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    await cache.delete(buildInternalCacheKey(requestUrl, objectKey));
  } catch {
    // Ignore cache API errors in non-zone / local environments
  }
}

function decodeBase64ToBytes(rawBase64: string): Uint8Array {
  const cleaned = rawBase64.replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  const binStr = atob(cleaned);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

function decodeUrlPathToKey(rawRestPath: string): string | null {
  const trimmed = rawRestPath.replace(/^\/+/, "");
  if (!trimmed) return null;
  try {
    const decoded = trimmed
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
    return normalizeObjectKey(decoded);
  } catch {
    return null;
  }
}

function etagMatches(ifNoneMatchHeader: string | null, etag: string | null): boolean {
  if (!ifNoneMatchHeader || !etag) return false;
  if (ifNoneMatchHeader.trim() === "*") return true;
  const cleanTarget = etag.replace(/^W\//i, "").trim();
  return ifNoneMatchHeader
    .split(",")
    .some((candidate) => candidate.replace(/^W\//i, "").trim() === cleanTarget);
}

async function handleAuthVerify(request: Request, env: Env): Promise<Response> {
  if (!(env.AUTH_TOKEN || "").trim()) {
    return jsonResponse(
      {
        authenticated: false,
        configured: false,
        error: "服务端尚未配置 AUTH_TOKEN 密钥，请在 Cloudflare Worker Secrets 或 .dev.vars 中设置。",
      },
      503,
    );
  }

  const authed = await isAuthorized(request, env);
  return jsonResponse(
    {
      authenticated: authed,
      configured: true,
    },
    authed ? 200 : 401,
  );
}

async function handleAuthLogin(request: Request, env: Env): Promise<Response> {
  const secret = (env.AUTH_TOKEN || "").trim();
  if (!secret) {
    return jsonResponse({ success: false, error: "服务端尚未设置 AUTH_TOKEN" }, 503);
  }

  let candidate = "";
  try {
    const body = (await request.json()) as { password?: string; token?: string };
    candidate = (body.password || body.token || "").trim();
  } catch {
    return jsonResponse({ success: false, error: "请求格式错误，需要 JSON" }, 400);
  }

  if (!(await timingSafeEqualString(candidate, secret))) {
    return jsonResponse({ success: false, error: "访问密码 / API Key 不正确" }, 401);
  }

  const isSecure = new URL(request.url).protocol === "https:";
  const cookie = await buildSessionSetCookie(secret, isSecure);

  return jsonResponse(
    { success: true },
    200,
    { "Set-Cookie": cookie },
  );
}

function handleAuthLogout(request: Request): Response {
  const isSecure = new URL(request.url).protocol === "https:";
  return jsonResponse(
    { success: true },
    200,
    { "Set-Cookie": buildClearSessionCookie(isSecure) },
  );
}

async function handleStatus(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ success: false, error: "未授权访问" }, 401);
  }

  const url = new URL(request.url);
  const wantPing = url.searchParams.get("ping") === "1";

  let config: AppConfig;
  try {
    config = loadConfig(env, { requireB2: true });
  } catch (err) {
    if (err instanceof ConfigError) {
      return jsonResponse({
        success: true,
        b2Configured: false,
        missingKeys: err.missingKeys,
        error: err.message,
      });
    }
    throw err;
  }

  let ping: { ok: boolean; latencyMs: number; error?: string } | undefined;
  if (wantPing) {
    const start = Date.now();
    try {
      await b2ListObjects(config, { maxKeys: 1 }, fetchImpl);
      ping = { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      ping = {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return jsonResponse({
    success: true,
    b2Configured: true,
    bucket: config.b2Bucket,
    endpoint: config.b2EndpointOrigin,
    region: config.b2Region,
    publicBaseUrl: resolvePublicBaseUrl(request, config.publicBaseUrl),
    customBaseUrlConfigured: Boolean(config.publicBaseUrl),
    uploadPrefix: config.uploadPrefix,
    pathStrategy: config.pathStrategy,
    maxFileSizeMb: config.maxFileSizeMb,
    cacheTtlSeconds: config.cacheTtlSeconds,
    hotlinkEnabled: config.allowedReferers.length > 0,
    allowedReferers: config.allowedReferers,
    allowEmptyReferer: config.allowEmptyReferer,
    ping,
  });
}

interface PendingUploadFile {
  bytes: Uint8Array;
  originalName: string;
  declaredMime?: string;
}

async function handleUpload(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const config = loadConfig(env, { requireB2: true });
  const url = new URL(request.url);
  const contentTypeHeader = (request.headers.get("Content-Type") || "").toLowerCase();

  // Reject oversized single-body payloads early via Content-Length when available
  const contentLength = Number.parseInt(request.headers.get("Content-Length") || "0", 10);
  if (contentLength > config.maxFileSizeBytes * 10 + 1024 * 1024) {
    return jsonResponse(
      { success: false, error: `请求总大小超出限制（单图最大 ${config.maxFileSizeMb} MB）` },
      413,
    );
  }

  let authed = await isAuthorized(request, env, { allowQueryKey: true });
  let customFolder = url.searchParams.get("folder") || url.searchParams.get("prefix") || "";
  let namingRaw = url.searchParams.get("naming") || url.searchParams.get("strategy") || "";
  const pendingFiles: PendingUploadFile[] = [];

  if (contentTypeHeader.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return jsonResponse({ success: false, error: "无法解析 multipart/form-data 表单数据" }, 400);
    }

    if (!authed) {
      const formToken =
        (formData.get("key") as string | null) ||
        (formData.get("token") as string | null) ||
        null;
      authed = await isAuthorized(request, env, {
        allowQueryKey: true,
        extraCandidateToken: typeof formToken === "string" ? formToken : null,
      });
    }

    if (!authed) {
      return jsonResponse({ success: false, error: "未授权：请提供有效的 API Key 或先登录" }, 401);
    }

    const formFolder = formData.get("folder") || formData.get("prefix");
    if (typeof formFolder === "string" && formFolder.trim()) {
      customFolder = formFolder.trim();
    }
    const formNaming = formData.get("naming") || formData.get("strategy");
    if (typeof formNaming === "string" && formNaming.trim()) {
      namingRaw = formNaming.trim();
    }

    for (const [, value] of formData.entries()) {
      if (typeof value === "object" && value !== null && "arrayBuffer" in value) {
        const blob = value as File;
        if (blob.size === 0) continue;
        if (blob.size > config.maxFileSizeBytes) {
          return jsonResponse(
            {
              success: false,
              error: `文件 "${blob.name || "image"}" 大小 (${(blob.size / 1024 / 1024).toFixed(2)} MB) 超过上限 ${config.maxFileSizeMb} MB`,
            },
            413,
          );
        }
        const buf = await blob.arrayBuffer();
        pendingFiles.push({
          bytes: new Uint8Array(buf),
          originalName: blob.name || "paste.png",
          declaredMime: blob.type,
        });
      }
    }
  } else if (contentTypeHeader.includes("application/json")) {
    if (!authed) {
      return jsonResponse({ success: false, error: "未授权：请提供有效的 API Key 或先登录" }, 401);
    }
    let payload: {
      base64?: string;
      filename?: string;
      contentType?: string;
      folder?: string;
      naming?: string;
    };
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "无效的 JSON 请求体" }, 400);
    }
    if (!payload.base64) {
      return jsonResponse({ success: false, error: "缺少 base64 字段" }, 400);
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64ToBytes(payload.base64);
    } catch {
      return jsonResponse({ success: false, error: "base64 数据解码失败" }, 400);
    }
    if (bytes.byteLength === 0 || bytes.byteLength > config.maxFileSizeBytes) {
      return jsonResponse(
        { success: false, error: `图片大小无效或超过上限 ${config.maxFileSizeMb} MB` },
        413,
      );
    }
    if (payload.folder) customFolder = payload.folder;
    if (payload.naming) namingRaw = payload.naming;
    pendingFiles.push({
      bytes,
      originalName: payload.filename || "upload.png",
      declaredMime: payload.contentType,
    });
  } else {
    // Raw binary body upload (e.g. curl --data-binary @img.png -H "Content-Type: image/png")
    if (!authed) {
      return jsonResponse({ success: false, error: "未授权：请提供有效的 API Key 或先登录" }, 401);
    }
    const buf = await request.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) {
      return jsonResponse({ success: false, error: "上传内容为空" }, 400);
    }
    if (bytes.byteLength > config.maxFileSizeBytes) {
      return jsonResponse(
        { success: false, error: `图片超过最大限制 ${config.maxFileSizeMb} MB` },
        413,
      );
    }
    pendingFiles.push({
      bytes,
      originalName: url.searchParams.get("filename") || "upload",
      declaredMime: contentTypeHeader,
    });
  }

  if (pendingFiles.length === 0) {
    return jsonResponse(
      { success: false, error: "未检测到上传的图片文件（表单字段名可使用 file / image / smfile）" },
      400,
    );
  }

  const strategy = parseNamingStrategy(namingRaw, config.pathStrategy);
  const publicBaseUrl = resolvePublicBaseUrl(request, config.publicBaseUrl);
  const cacheControl = `public, max-age=${config.cacheTtlSeconds}, immutable`;
  const uploadedItems: UploadedImageItem[] = [];

  for (const item of pendingFiles) {
    const mimeType = detectImageMime(item.bytes, item.originalName, item.declaredMime);
    if (!mimeType) {
      return jsonResponse(
        {
          success: false,
          error: `不支持的文件类型 "${item.originalName}"（仅支持 JPG/PNG/WebP/GIF/AVIF/SVG/BMP/ICO/HEIC 图片）`,
        },
        415,
      );
    }

    const key = buildObjectKey({
      originalName: item.originalName,
      mimeType,
      strategy,
      uploadPrefix: config.uploadPrefix,
      customFolder,
    });

    await b2PutObject(
      config,
      {
        key,
        body: item.bytes,
        contentType: mimeType,
        cacheControl,
        originalName: item.originalName,
      },
      fetchImpl,
    );

    const links = buildImageLinks(publicBaseUrl, key, item.originalName);
    uploadedItems.push({
      key,
      url: links.direct,
      name: item.originalName,
      size: item.bytes.byteLength,
      type: mimeType,
      uploadedAt: new Date().toISOString(),
      links,
    });
  }

  const primary = uploadedItems[0];
  return jsonResponse({
    success: true,
    // Top-level fields for effortless PicGo (jsonPath: "url") & ShareX ({json:url}) compatibility
    key: primary.key,
    url: primary.url,
    name: primary.name,
    size: primary.size,
    type: primary.type,
    uploadedAt: primary.uploadedAt,
    links: primary.links,
    // Nested `data.url` for Lsky / SM.MS style uploader compatibility
    data: {
      url: primary.url,
      key: primary.key,
      links: primary.links,
    },
    // Full array when uploading multiple files at once
    items: uploadedItems,
  });
}

async function handleListImages(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ success: false, error: "未授权访问" }, 401);
  }

  const config = loadConfig(env, { requireB2: true });
  const url = new URL(request.url);
  const rawSubPrefix = normalizePrefix(url.searchParams.get("prefix") || "");
  const cursor = url.searchParams.get("cursor") || undefined;
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const limitParam = Number.parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 1000) : 200;

  let effectivePrefix = "";
  if (config.uploadPrefix && rawSubPrefix) {
    effectivePrefix = rawSubPrefix.startsWith(config.uploadPrefix)
      ? rawSubPrefix
      : `${config.uploadPrefix}/${rawSubPrefix}`;
  } else {
    effectivePrefix = rawSubPrefix || config.uploadPrefix;
  }
  if (effectivePrefix && !effectivePrefix.endsWith("/")) {
    effectivePrefix = `${effectivePrefix}/`;
  }

  // Fetch up to 1,000 objects in a single B2 Class C call so we can sort newest-first!
  const listResult = await b2ListObjects(
    config,
    {
      prefix: effectivePrefix || undefined,
      cursor,
      maxKeys: 1000,
    },
    fetchImpl,
  );

  const publicBaseUrl = resolvePublicBaseUrl(request, config.publicBaseUrl);
  const folderSet = new Set<string>();

  for (const obj of listResult.objects) {
    const slashIdx = obj.key.lastIndexOf("/");
    if (slashIdx > 0) {
      const dir = obj.key.slice(0, slashIdx);
      const topSegment = dir.split("/")[0];
      if (topSegment) folderSet.add(topSegment);
      folderSet.add(dir);
    }
  }

  // Sort newest first by ISO-8601 LastModified timestamp
  const sorted = [...listResult.objects].sort((a, b) =>
    b.lastModified.localeCompare(a.lastModified),
  );

  const filtered = search
    ? sorted.filter((obj) => obj.key.toLowerCase().includes(search))
    : sorted;

  const totalBytes = filtered.reduce((acc, obj) => acc + obj.size, 0);

  const items: GalleryImageItem[] = filtered.slice(0, limit).map((obj) => {
    const name = obj.key.split("/").pop() || obj.key;
    const links = buildImageLinks(publicBaseUrl, obj.key, name);
    return {
      key: obj.key,
      url: links.direct,
      name,
      size: obj.size,
      type: guessMimeFromKey(obj.key),
      lastModified: obj.lastModified,
      etag: obj.etag,
      links,
    };
  });

  return jsonResponse({
    success: true,
    items,
    totalInBatch: filtered.length,
    totalBytesInBatch: totalBytes,
    folders: Array.from(folderSet).sort(),
    isTruncated: listResult.isTruncated,
    nextCursor: listResult.nextCursor ?? null,
  });
}

async function handleDeleteImages(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (!(await isAuthorized(request, env, { allowQueryKey: true }))) {
    return jsonResponse({ success: false, error: "未授权访问" }, 401);
  }

  const config = loadConfig(env, { requireB2: true });
  const url = new URL(request.url);
  const rawKeys: string[] = [];

  const queryKey = url.searchParams.get("key");
  if (queryKey) {
    rawKeys.push(queryKey);
  }

  if (rawKeys.length === 0) {
    try {
      const body = (await request.json()) as { key?: string; keys?: string[] };
      if (body.key) rawKeys.push(body.key);
      if (Array.isArray(body.keys)) rawKeys.push(...body.keys);
    } catch {
      // ignore if empty body
    }
  }

  const validKeys: string[] = [];
  for (const k of rawKeys) {
    const normalized = normalizeObjectKey(k);
    if (!normalized) {
      return jsonResponse({ success: false, error: `非法的图片路径 Key: "${k}"` }, 400);
    }
    validKeys.push(normalized);
  }

  if (validKeys.length === 0) {
    return jsonResponse({ success: false, error: "请提供要删除的图片 key 或 keys 数组" }, 400);
  }

  // Delete in bounded concurrency batches of 5
  const deleted: string[] = [];
  const batchSize = 5;
  for (let i = 0; i < validKeys.length; i += batchSize) {
    const slice = validKeys.slice(i, i + batchSize);
    await Promise.all(
      slice.map(async (key) => {
        await b2DeleteObject(config, key, fetchImpl);
        const purgeTask = purgeEdgeCacheForKey(url, key);
        if (ctx?.waitUntil) {
          ctx.waitUntil(purgeTask);
        } else {
          await purgeTask;
        }
        deleted.push(key);
      }),
    );
  }

  return jsonResponse({
    success: true,
    deleted,
    count: deleted.length,
  });
}

async function handleServeImage(
  request: Request,
  rawRestPath: string,
  env: Env,
  ctx: WorkerExecutionContext | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const key = decodeUrlPathToKey(rawRestPath);
  if (!key) {
    return jsonResponse({ success: false, error: "无效的图片路径" }, 400);
  }

  const config = loadConfig(env, { requireB2: true });

  // 1. Hotlink / Referer check BEFORE cache lookup so hotlink rules apply even on Edge Cache HITs
  if (!checkHotlinkAllowed(request, config)) {
    return new Response("403 Forbidden: Hotlinking is not allowed", {
      status: 403,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Vary: "Referer",
      },
    });
  }

  const reqUrl = new URL(request.url);
  const edgeCache = getEdgeCache();
  const cacheKey = buildInternalCacheKey(reqUrl, key);
  const varyReferer = config.allowedReferers.length > 0;

  // 2. Check Cloudflare Edge Cache first
  if (edgeCache) {
    try {
      const cached = await edgeCache.match(cacheKey);
      if (cached) {
        const cachedEtag = cached.headers.get("ETag");
        if (etagMatches(request.headers.get("If-None-Match"), cachedEtag)) {
          const headers304 = new Headers({
            "Cache-Control": cached.headers.get("Cache-Control") || `public, max-age=${config.cacheTtlSeconds}, immutable`,
            "Access-Control-Allow-Origin": "*",
            "X-Cache": "HIT",
          });
          if (cachedEtag) headers304.set("ETag", cachedEtag);
          if (varyReferer) headers304.set("Vary", "Referer");
          return new Response(null, { status: 304, headers: headers304 });
        }

        const outHeaders = new Headers(cached.headers);
        outHeaders.set("X-Cache", "HIT");
        if (varyReferer) outHeaders.set("Vary", "Referer");
        return new Response(request.method === "HEAD" ? null : cached.body, {
          status: cached.status,
          headers: outHeaders,
        });
      }
    } catch {
      // Fall through to B2 origin fetch if Cache API fails
    }
  }

  // 3. Cache Miss -> Signed request to Backblaze B2 Private/Public Bucket
  const canPopulateEdgeCache = Boolean(edgeCache && request.method === "GET" && !request.headers.get("Range"));

  const b2Res = await b2GetObject(
    config,
    key,
    {
      method: canPopulateEdgeCache ? "GET" : (request.method as "GET" | "HEAD"),
      ifNoneMatch: canPopulateEdgeCache ? null : request.headers.get("If-None-Match"),
      ifModifiedSince: canPopulateEdgeCache ? null : request.headers.get("If-Modified-Since"),
      range: request.headers.get("Range"),
    },
    fetchImpl,
  );

  if (b2Res.status === 404) {
    return new Response("404 Image Not Found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  if (b2Res.status === 304) {
    const headers304 = new Headers({
      "Cache-Control": `public, max-age=${config.cacheTtlSeconds}, immutable`,
      "Access-Control-Allow-Origin": "*",
      "X-Cache": "MISS",
    });
    const etag = b2Res.headers.get("ETag");
    if (etag) headers304.set("ETag", etag);
    if (varyReferer) headers304.set("Vary", "Referer");
    return new Response(null, { status: 304, headers: headers304 });
  }

  // Normalize Content-Type (Backblaze B2 may return "b2/x-auto" or "application/octet-stream")
  const rawB2Type = (b2Res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const contentType =
    !rawB2Type || rawB2Type === "b2/x-auto" || rawB2Type === "application/octet-stream"
      ? guessMimeFromKey(key)
      : rawB2Type;

  const baseHeaders = new Headers();
  baseHeaders.set("Content-Type", contentType);
  baseHeaders.set(
    "Cache-Control",
    `public, max-age=${config.cacheTtlSeconds}, s-maxage=${config.cacheTtlSeconds}, immutable`,
  );
  baseHeaders.set("Content-Disposition", "inline");
  baseHeaders.set("Access-Control-Allow-Origin", "*");
  baseHeaders.set("X-Content-Type-Options", "nosniff");
  baseHeaders.set("Accept-Ranges", "bytes");

  const passthroughHeaders = ["ETag", "Last-Modified", "Content-Length", "Content-Range"];
  for (const h of passthroughHeaders) {
    const val = b2Res.headers.get(h);
    if (val) baseHeaders.set(h, val);
  }

  // Strict sandbox CSP for SVG images to eliminate stored XSS risks
  if (contentType === "image/svg+xml") {
    baseHeaders.set(
      "Content-Security-Policy",
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    );
  }

  // Populate Cloudflare Edge Cache on 200 OK
  if (canPopulateEdgeCache && edgeCache && b2Res.status === 200 && b2Res.body) {
    const cacheableResponse = new Response(b2Res.body, {
      status: 200,
      headers: baseHeaders,
    });
    const forEdge = cacheableResponse.clone();
    const putPromise = edgeCache.put(cacheKey, forEdge).catch(() => {});
    if (ctx?.waitUntil) {
      ctx.waitUntil(putPromise);
    } else {
      await putPromise;
    }

    const etag = baseHeaders.get("ETag");
    if (etagMatches(request.headers.get("If-None-Match"), etag)) {
      const headers304 = new Headers({
        "Cache-Control": baseHeaders.get("Cache-Control")!,
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "MISS",
      });
      if (etag) headers304.set("ETag", etag);
      if (varyReferer) headers304.set("Vary", "Referer");
      return new Response(null, { status: 304, headers: headers304 });
    }

    const clientHeaders = new Headers(cacheableResponse.headers);
    clientHeaders.set("X-Cache", "MISS");
    if (varyReferer) clientHeaders.set("Vary", "Referer");
    return new Response(cacheableResponse.body, {
      status: 200,
      headers: clientHeaders,
    });
  }

  const clientHeaders = new Headers(baseHeaders);
  clientHeaders.set("X-Cache", "MISS");
  if (varyReferer) clientHeaders.set("Vary", "Referer");

  return new Response(request.method === "HEAD" ? null : b2Res.body, {
    status: b2Res.status,
    headers: clientHeaders,
  });
}

export async function handleWorkerRequest(
  request: Request,
  env: Env,
  ctx?: WorkerExecutionContext,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, X-Auth-Token",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);
  const { pathname } = url;

  try {
    if (pathname === "/health") {
      return jsonResponse({ ok: true, service: "cf-b2-images" });
    }

    if (pathname === "/api/auth/verify" && request.method === "GET") {
      return await handleAuthVerify(request, env);
    }
    if (pathname === "/api/auth/login" && request.method === "POST") {
      return await handleAuthLogin(request, env);
    }
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      return handleAuthLogout(request);
    }

    if (pathname === "/api/status" && request.method === "GET") {
      return await handleStatus(request, env, fetchImpl);
    }

    if ((pathname === "/api/upload" || pathname === "/upload") && request.method === "POST") {
      return await handleUpload(request, env, fetchImpl);
    }

    if (pathname === "/api/images" && request.method === "GET") {
      return await handleListImages(request, env, fetchImpl);
    }

    if (
      (pathname === "/api/images" && request.method === "DELETE") ||
      (pathname === "/api/images/delete" && request.method === "POST")
    ) {
      return await handleDeleteImages(request, env, ctx, fetchImpl);
    }

    if (pathname.startsWith("/i/")) {
      return await handleServeImage(request, pathname.slice(3), env, ctx, fetchImpl);
    }
    if (pathname.startsWith("/file/")) {
      return await handleServeImage(request, pathname.slice(6), env, ctx, fetchImpl);
    }

    // Fallback to Cloudflare Workers Static Assets (public/)
    if (env.ASSETS) {
      return await env.ASSETS.fetch(request);
    }

    return jsonResponse({ success: false, error: "Not Found" }, 404);
  } catch (err) {
    if (err instanceof ConfigError) {
      return jsonResponse(
        {
          success: false,
          error: err.message,
          missingKeys: err.missingKeys,
        },
        503,
      );
    }
    if (err instanceof B2ApiError) {
      return jsonResponse(
        {
          success: false,
          error: err.message,
          b2Code: err.code,
        },
        err.status >= 400 && err.status < 600 ? err.status : 502,
      );
    }
    console.error("Unhandled Worker Error:", err);
    return jsonResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : "服务器内部错误",
      },
      500,
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    return handleWorkerRequest(request, env, ctx);
  },
};
