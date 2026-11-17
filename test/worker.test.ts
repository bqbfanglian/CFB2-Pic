import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEndpointAndRegion } from "../src/config.ts";
import { matchDomainPattern } from "../src/hotlink.ts";
import { handleWorkerRequest } from "../src/index.ts";
import { awsUriEncode, parseListObjectsXml, sha256Hex, signS3Request } from "../src/s3.ts";
import type { Env } from "../src/types.ts";

// Minimal valid PNG bytes (1x1 transparent PNG signature + header)
const SAMPLE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const SAMPLE_SVG = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`,
);

class MockEdgeCache {
  private store = new Map<string, Response>();

  async match(req: Request | string): Promise<Response | undefined> {
    const key = typeof req === "string" ? req : req.url;
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }

  async put(req: Request | string, res: Response): Promise<void> {
    const key = typeof req === "string" ? req : req.url;
    this.store.set(key, res.clone());
  }

  async delete(req: Request | string): Promise<boolean> {
    const key = typeof req === "string" ? req : req.url;
    return this.store.delete(key);
  }
}

function createMockB2Environment(overrides: Partial<Env> = {}) {
  const objects = new Map<
    string,
    { body: Uint8Array; contentType: string; lastModified: string; etag: string }
  >();
  let b2GetCalls = 0;
  let lastPutHeaders: Record<string, string> = {};

  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers);

    // Verify every B2 S3 request carries AWS4-HMAC-SHA256 Authorization & x-amz-content-sha256
    const auth = headers.get("authorization") || "";
    assert.ok(
      auth.startsWith("AWS4-HMAC-SHA256 Credential=004keyid/"),
      `Missing valid SigV4 Authorization header: ${auth}`,
    );
    assert.ok(headers.get("x-amz-content-sha256"), "Missing x-amz-content-sha256");

    // Path-style: /<bucket> or /<bucket>/<key...>
    const prefix = "/my-b2-bucket";
    assert.ok(url.pathname.startsWith(prefix), `Unexpected bucket path: ${url.pathname}`);
    const rawKeyPart = url.pathname.slice(prefix.length).replace(/^\/+/, "");
    const decodedKey = rawKeyPart
      ? rawKeyPart.split("/").map(decodeURIComponent).join("/")
      : "";

    // ListObjectsV2
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const qPrefix = url.searchParams.get("prefix") || "";
      const itemsXml: string[] = [
        // Include a hidden .bzEmpty file to ensure Worker filters it out
        `<Contents><Key>.bzEmpty</Key><Size>0</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
      ];
      for (const [k, v] of objects.entries()) {
        if (!qPrefix || k.startsWith(qPrefix)) {
          const escapedKey = k.replace(/&/g, "&amp;");
          itemsXml.push(
            `<Contents><Key>${escapedKey}</Key><Size>${v.body.byteLength}</Size><LastModified>${v.lastModified}</LastModified><ETag>${v.etag}</ETag></Contents>`,
          );
        }
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult>
          <Name>my-b2-bucket</Name>
          <IsTruncated>false</IsTruncated>
          ${itemsXml.join("\n")}
        </ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
    }

    // PutObject
    if (method === "PUT" && decodedKey) {
      lastPutHeaders = Object.fromEntries(headers.entries());
      const rawBody = init?.body as Uint8Array;
      const bodyBytes =
        rawBody instanceof Uint8Array
          ? rawBody
          : new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      const expectedSha = await sha256Hex(bodyBytes);
      assert.equal(headers.get("x-amz-content-sha256"), expectedSha);

      const etag = `"${expectedSha.slice(0, 16)}"`;
      objects.set(decodedKey, {
        body: bodyBytes,
        contentType: headers.get("content-type") || "b2/x-auto",
        lastModified: new Date().toISOString(),
        etag,
      });
      return new Response("", { status: 200, headers: { ETag: etag } });
    }

    // GetObject / HeadObject
    if ((method === "GET" || method === "HEAD") && decodedKey) {
      b2GetCalls++;
      const found = objects.get(decodedKey);
      if (!found) {
        return new Response("<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>", {
          status: 404,
        });
      }
      return new Response(method === "HEAD" ? null : found.body, {
        status: 200,
        headers: {
          "Content-Type": found.contentType,
          "Content-Length": String(found.body.byteLength),
          ETag: found.etag,
        },
      });
    }

    // DeleteObject
    if (method === "DELETE" && decodedKey) {
      objects.delete(decodedKey);
      return new Response(null, { status: 204 });
    }

    return new Response("Unhandled mock route", { status: 500 });
  };

  const env: Env = {
    B2_KEY_ID: "004keyid",
    B2_APPLICATION_KEY: "K004secretapplicationkey",
    B2_BUCKET: "my-b2-bucket",
    B2_ENDPOINT: "s3.us-west-004.backblazeb2.com",
    AUTH_TOKEN: "super-secret-token-123",
    ...overrides,
  };

  return {
    env,
    objects,
    mockFetch,
    getB2GetCalls: () => b2GetCalls,
    getLastPutHeaders: () => lastPutHeaders,
  };
}

