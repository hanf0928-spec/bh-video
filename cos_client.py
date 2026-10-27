#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tencent Cloud COS integration for the BH-Video admin panel.

Responsibilities
----------------
- List every object under a given COS prefix (handles pagination).
- Classify each object as video / image / other by extension.
- Sort video objects by the FIRST natural-number sequence found in the
  file name so "ep10" lands after "ep9" (not after "ep1").
- Return playable URLs — pre-signed when the bucket is private, otherwise
  a plain https://bucket.cos.region.myqcloud.com/key URL.

The heavy lifting (signing, pagination, retries) is done by the official
cos-python-sdk-v5 library. See:
https://www.tencentcloud.com/zh/document/product/436/12269
"""

import re
from urllib.parse import quote

from qcloud_cos import CosConfig, CosS3Client  # type: ignore

from cos_config import (
    COS_BUCKET,
    COS_PRIVATE,
    COS_REGION,
    COS_SCHEME,
    COS_SECRET_ID,
    COS_SECRET_KEY,
    COS_URL_TTL,
    is_configured,
    public_endpoint,
)

VIDEO_EXTS = (".mp4", ".m4v", ".mov", ".mkv", ".webm", ".ts", ".flv", ".avi")
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif")

# A natural-ordering helper. Pull every run of digits out of the file
# name so "01.mp4" sorts before "2.mp4" and "ep10" after "ep9".
_NUM_RE = re.compile(r"(\d+)")


def _natural_key(name):
    """Split a string into alternating str/int chunks for stable sort."""
    parts = _NUM_RE.split(name)
    key = []
    for chunk in parts:
        if chunk.isdigit():
            key.append((1, int(chunk)))
        else:
            key.append((0, chunk.lower()))
    return key


def _first_number(name):
    """Return the first integer found in `name`, or None."""
    m = _NUM_RE.search(name)
    return int(m.group(1)) if m else None


def _basename(key):
    """Return the file name part of an object key (last segment)."""
    return key.rsplit("/", 1)[-1]


def _build_client():
    """Instantiate a CosS3Client using the configured credentials."""
    cfg = CosConfig(
        Region=COS_REGION,
        SecretId=COS_SECRET_ID,
        SecretKey=COS_SECRET_KEY,
        Scheme=COS_SCHEME,
    )
    return CosS3Client(cfg)


def _object_url(client, key):
    """Return a publicly reachable URL for a COS object key."""
    if COS_PRIVATE:
        # Pre-signed URL for a private bucket.
        return client.get_presigned_url(
            Method="GET",
            Bucket=COS_BUCKET,
            Key=key,
            Expired=COS_URL_TTL,
        )
    # Public-read bucket: URL-encode the key but keep the "/" separators.
    return "%s/%s" % (public_endpoint(), quote(key, safe="/"))


def list_prefix(prefix):
    """
    List every object under `prefix` in the configured bucket.

    Returns a dict:
        {
          "videos": [ { "key", "name", "size", "ep", "url" }, ... ],
          "images": [ { "key", "name", "url" }, ... ],
          "others": [ "key", ... ],
        }

    Videos are already sorted by their first-number episode index
    (natural order) so callers can turn them straight into episodes.
    """
    if not is_configured():
        raise RuntimeError(
            "COS not configured — fill in cos_config.py (SecretId / "
            "SecretKey / Bucket / Region)."
        )

    client = _build_client()

    # Normalise the prefix: strip leading slashes, keep trailing slash so
    # "dramas/my_drama_01" and "dramas/my_drama_01/" behave the same.
    norm_prefix = (prefix or "").lstrip("/")
    if norm_prefix and not norm_prefix.endswith("/"):
        norm_prefix = norm_prefix + "/"

    videos = []
    images = []
    others = []

    marker = ""
    # Hard cap to avoid runaway loops on huge buckets.
    for _ in range(50):
        resp = client.list_objects(
            Bucket=COS_BUCKET,
            Prefix=norm_prefix,
            Marker=marker,
            MaxKeys=1000,
        )
        contents = resp.get("Contents") or []
        for obj in contents:
            key = obj.get("Key") or ""
            if not key or key.endswith("/"):
                continue  # skip "folder" markers
            size = int(obj.get("Size") or 0)
            name = _basename(key)
            lower = name.lower()
            if lower.endswith(VIDEO_EXTS):
                videos.append(
                    {
                        "key": key,
                        "name": name,
                        "size": size,
                        "ep": _first_number(name),
                        "url": _object_url(client, key),
                    }
                )
            elif lower.endswith(IMAGE_EXTS):
                images.append(
                    {
                        "key": key,
                        "name": name,
                        "size": size,
                        "url": _object_url(client, key),
                    }
                )
            else:
                others.append(key)

        if resp.get("IsTruncated") == "true":
            marker = resp.get("NextMarker") or ""
            if not marker:
                break
        else:
            break

    # Sort videos: by the first number in the file name (ep index), then
    # by full natural order as a tie-breaker.
    def video_sort_key(v):
        n = v["ep"]
        return (0 if n is not None else 1, n if n is not None else 0, _natural_key(v["name"]))

    videos.sort(key=video_sort_key)

    # Re-number episodes 1..N using the sorted order so callers always
    # get sensible ep numbers even if filenames are odd ("teaser.mp4"
    # with no digits mixed in).
    for idx, v in enumerate(videos, start=1):
        if v.get("ep") is None:
            v["ep"] = idx

    # Images: just natural-sort by file name so "poster.jpg" / "cover.jpg"
    # feel predictable.
    images.sort(key=lambda i: _natural_key(i["name"]))

    return {"videos": videos, "images": images, "others": others}


def build_series_from_prefix(prefix, title, series_id=None, category=None, description=None):
    """
    Compose a Series dict (matching the /api/import schema) by listing a
    COS prefix.

    Rules:
      * Every video file under the prefix becomes an episode.
      * Episodes are ordered by the first number in the file name.
      * Thumbnail = the first jpg/png/webp image file under the prefix
        (if any). Falls back to empty.

    Raises ValueError when the prefix contains no videos.
    """
    listing = list_prefix(prefix)
    videos = listing["videos"]
    images = listing["images"]
    if not videos:
        raise ValueError("prefix contains no video files")

    thumbnail = images[0]["url"] if images else ""

    # Default series id = sanitised last path segment of the prefix.
    if not series_id:
        tail = prefix.strip("/").rsplit("/", 1)[-1] or "cos_series"
        series_id = re.sub(r"[^A-Za-z0-9_\-:.]", "_", tail) or "cos_series"

    episodes = []
    for v in videos:
        ep_num = v["ep"]
        episodes.append(
            {
                "ep": ep_num,
                "title": "第%d集" % ep_num,
                "src": v["url"],
                "thumbnail": thumbnail,
            }
        )

    return {
        "id": series_id,
        "title": title or series_id,
        "category": category or "",
        "description": description or "",
        "thumbnail": thumbnail,
        "episodes": episodes,
    }
