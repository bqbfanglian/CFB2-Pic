import type { Env } from "./types.ts";

const encoder = new TextEncoder();
const SESSION_COOKIE_NAME = "cf_img_session";
const SESSION_SALT = "cf-b2-image-host-session-v1";
const TIMING_SAFE_KEY_RAW = encoder.encode("cf-b2-timing-safe-compare-key");

let cachedCompareKeyPromise: Promise<CryptoKey> | null = null;

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

function getCompareKey(): Promise<CryptoKey> {
  if (!cachedCompareKeyPromise) {
    cachedCompareKeyPromise = crypto.subtle.importKey(
      "raw",
      toBuffer(TIMING_SAFE_KEY_RAW),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedCompareKeyPromise;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time string comparison via HMAC-SHA256 digest equality.
 * Prevents timing side-channel leaks of token content or token length.
 */
export async function timingSafeEqualString(candidate: string, expected: string): Promise<boolean> {
  if (!candidate || !expected) return false;
  const key = await getCompareKey();
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, toBuffer(encoder.encode(candidate))),
    crypto.subtle.sign("HMAC", key, toBuffer(encoder.encode(expected))),
  ]);
  const a = new Uint8Array(sigA);
  const b = new Uint8Array(sigB);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function deriveSessionSignature(authToken: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBuffer(encoder.encode(authToken)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, toBuffer(encoder.encode(SESSION_SALT)));
  return bytesToHex(new Uint8Array(sig));
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(val);
      } catch {
        cookies[name] = val;
      }
    }
  }
  return cookies;
}

export async function buildSessionSetCookie(authToken: string, isSecure: boolean): Promise<string> {
  const sig = await deriveSessionSignature(authToken);
  const parts = [
    `${SESSION_COOKIE_NAME}=${sig}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 30}`, // 30 days
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function buildClearSessionCookie(isSecure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export interface AuthCheckOptions {
  allowQueryKey?: boolean;
  extraCandidateToken?: string | null;
}

export async function isAuthorized(
  request: Request,
  env: Env,
  options: AuthCheckOptions = {},
): Promise<boolean> {
  const secret = (env.AUTH_TOKEN || "").trim();
  if (!secret) return false;

  // 1. Authorization header (supports "Bearer <token>" and raw "<token>")
  const authHeader = request.headers.get("Authorization")?.trim();
  if (authHeader) {
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : authHeader;
    if (await timingSafeEqualString(token, secret)) {
      return true;
    }
  }

  // 2. X-API-Key / X-Auth-Token headers (ShareX / PicGo / CLI)
  const headerKey =
    request.headers.get("X-API-Key")?.trim() || request.headers.get("X-Auth-Token")?.trim();
  if (headerKey && (await timingSafeEqualString(headerKey, secret))) {
    return true;
  }

  // 3. Extra candidate token (e.g. form-data field `key` / `token`)
  if (options.extraCandidateToken) {
    if (await timingSafeEqualString(options.extraCandidateToken.trim(), secret)) {
      return true;
    }
  }

  // 4. Optional URL query key (?key=... or ?token=...) for third-party uploader compatibility
  if (options.allowQueryKey) {
    const url = new URL(request.url);
    const queryKey = (url.searchParams.get("key") || url.searchParams.get("token") || "").trim();
    if (queryKey && (await timingSafeEqualString(queryKey, secret))) {
      return true;
    }
  }

  // 5. Stateless HMAC HttpOnly cookie session
  const cookies = parseCookies(request.headers.get("Cookie"));
  const cookieSig = cookies[SESSION_COOKIE_NAME];
  if (cookieSig) {
    const expectedSig = await deriveSessionSignature(secret);
    if (await timingSafeEqualString(cookieSig, expectedSig)) {
      return true;
    }
  }

  return false;
}
