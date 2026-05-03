/**
 * Sandbox runtime for the preview iframe. JSX-only contract.
 *
 * The agent's artifact is always a bare module of the form
 *
 *     const TWEAK_DEFAULTS = /\* EDITMODE-BEGIN *\/{...}/\* EDITMODE-END *\/;
 *     function App() { return <...>; }
 *     ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
 *
 * `buildSrcdoc` wraps it in a vendored React 18 + ReactDOM + @babel/standalone
 * skeleton (plus our window-scoped component library — IOSDevice,
 * DesignCanvas, …) so the model never has to think about the runtime
 * plumbing. Anything passed in — including a full `<!doctype html>` payload —
 * is embedded verbatim inside a `<script type="text/babel">`; if it isn't
 * valid JSX, Babel will surface a syntax error via the iframe error overlay.
 */

import { ensureEditmodeMarkers } from '@open-codesign/shared';

import BABEL_STANDALONE from '../vendor/babel.standalone.js?raw';
import DESIGN_CANVAS_JSX from '../vendor/design-canvas.jsx?raw';
import IOS_FRAME_JSX from '../vendor/ios-frame.jsx?raw';
import REACT_DOM_UMD from '../vendor/react-dom.umd.js?raw';
import REACT_UMD from '../vendor/react.umd.js?raw';

import { OVERLAY_SCRIPT } from './overlay';
import { TWEAKS_BRIDGE_LISTENER, TWEAKS_BRIDGE_SETUP } from './tweaks-bridge';

export {
  EDIT_CURSOR_KEY,
  isElementRectsMessage,
  isOverlayMessage,
  OVERLAY_SCRIPT,
} from './overlay';
export type { ElementRectsMessage, OverlayMessage } from './overlay';
export { isIframeErrorMessage } from './iframe-errors';
export type { IframeErrorMessage } from './iframe-errors';
// gameplan §7.1 — engine adapter registry. Phase A: three + phaser.
export {
  GAME_ENGINE_ADAPTERS,
  getEngineAdapter,
  listLivePreviewEngines,
} from './engines';
export type {
  GameEngineAdapter,
  GameEngineId,
  ValidationIssue,
  ValidationResult,
} from './engines';

const JSX_TEMPLATE_BEGIN = '<!-- AGENT_BODY_BEGIN -->';
const JSX_TEMPLATE_END = '<!-- AGENT_BODY_END -->';
const OVERLAY_MARKER = '<!-- CODESIGN_OVERLAY_SCRIPT -->';

/**
 * Patches React.createElement so DOM components (string-typed `type`) created
 * by JSX compiled with `@babel/plugin-transform-react-jsx-source` carry a
 * `data-src-line="N"` attribute. The plugin tags the createElement props with
 * `__source.lineNumber`; React strips it before mounting, so we copy it onto
 * the rendered DOM element here. Used by the follow-the-edit overlay to
 * resolve `[startLine, endLine]` (from the agent's str_replace metadata) back
 * to a DOM element so the cursor can be positioned.
 *
 * Runs once, defensively guarded — does nothing if React isn't available, and
 * never overwrites a caller-supplied `data-src-line` prop. Only DOM components
 * are tagged (React components manage their own children's attrs).
 */
const SRC_LINE_TAGGER_SCRIPT = `
(function(){
  if (!window.React || typeof window.React.createElement !== 'function') return;
  if (window.React.__codesignSrcLineWrapped) return;
  var orig = window.React.createElement;
  window.React.createElement = function(type, props) {
    var args = Array.prototype.slice.call(arguments);
    if (
      typeof type === 'string' &&
      props && props.__source &&
      typeof props.__source.lineNumber === 'number' &&
      !('data-src-line' in props)
    ) {
      var next = Object.assign({}, props);
      next['data-src-line'] = String(props.__source.lineNumber);
      args[1] = next;
    }
    return orig.apply(this, args);
  };
  window.React.__codesignSrcLineWrapped = true;
})();
`;

function escapeForScriptLiteral(jsx: string): string {
  // JSON.stringify handles quotes/newlines; the </script> escape prevents the
  // outer <script> from being closed early if the agent's source happens to
  // contain that literal string.
  return JSON.stringify(jsx).replace(/<\/script>/g, '<\\/script>');
}

function wrapJsxAsSrcdoc(jsx: string): string {
  // Auto-recover bare `const TWEAK_DEFAULTS = {...}` (no markers) into the
  // canonical EDITMODE form before embedding, so the in-iframe bridge regex
  // always matches and live tweaks work even on agent output that forgot the
  // markers. Side-benefit: TweakPanel's parser sees the same canonical form.
  const normalized = ensureEditmodeMarkers(jsx);
  // The boundary markers let us round-trip extract the agent's payload from
  // a fully-built srcdoc later (used by EDITMODE replace flows).
  const agentScriptLiteral = escapeForScriptLiteral(normalized);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;1,9..144,300;1,9..144,400&family=DM+Serif+Display:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}html,body,#root{height:100%;}body{font-family:'DM Sans',system-ui,sans-serif;background:var(--color-artifact-bg, #ffffff);}</style>
