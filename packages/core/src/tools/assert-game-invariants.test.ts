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
