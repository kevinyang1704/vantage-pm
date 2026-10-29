# Vantage collaboration service (Story 27.5, D4).
#
# Multi-stage build: compile the Rust workspace in a builder image, then ship a
# small runtime image. The service binds 0.0.0.0:$PORT (Railway injects PORT) and
# stores state under /data (a Railway volume).
#
# Note: the workspace includes `src-tauri` (the Tauri desktop crate). We build
# ONLY `-p pmapp-server`, so the Tauri crate is resolved but never compiled; its
# sources are copied so the workspace manifest stays valid.

FROM rust:1-slim-bookworm AS builder
WORKDIR /build

# rusqlite uses bundled SQLite, so a C toolchain is required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy the whole manifest set + sources the workspace needs to resolve, then
# build only the server. A failed build must fail the image (H13): `cargo build`
# is fatal; `strip` is a best-effort size reduction only (`|| true` scoped to it).
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src-tauri ./src-tauri
RUN cargo build --release -p pmapp-server \
    && (strip target/release/pmapp-server || true)

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/pmapp-server /usr/local/bin/pmapp-server

# State lives on the Railway volume (D4/D3). Railway injects PORT.
ENV PMAPP_DATA_DIR=/data
ENV PMAPP_ENV=production
# Attach a Railway-managed persistent volume at /data in the service settings.
# Railway rejects Dockerfile VOLUME instructions.
EXPOSE 8080

CMD ["pmapp-server"]
