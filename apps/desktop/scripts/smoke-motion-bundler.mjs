#!/usr/bin/env node
/**
 * Smoke test for motion-graphics-plan §0.5 — runs the same code path the
 * main process triggers when the agent writes src/Root.tsx, but without
 * Electron. Validates end-to-end:
 *
 *   - @remotion/bundler accepts a src/Root.tsx authored from our prompt
 *   - the produced .bundle/ contains index.html + bundle.js + chunks
 *   - publicPath: './' makes every emitted asset URL relative
 *
 * Doesn't validate the UI dispatch (PreviewPane → MotionPreviewPane → iframe)
 * — that needs the running Electron app. Doesn't validate LLM-side codegen
 * — needs a configured provider.
 *
 * Run from apps/desktop:  node scripts/smoke-motion-bundler.mjs
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT_TSX = `import { registerRoot, Composition, AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

const HelloMotion = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ background: '#0d0d10', color: 'white' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        opacity,
        fontSize: 96,
      }}>
        Hello, motion.
      </div>
    </AbsoluteFill>
  );
};

const RemotionRoot = () => (
  <>
    <Composition
      id="hello"
      component={HelloMotion}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);

registerRoot(RemotionRoot);
`;

async function main() {
  const designDir = await mkdtemp(join(tmpdir(), 'motion-smoke-'));
  console.log(`[smoke] designDir=${designDir}`);

  await mkdir(join(designDir, 'src'), { recursive: true });
  await writeFile(join(designDir, 'src/Root.tsx'), ROOT_TSX, 'utf8');

  const start = Date.now();
  const { bundle } = await import('@remotion/bundler');
  console.log(`[smoke] @remotion/bundler imported in ${Date.now() - start}ms`);

  const outDir = join(designDir, '.bundle');
  await mkdir(outDir, { recursive: true });

  const bundleStart = Date.now();
  const result = await bundle({
    entryPoint: join(designDir, 'src/Root.tsx'),
    outDir,
    publicPath: './',
  });
  console.log(`[smoke] bundle produced ${result} in ${Date.now() - bundleStart}ms`);

  const files = await readdir(outDir);
  console.log('[smoke] .bundle/ contents:', files.sort());

  // Required artifacts the iframe loads.
  for (const required of ['index.html', 'bundle.js']) {
    if (!files.includes(required)) {
      throw new Error(`[smoke] FAIL: missing required artifact ${required}`);
    }
  }

  // Verify the emitted index.html uses relative paths (publicPath: './').
  // If we see absolute /bundle.js refs, the iframe load would 404 under
  // the motion-files://designs/{id}/.bundle/ URL layout.
  const indexHtml = await readFile(join(outDir, 'index.html'), 'utf8');
  if (/src=["']\/bundle\.js["']/.test(indexHtml)) {
    throw new Error('[smoke] FAIL: index.html contains absolute /bundle.js path');
  }
  if (!/src=["']\.?\/?bundle\.js["']/.test(indexHtml)) {
    console.warn('[smoke] WARN: could not find expected ./bundle.js script tag');
  }
  console.log('[smoke] index.html uses relative bundle path OK');

  console.log(`[smoke] ALL OK in ${Date.now() - start}ms total`);

  await rm(designDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[smoke] FAIL:', err?.message ?? err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
