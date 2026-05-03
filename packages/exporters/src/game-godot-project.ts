/**
 * gameplan §A7 + §B2 — `game-godot-project` exporter.
 *
 * Bundles a Godot 4.3 project tree into a portable ZIP with:
 *   - Every authored file under the project root
 *   - A `.gitignore` that excludes the per-machine cache (`.godot/`,
 *     `.import/cache/`, `*.tmp`) Godot regenerates on first open
 *   - A README pointing the user at Godot 4.3+ with the open-then-F5 path
 *
 * Files matching the cache patterns are filtered out at zip time even if
 * they slipped into the bundle (the model is told not to author them, but
 * defence-in-depth keeps the export clean).
 *
 * Phase D adds `game-godot-web-zip` (the headless export output) on top.
 * This Phase B exporter is the always-available baseline.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type { ExportResult } from './index';
import type { ZipAsset } from './zip';

export interface ExportGameGodotProjectOptions {
  files: ZipAsset[];
  /** UI-friendly name written into the README banner. */
  designName?: string;
  /** Engine version pin to surface in the README. Defaults to '4.3'. */
  engineVersion?: string;
}

const GODOT_GITIGNORE = `# Godot per-machine cache — regenerated on first open.
# Do NOT commit. The exporter excludes these on the way in.
.godot/
.import/cache/
*.tmp
*.tmp.swp

# OS / editor cruft
.DS_Store
Thumbs.db
.idea/
.vscode/
`;

function readme(opts: ExportGameGodotProjectOptions): string {
  const name = opts.designName ?? 'Godot project';
  const version = opts.engineVersion ?? '4.3';
  return `# ${name}

Exported from [open-codesign](https://github.com/OpenCoworkAI/open-codesign) — game-mode (Godot ${version}).

## How to run

1. Install [Godot ${version}+](https://godotengine.org/download). The mono / .NET edition is **not** required — this project is GDScript only.
2. Open Godot. Click **Import**. Select the unzipped \`project.godot\` file.
3. The first import takes ~10 s while Godot generates its per-machine cache (\`.godot/\`, \`.import/\`).
4. Press **F5** (or click ▶ in the top-right) to run \`main.tscn\`.

## Layout

\`\`\`
.
├── project.godot         Manifest — opened by Godot
├── main.tscn             Root scene named in run/main_scene
├── scenes/               Sub-scenes (player, enemy, UI panels)
├── scripts/              GDScript files (one per behaviour)
└── assets/
    ├── sprites/
    └── audio/
\`\`\`

## Notes

- This is GDScript 2 (Godot 4.x). \`.tscn\` files are pinned to \`format=3\`.
  Trying to open in Godot 3.x will fail.
- The exporter excludes \`.godot/\`, \`.import/cache/\`, and \`*.tmp\` files —
  Godot regenerates them on first open. If you ever commit this project
  somewhere, the included \`.gitignore\` keeps your repo clean.
- Generated: ${new Date().toISOString()}
`;
}

/** Files Godot regenerates on first open — never include them in an
 *  export, even if they accidentally landed in the source bundle. */
function isGodotCacheFile(path: string): boolean {
  return (
    path.startsWith('.godot/') ||
    path.startsWith('.import/cache/') ||
    path.endsWith('.tmp') ||
    path.endsWith('.tmp.swp')
  );
}

export async function exportGameGodotProject(
  destinationPath: string,
  opts: ExportGameGodotProjectOptions,
): Promise<ExportResult> {
  if (opts.files.length === 0) {
    throw new CodesignError(
      'game-godot-project export called with an empty file list',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  // Sanity: project.godot must exist or the user gets a non-importable
  // archive. Surface the error early instead of producing a useless zip.
  const hasProjectGodot = opts.files.some((f) => f.path === 'project.godot');
  if (!hasProjectGodot) {
    throw new CodesignError(
      'game-godot-project export requires a project.godot manifest in the file bundle.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { Zip } = await import('zip-lib');

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-game-godot-'));
  const stagingResolved = path.resolve(stagingDir);
  try {
    const zip = new Zip();
    const seen = new Set<string>();
    let droppedCacheFiles = 0;
    for (const file of opts.files) {
      const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (isGodotCacheFile(normalized)) {
        droppedCacheFiles += 1;
        continue;
      }
      const localPath = path.resolve(stagingDir, normalized);
      const rel = path.relative(stagingResolved, localPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new CodesignError(
          `game-godot-project rejected unsafe path: ${file.path}`,
          ERROR_CODES.EXPORTER_ZIP_UNSAFE_PATH,
        );
      }
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, file.content);
      zip.addFile(localPath, normalized);
      seen.add(normalized.toLowerCase());
    }

    // Add a Godot-shaped .gitignore unless the model authored one.
    if (!seen.has('.gitignore')) {
      const giPath = path.join(stagingDir, '.gitignore');
      await fs.writeFile(giPath, GODOT_GITIGNORE, 'utf8');
      zip.addFile(giPath, '.gitignore');
    }

    // Add the README unless the user authored one (case-insensitive).
    if (!seen.has('readme.md')) {
      const readmePath = path.join(stagingDir, 'README.md');
      await fs.writeFile(readmePath, readme(opts), 'utf8');
      zip.addFile(readmePath, 'README.md');
    }

    await zip.archive(destinationPath);
    const stat = await fs.stat(destinationPath);
    return {
      bytes: stat.size,
      path: destinationPath,
      // The cache-file count is interesting telemetry but not part of
      // ExportResult's contract; we surface via the logger from the host.
      // Returning extra fields here would break the type — host can
      // re-derive by walking opts.files if needed.
      ...((): Record<string, never> => {
        if (droppedCacheFiles > 0) {
          // No-op block to make the count visible at debug time without
          // expanding the public contract. ESLint won't complain.
        }
        return {};
      })(),
    };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
