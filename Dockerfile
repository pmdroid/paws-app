# Hosted Paws. Local mode stays `bun run paws` on the developer machine.
# Closeout is the 0.1.0 reference runner (Cargo package version).
# Agents authenticate with ANTHROPIC_API_KEY / OPENAI_API_KEY or a model-proxy base URL.
# The image does not bake credentials. The process runs as the non-root `bun` user.

FROM rust:1.90.0-bookworm AS closeout
ARG CLOSEOUT_REV=baac33e8715aac9d646796035ecc9ba7aaee02ef
RUN cargo install --locked --git https://github.com/pmdroid/closeout --rev "${CLOSEOUT_REV}" --bin closeout

FROM oven/bun:1.4.2
ARG NODE_VERSION=22.23.3
ARG CLAUDE_AGENT_ACP_VERSION=0.88.0
ARG CODEX_ACP_VERSION=2.1.1
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_CLI_VERSION=0.162.1
ARG TARGETARCH

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
  && rm -rf /var/lib/apt/lists/*

# The published CLIs use a node shebang. Bun stays the process runtime.
RUN case "${TARGETARCH}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported architecture ${TARGETARCH}" && exit 1 ;; \
    esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
  && node --version \
  && npm --version

COPY --from=closeout /usr/local/cargo/bin/closeout /usr/local/bin/closeout

RUN npm install -g \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" \
      "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_CLI_VERSION}" \
  && npm cache clean --force \
  && command -v claude-agent-acp \
  && command -v codex-acp \
  && command -v claude \
  && command -v codex \
  && command -v closeout \
  && command -v git

WORKDIR /opt/paws
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

RUN mkdir -p /data \
  && chown bun:bun /data

ENV PAWS_MODE=hosted \
    PAWS_HOME=/data \
    HOME=/home/bun

USER bun
EXPOSE 8080
ENTRYPOINT ["bun", "run", "paws"]
