#!/usr/bin/env python3
"""
Unit tests for the health check script.

Tests manifest, search, and stream checks against mock backends.
Run: python3 scripts/test_health_check.py
"""

import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)
HEALTH_CHECK = os.path.join(SCRIPT_DIR, "health_check.py")

# ─── Mock backend ──────────────────────────────────────────────────────────────

MOCK_TRACKS = [
    {"id": "ia_music_271159", "title": "Test Track", "artist": "Test Artist", "duration": 180},
]

MOCK_STREAM = {"url": "https://example.com/audio.mp3", "format": "mp3"}


class MockBackendHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/manifest.json":
            self._respond(200, {"id": "com.test.backend", "name": "Test", "resources": ["search", "stream"], "types": ["track"]})
        elif path.startswith("/search"):
            self._respond(200, {"tracks": MOCK_TRACKS})
        elif path.startswith("/stream/"):
            self._respond(200, MOCK_STREAM)
        elif path == "/health":
            self._respond(200, {"status": "ok"})
        else:
            self._respond(404, {"error": "not found"})

    def _respond(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # Suppress logs


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def start_mock_backend(port):
    server = http.server.HTTPServer(("127.0.0.1", port), MockBackendHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class BrokenBackendHandler(http.server.BaseHTTPRequestHandler):
    """Always returns 500."""
    def do_GET(self):
        self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"broken"}')

    def log_message(self, format, *args):
        pass


def start_broken_backend(port):
    server = http.server.HTTPServer(("127.0.0.1", port), BrokenBackendHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def run_tests():
    passed = 0
    failed = 0

    def assert_ok(name, condition, detail=""):
        nonlocal passed, failed
        if condition:
            print(f"  ✓ {name}")
            passed += 1
        else:
            print(f"  ✗ {name} {detail}")
            failed += 1

    # Start mock backends
    good_port = find_free_port()
    bad_port = find_free_port()
    good_server = start_mock_backend(good_port)
    bad_server = start_broken_backend(bad_port)
    good_url = f"http://127.0.0.1:{good_port}"
    bad_url = f"http://127.0.0.1:{bad_port}"

    # Write test backends.json
    backends_file = os.path.join(REPO_DIR, "backends.json")
    healthy_file = os.path.join(REPO_DIR, "healthy-backends.json")
    original_backends = None
    original_healthy = None

    try:
        with open(backends_file, "r") as f:
            original_backends = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        original_backends = []

    try:
        with open(healthy_file, "r") as f:
            original_healthy = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        original_healthy = []

    try:
        print("═══════════════════════════════════════════════════════════════")
        print("  Health Check Unit Tests")
        print("═══════════════════════════════════════════════════════════════")

        # ── Test 1: Manifest check on healthy backend ────────────────────────
        print("\n[1] Manifest check — healthy backend")
        with open(backends_file, "w") as f:
            json.dump([good_url], f)

        result = subprocess.run(
            [sys.executable, HEALTH_CHECK, "--mode", "manifest"],
            capture_output=True, text=True, cwd=REPO_DIR
        )
        data = json.loads(result.stdout)
        assert_ok("returns 1 total", data["total"] == 1, f"got {data.get('total')}")
        assert_ok("returns 1 healthy", data["healthy"] == 1, f"got {data.get('healthy')}")

        # ── Test 2: Search check ─────────────────────────────────────────────
        print("\n[2] Search check — healthy backend")
        result = subprocess.run(
            [sys.executable, HEALTH_CHECK, "--mode", "search"],
            capture_output=True, text=True, cwd=REPO_DIR
        )
        data = json.loads(result.stdout)
        assert_ok("returns 1 healthy", data["healthy"] == 1, f"got {data.get('healthy')}")

        # ── Test 3: Stream check ─────────────────────────────────────────────
        print("\n[3] Stream check — healthy backend")
        result = subprocess.run(
            [sys.executable, HEALTH_CHECK, "--mode", "stream"],
            capture_output=True, text=True, cwd=REPO_DIR
        )
        data = json.loads(result.stdout)
        assert_ok("returns 1 healthy", data["healthy"] == 1, f"got {data.get('healthy')}")

        # ── Test 4: Manifest check on broken backend ─────────────────────────
        print("\n[4] Manifest check — broken backend")
        with open(backends_file, "w") as f:
            json.dump([bad_url], f)

        result = subprocess.run(
            [sys.executable, HEALTH_CHECK, "--mode", "manifest"],
            capture_output=True, text=True, cwd=REPO_DIR
        )
        data = json.loads(result.stdout)
        assert_ok("returns 0 healthy", data["healthy"] == 0, f"got {data.get('healthy')}")
        assert_ok("returns 1 unhealthy", data["unhealthy"] == 1, f"got {data.get('unhealthy')}")

        # ── Test 5: Mixed backends (one good, one bad) ───────────────────────
        print("\n[5] Manifest check — mixed backends")
        with open(backends_file, "w") as f:
            json.dump([good_url, bad_url], f)

        result = subprocess.run(
            [sys.executable, HEALTH_CHECK, "--mode", "manifest"],
            capture_output=True, text=True, cwd=REPO_DIR
        )
        data = json.loads(result.stdout)
        assert_ok("returns 2 total", data["total"] == 2, f"got {data.get('total')}")
        assert_ok("returns 1 healthy", data["healthy"] == 1, f"got {data.get('healthy')}")
        assert_ok("returns 1 unhealthy", data["unhealthy"] == 1, f"got {data.get('unhealthy')}")

        # ── Test 6: Empty backends list ───────────────────────────────────────
        print("\n[6] Manifest check — empty backends")
        with open(backends_file, "w") as f:
            json.dump([], f)

        result = subprocess.run(
            [sys.executable, HEALTH_CHECK, "--mode", "manifest"],
            capture_output=True, text=True, cwd=REPO_DIR
        )
        data = json.loads(result.stdout)
        # Empty backends returns {"results": [], "message": "No backends registered"}
        assert_ok("returns empty results", len(data.get("results", [])) == 0)
        assert_ok("has no total field or total is 0", data.get("total", 0) == 0)

    finally:
        # Restore original files
        with open(backends_file, "w") as f:
            json.dump(original_backends, f, indent=2)
            f.write("\n")
        with open(healthy_file, "w") as f:
            json.dump(original_healthy, f, indent=2)
            f.write("\n")
        good_server.shutdown()
        bad_server.shutdown()

    print(f"\n═══════════════════════════════════════════════════════════════")
    print(f"  Results: {passed} passed, {failed} failed")
    print(f"═══════════════════════════════════════════════════════════════")

    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_tests()
