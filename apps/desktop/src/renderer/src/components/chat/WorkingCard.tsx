import type { ChatToolCallPayload } from '@open-codesign/shared';
import {
  BookOpen,
  Check,
  CheckCircle2,
  Eye,
  FileEdit,
  FilePlus,
  FolderTree,
  Globe,
  ListChecks,
  type LucideIcon,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { lineDiff } from '../../lib/preview-diff';
import { summarizeToolCall } from '../../lib/tool-narrative';
import { useCodesignStore } from '../../store';

export interface WorkingCardProps {
  calls: ChatToolCallPayload[];
}

/**
 * Renders a tight vertical cluster of tool rows — no border, no card.
 * Visual grouping is intentional only when consecutive tool calls arrived
 * between two prose flushes; the chronological position of `set_todos` is
 * preserved by ChatMessageList rendering it as its own item via TodoListView.
 */
export function WorkingCard({ calls }: WorkingCardProps) {
  const rows = useMemo(() => buildRows(calls).filter((r) => !r.todos), [calls]);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-[var(--space-1)]">
      {rows.map((row) => (
        <ToolRowView key={row.key} row={row} />
      ))}
    </div>
  );
}

/**
 * Inline todo list — driven by the most recent `set_todos` payload at this
 * chronological position. Consumers (ChatMessageList) flush the tool bucket
 * before rendering one of these so the checklist sits where the agent actually
 * called the tool, not pinned to the end of the cluster.
 */
export function InlineTodoList({
  call,
  isLatest = false,
  isGenerating = false,
}: {
  call: ChatToolCallPayload;
  /** Whether this is the most recent set_todos in the chat. Older lists
   *  never get the inferred in-progress promotion (their work is done). */
  isLatest?: boolean;
  /** Whether the agent is currently working (an active run is in flight).
   *  When true AND this is the latest list AND there are pending items but
   *  no explicit in_progress, we visually promote the first pending item
   *  so the user sees forward motion without having to wait for the agent
   *  to call set_todos again. The model often batches todo updates at the
   *  end of a multi-step refactor (2026-04-28 traces had 90 turns between
   *  set_todos calls); the inference bridges the dead air. */
  isGenerating?: boolean;
}) {
  const todos = useMemo(() => extractTodos(call), [call]);
  if (todos.length === 0) return null;
  const inferInProgress = isLatest && isGenerating;
  return <TodoListView todos={todos} inferInProgress={inferInProgress} />;
}

interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface ToolRow {
  key: string;
  Icon: LucideIcon;
  label: string;
  detail: string | null;
  status: 'running' | 'done' | 'error';
  todos?: TodoItem[];
  editCount?: number;
  /** Story-mode label from `summarizeToolCall`. When present, the renderer
   *  shows this instead of the raw `label`; `label` is kept as the title
   *  attribute for hover-to-see-the-tool-name behaviour. */
  narrative?: string;
  /** Phase 5 — original call payload for edit rows; powers the "see diff"
   *  toggle. Only populated when the agent supplied old_str + new_str
   *  (str_replace) or content (create/insert). undefined for everything
   *  else so the toggle silently doesn't render. */
  diffPayload?: { kind: 'str_replace' | 'insert' | 'create'; oldText: string; newText: string };
  /** Backlog-3 §4 — toolCallId so the row can subscribe to the
   *  per-toolCallId streaming partial-result entry. Only set on rows
   *  that originated from a real `pending` tool call (i.e. live
   *  during a run). */
  toolCallId?: string;
}

