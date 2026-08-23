"""Pull data for this script.

VENDORED, never `import vibefoundry`: depending on the package would drag
pyarrow, pandas, fastapi and the rest — about 320 MB — into every container a
published app runs in.

It talks to the gateway directly and signs the user in itself, so a script runs
whether or not the VibeFoundry IDE is open. Routing through the IDE meant a
script could not be re-run tomorrow, handed to a colleague, or scheduled — and
that was the whole reason for keeping the SQL in the file.

Credentials, in order:
  1. VF_GATEWAY / VF_APP_ID / VF_APP_KEY from a .env beside the project, or the
     real environment. This is a published app; it never signs anyone in.
  2. ~/.vibefoundry/orgs.json, written by any sign-in on this machine.
  3. Neither, and a browser is available: sign in, save, continue.
Headless with no .env fails in a second rather than opening a browser nobody
can see.
"""

from __future__ import annotations

import http.server
import io
import json
import os
import re
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent

CONNECT_URL = "https://vibefoundry.ai/connect"
PUBLIC_DATA_BASE_URL = "https://vibefoundry.ai/public_data"
PUBLIC_ORG = "public"
USER_AGENT = "vibefoundry-vf/1"
GATEWAY_KEYS = ("VF_GATEWAY", "VF_APP_ID", "VF_APP_KEY")
STORE = Path.home() / ".vibefoundry" / "orgs.json"
SIGN_IN_WAIT_SECONDS = 180


