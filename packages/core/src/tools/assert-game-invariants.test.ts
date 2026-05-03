/**
 * gameplan §E2 — assert_game_invariants tests.
 */

import { describe, expect, it } from 'vitest';
import { assertGameInvariants, makeAssertGameInvariantsTool } from './assert-game-invariants';

function deps(files: Array<{ path: string; content: string }>) {
  return { listFiles: () => files };
}

describe('assertGameInvariants', () => {
  it('returns ok=true when all four invariants are present in JS source', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onCollision() {
              score += 10;
              new Audio('coin.wav').play();
            }
            function onGameOver() { /* lose */ }
            window.addEventListener('keydown', (e) => {
              if (e.code === 'KeyR') restartGame();
            });
            function restartGame() { score = 0; }
          `,
        },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('warns on missing restart', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onGameOver() {}
            function onHit() { score += 1; new Audio('hit.wav').play(); }
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('restart');
  });

  it('warns on missing fail state', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onCoin() { score += 1; new Audio('coin.wav').play(); }
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('fail-state');
  });

  it('warns on missing score / state mutation', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            function onHit() { gameOver(); new Audio('hit.wav').play(); }
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') reset(); });
            function reset() {}
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('score-or-state');
  });

  it('warns on missing feedback', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onHit() { score += 1; gameOver(); }
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ]),
    );
    expect(result.issues.map((i) => i.invariant)).toContain('feedback');
  });

  it('passes Pygame projects that use pygame.K_r + pygame.mixer.Sound', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'main.py',
          content: `
import pygame
pygame.init()
score = 0
hit = pygame.mixer.Sound('hit.wav')
def on_collision():
    global score
    score += 1
    hit.play()
def on_death():
    global game_over
    game_over = True
for event in pygame.event.get():
    if event.type == pygame.KEYDOWN and event.key == pygame.K_r:
        score = 0
          `,
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('passes Godot projects that use ui_select + AudioStreamPlayer', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'scripts/main.gd',
          content: `
extends Node2D
var score = 0
@onready var hit_sfx: AudioStreamPlayer = $HitSfx
func _physics_process(_delta):
    if Input.is_action_just_pressed("ui_select"):
        score = 0
func _on_collision():
    score += 1
    hit_sfx.play()
func _on_death():
    print("game over")
          `,
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('skips data:base64 binary content (e.g. inlined PNGs / WAVs)', () => {
    const result = assertGameInvariants(
      deps([
        { path: 'assets/sprite.png', content: 'data:base64,iVBORw0KGgo=' },
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onCollision() { score += 1; new Audio().play(); }
            function onGameOver() {}
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('produces all four invariant warnings for an empty / unhelpful project', () => {
    const result = assertGameInvariants(
      deps([{ path: 'src/main.js', content: 'console.log("hi")' }]),
    );
    expect(result.issues.length).toBe(4);
    expect(result.issues.map((i) => i.invariant).sort()).toEqual([
      'fail-state',
      'feedback',
      'restart',
      'score-or-state',
    ]);
  });
});

describe('makeAssertGameInvariantsTool', () => {
  it('returns a no-op-args tool that surfaces a friendly summary', async () => {
    const tool = makeAssertGameInvariantsTool({
      listFiles: () => [{ path: 'src/main.js', content: 'console.log("hi")' }],
    });
    const result = await tool.execute('call-1', {});
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('4 game invariant(s) appear missing');
    expect(text).toContain('restart');
    expect(result.details?.ok).toBe(false);
  });

  it('returns the green-light text when everything passes', async () => {
    const tool = makeAssertGameInvariantsTool({
      listFiles: () => [
        {
          path: 'src/main.js',
          content: `
            let score = 0;
            function onCollision() { score += 1; new Audio().play(); }
            function onGameOver() {}
            window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
          `,
        },
      ],
    });
    const result = await tool.execute('call-2', {});
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('All four game invariants present');
    expect(result.details?.ok).toBe(true);
  });
});

describe('assertGameInvariants brawler-specific checks (Sequence 6)', () => {
  const baseFour = `
    let score = 0;
    function onCollision() { score += 1; new Audio().play(); }
    function onGameOver() {}
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyR') score = 0; });
  `;

  it('flags missing combo, hitstop, limbs on a bare brawler skeleton (and tags genre)', () => {
    const result = assertGameInvariants(deps([{ path: 'src/main.js', content: baseFour }]), {
      genre: 'brawler',
    });
    const ids = result.issues.map((i) => i.invariant);
    expect(ids).toContain('brawler-combo');
    expect(ids).toContain('brawler-hitstop');
    expect(ids).toContain('brawler-per-attack-limb');
    expect(result.checked).toContain('brawler-combo');
    expect(result.genre).toBe('brawler');
  });

  it('passes the brawler combo check when combo / multiplier / lastAttack are wired', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nlet combo = 0; let multiplier = 1; const lastAttack = null;`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-combo');
  });

  it('passes hitstop when any of the wake-words appear', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nfunction applyHitstop() { staggerFrames = 6; }`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-hitstop');
  });

  it('passes per-attack-limb when at least two limb identifiers are present', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nconst leftArm = mesh; const rightFist = mesh; jab();`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-per-attack-limb');
  });

  it('flags the c44763af `rotation.y = -playerAngle` bug as an aim/hitbox parity violation', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nplayerGroup.rotation.y = -playerAngle;`,
        },
      ]),
      { genre: 'brawler' },
    );
    const issue = result.issues.find((i) => i.invariant === 'brawler-aim-hitbox-parity');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/c44763af/);
  });

  it('does NOT flag aim/hitbox parity on the corrected `rotation.y = playerAngle`', () => {
    const result = assertGameInvariants(
      deps([
        {
          path: 'src/main.js',
          content: `${baseFour}\nplayerGroup.rotation.y = playerAngle;`,
        },
      ]),
      { genre: 'brawler' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-aim-hitbox-parity');
  });

  it('does NOT add brawler checks when genre is not "brawler" (e.g. puzzle game)', () => {
    const result = assertGameInvariants(
      deps([{ path: 'src/main.js', content: `${baseFour}\nrotation.y = -playerAngle;` }]),
      { genre: 'puzzle' },
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-combo');
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-aim-hitbox-parity');
    expect(result.checked).not.toContain('brawler-combo');
  });

  it('design-mode (no genre) keeps the original four-check behaviour unchanged', () => {
    const result = assertGameInvariants(
      deps([{ path: 'src/main.js', content: `${baseFour}\nrotation.y = -playerAngle;` }]),
    );
    expect(result.issues.map((i) => i.invariant)).not.toContain('brawler-aim-hitbox-parity');
    expect(result.checked).toEqual(['restart', 'fail-state', 'score-or-state', 'feedback']);
    expect(result.genre).toBeNull();
  });
});

describe('assert_game_invariants tool (genre param wiring)', () => {
  it('forwards the genre arg into assertGameInvariants', async () => {
    const tool = makeAssertGameInvariantsTool({
      listFiles: () => [{ path: 'src/main.js', content: 'rotation.y = -playerAngle;' }],
    });
    const result = await tool.execute('call-x', { genre: 'brawler' });
    const details = result.details as {
      issues: Array<{ invariant: string }>;
      genre: string | null;
    };
    expect(details.genre).toBe('brawler');
    expect(details.issues.map((i) => i.invariant)).toContain('brawler-aim-hitbox-parity');
  });
});
