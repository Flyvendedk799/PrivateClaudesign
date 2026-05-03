/**
 * gameplan §A7 — `game-zip` exporter.
 *
 * Bundles a multi-file game project into a portable ZIP. CDN imports for
 * Three.js / Phaser are preserved (the user serves the resulting tree
 * via any static HTTP host). Compared to game-html, this exporter is
 * lighter (no engine vendoring at export time), but the unzipped tree
 * needs internet to load the engine ESM the first time it runs.
 *
 * Input is the design's full file bundle as `files: ZipAsset[]`. Caller
 * (apps/desktop main) reads design_files rows and base64-decodes any
 * `data:base64,` content before handing to this exporter.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type { ExportResult } from './index';
import type { ZipAsset } from './zip';

export interface ExportGameZipOptions {
  files: ZipAsset[];
  /** UI-friendly name written into the README banner. */
  designName?: string;
  /** Engine pinned for the project. Drives the README "how to run" hint. */
  engine?: 'three' | 'phaser' | 'pygame' | 'godot';
  /** Optional engine version pin to surface in the README. */
  engineVersion?: string;
}

function readme(opts: ExportGameZipOptions): string {
  const name = opts.designName ?? 'Game';
  const engineLabel =
    opts.engine === 'three'
      ? `Three.js${opts.engineVersion !== undefined ? ` ${opts.engineVersion}` : ''}`
      : opts.engine === 'phaser'
        ? `Phaser${opts.engineVersion !== undefined ? ` ${opts.engineVersion}` : ''}`
        : opts.engine === 'pygame'
          ? `Pygame${opts.engineVersion !== undefined ? ` ${opts.engineVersion}` : ''}`
          : opts.engine === 'godot'
            ? `Godot${opts.engineVersion !== undefined ? ` ${opts.engineVersion}` : ''}`
            : 'unknown engine';
  const howToRun =
    opts.engine === 'three' || opts.engine === 'phaser'
      ? '## How to run\n\n```sh\npython3 -m http.server\n# then open http://localhost:8000\n```\n\nThe engine library loads from cdn.jsdelivr.net the first time. After that, the browser caches it offline.'
      : opts.engine === 'pygame'
        ? '## How to run\n\n```sh\npython3 -m venv .venv && source .venv/bin/activate\npip install -r requirements.txt\npython main.py\n```'
        : opts.engine === 'godot'
          ? '## How to run\n\nOpen `project.godot` in Godot 4.3+, then press F5 (or click ▶) to run.'
          : '## How to run\n\nDouble-click `index.html`, or serve with `python3 -m http.server`.';
  return `# ${name}

Exported from [open-codesign](https://github.com/OpenCoworkAI/open-codesign) — game-mode.

- **Engine**: ${engineLabel}
- **Generated**: ${new Date().toISOString()}

${howToRun}

## Layout

\`\`\`
.
├── index.html / main.py / project.godot   Entry point
├── src/                                   Game source
└── assets/                                Sprites, audio, etc.
\`\`\`
`;
}

export async function exportGameZip(
  destinationPath: string,
  opts: ExportGameZipOptions,
): Promise<ExportResult> {
  if (opts.files.length === 0) {
    throw new CodesignError(
      'game-zip export called with an empty file list',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  // Lazy-load the zip writer (PRINCIPLES §1: heavy deps stay out of the
  // cold-start graph until export is invoked).
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { Zip } = await import('zip-lib');

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-game-zip-'));
  const stagingResolved = path.resolve(stagingDir);
  try {
    const zip = new Zip();
    const seen = new Set<string>();
    for (const file of opts.files) {
      // Normalise + reject path traversal — same idiom as the design-mode
      // zip exporter (EXPORTER_ZIP_UNSAFE_PATH defence).
      const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
      const localPath = path.resolve(stagingDir, normalized);
      const rel = path.relative(stagingResolved, localPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new CodesignError(
          `game-zip rejected unsafe path: ${file.path}`,
          ERROR_CODES.EXPORTER_ZIP_UNSAFE_PATH,
        );
      }
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, file.content);
      zip.addFile(localPath, normalized);
      seen.add(normalized.toLowerCase());
    }
    // Always add a README — surfaces engine + how-to-run + contributor link.
    // Don't overwrite a model-authored README if one already exists in the
    // bundle (any case-insensitive `readme.md` match).
    if (!seen.has('readme.md')) {
      const readmePath = path.join(stagingDir, 'README.md');
      await fs.writeFile(readmePath, readme(opts), 'utf8');
      zip.addFile(readmePath, 'README.md');
    }
    await zip.archive(destinationPath);
    const stat = await fs.stat(destinationPath);
    return { bytes: stat.size, path: destinationPath };
  } finally {
    // Best-effort cleanup; leaving a temp dir behind isn't fatal.
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
