# browser-mcp

Turn any webpage into an MCP server. Zero dependencies. One script tag.

**Demo:** [browser-mcp.pages.dev](https://browser-mcp.pages.dev) | **Tests:** [browser-mcp.pages.dev/test.html](https://browser-mcp.pages.dev/test.html) (76 tests) | **Shop Demo:** [mcp-shop-demo.html](https://browser-mcp.pages.dev/mcp-shop-demo.html) | **MCP Browser:** [Download](https://github.com/MauricioPerera/mcp-browser/releases)

## What it does

Add one script to any page and AI agents (Claude, Gemini, etc.) can interact with it via the [Model Context Protocol](https://modelcontextprotocol.io). Full spec coverage: Tools, Resources, Prompts, and Sampling.

Works in two runtimes:

- **Standalone** -- load `browser-mcp.js`, create a `BrowserMCP` instance, call `.start()`. Communication happens over `BroadcastChannel`.
- **[MCP Browser](https://github.com/MauricioPerera/mcp-browser)** -- the companion desktop app that bridges any webpage to MCP clients like Claude Desktop. Pages only need `mcpTool()` calls; no extra script tag required.

The `mcpTool()` global API is the universal way to register tools. It works identically in both runtimes.

```html
<script src="https://cdn.jsdelivr.net/npm/@rckflr/browser-mcp@0.5.0/browser-mcp.js"></script>
<script>
  const mcp = new BrowserMCP({ name: "My Site" });
  mcp.tool("search", "Search this page", { query: { type: "string" } },
    ({ query }) => document.body.innerText.includes(query) ? "Found" : "Not found"
  );
  mcp.start();
</script>
```

## Features

| Feature | Description |
|---------|-------------|
| **Tools** | Let agents perform actions on your site |
| **Resources** | Expose data via URIs (static or template) |
| **Prompts** | Pre-built templates for agent interactions |
| **Sampling** | Page requests completions from user/LLM (human-in-the-loop modal) |
| **Auth + Roles** | Token-based auth with role restrictions (admin, editor, etc.) |
| **Sessions** | Auto-expiring sessions (1h TTL, cleanup every 5min) |
| **mcpTool() Global API** | Universal tool registration that works in standalone and MCP Browser |
| **MCP Browser Compatibility** | Pages work inside [MCP Browser](https://github.com/MauricioPerera/mcp-browser) with zero changes |
| **Debug Plugin** | 12 pre-built debug tools (errors, network, DOM, performance) |
| **WordPress Plugin** | 13 tools for WP admin automation |
| **BroadcastChannel** | Cross-tab communication for agents |
| **Widget** | Floating status indicator with tool list |

## Install

```html
<!-- CDN -->
<script src="https://cdn.jsdelivr.net/npm/@rckflr/browser-mcp@0.5.0/browser-mcp.js"></script>
```

```bash
# npm
npm install @rckflr/browser-mcp
```

## mcpTool() -- The Universal API

`mcpTool()` is a global function that registers MCP tools in both runtimes. You write tool definitions once and they work whether the page is running standalone with `browser-mcp.js` or inside [MCP Browser](https://github.com/MauricioPerera/mcp-browser).

```javascript
mcpTool(name, description, schema, handler)
```

### How it works

**Standalone (browser-mcp.js loaded):** `mcpTool()` pushes tools into the global `__MCP_TOOLS__` / `__MCP_HANDLERS__` registries. When `BrowserMCP.start()` is called, it syncs those tools into the instance. If the instance is already running, tools are registered immediately.

**MCP Browser:** The bridge script injects its own `mcpTool()` before the page scripts run. Tools registered via `mcpTool()` are picked up by the bridge and exposed to MCP clients like Claude Desktop.

### Example: Shop Demo

The [shop demo](https://browser-mcp.pages.dev/mcp-shop-demo.html) uses only `mcpTool()` calls and works in both runtimes without any code changes:

```javascript
// Wait for mcpTool to be available (either runtime)
function whenMcpReady(cb) {
  if (typeof mcpTool === 'function') return cb();
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@rckflr/browser-mcp@0.5.0/browser-mcp.js';
  s.onload = () => { new BrowserMCP({ name: 'Shop' }).start(); cb(); };
  document.head.appendChild(s);
}

whenMcpReady(() => {
  mcpTool('shop_search', 'Search products by name or category',
    { query: { type: 'string' } },
    ({ query }) => products.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase())
    )
  );

  mcpTool('shop_add_to_cart', 'Add product to cart',
    { productId: { type: 'number' }, quantity: { type: 'number' } },
    ({ productId, quantity }) => { /* add to cart logic */ }
  );
});
```

## API Reference

### Tools

```javascript
// Using BrowserMCP instance
mcp.tool("name", "description", { arg: "type" }, handler, options?)

// Using mcpTool() global (works in both runtimes)
mcpTool("name", "description", { arg: { type: "string" } }, handler)

// Public tool
mcp.tool("ping", "Health check", {}, () => "pong", { public: true });

// Role-restricted
mcp.tool("delete", "Delete item", { id: "string" },
  ({ id }, user) => deleteItem(id),
  { roles: ["admin"] }
);
```

### Resources

```javascript
mcp.resource("page://content", "Page text", "text/plain", () => document.body.innerText);
mcp.resource("item://{id}", "Item by ID", "text/plain", ({ id }) => getItem(id));
```

### Prompts

```javascript
mcp.prompt("summarize", "Summarize page", [{ name: "focus" }],
  ({ focus }) => `Summarize, focus on ${focus}: ${document.body.innerText.slice(0, 3000)}`
);
```

### Sampling

```javascript
// Default: shows modal for human response
mcp.enableSampling();

// Custom: auto-respond (e.g. local LLM)
mcp.enableSampling(async ({ messages }) => myLLM.complete(messages));

// Use from tool handlers
mcp.tool("ask_user", "Ask user a question", { question: "string" },
  async ({ question }) => {
    const r = await mcp.createSamplingMessage({
      messages: [{ role: "user", content: { type: "text", text: question } }],
    });
    return r.content.text;
  }
);
```

### Auth

```javascript
// Simple tokens
mcp.requireAuth((token) => {
  const users = { "key123": { id: "admin", role: "admin", name: "Admin" } };
  return users[token] || null;
});

// API verification
mcp.requireAuth(async (token) => {
  const res = await fetch("/api/verify", { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? await res.json() : null;
});
```

Auth flow for agents:
1. Call `auth_login` tool with token -- get session ID
2. Include `_auth_token` in all subsequent tool calls
3. Sessions auto-expire after 1 hour

## Debug Plugin

12 pre-built tools for debugging any web app. Auto-captures errors, console, and fetch requests.

```html
<script src="browser-mcp.js"></script>
<script src="plugins/debug.js"></script>
<script>
  const mcp = new BrowserMCP({ name: "My App" });
  BrowserMCPDebug.register(mcp);
  mcp.start();
</script>
```

| Tool | What it does |
|------|-------------|
| `debug_health` | Uptime, memory, error count, DOM nodes |
| `debug_errors` | Captured JS errors + unhandled rejections |
| `debug_console` | Captured console.error/warn messages |
| `debug_network` | Fetch requests with status, duration, errors |
| `debug_dom` | Inspect element by CSS selector |
| `debug_query` | Count/list elements matching selector |
| `debug_performance` | LCP, FCP, load time, memory |
| `debug_storage` | localStorage/sessionStorage contents |
| `debug_cookies` | List all cookies |
| `debug_eval` | Execute JS in page context |
| `debug_viewport` | Viewport, scroll, device info |
| `debug_clear` | Reset all captured data |

Resource: `debug://snapshot` -- full debug state in one call.

The debug plugin also supports `mcpTool()` registration for MCP Browser compatibility.

## WordPress Plugin

Drop `wordpress-plugin/` into `wp-content/plugins/browser-mcp/` and activate. 13 tools auto-registered. Uses `mcpTool()` when running inside MCP Browser, falls back to `mcp.tool()` in standalone mode.

| Tool | Roles | Action |
|------|-------|--------|
| `wp_site_info` | public | Site metadata |
| `wp_search` | public | Search posts/pages |
| `wp_list_posts` | auth | List posts |
| `wp_get_post` | auth | Get post by ID |
| `wp_list_pages` | auth | List pages |
| `wp_list_categories` | auth | List categories |
| `wp_create_post` | editor+ | Create post |
| `wp_update_post` | editor+ | Edit post |
| `wp_delete_post` | editor+ | Delete post |
| `wp_list_users` | admin | List users |
| `wp_get_settings` | admin | WP settings |
| `wp_list_plugins` | admin | Installed plugins |

## Tests & Benchmarks

76 tests covering: constructor, tools, resources, prompts, sampling, auth, roles, sessions, error handling.

Live: [browser-mcp.pages.dev/test.html](https://browser-mcp.pages.dev/test.html)

| Operation | ops/sec |
|-----------|---------|
| tools/call | 250,000 |
| initialize | 333,333 |
| resources/read | 333,333 |
| sampling (custom) | 200,000+ |
| **throughput (1000 calls)** | **238,000** |

## Size

| File | Size |
|------|------|
| browser-mcp.js | ~10 KB |
| plugins/debug.js | ~6 KB |
| **Total** | **~16 KB** |

## Use Cases

- **E-commerce** -- Agents search products, check inventory, add to cart ([shop demo](https://browser-mcp.pages.dev/mcp-shop-demo.html))
- **CMS / WordPress** -- Create posts, manage content via AI
- **Dashboards** -- Expose metrics to AI analysis
- **Debugging** -- Errors, DOM, network, performance via tools
- **Documentation** -- Make docs searchable by agents
- **Internal tools** -- AI-automate any web app
- **MCP Browser pages** -- Register tools with `mcpTool()` for Claude Desktop

## Comparison with WebMCP

| | browser-mcp | WebMCP |
|---|---|---|
| Tools | Yes | Yes |
| Resources | Yes | Yes |
| Prompts | Yes | Yes |
| Sampling | Yes | Yes |
| Auth + Roles | Yes | No |
| Sessions (TTL) | Yes | No |
| mcpTool() Global API | Yes | No |
| MCP Browser Support | Yes | No |
| Debug Plugin | Yes | No |
| WordPress Plugin | Yes | No |
| BroadcastChannel | Yes | No |

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera)
