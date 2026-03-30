# browser-mcp

Turn any webpage into an MCP server. Zero dependencies. One script tag.

**Demo:** [browser-mcp.pages.dev](https://browser-mcp.pages.dev) | **Tests:** [browser-mcp.pages.dev/test.html](https://browser-mcp.pages.dev/test.html)

## What it does

Add one script to any page and AI agents (Claude, Gemini, etc.) can interact with it via the [Model Context Protocol](https://modelcontextprotocol.io). Full spec coverage: Tools, Resources, Prompts, and Sampling.

```html
<script src="https://cdn.jsdelivr.net/npm/@rckflr/browser-mcp@0.4.0/browser-mcp.js"></script>
<script>
  const mcp = new BrowserMCP({ name: "My Site" });
  mcp.tool("search", "Search this page", { query: "string" },
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
| **BroadcastChannel** | Cross-tab communication for agents |
| **Debug Plugin** | 12 pre-built debug tools (errors, network, DOM, performance) |
| **WordPress Plugin** | 13 tools for WP admin automation |
| **Widget** | Floating status indicator with tool list |

## Install

```html
<!-- CDN -->
<script src="https://cdn.jsdelivr.net/npm/@rckflr/browser-mcp@0.4.0/browser-mcp.js"></script>
```

```bash
# npm
npm install @rckflr/browser-mcp
```

## API

### Tools

```javascript
mcp.tool("name", "description", { arg: "type" }, handler, options?)

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
1. Call `auth_login` tool with token → get session ID
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

Resource: `debug://snapshot` — full debug state in one call.

## WordPress Plugin

Drop `wordpress-plugin/` into `wp-content/plugins/browser-mcp/` and activate. 13 tools auto-registered:

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

- **E-commerce** — Agents search products, check inventory, add to cart
- **CMS / WordPress** — Create posts, manage content
- **Dashboards** — Expose metrics to AI analysis
- **Debugging** — Errors, DOM, network, performance — all via tools
- **Documentation** — Make docs searchable by agents
- **Internal tools** — AI-automate any web app

## Comparison with WebMCP

| | browser-mcp | WebMCP |
|---|---|---|
| Tools | ✅ | ✅ |
| Resources | ✅ | ✅ |
| Prompts | ✅ | ✅ |
| Sampling | ✅ | ✅ |
| Auth + Roles | ✅ | ❌ |
| Sessions (TTL) | ✅ | ❌ |
| Debug Plugin | ✅ | ❌ |
| WordPress Plugin | ✅ | ❌ |
| BroadcastChannel | ✅ | ❌ |

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera)
