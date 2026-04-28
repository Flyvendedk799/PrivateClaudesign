import { useT } from '@open-codesign/i18n';
import type { UserSkill } from '@open-codesign/shared';
import { Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';

/**
 * Skills hub tab — backlog-2 #7. Lists user-authored skills the agent
 * can pick up via `list_design_skills` / `view_design_skill` on the
 * next generation. Manual-create form for v1; region-capture overlay
 * lands on top of the existing `skills:v1:extract-from-design` IPC in
 * a follow-up.
 */
export function SkillsTab() {
  const t = useT();
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    if (!window.codesign?.skills) {
      setLoading(false);
      setError(t('skills.unavailable'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await window.codesign.skills.list();
      setSkills(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!window.codesign?.skills) return;
      try {
        await window.codesign.skills.delete(id);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reload],
  );

  return (
    <section className="space-y-[var(--space-4)]">
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-[var(--space-1)]">
          <h2 className="display text-[var(--text-lg)] tracking-[var(--tracking-heading)] text-[var(--color-text-primary)] m-0">
            {t('skills.title')}
          </h2>
          <p className="text-[var(--text-sm)] text-[var(--color-text-muted)] leading-[var(--leading-body)]">
            {t('skills.body')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-on-accent)] text-[var(--text-sm)] font-medium hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          {t('skills.new')}
        </button>
      </header>

      {error ? <p className="text-[var(--text-sm)] text-[var(--color-error)]">{error}</p> : null}

      {loading ? (
        <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">
          {t('common.loading')}
        </p>
      ) : skills.length === 0 ? (
        <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">{t('skills.empty')}</p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-3)]">
          {skills.map((s) => (
            <li
              key={s.id}
              className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-3)] space-y-[var(--space-1)]"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-[var(--text-md)] font-medium text-[var(--color-text-primary)] m-0 truncate">
                  {s.name}
                </h3>
                <button
                  type="button"
                  aria-label={t('skills.delete', { name: s.name })}
                  title={t('skills.delete', { name: s.name })}
                  onClick={() => void onDelete(s.id)}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
              <p className="text-[var(--text-xs)] text-[var(--color-text-muted)] leading-[var(--leading-body)]">
                {s.whenToUse}
              </p>
              <p className="text-[var(--text-xs)] text-[var(--color-text-muted)] tabular-nums">
                {s.source.length}B · {new Date(s.updatedAt).toLocaleDateString()}
              </p>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <NewSkillDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      ) : null}
    </section>
  );
}

function NewSkillDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [whenToUse, setWhenToUse] = useState('');
  const [source, setSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.codesign?.skills) return;
    setSubmitting(true);
    setError(null);
    try {
      await window.codesign.skills.create({
        name: name.trim(),
        whenToUse: whenToUse.trim(),
        source,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('skills.newDialog.title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] animate-[overlay-in_120ms_ease-out]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg rounded-[var(--radius-2xl)] bg-[var(--color-background)] border border-[var(--color-border)] shadow-[var(--shadow-elevated)] p-5 space-y-3 animate-[panel-in_160ms_ease-out]"
      >
        <header className="flex items-start justify-between">
          <h3 className="text-[var(--text-md)] font-medium text-[var(--color-text-primary)] m-0">
            {t('skills.newDialog.title')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </header>

        <label className="block text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)] uppercase tracking-wide">
          {t('skills.newDialog.name')}
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="mobile-tab-bar"
            className="mt-1 block w-full h-9 px-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--text-sm)] text-[var(--color-text-primary)]"
          />
        </label>

        <label className="block text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)] uppercase tracking-wide">
          {t('skills.newDialog.whenToUse')}
          <input
            type="text"
            required
            maxLength={500}
            value={whenToUse}
            onChange={(e) => setWhenToUse(e.target.value)}
            placeholder={t('skills.newDialog.whenToUsePlaceholder')}
            className="mt-1 block w-full h-9 px-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--text-sm)] text-[var(--color-text-primary)]"
          />
        </label>

        <label className="block text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)] uppercase tracking-wide">
          {t('skills.newDialog.source')}
          <textarea
            required
            value={source}
            onChange={(e) => setSource(e.target.value)}
            rows={10}
            placeholder="<ComponentJSX />"
            className="mt-1 block w-full px-2 py-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--text-xs)] text-[var(--color-text-primary)] font-mono"
          />
        </label>

        {error ? <p className="text-[var(--text-sm)] text-[var(--color-error)]">{error}</p> : null}

        <footer className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 rounded-[var(--radius-md)] text-[var(--text-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="h-9 px-3 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-on-accent)] text-[var(--text-sm)] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting ? t('common.loading') : t('skills.newDialog.save')}
          </button>
        </footer>
      </form>
    </div>
  );
}
