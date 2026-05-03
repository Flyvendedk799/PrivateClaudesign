/**
 * gameplan §3 + §7.1 + §7.6 — Godot engine adapter tests (Phase B).
 */

import { describe, expect, it } from 'vitest';
import { godotAdapter } from './godot';

describe('godotAdapter shape (gameplan §7.1)', () => {
  it('exposes the gameplan-locked metadata', () => {
    expect(godotAdapter.id).toBe('godot');
    expect(godotAdapter.label).toBe('Godot');
    expect(godotAdapter.defaultVersion).toBe('4.3');
    expect(godotAdapter.canonicalEntry).toBe('project.godot');
  });

  it('does NOT support live preview in Phase B (project-download only)', () => {
    expect(godotAdapter.supportsLivePreview()).toBe(false);
  });

  it('lists godot-shaped file extensions', () => {
    expect(godotAdapter.fileExtensions).toContain('godot');
    expect(godotAdapter.fileExtensions).toContain('tscn');
    expect(godotAdapter.fileExtensions).toContain('gd');
    expect(godotAdapter.fileExtensions).toContain('tres');
  });
});

describe('godotAdapter.bootstrap (project-shell preview)', () => {
  const opts = {
    designId: 'abc-123',
    gameBaseUrl: 'game-files://designs/abc-123/',
  };

  it('emits a static project-shell HTML naming the engine version', () => {
    const html = godotAdapter.bootstrap(opts);
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('Godot 4.3');
    expect(html).toContain('main.tscn');
    expect(html).toContain('project.godot');
  });

  it('honours pinnedVersion override', () => {
    const html = godotAdapter.bootstrap({ ...opts, pinnedVersion: '4.4' });
    expect(html).toContain('Godot 4.4');
  });

  it('escapes the gameBaseUrl into the <base href>', () => {
    const html = godotAdapter.bootstrap(opts);
    expect(html).toContain('<base href="game-files://designs/abc-123/"');
  });

  it('explicitly tells the user that live preview lands in Phase D', () => {
    const html = godotAdapter.bootstrap(opts);
    expect(html).toContain('Phase D');
  });
});

describe('godotAdapter.validate (gameplan §7.6)', () => {
  const goodProject = `[application]
config/name="Test"
run/main_scene="res://main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
`;
  const goodMainScene = `[gd_scene format=3]

[ext_resource type="Script" path="res://scripts/player.gd" id="1"]

[node name="Main" type="Node2D"]
[node name="Player" parent="." instance=ExtResource("1")]
`;
  const goodPlayerGd = `extends CharacterBody2D

func _ready():
    pass

func _process(delta):
    var _v = velocity
`;

  it('returns ok for a well-formed minimal Godot project', () => {
    const result = godotAdapter.validate([
      { path: 'project.godot', content: goodProject },
      { path: 'main.tscn', content: goodMainScene },
      { path: 'scripts/player.gd', content: goodPlayerGd },
    ]);
    expect(result.ok).toBe(true);
  });

  it('flags a missing project.godot as a hard error', () => {
    const result = godotAdapter.validate([{ path: 'main.tscn', content: goodMainScene }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('project.godot is missing'))).toBe(true);
  });

  it('flags a project.godot without an [application] section', () => {
    const broken = `[rendering]\nrenderer/rendering_method="gl_compatibility"\n`;
    const result = godotAdapter.validate([{ path: 'project.godot', content: broken }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('[application] section'))).toBe(true);
  });

  it('flags a dangling run/main_scene reference', () => {
    const projectMissingScene = `[application]
config/name="Test"
run/main_scene="res://does_not_exist.tscn"
`;
    const result = godotAdapter.validate([{ path: 'project.godot', content: projectMissingScene }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some(
        (i) => i.message.includes('run/main_scene') && i.message.includes('no such file'),
      ),
    ).toBe(true);
  });

  it('flags a dangling [ext_resource] reference inside a .tscn', () => {
    const sceneWithGhost = `[gd_scene format=3]
[ext_resource type="Script" path="res://scripts/ghost.gd" id="1"]
[node name="Main" type="Node2D"]
`;
    const result = godotAdapter.validate([
      { path: 'project.godot', content: goodProject },
      { path: 'main.tscn', content: sceneWithGhost },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some(
        (i) => i.message.includes('ext_resource') && i.message.includes('scripts/ghost.gd'),
      ),
    ).toBe(true);
  });

  it('flags a .gd file without an extends declaration', () => {
    const noExtends = 'func _ready():\n    pass\n';
    const result = godotAdapter.validate([
      { path: 'project.godot', content: goodProject },
      { path: 'main.tscn', content: goodMainScene },
      { path: 'scripts/player.gd', content: noExtends },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('extends'))).toBe(true);
  });

  it('warns on print() inside _process (perf + log spam)', () => {
    const noisy = `extends Node2D

func _process(delta):
    print("frame")
`;
    const result = godotAdapter.validate([
      { path: 'project.godot', content: goodProject },
      { path: 'main.tscn', content: goodMainScene },
      { path: 'scripts/player.gd', content: noisy },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const warn = result.issues.find((i) => i.message.includes('print() inside _process'));
    expect(warn?.severity).toBe('warn');
  });

  it('flags Godot 3.x scenes (format=2) as unsupported', () => {
    const oldScene = `[gd_scene format=2]\n[node name="Main" type="Node2D"]\n`;
    const result = godotAdapter.validate([
      { path: 'project.godot', content: goodProject },
      { path: 'main.tscn', content: oldScene },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.message.includes('Godot 3.x'))).toBe(true);
  });
});
