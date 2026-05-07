import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodesignError, ERROR_CODES } from '@open-codesign/shared';
import type { LoadedSkillRule } from '@open-codesign/shared';
import { type LoadedSkill, SkillFrontmatterV1 } from './types.js';

// ---------------------------------------------------------------------------
// Inline YAML frontmatter parser
//
// Supports the subset of YAML needed for SKILL.md files:
//   - Top-level key: value pairs
//   - Folded (>) and literal (|) block scalars
//   - Nested block mappings (indented sub-keys, e.g. "trigger:")
//   - Inline sequences: key: [a, b, c]
//   - Block sequences: "  - item"
//   - Scalar types: string, number, boolean, null
//
// Does NOT support anchors, multi-document streams, or complex types.
// ---------------------------------------------------------------------------

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  const n = Number(t);
  if (!Number.isNaN(n) && t !== '') return n;
  return t;
}

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '');
}

function indentOf(line: string): number {
  return line.match(/^(\s*)/)?.[1]?.length ?? 0;
}

function parseInlineSequence(s: string): unknown[] {
  const inner = s.slice(1, s.lastIndexOf(']'));
  return inner
    .split(',')
    .map(unquote)
    .filter((item) => item.length > 0);
}

function parseBlockScalar(
  lines: string[],
  start: number,
  baseIndent: number,
  style: '>' | '|',
): [string, number] {
  const blockLines: string[] = [];
  let i = start;
  while (i < lines.length) {
    const next = lines[i] ?? '';
    if (next.trim() === '') {
      blockLines.push('');
      i++;
      continue;
    }
    if (indentOf(next) <= baseIndent) break;
    blockLines.push(next.trim());
    i++;
  }
  // Folded (>) joins lines with spaces; literal (|) preserves newlines.
  const joiner = style === '|' ? '\n' : ' ';
  return [blockLines.join(joiner).trim(), i];
}

function parseBlockSequence(
  lines: string[],
  start: number,
  baseIndent: number,
): [unknown[], number] {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const seqLine = lines[i] ?? '';
    if (seqLine.trim() === '') {
      i++;
      continue;
    }
    if (indentOf(seqLine) <= baseIndent) break;
    if (seqLine.trimStart().startsWith('- ')) {
      items.push(parseScalar(unquote(seqLine.replace(/^\s*-\s*/, '').trim())));
    }
    i++;
  }
  return [items, i];
}

function skipBlankLines(lines: string[], start: number): number {
  let i = start;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  return i;
}

function isBlockScalarIndicator(s: string): boolean {
  return s === '>' || s === '|' || s.startsWith('> ') || s.startsWith('| ');
}

/** Resolve the value for an empty-after-colon key, returning [value, nextLineIndex]. */
function resolveEmptyValue(lines: string[], start: number, baseIndent: number): [unknown, number] {
  const lookAheadIdx = skipBlankLines(lines, start);
  const nextLine = lines[lookAheadIdx] ?? '';
  const nextIndent = indentOf(nextLine);

  if (nextIndent <= baseIndent) return [null, start];
  if (nextLine.trimStart().startsWith('- ')) return parseBlockSequence(lines, start, baseIndent);
  return parseMapping(lines, start, nextIndent);
}

/**
 * Parse a sequence of YAML lines into a plain object.
 * `baseIndent` is the expected indentation level of keys in this mapping.
 */
function parseMapping(
  lines: string[],
  start: number,
  baseIndent: number,
): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const raw = lines[i] ?? '';

    if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
      i++;
      continue;
    }

    const indent = indentOf(raw);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      i++;
      continue;
    }

    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = raw.slice(0, colonIdx).trim();
    const afterTrimmed = raw.slice(colonIdx + 1).trim();
    i++;

    if (afterTrimmed.startsWith('[')) {
      result[key] = parseInlineSequence(afterTrimmed);
    } else if (isBlockScalarIndicator(afterTrimmed)) {
      const style = afterTrimmed.charAt(0) === '|' ? '|' : '>';
      const [value, nextI] = parseBlockScalar(lines, i, baseIndent, style);
      result[key] = value;
      i = nextI;
    } else if (afterTrimmed === '{}') {
      result[key] = {};
    } else if (afterTrimmed === '') {
      const [value, nextI] = resolveEmptyValue(lines, i, baseIndent);
      result[key] = value;
      i = nextI;
    } else {
      result[key] = parseScalar(unquote(afterTrimmed));
    }
  }

  return [result, i];
}

