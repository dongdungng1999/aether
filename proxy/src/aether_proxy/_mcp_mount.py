"""
_mcp_mount.py — mount all MCP servers onto the FastAPI app at startup.

Each MCP server is wrapped as a streamable-http sub-app so claude connects
via HTTP — no Python/Node/bun required on the host machine.

IMPORTANT: streamable_http_app() requires session_manager.run() to be active
inside a lifespan. _register_mcp() wraps the existing FastAPI lifespan so
every MCP session manager starts/stops correctly with the app.
"""
from __future__ import annotations

import contextlib
import glob
import logging
import os
import pathlib
import sys

from fastapi import FastAPI

logger = logging.getLogger(__name__)

_MCP_DIR = pathlib.Path(__file__).parent.parent.parent / "mcp_servers"
sys.path.insert(0, str(_MCP_DIR))


# ── Core helper: mount FastMCP with proper lifespan ──────────────────────────

def _register_mcp(app: FastAPI, path: str, fmcp) -> None:
    """
    Mount a FastMCP instance and inject its session_manager.run() into
    the FastAPI lifespan so the task group is initialised before requests.
    """
    sub_app = fmcp.streamable_http_app()
    app.mount(path, sub_app)

    existing_lifespan = app.router.lifespan_context

    @contextlib.asynccontextmanager
    async def _combined(a):
        async with existing_lifespan(a):
            async with fmcp._session_manager.run():
                yield

    app.router.lifespan_context = _combined


# ── Public entry point ────────────────────────────────────────────────────────

def mount_all(app: FastAPI) -> None:
    """Mount every available MCP server. Failures are logged, not raised."""
    _mount_local(app)
    _mount_external(app)


def _is_disabled(name: str) -> bool:
    """Check if MCP is in AURA_MCP_DISABLED list."""
    disabled = os.environ.get("AURA_MCP_DISABLED", "")
    return name in [x.strip() for x in disabled.split(",") if x.strip()]


# ── Local Python MCPs (bundled with this proxy) ────────────────────────────────

def _mount_local(app: FastAPI) -> None:
    try:
        from vision_server import mcp as mcp_vision
        from visualise_server import mcp as mcp_visualise
        _register_mcp(app, "/mcp/vision", mcp_vision)
        _register_mcp(app, "/mcp/visualise", mcp_visualise)
        logger.info("[MCP] vision + visualise mounted")
    except Exception as e:
        logger.warning("[MCP] local MCPs failed: %s", e)


# ── External MCPs (stdio subprocess proxied via MCP ClientSession) ────────────