function extractTodos(call: ChatToolCallPayload): TodoItem[] {
  const raw = (call.args?.['todos'] as unknown) ?? (call.args?.['items'] as unknown) ?? null;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it): TodoItem | null => {
      if (typeof it !== 'object' || it === null) return null;
      const o = it as Record<string, unknown>;
      const text =
        typeof o['content'] === 'string'
          ? (o['content'] as string)
          : typeof o['text'] === 'string'
            ? (o['text'] as string)
            : null;
      if (text === null) return null;
      const rawStatus = o['status'];
      const status: TodoItem['status'] =
        rawStatus === 'completed' || rawStatus === 'in_progress' || rawStatus === 'pending'
          ? rawStatus
          : o['checked'] === true
            ? 'completed'
            : 'pending';
      return { text, status };
    })
    .filter((x): x is TodoItem => x !== null);
}

function isEditCommand(call: ChatToolCallPayload): boolean {
  return call.command === 'str_replace' || call.command === 'insert';
}

function isCreateCommand(call: ChatToolCallPayload): boolean {
  return call.command === 'create';
}

function isTextEditorTool(call: ChatToolCallPayload): boolean {
  return call.toolName === 'str_replace_based_edit_tool' || call.toolName === 'text_editor';
}

function pathOf(call: ChatToolCallPayload): string | null {
  const p = call.args?.['path'];
  return typeof p === 'string' ? p : null;
}

/** Phase 5 — extract old/new pair from a text-editor call so the row can
 *  render an inline diff. Only populates for shapes where both sides are
 *  available; agents sometimes call str_replace with empty old_str etc. */
function extractDiffPayload(call: ChatToolCallPayload): ToolRow['diffPayload'] {
  if (!isTextEditorTool(call)) return undefined;
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.command === 'str_replace') {
    const oldText = args['old_str'];
    const newText = args['new_str'];
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
    return { kind: 'str_replace', oldText, newText };
  }
  if (call.command === 'insert') {
    const newText = args['insert_str'] ?? args['new_str'];
    if (typeof newText !== 'string') return undefined;
    return { kind: 'insert', oldText: '', newText };
  }
  if (call.command === 'create') {
    const newText = args['file_text'] ?? args['contents'];
    if (typeof newText !== 'string') return undefined;
    return { kind: 'create', oldText: '', newText };
  }
  return undefined;
}

function iconAndLabel(call: ChatToolCallPayload): { Icon: LucideIcon; label: string } {
  if (call.toolName === 'set_todos') return { Icon: ListChecks, label: 'set_todos' };
  if (call.toolName === 'load_skill') return { Icon: Sparkles, label: 'load_skill' };
  if (call.toolName === 'verify_html') return { Icon: CheckCircle2, label: 'verify_html' };
  if (call.toolName === 'read_url') return { Icon: Globe, label: 'read_url' };
  if (call.toolName === 'read_design_system')
    return { Icon: BookOpen, label: 'read_design_system' };
  if (call.toolName === 'list_files') return { Icon: FolderTree, label: 'list_files' };
  if (call.toolName === 'str_replace_based_edit_tool' || call.toolName === 'text_editor') {
    if (call.command === 'view') return { Icon: Eye, label: 'view' };
    if (isCreateCommand(call)) return { Icon: FilePlus, label: 'create' };
    if (isEditCommand(call)) return { Icon: FileEdit, label: 'edit' };
    return { Icon: FileEdit, label: call.command ?? 'edit' };
  }
  return { Icon: Wrench, label: call.toolName };
}

function detailOf(call: ChatToolCallPayload): string | null {
  const path = pathOf(call);
  if (path) return path;
  const name = call.args?.['name'];
  if (typeof name === 'string') return name;
  const url = call.args?.['url'];
  if (typeof url === 'string') return url;
  return null;
}

