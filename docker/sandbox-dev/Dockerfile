# Aether — Developer-Mode Code Interpreter sandbox.
#
# Same base as the normal sandbox, but this image backs the 🛡️ Developer Mode
# container which runs as root (user "0:0" in docker-compose.yml) with the
# host's $HOME + /data bind-mounted read-write, so the model can modify real
# files. Kept as a SEPARATE build context + image tag
# (official-aura-sandbox-dev-{user}) from the normal sandbox so the two can
# diverge (extra dev tooling, different lib set) without cross-contaminating.
#
# Mounts (decided by the extension at install time):
#   • /data : host /data    (rw)
#   • /home : host $HOME    (rw, and is the cwd)
#
# The LLM gets a Linux box with python + node + a small build toolchain.
# Networking is restricted to loopback only (no inbound from the internet,
# host's outbound is intentionally allowed so pip/npm work).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive \
    NODE_MAJOR=22

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash coreutils findutils grep sed gawk procps file ca-certificates \
        curl wget unzip zip tar xz-utils \
        git openssh-client \
        build-essential gcc g++ make cmake pkg-config \
        ripgrep fd-find jq tree less \
        libopenblas0 libgomp1 libffi8 \
        librsvg2-bin libcairo2 \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Curated Python stack — extending it means rebuilding the image (auditable).
COPY requirements.txt /opt/requirements.txt
RUN pip install --no-cache-dir -r /opt/requirements.txt

# Mini exec server — accepts {language, code, cwd, timeout} → stdout/stderr.
COPY server.py /opt/server.py

# Make /home and /data exist even if the host bind-mount is missing — keeps
# the image bootable for smoke tests without --mount.
RUN mkdir -p /data /home

# We DO NOT switch to a non-root user. The LLM operates as root inside the
# container so it can write anywhere under the bind-mounted /data and /home.
# Network namespace + container boundary is the security boundary.
WORKDIR /home
EXPOSE 8765

CMD ["python", "-u", "/opt/server.py"]
