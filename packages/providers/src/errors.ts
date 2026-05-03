/**
 * normalizeProviderError — flatten heterogeneous provider SDK errors into a
 * single shape for structured logging.
 *
 * PRINCIPLES §10 (errors loud): every upstream failure carries enough
 * identity (status, request-id) to be reproducible, with secrets scrubbed.
 *
 * NOTE: a near-identical API_KEY_RE lives in
 * apps/desktop/src/main/diagnostics-ipc.ts — we duplicate the constant here
 * instead of importing across module layers. Per CLAUDE.md "three similar
 * lines is fine", the duplication is intentional.
 */

import { CodesignError } from '@open-codesign/shared';

const API_KEY_RE =
  /(sk-[A-Za-z0-9-_]{20,}|AIzaSy[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/]{43}=|[A-Fa-f0-9]{32,}|Bearer\s+[A-Za-z0-9._~+/=-]+)/g;
const REDACTION = '***REDACTED***';
const BODY_HEAD_LIMIT = 512;

const REQUEST_ID_KEYS = [
  'x-request-id',
  'request-id',
  'openai-request-id',
  'anthropic-request-id',
  'x-amzn-requestid',
];

export interface NormalizedProviderError {
  upstream_provider: string;
  upstream_status: number | undefined;
  upstream_code: string | undefined;
  upstream_message: string;
  upstream_request_id: string | undefined;
  retry_count: number;
  redacted_body_head: string | undefined;
  original_error_name: string;
}

