import { describe, expect, it } from 'vitest';
import {
  createCameraGuard,
  evaluateCameraSwap,
  userPromptPermitsCameraSwap,
} from './camera-pin.js';

describe('userPromptPermitsCameraSwap', () => {
  it('treats any of {camera, perspective, view, zoom, angle, ortho} as permission', () => {
    expect(userPromptPermitsCameraSwap('switch the camera to top-down please')).toBe(true);
    expect(userPromptPermitsCameraSwap('use a perspective view instead')).toBe(true);
    expect(userPromptPermitsCameraSwap('zoom out a bit')).toBe(true);
    expect(userPromptPermitsCameraSwap('I want a different angle')).toBe(true);
    expect(userPromptPermitsCameraSwap('orthographic top-down please')).toBe(true);
  });

  it('does NOT count the term when it appears only inside a fenced code block', () => {
    expect(
      userPromptPermitsCameraSwap('improve the controls\n```js\nconst camera = ...\n```\nplease'),
    ).toBe(false);
  });

  it('returns false on prompts that just complain about gameplay', () => {
    expect(userPromptPermitsCameraSwap('the hitbox and aim ui do not correlate')).toBe(false);
    expect(userPromptPermitsCameraSwap('main character should be more animated')).toBe(false);
    expect(userPromptPermitsCameraSwap('punching to side is weird')).toBe(false);
  });
});

describe('evaluateCameraSwap', () => {
  const persp = 'const camera = new THREE.PerspectiveCamera(60, ...);';
  const ortho = 'const camera = new THREE.OrthographicCamera(-w, w, h, -h, 0.1, 200);';

  it('allows non-camera edits to pass through', () => {
    expect(evaluateCameraSwap('const x = 1;', 'const x = 2;', false).allowed).toBe(true);
  });

  it('allows tweaks to the SAME camera class (e.g. FOV change)', () => {
    expect(
      evaluateCameraSwap(
        'new THREE.PerspectiveCamera(60, a, 0.1, 100)',
        'new THREE.PerspectiveCamera(75, a, 0.1, 200)',
        false,
      ).allowed,
    ).toBe(true);
  });

  it('refuses Perspective → Orthographic swap when user did not name the camera', () => {
    const decision = evaluateCameraSwap(persp, ortho, false);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/PerspectiveCamera → OrthographicCamera/);
    expect(decision.reason).toMatch(/\[camera-pin\]/);
  });

  it('refuses Orthographic → Perspective swap when user did not name the camera', () => {
    const decision = evaluateCameraSwap(ortho, persp, false);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/OrthographicCamera → PerspectiveCamera/);
  });

  it('allows the swap when user permission is granted', () => {
    expect(evaluateCameraSwap(persp, ortho, true).allowed).toBe(true);
    expect(evaluateCameraSwap(ortho, persp, true).allowed).toBe(true);
  });

  it('allows ADDING a camera class to a region that previously had none (first-shot init)', () => {
    expect(evaluateCameraSwap('// camera goes here', persp, false).allowed).toBe(true);
  });
});

describe('createCameraGuard scoping', () => {
  it('design-mode runs are never enforcing (regression guard)', () => {
    const guard = createCameraGuard({
      gameMode: false,
      editMode: true,
      userPrompt: 'whatever',
    });
    expect(
      guard.check('new THREE.PerspectiveCamera(60)', 'new THREE.OrthographicCamera(-1, 1, 1, -1)'),
    ).toBeNull();
  });

  it('first-shot game runs (no history) are not enforcing — the agent picks the camera fresh', () => {
    const guard = createCameraGuard({
      gameMode: true,
      editMode: false,
      userPrompt: 'whatever',
    });
    expect(
      guard.check('new THREE.PerspectiveCamera(60)', 'new THREE.OrthographicCamera(-1, 1, 1, -1)'),
    ).toBeNull();
  });

  it('game + edit + camera-silent prompt + actual swap → guard returns the refusal text', () => {
    const guard = createCameraGuard({
      gameMode: true,
      editMode: true,
      userPrompt: 'the aim and hitbox do not correlate',
    });
    const reason = guard.check(
      'new THREE.PerspectiveCamera(60)',
      'new THREE.OrthographicCamera(-1, 1, 1, -1)',
    );
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/camera-pin/);
  });

  it('game + edit + camera-permitting prompt → guard allows the swap', () => {
    const guard = createCameraGuard({
      gameMode: true,
      editMode: true,
      userPrompt: 'switch to a 3rd-person camera from behind',
    });
    expect(
      guard.check('new THREE.OrthographicCamera(-1, 1, 1, -1)', 'new THREE.PerspectiveCamera(60)'),
    ).toBeNull();
  });
});
