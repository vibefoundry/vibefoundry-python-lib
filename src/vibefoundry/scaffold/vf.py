# The one file every VibeFoundry script and published app pulls data with.
#
# It is VENDORED — copied in, never `import vibefoundry`. Depending on the
# package drags ~320 MB into every deployed container (pyarrow 131, polars 115,
# pandas 69, plus fastapi/uvicorn/watchdog/openpyxl) for the sake of one HTTP
# call. Same reason there is no httpx and no requests here: urllib.request is
# stdlib, and polars is already present wherever this file runs.
"""Pull a cut of data into a parquet, whoever is running the script.

    from vf import pull
    pull(sql="SELECT ...", into=Path("raw_pulls/accounts.parquet"))

Three credential paths, tried in this order:

1. VF_GATEWAY / VF_APP_ID / VF_APP_KEY from a .env beside the script or from
   the real environment — the deployed path, straight to the gateway.
2. A running VibeFoundry backend — the development path. The backend owns the
   credential, its expiry and the sign-in, so this file holds no secret.
3. Neither — raise at once, naming both remedies. Never open a browser here.
"""
from __future__ import annotations

import io
import json
import os
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path

import polars as pl

PUBLIC_ORG = "public"
# The public datasets are static parquet on vibefoundry.ai — no credential,
# no query server. A deployed app reaches them by downloading the file once
# and running the SQL locally, which is what the IDE backend does too.
PUBLIC_DATA_BASE_URL = "https://vibefoundry.ai/public_data"
USER_AGENT = "vibefoundry-vf/1"
GATEWAY_KEYS = ("VF_GATEWAY", "VF_APP_ID", "VF_APP_KEY")

# Mirrors the library's find_available_port(start_port=8765, max_attempts=100):
# a backend can be listening anywhere in that band, whoever launched it.
BACKEND_PORTS = range(8765, 8865)

# How long to wait for a person to finish signing in after the backend opened
# the browser. A headless run never gets here: it has no backend to ask.
REAUTH_WAIT_SECONDS = 120
REAUTH_POLL_SECONDS = 2

HERE = Path(__file__).resolve().parent


def _parse_env(path: Path) -> dict:
    values = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def _credentials():
    """The gateway bundle from the nearest .env, or from the real environment,
    which wins. A blank value counts as absent: /api/build writes a .env with
    all three keys empty, and that file must not shadow a filled one further up."""
    values: dict = {}
    # Walk up only as far as the project root. app_folder/scripts/{name}/vf.py
    # sits three levels below it, and one more step would read a .env that
    # belongs to a different project entirely.
    for folder in [HERE, *list(HERE.parents)[:3]]:
        candidate = folder / ".env"
        if not candidate.is_file():
            continue
        for key, value in _parse_env(candidate).items():
            if key in GATEWAY_KEYS and value and key not in values:
                values[key] = value
    for key in GATEWAY_KEYS:
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values if all(values.get(key) for key in GATEWAY_KEYS) else None


def _viewer_headers() -> dict:
    """Forward an incoming viewer's IAP assertion to the gateway. It ignores
    unknown headers today, so this changes nothing — and when row-level
    security lands it turns on without redeploying a single app."""
    for name in ("HTTP_X_GOOG_IAP_JWT_ASSERTION", "X_GOOG_IAP_JWT_ASSERTION"):
        value = os.environ.get(name)
        if value:
            return {"X-VF-Viewer-Assertion": value}
    return {}


def _request(url: str, method: str = "GET", body=None, headers=None, timeout: float = 180) -> bytes:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    # R2 (where the public datasets live) refuses urllib's default User-Agent
    # with a 403; any ordinary one is accepted.
    request.add_header("User-Agent", USER_AGENT)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _request_with_headers(url: str, method: str, body, headers, timeout: float = 180):
    """Like _request, but also hands back the response headers. The gateway
    reports a capped parquet only through X-Truncated, and a puller that
    cannot see that header writes a partial result as if it were the whole."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("User-Agent", USER_AGENT)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        # Keep the HTTPMessage rather than dict()-ing it: the server may send
        # header names lowercased, and HTTPMessage.get() is case-insensitive
        # where a plain dict is not. That difference is a silently-ignored cap.
        return response.read(), response.headers


def _http_detail(problem: urllib.error.HTTPError) -> str:
    """The server's own message, trimmed. Read from the error body, because
    urllib's str() is only ever the status line."""
    try:
        body = problem.read().decode("utf-8", "replace")
    except Exception:
        return str(problem)
    try:
        return str(json.loads(body).get("detail") or body)[:500]
    except Exception:
        return body[:500]


