#!/usr/bin/env python3
"""
Shared health check script for Eclipse load-balanced addon backends.

Usage:
  python3 scripts/health_check.py --mode manifest
  python3 scripts/health_check.py --mode search
  python3 scripts/health_check.py --mode stream

Reads backends.json from the repo, checks each backend, updates healthy-backends.json.
Outputs results as JSON for GHA workflow consumption.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKENDS_FILE = os.path.join(REPO_DIR, "backends.json")
HEALTHY_FILE = os.path.join(REPO_DIR, "healthy-backends.json")

# Stable Internet Archive track ID for stream check
# IA identifier: 271159 (Thai Buddhist chanting, has MP3 + OGG)
IA_TRACK_ID = "ia_music_271159"

# Search query for search check
SEARCH_QUERY = "music"

# Timeout for health checks (seconds)
TIMEOUT = 10

# Results history for status page
RESULTS_DIR = os.path.join(REPO_DIR, "status-data")


def read_backends():
    with open(BACKENDS_FILE, "r") as f:
        return json.load(f)


def read_healthy():
    try:
        with open(HEALTHY_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def write_healthy(backends):
    with open(HEALTHY_FILE, "w") as f:
        json.dump(backends, f, indent=2)
        f.write("\n")


def fetch_json(url, timeout=TIMEOUT):
    """Fetch URL and return parsed JSON. Returns dict with _error on failure."""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "EclipseLB-HealthCheck/1.0",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if not isinstance(data, dict):
                return {"_error": f"expected JSON object, got {type(data).__name__}"}
            return data
    except Exception as e:
        return {"_error": str(e)}


def check_manifest(url):
    """Check if /manifest.json returns 200 + valid JSON with id field."""
    base = url.rstrip("/")
    data = fetch_json(f"{base}/manifest.json")
    if "_error" in data:
        return False, f"manifest fetch failed: {data['_error']}"
    if not isinstance(data, dict) or "id" not in data:
        return False, "manifest missing 'id' field"
    return True, "ok"


def check_search(url):
    """Check if /search?q=music returns non-empty tracks array."""
    base = url.rstrip("/")
    data = fetch_json(f"{base}/search?q={SEARCH_QUERY}")
    if "_error" in data:
        return False, f"search fetch failed: {data['_error']}"
    tracks = data.get("tracks", [])
    if not isinstance(tracks, list) or len(tracks) == 0:
        return False, f"search returned {len(tracks)} tracks"
    return True, f"{len(tracks)} tracks"


def check_stream(url):
    """Check if /stream/{id} returns JSON with non-empty url field."""
    base = url.rstrip("/")
    data = fetch_json(f"{base}/stream/{IA_TRACK_ID}")
    if "_error" in data:
        return False, f"stream fetch failed: {data['_error']}"
    stream_url = data.get("url") or data.get("streamURL") or data.get("stream_url")
    if not stream_url:
        return False, "stream response missing 'url' field"
    return True, f"stream url present"


def check_search_then_stream(url):
    """Search for 'music', take first IA track, resolve its stream."""
    base = url.rstrip("/")
    search_data = fetch_json(f"{base}/search?q={SEARCH_QUERY}")
    if "_error" in search_data:
        return False, f"search failed: {search_data['_error']}"
    tracks = search_data.get("tracks", [])
    # Find first IA track
    ia_track = None
    for t in tracks:
        tid = str(t.get("id", ""))
        if tid.startswith("ia_music_") or tid.startswith("ia_book_"):
            ia_track = t
            break
    if not ia_track:
        return False, "no IA tracks in search results"
    track_id = ia_track["id"]
    stream_data = fetch_json(f"{base}/stream/{urllib.parse.quote(track_id)}")
    if "_error" in stream_data:
        return False, f"stream failed: {stream_data['_error']}"
    stream_url = stream_data.get("url") or stream_data.get("streamURL")
    if not stream_url:
        return False, "stream response missing 'url' field"
    return True, f"resolved stream for {track_id}"


def run_check(mode, url):
    """Run a single check. Returns (ok, message)."""
    if mode == "manifest":
        return check_manifest(url)
    elif mode == "search":
        return check_search(url)
    elif mode == "stream":
        # Stream check: hardcoded ID + search-then-stream
        ok1, msg1 = check_stream(url)
        ok2, msg2 = check_search_then_stream(url)
        overall_ok = ok1 or ok2  # If either passes, backend is functional
        combined = f"hardcoded: {msg1} | search-then-stream: {msg2}"
        return overall_ok, combined
    else:
        return False, f"unknown mode: {mode}"


def save_results(results, mode):
    """Save results to status-data/ for the dashboard."""
    os.makedirs(RESULTS_DIR, exist_ok=True)
    timestamp = int(time.time())
    result_file = os.path.join(RESULTS_DIR, f"{mode}_{timestamp}.json")
    with open(result_file, "w") as f:
        json.dump({"timestamp": timestamp, "mode": mode, "results": results}, f, indent=2)

    # Also write latest.json (overwrite)
    latest_file = os.path.join(RESULTS_DIR, f"{mode}_latest.json")
    with open(latest_file, "w") as f:
        json.dump({"timestamp": timestamp, "mode": mode, "results": results}, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Health check for Eclipse backends")
    parser.add_argument("--mode", required=True, choices=["manifest", "search", "stream"],
                        help="Check mode: manifest, search, or stream")
    args = parser.parse_args()

    backends = read_backends()
    if not backends:
        print(json.dumps({"mode": args.mode, "results": [], "message": "No backends registered"}))
        return

    results = []
    healthy = []

    for url in backends:
        start = time.time()
        ok, message = run_check(args.mode, url)
        elapsed = round(time.time() - start, 2)

        result = {
            "url": url,
            "healthy": ok,
            "mode": args.mode,
            "message": message,
            "response_time_ms": int(elapsed * 1000),
            "timestamp": int(time.time()),
        }
        results.append(result)

        status = "✓" if ok else "✗"
        print(f"{status} {url} [{args.mode}] {message} ({elapsed}s)", file=sys.stderr)

        if ok:
            healthy.append(url)

    # Merge with existing healthy backends
    existing_healthy = read_healthy()
    if args.mode == "manifest":
        # Manifest check: replace healthy list entirely
        # (manifest is the primary health gate)
        # But keep backends that passed search/stream checks even if manifest failed
        # Actually: manifest is the gate. If manifest fails, backend is down.
        write_healthy(healthy)
    else:
        # Search/stream checks: intersect with existing healthy list
        # (only keep backends that pass BOTH manifest AND this check)
        merged = [u for u in existing_healthy if u in healthy]
        write_healthy(merged)

    save_results(results, args.mode)

    # Output JSON summary for GHA
    summary = {
        "mode": args.mode,
        "total": len(backends),
        "healthy": len(healthy),
        "unhealthy": len(backends) - len(healthy),
        "results": results,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
