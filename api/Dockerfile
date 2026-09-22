# The build stage. It holds the C compiler, and the runtime stage does not.
#
# `asammdf` depends on `zstd`, and zstd 1.5.7.2 publishes no linux arm64 wheel
# for Python 3.13 (`uv.lock:1914-1922` lists macOS arm64, linux x86_64 and
# Windows only). So uv builds zstd from its sdist on an Apple Silicon Mac, and
# `python:3.13-slim` carries no gcc. The build then died with
# "error: [Errno 2] No such file or directory: 'gcc'" and the front-end
# developer could not start the stack.
#
# We cannot fix this with a version bump. zstd 1.5.7.3 is the only release with
# that wheel and PyPI yanked it as "buggy - not thread safe" on 8 Jan 2026.
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
# `cli` travels with the manifest because the project now builds a wheel for
# the `tm` console script, and the build reads that directory. The wheel lands
# in the virtual environment, so `tm` works in the shipped image too.
COPY pyproject.toml uv.lock ./
COPY cli ./cli
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
# `--group ingest` installs asammdf, numpy and quixportal. uv installs the
# `dev` group by default and no other group, so this flag is not optional.
#
# **The flag stays after the watcher left, 19 Aug 2026.** The watcher moved to
# the ingestion pipeline, and the group lost `watchdog` only. The API still
# needs the other three:
#
#   quixportal   `ingest/store.py` builds the blob client. The file download
#                and the result upload both reach it by deferred import.
#   asammdf      `ingest/fixtures.py` mints a real MF4 byte image, and
#   numpy        `ingest/blob_seed.py` writes it at each registered file's
#                `storage_ref` on a developer machine.
#
# See plans/design/INGEST-SPLIT.md.
RUN uv sync --frozen --no-dev --group ingest
# Build the `tm` wheel here, in the stage that already holds the build
# toolchain. `GET /cli/<wheel>` streams the result, so a Volvo engineer
# installs the command line from the deployment with one `pip install` line
# and no registry and no credential. The wheel ships `cli` only
# (`pyproject.toml` `[tool.hatch.build.targets.wheel]`), so it carries our own
# client code and no secret.
RUN uv build --wheel --out-dir /app/dist

# The runtime stage. It copies the finished virtual environment, so the
# compiler and its 250 MB of headers never reach the shipped image.
FROM python:3.13-slim
WORKDIR /app
COPY --from=build /app/.venv ./.venv
# The `tm` wheel, and only the wheel. `uv` and the compiler stay behind.
# `api/api/main.py` reads this directory (`CLI_WHEEL_DIR`).
COPY --from=build /app/dist ./dist
# All four packages ship in one image: the API (the default command), the
# planning mock (compose runs it from this same image), the seed (the
# run-book's commands work inside the container too — seed/fixtures.py reads
# ../mock_planning/fixture.json, so the two must travel together), and the
# ingestion watcher.
COPY api ./api
COPY mock_planning ./mock_planning
COPY seed ./seed
COPY ingest ./ingest
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
# One image, three duties: the API by default; the planning mock and the seed
# job override TM_COMMAND. Compose overrides `command:` directly; a Quix
# deployment cannot, so there the override rides this environment variable.
CMD ["sh", "-c", "exec ${TM_COMMAND:-uvicorn api.main:app --host 0.0.0.0 --port 8000}"]