def _gateway_pull(config: dict, sql: str, into: Path) -> None:
    """Ask the gateway for parquet and write the bytes out — no local
    re-encoding, so the deployed file is exactly what the gateway produced."""
    headers = {"Authorization": f"Bearer {config['VF_APP_ID']}.{config['VF_APP_KEY']}"}
    headers.update(_viewer_headers())
    url = config["VF_GATEWAY"].rstrip("/") + "/v1/query"
    try:
        body, response_headers = _request_with_headers(
            url, "POST", {"sql": sql, "format": "parquet"}, headers
        )
    except urllib.error.HTTPError as problem:
        raise RuntimeError(
            f"the gateway refused this query ({problem.code}): {_http_detail(problem)}"
        ) from None
    except Exception as problem:
        raise RuntimeError(f"could not reach the gateway: {problem}") from None
    if not body.startswith(b"PAR1"):
        raise RuntimeError("the gateway answered, but not with a parquet")
    # A capped result is not an answer. The gateway says so only in this
    # header, so read it here or a 50,000-row cap silently becomes "the data".
    if str(response_headers.get("X-Truncated", "")).lower() == "true":
        raise RuntimeError(
            f"the gateway truncated this result at its row cap "
            f"({response_headers.get('X-Row-Count', '?')} rows returned). "
            "Narrow the query — filter or aggregate in SQL — rather than pulling a cut "
            "that is silently missing rows."
        )
    into.write_bytes(body)


def _project_root() -> Path:
    for folder in [HERE, *HERE.parents]:
        if (folder / "app_folder").is_dir():
            return folder
    return HERE


def _port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.12)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _find_backend():
    """A live backend serving this script's project, identified by /api/health
    rather than by process name.

    The project_folder check is the whole point: a backend with a different
    project open answers from the wrong folder, so only one that serves this
    project — or a parent of it — is usable."""
    root = _project_root()
    for port in BACKEND_PORTS:
        if not _port_open(port):
            continue
        try:
            health = json.loads(_request(f"http://127.0.0.1:{port}/api/health", timeout=2))
        except Exception:
            continue
        if health.get("status") != "ok" or not health.get("project_folder"):
            continue
        served = Path(health["project_folder"]).resolve()
        if served == root or served in root.parents:
            return port
    return None


def _wait_for_org(port: int, org: str) -> bool:
    deadline = time.time() + REAUTH_WAIT_SECONDS
    while time.time() < deadline:
        time.sleep(REAUTH_POLL_SECONDS)
        try:
            status = json.loads(_request(f"http://127.0.0.1:{port}/api/org/status", timeout=10))
        except Exception:
            continue
        if any(entry.get("org_id") == org for entry in status.get("organizations") or []):
            return True
    return False


def _frame(result: dict) -> pl.DataFrame:
    if result.get("spilled_to"):
        # Past its preview cap the backend returns the first rows and writes
        # the whole result to parquet. Reading that back is what stops a big
        # pull from silently becoming its first few hundred rows.
        return pl.read_parquet(result["spilled_to"])
    # The gateway's own cap comes through untouched as `truncated`; a preview
    # of a capped result is two kinds of incomplete at once, so refuse both.
    if result.get("truncated"):
        raise RuntimeError(
            "the gateway truncated this result at its row cap; narrow the query "
            "(filter or aggregate in SQL) rather than pulling a cut that is missing rows"
        )
    columns = result.get("columns") or []
    rows = result.get("rows") or []
    row_count = result.get("row_count", len(rows))
    if row_count > len(rows):
        raise RuntimeError(
            f"the backend returned {len(rows)} of {row_count} rows and no spill file; "
            "rerun the pull"
        )
    # infer_schema_length=None reads every row before typing a column, so one
    # that is null for its first rows is not frozen as Null.
    return pl.DataFrame(rows, schema=columns, orient="row", infer_schema_length=None)


