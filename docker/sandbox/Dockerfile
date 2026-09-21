# Aether — Code Interpreter sandbox.
#
# Mounts (decided by the extension at install time):
#   • /data : host /data    (read-only in normal sandbox)
#   • /home : host $HOME    (read-only in normal sandbox)
#
# The LLM gets a CPU-only Linux code interpreter with python + node + a small
# build toolchain. Use it for smoke tests, calculations, and artifact creation;
# use sandbox-dev for trusted host writes.
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

# Normal sandbox host mounts are read-only; writes are limited to container-local
# scratch/artifact paths such as /tmp/aura-artifacts. Developer Mode uses the
# separate sandbox-dev service when the user explicitly allows host writes.
WORKDIR /tmp/aura-artifacts
EXPOSE 8765

CMD ["python", "-u", "/opt/server.py"]
