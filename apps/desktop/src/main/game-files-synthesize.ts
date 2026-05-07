/**
 * gameplan A6.x — synthesise game-files responses for files the agent
 * doesn't author but the engine needs at preview time.
 *
 * Pygame is the main consumer: the agent only writes main.py + helper
 * modules, but Pyodide needs an `index.html` to bootstrap and a
 * `manifest.json` so the bootstrap can mount every project file into
 * MEMFS without a directory-listing API.
 *
 * Three.js / Phaser don't synthesize today — the agent authors index.html
 * directly. Godot doesn't either — the build pipeline produces the web
 * runtime via _build/.
 */

import { getEngineAdapter } from '@open-codesign/runtime';
import type Database from 'better-sqlite3';
import {
  buildAnimationPreviewManifest,
  buildSpritePreviewManifest,
} from './game-artifacts-preview';
import type { GameFilesSynthesize } from './game-files-protocol';
import { listDesignFiles } from './snapshots-db';

interface SnapshotEngineRow {
  engine: string | null;
  engine_version: string | null;
}

/** Look up the engine pin for a design via its newest snapshot. Returns
 *  null when no snapshot exists yet (fresh design) or when the snapshot
 *  doesn't carry an engine (design-mode). */
function getDesignEngine(
  db: Database.Database,
  designId: string,
): { engine: string; version: string | null } | null {
  const row = db
    .prepare(
      'SELECT engine, engine_version FROM design_snapshots WHERE design_id = ? AND engine IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(designId) as SnapshotEngineRow | undefined;
  if (row === undefined || row.engine === null) return null;
  return { engine: row.engine, version: row.engine_version };
}

/** Build the manifest.json the pygame bootstrap fetches to populate
 *  Pyodide's MEMFS. Lists every authored project file; bootstrap then
 *  fetches each via game-files:// and writes it into /home/pyodide. */
function buildPygameManifest(db: Database.Database, designId: string): string {
  const files = listDesignFiles(db, designId);
  const paths = files.map((f) => f.path).filter((p) => !p.startsWith('_build/'));
  return JSON.stringify(paths);
}

/**
 * Static preview shell for sprite / animation inspect mode. The shell:
 *  - imports a tiny three.js scene (loaded from @open-codesign/runtime
 *    bundles when packaged; for now an inline shim that fetches a
 *    static manifest and renders a textured plane / GLB)
 *  - posts back GAME_PREVIEW_READY / GAME_PREVIEW_ERROR over postMessage
 *  - falls back to a textual fallback for unsupported metadata
 *
 * Three.js is loaded from a CDN (esm.sh) at runtime because the desktop
 * build doesn't ship the library. Pygame / Godot designs reuse this same
 * shell — the engine-specific adapters can be layered on later via the
 * runtime registry.
 */
function buildArtifactPreviewShell(args: {
  designId: string;
  mode: 'sprite' | 'animation';
  artifactId: string;
  spriteId?: string;
  manifestUrl: string;
}): string {
  const escaped = JSON.stringify(args);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${args.mode} preview</title>
<style>
  html, body { margin: 0; height: 100%; background: #0d0e10; color: #fafaf6; font-family: -apple-system, system-ui, sans-serif; }
  #stage { position: fixed; inset: 0; }
  #status { position: fixed; bottom: 8px; left: 8px; right: 8px; padding: 6px 10px; font-size: 11px; background: rgba(0,0,0,0.55); border-radius: 6px; pointer-events: none; }
  #fallback { padding: 16px; max-width: 480px; margin: 24px auto; line-height: 1.4; }
  .err { color: #ff8c8c; }
</style></head><body>
<div id="stage"></div>
<div id="status">Loading…</div>
<noscript>JavaScript is required for sprite/animation preview.</noscript>
<script type="module">
const ARGS = ${escaped};
const status = document.getElementById('status');
function setStatus(text, kind) {
  if (!status) return;
  status.textContent = text;
  status.className = kind === 'error' ? 'err' : '';
}
function emitReady(mode, artifactIds) {
  parent.postMessage({ __codesign: true, type: 'GAME_PREVIEW_READY', mode, artifactIds }, '*');
}
function emitError(mode, artifactIds, message, detail) {
  parent.postMessage({
    __codesign: true,
    type: 'GAME_PREVIEW_ERROR',
    mode, artifactIds, message,
    detail: detail || undefined,
  }, '*');
  setStatus(message, 'error');
}
async function fetchManifest() {
  const res = await fetch(ARGS.manifestUrl);
  if (!res.ok) throw new Error('manifest fetch ' + res.status);
  return await res.json();
}
function renderFallback(manifest, message) {
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.id = 'fallback';
  wrap.innerHTML = '<h3>' + (manifest && manifest.sprite ? manifest.sprite.name : (manifest && manifest.animation ? manifest.animation.name : 'Preview')) + '</h3>' +
    '<p>' + (message || 'Preview unavailable for this artifact type yet.') + '</p>' +
    '<pre style="white-space:pre-wrap;font-size:11px;background:rgba(255,255,255,0.06);padding:8px;border-radius:6px">' +
    JSON.stringify(manifest, null, 2) + '</pre>';
  stage.appendChild(wrap);
}
async function loadThree() {
  return await import('https://esm.sh/three@0.170.0');
}
async function renderSprite(THREE, manifest) {
  const stage = document.getElementById('stage');
  if (!stage || !manifest.sprite) {
    emitError('sprite', [ARGS.artifactId], 'Manifest missing sprite payload');
    return;
  }
  const sprite = manifest.sprite;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    if (camera.isPerspectiveCamera) {
      camera.aspect = w / h;
    } else {
      const aspect = w / h;
      camera.left = -aspect; camera.right = aspect; camera.top = 1; camera.bottom = -1;
    }
    camera.updateProjectionMatrix();
  }
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111213);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0.3, 2.5);
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(2, 3, 4);
  scene.add(dir);
  const grid = new THREE.GridHelper(4, 8, 0x444444, 0x222222);
  scene.add(grid);
  let object = null;
  try {
    const texFile = sprite.files.find((f) => f.role === 'texture' || f.role === 'thumbnail');
    const modelFile = sprite.files.find((f) => f.role === 'model');
    if (modelFile) {
      const loaderMod = await import('https://esm.sh/three@0.170.0/addons/loaders/GLTFLoader.js');
      const loader = new loaderMod.GLTFLoader();
      const gltf = await loader.loadAsync(modelFile.url);
      object = gltf.scene;
      scene.add(object);
    } else if (texFile) {
      const loader = new THREE.TextureLoader();
      const texture = await loader.loadAsync(texFile.url);
      const aspect = texture.image && texture.image.width
        ? texture.image.width / Math.max(1, texture.image.height)
        : 1;
      const geometry = new THREE.PlaneGeometry(aspect, 1);
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
      object = new THREE.Mesh(geometry, material);
      scene.add(object);
    }
  } catch (e) {
    emitError('sprite', [ARGS.artifactId], 'Failed to load sprite asset', String(e && e.message ? e.message : e));
    return;
  }
  let dragging = false; let lastX = 0; let lastY = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || !object) return;
    const dx = (e.clientX - lastX) / 200;
    const dy = (e.clientY - lastY) / 200;
    object.rotation.y += dx;
    object.rotation.x += dy;
    lastX = e.clientX; lastY = e.clientY;
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.001);
    camera.position.z = Math.max(0.5, Math.min(10, camera.position.z * factor));
  }, { passive: false });
  resize();
  window.addEventListener('resize', resize);
  emitReady('sprite', [ARGS.artifactId]);
  setStatus(sprite.name + ' · drag to rotate · scroll to zoom');
  function loop() {
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();
}
async function renderAnimation(THREE, manifest) {
  if (!manifest.animation || !manifest.sprite) {
    emitError('animation', [ARGS.artifactId], 'Manifest missing animation/sprite payload');
    return;
  }
  if (manifest.animation.binding && manifest.animation.binding.bindingStatus === 'broken') {
    emitError('animation', [ARGS.artifactId], 'Binding is broken — sprite/animation files mismatch.');
    return;
  }
  const meta = manifest.animation.metadata;
  // Skeletal clips on a GLB model — load via GLTFLoader, attach AnimationMixer,
  // play the first clip the file ships with.
  const modelFile = manifest.sprite.files.find((f) => f.role === 'model');
  if (modelFile && (meta.animationType === 'skeletal' || meta.animationType === 'engine-clip')) {
    try {
      const stage = document.getElementById('stage');
      if (!stage) throw new Error('no stage');
      const loaderMod = await import('https://esm.sh/three@0.170.0/addons/loaders/GLTFLoader.js');
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x111213);
      const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
      camera.position.set(0, 1, 2.5);
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const dir = new THREE.DirectionalLight(0xffffff, 0.7);
      dir.position.set(2, 3, 4);
      scene.add(dir);
      scene.add(new THREE.GridHelper(4, 8, 0x444444, 0x222222));
      const loader = new loaderMod.GLTFLoader();
      const gltf = await loader.loadAsync(modelFile.url);
      const model = gltf.scene;
      scene.add(model);
      stage.appendChild(renderer.domElement);
      function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
      }
      window.addEventListener('resize', resize);
      resize();
      const mixer = new THREE.AnimationMixer(model);
      if (gltf.animations && gltf.animations.length > 0) {
        const clip = gltf.animations[0];
        const action = mixer.clipAction(clip);
        action.setLoop(meta.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        action.play();
      }
      const clock = new THREE.Clock();
      function loop() {
        const dt = clock.getDelta();
        mixer.update(dt);
        renderer.render(scene, camera);
        requestAnimationFrame(loop);
      }
      emitReady('animation', [ARGS.artifactId, ARGS.spriteId || '']);
      setStatus(manifest.animation.name + ' · ' + Math.round(meta.durationMs) + 'ms · skeletal clip');
      loop();
      return;
    } catch (e) {
      emitError(
        'animation',
        [ARGS.artifactId],
        'Skeletal clip failed; falling back to static sprite.',
        String(e && e.message ? e.message : e),
      );
    }
  }
  // Frame-sequence playback for 2D sprites with multiple frames in the
  // texture row. Loads the texture from the bound sprite, slices via UV
  // offset/repeat over time. Works when the sprite metadata reports
  // frameCount > 1 (or animation declares a count).
  const texFile = manifest.sprite.files.find((f) => f.role === 'spritesheet') ||
    manifest.sprite.files.find((f) => f.role === 'texture');
  const spriteMeta = manifest.sprite.metadata;
  const frameCount = (spriteMeta && typeof spriteMeta.frameCount === 'number' && spriteMeta.frameCount > 1)
    ? spriteMeta.frameCount
    : 1;
  if (texFile && (meta.animationType === 'frame-sequence' || meta.animationType === 'spritesheet-cycle') && frameCount > 1) {
    const stage = document.getElementById('stage');
    if (!stage) {
      await renderSprite(THREE, manifest);
      return;
    }
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111213);
    const aspect = window.innerWidth / window.innerHeight;
    const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.01, 10);
    camera.position.z = 2;
    const loader = new THREE.TextureLoader();
    const texture = await loader.loadAsync(texFile.url);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.set(1 / frameCount, 1);
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    stage.appendChild(renderer.domElement);
    function resize() {
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      const a = window.innerWidth / window.innerHeight;
      camera.left = -a; camera.right = a; camera.top = 1; camera.bottom = -1;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    resize();
    const fps = (typeof meta.fps === 'number' && meta.fps > 0) ? meta.fps : (frameCount * 1000) / Math.max(1, meta.durationMs);
    let lastFrame = -1;
    const start = performance.now();
    function loop() {
      const t = performance.now() - start;
      const frameIndex = meta.loop
        ? Math.floor((t * fps) / 1000) % frameCount
        : Math.min(frameCount - 1, Math.floor((t * fps) / 1000));
      if (frameIndex !== lastFrame) {
        texture.offset.x = frameIndex / frameCount;
        lastFrame = frameIndex;
      }
      renderer.render(scene, camera);
      requestAnimationFrame(loop);
    }
    emitReady('animation', [ARGS.artifactId, ARGS.spriteId || '']);
    setStatus(manifest.animation.name + ' · ' + frameCount + ' frames @ ' + fps.toFixed(1) + ' fps');
    loop();
    return;
  }
  // No usable clip — render the bound sprite as a static preview with the
  // animation metadata overlaid.
  await renderSprite(THREE, manifest);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:8px;left:8px;background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;font-size:11px;';
  overlay.textContent = 'Animation: ' + manifest.animation.name + ' · ' +
    Math.round(meta.durationMs) + 'ms · ' +
    (meta.loop ? 'loop' : 'one-shot') + ' · static preview';
  document.body.appendChild(overlay);
  emitReady('animation', [ARGS.artifactId, ARGS.spriteId || '']);
}
(async () => {
  try {
    const manifest = await fetchManifest();
    const THREE = await loadThree();
    if (ARGS.mode === 'sprite') {
      await renderSprite(THREE, manifest);
    } else {
      await renderAnimation(THREE, manifest);
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    emitError(ARGS.mode, [ARGS.artifactId], msg);
    try {
      const manifest = await fetchManifest();
      renderFallback(manifest, msg);
    } catch {}
  }
})();
</script>
</body></html>`;
}

export function makeGameFilesSynthesizer(db: Database.Database): GameFilesSynthesize {
  return (designId, path, searchParams) => {
    // game-artifacts §3 — sprite/animation preview synthesis. Available for
    // any engine because the inspect scene runs through the runtime
    // registry, not the engine's main adapter.
    if (path === '__preview/sprite.html') {
      const artifactId = searchParams?.get('artifactId') ?? '';
      if (artifactId.length === 0) return null;
      const manifestUrl = `game-files://designs/${designId}/__preview/manifest.json?mode=sprite&artifactId=${encodeURIComponent(artifactId)}`;
      const html = buildArtifactPreviewShell({
        designId,
        mode: 'sprite',
        artifactId,
        manifestUrl,
      });
      return { contentType: 'text/html', body: new TextEncoder().encode(html) };
    }
    if (path === '__preview/animation.html') {
      const artifactId = searchParams?.get('artifactId') ?? '';
      const spriteId = searchParams?.get('spriteId') ?? '';
      if (artifactId.length === 0 || spriteId.length === 0) return null;
      const manifestUrl = `game-files://designs/${designId}/__preview/manifest.json?mode=animation&artifactId=${encodeURIComponent(artifactId)}&spriteId=${encodeURIComponent(spriteId)}`;
      const html = buildArtifactPreviewShell({
        designId,
        mode: 'animation',
        artifactId,
        spriteId,
        manifestUrl,
      });
      return { contentType: 'text/html', body: new TextEncoder().encode(html) };
    }
    if (path === '__preview/manifest.json') {
      const mode = searchParams?.get('mode') ?? '';
      if (mode === 'sprite') {
        const artifactId = searchParams?.get('artifactId') ?? '';
        if (artifactId.length === 0) return null;
        const manifest = buildSpritePreviewManifest(db, designId, artifactId);
        if (manifest === null) return null;
        return {
          contentType: 'application/json',
          body: new TextEncoder().encode(JSON.stringify(manifest)),
        };
      }
      if (mode === 'animation') {
        const artifactId = searchParams?.get('artifactId') ?? '';
        const spriteId = searchParams?.get('spriteId') ?? '';
        if (artifactId.length === 0 || spriteId.length === 0) return null;
        const manifest = buildAnimationPreviewManifest(db, designId, artifactId, spriteId);
        if (manifest === null) return null;
        return {
          contentType: 'application/json',
          body: new TextEncoder().encode(JSON.stringify(manifest)),
        };
      }
      return null;
    }

    const engine = getDesignEngine(db, designId);
    if (engine === null) return null;
    if (engine.engine !== 'pygame') return null;

    if (path === 'index.html') {
      const adapter = getEngineAdapter('pygame');
      if (adapter === null) return null;
      const html = adapter.bootstrap({
        designId,
        gameBaseUrl: `game-files://designs/${designId}/`,
        ...(engine.version !== null ? { pinnedVersion: engine.version } : {}),
      });
      return {
        contentType: 'text/html',
        body: new TextEncoder().encode(html),
      };
    }
    if (path === 'manifest.json') {
      return {
        contentType: 'application/json',
        body: new TextEncoder().encode(buildPygameManifest(db, designId)),
      };
    }
    return null;
  };
}