describe("AWS Signature V4 & Backblaze B2 S3 Utilities", () => {
  it("matches the official AWS S3 Signature Version 4 GET Object test vector", async () => {
    const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const signed = await signS3Request({
      method: "GET",
      origin: "https://examplebucket.s3.amazonaws.com",
      host: "examplebucket.s3.amazonaws.com",
      canonicalUri: "/test.txt",
      headers: {
        range: "bytes=0-9",
      },
      payloadHash: emptySha256,
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      now: new Date("2013-05-24T00:00:00.000Z"),
    });

    assert.equal(
      signed.signature,
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("RFC-3986 encodes special characters including !'()* and UTF-8 while preserving slashes when requested", () => {
    assert.equal(
      awsUriEncode("2026/11/photo (1)!*.webp", false),
      "2026/11/photo%20%281%29%21%2A.webp",
    );
    assert.equal(awsUriEncode("a/b", true), "a%2Fb");
  });

  it("auto-extracts region from Backblaze B2 S3 endpoints", () => {
    const p1 = parseEndpointAndRegion("s3.us-west-004.backblazeb2.com", "my-bucket");
    assert.equal(p1.origin, "https://s3.us-west-004.backblazeb2.com");
    assert.equal(p1.region, "us-west-004");
    assert.equal(p1.isVirtualHosted, false);

    const p2 = parseEndpointAndRegion(
      "https://my-bucket.s3.eu-central-003.backblazeb2.com/",
      "my-bucket",
      "us-west-004",
    );
    assert.equal(p2.region, "eu-central-003");
    assert.equal(p2.isVirtualHosted, true);
  });

  it("retains the configured signing region for custom S3 endpoints", () => {
    const endpoint = "https://s3.example.com";
    assert.equal(parseEndpointAndRegion(endpoint, "my-bucket", " eu-central-003 ").region, "eu-central-003");
    assert.equal(parseEndpointAndRegion(endpoint, "my-bucket", " ").region, "us-west-004");
  });

  it("parses ListObjectsV2 XML, decodes entities, and skips .bzEmpty", () => {
    const parsed = parseListObjectsXml(`
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>tok_abc</NextContinuationToken>
        <Contents>
          <Key>folder/.bzEmpty</Key>
          <Size>0</Size>
          <LastModified>2026-11-18T00:00:00.000Z</LastModified>
        </Contents>
        <Contents>
          <Key>2026/11/a&amp;b.webp</Key>
          <Size>4096</Size>
          <LastModified>2026-11-18T01:00:00.000Z</LastModified>
          <ETag>"etag1"</ETag>
        </Contents>
      </ListBucketResult>
    `);
    assert.equal(parsed.objects.length, 1);
    assert.equal(parsed.objects[0].key, "2026/11/a&b.webp");
    assert.equal(parsed.objects[0].size, 4096);
    assert.equal(parsed.isTruncated, true);
    assert.equal(parsed.nextCursor, "tok_abc");
  });

  it("matches wildcard Referer domain patterns accurately", () => {
    assert.equal(matchDomainPattern("blog.example.com", "*.example.com"), true);
    assert.equal(matchDomainPattern("example.com", "*.example.com"), true);
    assert.equal(matchDomainPattern("badexample.com", "*.example.com"), false);
  });
});

describe("Cloudflare Worker End-to-End Flows", () => {
  it("supports session login, multipart upload, Edge Cache HIT/MISS, 304, gallery listing, and cache-purging delete", async () => {
    const mockCache = new MockEdgeCache();
    (globalThis as unknown as { caches: { default: MockEdgeCache } }).caches = {
      default: mockCache,
    };

    const { env, mockFetch, objects, getB2GetCalls, getLastPutHeaders } = createMockB2Environment({
      B2_ENDPOINT: "s3.us-east-005.backblazeb2.com",
      B2_REGION: "us-west-004",
    });
    Object.assign(env, { UPLOAD_PREFIX: "legacy" });
    const legacyKey = "legacy/old.png";
    objects.set(legacyKey, {
      body: SAMPLE_PNG,
      contentType: "image/png",
      lastModified: "2025-01-01T00:00:00.000Z",
      etag: '"legacy"',
    });

    // 1. Unauthenticated upload should fail with 401
    const unauthForm = new FormData();
    unauthForm.append("file", new File([SAMPLE_PNG], "shot.png", { type: "image/png" }));
    const unauthRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/upload", { method: "POST", body: unauthForm }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(unauthRes.status, 401);

    // 2. Login via Web UI endpoint -> receive HttpOnly session cookie
    const loginRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "super-secret-token-123" }),
      }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get("Set-Cookie") || "";
    assert.ok(setCookie.includes("cf_img_session="));
    const cookieHeader = setCookie.split(";")[0];

    // 3. Upload PNG via session cookie
    const fd = new FormData();
    fd.append("file", new File([SAMPLE_PNG], "my photo (1).png", { type: "image/png" }));
    fd.append("naming", "date-original");
    fd.append("folder", "blog");

    const upRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/upload", {
        method: "POST",
        headers: { Cookie: cookieHeader },
        body: fd,
      }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(upRes.status, 200);
    const upJson = (await upRes.json()) as {
      success: boolean;
      key: string;
      url: string;
      data: { url: string };
      links: { markdown: string; html: string; bbcode: string };
    };
    assert.equal(upJson.success, true);
    assert.ok(upJson.key.startsWith("blog/"));
    assert.equal(upJson.url, upJson.data.url);
    assert.ok(upJson.links.markdown.includes(upJson.url));
    assert.equal(getLastPutHeaders()["content-length"], String(SAMPLE_PNG.byteLength));
    assert.match(getLastPutHeaders().authorization, /\/us-east-005\/s3\/aws4_request,/);

    // 4. Reject non-image disguised binary
    const fakeExe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // MZ header, no image mime
    const badFd = new FormData();
    badFd.append("file", new File([fakeExe], "malware.exe", { type: "application/octet-stream" }));
    const badRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/upload", {
        method: "POST",
        headers: { "X-API-Key": "super-secret-token-123" },
        body: badFd,
      }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(badRes.status, 415);

    // 5. Public Image Delivery: 1st request -> Edge Cache MISS, fetches from B2
    const imgRes1 = await handleWorkerRequest(
      new Request(upJson.url),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(imgRes1.status, 200);
    assert.equal(imgRes1.headers.get("X-Cache"), "MISS");
    assert.equal(imgRes1.headers.get("Content-Type"), "image/png");
    assert.equal(getB2GetCalls(), 1);
    const etag = imgRes1.headers.get("ETag");
    assert.ok(etag);

    // 6. 2nd request -> Edge Cache HIT without hitting B2 again!
    const imgRes2 = await handleWorkerRequest(
      new Request(upJson.url),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(imgRes2.status, 200);
    assert.equal(imgRes2.headers.get("X-Cache"), "HIT");
    assert.equal(getB2GetCalls(), 1);

    // 7. Conditional If-None-Match -> 304 Not Modified from Edge Cache
    const imgRes304 = await handleWorkerRequest(
      new Request(upJson.url, { headers: { "If-None-Match": etag! } }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(imgRes304.status, 304);
    assert.equal(getB2GetCalls(), 1);

    // 8. SVG upload & XSS sandbox CSP verification (also test PicGo ?key= auth)
    const svgFd = new FormData();
    svgFd.append("smfile", new File([SAMPLE_SVG], "icon.svg", { type: "image/svg+xml" }));
    const svgUp = await handleWorkerRequest(
      new Request("https://img.example.com/upload?key=super-secret-token-123", {
        method: "POST",
        body: svgFd,
      }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(svgUp.status, 200);
    const svgJson = (await svgUp.json()) as { url: string; key: string };
    const svgGet = await handleWorkerRequest(
      new Request(svgJson.url),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(svgGet.status, 200);
    assert.ok((svgGet.headers.get("Content-Security-Policy") || "").includes("sandbox"));

    // 9. Gallery list returns new and legacy images (and excludes .bzEmpty)
    const listRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/images", {
        headers: { Authorization: "Bearer super-secret-token-123" },
      }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as { items: Array<{ key: string }>; folders: string[] };
    assert.deepEqual(
      listData.items.map((item) => item.key).sort(),
      [upJson.key, svgJson.key, legacyKey].sort(),
    );
    assert.ok(listData.folders.includes("legacy"));

    const legacyListRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/images?prefix=legacy", {
        headers: { Authorization: "Bearer super-secret-token-123" },
      }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(legacyListRes.status, 200);
    const legacyList = (await legacyListRes.json()) as { items: Array<{ key: string; url: string }> };
    const legacyUrl = "https://img.example.com/i/legacy/old.png";
    assert.deepEqual(legacyList.items.map(({ key, url }) => ({ key, url })), [
      { key: legacyKey, url: legacyUrl },
    ]);
    const legacyImage = await handleWorkerRequest(new Request(legacyUrl), env, undefined, mockFetch);
    assert.equal(legacyImage.status, 200);

    // 10. Delete image -> removes from B2 AND purges Edge Cache
    const delRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/images", {
        method: "DELETE",
        headers: {
          Authorization: "Bearer super-secret-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ keys: [upJson.key] }),
      }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(delRes.status, 200);

    const afterDelGet = await handleWorkerRequest(
      new Request(upJson.url),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(afterDelGet.status, 404);
  });

  it("enforces Referer hotlink protection even when image is cached at the edge", async () => {
    const mockCache = new MockEdgeCache();
    (globalThis as unknown as { caches: { default: MockEdgeCache } }).caches = {
      default: mockCache,
    };

    const { env, mockFetch } = createMockB2Environment({
      ALLOWED_REFERERS: "mysite.com, *.trusted.org",
      ALLOW_EMPTY_REFERER: "false",
    });

    const fd = new FormData();
    fd.append("file", new File([SAMPLE_PNG], "protected.png", { type: "image/png" }));
    const upRes = await handleWorkerRequest(
      new Request("https://img.example.com/api/upload", {
        method: "POST",
        headers: { "X-API-Key": "super-secret-token-123" },
        body: fd,
      }),
      env,
      undefined,
      mockFetch,
    );
    const { url } = (await upRes.json()) as { url: string };

    // Allowed wildcard subdomain -> 200 OK (populates cache)
    const okRes = await handleWorkerRequest(
      new Request(url, { headers: { Referer: "https://docs.trusted.org/article" } }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(okRes.status, 200);

    // Same-origin admin gallery Referer -> 200 OK (HIT)
    const adminRes = await handleWorkerRequest(
      new Request(url, { headers: { Referer: "https://img.example.com/" } }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.headers.get("X-Cache"), "HIT");

    // Unauthorized hotlinker -> 403 Forbidden (despite cache entry existing!)
    const hotlinkRes = await handleWorkerRequest(
      new Request(url, { headers: { Referer: "https://thief-site.io/post" } }),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(hotlinkRes.status, 403);

    // Empty Referer when ALLOW_EMPTY_REFERER = "false" -> 403 Forbidden
    const emptyRefRes = await handleWorkerRequest(
      new Request(url),
      env,
      undefined,
      mockFetch,
    );
    assert.equal(emptyRefRes.status, 403);
  });
});
