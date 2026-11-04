# syntax=docker/dockerfile:1

FROM rust:bookworm AS builder
WORKDIR /workspace

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri ./src-tauri

RUN cargo build --release --locked -p atools-sync-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /data atools

WORKDIR /data
COPY --from=builder /workspace/target/release/atools-sync-server /usr/local/bin/atools-sync-server

ENV BIND_ADDRESS=0.0.0.0 \
    PORT=23517 \
    DATA_DIR=/data/standalone \
    RUST_LOG=info

EXPOSE 23517
VOLUME ["/data/standalone"]
USER atools

LABEL org.opencontainers.image.title="atools-sync-server" \
      org.opencontainers.image.description="Optional private ZTools-compatible document sync server for ATools" \
      org.opencontainers.image.source="https://github.com/TheLastSheep/atools" \
      org.opencontainers.image.licenses="MIT"

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/atools-sync-server"]
