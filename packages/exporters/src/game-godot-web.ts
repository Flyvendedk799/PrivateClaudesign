/**
 * gameplan §D — `game-godot-web` exporter.
 *
 * Zips the `_build/` output Godot writes when the user clicks "Build web
 * preview" — typically `index.html`, `index.js`, `index.wasm`, `index.pck`,
 * `index.audio.worklet.js`, and `index.icon.png`. The IPC layer
 * (`godot-web-build-ipc.ts`) is responsible for actually invoking
 * `godot --headless --export-release Web` against the user's project; this
 * exporter just packages the resulting tree.
 *
 * Inputs are pre-built file bytes (read from the per-design `_build/` temp
 * dir by the host) — same `ZipAsset[]` shape the other game exporters use.
 *
 * Sanity check: `index.html` and `index.wasm` must both be present, or
 * the export is non-runnable. Surface an error with a hint pointing at
 * the build step rather than producing a useless zip.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type { ExportResult } from './index';
import type { ZipAsset } from './zip';

export interface ExportGameGodotWebOptions {
  files: ZipAsset[];
  /** UI-friendly name written into the README banner. */
  designName?: string;
  /** Optional engine version pin to surface in the README. */
  engineVersion?: string;
}

function readme(opts: ExportGameGodotWebOptions): string {
  const name = opts.designName ?? 'Godot web build';
  const version = opts.engineVersion ?? '4.3';
  return `# ${name} — web build

Exported from [open-codesign](https://github.com/OpenCoworkAI/open-codesign) — game-mode (Godot ${version} web export).

## How to host

This bundle uses **SharedArrayBuffer**, which browsers gate behind cross-origin
isolation. You MUST serve the files with these response headers:

\`\`\`
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
\`\`\`

Quick local test (Python ≥ 3.7):

\`\`\`bash
python3 -c "
from http.server import HTTPServer, SimpleHTTPRequestHandler
class H(SimpleHTTPRequestHandler):
  def end_headers(self):
    self.send_header('Cross-Origin-Opener-Policy','same-origin')
    self.send_header('Cross-Origin-Embedder-Policy','require-corp')
    super().end_headers()
HTTPServer(('localhost',8000),H).serve_forever()
" &
open http://localhost:8000/index.html
\`\`\`

itch.io's HTML5 hosting flips these headers on automatically when you upload
the zip; most other static hosts (GitHub Pages, S3 static sites) do NOT and
need a custom config.

## Files

- \`index.html\`    Entry page — opens the WebAssembly runtime
- \`index.js\`      Glue script
- \`index.wasm\`    Godot engine compiled to WebAssembly
- \`index.pck\`     Your packed game data
- \`index.audio.worklet.js\`  Audio thread bootstrap
- \`index.icon.png\` Browser tab icon

Generated: ${new Date().toISOString()}
`;
}

export async function exportGameGodotWeb(
  destinationPath: string,
  opts: ExportGameGodotWebOptions,
): Promise<ExportResult> {
  if (opts.files.length === 0) {
    throw new CodesignError(
      'game-godot-web export called with an empty file list — run "Build web preview" first.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  const hasIndexHtml = opts.files.some((f) => f.path === 'index.html');
  const hasWasm = opts.files.some((f) => f.path.endsWith('.wasm'));
  if (!hasIndexHtml || !hasWasm) {
    throw new CodesignError(
      'game-godot-web export requires index.html + an index.wasm in the file bundle. Run "Build web preview" in the iframe toolbar first; this exporter zips that build output.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { Zip } = await import('zip-lib');

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-game-godot-web-'));
  const stagingResolved = path.resolve(stagingDir);
  try {
    const zip = new Zip();
    const seen = new Set<string>();
    for (const file of opts.files) {
      const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
      const localPath = path.resolve(stagingDir, normalized);
      const rel = path.relative(stagingResolved, localPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new CodesignError(
          `game-godot-web rejected unsafe path: ${file.path}`,
          ERROR_CODES.EXPORTER_ZIP_UNSAFE_PATH,
        );
      }
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, file.content);
      zip.addFile(localPath, normalized);
      seen.add(normalized.toLowerCase());
    }

    if (!seen.has('readme.md')) {
      const readmePath = path.join(stagingDir, 'README.md');
      await fs.writeFile(readmePath, readme(opts), 'utf8');
      zip.addFile(readmePath, 'README.md');
    }

    await zip.archive(destinationPath);
    const stat = await fs.stat(destinationPath);
    return { bytes: stat.size, path: destinationPath };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
