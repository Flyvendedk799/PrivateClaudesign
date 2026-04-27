/**
 * USE_AGENT_RUNTIME resolution. Lifted out of `index.ts` so unit tests can
 * import the function without pulling in Electron and the rest of the main
 * process initialization.
 *
 * Default ON: streaming + tool-using agent loop is the primary path now.
 * `USE_AGENT_RUNTIME=0` or `USE_AGENT_RUNTIME=false` opts out and keeps the
 * legacy single-turn `generate()` path as an escape hatch.
 */
export function resolveUseAgentRuntime(envValue: string | undefined): boolean {
  if (envValue === '0' || envValue === 'false') return false;
  return true;
}
