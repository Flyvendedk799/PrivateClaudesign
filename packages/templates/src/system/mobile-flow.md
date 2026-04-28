# Mobile flow scaffolding (when prompt asks for a mobile flow)

When the brief implies a multi-screen mobile prototype (e-learning flow,
onboarding flow, shopping checkout, fitness app, …) DO NOT reinvent the
TabBar, screen-transition pattern, safe-area handling, or lesson/quiz
scaffolding from scratch. The 2026-04-27 e-learning trace burned ~17
minutes partly because the model improvised every component. Pick up
this scaffold and customise the content.

## Frame & viewport

Wrap the entire artifact in the bundled `iphone.jsx` frame (390×844,
dynamic-island, home-indicator). Never hand-roll device chrome —
`view_frame iphone.jsx` returns a working frame in one tool call.

## TabBar pattern

Fixed bottom bar, ≥ 44 px tab height (iOS HIG minimum), 4–5 items,
accent for active, lucide-react icons. Sample shape:

```jsx
function TabBar({ active, onChange }) {
  const tabs = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'courses', icon: BookOpen, label: 'Courses' },
    { id: 'progress', icon: BarChart3, label: 'Progress' },
    { id: 'profile', icon: User, label: 'Profile' },
  ];
  return (
    <nav
      className="fixed bottom-0 inset-x-0 grid grid-cols-4 border-t border-[var(--color-border)] bg-[var(--color-surface)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {tabs.map(({ id, icon: Icon, label }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(id)}
            className={`min-h-[56px] flex flex-col items-center justify-center gap-1 text-[11px] ${
              isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'
            }`}
          >
            <Icon className="w-5 h-5" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
```

## Screen routing (no router library)

The agent MUST NOT pull in react-router or wouter for a 5-screen flow.
A single `useState` in `<App>` driving conditional render plus a
`current` discriminator is sufficient and ships zero kilobytes of
router code. CSS `opacity 200ms` between screens covers transitions.

```jsx
function App() {
  const [tab, setTab] = useState('home');
  return (
    <div className="h-full flex flex-col bg-[var(--color-bg)]">
      <main className="flex-1 overflow-y-auto pb-[calc(56px+env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)]">
        {tab === 'home' && <HomeScreen />}
        {tab === 'courses' && <CoursesScreen />}
        {tab === 'progress' && <ProgressScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </main>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
```

## Safe area

iPhone with dynamic island needs `env(safe-area-inset-top)` on the
page header AND `env(safe-area-inset-bottom)` on the TabBar. The
`<main>` padding above accounts for both. Without it the TabBar
clips under the home indicator on physical devices.

## Lesson / list scaffolding

Lesson rows have ≥ 44 px touch targets (the e-learning trace had
26 px rows — a backlog-2 §3 rule violation).

```jsx
function LessonRow({ title, duration, status }) {
  return (
    <button
      type="button"
      className="w-full min-h-[64px] flex items-center gap-3 px-4 py-3 text-left active:opacity-70 transition-opacity"
    >
      <span className="w-8 h-8 rounded-full bg-[var(--color-accent-light)] flex items-center justify-center">
        {status === 'done' ? (
          <Check className="w-4 h-4 text-[var(--color-accent)]" />
        ) : (
          <Play className="w-4 h-4 text-[var(--color-accent)]" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-[var(--color-text-primary)] truncate">
          {title}
        </span>
        <span className="block text-xs text-[var(--color-text-muted)]">{duration}</span>
      </span>
      <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)]" />
    </button>
  );
}
```

## Quiz scaffolding (when the brief mentions a quiz / assessment)

Quiz data lives in a `const QUIZ_QUESTIONS = [...]` declaration at
module scope, NOT hard-coded inside the component. This lets the
user swap content without rewriting JSX. Single-correct answers use
radio semantics; multi-correct uses checkboxes. State is one
`useState({ [questionId]: pickedId })`. Show the correct answer only
after submit, never during selection.

## What NOT to do

- **No emoji-as-icon.** When lucide-react is in scope (and it is, for
  this scaffold) every icon slot uses lucide. The 2026-04-27 trace
  mixed 🚀 / 🎓 / 📊 with a lucide tab bar — that's the canonical
  "AI tell" the anti-slop rules explicitly forbid.
- **No sub-44 px touch targets.** Lesson rows, tab items, list
  rows, and inline buttons all meet the 44 px minimum.
- **No hard-coded data the user can't swap.** Quiz questions, lesson
  lists, progress numbers all live as module-level `const` arrays.
- **No skeleton or empty state? Add one.** Lists need a "no items
  yet" state and a brief loading shimmer; without them the UI feels
  unfinished.
- **No router library.** A `useState` discriminator handles 5
  screens without 12 KB of routing.