export function buildRows(calls: ChatToolCallPayload[]): ToolRow[] {
  const rows: ToolRow[] = [];
  let lastEditIdx = -1;
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    if (!call) continue;

    // Internal signal tools — hide from UI
    if (call.toolName === 'done') continue;

    if (call.toolName === 'set_todos') {
      const items = extractTodos(call);
      const existingIdx = rows.findIndex((r) => r.todos !== undefined);
      const existing = existingIdx >= 0 ? rows[existingIdx] : undefined;
      const row: ToolRow = {
        key: `todos-${i}`,
        Icon: ListChecks,
        label: 'set_todos',
        detail: null,
        status: call.status,
        todos: items.length > 0 ? items : (existing?.todos ?? items),
        narrative: summarizeToolCall(call),
      };
      if (existingIdx >= 0) {
        rows[existingIdx] = row;
      } else {
        rows.push(row);
      }
      continue;
    }

    const { Icon, label } = iconAndLabel(call);
    const detail = detailOf(call);
    const isFileEdit = isTextEditorTool(call) && Boolean(detail);

    if (isFileEdit && detail) {
      const candidateIdx =
        lastEditIdx >= 0 && rows[lastEditIdx]?.detail === detail ? lastEditIdx : -1;
      const last = candidateIdx >= 0 ? rows[candidateIdx] : undefined;
      if (last) {
        last.editCount = (last.editCount ?? 1) + 1;
        last.label = 'edit';
        last.Icon = FileEdit;
        // Use the most recent call's narrative so the row reflects the latest
        // action ("Wired interactivity" trumps an earlier "Added hero").
        last.narrative = summarizeToolCall(call);
        if (call.status === 'running') last.status = 'running';
        else if (call.status === 'error') last.status = 'error';
        else if (last.status !== 'running' && last.status !== 'error') last.status = 'done';
        const dp = extractDiffPayload(call);
        if (dp) last.diffPayload = dp;
        continue;
      }
    }

    const diffPayload = extractDiffPayload(call);
    rows.push({
      key: `c-${i}`,
      Icon,
      label,
      detail,
      status: call.status,
      narrative: summarizeToolCall(call),
      ...(diffPayload ? { diffPayload } : {}),
      ...(call.toolCallId !== undefined ? { toolCallId: call.toolCallId } : {}),
    });
    if (isFileEdit) lastEditIdx = rows.length - 1;
  }
  return rows;
}

/* ── Todo checklist card ────────────────────────────────────────────── */

