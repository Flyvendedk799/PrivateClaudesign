/**
 * Backlog-3 §1 — in-iframe HMR runtime.
 *
 * Listens for `{ __codesign_hmr: true, kind: 'css' | 'js', protocolVersion: 1, ... }`
 * postMessage envelopes from the parent window. Applies CSS or single
 * `<script>` patches in place so str_replace edits don't reset canvas
 * rAF loops, video playback, scroll position, or form state.
 *
 * Falls back to full reload (renderer side) when:
 *  - Multiple `<script>` blocks change.
 *  - The patcher reports `ok: false` via the ack envelope.
 *  - 500ms passes without an ack.
 *
 * Protocol contract (versioned, parent and child must agree):
 *  - parent → iframe: `{ __codesign_hmr: true, protocolVersion: 1, kind, oldStyles?,
 *      newStyles?, oldScripts?, newScripts? }`
 *  - iframe → parent: `{ __codesign_hmr_ack: true, ok: boolean, kind, error? }`
 *
 * The script is INJECTED via `injectOverlayIntoHtmlDocument` (./index.ts)
 * — see the marker `__CODESIGN_HMR_PATCHER_MARKER` so the injector is
 * idempotent across re-injections.
 */

export const HMR_PATCHER_MARKER = '__CODESIGN_HMR_PATCHER_MARKER';
export const HMR_PROTOCOL_VERSION = 1;

export interface HmrCssPatchEnvelope {
  __codesign_hmr: true;
  protocolVersion: 1;
  kind: 'css';
  oldStyles: string[];
  newStyles: string[];
}

export interface HmrJsPatchEnvelope {
  __codesign_hmr: true;
  protocolVersion: 1;
  kind: 'js';
  oldScripts: string[];
  newScripts: string[];
}

export type HmrPatchEnvelope = HmrCssPatchEnvelope | HmrJsPatchEnvelope;

export interface HmrAckEnvelope {
  __codesign_hmr_ack: true;
  protocolVersion: 1;
  ok: boolean;
  kind: 'css' | 'js';
  error?: string;
}

/**
 * The patcher script body — the inline JS that runs INSIDE the iframe.
 * Returned as a string so the runtime can inline it into srcdoc. Kept
 * as a single function with no external deps so it works in any
 * sandboxed iframe (sandbox="allow-scripts" with no allow-same-origin).
 */
export function hmrPatcherScript(): string {
  // Note: the body is hand-rolled because the iframe sandbox can't
  // import modules (origin = null). Care taken to avoid features that
  // require a parser plugin (e.g. optional chaining is fine in modern
  // sandbox UA strings; we shipped Electron 39+).
  return `
(function() {
  if (window.${HMR_PATCHER_MARKER}) return;
  window.${HMR_PATCHER_MARKER} = true;
  var PROTOCOL = ${HMR_PROTOCOL_VERSION};
  function ack(ok, kind, error) {
    try {
      window.parent.postMessage({
        __codesign_hmr_ack: true,
        protocolVersion: PROTOCOL,
        ok: ok,
        kind: kind,
        error: error
      }, '*');
    } catch (e) { /* parent may have closed */ }
  }
  function applyCss(envelope) {
    var styles = document.querySelectorAll('style');
    if (!Array.isArray(envelope.oldStyles) || !Array.isArray(envelope.newStyles)) {
      return ack(false, 'css', 'malformed envelope');
    }
    if (styles.length !== envelope.newStyles.length) {
      return ack(false, 'css', 'style count mismatch (' + styles.length + ' vs ' + envelope.newStyles.length + ')');
    }
    var changed = 0;
    for (var i = 0; i < styles.length; i++) {
      if (envelope.oldStyles[i] !== envelope.newStyles[i]) {
        styles[i].textContent = envelope.newStyles[i];
        changed += 1;
      }
    }
    ack(true, 'css', changed === 0 ? 'no-op' : changed + ' style block(s) updated');
  }
  function applyJs(envelope) {
    if (!Array.isArray(envelope.oldScripts) || !Array.isArray(envelope.newScripts)) {
      return ack(false, 'js', 'malformed envelope');
    }
    var scripts = document.querySelectorAll('script');
    var jsScripts = [];
    for (var i = 0; i < scripts.length; i++) {
      // Skip our own patcher script and overlay scripts.
      var src = scripts[i].textContent || '';
      if (src.indexOf('${HMR_PATCHER_MARKER}') !== -1) continue;
      if (scripts[i].dataset && scripts[i].dataset.codesignOverlay === 'true') continue;
      jsScripts.push(scripts[i]);
    }
    if (jsScripts.length !== envelope.newScripts.length) {
      return ack(false, 'js', 'script count mismatch (' + jsScripts.length + ' vs ' + envelope.newScripts.length + ')');
    }
    var changedIdx = -1;
    var changedCount = 0;
    for (var j = 0; j < jsScripts.length; j++) {
      if (envelope.oldScripts[j] !== envelope.newScripts[j]) {
        changedIdx = j;
        changedCount += 1;
      }
    }
    if (changedCount === 0) return ack(true, 'js', 'no-op');
    if (changedCount > 1) return ack(false, 'js', 'multiple scripts changed; structural reload required');
    // Replace the single changed script in place. Re-evaluation is
    // browser-driven: a fresh <script> element appended to the parent
    // re-runs by appending to the DOM.
    var oldScript = jsScripts[changedIdx];
    var newScript = document.createElement('script');
    var attrs = oldScript.attributes;
    for (var k = 0; k < attrs.length; k++) newScript.setAttribute(attrs[k].name, attrs[k].value);
    newScript.textContent = envelope.newScripts[changedIdx];
    var parentNode = oldScript.parentNode;
    if (parentNode === null) return ack(false, 'js', 'orphaned script element');
    parentNode.replaceChild(newScript, oldScript);
    ack(true, 'js', 'script ' + changedIdx + ' re-evaluated');
  }
  window.addEventListener('message', function(event) {
    var data = event && event.data;
    if (!data || data.__codesign_hmr !== true) return;
    if (data.protocolVersion !== PROTOCOL) {
      return ack(false, data.kind || 'unknown', 'protocol version mismatch (' + data.protocolVersion + ' vs ' + PROTOCOL + ')');
    }
    try {
      if (data.kind === 'css') applyCss(data);
      else if (data.kind === 'js') applyJs(data);
      else ack(false, data.kind || 'unknown', 'unknown kind');
    } catch (e) {
      ack(false, data.kind || 'unknown', (e && e.message) || String(e));
    }
  });
})();
`.trim();
}

/** A `<script>` tag wrapping the patcher body, marked so injectors
 *  can detect already-injected documents. */
export function hmrPatcherScriptTag(): string {
  return `<script>${hmrPatcherScript()}</script>`;
}
