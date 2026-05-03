import { describe, expect, it } from 'vitest';
import { summarizeSnapshotDiff } from './snapshot-diff';

const persp = `
  const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 100);
  function tick(t) { renderer.render(scene, camera); requestAnimationFrame(tick); }
`;

const ortho = persp.replace(/PerspectiveCamera/g, 'OrthographicCamera');

describe('summarizeSnapshotDiff', () => {
  it('returns [] when prev and next are byte-identical', () => {
    expect(summarizeSnapshotDiff(persp, persp)).toEqual([]);
  });

  it('describes a Perspective → Orthographic camera swap', () => {
    const lines = summarizeSnapshotDiff(persp, ortho);
    expect(lines.some((l) => l.includes('PerspectiveCamera → OrthographicCamera'))).toBe(true);
  });

  it('describes the c44763af rotation sign-flip fix', () => {
    const buggy = `${persp}\nplayerGroup.rotation.y = -playerAngle;`;
    const fixed = `${persp}\nplayerGroup.rotation.y = playerAngle;`;
    const lines = summarizeSnapshotDiff(buggy, fixed);
    expect(lines.some((l) => l.includes('sign fixed'))).toBe(true);
  });

  it('describes added systems on a fresh edit (e.g. combo + screen shake)', () => {
    const a = persp;
    const b = `${persp}\nlet combo = 0;\ncamera.shake();`;
    const lines = summarizeSnapshotDiff(a, b);
    expect(lines.some((l) => l.includes('+combo system'))).toBe(true);
    expect(lines.some((l) => l.includes('+screen shake'))).toBe(true);
  });

  it('describes removed systems', () => {
    const a = `${persp}\nlet combo = 0;\nspawnImpactFlash();`;
    const b = persp;
    const lines = summarizeSnapshotDiff(a, b);
    expect(lines.some((l) => l.includes('-combo system'))).toBe(true);
  });

  it('falls back to a byte-delta line when no top-level system change is detected', () => {
    const a = persp;
    const b = `${persp}\n// add a long throwaway comment block ${'x'.repeat(120)}`;
    const lines = summarizeSnapshotDiff(a, b);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^\+\d+ bytes/);
  });

  it('caps output at the configured maxLines (default 3)', () => {
    const a = persp;
    const b = `${persp}\nlet combo = 0;\ncamera.shake();\nlet hitstop = 0;\nspawnImpactFlash();\nconst leftArm = 1;\nconst rightArm = 2;`;
    const lines = summarizeSnapshotDiff(a, b);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('on initial snapshot (prev=null) summarises camera + first systems', () => {
    const lines = summarizeSnapshotDiff(null, `${persp}\nlet combo = 0;\nspawnImpactFlash();`);
    expect(lines.some((l) => l.includes('camera: PerspectiveCamera'))).toBe(true);
    expect(lines.some((l) => l.includes('+combo system') || l.includes('+hit flash'))).toBe(true);
  });

  it('returns [] on empty next when prev is also empty', () => {
    expect(summarizeSnapshotDiff('', '')).toEqual([]);
  });
});
