# browser-mcp

Turn any webpage into an MCP server. Zero dependencies. One script tag.

**Demo:** [browser-mcp.pages.dev](https://browser-mcp.pages.dev)

## What it does

Add one script to your page and AI agents (Claude, Gemini, etc.) can interact with it via the [Model Context Protocol](https://modelcontextprotocol.io).

```html
<script src="https://cdn.jsdelivr.net/npm/browser-mcp"></script>
<script>
  const mcp = new BrowserMCP({ name: "My Site" });

  mcp.tool("search", "Search this page", { query: "string" },
    ({ query }) => document.body.innerText.includes(query) ? "Found" : "Not found"
  );

  mcp.start();
</script>
```

That's it. Your page now exposes an MCP endpoint at `/mcp`.

## Features

- **Zero dependencies** — one 8KB file
- **5 lines to start** — register tools, call start()
- **MCP spec compliant** — tools, resources, prompts
- **Service Worker transport** — Streamable HTTP via SW intercept
- **Widget** — floating button shows status, tools, endpoint
- **Works everywhere** — any static site, SPA, CMS, dashboard

## API

### Tools

```javascript
mcp.tool(name, description, inputSchema, handler)

// Example
mcp.tool("get_price", "Get product price", { productId: "string" },
  ({ productId }) => products[productId]?.price || "Not found"
);
```

### Resources

```javascript
mcp.resource(uri, description, mimeType, handler)

// Static resource
mcp.resource("page://content", "Page text", "text/plain",
  () => document.body.innerText
);

// Template resource
mcp.resource("element://{id}", "DOM element by ID", "text/html",
  ({ id }) => document.getElementById(id)?.outerHTML || "Not found"
);
```

### Prompts

```javascript
mcp.prompt(name, description, args, handler)

mcp.prompt("summarize", "Summarize the page", [{ name: "focus" }],
  ({ focus }) => `Summarize this page, focus on ${focus}: ${document.body.innerText.slice(0, 3000)}`
);
```

### Start/Stop

```javascript
await mcp.start();  // Register SW + show widget
mcp.stop();          // Remove widget
mcp.listTools();     // ["search", "get_price", ...]
```

## How it works

1. `start()` registers a Service Worker that intercepts `POST /mcp`
2. The SW forwards JSON-RPC requests to the main page via `postMessage`
3. `BrowserMCP` dispatches to the registered tool/resource/prompt handler
4. Response flows back: handler → page → SW → HTTP response

```
AI Agent → POST /mcp → Service Worker → postMessage → BrowserMCP → handler
                                                                      ↓
AI Agent ← JSON response ← Service Worker ← postMessage ← result ←───┘
```

## Input Schema

Two formats supported:

```javascript
// Simple (auto-converts to JSON Schema)
{ name: "string", count: "number", active: "boolean" }

// Full JSON Schema
{
  type: "object",
  properties: {
    name: { type: "string", description: "User name" },
    age: { type: "number" }
  },
  required: ["name"]
}
```

## Widget

A floating button appears in the bottom-right corner showing:
- Server status (green = running)
- Tool list
- MCP endpoint URL (click to copy)
- Request counter

Disable with `new BrowserMCP({ widget: false })`.

## Install

### CDN (recommended)
```html
<script src="https://cdn.jsdelivr.net/npm/browser-mcp"></script>
```

### npm
```bash
npm install browser-mcp
```

```javascript
import { BrowserMCP } from 'browser-mcp';
```

## Use Cases

- **E-commerce**: Let agents check prices, inventory, add to cart
- **Dashboards**: Expose metrics and charts to AI analysis
- **Documentation**: Make docs searchable by agents
- **CMS**: Let agents create/edit content
- **Internal tools**: AI-automate any web app
- **Prototyping**: Quickly expose any page to AI agents

## Size

| Component | Size |
|-----------|------|
| browser-mcp.js | ~8 KB |
| Gzipped | ~3 KB |

## License

MIT

## Author

[Mauricio Perera](https://github.com/MauricioPerera)
