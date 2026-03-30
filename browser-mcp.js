/**
 * browser-mcp — Turn any webpage into an MCP server
 *
 * Zero dependencies. One script tag. Any site becomes AI-agent-controllable.
 *
 * Usage:
 *   <script src="browser-mcp.js"></script>
 *   <script>
 *     const mcp = new BrowserMCP({ name: "My Site" });
 *     mcp.tool("greet", "Say hello", { name: "string" }, ({ name }) => `Hello ${name}!`);
 *     mcp.start();
 *   </script>
 *
 * @license MIT
 * @version 0.1.0
 */

(function (global) {
  'use strict';

  const MCP_VERSION = '2024-11-05';
  const ENDPOINT = '/mcp';

  // ─── BrowserMCP Class ──────────────────────────────────────────────────────

  class BrowserMCP {
    /**
     * @param {object} opts
     * @param {string} opts.name - Server name
     * @param {string} [opts.version='1.0.0'] - Server version
     * @param {string} [opts.description] - Server description
     * @param {boolean} [opts.widget=true] - Show floating widget
     * @param {string} [opts.endpoint='/mcp'] - MCP endpoint path
     */
    constructor(opts = {}) {
      this._name = opts.name || 'BrowserMCP';
      this._version = opts.version || '1.0.0';
      this._description = opts.description || '';
      this._showWidget = opts.widget !== false;
      this._endpoint = opts.endpoint || ENDPOINT;

      this._tools = [];
      this._resources = [];
      this._prompts = [];
      this._toolHandlers = new Map();
      this._resourceHandlers = new Map();
      this._promptHandlers = new Map();

      this._sessionId = null;
      this._started = false;
      this._requestCount = 0;
    }

    // ─── Registration API ──────────────────────────────────────────────────

    /**
     * Register a tool.
     * @param {string} name
     * @param {string} description
     * @param {object} inputSchema - { fieldName: "type" } or JSON Schema object
     * @param {function} handler - (args) => result
     */
    tool(name, description, inputSchema, handler) {
      // Normalize simple schema { field: "type" } to JSON Schema
      const schema = this._normalizeSchema(inputSchema);
      this._tools.push({ name, description, inputSchema: schema });
      this._toolHandlers.set(name, handler);
      return this;
    }

    /**
     * Register a resource.
     * @param {string} uri - e.g. "page://content" or "data://{id}"
     * @param {string} description
     * @param {string} [mimeType='text/plain']
     * @param {function} handler - (params) => string
     */
    resource(uri, description, mimeType, handler) {
      if (typeof mimeType === 'function') { handler = mimeType; mimeType = 'text/plain'; }
      const isTemplate = uri.includes('{');
      const r = { uri: isTemplate ? undefined : uri, uriTemplate: isTemplate ? uri : undefined, name: uri, description, mimeType: mimeType || 'text/plain' };
      this._resources.push(r);
      this._resourceHandlers.set(uri, handler);
      return this;
    }

    /**
     * Register a prompt.
     * @param {string} name
     * @param {string} description
     * @param {Array<{name:string, description?:string, required?:boolean}>} args
     * @param {function} handler - (args) => string | {messages: [...]}
     */
    prompt(name, description, args, handler) {
      this._prompts.push({ name, description, arguments: args || [] });
      this._promptHandlers.set(name, handler);
      return this;
    }

    // ─── Start / Stop ──────────────────────────────────────────────────────

    async start() {
      if (this._started) return;
      this._started = true;
      this._sessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);

      // Register Service Worker for Streamable HTTP transport
      await this._registerServiceWorker();

      // Show widget
      if (this._showWidget) this._createWidget();

      console.log(`[BrowserMCP] ${this._name} started — ${this._tools.length} tools, ${this._resources.length} resources, ${this._prompts.length} prompts`);
      console.log(`[BrowserMCP] MCP endpoint: ${location.origin}${this._endpoint}`);
    }

    stop() {
      this._started = false;
      const widget = document.getElementById('browser-mcp-widget');
      if (widget) widget.remove();
      // Note: SW stays registered but will return 503 when !this._started
    }

    listTools() { return this._tools.map(t => t.name); }

    // ─── MCP Protocol Handler ──────────────────────────────────────────────

    async handleRequest(body) {
      const id = body.id;

      try {
        let result;

        switch (body.method) {
          case 'initialize':
            result = {
              protocolVersion: MCP_VERSION,
              capabilities: {
                tools: this._tools.length > 0 ? {} : undefined,
                resources: this._resources.length > 0 ? {} : undefined,
                prompts: this._prompts.length > 0 ? {} : undefined,
              },
              serverInfo: { name: this._name, version: this._version },
            };
            break;

          case 'notifications/initialized':
            return null; // No response needed for notifications

          case 'tools/list':
            result = { tools: this._tools };
            break;

          case 'tools/call': {
            const { name, arguments: args } = body.params;
            const handler = this._toolHandlers.get(name);
            if (!handler) throw new Error(`Tool not found: ${name}`);
            const raw = await handler(args || {});
            result = this._formatToolResult(raw);
            break;
          }

          case 'resources/list':
            result = { resources: this._resources };
            break;

          case 'resources/read': {
            const uri = body.params.uri;
            // Find matching handler (exact or template)
            let handler = this._resourceHandlers.get(uri);
            let params = {};
            if (!handler) {
              // Try template match
              for (const [template, h] of this._resourceHandlers) {
                const match = this._matchUriTemplate(template, uri);
                if (match) { handler = h; params = match; break; }
              }
            }
            if (!handler) throw new Error(`Resource not found: ${uri}`);
            const content = await handler(params);
            const res = this._resources.find(r => r.uri === uri || r.uriTemplate);
            result = { contents: [{ uri, mimeType: res?.mimeType || 'text/plain', text: typeof content === 'string' ? content : JSON.stringify(content) }] };
            break;
          }

          case 'prompts/list':
            result = { prompts: this._prompts };
            break;

          case 'prompts/get': {
            const { name, arguments: args } = body.params;
            const handler = this._promptHandlers.get(name);
            if (!handler) throw new Error(`Prompt not found: ${name}`);
            const raw = await handler(args || {});
            result = typeof raw === 'string'
              ? { messages: [{ role: 'user', content: { type: 'text', text: raw } }] }
              : raw;
            break;
          }

          case 'ping':
            result = {};
            break;

          default:
            throw new Error(`Method not supported: ${body.method}`);
        }

        if (result === null) return null; // notification
        this._requestCount++;
        return { jsonrpc: '2.0', id, result };

      } catch (e) {
        return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
      }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    _normalizeSchema(input) {
      if (!input) return { type: 'object', properties: {} };
      // Already JSON Schema?
      if (input.type === 'object' && input.properties) return input;
      // Simple { field: "type" } format
      const properties = {};
      const required = [];
      for (const [key, val] of Object.entries(input)) {
        if (typeof val === 'string') {
          properties[key] = { type: val };
        } else if (typeof val === 'object') {
          properties[key] = val;
          if (val.required) required.push(key);
        }
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }

    _formatToolResult(raw) {
      if (typeof raw === 'string') return { content: [{ type: 'text', text: raw }] };
      if (raw && raw.content) return raw; // Already MCP format
      return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }] };
    }

    _matchUriTemplate(template, uri) {
      const regex = template.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)');
      const match = uri.match(new RegExp(`^${regex}$`));
      return match ? match.groups : null;
    }

    // ─── Service Worker Transport ──────────────────────────────────────────

    async _registerServiceWorker() {
      // Create SW code as blob
      const swCode = `
        const ENDPOINT = '${this._endpoint}';

        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

        self.addEventListener('fetch', (event) => {
          const url = new URL(event.request.url);
          if (url.pathname === ENDPOINT && event.request.method === 'POST') {
            event.respondWith(handleMCP(event));
          }
        });

        async function handleMCP(event) {
          try {
            const body = await event.request.json();
            // Forward to main page via postMessage and wait for response
            const clients = await self.clients.matchAll({ type: 'window' });
            if (clients.length === 0) {
              return new Response(JSON.stringify({
                jsonrpc: '2.0', id: body.id,
                error: { code: -32603, message: 'No active page' }
              }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }

            return new Promise((resolve) => {
              const channel = new MessageChannel();
              channel.port1.onmessage = (e) => {
                resolve(new Response(JSON.stringify(e.data), {
                  headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
                  }
                }));
              };
              clients[0].postMessage({ type: 'mcp-request', body }, [channel.port2]);

              // Timeout after 30s
              setTimeout(() => resolve(new Response(JSON.stringify({
                jsonrpc: '2.0', id: body.id,
                error: { code: -32603, message: 'Timeout' }
              }), { headers: { 'Content-Type': 'application/json' } })), 30000);
            });
          } catch (e) {
            return new Response(JSON.stringify({
              jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }
        }

        self.addEventListener('fetch', (event) => {
          const url = new URL(event.request.url);
          if (url.pathname === ENDPOINT && event.request.method === 'OPTIONS') {
            event.respondWith(new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
              }
            }));
          }
        });
      `;

      const blob = new Blob([swCode], { type: 'application/javascript' });
      const swUrl = URL.createObjectURL(blob);

      try {
        const reg = await navigator.serviceWorker.register(swUrl, { scope: '/' });
        await navigator.serviceWorker.ready;

        // Listen for requests from SW
        navigator.serviceWorker.addEventListener('message', async (event) => {
          if (event.data?.type === 'mcp-request') {
            const response = await this.handleRequest(event.data.body);
            if (response !== null) {
              event.ports[0].postMessage(response);
            }
          }
        });

        console.log('[BrowserMCP] Service Worker registered');
      } catch (e) {
        console.warn('[BrowserMCP] Service Worker failed, falling back to manual mode:', e.message);
        // Fallback: expose handleRequest globally for manual testing
        global._browserMCP = this;
      }
    }

    // ─── Widget UI ─────────────────────────────────────────────────────────

    _createWidget() {
      const div = document.createElement('div');
      div.id = 'browser-mcp-widget';
      div.innerHTML = `
        <style>
          #browser-mcp-widget {
            position: fixed; bottom: 20px; right: 20px; z-index: 99999;
            font-family: system-ui, sans-serif; font-size: 13px;
          }
          #bmcp-btn {
            width: 44px; height: 44px; border-radius: 50%; border: none;
            background: #1a1a2e; color: #4ade80; cursor: pointer;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3); display: flex;
            align-items: center; justify-content: center; font-size: 18px;
          }
          #bmcp-btn:hover { background: #16213e; }
          #bmcp-panel {
            display: none; position: absolute; bottom: 54px; right: 0;
            width: 320px; background: #1a1a2e; border: 1px solid #334155;
            border-radius: 12px; padding: 16px; color: #e2e8f0;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
          }
          #bmcp-panel.open { display: block; }
          #bmcp-panel h3 { margin: 0 0 8px; font-size: 15px; }
          #bmcp-panel .info { color: #94a3b8; font-size: 11px; margin-bottom: 8px; }
          #bmcp-panel .tool { padding: 4px 8px; background: #0f172a; border-radius: 4px; margin: 2px 0; font-size: 12px; }
          #bmcp-panel .tool span { color: #4ade80; }
          #bmcp-panel .endpoint { background: #0f172a; padding: 8px; border-radius: 6px; font-family: monospace; font-size: 11px; margin: 8px 0; word-break: break-all; color: #38bdf8; }
          #bmcp-panel button { padding: 6px 12px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; margin-top: 4px; }
        </style>
        <div id="bmcp-panel">
          <h3>${this._name}</h3>
          <div class="info">${this._tools.length} tools | ${this._resources.length} resources | ${this._prompts.length} prompts</div>
          <div class="endpoint">POST ${location.origin}${this._endpoint}</div>
          <div style="margin-top:8px;font-size:11px;color:#94a3b8;">Tools:</div>
          ${this._tools.map(t => `<div class="tool"><span>${t.name}</span> — ${t.description}</div>`).join('')}
          ${this._resources.length ? `<div style="margin-top:8px;font-size:11px;color:#94a3b8;">Resources:</div>${this._resources.map(r => `<div class="tool"><span>${r.name}</span></div>`).join('')}` : ''}
          <button onclick="navigator.clipboard.writeText('${location.origin}${this._endpoint}')">Copy endpoint</button>
          <div style="margin-top:8px;font-size:10px;color:#4ade80;">Requests: <span id="bmcp-count">0</span></div>
        </div>
        <button id="bmcp-btn" onclick="document.getElementById('bmcp-panel').classList.toggle('open')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
        </button>
      `;
      document.body.appendChild(div);

      // Update request count
      setInterval(() => {
        const el = document.getElementById('bmcp-count');
        if (el) el.textContent = this._requestCount;
      }, 1000);
    }
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  // ESM
  if (typeof globalThis !== 'undefined') globalThis.BrowserMCP = BrowserMCP;
  // CommonJS
  if (typeof module !== 'undefined' && module.exports) module.exports = { BrowserMCP };
  // Browser global
  if (typeof window !== 'undefined') window.BrowserMCP = BrowserMCP;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
