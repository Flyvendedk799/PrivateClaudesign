import { describe, expect, it } from 'vitest';
import { TOOL_BUCKET_GAP_MS, shouldSplitBucket } from '../ChatMessageList';

describe('shouldSplitBucket (2026-05-07 long-thinking fix)', () => {
  it('splits when the gap between two tool_calls exceeds the configured window', () => {
    const a = '2026-05-07T21:14:00.000Z';
    const b = '2026-05-07T21:14:31.000Z';
    expect(shouldSplitBucket(a, b)).toBe(true);
  });

  it('keeps the bucket together when the gap is within the window', () => {
    const a = '2026-05-07T21:14:00.000Z';
    const b = '2026-05-07T21:14:29.500Z';
    expect(shouldSplitBucket(a, b)).toBe(false);
  });

  it('returns false when either timestamp is missing', () => {
    expect(shouldSplitBucket(undefined, '2026-05-07T21:14:00.000Z')).toBe(false);
    expect(shouldSplitBucket('2026-05-07T21:14:00.000Z', undefined)).toBe(false);
  });

  it('returns false when either timestamp is unparseable', () => {
    expect(shouldSplitBucket('not-a-date', '2026-05-07T21:14:00.000Z')).toBe(false);
    expect(shouldSplitBucket('2026-05-07T21:14:00.000Z', 'also-not-a-date')).toBe(false);
  });

  it('respects a custom gap override', () => {
    const a = '2026-05-07T21:14:00.000Z';
    const b = '2026-05-07T21:14:05.000Z';
    expect(shouldSplitBucket(a, b, 1000)).toBe(true);
    expect(shouldSplitBucket(a, b, 10_000)).toBe(false);
  });

  it('exposes the default gap as a sane (>= 10s, <= 5min) constant', () => {
    expect(TOOL_BUCKET_GAP_MS).toBeGreaterThanOrEqual(10_000);
    expect(TOOL_BUCKET_GAP_MS).toBeLessThanOrEqual(300_000);
  });
});
