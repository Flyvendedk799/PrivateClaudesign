/**
 * Heuristic chat-row narrative for tool calls.
 *
 * Replaces the raw tool-name labels ("str_replace_based_edit_tool",
 * "set_todos") with story-mode prose ("Added hero", "Updated plan: 3 / 6
 * todos done", "Verified — accepted"). Pairs with WorkingCard.tsx to make
 * the chat read as a design narrative instead of an activity log.
 *
 * Pure function — no IO, no React. Easy to unit-test against fixtures.
 */
import type { ChatToolCallPayload } from '@open-codesign/shared';

interface TodoItem {
  text?: unknown;
  checked?: unknown;
}

/** Truncate a label so chat rows stay single-line. */
function truncate(s: string, max = 48): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fileName(path: string | undefined): string {
  if (!path) return 'file';
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Pull the most informative section/heading hint from a freshly inserted
 *  block of text. Looks for HTML headings, JSX comment markers, and
 *  className= hints in that order. */
function extractSectionHint(newStr: string): string | null {
  const headingMatch = newStr.match(/<h[1-3][^>]*>([\s\S]+?)<\/h[1-3]>/i);
  if (headingMatch?.[1]) {
    const text = headingMatch[1].replace(/<[^>]*>/g, '').trim();
    if (text.length > 0) return truncate(text, 40);
  }
  // JSX block comment marker: {/* hero section */}
  const blockComment = newStr.match(/\{\s*\/\*\s*([^*]+?)\s*\*\/\s*\}/);
  if (blockComment?.[1]) return truncate(blockComment[1].trim(), 40);
  // className="hero" / "pricing" / etc.
  const classHint = newStr.match(/className\s*=\s*["'`]([a-zA-Z][a-zA-Z0-9-]*?)(?:[\s"'`]|$)/);
  if (classHint?.[1] && classHint[1].length > 2) return classHint[1];
  return null;
}

const KNOWN_SECTIONS = [
  'hero',
  'nav',
  'header',
  'footer',
  'pricing',
  'features',
  'testimonials',
  'cta',
  'about',
  'contact',
];

/** Identify if a `new_str` introduces a brand-new top-level section
 *  (`<section>`, `<header>`, `<nav>`, `<footer>`). */
function detectSectionInsert(newStr: string): string | null {
  if (/<(section|header|nav|footer)\b/i.test(newStr)) {
    const hint = extractSectionHint(newStr);
    if (hint) return hint;
    // Fall back to common section keywords in the text.
    const lower = newStr.toLowerCase();
    for (const section of KNOWN_SECTIONS) {
      if (lower.includes(section)) return section;
    }
    return 'section';
  }
  return null;
}

function detectInteractivityInsert(newStr: string): boolean {
  return (
    /\bonClick\s*=/.test(newStr) ||
    /\bonChange\s*=/.test(newStr) ||
    /\buseState\s*\(/.test(newStr) ||
    /\bsetState\s*\(/.test(newStr) ||
    /\baddEventListener\s*\(/.test(newStr)
  );
}

function summarizeStrReplace(call: ChatToolCallPayload): string {
  const path = (call.args['path'] as string | undefined) ?? undefined;
  const oldStr = (call.args['old_str'] as string | undefined) ?? '';
  const newStr = (call.args['new_str'] as string | undefined) ?? '';
  const file = fileName(path);
  // 1. New section?
  const section = detectSectionInsert(newStr);
  if (section) return `Added ${section}${file !== 'index.html' ? ` to ${file}` : ''}`;
  // 2. Wired interactivity (only if the new content adds it AND the old didn't have it)
  if (detectInteractivityInsert(newStr) && !detectInteractivityInsert(oldStr)) {
    const hint = extractSectionHint(newStr);
    return `Wired interactivity${hint ? ` in ${hint}` : ''}`;
  }
  // 3. Net-negative byte change → trim
  if (oldStr.length > newStr.length + 32) {
    return `Trimmed ${file} (-${oldStr.length - newStr.length}b)`;
  }
  // 4. Small touch-up — refer to nearest hint or fall back to file.
  const hint = extractSectionHint(newStr);
  if (hint) return `Refined ${hint}`;
  return `Edited ${file}`;
}

function summarizeCreate(call: ChatToolCallPayload): string {
  const path = (call.args['path'] as string | undefined) ?? undefined;
  const file = fileName(path);
  if (file === 'index.html') return 'Started the artifact scaffold';
  if (file.endsWith('.css')) return `Added stylesheet ${file}`;
  if (file.endsWith('.js') || file.endsWith('.mjs')) return `Added module ${file}`;
  if (file.endsWith('.json')) return `Added data file ${file}`;
  return `Created ${file}`;
}

function summarizeView(call: ChatToolCallPayload): string {
  const path = (call.args['path'] as string | undefined) ?? undefined;
  const range = call.args['view_range'];
  const file = fileName(path);
  if (Array.isArray(range)) return `Reading ${file} (lines ${range.join('-')})`;
  return `Reading ${file}`;
}

function summarizeTextEditor(call: ChatToolCallPayload): string {
  const command = (call.args['command'] as string | undefined) ?? call.command;
  if (command === 'create') return summarizeCreate(call);
  if (command === 'str_replace') return summarizeStrReplace(call);
  if (command === 'view') return summarizeView(call);
  if (command === 'insert')
    return `Inserted into ${fileName(call.args['path'] as string | undefined)}`;
  return `Edited ${fileName(call.args['path'] as string | undefined)}`;
}

function summarizeSetTodos(call: ChatToolCallPayload): string {
  const items = (call.args['items'] as TodoItem[] | undefined) ?? [];
  const total = items.length;
  const done = items.filter((it) => it?.checked === true).length;
  if (total === 0) return 'Cleared the plan';
  return `Updated plan: ${done} / ${total} todos done`;
}

function summarizeDone(call: ChatToolCallPayload): string {
  const result = call.result as { status?: string; errors?: unknown[] } | undefined;
  const status = result?.status;
  const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0;
  if (status === 'ok') return 'Verified — artifact accepted';
  if (status === 'has_errors')
    return `Verifying — ${errorCount} issue${errorCount === 1 ? '' : 's'} to fix`;
  return 'Verifying';
}

/** Produce a story-mode label for a chat tool-call row. Falls back to the
 *  raw tool name when nothing more specific applies. */
export function summarizeToolCall(call: ChatToolCallPayload): string {
  switch (call.toolName) {
    case 'str_replace_based_edit_tool':
    case 'text_editor':
      return summarizeTextEditor(call);
    case 'set_todos':
      return summarizeSetTodos(call);
    case 'done':
      return summarizeDone(call);
    case 'declare_tweak_schema':
      return 'Defined tweakable controls';
    case 'list_design_skills':
      return 'Browsing the design library';
    case 'view_design_skill': {
      const name = (call.args['name'] as string | undefined) ?? 'skill';
      return `Loaded design skill: ${name.replace(/\.jsx$/, '')}`;
    }
    case 'view_frame': {
      const name = (call.args['name'] as string | undefined) ?? 'frame';
      return `Loaded device frame: ${name.replace(/\.jsx$/, '')}`;
    }
    case 'generate_image_asset': {
      const purpose = (call.args['purpose'] as string | undefined) ?? 'image';
      return `Generating ${purpose} image`;
    }
    case 'read_url': {
      const url = (call.args['url'] as string | undefined) ?? '';
      return `Reading reference: ${truncate(url.replace(/^https?:\/\//, ''), 36)}`;
    }
    case 'read_design_system':
      return 'Loading design system tokens';
    case 'list_files':
      return 'Listing project files';
    default:
      return `${call.verbGroup ?? 'Working'} · ${call.toolName}`;
  }
}
