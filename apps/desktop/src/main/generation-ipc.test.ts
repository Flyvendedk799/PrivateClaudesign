import { CancelGenerationPayloadV1, CodesignError, ERROR_CODES } from '@open-codesign/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armGenerationTimeout,
  cancelGenerationRequest,
  classifyAbortError,
  extractGenerationTimeoutError,
  requestCheckpointAbort,
} from './generation-ipc';

function makeController() {
  return { abort: vi.fn() } as unknown as AbortController;
}

describe('cancelGenerationRequest', () => {
  it('parses the public v1 cancel-generation payload', () => {
    const payload = CancelGenerationPayloadV1.parse({
      schemaVersion: 1,
      generationId: 'gen-1',
    });

    expect(payload).toEqual({
      schemaVersion: 1,
      generationId: 'gen-1',
    });
  });

  it('throws on invalid IPC payloads without aborting in-flight requests', () => {
    const controller = makeController();
    const inFlight = new Map([['gen-1', controller]]);
    const logIpc = { info: vi.fn() };

    expect(() => cancelGenerationRequest(undefined, inFlight, logIpc)).toThrow(CodesignError);
    expect(controller.abort).not.toHaveBeenCalled();
    expect(inFlight.has('gen-1')).toBe(true);
    expect(logIpc.info).not.toHaveBeenCalled();
  });

  it('aborts only the requested generation', () => {
    const target = makeController();
    const other = makeController();
    const inFlight = new Map([
      ['gen-1', target],
      ['gen-2', other],
    ]);
    const logIpc = { info: vi.fn() };

    cancelGenerationRequest('gen-1', inFlight, logIpc);

    expect(target.abort).toHaveBeenCalledOnce();
    expect(other.abort).not.toHaveBeenCalled();
    expect(inFlight.has('gen-1')).toBe(false);
    expect(inFlight.has('gen-2')).toBe(true);
    expect(logIpc.info).toHaveBeenCalledWith('generate.cancelled', { id: 'gen-1' });
  });

  it('is a noop when the generationId is not in the in-flight map', () => {
    const other = makeController();
    const inFlight = new Map([['gen-2', other]]);
    const logIpc = { info: vi.fn() };

    cancelGenerationRequest('gen-unknown', inFlight, logIpc);

    expect(other.abort).not.toHaveBeenCalled();
    expect(inFlight.has('gen-2')).toBe(true);
    expect(logIpc.info).not.toHaveBeenCalled();
  });

  it('rejects CancelGenerationPayloadV1 with empty generationId or missing schemaVersion', () => {
    expect(() => CancelGenerationPayloadV1.parse({ schemaVersion: 1, generationId: '' })).toThrow();
    expect(() => CancelGenerationPayloadV1.parse({ generationId: 'gen-1' })).toThrow();
    expect(() =>
      CancelGenerationPayloadV1.parse({ schemaVersion: 2, generationId: 'gen-1' }),
    ).toThrow();
  });
});