def _make_proxy(name: str, command: str, args: list[str], env: dict | None = None):
    """
    Wrap a stdio MCP server as a FastMCP streamable-http sub-app.
    
    Tools are discovered at server startup (during lifespan) by spawning the
    subprocess and calling tools/list. Each discovered tool is registered as
    a typed FastMCP handler with proper parameter signatures built from the
    tool's inputSchema — so claude sees real tool names and parameters.
    """
    from mcp import ClientSession
    from mcp.client.stdio import stdio_client, StdioServerParameters
    from mcp.server.fastmcp import FastMCP

    full_env = {**os.environ, **(env or {})}
    full_env = {k: v for k, v in full_env.items() if v}

    params = StdioServerParameters(command=command, args=args, env=full_env)
    # stateless_http=True: each POST is handled independently — no session ID
    # required. This makes older Claude Code clients (e.g. Windows CLI) work
    # correctly since they don't always persist the mcp-session-id header.
    proxy = FastMCP(name, stateless_http=True)

    async def _call(tool_name: str, kwargs: dict) -> str:
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                result = await s.call_tool(tool_name, kwargs)
                parts = [c.text for c in result.content if hasattr(c, "text")]
                return "\n".join(parts) if parts else ""

    # Cache file in persistent bind-mount — survives container restarts.
    # Falls back to /tmp if mount not available.
    import os as _os
    _cache_dir = "/mnt/claude-mem/.mcp_tool_cache"
    if not _os.path.exists(_cache_dir):
        try:
            _os.makedirs(_cache_dir, mode=0o700, exist_ok=True)
        except Exception:
            _cache_dir = "/tmp"
    # Include a hash of the env so cache invalidates when config changes (e.g. URL switch).
    import hashlib as _hashlib
    _env_sig = _hashlib.md5(str(sorted((env or {}).items())).encode()).hexdigest()[:8]
    _cache_file = f"{_cache_dir}/aura_mcp_{name}_{_env_sig}.json"

    async def _discover_and_register():
        """Discover tools from subprocess and register with proper typed signatures.
        Uses JSON cache to skip subprocess spawn on subsequent startups."""
        import json as _json
        import keyword as _keyword

        tools_data = None

        # Try cache first
        try:
            with open(_cache_file) as _f:
                tools_data = _json.load(_f)
                logger.info("[MCP] %s: loaded %d tools from cache", name, len(tools_data))
        except Exception:
            pass

        if tools_data is None:
            # Cache miss — discover from subprocess
            try:
                async with stdio_client(params) as (r, w):
                    async with ClientSession(r, w) as s:
                        await s.initialize()
                        tools_result = await s.list_tools()
                tools_data = [
                    {"name": t.name, "description": t.description,
                     "inputSchema": t.inputSchema}
                    for t in tools_result.tools
                ]
                # Save cache
                try:
                    with open(_cache_file, "w") as _f:
                        _json.dump(tools_data, _f)
                except Exception:
                    pass
            except Exception as e:
                logger.warning("[MCP] %s: tool discovery failed (%s) — no tools registered", name, e)
                return

        try:

            for td in tools_data:
                _n = td["name"]
                _d = td.get("description") or _n
                _schema = td.get("inputSchema") or {}
                _props = _schema.get("properties", {})
                _required = set(_schema.get("required", []))

                # Build typed parameter list from inputSchema
                # Required params MUST come before optional ones (Python syntax)
                ptype_map = {"string": "str", "integer": "int",
                             "boolean": "bool", "number": "float",
                             "array": "list", "object": "dict"}
                required_parts = []
                optional_parts = []
                safe_names = {pname: f"{pname}_" if _keyword.iskeyword(pname) else pname for pname in _props}
                for pname, pinfo in _props.items():
                    safe_name = safe_names[pname]
                    raw_type = pinfo.get("type", "string")
                    if isinstance(raw_type, list):
                        raw_type = next((t for t in raw_type if t != "null"), "string")
                    ptype = ptype_map.get(raw_type, "str")
                    if pname in _required:
                        required_parts.append(f"{safe_name}: {ptype}")
                    elif "default" in pinfo:
                        default = pinfo["default"]
                        optional_parts.append(f"{safe_name}: {ptype} = {repr(default)}")
                    else:
                        optional_parts.append(f"{safe_name}: {ptype} = None")
                param_parts = required_parts + optional_parts

                param_str = ", ".join(param_parts) if param_parts else ""
                kw_build = "{" + ", ".join(
                    f"'{pname}': {safe_names[pname]}"
                    for pname in _props
                ) + "}" if param_parts else "{}"
                # Filter None values at call time
                kw_build = "{k: v for k, v in " + kw_build + ".items() if v is not None}"

                fn_code = f"""
async def _handler({param_str}) -> str:
    kw = {kw_build}
    return await _call_fn('{_n}', kw)
"""
                local_ns = {"_call_fn": _call}
                exec(fn_code, local_ns)
                handler = local_ns["_handler"]
                handler.__name__ = _n
                handler.__doc__ = _d
                proxy.tool(name=_n, description=_d)(handler)

            logger.info("[MCP] %s: %d tools registered", name, len(tools_data))
        except Exception as e:
            logger.warning("[MCP] %s: tool registration failed (%s)", name, e)

    proxy._aura_discover = _discover_and_register
    return proxy


