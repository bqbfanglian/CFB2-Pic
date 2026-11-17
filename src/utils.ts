import { normalizePrefix } from "./config.ts";
import type { ImageLinks, NamingStrategy } from "./types.ts";

const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
  heif: "image/heif",
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/heic": "heic",
  "image/heif": "heif",
};

const RANDOM_ALPHABET = "0123456789abcdefghijkmnpqrstuvwxyz";

export function randomId(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += RANDOM_ALPHABET[bytes[i] % RANDOM_ALPHABET.length];
  }
  return out;
}

export function detectImageMime(
  bytes: Uint8Array,
  filename?: string,
  declaredMime?: string,
): string | null {
  // 1. Inspect magic bytes first (prevents disguised non-image binaries)
  if (bytes.length >= 4) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }

    // GIF: GIF87a / GIF89a
    if (
      bytes.length >= 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61
    ) {
      return "image/gif";
    }

    // WebP: RIFF....WEBP
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }

    // BMP: 42 4D ("BM")
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return "image/bmp";
    }

    // ICO: 00 00 01 00
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
      return "image/x-icon";
    }

    // ISO BMFF (AVIF / HEIC / HEIF): bytes 4..7 == "ftyp"
    if (
      bytes.length >= 12 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
      if (brand === "avif" || brand === "avis" || brand === "MA1B".toLowerCase()) {
        return "image/avif";
      }
      if (brand === "heic" || brand === "heix" || brand === "heim" || brand === "heis") {
        return "image/heic";
      }
      if (brand === "mif1" || brand === "msf1" || brand === "heif") {
        return "image/heif";
      }
    }
  }

  // 2. Check SVG text header safely (first 2 KB)
  if (bytes.length > 0) {
    const headText = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
      .trimStart();
    if (
      headText.startsWith("<svg") ||
      (headText.startsWith("<?xml") && /<svg[\s>]/i.test(headText)) ||
      (headText.startsWith("<!DOCTYPE svg") && /<svg[\s>]/i.test(headText))
    ) {
      return "image/svg+xml";
    }
  }

  // 3. Fallback to declared valid image MIME or extension only if not clearly HTML/script
  const cleanDeclared = (declaredMime || "").split(";")[0].trim().toLowerCase();
  if (cleanDeclared && MIME_TO_EXTENSION[cleanDeclared]) {
    return cleanDeclared === "image/jpg" ? "image/jpeg" : cleanDeclared;
  }

  if (filename) {
    const ext = getFileExtension(filename);
    if (ext && EXTENSION_TO_MIME[ext]) {
      return EXTENSION_TO_MIME[ext];
    }
  }

  return null;
}

export function getFileExtension(filenameOrKey: string): string {
  const base = filenameOrKey.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function guessMimeFromKey(key: string): string {
  const ext = getFileExtension(key);
  return EXTENSION_TO_MIME[ext] || "application/octet-stream";
}

export function extensionForMime(mimeType: string, originalFilename?: string): string {
  const mapped = MIME_TO_EXTENSION[mimeType.toLowerCase()];
  if (mapped) return mapped;
  const fromName = originalFilename ? getFileExtension(originalFilename) : "";
  return fromName || "bin";
}

export function sanitizeFilenameStem(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() || "image";
  const dot = base.lastIndexOf(".");
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const cleaned = rawStem
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*#%]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "image";
}

export function normalizeObjectKey(rawKey: string): string | null {
  const cleaned = rawKey.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) return null;
  const segments = cleaned.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      return null;
    }
    if (/[\u0000-\u001f\u007f]/.test(seg)) {
      return null;
    }
  }
  return segments.join("/");
}

export interface BuildKeyOptions {
  originalName: string;
  mimeType: string;
  strategy: NamingStrategy;
  customFolder?: string;
  now?: Date;
}

export function buildObjectKey(options: BuildKeyOptions): string {
  const now = options.now ?? new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const dateDir = `${yyyy}/${mm}/${dd}`;

  const ext = extensionForMime(options.mimeType, options.originalName);
  const prefixParts: string[] = [];

  const subFolder = normalizePrefix(options.customFolder);
  if (subFolder) prefixParts.push(subFolder);

  switch (options.strategy) {
    case "flat-random": {
      prefixParts.push(`${randomId(12)}.${ext}`);
      break;
    }
    case "date-original": {
      const stem = sanitizeFilenameStem(options.originalName);
      prefixParts.push(dateDir, `${stem}-${randomId(4)}.${ext}`);
      break;
    }
    case "original": {
      const stem = sanitizeFilenameStem(options.originalName);
      prefixParts.push(`${stem}.${ext}`);
      break;
    }
    case "date-random":
    default: {
      prefixParts.push(dateDir, `${randomId(10)}.${ext}`);
      break;
    }
  }

  return prefixParts.join("/");
}

export function encodeKeyForPublicPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function resolvePublicBaseUrl(request: Request, configuredBaseUrl?: string): string {
  if (configuredBaseUrl && configuredBaseUrl.trim()) {
    return configuredBaseUrl.trim().replace(/\/+$/, "");
  }
  return new URL(request.url).origin;
}

export function buildImageLinks(baseUrl: string, key: string, displayName?: string): ImageLinks {
  const encodedPath = encodeKeyForPublicPath(key);
  const direct = `${baseUrl.replace(/\/+$/, "")}/i/${encodedPath}`;
  const alt = (displayName || key.split("/").pop() || "image").replace(/[\[\]"<>]/g, "");
  return {
    direct,
    markdown: `![${alt}](${direct})`,
    html: `<img src="${direct}" alt="${alt}" />`,
    bbcode: `[img]${direct}[/img]`,
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, X-Auth-Token",
      ...extraHeaders,
    },
  });
}