def _request(url, method="GET", body=None, headers=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", USER_AGENT)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read(), res.headers


def _detail(problem):
    try:
        return problem.read().decode("utf-8", "replace")[:400]
    except Exception:
        return str(problem)


def _parse_env(path):
    values = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def _from_env():
    found = {}
    for folder in [HERE, *list(HERE.parents)[:3]]:
        candidate = folder / ".env"
        if candidate.is_file():
            for k, v in _parse_env(candidate).items():
                if k in GATEWAY_KEYS and v and k not in found:
                    found[k] = v
    for k in GATEWAY_KEYS:
        if os.environ.get(k):
            found[k] = os.environ[k]
    return found if all(found.get(k) for k in GATEWAY_KEYS) else None


def _read_store():
    try:
        orgs = json.loads(STORE.read_text(encoding="utf-8")).get("orgs") or {}
    except Exception:
        return {}
    live = {}
    for key, entry in orgs.items():
        expires = entry.get("expires")
        if expires:
            try:
                if datetime.fromisoformat(expires.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                    continue
            except ValueError:
                continue
        live[key] = entry
    return live


def _write_store(entry):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    try:
        doc = json.loads(STORE.read_text(encoding="utf-8"))
    except Exception:
        doc = {}
    doc.setdefault("orgs", {})[entry["org_id"]] = entry
    STORE.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    try:
        STORE.chmod(0o600)
    except OSError:
        pass


def _from_store(org):
    entry = _read_store().get(org)
    if not entry:
        return None
    return {
        "VF_GATEWAY": entry.get("gateway", ""),
        "VF_APP_ID": entry.get("app_id", ""),
        "VF_APP_KEY": entry.get("app_key", ""),
    }


def sign_in(org):
    """Open the organization picker and wait for the credential to come back.

    The hub redirects to a loopback URL this function is listening on, so the
    credential goes browser -> this process and touches nothing else."""
    caught = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            caught.update(
                {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).items()}
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"<title>Connected</title><p>Signed in. You can close this tab.")
            done.set()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    state = secrets.token_urlsafe(32)
    callback = f"http://127.0.0.1:{server.server_port}/org/callback"
    url = f"{CONNECT_URL}?state={state}&callback={urllib.parse.quote(callback, safe='')}"
    opened = webbrowser.open(url)
    if not opened:
        print(f"Open this to sign in: {url}")
    done.wait(SIGN_IN_WAIT_SECONDS)
    server.shutdown()

    if caught.get("state") != state or not caught.get("app_key"):
        raise RuntimeError(
            f"Sign-in for '{org}' did not complete. Open {url} and finish it, then rerun."
        )
    entry = {
        "org_id": caught.get("org_id") or org,
        "org_name": caught.get("org_name") or org,
        "gateway": caught.get("gateway", ""),
        "app_id": caught.get("app_id", ""),
        "app_key": caught.get("app_key", ""),
        "email": caught.get("email", ""),
        "expires": caught.get("expires", ""),
        "connected_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    _write_store(entry)
    return {
        "VF_GATEWAY": entry["gateway"],
        "VF_APP_ID": entry["app_id"],
        "VF_APP_KEY": entry["app_key"],
    }


def _credentials(org):
    return _from_env() or _from_store(org)


def _gateway_query(config, sql, into):
    headers = {"Authorization": f"Bearer {config['VF_APP_ID']}.{config['VF_APP_KEY']}"}
    for name in ("HTTP_X_GOOG_IAP_JWT_ASSERTION", "X_GOOG_IAP_JWT_ASSERTION"):
        if os.environ.get(name):
            headers["X-VF-Viewer-Assertion"] = os.environ[name]
            break
    url = config["VF_GATEWAY"].rstrip("/") + "/v1/query"
    try:
        body, response_headers = _request(url, "POST", {"sql": sql, "format": "parquet"}, headers)
    except urllib.error.HTTPError as problem:
        if problem.code in (401, 403):
            raise PermissionError(_detail(problem)) from None
        raise RuntimeError(f"the gateway refused this query ({problem.code}): {_detail(problem)}") from None
    if not body.startswith(b"PAR1"):
        raise RuntimeError("the gateway answered, but not with a parquet")
    # A capped result is not an answer, and the gateway says so only here.
    if str(response_headers.get("X-Truncated", "")).lower() == "true":
        raise RuntimeError(
            f"the gateway truncated this at its row cap "
            f"({response_headers.get('X-Row-Count', '?')} rows). Narrow the query."
        )
    into.write_bytes(body)


def _public_query(sql, into):
    frames = {}
    for table in sorted(set(re.findall(r"(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)", sql, re.I))):
        try:
            meta = json.loads(_request(f"{PUBLIC_DATA_BASE_URL}/{table}.json")[0])
        except Exception as problem:
            raise RuntimeError(f"no public dataset named '{table}': {problem}") from None
        url = meta.get("downloadUrl") or f"{PUBLIC_DATA_BASE_URL}/{meta.get('sourceFile') or table + '.parquet'}"
        frames[table] = pl.scan_parquet(io.BytesIO(_request(url)[0]))
    if not frames:
        raise RuntimeError("the SQL names no table; a public pull needs FROM <dataset_id>")
    pl.SQLContext(frames=frames, eager=False).execute(sql).collect().write_parquet(into)


def pull(sql, into, org="pronghorn", script_name=None):
    """Run `sql` and write the result to `into`. Returns the path written."""
    into = Path(into)
    into.parent.mkdir(parents=True, exist_ok=True)

    if org == PUBLIC_ORG:
        _public_query(sql, into)
        return into

    config = _credentials(org)
    if not config:
        if not os.environ.get("DISPLAY") and os.name != "nt" and not _can_open_browser():
            raise RuntimeError(
                f"'{org}' is not connected and there is no browser here. Add an App "
                "Credential (VF_GATEWAY, VF_APP_ID, VF_APP_KEY) to a .env beside this script."
            )
        config = sign_in(org)
    try:
        _gateway_query(config, sql, into)
    except PermissionError:
        # The credential was refused — expired early, revoked, or grants changed.
        # Sign in once and retry; a second refusal is a real error.
        _gateway_query(sign_in(org), sql, into)
    return into


def _can_open_browser():
    try:
        return webbrowser.get() is not None
    except Exception:
        return False
