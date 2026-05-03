/**
 * gameplan §B2 — game-godot-project exporter tests.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportGameGodotProject } from './game-godot-project';

let workDir = '';

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'open-codesign-godot-export-')));
});
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

async function unzipTo(zipPath: string, destDir: string): Promise<string[]> {
  const ZipFile: typeof import('zip-lib') = await import('zip-lib');
  mkdirSync(destDir, { recursive: true });
  await ZipFile.extract(zipPath, destDir);
  const { readdirSync } = await import('node:fs');
  const out: string[] = [];
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  }
  walk(destDir, '');
  return out.sort();
}

describe('exportGameGodotProject', () => {
  it('produces a valid Godot project zip with the required files', async () => {
    const dest = join(workDir, 'game.zip');
    const result = await exportGameGodotProject(dest, {
      files: [
        {
          path: 'project.godot',
          content: `[application]\nconfig/name="Topdown RPG"\nrun/main_scene="res://main.tscn"\n`,
        },
        {
          path: 'main.tscn',
          content:
            '[gd_scene format=3]\n[ext_resource type="Script" path="res://scripts/main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
        },
        { path: 'scripts/main.gd', content: 'extends Node2D\nfunc _ready():\n\tpass\n' },
        { path: 'assets/sprites/player.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
      designName: 'Topdown RPG',
      engineVersion: '4.3',
    });
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);

    const extracted = await unzipTo(dest, join(workDir, 'unzipped'));
    expect(extracted).toContain('project.godot');
    expect(extracted).toContain('main.tscn');
    expect(extracted).toContain('scripts/main.gd');
    expect(extracted).toContain('assets/sprites/player.png');
    expect(extracted).toContain('.gitignore');
    expect(extracted).toContain('README.md');
  });

  it('writes a Godot-shaped .gitignore that excludes the per-machine cache', async () => {
    const dest = join(workDir, 'gi.zip');
    await exportGameGodotProject(dest, {
      files: [{ path: 'project.godot', content: '[application]\n' }],
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    const gi = readFileSync(join(extracted, '.gitignore'), 'utf8');
    expect(gi).toContain('.godot/');
    expect(gi).toContain('.import/cache/');
    expect(gi).toContain('*.tmp');
  });

  it('writes a README that points at Godot 4.3+ and the F5 path', async () => {
    const dest = join(workDir, 'readme.zip');
    await exportGameGodotProject(dest, {
      files: [{ path: 'project.godot', content: '[application]\n' }],
      designName: 'My RPG',
      engineVersion: '4.3',
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    const readme = readFileSync(join(extracted, 'README.md'), 'utf8');
    expect(readme).toContain('My RPG');
    expect(readme).toContain('Godot 4.3+');
    expect(readme).toContain('F5');
    expect(readme).toContain('main.tscn');
  });

  it('drops cache-files (.godot/, .import/cache/, *.tmp) the model accidentally generated', async () => {
    const dest = join(workDir, 'clean.zip');
    await exportGameGodotProject(dest, {
      files: [
        { path: 'project.godot', content: '[application]\n' },
        // Defence-in-depth: even if these slip into design_files, the
        // exporter keeps them out of the user-distributable zip.
        { path: '.godot/uid_cache.bin', content: Buffer.from([0xff]) },
        { path: '.import/cache/foo.md5', content: 'cache' },
        { path: 'scratch.tmp', content: 'temp' },
      ],
    });
    const extracted = await unzipTo(dest, join(workDir, 'unzipped'));
    expect(extracted).toContain('project.godot');
    expect(extracted).not.toContain('.godot/uid_cache.bin');
    expect(extracted).not.toContain('.import/cache/foo.md5');
    expect(extracted).not.toContain('scratch.tmp');
  });

  it('does not overwrite a user-authored .gitignore or README', async () => {
    const dest = join(workDir, 'authored.zip');
    await exportGameGodotProject(dest, {
      files: [
        { path: 'project.godot', content: '[application]\n' },
        { path: '.gitignore', content: '# custom .gitignore\nlocal-only/\n' },
        { path: 'README.md', content: '# Custom README\nDont overwrite.\n' },
      ],
    });
    const extracted = join(workDir, 'unzipped');
    await unzipTo(dest, extracted);
    const gi = readFileSync(join(extracted, '.gitignore'), 'utf8');
    const readme = readFileSync(join(extracted, 'README.md'), 'utf8');
    expect(gi).toContain('# custom .gitignore');
    expect(gi).not.toContain('.godot/');
    expect(readme).toContain('Custom README');
  });

  it('throws when project.godot is missing (non-importable archive)', async () => {
    const dest = join(workDir, 'no-project.zip');
    await expect(
      exportGameGodotProject(dest, {
        files: [{ path: 'main.tscn', content: '[gd_scene format=3]\n' }],
      }),
    ).rejects.toThrow(/project\.godot manifest/);
  });

  it('throws when given an empty file list', async () => {
    const dest = join(workDir, 'empty.zip');
    await expect(exportGameGodotProject(dest, { files: [] })).rejects.toThrow(/empty file list/);
  });
});