def _backend_query(port: int, org: str, sql: str, script_name) -> pl.DataFrame:
    url = f"http://127.0.0.1:{port}/api/org/query"
    payload = {"org_id": org, "sql": sql, "script_name": script_name}
    result = _backend_call(url, payload)

    # Two different "no credential" answers, and they need different first moves.
    # reauth_started: the backend refused an existing credential, cleared it and
    # already opened the browser — only a wait is owed. reauth_required: this
    # machine has never connected, so nothing has been opened and asking for the
    # sign-in is this script's job. Without that second branch, running a script
    # on a fresh machine errored instead of signing the user in, which defeats
    # the point of the pull living in the script at all.
    if result.get("status") == "reauth_required":
        if not _open_sign_in(port, org):
            raise RuntimeError(
                f"'{org}' is not connected on this machine, and VibeFoundry could not "
                "open its sign-in page. Connect it from the Organizations panel and rerun."
            )
        if not _wait_for_org(port, org):
            raise RuntimeError(
                f"the sign-in for '{org}' is open in the browser and still unfinished — "
                "complete it and rerun"
            )
        result = _backend_call(url, payload)
    elif result.get("status") == "reauth_started":
        if not _wait_for_org(port, org):
            raise RuntimeError(
                f"the sign-in for '{org}' is still waiting in the browser — finish it and rerun"
            )
        result = _backend_call(url, payload)

    status = result.get("status")
    if status and status != "ok":
        raise RuntimeError(
            f"VibeFoundry could not query '{org}' ({status}) — connect the organization and rerun"
        )
    return _frame(result)


def _open_sign_in(port: int, org: str) -> bool:
    """Ask the backend to open this organization's sign-in page. The backend
    owns the nonce, the browser and the callback — the same call the
    Organizations panel makes — so nothing here touches a credential."""
    try:
        answer = json.loads(
            _request(
                f"http://127.0.0.1:{port}/api/org/connect",
                "POST",
                {"org_id": org},
                timeout=60,
            )
        )
    except Exception:
        return False
    return answer.get("status") in ("opened", "ok")


def _backend_call(url: str, payload: dict) -> dict:
    try:
        return json.loads(_request(url, "POST", payload, timeout=600))
    except urllib.error.HTTPError as problem:
        raise RuntimeError(f"VibeFoundry refused this query: {_http_detail(problem)}") from None
    except Exception as problem:
        raise RuntimeError(f"could not reach the VibeFoundry backend: {problem}") from None


def _public_tables(sql: str) -> list:
    """Table names the SQL references, so only those public files download."""
    import re
    return sorted(set(re.findall(r"(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)", sql, re.I)))


def _public_pull(sql: str, into: Path) -> None:
    """Public datasets need no credential at all, so a deployed app can answer
    from them with nothing in .env: fetch each referenced <id>.json for its
    downloadUrl, download that parquet once, run the SQL locally."""
    frames = {}
    for table in _public_tables(sql):
        try:
            meta = json.loads(_request(f"{PUBLIC_DATA_BASE_URL}/{table}.json"))
        except Exception as problem:
            raise RuntimeError(f"no public dataset named '{table}': {problem}") from None
        url = meta.get("downloadUrl") or f"{PUBLIC_DATA_BASE_URL}/{meta.get('sourceFile') or table + '.parquet'}"
        body = _request(url)
        if not body.startswith(b"PAR1"):
            raise RuntimeError(f"public dataset '{table}' did not come back as parquet")
        frames[table] = pl.scan_parquet(io.BytesIO(body))
    if not frames:
        raise RuntimeError("the SQL names no table; public pulls need a FROM <dataset_id>")
    pl.SQLContext(frames=frames, eager=False).execute(sql).collect().write_parquet(into)


def pull(sql: str, into, org: str = "pronghorn", script_name=None) -> Path:
    """Run `sql` and write the result to `into`, creating its folder. Returns
    the path written. `org="public"` reaches the public datasets."""
    into = Path(into)
    into.parent.mkdir(parents=True, exist_ok=True)

    tried = []
    if org == PUBLIC_ORG:
        # Public datasets carry no app credential, so path 1 cannot serve them.
        tried.append("public datasets need no app credential, so .env was skipped")
    else:
        config = _credentials()
        if config:
            _gateway_pull(config, sql, into)
            return into
        tried.append("no VF_GATEWAY/VF_APP_ID/VF_APP_KEY in a nearby .env or the environment")

    port = _find_backend()
    if port:
        _backend_query(port, org, sql, script_name).write_parquet(into)
        return into
    tried.append(f"no VibeFoundry backend on 127.0.0.1:{BACKEND_PORTS[0]}-{BACKEND_PORTS[-1]} serving this project")

    if org == PUBLIC_ORG:
        # No backend, but public data needs none: this is the path a deployed
        # app with only an App Credential (or nothing) takes for public tables,
        # and it is what makes "a question's script needs no edit to become an
        # app" true for public data as well as the org's own.
        _public_pull(sql, into)
        return into

    # Fail now, not later: a 3am cron on a headless box must stop in a second
    # rather than hang on a sign-in nobody is there to perform.
    raise RuntimeError(
        "Could not pull data — " + "; ".join(tried) + ". "
        "Connect the organization once in VibeFoundry, or add an App Credential "
        "(VF_GATEWAY, VF_APP_ID, VF_APP_KEY) to a .env beside this script."
    )
