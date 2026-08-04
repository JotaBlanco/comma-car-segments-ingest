import logging
import os
import sys
import time

from huggingface_hub import hf_hub_download, list_repo_files
from quixportal import get_filesystem

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("hf-comma-dataset-mirror")

MAX_ATTEMPTS = 3
BACKOFF_SECONDS = 2
PROGRESS_LOG_EVERY = 1


def str_to_bool(value):
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def build_dest_key(dest_prefix, relative_path):
    """Mirror the exact HF relative path under the configured destination prefix."""
    prefix = dest_prefix or ""
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return prefix + relative_path


def download_file_with_retry(repo_id, repo_type, relative_path, token, attempts=MAX_ATTEMPTS):
    """Download a single file from HF hub, retrying on transient errors."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return hf_hub_download(
                repo_id=repo_id,
                filename=relative_path,
                repo_type=repo_type,
                token=token,
            )
        except Exception as exc:  # noqa: BLE001 - retry on any transient error
            last_error = exc
            logger.warning(
                "Download attempt %d/%d failed for %s: %s",
                attempt,
                attempts,
                relative_path,
                exc,
            )
            if attempt < attempts:
                time.sleep(BACKOFF_SECONDS * attempt)
    raise last_error


def upload_file_with_retry(fs, local_path, dest_key, attempts=MAX_ATTEMPTS):
    """Upload a single local file to blob storage, retrying on transient errors."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            fs.put(local_path, dest_key)
            return
        except Exception as exc:  # noqa: BLE001 - retry on any transient error
            last_error = exc
            logger.warning(
                "Upload attempt %d/%d failed for %s: %s",
                attempt,
                attempts,
                dest_key,
                exc,
            )
            if attempt < attempts:
                time.sleep(BACKOFF_SECONDS * attempt)
    raise last_error


def mirror_file(fs, repo_id, repo_type, relative_path, dest_prefix, skip_existing, token):
    """Mirror a single HF file to blob storage. Returns (status, dest_key, size_bytes)."""
    dest_key = build_dest_key(dest_prefix, relative_path)

    if skip_existing and fs.exists(dest_key):
        logger.info("skip: %s (already exists at %s)", relative_path, dest_key)
        return "skipped", dest_key, 0

    local_path = None
    try:
        local_path = download_file_with_retry(repo_id, repo_type, relative_path, token)
        size_bytes = os.path.getsize(local_path)
        upload_file_with_retry(fs, local_path, dest_key)
        return "uploaded", dest_key, size_bytes
    finally:
        if local_path and os.path.exists(local_path):
            os.remove(local_path)


def run():
    repo_id = os.environ["HF_DATASET_REPO_ID"]
    repo_type = os.environ["HF_REPO_TYPE"]
    dest_prefix = os.environ.get("BLOB_DEST_PREFIX", "")
    skip_existing = str_to_bool(os.environ.get("SKIP_EXISTING", "true"))
    token = os.environ.get("HF_TOKEN") or None

    logger.info(
        "Starting mirror of %s (repo_type=%s) -> blob prefix '%s' (skip_existing=%s)",
        repo_id,
        repo_type,
        dest_prefix,
        skip_existing,
    )

    fs = get_filesystem()

    files = list_repo_files(repo_id, repo_type=repo_type, token=token)
    total = len(files)
    logger.info("Found %d files in HF repo %s", total, repo_id)

    uploaded = []
    skipped = []
    failed = []
    running_bytes = 0

    for index, relative_path in enumerate(files, start=1):
        try:
            status, dest_key, size_bytes = mirror_file(
                fs, repo_id, repo_type, relative_path, dest_prefix, skip_existing, token
            )
            if status == "uploaded":
                uploaded.append(relative_path)
                running_bytes += size_bytes
            else:
                skipped.append(relative_path)

            if index % PROGRESS_LOG_EVERY == 0:
                logger.info(
                    "[%d/%d] %s %s (size=%d bytes, running_total=%d bytes)",
                    index,
                    total,
                    status,
                    relative_path,
                    size_bytes,
                    running_bytes,
                )
        except Exception as exc:  # noqa: BLE001 - continue mirroring remaining files
            logger.error("[%d/%d] failed: %s (%s)", index, total, relative_path, exc)
            failed.append(relative_path)

    logger.info(
        "Mirror complete. total=%d uploaded=%d skipped=%d failed=%d",
        total,
        len(uploaded),
        len(skipped),
        len(failed),
    )
    if failed:
        logger.info("Failed files: %s", failed)

    return {
        "total": total,
        "uploaded": uploaded,
        "skipped": skipped,
        "failed": failed,
    }


if __name__ == "__main__":
    run()
    sys.exit(0)