</head>
<body>
<div id="root"></div>
<script>${REACT_UMD}</script>
<script>${REACT_DOM_UMD}</script>
<script>${SRC_LINE_TAGGER_SCRIPT}</script>
<script>${BABEL_STANDALONE}</script>
<script>${TWEAKS_BRIDGE_SETUP}</script>
<script type="text/babel" data-presets="react">${IOS_FRAME_JSX}</script>
<script type="text/babel" data-presets="react">${DESIGN_CANVAS_JSX}</script>
${JSX_TEMPLATE_BEGIN}
<script type="text/babel" data-presets="react" data-plugins="transform-react-jsx-source">
${jsx}
</script>
${JSX_TEMPLATE_END}
<script>if(window.__codesign_tweaks__){window.__codesign_tweaks__.originalScript=${agentScriptLiteral};}</script>
<script>${TWEAKS_BRIDGE_LISTENER}</script>
<script>${OVERLAY_SCRIPT}</script>
</body>
</html>`;
}

function overlayScriptTag(): string {
  return `${OVERLAY_MARKER}<script>${OVERLAY_SCRIPT}</script>`;
}

function injectOverlayIntoHtmlDocument(html: string): string {
  // Defensive Babel-standalone backfill. Agent artifacts that emit a full
  // HTML document with `<script type="text/babel">` (typical when the
  // design pulls in Three.js or another global lib via <script src>) often
  // forget to also include `@babel/standalone` — the result is a page
  // where the React app silently never mounts and only the non-JSX
  // scripts (Three.js scene, etc.) run. From the user's perspective this
  // looks like "the agent did nothing" because all the structural sections
  // never render. Auto-inject Babel + React UMD if we detect a JSX-typed
  // script tag and the document doesn't already provide them. Idempotent
  // and only fires when both signals (text/babel script + missing
  // dependencies) are present.
  let upgraded = html;
  const hasBabelScript = /<script[^>]+type=["']text\/babel["']/i.test(upgraded);
  if (hasBabelScript) {
    const hasBabelLib = /babel[-.]standalone|@babel\/standalone/i.test(upgraded);
    const hasReactLib =
      /\b(?:react@\d|react\.(?:production|development|umd))/i.test(upgraded) ||
      /\bReact\.\w+\s*=/.test(upgraded);
    if (!hasBabelLib || !hasReactLib) {
      const reactRuntime = `<!-- CODESIGN_AUTO_BACKFILL: agent forgot React+Babel for type=text/babel scripts -->
<script>${REACT_UMD}</script>
<script>${REACT_DOM_UMD}</script>
<script>${BABEL_STANDALONE}</script>`;
      // Place BEFORE the first text/babel script so the transformer is
      // available by the time the JSX runs. If we can't find the script
      // (regex edge case), fall back to injecting after </head>.
      const babelScriptMatch = upgraded.match(/<script[^>]+type=["']text\/babel["'][^>]*>/i);
      if (babelScriptMatch && babelScriptMatch.index !== undefined) {
        const splitIndex = babelScriptMatch.index;
        upgraded = `${upgraded.slice(0, splitIndex)}${reactRuntime}\n${upgraded.slice(splitIndex)}`;
      } else if (/<\/head\s*>/i.test(upgraded)) {
        upgraded = upgraded.replace(/<\/head\s*>/i, `${reactRuntime}</head>`);
      } else {
        upgraded = `${reactRuntime}${upgraded}`;
      }
    }
  }
  if (upgraded.includes(OVERLAY_MARKER) || upgraded.includes("type: 'ELEMENT_SELECTED'")) {
    return upgraded;
  }
  const script = overlayScriptTag();
  if (/<\/body\s*>/i.test(upgraded)) {
    return upgraded.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  if (/<\/html\s*>/i.test(upgraded)) {
    return upgraded.replace(/<\/html\s*>/i, `${script}</html>`);
  }
  return `${upgraded}${script}`;
}

/**
 * Wrap an agent artifact in the vendored React + Babel skeleton, ready for
 * use as an iframe `srcdoc`. Already-wrapped payloads pass through unchanged.
 */
export function extractAndUpgradeArtifact(source: string): string {
  if (source.includes(JSX_TEMPLATE_BEGIN)) return source;
  return wrapJsxAsSrcdoc(source);
}

/**
 * Build a complete srcdoc HTML string for the preview iframe. Strips any
 * stray CSP meta tags from the agent payload, then wraps it as JSX.
 *
 * Legacy-HTML compatibility: snapshots created before the JSX-only switchover
 * stored raw HTML documents (starting with `<!doctype` or `<html>`). Feeding
 * these through `wrapJsxAsSrcdoc` produces "Unexpected token" errors because
 * Babel tries to parse the HTML as JSX. Detect and pass them through verbatim.
 */
export function buildSrcdoc(userSource: string): string {
  const stripped = userSource.replace(
    /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
    '',
  );
  // Already-wrapped srcdoc (round-trip safe) — return as-is.
  if (stripped.includes(JSX_TEMPLATE_BEGIN)) return stripped;
  // Legacy HTML document (pre-JSX-only-switchover snapshots) — render as-is.
  const head = stripped.trimStart().slice(0, 2048).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    return injectOverlayIntoHtmlDocument(stripped);
  }
  return wrapJsxAsSrcdoc(stripped);
}
