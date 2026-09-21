"""Entry point: ``python -m aether_proxy``.

Imports ``proxy`` so its FastAPI app is initialised, then starts uvicorn.
"""

import uvicorn

from . import proxy as _proxy


def main() -> None:
    uvicorn.run(_proxy.app, host=_proxy.PROXY_HOST, port=_proxy.PROXY_PORT)


if __name__ == "__main__":
    main()
