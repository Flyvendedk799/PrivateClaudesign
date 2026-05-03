/**
 * gameplan §3 + §7.1 + §7.6 — Pygame engine adapter tests (Phase C).
 */

import { describe, expect, it } from 'vitest';
import { pygameAdapter } from './pygame';

describe('pygameAdapter shape (gameplan §7.1)', () => {
  it('exposes the gameplan-locked metadata', () => {
    expect(pygameAdapter.id).toBe('pygame');
    expect(pygameAdapter.label).toBe('Pygame');
    expect(pygameAdapter.defaultVersion).toBe('2.5.5');
    expect(pygameAdapter.canonicalEntry).toBe('main.py');
  });

  it('supports live preview (Pyodide-loaded)', () => {
    expect(pygameAdapter.supportsLivePreview()).toBe(true);
  });

  it('lists Pygame-shaped file extensions', () => {
    expect(pygameAdapter.fileExtensions).toContain('py');
    expect(pygameAdapter.fileExtensions).toContain('png');
    expect(pygameAdapter.fileExtensions).toContain('wav');
    expect(pygameAdapter.fileExtensions).toContain('ogg');
  });
});

describe('pygameAdapter.bootstrap (Pyodide loader + MEMFS mount)', () => {
  const opts = {
    designId: 'abc-123',
    gameBaseUrl: 'game-files://designs/abc-123/',
  };

  it('emits doctype + Pyodide loader from cdn.jsdelivr.net', () => {
    const html = pygameAdapter.bootstrap(opts);
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
  });

  it('pins pygame-ce to the gameplan version (2.5.5)', () => {
    const html = pygameAdapter.bootstrap(opts);
    expect(html).toContain("'pygame-ce==2.5.5'");
  });

  it('honours pinnedVersion override', () => {
    const html = pygameAdapter.bootstrap({ ...opts, pinnedVersion: '2.5.6' });
    expect(html).toContain("'pygame-ce==2.5.6'");
  });

  it('shows an honest first-run loader copy (~13 MB cached after this)', () => {
    const html = pygameAdapter.bootstrap(opts);
    expect(html).toContain('Loading Pygame runtime');
    expect(html).toContain('cached after this');
  });

  it('injects <base href> against the game-files:// URL', () => {
    const html = pygameAdapter.bootstrap(opts);
    expect(html).toContain('<base href="game-files://designs/abc-123/"');
  });

  it('sets up the cross-engine __game global with engine="pygame"', () => {
    const html = pygameAdapter.bootstrap({
      ...opts,
      initialParams: { player_speed: 5 },
      startMuted: true,
    });
    expect(html).toContain('window.__game.engine = "pygame"');
    expect(html).toContain('"player_speed":5');
    expect(html).toContain('"startMuted":true');
  });

  it('mounts project files into Pyodide MEMFS at /home/pyodide', () => {
    const html = pygameAdapter.bootstrap(opts);
    expect(html).toContain('/home/pyodide');
    expect(html).toContain('FS.writeFile');
    expect(html).toContain('FS.chdir');
  });

  it('reads main.py from the mounted FS and runs via runPythonAsync', () => {
    const html = pygameAdapter.bootstrap(opts);
    expect(html).toContain("fetch(baseUrl + 'main.py')");
    expect(html).toContain('runPythonAsync(main)');
  });
});

describe('pygameAdapter.validate (gameplan §7.6)', () => {
  const goodMain = `
import pygame
import asyncio

async def main():
    pygame.init()
    screen = pygame.display.set_mode((800, 600))
    clock = pygame.time.Clock()
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
        screen.fill((0, 0, 0))
        pygame.display.flip()
        clock.tick(60)
        await asyncio.sleep(0)

asyncio.ensure_future(main())
`;

  it('returns ok for a well-formed Pygame project', () => {
    const result = pygameAdapter.validate([{ path: 'main.py', content: goodMain }]);
    expect(result.ok).toBe(true);
  });

  it('flags a missing main.py as a hard error', () => {
    const result = pygameAdapter.validate([
      { path: 'entities.py', content: 'import pygame\npygame.init()' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('main.py is missing'))).toBe(true);
  });

  it('flags a missing pygame import', () => {
    const result = pygameAdapter.validate([{ path: 'main.py', content: '# no pygame here' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('import pygame'))).toBe(true);
  });

  it('flags a missing pygame.init() call', () => {
    const noInit = `
import pygame
screen = pygame.display.set_mode((800, 600))
running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
    pygame.display.flip()
`;
    const result = pygameAdapter.validate([{ path: 'main.py', content: noInit }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('pygame.init()'))).toBe(true);
  });

  it('flags a missing event-loop drain', () => {
    const noEvents = `
import pygame
pygame.init()
screen = pygame.display.set_mode((800, 600))
running = True
while running:
    pygame.display.flip()
`;
    const result = pygameAdapter.validate([{ path: 'main.py', content: noEvents }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('pygame.event.get()'))).toBe(true);
  });

  it('warns when pygame.QUIT is not handled', () => {
    const noQuit = `
import pygame
pygame.init()
screen = pygame.display.set_mode((800, 600))
running = True
while running:
    pygame.event.get()
    pygame.display.flip()
`;
    const result = pygameAdapter.validate([{ path: 'main.py', content: noQuit }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const warn = result.issues.find((i) => i.message.includes('pygame.QUIT'));
    expect(warn?.severity).toBe('warn');
  });

  it('flags a missing display.flip / display.update', () => {
    const noFlip = `
import pygame
pygame.init()
screen = pygame.display.set_mode((800, 600))
running = True
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
`;
    const result = pygameAdapter.validate([{ path: 'main.py', content: noFlip }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('pygame.display.flip()'))).toBe(true);
  });

  it('flags pygame.mixer.music.load as a Pyodide-incompatible call', () => {
    const musicStreaming = `${goodMain}
pygame.mixer.music.load('assets/audio/loop.mp3')
pygame.mixer.music.play(-1)
`;
    const result = pygameAdapter.validate([{ path: 'main.py', content: musicStreaming }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('mixer.music.load'))).toBe(true);
  });

  it('flags forbidden network libs (requests, urllib3, aiohttp, httpx)', () => {
    for (const banned of ['requests', 'urllib3', 'aiohttp', 'httpx']) {
      const evil = `${goodMain}\nimport ${banned}\n`;
      const result = pygameAdapter.validate([{ path: 'main.py', content: evil }]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.some((i) => i.message.includes(`import ${banned}`))).toBe(true);
    }
  });
});
