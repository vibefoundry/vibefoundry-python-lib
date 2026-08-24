"""Talking to a client's portal: which one, who you are, and asking it things.

Three separate questions, deliberately kept apart because they fail for
different reasons and are fixed in different places.

  Which portal?  A project belongs to a client, so the choice is bound to the
                 folder and remembered. Discovering the options needs a
                 VibeFoundry sign-in; vibefoundry.ai serves addresses only.

  Who are you?   The portal's own Google sign-in, in the user's browser. What
                 comes back is a short-lived assertion that a person is
                 present. It is deliberately short - an hour - so re-signing
                 in is normal rather than exceptional.

  The question   SQL, sent to the gateway, answered there. Rows come back;
                 tables do not.

Nothing here holds an application credential. A `.env` is for callers with no
human attached, and this module is the path for callers who have one.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

ORG_HUBS_URL = "https://vibefoundry.ai/api/org-hubs"

# The binding lives in the project rather than beside it. A hub is an address,
# never a secret, so committing it is safe - and it means a colleague who
# clones the repo reaches the same client's portal without being told which.
PROJECT_MARKER = Path(".vibefoundry") / "hub.json"

# Tokens are per hub and never per project: one sign-in serves every folder
# belonging to that client.
_TOKEN_STORE = Path.home() / ".vibefoundry" / "portal.json"

# Refreshed a little early, so a query that takes a moment to reach the
# gateway is not answered with "expired" by the time it lands.
_EXPIRY_MARGIN_SECONDS = 60


class PortalError(RuntimeError):
    """A failure phrased for the person who has to act on it."""

    def __init__(self, message: str, *, needs: str = ""):
        super().__init__(message)
        # What would fix it: "vibefoundry_signin", "pick_org", "portal_signin".
        # Callers branch on this rather than reading the sentence.
        self.needs = needs


# ----------------------------------------------------------- which portal

def project_hub(project_folder: Path) -> Optional[dict]:
    """The client this folder belongs to, or None if it has not been asked."""
    marker = Path(project_folder) / PROJECT_MARKER
    if not marker.exists():
        return None
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if data.get("hub") else None


def bind_project(project_folder: Path, org: dict) -> dict:
    """Remember which client's portal this folder talks to."""
    marker = Path(project_folder) / PROJECT_MARKER
    marker.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "id": org.get("id", ""),
        "name": org.get("name", ""),
        "hub": org["hub"].rstrip("/"),
    }
    marker.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


def org_hubs(ide_token: str) -> list:
    """The portals this VibeFoundry account may reach. Addresses only."""
    if not ide_token:
        raise PortalError(
            "Sign in to VibeFoundry to see which organizations you can reach.",
            needs="vibefoundry_signin",
        )
    request = urllib.request.Request(
        ORG_HUBS_URL, headers={"Authorization": f"Bearer {ide_token}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as problem:
        if problem.code == 401:
            raise PortalError(
                "Your VibeFoundry sign-in has expired. Sign in again.",
                needs="vibefoundry_signin",
            ) from problem
        raise PortalError(f"Could not read your organizations ({problem.code}).") from problem
    except Exception as problem:
        raise PortalError(f"Could not reach VibeFoundry: {problem}") from problem
    return payload.get("orgs", [])


# ------------------------------------------------------------- who you are

def _load_tokens() -> dict:
    if not _TOKEN_STORE.exists():
        return {}
    try:
        return json.loads(_TOKEN_STORE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_token(hub: str, token: str, gateway: str, email: str, expires: int) -> None:
    store = _load_tokens()
    store[hub.rstrip("/")] = {
        "token": token,
        "gateway": (gateway or "").rstrip("/"),
        "email": email,
        "expires": int(expires),
    }
    _TOKEN_STORE.parent.mkdir(parents=True, exist_ok=True)
    _TOKEN_STORE.write_text(json.dumps(store, indent=2), encoding="utf-8")


def session(hub: str) -> Optional[dict]:
    """The live session for this hub, or None if there is not one."""
    record = _load_tokens().get(hub.rstrip("/"))
    if not record or not record.get("token"):
        return None
    if float(record.get("expires", 0)) - _EXPIRY_MARGIN_SECONDS <= time.time():
        return None
    return record


def sign_in_url(hub: str, callback: str, state: str) -> str:
    """Where the browser goes to turn a portal session into a token."""
    query = urllib.parse.urlencode({"callback": callback, "state": state})
    return f"{hub.rstrip('/')}/api/viewer-token?{query}"


# -------------------------------------------------------------- the question

def _gateway_call(record: dict, path: str, body: Optional[dict] = None):
    gateway = (record.get("gateway") or "").rstrip("/")
    if not gateway:
        raise PortalError("This portal did not report a data gateway.")
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-VF-Viewer-Assertion": record["token"]}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{gateway}{path}", data=data, headers=headers,
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as problem:
        raw = problem.read() or b"{}"
        try:
            detail = json.loads(raw).get("detail", "")
        except ValueError:
            detail = raw.decode("utf-8", "replace")[:300]
        if problem.code == 401:
            # The assertion is the thing that lapsed, and it lapses hourly by
            # design. Say which sign-in is meant, not just "unauthorized".
            raise PortalError(
                detail or "Your portal sign-in has expired.", needs="portal_signin"
            ) from problem
        raise PortalError(detail or f"The portal refused that ({problem.code}).") from problem
    except Exception as problem:
        raise PortalError(f"Could not reach the data gateway: {problem}") from problem


def tables(record: dict) -> list:
    """Every table this person may read, with its columns."""
    return _gateway_call(record, "/v1/tables").get("tables", [])


def schema(record: dict, table_id: str) -> dict:
    """One table's full profile: dtypes, nulls, ranges, sample values."""
    return _gateway_call(record, f"/v1/tables/{urllib.parse.quote(table_id)}/schema")


def query(record: dict, sql: str, limit: Optional[int] = None) -> dict:
    """Ask the portal a question. The answer travels; the table does not."""
    body: dict = {"sql": sql}
    if limit:
        body["limit"] = int(limit)
    return _gateway_call(record, "/v1/query", body)
