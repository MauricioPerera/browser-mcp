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
 * @version 0.3.0
 */

(function (global) {
  'use strict';

  const MCP_VERSION = '2024-11-05';
  const SESSION_TTL = 3600000; // 1 hour
  const SESSION_CLEANUP_INTERVAL = 300000; // 5 min

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function secureId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ─── BrowserMCP ────────────────────────────────────────────────────────────

  class BrowserMCP {
    constructor(opts = {}) {
      this._name = opts.name || 'BrowserMCP';
      this._version = opts.version || '1.0.0';
      this._description = opts.description || '';
      this._showWidget = opts.widget !== false;
      this._endpoint = opts.endpoint || '/mcp';

      this._tools = [];
      this._resources = [];
      this._prompts = [];
      this._toolHandlers = new Map();
      this._resourceHandlers = new Map();
      this._promptHandlers = new Map();

      this._started = false;
      this._requestCount = 0;

      // Auth
      this._authVerifier = null;
      this._authRequired = false;
      this._sessions = new Map();
      this._cleanupTimer = null;
    }

    // ─── Auth ──────────────────────────────────────────────────────────────

    requireAuth(verifier) {
      this._authVerifier = verifier;
      this._authRequired = true;
      return this;
    }

    _registerAuthTools() {
      if (this._toolHandlers.has('auth_login')) return;

      this._tools.push({
        name: 'auth_login',
        description: 'Authenticate to access protected tools. Returns session token for _auth_token.',
        inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'API key, JWT, or auth token' } }, required: ['token'] },
      });
      this._toolHandlers.set('auth_login', async ({ token }) => {
        if (!this._authVerifier) return { error: 'Auth not configured' };
        const user = await this._authVerifier(token);
        if (!user) return { error: 'Invalid token' };
        const sid = secureId();
        this._sessions.set(sid, { user, created: Date.now() });
        return { session: sid, user: { id: user.id, role: user.role, roles: user.roles, name: user.name }, message: 'Include _auth_token in tool arguments.' };
      });

      this._tools.push({
        name: 'auth_whoami',
        description: 'Check current auth status',
        inputSchema: { type: 'object', properties: { _auth_token: { type: 'string' } }, required: ['_auth_token'] },
      });
      this._toolHandlers.set('auth_whoami', ({ _auth_token }) => {
        const s = this._sessions.get(_auth_token);
        if (!s || Date.now() - s.created > SESSION_TTL) return { authenticated: false };
        return { authenticated: true, user: s.user };
      });
    }

    async _verifyToolAuth(toolName, args) {
      if (toolName === 'auth_login' || toolName === 'auth_whoami') return null;
      if (!this._authRequired) return null;
      const toolDef = this._tools.find(t => t.name === toolName);
      if (toolDef && toolDef._public) return null;

      const sid = args?._auth_token;
      if (!sid) throw new Error('Authentication required. Call auth_login first.');

      const session = this._sessions.get(sid);
      if (!session) throw new Error('Invalid or expired session.');
      if (Date.now() - session.created > SESSION_TTL) {
        this._sessions.delete(sid);
        throw new Error('Session expired. Call auth_login again.');
      }

      // Role check — supports single role or roles array
      if (toolDef?._roles?.length > 0) {
        const userRoles = session.user.roles || [session.user.role];
        if (!toolDef._roles.some(r => userRoles.includes(r))) {
          throw new Error(`Insufficient permissions. Required: ${toolDef._roles.join('/')}.`);
        }
      }

      return session.user;
    }

    _cleanupSessions() {
      const now = Date.now();
      for (const [sid, s] of this._sessions) {
        if (now - s.created > SESSION_TTL) this._sessions.delete(sid);
      }
    }

    // ─── Registration ──────────────────────────────────────────────────────

    tool(name, description, inputSchema, handler, opts) {
      const schema = this._normalizeSchema(inputSchema);
      if (this._authRequired && !opts?.public) {
        schema.properties._auth_token = { type: 'string', description: 'Session token from auth_login' };
      }
      const def = { name, description, inputSchema: schema };
      if (opts?.public) def._public = true;
      if (opts?.roles) def._roles = opts.roles;
      this._tools.push(def);
      this._toolHandlers.set(name, handler);
      return this;
    }

    resource(uri, description, mimeType, handler) {
      if (typeof mimeType === 'function') { handler = mimeType; mimeType = 'text/plain'; }
      const isT = uri.includes('{');
      this._resources.push({ uri: isT ? undefined : uri, uriTemplate: isT ? uri : undefined, name: uri, description, mimeType: mimeType || 'text/plain' });
      this._resourceHandlers.set(uri, handler);
      return this;
    }

    prompt(name, description, args, handler) {
      this._prompts.push({ name, description, arguments: args || [] });
      this._promptHandlers.set(name, handler);
      return this;
    }

    // ─── Start / Stop ──────────────────────────────────────────────────────

    async start() {
      if (this._started) return;
      this._started = true;

      if (this._authRequired) this._registerAuthTools();

      // Session cleanup timer
      this._cleanupTimer = setInterval(() => this._cleanupSessions(), SESSION_CLEANUP_INTERVAL);

      // Expose globally for postMessage/BroadcastChannel/direct access
      global._browserMCP = this;

      // Listen for postMessage (cross-tab, iframe, extension communication)
      window.addEventListener('message', async (event) => {
        if (event.data?.type === 'mcp-request' && event.data.body) {
          const response = await this.handleRequest(event.data.body);
          if (response && event.source) {
            event.source.postMessage({ type: 'mcp-response', id: event.data.body.id, response }, event.origin);
          }
          if (response && event.ports?.[0]) {
            event.ports[0].postMessage(response);
          }
        }
      });

      // BroadcastChannel for same-origin cross-tab communication
      try {
        this._channel = new BroadcastChannel('browser-mcp');
        this._channel.onmessage = async (event) => {
          if (event.data?.type === 'mcp-request') {
            const response = await this.handleRequest(event.data.body);
            if (response) this._channel.postMessage({ type: 'mcp-response', id: event.data.body.id, response });
          }
        };
      } catch {}

      if (this._showWidget) this._createWidget();

      console.log(`[BrowserMCP] ${this._name} started — ${this._tools.length} tools, ${this._resources.length} resources, ${this._prompts.length} prompts`);
      console.log(`[BrowserMCP] Access: window._browserMCP.handleRequest({...})`);
    }

    stop() {
      this._started = false;
      if (this._cleanupTimer) clearInterval(this._cleanupTimer);
      if (this._channel) this._channel.close();
      document.getElementById('browser-mcp-widget')?.remove();
    }

    listTools() { return this._tools.map(t => t.name); }

    // ─── MCP Protocol ──────────────────────────────────────────────────────

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
            return null;
          case 'tools/list':
            result = { tools: this._tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
            break;
          case 'tools/call': {
            const { name, arguments: args } = body.params;
            const handler = this._toolHandlers.get(name);
            if (!handler) throw new Error(`Tool not found: ${name}`);
            const user = await this._verifyToolAuth(name, args);
            const clean = { ...(args || {}) };
            delete clean._auth_token;
            const raw = await handler(clean, user);
            result = this._formatToolResult(raw);
            break;
          }
          case 'resources/list':
            result = { resources: this._resources };
            break;
          case 'resources/read': {
            const uri = body.params.uri;
            let handler = this._resourceHandlers.get(uri);
            let params = {};
            if (!handler) {
              for (const [tmpl, h] of this._resourceHandlers) {
                const m = this._matchUri(tmpl, uri);
                if (m) { handler = h; params = m; break; }
              }
            }
            if (!handler) throw new Error(`Resource not found: ${uri}`);
            const content = await handler(params);
            const rd = this._resources.find(r => r.uri === uri || r.uriTemplate);
            result = { contents: [{ uri, mimeType: rd?.mimeType || 'text/plain', text: typeof content === 'string' ? content : JSON.stringify(content) }] };
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
        if (result === null) return null;
        this._requestCount++;
        return { jsonrpc: '2.0', id, result };
      } catch (e) {
        return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
      }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    _normalizeSchema(input) {
      if (!input) return { type: 'object', properties: {} };
      if (input.type === 'object' && input.properties && typeof input.properties === 'object') {
        // Sanitize — prevent prototype pollution
        const safe = { type: 'object', properties: {} };
        for (const [k, v] of Object.entries(input.properties)) {
          if (k !== '__proto__' && k !== 'constructor') safe.properties[k] = v;
        }
        if (input.required) safe.required = input.required;
        return safe;
      }
      const properties = {};
      const required = [];
      for (const [key, val] of Object.entries(input)) {
        if (key === '__proto__' || key === 'constructor') continue;
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
      if (raw && raw.content) return raw;
      return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }] };
    }

    _matchUri(template, uri) {
      const escaped = template.replace(/([.+?^${}()|\\[\]])/g, '\\$1').replace(/\\\{(\w+)\\\}/g, '(?<$1>[^/]+)');
      const match = uri.match(new RegExp(`^${escaped}$`));
      return match ? match.groups : null;
    }

    // ─── Widget (XSS-safe) ─────────────────────────────────────────────────

    _createWidget() {
      const div = document.createElement('div');
      div.id = 'browser-mcp-widget';

      const style = document.createElement('style');
      style.textContent = `
        #browser-mcp-widget { position:fixed; bottom:20px; right:20px; z-index:99999; font-family:system-ui,sans-serif; font-size:13px; }
        #bmcp-btn { width:44px; height:44px; border-radius:50%; border:none; background:#1a1a2e; color:#4ade80; cursor:pointer; box-shadow:0 2px 10px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; }
        #bmcp-btn:hover { background:#16213e; }
        #bmcp-panel { display:none; position:absolute; bottom:54px; right:0; width:320px; background:#1a1a2e; border:1px solid #334155; border-radius:12px; padding:16px; color:#e2e8f0; box-shadow:0 4px 20px rgba(0,0,0,0.4); }
        #bmcp-panel.open { display:block; }
        #bmcp-panel h3 { margin:0 0 8px; font-size:15px; }
        .bmcp-info { color:#94a3b8; font-size:11px; margin-bottom:8px; }
        .bmcp-tool { padding:4px 8px; background:#0f172a; border-radius:4px; margin:2px 0; font-size:12px; }
        .bmcp-tool b { color:#4ade80; }
        .bmcp-ep { background:#0f172a; padding:8px; border-radius:6px; font-family:monospace; font-size:11px; margin:8px 0; word-break:break-all; color:#38bdf8; }
        .bmcp-copy { padding:6px 12px; background:#2563eb; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px; margin-top:4px; }
      `;
      div.appendChild(style);

      const panel = document.createElement('div');
      panel.id = 'bmcp-panel';

      const h3 = document.createElement('h3');
      h3.textContent = this._name;
      panel.appendChild(h3);

      const info = document.createElement('div');
      info.className = 'bmcp-info';
      info.textContent = `${this._tools.length} tools | ${this._resources.length} resources | ${this._prompts.length} prompts`;
      panel.appendChild(info);

      const ep = document.createElement('div');
      ep.className = 'bmcp-ep';
      ep.textContent = `window._browserMCP.handleRequest({...})`;
      panel.appendChild(ep);

      const toolsLabel = document.createElement('div');
      toolsLabel.style.cssText = 'margin-top:8px;font-size:11px;color:#94a3b8;';
      toolsLabel.textContent = 'Tools:';
      panel.appendChild(toolsLabel);

      for (const t of this._tools) {
        const td = document.createElement('div');
        td.className = 'bmcp-tool';
        const b = document.createElement('b');
        b.textContent = t.name;
        td.appendChild(b);
        td.appendChild(document.createTextNode(' — ' + t.description));
        panel.appendChild(td);
      }

      const copyBtn = document.createElement('button');
      copyBtn.className = 'bmcp-copy';
      copyBtn.textContent = 'Copy endpoint info';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(`window._browserMCP.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })`);
      });
      panel.appendChild(copyBtn);

      const count = document.createElement('div');
      count.style.cssText = 'margin-top:8px;font-size:10px;color:#4ade80;';
      count.innerHTML = 'Requests: <span id="bmcp-count">0</span>';
      panel.appendChild(count);

      div.appendChild(panel);

      const btn = document.createElement('button');
      btn.id = 'bmcp-btn';
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
      btn.addEventListener('click', () => panel.classList.toggle('open'));
      div.appendChild(btn);

      document.body.appendChild(div);

      setInterval(() => {
        const el = document.getElementById('bmcp-count');
        if (el) el.textContent = this._requestCount;
      }, 1000);
    }
  }

  if (typeof globalThis !== 'undefined') globalThis.BrowserMCP = BrowserMCP;
  if (typeof module !== 'undefined' && module.exports) module.exports = { BrowserMCP };
  if (typeof window !== 'undefined') window.BrowserMCP = BrowserMCP;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
