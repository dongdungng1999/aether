#!/usr/bin/env python3
"""MCP server for the `visualise` skill (bentossell/visualise).

Two tools:
  - get_visualise_rules(diagram_type) — layout rules + output policy
  - save_visualise(content, name, format) — write file inside container,
    return a proxy URL the client (any OS, any tunnel) can fetch.

Hub-and-spoke: files live in the container at $VISUALISE_OUT_DIR and are
served by /api/visualise/<name> (see aura_proxy/visualise_endpoint.py).
This mirrors the renesas-image HTTP mode — the only cross-platform approach
that survives Windows extensions over SSH tunnels.
"""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Literal

from mcp.server.fastmcp import Context, FastMCP


mcp = FastMCP("visualise")

_SKILL_DIR = Path(__file__).parent / "visualise_skill"
_SKILL_MD = _SKILL_DIR / "SKILL.md"
_REFS = _SKILL_DIR / "references"

# Container-side output dir. Served by /api/visualise/<file>.
_OUT_DIR = Path(os.environ.get("VISUALISE_OUT_DIR", "/tmp/visualise"))

# Fallback proxy base if the request Context is missing a Host header.
PROXY_BASE_URL = os.environ.get("AURA_PROXY_INTERNAL_URL", "http://127.0.0.1:8000")
TOKEN_FILE_PATH = "/tmp/aura-visualise-token"


def _client_proxy_base(ctx: Context | None) -> str:
    """Return the base URL the calling client used to reach the proxy.
    Same trick as renesas_image._client_proxy_base — Host header wins."""
    if ctx is not None:
        try:
            req = ctx.request_context.request
            host = req.headers.get("host") if req is not None else None
            scheme = (req.url.scheme if req is not None else "http") or "http"
            if host:
                return f"{scheme}://{host}"
        except Exception:
            pass
    return PROXY_BASE_URL


def _read_token() -> str:
    try:
        return Path(TOKEN_FILE_PATH).read_text().strip()
    except OSError:
        return ""


_TEMPLATE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{title}</title><style>
/* Light-mode defaults. Dark mode via media query — works in both CLI
   browser (system preference) and VS Code extension iframe (inherits
   color-scheme:dark from the webview). */