def _mount_external(app: FastAPI) -> None:
    _proxies_to_discover: list = []

    def _add(path: str, proxy):
        name = path.split("/")[-1]
        if _is_disabled(name):
            logger.info("[MCP] %s: disabled via AURA_MCP_DISABLED — skipped", name)
            return
        try:
            _register_mcp(app, path, proxy)
            _proxies_to_discover.append(proxy)
            logger.info("[MCP] mounted %s", path)
        except Exception as e:
            logger.warning("[MCP] failed to mount %s: %s", path, e)

    # ── Helper: resolve pre-installed npm package entry point ───────────────
    def _npm_bin(pkg: str) -> tuple[str, list[str]]:
        """
        Use globally pre-installed npm package instead of npx -y (avoids
        network hit on corporate proxies). Reads package.json bin field to
        find the correct entry point.

        If the entry JS starts with '#!/usr/bin/env bun' (Bun-compiled bundle),
        use 'bun' as the runtime instead of 'node' (Bun APIs like HTMLRewriter
        are not available in Node).

        Falls back to npx without version tag if package not found locally.
        """
        import glob as _glob
        import json as _json
        import shutil as _shutil

        # Build search dirs: standard global prefixes + npx cache entries
        _search_dirs = [
            os.path.join(p, "lib", "node_modules", pkg)
            for p in ("/usr/local", "/usr")
        ]
        # npx caches packages under ~/.npm/_npx/<hash>/node_modules/<pkg>
        # Scan all user home dirs accessible from the container.
        for _npx_entry in _glob.glob(f"/home/*/.npm/_npx/*/node_modules/{pkg}"):
            _search_dirs.append(_npx_entry)
        for _npx_entry in _glob.glob(f"/root/.npm/_npx/*/node_modules/{pkg}"):
            _search_dirs.append(_npx_entry)

        for pkg_dir in _search_dirs:
            pkg_json = os.path.join(pkg_dir, "package.json")
            if not os.path.exists(pkg_json):
                continue
            try:
                meta = _json.load(open(pkg_json))
                # bin: {"pkg-name": "relative/path.js"} or string
                bin_field = meta.get("bin")
                if isinstance(bin_field, dict):
                    rel = next(iter(bin_field.values()))
                elif isinstance(bin_field, str):
                    rel = bin_field
                elif meta.get("main"):
                    rel = meta["main"]
                else:
                    continue
                entry = os.path.join(pkg_dir, rel)
                if not os.path.exists(entry):
                    continue
                # Detect Bun-compiled bundles (shebang or @bun marker in first line)
                runtime = "node"
                try:
                    with open(entry, "rb") as _f:
                        first = _f.read(128).decode("utf-8", errors="ignore")
                    if "#!/usr/bin/env bun" in first or "// @bun" in first:
                        bun_path = _shutil.which("bun")
                        if bun_path:
                            runtime = "bun"
                            logger.info("[MCP] %s: Bun bundle detected, using bun runtime", pkg)
                        else:
                            logger.warning("[MCP] %s: Bun bundle but bun not found, trying node anyway", pkg)
                except Exception:
                    pass
                logger.info("[MCP] %s: using pre-installed %s (runtime=%s)", pkg, entry, runtime)
                return runtime, [entry]
            except Exception:
                pass
        # Final fallback: npx without @latest to use local cache
        logger.warning("[MCP] %s: pre-install not found, falling back to npx", pkg)
        return "npx", [pkg]

    # ── tavily ──────────────────────────────────────────────────────────────
    if os.environ.get("TAVILY_API_KEY"):
        _cmd, _args = _npm_bin("tavily-mcp")
        _add("/mcp/tavily", _make_proxy(
            "tavily", _cmd, _args,
            env={"TAVILY_API_KEY": os.environ["TAVILY_API_KEY"]},
        ))

    # ── duckduckgo ──────────────────────────────────────────────────────────
    _cmd, _args = _npm_bin("duckduckgo-mcp")
    _add("/mcp/duckduckgo", _make_proxy("duckduckgo", _cmd, _args))

    # ── firecrawl ───────────────────────────────────────────────────────────
    if os.environ.get("FIRECRAWL_API_KEY"):
        _cmd, _args = _npm_bin("firecrawl-mcp")
        _add("/mcp/firecrawl", _make_proxy(
            "firecrawl", _cmd, _args,
            env={"FIRECRAWL_API_KEY": os.environ["FIRECRAWL_API_KEY"]},
        ))

    # ── paper-search ────────────────────────────────────────────────────────
    # --with pins mcp<2.0.0 inside uvx's ephemeral env — paper-search-mcp
    # doesn't pin it itself, so uvx otherwise resolves latest mcp (2.x),
    # which renamed FastMCP → MCPServer and breaks this server's imports.
    _add("/mcp/paper-search", _make_proxy(
        "paper-search", "uvx",
        ["--from", "paper-search-mcp", "--with", "mcp<2.0.0", "python", "-m", "paper_search_mcp.server"],
        env={"PAPER_SEARCH_MCP_UNPAYWALL_EMAIL": os.environ.get("PAPER_SEARCH_MCP_UNPAYWALL_EMAIL", "")},
    ))

    # ── arxiv ───────────────────────────────────────────────────────────────
    _add("/mcp/arxiv", _make_proxy(
        "arxiv", "uvx", ["arxiv-mcp-server", "--storage-path", os.path.expanduser("~/arxiv-papers")],
    ))

    # ── jira / confluence ────────────────────────────────────────────────────
    if os.environ.get("JIRA_URL") and os.environ.get("JIRA_PERSONAL_TOKEN"):
        _add("/mcp/jira", _make_proxy(
            "jira", "uvx", ["mcp-atlassian"],
            env={
                "JIRA_URL": os.environ.get("JIRA_URL", ""),
                "JIRA_PERSONAL_TOKEN": os.environ.get("JIRA_PERSONAL_TOKEN", ""),
                "CONFLUENCE_URL": os.environ.get("CONFLUENCE_URL", ""),
                "CONFLUENCE_PERSONAL_TOKEN": os.environ.get("CONFLUENCE_PERSONAL_TOKEN", ""),
            },
        ))

    # ── gitlab ───────────────────────────────────────────────────────────────
    if os.environ.get("GITLAB_PERSONAL_ACCESS_TOKEN"):
        _add("/mcp/gitlab", _make_proxy(
            "gitlab", "uvx", ["mcp-server-gitlab"],
            env={
                "GITLAB_API_URL": os.environ.get("GITLAB_API_URL", ""),
                "GITLAB_PERSONAL_ACCESS_TOKEN": os.environ.get("GITLAB_PERSONAL_ACCESS_TOKEN", ""),
            },
        ))

    # ── excalidraw ──────────────────────────────────────────────────────────
    _cmd, _args = _npm_bin("mcp-excalidraw-server")
    _excalidraw_server_url = os.environ.get("EXCALIDRAW_SERVER_URL", "")
    if not _excalidraw_server_url:
        # EXCALIDRAW_SERVER_URL not passed at container start — resolve docker
        # bridge IP dynamically so mcp-excalidraw-server can reach the canvas
        # server on the host (host.docker.internal is not always resolvable).
        import socket
        _port = os.environ.get("EXCALIDRAW_PORT", "3001")
        _bridge_ip = None
        try:
            with open("/proc/net/route") as _f:
                for _line in _f:
                    _parts = _line.strip().split()
                    if _parts[1] == "00000000":  # default route
                        _bridge_ip = socket.inet_ntoa(bytes.fromhex(_parts[2])[::-1])
                        break
        except Exception:
            pass
        _excalidraw_server_url = (
            f"http://{_bridge_ip}:{_port}" if _bridge_ip
            else f"http://host.docker.internal:{_port}"
        )
        logger.info("[MCP] excalidraw: resolved server URL → %s", _excalidraw_server_url)
    _add("/mcp/excalidraw", _make_proxy(
        "excalidraw", _cmd, _args,
        env={
            "EXPRESS_SERVER_URL": _excalidraw_server_url,
            "EXCALIDRAW_EXPORT_DIR": os.environ.get("AURA_CWD", "/tmp"),
            "EXCALIDRAW_NO_AUTOSTART": "1",
        },
    ))

    # ── excel — spreadsheets via @negokaz/excel-mcp-server ──────────────────────
    _cmd, _args = _npm_bin("@negokaz/excel-mcp-server")
    _add("/mcp/excel", _make_proxy("excel", _cmd, _args))

    # ── claude-mem ───────────────────────────────────────────────────────────
    claude_mem_server = os.environ.get("CLAUDE_MEM_SERVER", "")
    if not claude_mem_server or not os.path.exists(claude_mem_server):
        # Search order: bundled in image → host plugin mount
        search_patterns = [
            "/opt/claude-mem/**/mcp-server.cjs",    # bundled via git clone
            "/data/claude-mem-plugin/*/scripts/mcp-server.cjs",  # host mount fallback
        ]
        for pattern in search_patterns:
            candidates = sorted(glob.glob(pattern, recursive=True))
            if candidates:
                claude_mem_server = candidates[-1]
                logger.info("[MCP] claude-mem: auto-discovered %s", claude_mem_server)
                break

    if claude_mem_server and os.path.exists(claude_mem_server):
        _add("/mcp/claude-mem", _make_proxy(
            "claude-mem", "node", [claude_mem_server],
            env={
                "CLAUDE_MEM_DATA_DIR": os.environ.get("CLAUDE_MEM_DATA_DIR", "/mnt/claude-mem"),
                "CLAUDE_MEM_WORKER_HOST": os.environ.get("CLAUDE_MEM_WORKER_HOST", "127.0.0.1"),
                "CLAUDE_MEM_WORKER_PORT": os.environ.get("CLAUDE_MEM_WORKER_PORT", "37700"),
            },
        ))
    else:
        logger.info("[MCP] claude-mem: not found — skipped")

    # ── obscura (headless browser) ───────────────────────────────────────────
    # sys.executable (this proxy's own pinned .venv), not a bare "python3" —
    # that resolves via PATH and can land on a system/user-site Python whose
    # own mcp package is a newer, incompatible major version.
    _add("/mcp/obscura", _make_proxy(
        "obscura", sys.executable, [str(_MCP_DIR / "obscura_server.py")],
        env={"OBSCURA_BIN": os.environ.get("OBSCURA_BIN", "obscura"),
             "OBSCURA_OUT_DIR": os.environ.get("OBSCURA_OUT_DIR", "/tmp/obscura-out"),
             "AURA_PROXY_INTERNAL_URL": os.environ.get("AURA_PROXY_INTERNAL_URL", "http://127.0.0.1:8000")},
    ))

    # ── mineru (local CLI or remote relay) ───────────────────────────────────
    mineru_url = os.environ.get("MINERU_API_URL", "")
    mineru_venv = os.environ.get("MINERU_VENV_PYTHON", "")
    # If the user's preset points at a host venv (LOCAL mode) but that path
    # isn't reachable from inside the container — typical when the proxy
    # doesn't bind-mount the host's MinerU dir — drop back to REMOTE mode
    # using whichever URL is configured. This keeps the user's config
    # untouched while still giving us a working PDF parser.
    if mineru_venv and not os.path.exists(mineru_venv):
        logger.info("[MCP] mineru: MINERU_VENV_PYTHON=%s missing inside container — falling back to REMOTE", mineru_venv)
        mineru_venv = ""
    # Last-resort default — if neither LOCAL venv nor REMOTE URL came
    # through, try the conventional MinerU REST endpoint on the docker
    # host. Costs nothing if the host doesn't actually run mineru-api;
    # the MCP server's own health check surfaces that as a parse error
    # rather than crashing on tool registration.
    if not mineru_url and not mineru_venv:
        mineru_url = "http://host.docker.internal:8962"
        logger.info("[MCP] mineru: no config — defaulting to REMOTE %s", mineru_url)
    if mineru_url or mineru_venv:
        # mineru_server.py decides mode by `bool(MINERU_API_URL)` at module
        # load. Pass ONE of the two env vars — never both — so a host
        # configured for both LOCAL (venv) and REMOTE (url) deterministically
        # picks LOCAL. LOCAL wins because it doesn't need outbound network
        # access from the container, which is exactly the scenario this
        # branch handles (firewalled hosts).
        mineru_env = {}
        if mineru_venv:
            mineru_env["MINERU_VENV_PYTHON"] = mineru_venv
            mineru_env["MINERU_API_URL"]     = ""   # mask any inherited value
        else:
            mineru_env["MINERU_API_URL"]     = mineru_url
        mode = "LOCAL" if mineru_venv else "REMOTE"
        logger.info("[MCP] mineru: %s mode (url=%s)", mode, mineru_url or "<none>")
        _add("/mcp/mineru", _make_proxy(
            "mineru", sys.executable, [str(_MCP_DIR / "mineru_server.py")],
            env=mineru_env,
        ))
    else:
        logger.info("[MCP] mineru: neither MINERU_API_URL nor MINERU_VENV_PYTHON set — skipped")

    # Schedule ALL tool discoveries concurrently in lifespan
    # Parallel discovery cuts startup from ~40s (sequential) to ~10s (longest single)
    existing_lifespan = app.router.lifespan_context

    @contextlib.asynccontextmanager
    async def _discover_all_concurrent(a):
        async with existing_lifespan(a):
            import asyncio as _asyncio
            results = await _asyncio.gather(
                *[p._aura_discover() for p in _proxies_to_discover],
                return_exceptions=True
            )
            for p, r in zip(_proxies_to_discover, results):
                if isinstance(r, Exception):
                    logger.warning("[MCP] %s: discovery exception: %s", p.name, r)
            yield

    app.router.lifespan_context = _discover_all_concurrent
