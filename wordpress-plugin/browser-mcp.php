<?php
/**
 * Plugin Name: Browser MCP
 * Description: Turn your WordPress site into an MCP server. AI agents can manage posts, pages, users, and settings.
 * Version: 0.1.0
 * Author: Mauricio Perera
 * License: MIT
 */

defined('ABSPATH') || exit;

class BrowserMCP_Plugin {

    public function __construct() {
        add_action('wp_enqueue_scripts', [$this, 'enqueue_frontend']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_admin']);
        add_action('rest_api_init', [$this, 'register_rest_routes']);
        add_action('admin_menu', [$this, 'add_settings_page']);
    }

    /**
     * Inject browser-mcp.js + WordPress tools on frontend
     */
    public function enqueue_frontend() {
        if (!get_option('bmcp_enable_frontend', false)) return;
        $this->inject_mcp_script('frontend');
    }

    /**
     * Inject browser-mcp.js + WordPress tools on admin
     */
    public function enqueue_admin() {
        $this->inject_mcp_script('admin');
    }

    /**
     * Inject the MCP script and register WordPress tools
     */
    private function inject_mcp_script($context) {
        // Load from local plugin dir (not CDN) — no SRI needed
        wp_enqueue_script(
            'browser-mcp',
            plugin_dir_url(__FILE__) . 'browser-mcp.js',
            [],
            '0.3.0',
            true
        );

        // Pass WP data to JS
        wp_localize_script('browser-mcp', 'bmcpConfig', [
            'restUrl'   => esc_url_raw(rest_url()),
            'nonce'     => wp_create_nonce('wp_rest'),
            'siteTitle' => wp_strip_all_tags(get_bloginfo('name')),
            'context'   => $context,
            'userId'    => get_current_user_id(),
            'isAdmin'   => current_user_can('manage_options'),
        ]);

        add_action($context === 'admin' ? 'admin_footer' : 'wp_footer', [$this, 'print_mcp_init']);
    }

    /**
     * Print the MCP initialization JavaScript
     */
    public function print_mcp_init() {
        ?>
        <script>
        (function() {
            if (typeof BrowserMCP === 'undefined') return;

            const cfg = window.bmcpConfig || {};
            const rest = cfg.restUrl;
            const nonce = cfg.nonce;

            const mcp = new BrowserMCP({
                name: cfg.siteTitle + ' (WordPress)',
                version: '0.1.0',
                description: 'WordPress MCP Server — manage posts, pages, media, and settings via AI agents',
            });

            // Auth: verify WordPress nonce (admin) or application password (external)
            let _authHeaders = {};
            mcp.requireAuth(async (token) => {
                try {
                    const headers = {};
                    if (token === 'wp-nonce') {
                        headers['X-WP-Nonce'] = nonce;
                    } else {
                        headers['Authorization'] = 'Basic ' + btoa(token);
                    }
                    const res = await fetch(rest + 'wp/v2/users/me', { headers });
                    if (!res.ok) return null;
                    _authHeaders = headers; // Store for tool calls
                    const user = await res.json();
                    return {
                        id: user.id,
                        role: user.roles?.[0] || 'subscriber',
                        roles: user.roles || ['subscriber'],
                        name: user.name,
                    };
                } catch { return null; }
            });

            // Helper: get auth headers for REST calls
            function wpHeaders() {
                if (_authHeaders['X-WP-Nonce']) return { 'X-WP-Nonce': _authHeaders['X-WP-Nonce'] };
                if (_authHeaders['Authorization']) return { 'Authorization': _authHeaders['Authorization'] };
                return { 'X-WP-Nonce': nonce }; // fallback to page nonce
            }

            function clampLimit(limit, def) {
                return Math.min(Math.max(parseInt(limit) || def, 1), 100);
            }

            // ── Public tools ──────────────────────────────────────────

            mcp.tool('wp_site_info', 'Get WordPress site information', {},
                () => JSON.stringify({
                    title: cfg.siteTitle,
                    url: window.location.origin,
                    context: cfg.context,
                    restUrl: rest,
                }),
                { public: true }
            );

            mcp.tool('wp_search', 'Search posts and pages', { query: 'string', limit: 'number' },
                async ({ query, limit }) => {
                    const res = await fetch(rest + 'wp/v2/search?search=' + encodeURIComponent(query) + '&per_page=' + Math.min(Math.max(parseInt(limit) || 10, 1), 100));
                    return await res.text();
                },
                { public: true }
            );

            // ── Authenticated tools ───────────────────────────────────

            mcp.tool('wp_list_posts', 'List recent posts', { status: 'string', limit: 'number' },
                async ({ status, limit }, user) => {
                    const s = status || 'publish';
                    const res = await fetch(rest + 'wp/v2/posts?status=' + s + '&per_page=' + clampLimit(limit, 10), {
                        headers: wpHeaders()
                    });
                    const posts = await res.json();
                    return JSON.stringify(posts.map(p => ({
                        id: p.id, title: p.title?.rendered, status: p.status,
                        date: p.date, link: p.link, excerpt: p.excerpt?.rendered?.slice(0, 200),
                    })), null, 2);
                }
            );

            mcp.tool('wp_get_post', 'Get a single post by ID', { id: 'number' },
                async ({ id }, user) => {
                    const res = await fetch(rest + 'wp/v2/posts/' + id, {
                        headers: wpHeaders()
                    });
                    if (!res.ok) return 'Post not found';
                    const p = await res.json();
                    return JSON.stringify({
                        id: p.id, title: p.title?.rendered, content: p.content?.rendered,
                        status: p.status, date: p.date, categories: p.categories, tags: p.tags,
                    }, null, 2);
                }
            );

            mcp.tool('wp_create_post', 'Create a new post', {
                title: 'string', content: 'string', status: 'string'
            },
                async ({ title, content, status }, user) => {
                    const res = await fetch(rest + 'wp/v2/posts', {
                        method: 'POST',
                        headers: { ...wpHeaders(), 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title, content, status: status || 'draft' }),
                    });
                    if (!res.ok) return 'Error: ' + (await res.text());
                    const p = await res.json();
                    return JSON.stringify({ id: p.id, title: p.title?.rendered, status: p.status, link: p.link });
                },
                { roles: ['administrator', 'editor', 'author'] }
            );

            mcp.tool('wp_update_post', 'Update an existing post', {
                id: 'number', title: 'string', content: 'string', status: 'string'
            },
                async ({ id, title, content, status }, user) => {
                    const body = {};
                    if (title) body.title = title;
                    if (content) body.content = content;
                    if (status) body.status = status;
                    const res = await fetch(rest + 'wp/v2/posts/' + id, {
                        method: 'PUT',
                        headers: { ...wpHeaders(), 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                    if (!res.ok) return 'Error: ' + (await res.text());
                    return 'Updated post ' + id;
                },
                { roles: ['administrator', 'editor'] }
            );

            mcp.tool('wp_delete_post', 'Delete a post (move to trash)', { id: 'number' },
                async ({ id }, user) => {
                    const res = await fetch(rest + 'wp/v2/posts/' + id, {
                        method: 'DELETE',
                        headers: wpHeaders(),
                    });
                    return res.ok ? 'Deleted post ' + id : 'Error: ' + (await res.text());
                },
                { roles: ['administrator', 'editor'] }
            );

            mcp.tool('wp_list_pages', 'List all pages', { limit: 'number' },
                async ({ limit }, user) => {
                    const res = await fetch(rest + 'wp/v2/pages?per_page=' + clampLimit(limit, 20), {
                        headers: wpHeaders()
                    });
                    const pages = await res.json();
                    return JSON.stringify(pages.map(p => ({
                        id: p.id, title: p.title?.rendered, status: p.status, link: p.link,
                    })), null, 2);
                }
            );

            mcp.tool('wp_list_categories', 'List all categories', {},
                async (_, user) => {
                    const res = await fetch(rest + 'wp/v2/categories?per_page=100', {
                        headers: wpHeaders()
                    });
                    const cats = await res.json();
                    return JSON.stringify(cats.map(c => ({ id: c.id, name: c.name, count: c.count })));
                }
            );

            mcp.tool('wp_list_users', 'List WordPress users', { limit: 'number' },
                async ({ limit }, user) => {
                    const res = await fetch(rest + 'wp/v2/users?per_page=' + clampLimit(limit, 20), {
                        headers: wpHeaders()
                    });
                    const users = await res.json();
                    return JSON.stringify(users.map(u => ({
                        id: u.id, name: u.name, slug: u.slug, roles: u.roles,
                    })));
                },
                { roles: ['administrator'] }
            );

            mcp.tool('wp_get_settings', 'Get WordPress site settings', {},
                async (_, user) => {
                    const res = await fetch(rest + 'wp/v2/settings', {
                        headers: wpHeaders()
                    });
                    if (!res.ok) return 'Error: insufficient permissions';
                    return await res.text();
                },
                { roles: ['administrator'] }
            );

            mcp.tool('wp_list_plugins', 'List installed plugins', {},
                async (_, user) => {
                    const res = await fetch(rest + 'wp/v2/plugins', {
                        headers: wpHeaders()
                    });
                    if (!res.ok) return 'Error: ' + res.status;
                    const plugins = await res.json();
                    return JSON.stringify(plugins.map(p => ({
                        plugin: p.plugin, name: p.name, status: p.status, version: p.version,
                    })), null, 2);
                },
                { roles: ['administrator'] }
            );

            // ── Resources ─────────────────────────────────────────────

            mcp.resource('wp://site', 'WordPress site metadata', 'application/json',
                () => JSON.stringify({
                    title: cfg.siteTitle,
                    url: window.location.origin,
                    userId: cfg.userId,
                    isAdmin: cfg.isAdmin,
                })
            );

            mcp.resource('wp://page/current', 'Current page content', 'text/plain',
                () => document.body.innerText.slice(0, 5000)
            );

            // ── Start ─────────────────────────────────────────────────

            mcp.start().then(() => {
                console.log('[Browser MCP] WordPress MCP server started with ' + mcp.listTools().length + ' tools');
            });
        })();
        </script>
        <?php
    }

    /**
     * REST API endpoint for MCP health check
     */
    public function register_rest_routes() {
        register_rest_route('browser-mcp/v1', '/status', [
            'methods' => 'GET',
            'callback' => function() {
                return rest_ensure_response([
                    'status' => 'active',
                    'version' => '0.1.0',
                    'tools' => 13,
                ]);
            },
            'permission_callback' => function() { return is_user_logged_in(); },
        ]);
    }

    /**
     * Settings page
     */
    public function add_settings_page() {
        add_options_page(
            'Browser MCP',
            'Browser MCP',
            'manage_options',
            'browser-mcp',
            [$this, 'render_settings']
        );
    }

    public function render_settings() {
        if (isset($_POST['bmcp_save'])) {
            check_admin_referer('bmcp_settings'); // Dies if invalid
            update_option('bmcp_enable_frontend', (bool) isset($_POST['bmcp_enable_frontend']));
            echo '<div class="notice notice-success"><p>Settings saved.</p></div>';
        }
        $frontend = get_option('bmcp_enable_frontend', false);
        ?>
        <div class="wrap">
            <h1>Browser MCP Settings</h1>
            <p>This plugin turns your WordPress admin (and optionally frontend) into an MCP server that AI agents can interact with.</p>

            <form method="post">
                <?php wp_nonce_field('bmcp_settings'); ?>
                <table class="form-table">
                    <tr>
                        <th>Enable on Frontend</th>
                        <td>
                            <label>
                                <input type="checkbox" name="bmcp_enable_frontend" <?php checked($frontend); ?>>
                                Also load MCP server on public pages (not just admin)
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th>MCP Endpoint</th>
                        <td><code><?php echo esc_url(home_url('/mcp')); ?></code></td>
                    </tr>
                    <tr>
                        <th>Tools Available</th>
                        <td>
                            <ul>
                                <li><strong>Public:</strong> wp_site_info, wp_search</li>
                                <li><strong>Auth required:</strong> wp_list_posts, wp_get_post, wp_list_pages, wp_list_categories</li>
                                <li><strong>Editor+:</strong> wp_create_post, wp_update_post, wp_delete_post</li>
                                <li><strong>Admin only:</strong> wp_list_users, wp_get_settings, wp_list_plugins</li>
                            </ul>
                        </td>
                    </tr>
                </table>
                <p class="submit">
                    <input type="submit" name="bmcp_save" class="button-primary" value="Save Settings">
                </p>
            </form>
        </div>
        <?php
    }
}

add_action('plugins_loaded', function() {
    new BrowserMCP_Plugin();
});
