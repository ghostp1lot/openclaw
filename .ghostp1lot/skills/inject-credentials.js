/**
 * inject-credentials
 * OpenClaw skill: fill login form fields in a running Chromium instance via CDP.
 *
 * Ported directly from autofill.mjs in ghostp1lot/controller (archived).
 * The credential schema and wildcard URL matching logic are identical.
 *
 * All DOM manipulation is done via small Runtime.evaluate calls — the same
 * pattern used in the archived controller. No large browser-side scripts
 * are injected; all logic stays Node-side.
 *
 * Input:
 *   port        {number}  — CDP port of the target Chromium instance (9222–9226)
 *   credentials {object}  — credential map returned by fetch-credentials skill
 *
 * Output:
 *   { filled, total, matched, matchedPattern, autoSubmitted, currentUrl }
 */

import CDP from 'chrome-remote-interface';

/**
 * Wildcard URL matcher.
 * Supports * as "match any characters" (same as autofill.mjs).
 */
function patternMatchesUrl(pattern, url) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const regex = new RegExp('^' + escaped + '$', 'i');
  return regex.test(url);
}

export default {
  name: 'inject-credentials',
  description:
    'Fill login form fields in a Chromium instance via CDP, using URL-pattern matched credentials.',

  async execute({ port, credentials }) {
    if (!port || !credentials || Object.keys(credentials).length === 0) {
      console.log('[inject-credentials] No port or credentials provided — skipping.');
      return { filled: 0, total: 0, skipped: true };
    }

    const patterns = Object.keys(credentials);
    console.log(`[inject-credentials] Port ${port}, ${patterns.length} pattern(s)`);

    let client;
    try {
      client = await CDP({ port });
      const { Runtime } = client;

      // ── Get current page URL ────────────────────────────────
      const urlEval = await Runtime.evaluate({
        expression: 'window.location.href',
        returnByValue: true,
      });

      if (urlEval.exceptionDetails) {
        throw new Error(
          `[inject-credentials] Cannot read window.location.href: ` +
          JSON.stringify(urlEval.exceptionDetails)
        );
      }

      const currentUrl = urlEval.result.value;
      console.log(`[inject-credentials] Current URL: ${currentUrl}`);

      // ── Match URL against credential patterns (Node-side) ───
      let matchedPattern    = null;
      let matchedCredential = null;

      for (const pattern of patterns) {
        if (patternMatchesUrl(pattern, currentUrl)) {
          matchedPattern    = pattern;
          matchedCredential = credentials[pattern];
          break;
        }
      }

      if (!matchedPattern) {
        console.log('[inject-credentials] No credential pattern matches current URL — skipping.');
        return { filled: 0, total: 0, matched: false, currentUrl };
      }

      console.log(`[inject-credentials] Matched pattern: "${matchedPattern}"`);

      const fields   = matchedCredential.fields   || [];
      const triggers = matchedCredential.triggers || {};
      let filledCount = 0;

      // ── Fill fields ─────────────────────────────────────────
      for (const field of fields) {
        const { type = 'text', value, selectors = [] } = field;
        let filled = false;

        for (const selector of selectors) {
          const expr = `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { found: false };
            if (typeof el.focus === 'function') el.focus();
            el.value = ${JSON.stringify(value)};
            ['input', 'change', 'blur'].forEach(ev => {
              try { el.dispatchEvent(new Event(ev, { bubbles: true, cancelable: true })); }
              catch (e) {}
            });
            return {
              found:     true,
              tag:       el.tagName,
              inputType: el.type || null,
              visible:   el.offsetParent !== null,
            };
          })()`;

          const res = await Runtime.evaluate({ expression: expr, returnByValue: true });

          if (!res.exceptionDetails && res.result?.value?.found) {
            console.log(`[inject-credentials] Filled ${type} via selector: ${selector}`);
            filledCount++;
            filled = true;
            break;
          }
        }

        if (!filled) {
          console.warn(`[inject-credentials] Could not fill ${type} field — no selector matched.`);
        }
      }

      console.log(`[inject-credentials] Filled ${filledCount}/${fields.length} field(s).`);

      // ── Auto-submit ─────────────────────────────────────────
      let autoSubmitted = false;

      if (triggers.autoSubmit && filledCount > 0 && triggers.submitSelectors?.length > 0) {
        const waitMs = triggers.waitBeforeSubmit || 1000;
        console.log(`[inject-credentials] Auto-submit in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));

        for (const selector of triggers.submitSelectors) {
          const submitExpr = `(() => {
            const btn = document.querySelector(${JSON.stringify(selector)});
            if (!btn)          return { found: false, clicked: false };
            if (btn.disabled)  return { found: true,  clicked: false, disabled: true };
            try { btn.click(); return { found: true, clicked: true }; }
            catch (e) { return { found: true, clicked: false, error: e.message }; }
          })()`;

          const submitRes = await Runtime.evaluate({ expression: submitExpr, returnByValue: true });

          if (!submitRes.exceptionDetails && submitRes.result?.value?.clicked) {
            console.log(`[inject-credentials] Submit clicked: ${selector}`);
            autoSubmitted = true;
            break;
          }
        }

        if (!autoSubmitted) {
          console.warn('[inject-credentials] Auto-submit enabled but no submit selector responded.');
        }
      }

      return {
        filled:         filledCount,
        total:          fields.length,
        matched:        true,
        matchedPattern,
        autoSubmitted,
        currentUrl,
      };

    } finally {
      // We intentionally leave the CDP client open.
      // OpenClaw/controller may reuse the CDP connection for subsequent operations.
      // To close explicitly: uncomment the line below.
      // if (client) await client.close();
    }
  },
};
