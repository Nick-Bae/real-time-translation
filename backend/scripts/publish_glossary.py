#!/usr/bin/env python3
"""
Upload the KO-EN glossary CSV to Cloud Storage and recreate the
Google Translate v3 glossary so fallback translations respect church-specific terms.

Usage:
    python backend/scripts/publish_glossary.py \
        --csv backend/resources/glossary-ko-en.csv \
        --glossary-id worship-ko-en

Environment variables (loaded from backend/.env):
    GCP_PROJECT (required)
    GCP_LOCATION (default: us-central1)
    GLOSSARY_BUCKET (required)  # Cloud Storage bucket name

Requires google-cloud-storage and google-cloud-translate.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from google.api_core.exceptions import AlreadyExists, NotFound
from google.cloud import storage
from google.cloud import translate_v3 as translate


REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = REPO_ROOT / "backend" / ".env"

# Load backend/.env so scripts behave like the running app.
load_dotenv(dotenv_path=ENV_PATH, override=True)


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish KO→EN glossary to Google Translate")
    parser.add_argument(
        "--csv",
        default=str(REPO_ROOT / "backend" / "resources" / "glossary-ko-en.csv"),
        help="Path to the local CSV file (default: backend/resources/glossary-ko-en.csv)",
    )
    parser.add_argument(
        "--glossary-id",
        default=os.getenv("GOOGLE_TRANSLATE_GLOSSARY_ID", "worship-ko-en"),
        help="Glossary ID to create. Defaults to GOOGLE_TRANSLATE_GLOSSARY_ID or 'worship-ko-en'.",
    )
    parser.add_argument(
        "--object",
        default=None,
        help="Optional Cloud Storage object name. Defaults to glossaries/<glossary-id>-<timestamp>.csv",
    )
    return parser.parse_args()


def upload_to_gcs(bucket_name: str, local_path: Path, object_name: str) -> str:
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(object_name)
    blob.upload_from_filename(str(local_path))
    return f"gs://{bucket_name}/{object_name}"


def recreate_glossary(
    client: translate.TranslationServiceClient,
    parent: str,
    glossary_id: str,
    input_uri: str,
) -> translate.Glossary:
    name = f"{parent}/glossaries/{glossary_id}"
    # Delete existing glossary if present (API has no update call).
    try:
        delete_op = client.delete_glossary(name=name)
        delete_op.result(timeout=300)
        print(f"[glossary] Deleted existing glossary: {name}")
    except NotFound:
        pass

    glossary = translate.Glossary(
        language_pair=translate.Glossary.LanguagePair(
            source_language_code="ko",
            target_language_code="en",
        ),
        input_config=translate.GlossaryInputConfig(
            gcs_source=translate.GcsSource(input_uri=input_uri)
        ),
        name=name,
    )

    create_op = client.create_glossary(
        parent=parent,
        glossary=glossary,
        glossary_id=glossary_id,
    )
    try:
        result = create_op.result(timeout=600)
    except AlreadyExists:
        # Edge case: glossary recreated between delete and create – retry once.
        print("[glossary] Glossary already existed after delete; retrying create.")
        recreate_glossary(client, parent, glossary_id, input_uri)
        return client.get_glossary(name=name)

    return result


def main() -> None:
    args = parse_args()
    csv_path = Path(args.csv).expanduser().resolve()
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    glossary_id = args.glossary_id
    project = _require_env("GCP_PROJECT")
    location = os.getenv("GCP_LOCATION", "us-central1")
    bucket_name = _require_env("GLOSSARY_BUCKET")

    object_name = args.object
    if not object_name:
        timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        object_name = f"glossaries/{glossary_id}-{timestamp}.csv"

    print(f"[upload] Uploading {csv_path} to gs://{bucket_name}/{object_name}")
    input_uri = upload_to_gcs(bucket_name, csv_path, object_name)

    parent = f"projects/{project}/locations/{location}"
    client = translate.TranslationServiceClient()

    print(f"[glossary] Re-creating glossary '{glossary_id}' in {parent}")
    glossary = recreate_glossary(client, parent, glossary_id, input_uri)

    print(f"[done] Glossary ready: {glossary.name}")
    print(f"       Entries: {getattr(glossary, 'entry_count', 'unknown')} (source: {input_uri})")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)