function scrub(s: string): string {
  return s.replace(API_KEY_RE, REDACTION);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function extractCode(err: Record<string, unknown>): string | undefined {
  const direct = pickString(err['code']);
  if (direct !== undefined) return direct;
  const errorField = asRecord(err['error']);
  const viaError = errorField ? pickString(errorField['code']) : undefined;
  if (viaError !== undefined) return viaError;
  const response = asRecord(err['response']);
  const data = response ? asRecord(response['data']) : undefined;
  const dataError = data ? asRecord(data['error']) : undefined;
  return dataError ? pickString(dataError['code']) : undefined;
}

function extractMessage(err: unknown, errRec: Record<string, unknown>): string {
  const direct = pickString(errRec['message']);
  if (direct !== undefined) return direct;
  const response = asRecord(errRec['response']);
  const data = response ? asRecord(response['data']) : undefined;
  const dataError = data ? asRecord(data['error']) : undefined;
  const viaData = dataError ? pickString(dataError['message']) : undefined;
  if (viaData !== undefined) return viaData;
  const errorField = asRecord(errRec['error']);
  const viaError = errorField ? pickString(errorField['message']) : undefined;
  if (viaError !== undefined) return viaError;
  return String(err);
}

interface HeadersLike {
  get?: (key: string) => string | null | undefined;
  [key: string]: unknown;
}

function headerLookup(headers: HeadersLike, key: string): string | undefined {
  if (typeof headers.get === 'function') {
    const value = headers.get(key);
    if (typeof value === 'string' && value.length > 0) return value;
    return undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === key && typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

function extractRequestId(err: Record<string, unknown>): string | undefined {
  const response = asRecord(err['response']);
  const sources: HeadersLike[] = [];
  const responseHeaders = response ? (response['headers'] as unknown) : undefined;
  if (responseHeaders && typeof responseHeaders === 'object') {
    sources.push(responseHeaders as HeadersLike);
  }
  const errHeaders = err['headers'];
  if (errHeaders && typeof errHeaders === 'object') {
    sources.push(errHeaders as HeadersLike);
  }
  for (const source of sources) {
    for (const key of REQUEST_ID_KEYS) {
      const value = headerLookup(source, key);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function extractBodyHead(err: Record<string, unknown>): string | undefined {
  const response = asRecord(err['response']);
  let raw: string | undefined;
  if (response && 'data' in response) {
    const data = response['data'];
    if (typeof data === 'string') {
      raw = data;
    } else if (data && typeof data === 'object') {
      try {
        raw = JSON.stringify(data);
      } catch {
        raw = undefined;
      }
    }
  }
  if (raw === undefined) {
    const responseBody = pickString(err['responseBody']);
    if (responseBody !== undefined) raw = responseBody;
  }
  if (raw === undefined) return undefined;
  return scrub(raw).slice(0, BODY_HEAD_LIMIT);
}

function extractErrorName(err: unknown, errRec: Record<string, unknown>): string {
  const direct = pickString(errRec['name']);
  if (direct !== undefined) return direct;
  if (err && typeof err === 'object') {
    const ctor = (err as { constructor?: { name?: unknown } }).constructor;
    if (ctor && typeof ctor.name === 'string' && ctor.name.length > 0) {
      return ctor.name;
    }
  }
  return 'UnknownError';
}

export function normalizeProviderError(
  err: unknown,
  provider: string,
  retryCount: number,
): NormalizedProviderError {
  const rec = asRecord(err) ?? {};
  const rawMessage = extractMessage(err, rec);
  return {
    upstream_provider: provider,
    // Use the public helper so logged `upstream_status` reflects status
    // recovered from a CodesignError-wrapped Anthropic JSON body too — not
    // just SDK-style numeric properties.
    upstream_status: extractHttpStatus(err),
    upstream_code: extractCode(rec),
    upstream_message: scrub(rawMessage),
    upstream_request_id: extractRequestId(rec),
    retry_count: retryCount,
    redacted_body_head: extractBodyHead(rec),
    original_error_name: extractErrorName(err, rec),
  };
}

/**
 * Map a provider's structured error `type` to the HTTP status it would have
 * carried. pi-ai's stream surfaces upstream failures as an assistant message
 * with the raw JSON body in `errorMessage` — by the time we see it, the HTTP
 * status is gone. Recovering it from the body is the only way the retry layer
 * can classify these (`overloaded_error` → 529 → retry; `authentication_error`
 * → 401 → no retry).
 *
 * Anthropic's published taxonomy:
 *   https://docs.anthropic.com/en/api/errors
 */
const ANTHROPIC_ERROR_TYPE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

export interface ParsedUpstreamError {
  /** HTTP status inferred from the structured error type. */
  status: number;
  /** The provider's own short code (e.g. 'overloaded_error'). */
  type: string;
  /** The human-readable message from the provider (e.g. "Overloaded"). */
  providerMessage: string | undefined;
  /** Anthropic-style request id (e.g. 'req_011…'), useful for support tickets. */
  requestId: string | undefined;
}

/**
 * Best-effort parse of an upstream error payload that has been flattened to a
 * string. Recognises Anthropic's `{"type":"error","error":{"type":"…"}}` shape
 * — currently the only provider whose stream-level errors lose status info on
 * the way through pi-ai. Returns undefined for unrecognised shapes so callers
 * fall back to existing classification.
 */
export function parseUpstreamErrorMessage(message: string): ParsedUpstreamError | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  if (!root) return undefined;
  const inner = asRecord(root['error']);
  const type = pickString(inner?.['type']);
  if (type === undefined) return undefined;
  const status = ANTHROPIC_ERROR_TYPE_STATUS[type];
  if (status === undefined) return undefined;
  return {
    status,
    type,
    providerMessage: pickString(inner?.['message']),
    requestId: pickString(root['request_id']),
  };
}

/**
 * Single source of truth for "what HTTP status does this error carry?".
 * Used by:
 *   - retry.ts (classify transient vs. permanent)
 *   - normalizeProviderError (structured logging)
 *   - core/errors.ts remapProviderError (4xx URL-rewriting)
 *
 * Lookup order:
 *   1. SDK-style numeric `status` / `statusCode` / `response.status`
 *   2. CodesignError carrying an Anthropic JSON body (overloaded_error → 529)
 *   3. Fallback: a 3-digit token in any Error message ("HTTP 503 …")
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidates = [
    (err as { status?: unknown }).status,
    (err as { statusCode?: unknown }).statusCode,
    (err as { response?: { status?: unknown } }).response?.status,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  if (err instanceof CodesignError) {
    const upstream = parseUpstreamErrorMessage(err.message);
    if (upstream !== undefined) return upstream.status;
  }
  if (err instanceof Error) {
    const m = /\b(\d{3})\b/.exec(err.message);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (n >= 400 && n < 600) return n;
    }
  }
  return undefined;
}

/**
 * Map a provider error type to the Codesign error code that best describes
 * it for renderer-level routing. Used when re-throwing a stream-level error so
 * the friendly user message ("Anthropic is overloaded — retried automatically")
 * survives the trip across IPC. Unknown types fall back to PROVIDER_ERROR.
 */
export function errorCodeForUpstreamType(type: string): string {
  switch (type) {
    case 'overloaded_error':
      return 'PROVIDER_OVERLOADED';
    case 'rate_limit_error':
      return 'PROVIDER_RATE_LIMITED';
    case 'authentication_error':
      return 'PROVIDER_AUTH_MISSING';
    default:
      return 'PROVIDER_ERROR';
  }
}
