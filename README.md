# Aether

A personal, self-hosted chat app. No VS Code, no Docker required to chat.
Point it at any Anthropic- or OpenAI-compatible endpoint — your own API key,
a local model server, whatever — from the app's own Settings panel. Chat
history and projects are stored on disk on whichever machine runs it; other
machines (e.g. a work laptop) just open it in a browser like any other site.

Forked from the AURA project's chat engine, stripped of its VS Code
extension host, Docker dependency, and company-specific backend.

## What's here

- `frontend/` — the chat UI (static HTML/CSS/JS), served by the Node backend.
- `src/` — the Node backend: WebSocket chat server, tool/agent orchestration,
  chat + project persistence.
- `proxy/` — a small local Python process (FastAPI) that talks to whichever
  model provider you connect, translates Anthropic↔OpenAI wire formats when
  needed, and hosts the MCP tools (web search, MinerU document parsing,
  etc.). Started automatically by the Node backend — you never run it by hand.
- `docker/` — **optional**. Only the code-execution sandbox tools
  (`run_bash`/`run_python`/`run_node`) use Docker, and only if you install
  them. Everything else works with zero containers.

## Run it

```bash
./scripts/run.sh
```

First run creates a Python venv, installs the proxy's (small) dependency
list, `npm install`s and builds the Node backend, then starts the server.
Open the printed URL (default `http://127.0.0.1:8500`) in a browser.

On first load, open **Settings → Connect provider** and enter your model
provider's base URL, format (Anthropic or OpenAI-compatible), and API key.
Nothing works until a provider is connected — there is no bundled default.

If you also want document-parsing (MinerU) support and you run MinerU
yourself somewhere, put its URL in **Settings → MinerU server URL**.

## Exposing it beyond localhost

There is **no built-in authentication** — by design, this is a personal tool
and auth was intentionally left out of scope. If you bind it to anything
other than `127.0.0.1` (e.g. to reach it from a work machine), put it behind
your own VPN or tunnel (Tailscale, Cloudflare Tunnel, WireGuard, etc.) —
don't expose `AETHER_HOST=0.0.0.0` directly to the open internet.

## Config (env vars, or a `.env` file next to this README)

| Var | Default | Meaning |
|---|---|---|
| `AETHER_HOST` | `127.0.0.1` | Bind address |
| `AETHER_PORT` | auto-picked | Bind port |
| `AETHER_DATA_DIR` | `~/.aether/data` | Chats, projects, attachments, images |

MCP tool API keys (all optional — each tool self-disables without its key):
see `.env.example`.

## Optional: code-execution sandbox

```bash
cd docker && docker compose up -d sandbox        # read-only host access
cd docker && docker compose up -d sandbox-dev    # host-writable, opt-in
```

Without these, the sandbox tools just return a clear error when called —
nothing else in the app is affected.

## Status

This is a fresh extraction — expect rough edges. See the code for what's
carried over vs. dropped (VS Code sidebar, Renesas-specific auth/MCP tools,
and Docker-hosted model routing were all removed; MCP tools, sub-agent
orchestration, artifacts, and the sandbox/terminal tools were kept).