describe('armGenerationTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the controller with a CodesignError after the configured timeout', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };

    const clear = await armGenerationTimeout('gen-1', controller, async () => 5, logger);

    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(CodesignError);
    expect((controller.signal.reason as CodesignError).code).toBe('GENERATION_TIMEOUT');
    expect(logger.warn).toHaveBeenCalledWith('generate.timeout.fired', {
      id: 'gen-1',
      timeoutSec: 5,
    });
    clear();
  });

  it('does not abort when clear() is called before the timeout fires', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };

    const clear = await armGenerationTimeout('gen-1', controller, async () => 60, logger);
    clear();
    vi.advanceTimersByTime(120_000);

    expect(controller.signal.aborted).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('rethrows as PREFERENCES_READ_FAIL when reading preferences fails — never silently unbounded', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };

    await expect(
      armGenerationTimeout(
        'gen-1',
        controller,
        async () => {
          throw new Error('disk gone');
        },
        logger,
      ),
    ).rejects.toMatchObject({
      name: 'CodesignError',
      code: 'PREFERENCES_READ_FAIL',
    });

    expect(controller.signal.aborted).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'generate.timeout.prefs_read_failed',
      expect.objectContaining({ id: 'gen-1', message: 'disk gone' }),
    );
  });

  it('treats 0 as disabled and does not arm a timeout', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };

    const clear = await armGenerationTimeout('gen-1', controller, async () => 0, logger);
    vi.advanceTimersByTime(60_000);
    clear();

    expect(controller.signal.aborted).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('clamps very large timeout values to Node setTimeout int32 cap so the abort does not fire immediately', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const clear = await armGenerationTimeout('gen-1', controller, async () => 99_999_999, logger);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    const delay = setTimeoutSpy.mock.calls[0]?.[1];
    expect(delay).toBe(2_147_483_647);

    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(false);

    setTimeoutSpy.mockRestore();
    clear();
  });

  it('throws PREFERENCES_INVALID_TIMEOUT when the timeout value is NaN', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };

    await expect(
      armGenerationTimeout('gen-1', controller, async () => Number.NaN, logger),
    ).rejects.toMatchObject({ name: 'CodesignError', code: 'PREFERENCES_INVALID_TIMEOUT' });
    expect(controller.signal.aborted).toBe(false);
  });

  it('throws PREFERENCES_INVALID_TIMEOUT when the timeout value is negative', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };

    await expect(
      armGenerationTimeout('gen-1', controller, async () => -1, logger),
    ).rejects.toMatchObject({ name: 'CodesignError', code: 'PREFERENCES_INVALID_TIMEOUT' });
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('extractGenerationTimeoutError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the CodesignError stashed by armGenerationTimeout so the SDK-rewritten AbortError can be upgraded back to GENERATION_TIMEOUT', async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };

    await armGenerationTimeout('gen-1', controller, async () => 3, logger);
    vi.advanceTimersByTime(3000);

    const recovered = extractGenerationTimeoutError(controller.signal);
    expect(recovered).toBeInstanceOf(CodesignError);
    expect(recovered?.code).toBe('GENERATION_TIMEOUT');
    expect(recovered?.message).toContain('3s');
    expect(recovered?.message).toContain('Settings');
  });

  it('returns null when the controller was aborted by a user-initiated cancel (no reason set)', () => {
    const controller = new AbortController();
    controller.abort();
    expect(extractGenerationTimeoutError(controller.signal)).toBeNull();
  });

  it('returns null when the signal has not been aborted', () => {
    const controller = new AbortController();
    expect(extractGenerationTimeoutError(controller.signal)).toBeNull();
  });

  it('returns null when the abort reason is some other CodesignError (not a timeout)', () => {
    const controller = new AbortController();
    controller.abort(new CodesignError('something else', 'PROVIDER_ABORTED'));
    expect(extractGenerationTimeoutError(controller.signal)).toBeNull();
  });
});