:root{{
  --bg:#fafaf7;--bg2:#f2f0e8;--bg3:#e8e6dc;
  --fg:#1a1a1a;--fg2:#5f5e5a;--fg3:#888780;
  --border:#d0cec4;
  --link:#185FA5;
  --font-sans:system-ui,sans-serif;
  --font-mono:monospace;
  --border-radius-md:8px;--border-radius-lg:12px;--border-radius-xl:16px;
  /* Aliases matching design-system.md variable names (light values) */
  --color-background-primary:#fafaf7;
  --color-background-secondary:#f2f0e8;
  --color-background-tertiary:#e8e6dc;
  --color-background-info:#E6F1FB;
  --color-background-success:#EAF3DE;
  --color-background-warning:#FAEEDA;
  --color-background-danger:#FCEBEB;
  --color-text-primary:#1a1a1a;
  --color-text-secondary:#5f5e5a;
  --color-text-tertiary:#888780;
  --color-text-info:#0C447C;
  --color-text-success:#27500A;
  --color-text-warning:#633806;
  --color-text-danger:#791F1F;
  --color-border-primary:#888780;
  --color-border-secondary:#b4b2a9;
  --color-border-tertiary:#d0cec4;
  --color-border-info:#185FA5;
  --color-border-success:#3B6D11;
  --color-border-warning:#854F0B;
  --color-border-danger:#A32D2D;
  /* Palette light */
  --c-blue-bg:#E6F1FB;--c-blue-b:#185FA5;--c-blue-t:#0C447C;
  --c-teal-bg:#E1F5EE;--c-teal-b:#0F6E56;--c-teal-t:#085041;
  --c-purple-bg:#EEEDFE;--c-purple-b:#534AB7;--c-purple-t:#3C3489;
  --c-coral-bg:#FAECE7;--c-coral-b:#993C1D;--c-coral-t:#712B13;
  --c-pink-bg:#FBEAF0;--c-pink-b:#993556;--c-pink-t:#72243E;
  --c-amber-bg:#FAEEDA;--c-amber-b:#854F0B;--c-amber-t:#633806;
  --c-green-bg:#EAF3DE;--c-green-b:#3B6D11;--c-green-t:#27500A;
  --c-red-bg:#FCEBEB;--c-red-b:#A32D2D;--c-red-t:#791F1F;
  --c-gray-bg:#F1EFE8;--c-gray-b:#5F5E5A;--c-gray-t:#444441;
  /* Diff / code highlight */
  --diff-del:#A32D2D;--diff-add:#27500A;
  --diff-del-bg:#FCEBEB;--diff-add-bg:#EAF3DE;
}}
@media(prefers-color-scheme:dark){{
  :root{{
    --bg:#1e1e1e;--bg2:#252526;--bg3:#2d2d30;
    --fg:#d4d4d4;--fg2:#a0a0a0;--fg3:#808080;
    --border:#454545;
    --link:#6cb8ff;
    /* Aliases dark override */
    --color-background-primary:#1e1e1e;
    --color-background-secondary:#252526;
    --color-background-tertiary:#2d2d30;
    --color-background-info:#1e3a5f;
    --color-background-success:#1f3d14;
    --color-background-warning:#4d3410;
    --color-background-danger:#4a1e1e;
    --color-text-primary:#d4d4d4;
    --color-text-secondary:#a0a0a0;
    --color-text-tertiary:#808080;
    --color-text-info:#dbe9ff;
    --color-text-success:#d5efc3;
    --color-text-warning:#f8e0bd;
    --color-text-danger:#f7c9c9;
    --color-border-primary:#8a8a8a;
    --color-border-secondary:#666666;
    --color-border-tertiary:#454545;
    --color-border-info:#5aa9ff;
    --color-border-success:#7ac256;
    --color-border-warning:#e0a35d;
    --color-border-danger:#e07070;
    --c-blue-bg:#1e3a5f;--c-blue-b:#5aa9ff;--c-blue-t:#dbe9ff;
    --c-teal-bg:#0f4438;--c-teal-b:#4dd0a8;--c-teal-t:#cdf3e5;
    --c-purple-bg:#332d6b;--c-purple-b:#9d92ff;--c-purple-t:#e0dbff;
    --c-coral-bg:#4d2418;--c-coral-b:#e88860;--c-coral-t:#fad6c4;
    --c-pink-bg:#4a2033;--c-pink-b:#e08aa9;--c-pink-t:#f7d3e0;
    --c-amber-bg:#4d3410;--c-amber-b:#e0a35d;--c-amber-t:#f8e0bd;
    --c-green-bg:#1f3d14;--c-green-b:#7ac256;--c-green-t:#d5efc3;
    --c-red-bg:#4a1e1e;--c-red-b:#e07070;--c-red-t:#f7c9c9;
    --c-gray-bg:#2f2f2f;--c-gray-b:#8a8a8a;--c-gray-t:#d6d6d6;
    /* Diff / code highlight dark */
    --diff-del:#e07070;--diff-add:#7ac256;
    --diff-del-bg:#4a1e1e;--diff-add-bg:#1f3d14;
  }}
}}
*{{box-sizing:border-box;}}
html,body{{margin:0!important;padding:12px 16px!important;
  background:var(--bg)!important;color:var(--fg)!important;
  font-family:var(--font-sans)!important;font-size:13px!important;
  overflow:visible!important;height:auto!important;min-height:0!important;
  width:100%!important;}}
html::-webkit-scrollbar,body::-webkit-scrollbar{{display:none;width:0;height:0;}}
body>*{{max-width:100%!important;}}
.card{{background:var(--bg)!important;border-radius:16px;padding:24px;
  max-width:none!important;width:100%!important;margin:0!important;
  border:1px solid var(--border);}}
