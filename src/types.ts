export interface AssetsBinding {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface Env {
  ASSETS?: AssetsBinding;

  // Required Secrets / Vars
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_BUCKET?: string;
  B2_ENDPOINT?: string;
  AUTH_TOKEN?: string;

  // Optional Vars
  B2_REGION?: string; // Fallback signing region for custom S3 endpoints.
  PUBLIC_BASE_URL?: string;
  PATH_STRATEGY?: string;
  MAX_FILE_SIZE_MB?: string;
  CACHE_TTL_SECONDS?: string;
  ALLOWED_REFERERS?: string;
  ALLOW_EMPTY_REFERER?: string;
}

export type NamingStrategy = "date-random" | "date-original" | "flat-random" | "original";

export interface AppConfig {
  b2KeyId: string;
  b2ApplicationKey: string;
  b2Bucket: string;
  b2EndpointOrigin: string;
  b2EndpointHost: string;
  b2Region: string;
  isVirtualHostedEndpoint: boolean;
  authToken: string;
  publicBaseUrl: string;
  pathStrategy: NamingStrategy;
  maxFileSizeBytes: number;
  maxFileSizeMb: number;
  cacheTtlSeconds: number;
  allowedReferers: string[];
  allowEmptyReferer: boolean;
}

export interface ImageLinks {
  direct: string;
  markdown: string;
  html: string;
  bbcode: string;
}

export interface UploadedImageItem {
  key: string;
  url: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: string;
  links: ImageLinks;
}

export interface GalleryImageItem {
  key: string;
  url: string;
  name: string;
  size: number;
  type: string;
  lastModified: string;
  etag?: string;
  links: ImageLinks;
}
