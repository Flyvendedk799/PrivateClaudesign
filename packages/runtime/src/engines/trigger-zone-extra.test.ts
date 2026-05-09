/**
 * may9 Phase 8 follow-up #27 — Three.js / Pygame / Godot trigger-zone
 * structural lint. Phaser's Tiled-JSON walker has its own test file.
 */
import { describe, expect, it } from 'vitest';
import { godotAdapter } from './godot';
import { pygameAdapter } from './pygame';
import { threeAdapter } from './three';

const THREE_INDEX = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body><canvas id="game"></canvas><script type="module" src="src/main.js"></script></body></html>`;

function threeFiles(jsContent: string): { path: string; content: string }[] {
  return [
    { path: 'index.html', content: THREE_INDEX },
    { path: 'src/main.js', content: jsContent },
  ];
}

const THREE_BASE = `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game') });
window.addEventListener('keydown', () => {});
function tick() { requestAnimationFrame(tick); }
tick();`;

describe('threeValidate — trigger-zone contract (Phase 8 #27)', () => {
  it('FLAGS code referencing __game.world.triggers without colliders', () => {
    const result = threeAdapter.validate(
      threeFiles(`${THREE_BASE}
window.__game = window.__game || {};
window.__game.world = window.__game.world || {};
window.__game.world.triggers = [{ name: 'exit', x: 50, y: 0 }];`),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeDefined();
    }
  });

  it('PASSES when both triggers and colliders are exposed', () => {
    const result = threeAdapter.validate(
      threeFiles(`${THREE_BASE}
window.__game = window.__game || {};
window.__game.world = {
  triggers: [{ name: 'exit', x: 50, y: 0 }],
  colliders: [{ box: [0, 0, 100, 100] }],
};
window.addEventListener('keydown', () => {});`),
    );
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeUndefined();
    }
  });

  it('PASSES when there are no triggers at all (no false positives)', () => {
    const result = threeAdapter.validate(threeFiles(THREE_BASE));
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeUndefined();
    }
  });
});

describe('pygameValidate — trigger-zone heuristic (Phase 8 #27)', () => {
  it('FLAGS exit_zone reference without walkable bounds', () => {
    const result = pygameAdapter.validate([
      {
        path: 'main.py',
        content: `import pygame
pygame.init()
screen = pygame.display.set_mode((800, 600))
exit_zone = pygame.Rect(750, 50, 32, 32)
running = True
clock = pygame.time.Clock()
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT: running = False
    pygame.display.flip()
    clock.tick(60)`,
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeDefined();
    }
  });

  it('PASSES when walls / walkable bounds are present', () => {
    const result = pygameAdapter.validate([
      {
        path: 'main.py',
        content: `import pygame
pygame.init()
screen = pygame.display.set_mode((800, 600))
walls = pygame.sprite.Group()
exit_zone = pygame.Rect(750, 50, 32, 32)
running = True
clock = pygame.time.Clock()
while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT: running = False
    pygame.display.flip()
    clock.tick(60)`,
      },
    ]);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeUndefined();
    }
  });
});

describe('godotValidate — trigger-zone scene lint (Phase 8 #27)', () => {
  const baseProjectGodot = `[application]
config/name="Test"
config/features=PackedStringArray("4.3")
`;

  it('FLAGS Area2D node without a CollisionShape child', () => {
    const tscn = `[gd_scene format=3 load_steps=2]
[ext_resource path="res://main.gd"]
[node name="Root" type="Node2D"]
[node name="Trigger" type="Area2D" parent="."]
position = Vector2(400, 300)
`;
    const result = godotAdapter.validate([
      { path: 'project.godot', content: baseProjectGodot },
      { path: 'main.tscn', content: tscn },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeDefined();
    }
  });

  it('FLAGS Area + CollisionShape but no walkable bounds', () => {
    const tscn = `[gd_scene format=3 load_steps=2]
[node name="Root" type="Node2D"]
[node name="Trigger" type="Area2D" parent="."]
[node name="Shape" type="CollisionShape2D" parent="Trigger"]
`;
    const result = godotAdapter.validate([
      { path: 'project.godot', content: baseProjectGodot },
      { path: 'main.tscn', content: tscn },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('walkable');
    }
  });

  it('PASSES with Area + CollisionShape + StaticBody', () => {
    const tscn = `[gd_scene format=3 load_steps=2]
[node name="Root" type="Node2D"]
[node name="Trigger" type="Area2D" parent="."]
[node name="Shape" type="CollisionShape2D" parent="Trigger"]
[node name="Walls" type="StaticBody2D" parent="."]
`;
    const result = godotAdapter.validate([
      { path: 'project.godot', content: baseProjectGodot },
      { path: 'main.tscn', content: tscn },
    ]);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeUndefined();
    }
  });
});