.t{{fill:var(--fg);font:400 14px system-ui;}}
.ts{{fill:var(--fg2);font:400 12px system-ui;}}
.th{{fill:var(--fg);font:500 14px system-ui;}}
.arr{{stroke:var(--fg2);}}
h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,figcaption,label,span,small{{color:var(--fg);}}
a{{color:var(--link);}}
svg{{max-width:100%!important;width:100%!important;height:auto;display:block;}}
/* Palette */
.c-blue rect{{fill:var(--c-blue-bg);stroke:var(--c-blue-b);}}
.c-blue .th,.c-blue .ts,.c-blue *{{fill:var(--c-blue-t);color:var(--c-blue-t);}}
.c-blue.card,.c-blue{{background:var(--c-blue-bg);border-color:var(--c-blue-b);color:var(--c-blue-t);}}
.c-teal rect{{fill:var(--c-teal-bg);stroke:var(--c-teal-b);}}
.c-teal .th,.c-teal .ts,.c-teal *{{fill:var(--c-teal-t);color:var(--c-teal-t);}}
.c-teal.card,.c-teal{{background:var(--c-teal-bg);border-color:var(--c-teal-b);color:var(--c-teal-t);}}
.c-purple rect{{fill:var(--c-purple-bg);stroke:var(--c-purple-b);}}
.c-purple .th,.c-purple .ts,.c-purple *{{fill:var(--c-purple-t);color:var(--c-purple-t);}}
.c-purple.card,.c-purple{{background:var(--c-purple-bg);border-color:var(--c-purple-b);color:var(--c-purple-t);}}
.c-coral rect{{fill:var(--c-coral-bg);stroke:var(--c-coral-b);}}
.c-coral .th,.c-coral .ts,.c-coral *{{fill:var(--c-coral-t);color:var(--c-coral-t);}}
.c-coral.card,.c-coral{{background:var(--c-coral-bg);border-color:var(--c-coral-b);color:var(--c-coral-t);}}
.c-pink rect{{fill:var(--c-pink-bg);stroke:var(--c-pink-b);}}
.c-pink .th,.c-pink .ts,.c-pink *{{fill:var(--c-pink-t);color:var(--c-pink-t);}}
.c-pink.card,.c-pink{{background:var(--c-pink-bg);border-color:var(--c-pink-b);color:var(--c-pink-t);}}
.c-amber rect{{fill:var(--c-amber-bg);stroke:var(--c-amber-b);}}
.c-amber .th,.c-amber .ts,.c-amber *{{fill:var(--c-amber-t);color:var(--c-amber-t);}}
.c-amber.card,.c-amber{{background:var(--c-amber-bg);border-color:var(--c-amber-b);color:var(--c-amber-t);}}
.c-green rect{{fill:var(--c-green-bg);stroke:var(--c-green-b);}}
.c-green .th,.c-green .ts,.c-green *{{fill:var(--c-green-t);color:var(--c-green-t);}}
.c-green.card,.c-green{{background:var(--c-green-bg);border-color:var(--c-green-b);color:var(--c-green-t);}}
.c-red rect{{fill:var(--c-red-bg);stroke:var(--c-red-b);}}
.c-red .th,.c-red .ts,.c-red *{{fill:var(--c-red-t);color:var(--c-red-t);}}
.c-red.card,.c-red{{background:var(--c-red-bg);border-color:var(--c-red-b);color:var(--c-red-t);}}
.c-gray rect{{fill:var(--c-gray-bg);stroke:var(--c-gray-b);}}
.c-gray .th,.c-gray .ts,.c-gray *{{fill:var(--c-gray-t);color:var(--c-gray-t);}}
.c-gray.card,.c-gray{{background:var(--c-gray-bg);border-color:var(--c-gray-b);color:var(--c-gray-t);}}
/* Generic containers */
.tier,.stack,.box,.panel,.section,.group,.container{{background:var(--bg2);border-color:var(--border);
  max-width:100%!important;}}
.tier h3,.stack h3,.tier h2,.section h3{{color:var(--fg);}}
p,li,td,th,dd,dt,figcaption{{overflow-wrap:break-word;word-break:break-word;}}
</style></head>
<body>
{content}
<script>(function(){{
  var last=0;
  function measure(){{
    var h=0,st=document.documentElement.scrollTop||0;
    var all=document.body?document.body.querySelectorAll('*'):[];
    for(var i=0;i<all.length;i++){{
      try{{var r=all[i].getBoundingClientRect();
        if(r.bottom>0){{var bot=r.bottom+st;if(bot>h)h=bot;}}}}catch(e){{}}
    }}
    var sh=Math.max(document.documentElement.scrollHeight||0,
                    document.body?document.body.scrollHeight||0:0);
    if(sh>h)h=sh;
    return Math.ceil(h)+16;
  }}
  function post(){{
    try{{var h=measure();
      if(h&&Math.abs(h-last)>4){{last=h;parent.postMessage({{type:'aura.visualise.resize',h:h,name:window.name}},'*');}}
    }}catch(e){{}}
  }}
  if(window.ResizeObserver){{
    new ResizeObserver(post).observe(document.documentElement);
    if(document.body)new ResizeObserver(post).observe(document.body);
  }}
  window.addEventListener('load',post);
  window.addEventListener('resize',post);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(post);
  [50,200,500,1000,2000,3000,5000].forEach(function(t){{setTimeout(post,t);}});
}})();
</script>
</body></html>
"""


_OUTPUT_POLICY = """
## OUTPUT POLICY (AURA — override skill default)

Do NOT print the SVG/HTML in your chat response. Instead:

1. Generate the full visual content INTERNALLY (SVG or HTML fragment — no
   `<html>/<head>/<body>` wrapper, the tool adds those).
