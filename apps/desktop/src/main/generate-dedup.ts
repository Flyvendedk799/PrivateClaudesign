/**
 * Helpers for collapsing accidental concurrent `codesign:v1:generate`
 * IPC calls. Extracted from `index.ts` so the dedup behavior can be
 * unit-tested without spinning up the full IPC stack.
 *
 * The two-key strategy: primary key is the renderer-minted generationId
 * (a duplicate IPC of the same submit collides on this), secondary key is
 * a content fingerprint (a double-click that minted distinct generationIds
 * but identical payloads collides on this).
 */

export interface DedupablePayload {
  designId?: string | undefined;
  prompt: string;
  attachments: unknown;
}

/** Stable string fingerprint of a generate payload. Includes designId so
 *  the same prompt against two designs does NOT collapse. */
export function generateDedupKey(payload: DedupablePayload): string {
  const designId = payload.designId ?? '<no-design>';
  return `${designId}|${payload.prompt}|${JSON.stringify(payload.attachments)}`;
}

/** Short fingerprint for log lines — full content key may carry prompt
 *  text we don't want logged verbatim. djb2; cheap and stable enough for
 *  correlating dedup decisions across log entries. */
export function hashContentKey(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Look up an in-flight promise for a duplicate of `payload`, or undefined
 *  when this is a fresh request. Pure — does not register the new promise. */
export function findInFlightDuplicate<T>(opts: {
  generationId: string;
  contentKey: string;
  inFlightById: Map<string, Promise<T>>;
  inFlightContentToId: Map<string, string>;
}): Promise<T> | undefined {
  const direct = opts.inFlightById.get(opts.generationId);
  if (direct !== undefined) return direct;
  const otherId = opts.inFlightContentToId.get(opts.contentKey);
  if (otherId === undefined || otherId === opts.generationId) return undefined;
  return opts.inFlightById.get(otherId);
}
