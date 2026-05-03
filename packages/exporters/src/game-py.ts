/**
 * gameplan §C2 — `game-py` exporter.
 *
 * Bundles a Pygame project tree into a portable ZIP that runs locally
 * with `python3 -m venv .venv && pip install -r requirements.txt && python main.py`.
 *
 * Auto-generates the surrounding scaffolding when the model didn't author it:
 *   - `requirements.txt` pinning `pygame-ce==2.5.5`
 *   - `.gitignore` covering Python build artefacts (`__pycache__/`, `.venv/`,
 *     `*.pyc`, `.pytest_cache/`, `.DS_Store`)
 *   - `README.md` with the venv + pip path + control hints
 *
 * Filters out `__pycache__/` / `*.pyc` files at zip time even if they
 * slipped into the bundle (Pyodide regenerates them; never useful in an
 * exported archive).
 *
 * Mirrors `game-godot-project` in shape — same staging-dir + zip-lib idiom,
 * same defence-in-depth filter, same model-authored-file detection.
 */

import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type { ExportResult } from './index';
import type { ZipAsset } from './zip';

export interface ExportGamePyOptions {
  files: ZipAsset[];
  /** UI-friendly name written into the README banner. */
  designName?: string;
  /** Pygame-CE version pin. Defaults to '2.5.5' (matches the in-app preview). */
  engineVersion?: string;
}

const PY_GITIGNORE = `# Python build artefacts — regenerated at runtime.
__pycache__/
*.pyc
*.pyo
*.pyd

# Virtualenvs — local-only.
.venv/
venv/
env/

# Test caches.
.pytest_cache/
.mypy_cache/

# OS / editor cruft.
.DS_Store
Thumbs.db
.idea/
.vscode/
`;

function readme(opts: ExportGamePyOptions): string {
  const name = opts.designName ?? 'Pygame project';
  const version = opts.engineVersion ?? '2.5.5';
  return `# ${name}

Exported from [open-codesign](https://github.com/OpenCoworkAI/open-codesign) — game-mode (Pygame ${version}).

## Run locally

\`\`\`bash
python3 -m venv .venv
source .venv/bin/activate    # macOS / Linux
# .venv\\Scripts\\activate      # Windows PowerShell
pip install -r requirements.txt
python main.py
\`\`\`

## Layout

\`\`\`
.
├── main.py             Entry — pygame.init + game loop
├── entities/           Player / enemy / projectile classes
├── scenes/             Per-screen controllers
├── systems/            Audio, input, save helpers
├── assets/
│   ├── sprites/
│   └── audio/
├── requirements.txt    pygame-ce ${version}
└── README.md           This file
\`\`\`

## Notes

- This is **pygame-ce** (community edition) ${version}, not the upstream pygame fork.
  Both are API-compatible; pygame-ce is the actively-maintained one and the only
  flavour Pyodide ships, so the in-app preview matches your local run.
- The exporter excludes \`__pycache__/\` and \`*.pyc\` files — Python regenerates
  them at runtime. The included \`.gitignore\` keeps your repo clean if you push.
- Generated: ${new Date().toISOString()}
`;
}

/** Files Python regenerates on every run — never include them in an
 *  export, even if they accidentally landed in the source bundle. */
function isPythonCacheFile(path: string): boolean {
  return (
    path.includes('__pycache__/') ||
    path.endsWith('.pyc') ||
    path.endsWith('.pyo') ||
    path.endsWith('.pyd')
  );
}

export async function exportGamePy(
  destinationPath: string,
  opts: ExportGamePyOptions,
): Promise<ExportResult> {
  if (opts.files.length === 0) {
    throw new CodesignError(
      'game-py export called with an empty file list',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }
  // Sanity: main.py must exist or the user gets a non-runnable archive.
  const hasMainPy = opts.files.some((f) => f.path === 'main.py');
  if (!hasMainPy) {
    throw new CodesignError(
      'game-py export requires a main.py entry point in the file bundle.',
      ERROR_CODES.EXPORTER_INPUT_INVALID,
    );
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { Zip } = await import('zip-lib');

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesign-game-py-'));
  const stagingResolved = path.resolve(stagingDir);
  try {
    const zip = new Zip();
    const seen = new Set<string>();
    for (const file of opts.files) {
      const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (isPythonCacheFile(normalized)) continue;
      const localPath = path.resolve(stagingDir, normalized);
      const rel = path.relative(stagingResolved, localPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new CodesignError(
          `game-py rejected unsafe path: ${file.path}`,
          ERROR_CODES.EXPORTER_ZIP_UNSAFE_PATH,
        );
      }
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, file.content);
      zip.addFile(localPath, normalized);
      seen.add(normalized.toLowerCase());
    }

    const version = opts.engineVersion ?? '2.5.5';

    if (!seen.has('requirements.txt')) {
      const reqPath = path.join(stagingDir, 'requirements.txt');
      await fs.writeFile(reqPath, `pygame-ce==${version}\n`, 'utf8');
      zip.addFile(reqPath, 'requirements.txt');
    }

    if (!seen.has('.gitignore')) {
      const giPath = path.join(stagingDir, '.gitignore');
      await fs.writeFile(giPath, PY_GITIGNORE, 'utf8');
      zip.addFile(giPath, '.gitignore');
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
