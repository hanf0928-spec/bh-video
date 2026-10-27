#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tencent Cloud COS configuration.

Fill in the values below (or override via environment variables) so the
admin "Import from COS" feature can list objects and build playable URLs.

Reference: https://www.tencentcloud.com/zh/document/product/436/12269
"""

import os

# ---------------------------------------------------------------------------
# Required: credentials from https://console.cloud.tencent.com/cam/capi
# ---------------------------------------------------------------------------
COS_SECRET_ID = os.environ.get("COS_SECRET_ID", "")
COS_SECRET_KEY = os.environ.get("COS_SECRET_KEY", "")

# Example: "ap-guangzhou", "ap-shanghai", "ap-singapore"
COS_REGION = os.environ.get("COS_REGION", "ap-guangzhou")

# Bucket name with APPID suffix, e.g. "examplebucket-1250000000"
COS_BUCKET = os.environ.get("COS_BUCKET", "")

# Optional: custom CDN / endpoint domain. Leave empty to use the default
# "<bucket>.cos.<region>.myqcloud.com".
# Example: "https://cdn.example.com"  (NO trailing slash)
COS_PUBLIC_DOMAIN = os.environ.get("COS_PUBLIC_DOMAIN", "")

# If the bucket is private, every object URL must be signed. Set this to
# True so the server returns pre-signed URLs good for `COS_URL_TTL`
# seconds. Public-read buckets can keep it False for shorter responses.
COS_PRIVATE = os.environ.get("COS_PRIVATE", "false").lower() in ("1", "true", "yes")

# Signed-URL TTL in seconds (default 7 days).
COS_URL_TTL = int(os.environ.get("COS_URL_TTL", "604800"))

# Optional scheme override: "https" (default) or "http".
COS_SCHEME = os.environ.get("COS_SCHEME", "https")


def is_configured():
    """Return True when the minimum fields are filled in."""
    return bool(COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET and COS_REGION)


def public_endpoint():
    """Return the base URL (no trailing slash) used to build object URLs."""
    if COS_PUBLIC_DOMAIN:
        return COS_PUBLIC_DOMAIN.rstrip("/")
    return "%s://%s.cos.%s.myqcloud.com" % (COS_SCHEME, COS_BUCKET, COS_REGION)
