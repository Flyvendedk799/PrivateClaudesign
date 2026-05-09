import { describe, expect, it } from 'vitest';
import { makeVerifyUnityMatchesPreviewTool } from './verify-unity-matches-preview';

const SHADOW_INDEX_HTML = `<!doctype html>
<html><body>
<canvas id="game"></canvas>
<script type="module">
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import { PointerLockControls } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/PointerLockControls.js';
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
const controls = new PointerLockControls(camera, document.body);
const player = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.6), new THREE.MeshStandardMaterial());
player.name = 'Player';
scene.add(player);
const enemy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
enemy.name = 'Enemy';
scene.add(enemy);
</script>
</body></html>`;

const UNITY_SCENE = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!29 &1
OcclusionCullingSettings:
  m_ObjectHideFlags: 0
`;

const UNITY_SCENE_BUILDER = `using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
public static class SceneBuilder {
  static void Build() {
    Cursor.lockState = CursorLockMode.Locked;
    var player = GameObject.CreatePrimitive(PrimitiveType.Capsule);
    player.name = "Player";
    var enemy = GameObject.CreatePrimitive(PrimitiveType.Cube);
    enemy.name = "Enemy";
  }
}`;

describe('verify_unity_matches_preview', () => {
  it('passes when both sides exist and actors overlap', async () => {
    const tool = makeVerifyUnityMatchesPreviewTool({
      listFiles: () => [
        { path: 'index.html', content: SHADOW_INDEX_HTML },
        { path: 'Assets/Scenes/Main.unity', content: UNITY_SCENE },
        { path: 'Assets/Editor/SceneBuilder.cs', content: UNITY_SCENE_BUILDER },
      ],
    });
    const result = await tool.execute('id', {});
    expect(result.details.ok).toBe(true);
    expect(result.details.shadowActors).toContain('Player');
    expect(result.details.unityActors).toContain('Player');
    expect(result.details.unityCamera).toBe('first_person');
    expect(result.details.shadowCamera).toBe('first_person');
  });

  it('fails when index.html is missing (shadow scene absent)', async () => {
    const tool = makeVerifyUnityMatchesPreviewTool({
      listFiles: () => [
        { path: 'Assets/Scenes/Main.unity', content: UNITY_SCENE },
        { path: 'Assets/Editor/SceneBuilder.cs', content: UNITY_SCENE_BUILDER },
      ],
    });
    const result = await tool.execute('id', {});
    expect(result.details.ok).toBe(false);
    expect(result.details.issues.some((i) => i.kind === 'missing_shadow')).toBe(true);
  });

  it('fails when Unity tree is missing', async () => {
    const tool = makeVerifyUnityMatchesPreviewTool({
      listFiles: () => [{ path: 'index.html', content: SHADOW_INDEX_HTML }],
    });
    const result = await tool.execute('id', {});
    expect(result.details.ok).toBe(false);
    expect(result.details.issues.some((i) => i.kind === 'missing_unity')).toBe(true);
  });

  it('warns on camera-kind drift (first-person Unity vs orbital shadow)', async () => {
    const orbitShadow = `<!doctype html><script type="module">
      import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
      const controls = new OrbitControls(camera, document.body);
      const player = new THREE.Mesh();
      player.name = 'Player';
    </script>`;
    const tool = makeVerifyUnityMatchesPreviewTool({
      listFiles: () => [
        { path: 'index.html', content: orbitShadow },
        { path: 'Assets/Scenes/Main.unity', content: UNITY_SCENE },
        { path: 'Assets/Editor/SceneBuilder.cs', content: UNITY_SCENE_BUILDER },
      ],
    });
    const result = await tool.execute('id', {});
    expect(result.details.issues.some((i) => i.kind === 'camera_drift')).toBe(true);
  });

  it('warns on named-actor drift (zero overlap)', async () => {
    const altShadow = `<!doctype html><script type="module">
      const cam = new THREE.PerspectiveCamera();
      const tree = new THREE.Mesh(); tree.name = 'Tree';
      const rock = new THREE.Mesh(); rock.name = 'Rock';
    </script>`;
    const tool = makeVerifyUnityMatchesPreviewTool({
      listFiles: () => [
        { path: 'index.html', content: altShadow },
        { path: 'Assets/Scenes/Main.unity', content: UNITY_SCENE },
        { path: 'Assets/Editor/SceneBuilder.cs', content: UNITY_SCENE_BUILDER },
      ],
    });
    const result = await tool.execute('id', {});
    expect(result.details.issues.some((i) => i.kind === 'actor_drift')).toBe(true);
  });
});