interface ParsedMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): ParsedMd {
  // Match --- delimited frontmatter at the very start of the file
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const yamlSrc = m[1] ?? '';
  const body = m[2] ?? '';
  const lines = yamlSrc.split('\n');
  const [frontmatter] = parseMapping(lines, 0, 0);
  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadSkillsFromDir(
  dir: string,
  source: LoadedSkill['source'],
): Promise<LoadedSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const skills: LoadedSkill[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    if (extname(entry) === '.md') {
      // Existing flat-skill path — preserved byte-for-byte. Adding the
      // folder-skill branch below MUST NOT change anything that lands
      // here. (motion-graphics-plan §0.3 byte-identical contract.)
      const id = basename(entry, '.md');
      const flatSkill = await loadFlatSkill({ filePath: fullPath, id, source, errors });
      if (flatSkill !== null) skills.push(flatSkill);
      continue;
    }

    // Folder-format detection — only triggers on directories that
    // contain a SKILL.md. Anything else is silently ignored, matching
    // the pre-existing skip behavior for non-.md entries.
    let isDir = false;
    try {
      isDir = (await stat(fullPath)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const folderSkill = await loadFolderSkill({ dir: fullPath, source, errors });
    if (folderSkill !== null) skills.push(folderSkill);
  }

  if (errors.length > 0) {
    throw new CodesignError(
      `Skill loading failed:\n${errors.join('\n')}`,
      ERROR_CODES.SKILL_LOAD_FAILED,
    );
  }

  return skills;
}

interface FlatLoadInput {
  filePath: string;
  id: string;
  source: LoadedSkill['source'];
  errors: string[];
}

async function loadFlatSkill(input: FlatLoadInput): Promise<LoadedSkill | null> {
  let raw: string;
  try {
    raw = await readFile(input.filePath, 'utf-8');
  } catch (err) {
    input.errors.push(
      `Could not read ${input.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  let parsed: ParsedMd;
  try {
    parsed = parseFrontmatter(raw);
  } catch (err) {
    input.errors.push(
      `Could not parse frontmatter in ${input.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const raw_fm = { name: input.id, ...parsed.frontmatter };
  const result = SkillFrontmatterV1.safeParse(raw_fm);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join('; ');
    input.errors.push(`Invalid frontmatter in ${input.filePath}: ${issues}`);
    return null;
  }
  return {
    id: input.id,
    source: input.source,
    frontmatter: result.data,
    body: parsed.body.trim(),
  };
}

interface FolderLoadInput {
  dir: string;
  source: LoadedSkill['source'];
  errors: string[];
}

async function loadFolderSkill(input: FolderLoadInput): Promise<LoadedSkill | null> {
  const skillMdPath = join(input.dir, 'SKILL.md');
  let body: string;
  try {
    body = await readFile(skillMdPath, 'utf-8');
  } catch {
    // Directory without SKILL.md — silently skip (matches the old
    // "non-.md entries are ignored" behavior bit-for-bit).
    return null;
  }
  let parsed: ParsedMd;
  try {
    parsed = parseFrontmatter(body);
  } catch (err) {
    input.errors.push(
      `Could not parse frontmatter in ${skillMdPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const id = basename(input.dir);
  const raw_fm = { name: id, ...parsed.frontmatter };
  const result = SkillFrontmatterV1.safeParse(raw_fm);
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join('; ');
    input.errors.push(`Invalid frontmatter in ${skillMdPath}: ${issues}`);
    return null;
  }
  const rules = await loadRules(input.dir);
  return {
    id,
    source: input.source,
    frontmatter: result.data,
    body: parsed.body.trim(),
    rules,
  };
}

async function loadRules(skillDir: string): Promise<LoadedSkillRule[]> {
  const rulesDir = join(skillDir, 'rules');
  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch {
    return [];
  }
  const rules: LoadedSkillRule[] = [];
  for (const entry of entries) {
    if (extname(entry) !== '.md') continue;
    const fullPath = join(rulesDir, entry);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }
    rules.push({ path: `rules/${entry}`, content });
  }
  rules.sort((a, b) => a.path.localeCompare(b.path));
  return rules;
}

export interface LoadAllSkillsOptions {
  builtinDir: string;
  /** ~/.config/open-codesign/skills */
  userDir?: string | undefined;
  /** <project>/.codesign/skills */
  projectDir?: string | undefined;
}

/**
 * Load skills from all three tiers.
 * Priority order: project > user > builtin.
 * When two skills share the same id, the higher-priority one wins.
 */
export async function loadAllSkills(opts: LoadAllSkillsOptions): Promise<LoadedSkill[]> {
  const [builtin, user, project] = await Promise.all([
    loadSkillsFromDir(opts.builtinDir, 'builtin'),
    opts.userDir ? loadSkillsFromDir(opts.userDir, 'user') : Promise.resolve([]),
    opts.projectDir ? loadSkillsFromDir(opts.projectDir, 'project') : Promise.resolve([]),
  ]);

  // Merge with priority: project overrides user overrides builtin
  const map = new Map<string, LoadedSkill>();
  for (const skill of [...builtin, ...user, ...project]) {
    map.set(skill.id, skill);
  }

  return [...map.values()];
}

/**
 * Load the four builtin skills shipped inside this package
 * (`packages/core/src/skills/builtin/*.md`). Resolved relative to this file via
 * `import.meta.url` so it works in ESM, Vite, and Electron main without
 * hard-coded paths.
 */
export async function loadBuiltinSkills(): Promise<LoadedSkill[]> {
  const builtinDir = fileURLToPath(new URL('./builtin/', import.meta.url));
  return loadSkillsFromDir(builtinDir, 'builtin');
}
