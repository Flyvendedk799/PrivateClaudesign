import { describe, expect, it } from 'vitest';
import { type ValidateMotionFile, preFilterMotionIssues } from './validate-motion-composition.js';

const ROOT_OK = `import { registerRoot, Composition } from 'remotion';
import { MainVideo } from './MainComposition';

const RemotionRoot = () => (
  <>
    <Composition
      id="main"
      component={MainVideo}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);

registerRoot(RemotionRoot);
`;

describe('preFilterMotionIssues', () => {
  it('returns no issues for a valid Root', () => {
    const files: ValidateMotionFile[] = [{ path: 'src/Root.tsx', content: ROOT_OK }];
    expect(preFilterMotionIssues(files, 'src/Root.tsx')).toEqual([]);
  });

  it('flags missing registerRoot', () => {
    const files: ValidateMotionFile[] = [
      {
        path: 'src/Root.tsx',
        content: ROOT_OK.replace('registerRoot(RemotionRoot);', '// no register'),
      },
    ];
    const issues = preFilterMotionIssues(files, 'src/Root.tsx');
    expect(issues.some((i) => i.message.includes('registerRoot'))).toBe(true);
  });

  it('flags missing Composition tag', () => {
    const files: ValidateMotionFile[] = [
      {
        path: 'src/Root.tsx',
        content: `import { registerRoot } from 'remotion';\nregisterRoot(() => null);`,
      },
    ];
    const issues = preFilterMotionIssues(files, 'src/Root.tsx');
    expect(issues.some((i) => i.message.includes('<Composition>'))).toBe(true);
  });

  it('flags zero or negative durationInFrames', () => {
    const files: ValidateMotionFile[] = [
      {
        path: 'src/Root.tsx',
        content: ROOT_OK.replace('durationInFrames={150}', 'durationInFrames={0}'),
      },
    ];
    const issues = preFilterMotionIssues(files, 'src/Root.tsx');
    expect(
      issues.some((i) => i.message.includes('durationInFrames=0') && i.severity === 'error'),
    ).toBe(true);
  });

  it('flags setTimeout / framer-motion / Math.random', () => {
    const bad: ValidateMotionFile[] = [
      { path: 'src/Root.tsx', content: ROOT_OK },
      {
        path: 'src/MainComposition.tsx',
        content: `import { motion } from 'framer-motion';
const x = setTimeout(() => null, 100);
const r = Math.random();
export const MainVideo = () => null;`,
      },
    ];
    const issues = preFilterMotionIssues(bad, 'src/Root.tsx');
    expect(issues.some((i) => i.message.includes('setTimeout'))).toBe(true);
    expect(issues.some((i) => i.message.includes('framer-motion'))).toBe(true);
    expect(issues.some((i) => i.message.includes('Math.random'))).toBe(true);
  });

  it('warns on unusual fps values', () => {
    const files: ValidateMotionFile[] = [
      { path: 'src/Root.tsx', content: ROOT_OK.replace('fps={30}', 'fps={17}') },
    ];
    const issues = preFilterMotionIssues(files, 'src/Root.tsx');
    expect(issues.some((i) => i.message.includes('fps=17') && i.severity === 'warn')).toBe(true);
  });

  it('reports a missing entry file as the only issue', () => {
    const issues = preFilterMotionIssues([], 'src/Root.tsx');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('not found');
  });
});
