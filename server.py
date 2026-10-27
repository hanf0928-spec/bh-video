#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BH Video — Tiny static server with play-count, library, ads and admin APIs.

Why this file exists
--------------------
The project is a pure static front-end, but we need to persist a handful
of counters into files inside the project folder:
  - play counts (views.json)
  - user-imported series (videos.local.json)
  - ad impression / click counts (ads_stats.json)
  - daily unique-visitor IPs (visits.json)
Browsers cannot write local files directly, so we extend Python's built-in
`http.server` with small JSON APIs that the front-end calls.

Endpoints
---------
GET  /api/stats
POST /api/stats                — bump an episode counter.
GET  /api/library
POST /api/import               — add imported series.
POST /api/ads/track            — record ad impression / click events.
POST /api/admin/login          — password-gated login, returns a token.
GET  /api/admin/overview       — aggregated dashboard payload (token req.).

Every page GET (text/html) is also treated as a "visit" and the client
IP is added to the UV set for today in visits.json.

Run
---
    python3 server.py            # binds 0.0.0.0:8765
    python3 server.py 8080       # custom port
"""

import datetime
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(ROOT_DIR, "views.json")
LIBRARY_FILE = os.path.join(ROOT_DIR, "videos.local.json")
ADS_STATS_FILE = os.path.join(ROOT_DIR, "ads_stats.json")
VISITS_FILE = os.path.join(ROOT_DIR, "visits.json")
VALID_EVENTS = ("open", "play", "ended")
EVENT_FIELD = {"open": "opens", "play": "plays", "ended": "ends"}

# Admin-dashboard credentials & session store.
# Password is intentionally hard-coded per product spec.
ADMIN_PASSWORD = "BH123456"
# token -> expires_at (unix seconds). In-memory on purpose: resetting the
# server invalidates all logins.
_admin_sessions = {}
_admin_sessions_lock = threading.Lock()
ADMIN_TOKEN_TTL = 60 * 60 * 8  # 8 hours

# Known ad slots recognised by /api/ads/track. Unknown slots are rejected.
AD_SLOTS = ("top", "bottom", "float", "preroll", "preroll_cta")
AD_EVENTS = ("impression", "click")

# Conservative limits to keep imports sane.
MAX_IMPORT_BYTES = 4 * 1024 * 1024  # 4 MiB JSON body
MAX_SERIES_PER_IMPORT = 500
MAX_EPISODES_PER_SERIES = 500
MAX_STR_LEN = 2000

# A single lock guards every read/modify/write so concurrent requests
# cannot lose updates.
_data_lock = threading.Lock()
_library_lock = threading.Lock()
_ads_lock = threading.Lock()
_visits_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Stats persistence (views.json)
# ---------------------------------------------------------------------------

def _load_stats():
    if not os.path.isfile(DATA_FILE):
        return {}
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}

def _save_stats(stats):
    tmp_path = DATA_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp_path, DATA_FILE)

def _ensure_entry(stats, video_id):
    entry = stats.get(video_id)
    if not isinstance(entry, dict):
        entry = {}
    for field in EVENT_FIELD.values():
        if not isinstance(entry.get(field), int):
            entry[field] = 0
    stats[video_id] = entry
    return entry

# ---------------------------------------------------------------------------
# Imported library persistence (videos.local.json)
# ---------------------------------------------------------------------------

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-:.]{0,127}$")


def _load_library():
    """Load videos.local.json. Returns a list of Series dicts (possibly empty)."""
    if not os.path.isfile(LIBRARY_FILE):
        return []
    try:
        with open(LIBRARY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("imported"), list):
            return data["imported"]
        return []
    except (OSError, ValueError):
        return []


def _save_library(series_list):
    tmp_path = LIBRARY_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(
            {"imported": series_list},
            f,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    os.replace(tmp_path, LIBRARY_FILE)


def _clean_str(value, max_len=MAX_STR_LEN):
    """Coerce arbitrary input to a trimmed string with a hard length cap."""
    if value is None:
        return ""
    s = str(value).strip()
    if len(s) > max_len:
        s = s[:max_len]
    return s


def _validate_series(raw):
    """
    Validate one Series dict from /api/import.

    Returns the cleaned Series dict on success, or None if invalid.
    """
    if not isinstance(raw, dict):
        return None

    series_id = _clean_str(raw.get("id"), 128)
    if not series_id or not _ID_RE.match(series_id):
        return None

    episodes_raw = raw.get("episodes")
    if not isinstance(episodes_raw, list) or not episodes_raw:
        return None

    cleaned_eps = []
    for idx, ep in enumerate(episodes_raw[:MAX_EPISODES_PER_SERIES], start=1):
        if not isinstance(ep, dict):
            continue
        src = _clean_str(ep.get("src"), 2048)
        if not src:
            continue
        try:
            ep_num = int(ep.get("ep") or idx)
        except (TypeError, ValueError):
            ep_num = idx
        if ep_num <= 0:
            ep_num = idx

        cleaned_eps.append(
            {
                "ep": ep_num,
                "title": _clean_str(ep.get("title")) or f"EP{ep_num}",
                "src": src,
                "duration": _clean_str(ep.get("duration"), 32),
                "thumbnail": _clean_str(ep.get("thumbnail"), 2048),
                "views": _clean_str(ep.get("views"), 32),
            }
        )

    if not cleaned_eps:
        return None

    cleaned_eps.sort(key=lambda e: e["ep"])

    # Tags: accept a list of short strings, keep the original order, dedupe.
    tags_raw = raw.get("tags")
    cleaned_tags = []
    if isinstance(tags_raw, list):
        seen = set()
        for t in tags_raw[:32]:  # hard cap on tag count
            tag = _clean_str(t, 64)
            if tag and tag not in seen:
                seen.add(tag)
                cleaned_tags.append(tag)

    # Category falls back to the first tag (mirrors the client-side parser),
    # so the home-page filter chips stay populated even if the user only
    # filled in `tags`.
    category = _clean_str(raw.get("category"), 64)
    if not category:
        category = cleaned_tags[0] if cleaned_tags else "Drama"

    cleaned = {
        "id": series_id,
        "title": _clean_str(raw.get("title")) or series_id,
        "author": _clean_str(raw.get("author")),
        "category": category,
        "tags": cleaned_tags,
        "description": _clean_str(raw.get("description"), 4000),
        "thumbnail": _clean_str(raw.get("thumbnail"), 2048),
        "episodes": cleaned_eps,
    }

    # Optional: keep i18n block if it looks well-formed.
    i18n = raw.get("i18n")
    if isinstance(i18n, dict):
        clean_i18n = {}
        for lang, block in i18n.items():
            if not isinstance(block, dict):
                continue
            lang_key = _clean_str(lang, 8)
            if not lang_key:
                continue
            clean_block = {}
            for k in ("title", "description", "author"):
                if k in block:
                    clean_block[k] = _clean_str(block.get(k))
            if clean_block:
                clean_i18n[lang_key] = clean_block
        if clean_i18n:
            cleaned["i18n"] = clean_i18n

    return cleaned


def _merge_series(existing, incoming):
    """Merge `incoming` into `existing` by id (incoming wins). Returns new list."""
    by_id = {s["id"]: s for s in existing if isinstance(s, dict) and s.get("id")}
    for s in incoming:
        by_id[s["id"]] = s
    return list(by_id.values())

# ---------------------------------------------------------------------------
# Ads stats persistence (ads_stats.json)
# ---------------------------------------------------------------------------

def _load_ads_stats():
    """Shape: { "<slot>": { "impressions": N, "clicks": N }, ... }"""
    if not os.path.isfile(ADS_STATS_FILE):
        return {}
    try:
        with open(ADS_STATS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}

def _save_ads_stats(stats):
    tmp_path = ADS_STATS_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp_path, ADS_STATS_FILE)

def _ensure_ad_entry(stats, slot):
    entry = stats.get(slot)
    if not isinstance(entry, dict):
        entry = {}
    for k in ("impressions", "clicks"):
        if not isinstance(entry.get(k), int):
            entry[k] = 0
    stats[slot] = entry
    return entry

# ---------------------------------------------------------------------------
# Daily unique-visitor persistence (visits.json)
# ---------------------------------------------------------------------------

def _today_str():
    """UTC+8 day string so 'daily UV' aligns with CN wall-clock."""
    now = datetime.datetime.utcnow() + datetime.timedelta(hours=8)
    return now.strftime("%Y-%m-%d")

def _load_visits():
    """Shape: { "YYYY-MM-DD": ["<ip-hash>", "<ip-hash>", ...], ... }"""
    if not os.path.isfile(VISITS_FILE):
        return {}
    try:
        with open(VISITS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}

def _save_visits(visits):
    tmp_path = VISITS_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(visits, f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp_path, VISITS_FILE)

def _hash_ip(ip):
    """Store a short hash instead of raw IP for a bit of PII hygiene."""
    if not ip:
        return ""
    return hashlib.sha1(("bhv-salt::" + ip).encode("utf-8")).hexdigest()[:16]

def _record_visit(ip):
    """Record a unique visitor for today. Returns True if newly seen."""
    if not ip:
        return False
    ip_hash = _hash_ip(ip)
    day = _today_str()
    with _visits_lock:
        visits = _load_visits()
        day_list = visits.get(day)
        if not isinstance(day_list, list):
            day_list = []
        if ip_hash in day_list:
            return False
        day_list.append(ip_hash)
        visits[day] = day_list
        _save_visits(visits)
    return True

# ---------------------------------------------------------------------------
# Admin session helpers
# ---------------------------------------------------------------------------

def _issue_admin_token():
    tok = secrets.token_urlsafe(24)
    with _admin_sessions_lock:
        _admin_sessions[tok] = time.time() + ADMIN_TOKEN_TTL
        # Opportunistically prune expired tokens so the map stays small.
        now = time.time()
        for k in [k for k, exp in _admin_sessions.items() if exp < now]:
            _admin_sessions.pop(k, None)
    return tok

def _validate_admin_token(tok):
    if not tok:
        return False
    with _admin_sessions_lock:
        exp = _admin_sessions.get(tok)
        if not exp or exp < time.time():
            _admin_sessions.pop(tok, None)
            return False
        return True


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class BHVideoHandler(SimpleHTTPRequestHandler):
    """Static file server with extra /api/* endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    # ---- API helpers ------------------------------------------------------
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status, message):
        self._send_json(status, {"ok": False, "error": message})

    def _read_json_body(self, max_bytes):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > max_bytes:
            return None, "empty or oversized body"
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8")), None
        except (ValueError, UnicodeDecodeError):
            return None, "invalid JSON body"

    def _client_ip(self):
        """Best-effort client IP that honours a single reverse-proxy hop."""
        fwd = self.headers.get("X-Forwarded-For") or ""
        if fwd:
            # X-Forwarded-For: client, proxy1, proxy2 — take the first.
            return fwd.split(",")[0].strip()
        try:
            return self.client_address[0]
        except Exception:
            return ""

    def _bearer_token(self):
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return ""

    # ---- Routing ----------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/stats":
            with _data_lock:
                stats = _load_stats()
            self._send_json(HTTPStatus.OK, stats)
            return
        if path == "/api/library":
            with _library_lock:
                imported = _load_library()
            self._send_json(HTTPStatus.OK, {"imported": imported})
            return
        if path == "/api/admin/overview":
            return self._handle_admin_overview()

        # Any navigation to a .html page (or "/") counts as a visit for
        # today's UV ledger. Note: static assets like .js/.css/.png are
        # ignored so a single page view counts once.
        if self._looks_like_page(path):
            try:
                _record_visit(self._client_ip())
            except Exception:
                pass

        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/stats":
            return self._handle_stats_post()
        if path == "/api/import":
            return self._handle_import_post()
        if path == "/api/ads/track":
            return self._handle_ads_track()
        if path == "/api/admin/login":
            return self._handle_admin_login()
        self._send_error_json(HTTPStatus.NOT_FOUND, "unknown endpoint")

    @staticmethod
    def _looks_like_page(path):
        """True for '/', '/foo.html', '/foo/' — things a human loads in a tab."""
        if not path or path == "/":
            return True
        # Any extension other than .html → static asset, skip.
        if "." in os.path.basename(path):
            return path.endswith(".html")
        # Directory-style URL.
        return path.endswith("/")

    # ---- /api/stats POST --------------------------------------------------
    def _handle_stats_post(self):
        payload, err = self._read_json_body(4096)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return

        video_id = (payload.get("id") or "").strip()
        event = (payload.get("event") or "").strip()
        if not video_id or len(video_id) > 256:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "missing or invalid 'id'")
            return
        if event not in VALID_EVENTS:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "'event' must be one of: " + ", ".join(VALID_EVENTS),
            )
            return

        field = EVENT_FIELD[event]
        with _data_lock:
            stats = _load_stats()
            entry = _ensure_entry(stats, video_id)
            entry[field] = int(entry.get(field, 0)) + 1
            _save_stats(stats)
            updated = dict(entry)

        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "id": video_id, "stats": updated},
        )

    # ---- /api/import POST -------------------------------------------------
    def _handle_import_post(self):
        payload, err = self._read_json_body(MAX_IMPORT_BYTES)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return
        if not isinstance(payload, dict):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "expected JSON object")
            return

        raw_list = payload.get("series")
        if not isinstance(raw_list, list) or not raw_list:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST, "'series' must be a non-empty array"
            )
            return
        if len(raw_list) > MAX_SERIES_PER_IMPORT:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "too many series (max %d)" % MAX_SERIES_PER_IMPORT,
            )
            return

        cleaned = []
        for raw in raw_list:
            s = _validate_series(raw)
            if s is not None:
                cleaned.append(s)

        if not cleaned:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "no valid series found (each series needs an 'id' and at least one episode with 'src')",
            )
            return

        with _library_lock:
            existing = _load_library()
            merged = _merge_series(existing, cleaned)
            _save_library(merged)

        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "added": len(cleaned), "imported": merged},
        )

    # ---- /api/ads/track POST ---------------------------------------------
    def _handle_ads_track(self):
        payload, err = self._read_json_body(1024)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return
        if not isinstance(payload, dict):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "expected JSON object")
            return

        slot = (payload.get("slot") or "").strip()
        event = (payload.get("event") or "").strip()
        if slot not in AD_SLOTS:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "'slot' must be one of: " + ", ".join(AD_SLOTS),
            )
            return
        if event not in AD_EVENTS:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "'event' must be one of: " + ", ".join(AD_EVENTS),
            )
            return

        field = "impressions" if event == "impression" else "clicks"
        with _ads_lock:
            stats = _load_ads_stats()
            entry = _ensure_ad_entry(stats, slot)
            entry[field] = int(entry.get(field, 0)) + 1
            _save_ads_stats(stats)
            updated = dict(entry)
        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "slot": slot, "stats": updated},
        )

    # ---- /api/admin/login POST -------------------------------------------
    def _handle_admin_login(self):
        payload, err = self._read_json_body(512)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return
        if not isinstance(payload, dict):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "expected JSON object")
            return
        password = str(payload.get("password") or "")
        # Constant-time compare to avoid trivial timing leaks.
        if not secrets.compare_digest(password, ADMIN_PASSWORD):
            self._send_error_json(HTTPStatus.UNAUTHORIZED, "invalid password")
            return
        token = _issue_admin_token()
        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "token": token, "ttl": ADMIN_TOKEN_TTL},
        )

    # ---- /api/admin/overview GET -----------------------------------------
    def _handle_admin_overview(self):
        # Token may come via Authorization header or ?token= query param.
        token = self._bearer_token()
        if not token:
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            for part in qs.split("&"):
                if part.startswith("token="):
                    token = part[6:]
                    break
        if not _validate_admin_token(token):
            self._send_error_json(HTTPStatus.UNAUTHORIZED, "unauthorized")
            return

        with _data_lock:
            play_stats = _load_stats()
        with _ads_lock:
            ads_stats = _load_ads_stats()
        with _visits_lock:
            visits = _load_visits()

        # Normalise ad stats so every known slot is reported, even if the
        # file has never seen that slot before.
        ads_payload = {}
        for slot in AD_SLOTS:
            entry = ads_stats.get(slot) or {}
            imp = int(entry.get("impressions") or 0)
            clk = int(entry.get("clicks") or 0)
            ctr = round(clk / imp * 100, 2) if imp > 0 else 0.0
            ads_payload[slot] = {
                "impressions": imp,
                "clicks": clk,
                "ctr": ctr,
            }

        # Daily UV time series: last 30 days (including today) sorted asc.
        today = datetime.datetime.utcnow() + datetime.timedelta(hours=8)
        series = []
        total_uv = 0
        for i in range(29, -1, -1):
            d = (today - datetime.timedelta(days=i)).strftime("%Y-%m-%d")
            n = len(visits.get(d) or [])
            series.append({"date": d, "uv": n})
            total_uv += n

        today_key = today.strftime("%Y-%m-%d")
        today_uv = len(visits.get(today_key) or [])

        # Overall totals so the dashboard can show headline numbers.
        total_opens = sum(int(e.get("opens") or 0) for e in play_stats.values() if isinstance(e, dict))
        total_plays = sum(int(e.get("plays") or 0) for e in play_stats.values() if isinstance(e, dict))
        total_ends = sum(int(e.get("ends") or 0) for e in play_stats.values() if isinstance(e, dict))
        total_imp = sum(v["impressions"] for v in ads_payload.values())
        total_clk = sum(v["clicks"] for v in ads_payload.values())

        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "generated_at": today.strftime("%Y-%m-%d %H:%M:%S"),
                "videos": {
                    "episodes": play_stats,
                    "totals": {
                        "opens": total_opens,
                        "plays": total_plays,
                        "ends": total_ends,
                    },
                },
                "ads": {
                    "slots": ads_payload,
                    "totals": {
                        "impressions": total_imp,
                        "clicks": total_clk,
                        "ctr": round(total_clk / total_imp * 100, 2) if total_imp > 0 else 0.0,
                    },
                },
                "visits": {
                    "today": today_uv,
                    "last_30_days": series,
                    "total_30d": total_uv,
                },
            },
        )

    # Keep the default logging tidy.
    def log_message(self, fmt, *args):
        sys.stderr.write("[bh-video] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = 8765
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("Invalid port:", sys.argv[1], file=sys.stderr)
            sys.exit(2)

    bind = "0.0.0.0"
    server = ThreadingHTTPServer((bind, port), BHVideoHandler)
    print("BH-video server running at http://%s:%d/" % (bind, port))
    print("Stats file:    %s" % DATA_FILE)
    print("Library file:  %s" % LIBRARY_FILE)
    print("Ads stats:     %s" % ADS_STATS_FILE)
    print("Visits file:   %s" % VISITS_FILE)
    print("Admin page:    http://%s:%d/admin.html  (password: %s)" % (bind, port, ADMIN_PASSWORD))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