2. Call the `save_visualise` tool with:
   - `content`: the SVG/HTML fragment
   - `name`: a short kebab-slug describing the visual (e.g. `cpp-memory-layout`)
   - `format`: ALWAYS `"html"` unless the user explicitly asked for a raw `.svg` file to download

   Important: if you create an SVG diagram, still pass `format="html"` and put
   the `<svg>...</svg>` fragment in `content`. Raw `format="svg"` is not themed;
   it skips the color-ramp CSS wrapper and may render with missing colors.
3. The tool returns `{"url": "...", "filename": "..."}`.
4. Reply to the user with ONE short line: `Saved: <url>` — nothing else.
   Do NOT paste the SVG/HTML, do NOT wrap in ```visualizer, do NOT explain
   the diagram unless the user explicitly asks after seeing the file.

Rationale: SVG/HTML pasted inline pollutes the terminal. The file (fetched
via the proxy URL) is the deliverable. Follow this policy strictly.
"""


# diagram_type → reference file
_MAP = {
    "flowchart":    "diagrams.md",
    "structural":   "diagrams.md",
    "illustrative": "diagrams.md",
    "component":    "components.md",
    "chart":        "charts.md",
}


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception as e:
        return f"[visualise: failed to read {p.name}: {e}]"


_SLUG_RE = re.compile(r"[^a-z0-9-]+")


def _slugify(name: str) -> str:
    s = _SLUG_RE.sub("-", (name or "").lower()).strip("-")
    return s[:60] or f"visual-{uuid.uuid4().hex[:8]}"


@mcp.tool(
    name="get_visualise_rules",
    description=(
        "Call BEFORE generating any SVG or HTML diagram, chart, or "
        "visualization. Returns layout rules AND an output policy that "
        "requires saving the visual via the `save_visualise` tool (returns a "
        "proxy URL) — do NOT paste inline. Skipping this WILL produce "
        "broken visuals AND paste-pollution. Pick diagram_type: flowchart=steps, "
        "structural=containment, illustrative=mechanism, component=interactive "
        "HTML, chart=data viz. Read the rules ONCE per conversation: if the "
        "rules for the shape you need are already in context from an earlier "
        "call, skip this tool and go straight to `save_visualise`. Re-read only "
        "if the conversation was compacted and the rules are no longer visible."
    ),
)
def get_visualise_rules(
    diagram_type: Literal[
        "flowchart", "structural", "illustrative", "component", "chart"
    ],
) -> str:
    design = _read(_REFS / "design-system.md")
    skill  = _read(_SKILL_MD)
    module = _read(_REFS / _MAP[diagram_type])
    return (
        f"# visualise skill (diagram_type={diagram_type})\n\n"
        f"{_OUTPUT_POLICY}\n\n"
        f"## SKILL.md\n\n{skill}\n\n"
        f"## references/design-system.md\n\n{design}\n\n"
        f"## references/{_MAP[diagram_type]}\n\n{module}\n"
    )


@mcp.tool(
    name="save_visualise",
    description=(
        "Save an SVG/HTML visual to the proxy's file store and return a URL "
        "the client can fetch. Call AFTER generating content following the "
        "rules from `get_visualise_rules`. For `format=html`: `content` is "
        "wrapped in a themed template (CSS vars + color ramp classes). For "
        "`format=svg`: `content` MUST start with `<svg` and is written as-is "
        "(no wrapper — inline all styles). Returns JSON: "
        "{url, filename, container_path}."
    ),
)
def save_visualise(
    content: str,
    name: str = "",
    format: Literal["html", "svg"] = "html",
    ctx: Context | None = None,
) -> str:
    import json as _json

    slug = _slugify(name)
    ext = "svg" if format == "svg" else "html"
    filename = f"{slug}-{uuid.uuid4().hex[:6]}.{ext}"

    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = _OUT_DIR / filename

    if format == "svg":
        if not content.lstrip().startswith("<svg"):
            return _json.dumps({"error": "format=svg requires content starting with <svg"})
        payload = content
    else:
        payload = _TEMPLATE.format(title=slug, content=content)

    try:
        path.write_text(payload, encoding="utf-8")
    except OSError as e:
        return _json.dumps({"error": f"write failed: {e}"})

    base = _client_proxy_base(ctx).rstrip("/")
    token = _read_token()
    url = f"{base}/api/visualise/{filename}"
    if token:
        url += f"?token={token}"

    return _json.dumps({
        "url": url,
        "filename": filename,
        "container_path": str(path),
    })


if __name__ == "__main__":
    mcp.run()
