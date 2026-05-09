import { describe, expect, it } from 'vitest';
import { findSteamCmd } from './steam-discovery';

describe('findSteamCmd', () => {
  it('finds steamcmd on PATH', () => {
    const r = findSteamCmd({
      pathEnv: '/usr/local/bin:/opt/homebrew/bin',
      exists: (p) => p === '/opt/homebrew/bin/steamcmd',
      platform: 'darwin',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('/opt/homebrew/bin/steamcmd');
  });

  it('falls back to known macOS install paths when PATH lookup fails', () => {
    const r = findSteamCmd({
      pathEnv: '/empty',
      exists: (p) => p === '/usr/local/bin/steamcmd',
      platform: 'darwin',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('/usr/local/bin/steamcmd');
  });

  it('returns missing when nothing is found', () => {
    const r = findSteamCmd({
      pathEnv: '',
      exists: () => false,
      platform: 'linux',
    });
    expect(r.ok).toBe(false);
  });

  it('looks for steamcmd.exe on Windows', () => {
    const r = findSteamCmd({
      pathEnv: 'C:\\Tools',
      exists: (p) => p === 'C:\\Tools\\steamcmd.exe',
      platform: 'win32',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('C:\\Tools\\steamcmd.exe');
  });
});