function TodoListView({
  todos,
  inferInProgress = false,
}: {
  todos: TodoItem[];
  inferInProgress?: boolean;
}) {
  // Inference: if the agent hasn't marked anything in_progress and the run
  // is active, treat the first pending item as visually in_progress so the
  // checklist shows motion. Real agent state always wins.
  const hasExplicitInProgress = todos.some((t) => t.status === 'in_progress');
  const firstPendingIdx =
    inferInProgress && !hasExplicitInProgress ? todos.findIndex((t) => t.status === 'pending') : -1;
  const effectiveStatus = (idx: number, t: TodoItem): TodoItem['status'] =>
    idx === firstPendingIdx ? 'in_progress' : t.status;
  const done = todos.filter((it) => it.status === 'completed').length;
  const total = todos.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // D2 — track which todos JUST flipped to completed since the last render
  // and apply a one-shot scale+glow animation to the checkbox. The
  // animation is purely visual feedback (the CSS class auto-removes via
  // the keyframe's natural end). We key by index+text so ordered lists
  // don't false-positive when an item is renamed.
  const prevStatusRef = useRef<Map<string, TodoItem['status']>>(new Map());
  const justChecked = useMemo(() => {
    const out = new Set<string>();
    const prev = prevStatusRef.current;
    todos.forEach((t, i) => {
      const key = `${i}::${t.text}`;
      const before = prev.get(key);
      if (before !== 'completed' && t.status === 'completed') out.add(key);
    });
    return out;
  }, [todos]);
  useEffect(() => {
    const next = new Map<string, TodoItem['status']>();
    todos.forEach((t, i) => next.set(`${i}::${t.text}`, t.status));
    prevStatusRef.current = next;
  }, [todos]);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border-muted)] bg-[var(--color-surface)] px-[var(--space-3)] py-[var(--space-2_5)] space-y-[var(--space-2)]">
      {/* Progress header */}
      <div className="flex items-center gap-[var(--space-2)]">
        <ListChecks
          className="w-[13px] h-[13px] shrink-0 text-[var(--color-text-muted)]"
          aria-hidden
        />
        <div className="flex-1 h-[3px] rounded-full bg-[var(--color-background-secondary)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[11px] tabular-nums text-[var(--color-text-muted)] shrink-0">
          {done}/{total}
        </span>
      </div>
      {/* Items */}
      <div className="space-y-[3px]">
        {todos.map((todo, i) => {
          const status = effectiveStatus(i, todo);
          return (
            <div
              key={`${i}-${todo.text.slice(0, 12)}`}
              className="flex items-start gap-[var(--space-2)] text-[12.5px] leading-[1.4]"
            >
              {(() => {
                const animateCheck = justChecked.has(`${i}::${todo.text}`);
                if (status === 'completed') {
                  return (
                    <span
                      className={`mt-[2px] inline-flex items-center justify-center w-[14px] h-[14px] rounded-[3px] bg-[var(--color-accent)] shrink-0 ${animateCheck ? 'codesign-todo-check-in' : ''}`}
                    >
                      <Check className="w-[10px] h-[10px] text-white" strokeWidth={3} />
                    </span>
                  );
                }
                if (status === 'in_progress') {
                  return (
                    <span className="mt-[2px] inline-block w-[14px] h-[14px] rounded-[3px] border-2 border-[var(--color-accent)] bg-[var(--color-accent)]/10 shrink-0 animate-pulse" />
                  );
                }
                return (
                  <span className="mt-[2px] inline-block w-[14px] h-[14px] rounded-[3px] border border-[var(--color-border)] shrink-0" />
                );
              })()}
              <span
                className={
                  status === 'completed'
                    ? `line-through text-[var(--color-text-muted)] ${justChecked.has(`${i}::${todo.text}`) ? 'codesign-todo-strike-in' : ''}`
                    : status === 'in_progress'
                      ? 'text-[var(--color-text-primary)] font-medium'
                      : 'text-[var(--color-text-primary)]'
                }
              >
                {todo.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Individual tool row ────────────────────────────────────────────── */

function ToolRowView({ row }: { row: ToolRow }) {
  const { Icon } = row;
  // Backlog-3 §4 — partial-result preview while the row is running.
  // Subscribes only to its own toolCallId entry so unrelated tool
  // updates don't re-render. `?? null` so the stable selector returns
  // a stable reference for shallow-equality bailout.
  const partial = useCodesignStore((s) =>
    row.toolCallId !== undefined && row.status === 'running'
      ? (s.streamingToolResults[row.toolCallId] ?? null)
      : null,
  );
  // Story-mode label when the narrative helper produced one; otherwise fall
  // back to the raw tool name. The detail (file path, etc.) appends only
  // when the narrative didn't already incorporate it.
  const showDetail =
    row.detail !== null && (row.narrative === undefined || !row.narrative.includes(row.detail));
  const detailText =
    showDetail && row.detail && row.editCount && row.editCount > 1
      ? `${row.detail} (${row.editCount} edits)`
      : showDetail
        ? row.detail
        : null;
  // Hover tooltip surfaces the raw tool name + path so power users can still
  // see what's actually happening. Format: "raw_tool_name · /path".
  const tooltip = [row.label, row.detail].filter(Boolean).join(' · ');
  const primary = row.narrative ?? row.label;
  const [diffOpen, setDiffOpen] = useState(false);
  const hasDiff = row.diffPayload !== undefined;

  return (
    <div className="text-[12.5px] py-[1px]">
      <div className="flex items-center gap-[6px]" title={tooltip || row.label}>
        {row.status === 'running' ? (
          <span className="relative inline-flex w-[14px] h-[14px] items-center justify-center shrink-0">
            <span className="absolute inline-block w-[7px] h-[7px] rounded-full bg-[var(--color-accent)] animate-pulse" />
            <span className="absolute inline-block w-[12px] h-[12px] rounded-full border border-[var(--color-accent)]/30 animate-ping" />
          </span>
        ) : row.status === 'error' ? (
          <Icon className="w-[14px] h-[14px] shrink-0 text-[var(--color-error)]" aria-hidden />
        ) : (
          <Icon className="w-[14px] h-[14px] shrink-0 text-[var(--color-text-muted)]" aria-hidden />
        )}
        <span className="text-[var(--color-text-primary)]">{primary}</span>
        {detailText ? (
          <span className="font-[var(--font-mono),ui-monospace,Menlo,monospace] text-[var(--color-text-muted)] truncate">
            {detailText}
          </span>
        ) : null}
        {hasDiff ? (
          <button
            type="button"
            onClick={() => setDiffOpen((v) => !v)}
            className="ml-auto rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-background-secondary)] px-[6px] py-[1px] text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-background-tertiary)]"
            aria-expanded={diffOpen}
            title="Show / hide diff"
          >
            {diffOpen ? 'Hide diff' : 'Diff'}
          </button>
        ) : null}
      </div>
      {hasDiff && diffOpen && row.diffPayload ? <DiffBlock payload={row.diffPayload} /> : null}
      {partial !== null ? <ToolProgressStrip partial={partial} /> : null}
    </div>
  );
}

/** Backlog-3 §4 — compact strip below a running tool row. Shows
 *  `progressPct` as a thin bar when set; otherwise falls back to a
 *  byte-count line. The preview text (when non-empty) anchors the
 *  user to "what is the tool actually doing right now". */
function ToolProgressStrip({
  partial,
}: {
  partial: { byteCount?: number; preview?: string; progressPct?: number };
}) {
  const pct =
    typeof partial.progressPct === 'number'
      ? Math.max(0, Math.min(100, partial.progressPct))
      : null;
  const hasPreview = typeof partial.preview === 'string' && partial.preview.length > 0;
  const hasBytes = typeof partial.byteCount === 'number' && partial.byteCount > 0;
  if (pct === null && !hasPreview && !hasBytes) return null;
  return (
    <div className="mt-[var(--space-1)] ml-[20px] text-[11px] text-[var(--color-text-muted)]">
      {pct !== null ? (
        <div
          className="relative h-[3px] w-[140px] overflow-hidden rounded-full bg-[var(--color-border-subtle)]"
          aria-label={`progress ${pct}%`}
        >
          <div
            className="absolute inset-y-0 left-0 bg-[var(--color-accent)] transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {hasPreview ? (
        <div className="mt-[2px] truncate font-[var(--font-mono),ui-monospace,Menlo,monospace]">
          {partial.preview}
        </div>
      ) : null}
      {pct === null && hasBytes ? (
        <div className="tabular-nums">
          {((partial.byteCount ?? 0) / 1024).toFixed(1)} KB streamed
        </div>
      ) : null}
    </div>
  );
}

function DiffBlock({ payload }: { payload: NonNullable<ToolRow['diffPayload']> }) {
  const lines = useMemo(
    () => lineDiff(payload.oldText, payload.newText, { context: 2, maxLines: 80 }),
    [payload.oldText, payload.newText],
  );
  return (
    <div className="mt-[var(--space-1)] ml-[20px] rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-background)] font-[var(--font-mono),ui-monospace,Menlo,monospace] text-[11px] leading-[1.4]">
      {lines.map((l, i) => {
        const cls =
          l.kind === 'add'
            ? 'bg-[var(--color-success,#16a34a)]/10 text-[var(--color-success,#166534)]'
            : l.kind === 'remove'
              ? 'bg-[var(--color-danger,#dc2626)]/10 text-[var(--color-danger,#991b1b)]'
              : 'text-[var(--color-text-muted)]';
        const prefix = l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ';
        return (
          <div key={i} className={`px-[var(--space-2)] whitespace-pre-wrap break-all ${cls}`}>
            {prefix} {l.text}
          </div>
        );
      })}
    </div>
  );
}