describe('requestCheckpointAbort — Backlog-3 §5', () => {
  it('sets the per-id hint without aborting in-flight requests', () => {
    const controller = makeController();
    const inFlight = new Map([['gen-1', controller]]);
    const hints = new Map<string, boolean>();
    const logIpc = { info: vi.fn() };

    requestCheckpointAbort('gen-1', hints, logIpc);

    // Hint set; controller untouched (the agent's turn_end subscriber
    // is responsible for the eventual clean abort).
    expect(hints.get('gen-1')).toBe(true);
    expect(controller.abort).not.toHaveBeenCalled();
    expect(inFlight.has('gen-1')).toBe(true);
    expect(logIpc.info).toHaveBeenCalledWith('generate.cancel.checkpoint_requested', {
      id: 'gen-1',
    });
  });

  it('throws on non-string generationId without mutating the hint Map', () => {
    const hints = new Map<string, boolean>();
    const logIpc = { info: vi.fn() };

    expect(() => requestCheckpointAbort(undefined, hints, logIpc)).toThrow(CodesignError);
    expect(() => requestCheckpointAbort(42, hints, logIpc)).toThrow(CodesignError);
    expect(() => requestCheckpointAbort(null, hints, logIpc)).toThrow(CodesignError);

    expect(hints.size).toBe(0);
    expect(logIpc.info).not.toHaveBeenCalled();
  });

  it('overwrites a prior hint for the same generationId (idempotent)', () => {
    const hints = new Map<string, boolean>();
    const logIpc = { info: vi.fn() };

    requestCheckpointAbort('gen-1', hints, logIpc);
    requestCheckpointAbort('gen-1', hints, logIpc);

    expect(hints.get('gen-1')).toBe(true);
    expect(hints.size).toBe(1);
    expect(logIpc.info).toHaveBeenCalledTimes(2);
  });

  it('hints for different generations stay isolated', () => {
    const hints = new Map<string, boolean>();
    const logIpc = { info: vi.fn() };

    requestCheckpointAbort('gen-1', hints, logIpc);
    requestCheckpointAbort('gen-2', hints, logIpc);

    expect(hints.get('gen-1')).toBe(true);
    expect(hints.get('gen-2')).toBe(true);
    expect(hints.has('gen-3')).toBe(false);
  });
});

describe('CancelGenerationPayloadV1 — Backlog-3 §5 asCheckpoint', () => {
  it('parses the optional asCheckpoint flag', () => {
    const payload = CancelGenerationPayloadV1.parse({
      schemaVersion: 1,
      generationId: 'gen-1',
      asCheckpoint: true,
    });
    expect(payload.asCheckpoint).toBe(true);
  });

  it('asCheckpoint is optional — omitting it parses cleanly', () => {
    const payload = CancelGenerationPayloadV1.parse({
      schemaVersion: 1,
      generationId: 'gen-1',
    });
    expect(payload.asCheckpoint).toBeUndefined();
  });

  it('rejects non-boolean asCheckpoint', () => {
    expect(() =>
      CancelGenerationPayloadV1.parse({
        schemaVersion: 1,
        generationId: 'gen-1',
        asCheckpoint: 'yes',
      }),
    ).toThrow();
  });
});

describe('classifyAbortError — 2026-05-07 STREAM_INTERRUPTED path', () => {
  function abortedSignal(reason?: unknown): AbortSignal {
    const c = new AbortController();
    if (reason !== undefined) c.abort(reason);
    else c.abort();
    return c.signal;
  }

  it('forwards GENERATION_TIMEOUT first when both could match', () => {
    const reason = new CodesignError('timed out', ERROR_CODES.GENERATION_TIMEOUT);
    const got = classifyAbortError(new Error('Request was aborted.'), abortedSignal(reason));
    expect(got?.code).toBe(ERROR_CODES.GENERATION_TIMEOUT);
  });

  it('returns STREAM_INTERRUPTED for an SDK-rethrown abort with no signal marker', () => {
    const got = classifyAbortError(new Error('Request was aborted.'), abortedSignal());
    expect(got?.code).toBe(ERROR_CODES.STREAM_INTERRUPTED);
  });

  it('returns STREAM_INTERRUPTED for the IPC-wrapped variant', () => {
    const got = classifyAbortError(
      new Error(
        "Error invoking remote method 'codesign:v1:generate': CodesignError: Request was aborted.",
      ),
      abortedSignal(),
    );
    expect(got?.code).toBe(ERROR_CODES.STREAM_INTERRUPTED);
  });

  it('returns null when the error message is unrelated', () => {
    expect(classifyAbortError(new Error('Invalid API key'), abortedSignal())).toBeNull();
    expect(classifyAbortError('Some random string', abortedSignal())).toBeNull();
  });

  it('returns null when err is undefined / null', () => {
    expect(classifyAbortError(undefined, abortedSignal())).toBeNull();
    expect(classifyAbortError(null, abortedSignal())).toBeNull();
  });
});
