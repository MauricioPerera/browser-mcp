/**
 * browser-mcp/plugins/debug — Pre-built debug tools for any web app
 *
 * Add to your page:
 *   <script src="browser-mcp.js"></script>
 *   <script src="plugins/debug.js"></script>
 *   <script>
 *     const mcp = new BrowserMCP({ name: "My App" });
 *     BrowserMCPDebug.register(mcp);  // adds 12 debug tools
 *     mcp.start();
 *   </script>
 *
 * All tools are public by default (no auth needed for debugging).
 * Pass { requireAuth: true } to register() to require auth.
 *
 * @license MIT
 * @version 0.1.0
 */

(function (global) {
  'use strict';

  // ─── Error Capture ─────────────────────────────────────────────────────────

  const capturedErrors = [];
  const capturedLogs = [];
  const networkLog = [];
  const MAX_LOG = 200;

  // Capture JS errors
  window.addEventListener('error', (e) => {
    capturedErrors.push({
      message: e.message,
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
      time: new Date().toISOString(),
    });
    if (capturedErrors.length > MAX_LOG) capturedErrors.shift();
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (e) => {
    capturedErrors.push({
      message: String(e.reason?.message || e.reason),
      type: 'unhandledrejection',
      time: new Date().toISOString(),
    });
    if (capturedErrors.length > MAX_LOG) capturedErrors.shift();
  });

  // Capture console.error / console.warn
  const origError = console.error;
  const origWarn = console.warn;
  console.error = function (...args) {
    capturedLogs.push({ level: 'error', args: args.map(String), time: new Date().toISOString() });
    if (capturedLogs.length > MAX_LOG) capturedLogs.shift();
    origError.apply(console, args);
  };
  console.warn = function (...args) {
    capturedLogs.push({ level: 'warn', args: args.map(String), time: new Date().toISOString() });
    if (capturedLogs.length > MAX_LOG) capturedLogs.shift();
    origWarn.apply(console, args);
  };

  // Capture fetch requests
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '?';
    const method = args[1]?.method || 'GET';
    const start = performance.now();
    const entry = { url, method, start: new Date().toISOString(), status: null, duration: null, error: null };
    try {
      const res = await origFetch.apply(window, args);
      entry.status = res.status;
      entry.duration = +(performance.now() - start).toFixed(1);
      networkLog.push(entry);
      if (networkLog.length > MAX_LOG) networkLog.shift();
      return res;
    } catch (e) {
      entry.error = e.message;
      entry.duration = +(performance.now() - start).toFixed(1);
      networkLog.push(entry);
      if (networkLog.length > MAX_LOG) networkLog.shift();
      throw e;
    }
  };

  // ─── Plugin ────────────────────────────────────────────────────────────────

  const BrowserMCPDebug = {
    /**
     * Register all debug tools on a BrowserMCP instance.
     * @param {BrowserMCP} mcp
     * @param {object} [opts]
     * @param {boolean} [opts.requireAuth=false] — require auth for debug tools
     */
    register(mcp, opts = {}) {
      const toolOpts = opts.requireAuth ? {} : { public: true };

      // ── 1. Health Check ──────────────────────────────────────────

      mcp.tool('debug_health', 'Quick health check: uptime, memory, errors, page info', {},
        () => JSON.stringify({
          url: location.href,
          title: document.title,
          uptime_ms: Math.round(performance.now()),
          memory_mb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          dom_nodes: document.querySelectorAll('*').length,
          error_count: capturedErrors.length,
          warn_count: capturedLogs.filter(l => l.level === 'warn').length,
          pending_fetches: networkLog.filter(n => n.status === null && !n.error).length,
        }, null, 2),
        toolOpts
      );

      // ── 2. JS Errors ─────────────────────────────────────────────

      mcp.tool('debug_errors', 'Get captured JavaScript errors (window.onerror + unhandled rejections)', { limit: 'number' },
        ({ limit }) => {
          const n = Math.min(limit || 20, capturedErrors.length);
          return JSON.stringify(capturedErrors.slice(-n), null, 2);
        },
        toolOpts
      );

      // ── 3. Console Logs ──────────────────────────────────────────

      mcp.tool('debug_console', 'Get captured console.error and console.warn messages', { level: 'string', limit: 'number' },
        ({ level, limit }) => {
          let logs = capturedLogs;
          if (level === 'error') logs = logs.filter(l => l.level === 'error');
          if (level === 'warn') logs = logs.filter(l => l.level === 'warn');
          const n = Math.min(limit || 20, logs.length);
          return JSON.stringify(logs.slice(-n), null, 2);
        },
        toolOpts
      );

      // ── 4. Network Log ───────────────────────────────────────────

      mcp.tool('debug_network', 'Get recent fetch requests with status, duration, errors', { limit: 'number', failed_only: 'boolean' },
        ({ limit, failed_only }) => {
          let log = networkLog;
          if (failed_only) log = log.filter(n => n.error || (n.status && n.status >= 400));
          const n = Math.min(limit || 20, log.length);
          return JSON.stringify(log.slice(-n), null, 2);
        },
        toolOpts
      );

      // ── 5. DOM Inspector ─────────────────────────────────────────

      mcp.tool('debug_dom', 'Inspect a DOM element by CSS selector', { selector: 'string' },
        ({ selector }) => {
          const el = document.querySelector(selector);
          if (!el) return `Element not found: ${selector}`;
          return JSON.stringify({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: Array.from(el.classList),
            text: el.textContent?.slice(0, 200),
            html: el.outerHTML?.slice(0, 500),
            rect: el.getBoundingClientRect(),
            visible: el.offsetParent !== null,
            children: el.children.length,
            attributes: Array.from(el.attributes).map(a => ({ name: a.name, value: a.value.slice(0, 100) })),
          }, null, 2);
        },
        toolOpts
      );

      // ── 6. Query DOM ─────────────────────────────────────────────

      mcp.tool('debug_query', 'Count or list elements matching a CSS selector', { selector: 'string', limit: 'number' },
        ({ selector, limit }) => {
          const els = document.querySelectorAll(selector);
          const n = Math.min(limit || 10, els.length);
          return JSON.stringify({
            count: els.length,
            elements: Array.from(els).slice(0, n).map(el => ({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              text: el.textContent?.slice(0, 100),
            })),
          }, null, 2);
        },
        toolOpts
      );

      // ── 7. Performance ───────────────────────────────────────────

      mcp.tool('debug_performance', 'Get page performance metrics (load time, LCP, CLS, memory)', {},
        () => {
          const nav = performance.getEntriesByType('navigation')[0];
          const paint = performance.getEntriesByType('paint');
          const lcp = performance.getEntriesByType('largest-contentful-paint');
          return JSON.stringify({
            dom_complete: nav ? Math.round(nav.domComplete) : null,
            load_time: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
            first_paint: paint.find(p => p.name === 'first-paint')?.startTime?.toFixed(1),
            first_contentful_paint: paint.find(p => p.name === 'first-contentful-paint')?.startTime?.toFixed(1),
            largest_contentful_paint: lcp.length ? lcp[lcp.length - 1].startTime?.toFixed(1) : null,
            memory_mb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
            heap_limit_mb: performance.memory ? +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0) : null,
            resources: performance.getEntriesByType('resource').length,
          }, null, 2);
        },
        toolOpts
      );

      // ── 8. Local/Session Storage ─────────────────────────────────

      mcp.tool('debug_storage', 'Inspect localStorage and sessionStorage', { type: 'string' },
        ({ type }) => {
          const storage = type === 'session' ? sessionStorage : localStorage;
          const entries = {};
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            const val = storage.getItem(key);
            entries[key] = val?.length > 200 ? val.slice(0, 200) + '...' : val;
          }
          return JSON.stringify({
            type: type || 'local',
            count: storage.length,
            total_bytes: JSON.stringify(entries).length,
            entries,
          }, null, 2);
        },
        toolOpts
      );

      // ── 9. Cookies ───────────────────────────────────────────────

      mcp.tool('debug_cookies', 'List all cookies for this domain', {},
        () => {
          const cookies = document.cookie.split(';').map(c => {
            const [name, ...rest] = c.trim().split('=');
            return { name, value: rest.join('=').slice(0, 100) };
          }).filter(c => c.name);
          return JSON.stringify({ count: cookies.length, cookies }, null, 2);
        },
        toolOpts
      );

      // ── 10. Execute JS ───────────────────────────────────────────

      mcp.tool('debug_eval', 'Execute JavaScript in page context (use carefully)', { code: 'string' },
        ({ code }) => {
          try {
            const result = Function('"use strict"; return (' + code + ')')();
            return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
          } catch (e) {
            return `Error: ${e.message}`;
          }
        },
        opts.requireAuth ? { roles: ['admin'] } : toolOpts
      );

      // ── 11. Screenshot (data URL) ────────────────────────────────

      mcp.tool('debug_viewport', 'Get viewport and scroll info', {},
        () => JSON.stringify({
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scroll: { x: window.scrollX, y: window.scrollY },
          document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
          devicePixelRatio: window.devicePixelRatio,
          userAgent: navigator.userAgent,
        }, null, 2),
        toolOpts
      );

      // ── 12. Clear Captures ───────────────────────────────────────

      mcp.tool('debug_clear', 'Clear all captured errors, logs, and network entries', {},
        () => {
          capturedErrors.length = 0;
          capturedLogs.length = 0;
          networkLog.length = 0;
          return 'Cleared all debug captures';
        },
        toolOpts
      );

      // ── Resource: full debug snapshot ────────────────────────────

      mcp.resource('debug://snapshot', 'Full debug snapshot (errors + logs + network + performance)', 'application/json',
        () => JSON.stringify({
          timestamp: new Date().toISOString(),
          url: location.href,
          errors: capturedErrors.slice(-10),
          console: capturedLogs.slice(-10),
          network: networkLog.slice(-10),
          memory_mb: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          dom_nodes: document.querySelectorAll('*').length,
        }, null, 2)
      );
    },
  };

  if (typeof globalThis !== 'undefined') globalThis.BrowserMCPDebug = BrowserMCPDebug;
  if (typeof module !== 'undefined' && module.exports) module.exports = { BrowserMCPDebug };
  if (typeof window !== 'undefined') window.BrowserMCPDebug = BrowserMCPDebug;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
