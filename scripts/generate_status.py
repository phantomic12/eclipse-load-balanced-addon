#!/usr/bin/env python3
"""
Generate a static status dashboard (HTML) from health check data.

Reads:
  - backends.json (all registered backends)
  - healthy-backends.json (currently healthy backends)
  - status-data/*_latest.json (latest health check results)

Writes:
  - status-data/site/index.html (static dashboard)
"""

import json
import os
import time
from datetime import datetime, timezone

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKENDS_FILE = os.path.join(REPO_DIR, "backends.json")
HEALTHY_FILE = os.path.join(REPO_DIR, "healthy-backends.json")
DATA_DIR = os.path.join(REPO_DIR, "status-data")
SITE_DIR = os.path.join(DATA_DIR, "site")


def read_json(path, default=None):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def read_latest(mode):
    path = os.path.join(DATA_DIR, f"{mode}_latest.json")
    data = read_json(path, None)
    if not isinstance(data, dict):
        return {"results": [], "timestamp": 0}
    return data


def fmt_timestamp(ts):
    if not ts:
        return "never"
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M UTC")


def fmt_reltime(ts):
    if not ts:
        return "never"
    diff = int(time.time()) - ts
    if diff < 60:
        return f"{diff}s ago"
    if diff < 3600:
        return f"{diff // 60}m ago"
    if diff < 86400:
        return f"{diff // 3600}h ago"
    return f"{diff // 86400}d ago"


def generate():
    backends = read_json(BACKENDS_FILE, [])
    healthy = read_json(HEALTHY_FILE, [])

    manifest_data = read_latest("manifest")
    search_data = read_latest("search")
    stream_data = read_latest("stream")

    # Build per-backend status
    backend_status = {}
    for url in backends:
        backend_status[url] = {
            "url": url,
            "healthy": url in healthy,
            "manifest": None,
            "search": None,
            "stream": None,
        }

    for mode_data in [manifest_data, search_data, stream_data]:
        if not isinstance(mode_data, dict):
            continue
        mode = mode_data.get("mode", "")
        for r in mode_data.get("results", []) or []:
            url = r.get("url", "")
            if url in backend_status:
                backend_status[url][mode] = r

    total = len(backends)
    up = len(healthy)
    down = total - up

    rows_html = ""
    for url in backends:
        s = backend_status[url]
        status_class = "up" if s["healthy"] else "down"
        status_icon = "✅" if s["healthy"] else "❌"

        manifest_r = s.get("manifest") or {}
        search_r = s.get("search") or {}
        stream_r = s.get("stream") or {}

        rows_html += f"""
        <tr class="{status_class}">
          <td class="status">{status_icon}</td>
          <td class="url"><a href="{url}/manifest.json">{url}</a></td>
          <td>{manifest_r.get('message', '—')}</td>
          <td>{search_r.get('message', '—')}</td>
          <td>{stream_r.get('message', '—')}</td>
          <td>{fmt_reltime(manifest_r.get('timestamp', 0))}</td>
          <td>{manifest_r.get('response_time_ms', '—')}ms</td>
        </tr>"""

    overall_class = "up" if down == 0 else ("degraded" if up > 0 else "down")
    overall_status = "All Systems Operational" if down == 0 else (f"{up}/{total} Operational" if up > 0 else "All Systems Down")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eclipse LB Addon — Status</title>
  <style>
    :root {{
      --bg: #0a0a0a;
      --card: #151515;
      --border: #2a2a2a;
      --text: #e0e0e0;
      --text-dim: #888;
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
    }}
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 2rem;
      max-width: 900px;
      margin: 0 auto;
    }}
    h1 {{ font-size: 1.5rem; margin-bottom: 0.5rem; }}
    .subtitle {{ color: var(--text-dim); font-size: 0.875rem; margin-bottom: 2rem; }}
    .overall {{
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.875rem;
      margin-bottom: 2rem;
    }}
    .overall.up {{ background: rgba(34,197,94,0.15); color: var(--green); }}
    .overall.degraded {{ background: rgba(234,179,8,0.15); color: var(--yellow); }}
    .overall.down {{ background: rgba(239,68,68,0.15); color: var(--red); }}
    table {{
      width: 100%;
      border-collapse: collapse;
      background: var(--card);
      border-radius: 8px;
      overflow: hidden;
    }}
    th {{
      text-align: left;
      padding: 0.75rem 1rem;
      background: var(--border);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
    }}
    td {{
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      font-size: 0.875rem;
    }}
    tr.up td {{ }}
    tr.down td {{ opacity: 0.7; }}
    .status {{ font-size: 1.1rem; }}
    .url a {{ color: #6cb6ff; text-decoration: none; word-break: break-all; }}
    .url a:hover {{ text-decoration: underline; }}
    .footer {{
      margin-top: 2rem;
      color: var(--text-dim);
      font-size: 0.75rem;
      text-align: center;
    }}
    .footer a {{ color: #6cb6ff; text-decoration: none; }}
  </style>
</head>
<body>
  <h1>Eclipse Load-Balanced Addon</h1>
  <p class="subtitle">Backend health monitoring — updated every 10 minutes</p>
  <div class="overall {overall_class}">{overall_status}</div>
  <table>
    <thead>
      <tr>
        <th></th>
        <th>Backend</th>
        <th>Manifest</th>
        <th>Search</th>
        <th>Stream</th>
        <th>Last Check</th>
        <th>Response</th>
      </tr>
    </thead>
    <tbody>
      {rows_html}
    </tbody>
  </table>
  <div class="footer">
    <p>Auto-generated by GitHub Actions · <a href="https://github.com/phantomic12/eclipse-load-balanced-addon">Source</a></p>
    <p>Last updated: {fmt_timestamp(int(time.time()))}</p>
  </div>
</body>
</html>
"""

    os.makedirs(SITE_DIR, exist_ok=True)
    with open(os.path.join(SITE_DIR, "index.html"), "w") as f:
        f.write(html)
    print(f"Status page generated: {SITE_DIR}/index.html")
    print(f"Backends: {total} total, {up} up, {down} down")


if __name__ == "__main__":
    generate()
