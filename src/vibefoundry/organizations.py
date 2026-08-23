"""The organizations the IDE knows how to connect to.

This list ships inside the package instead of being fetched from
vibefoundry.ai, and that is the whole point: a hosted registry would see
every client's hub URL and every connection attempt, which is exactly the
sovereignty the design promises not to spend. Discovery costs a package
release; the alternative costs the guarantee.

An organization that isn't listed is still reachable — the user pastes their
hub URL and `normalize_hub_url` turns it into the same shape.
"""

import urllib.parse
from typing import Optional

# Where a connection starts when the user has not named a hub. This page lists
# the organizations and hands the browser to whichever one they pick; the hub
# then authenticates them against ITS OWN identity provider and redirects the
# credential straight back to this machine. Nothing about which organizations
# exist is compiled in here, so onboarding a client is a change to that page,
# not a release of this package.
CONNECT_URL = "https://vibefoundry.ai/connect"

# Deliberately empty. A hardcoded roster meant every new client needed a package
# release, and it named one client in the source of a product meant to serve
# many. A user who knows their hub address can still paste it (see
# `normalize_hub_url`); everyone else goes through CONNECT_URL.
ORGANIZATIONS = []

# The public data library is not an organization — it has no hub and no
# credential — but every catalogue and query path addresses it by the same
# org_id, so the reserved value lives here next to the real ones.
PUBLIC_ORG_ID = "public"
PUBLIC_ORG_NAME = "Public data"


def find_organization(org_id: str) -> Optional[dict]:
    """The bundled entry for `org_id`, or None. Case-insensitive because the
    id also arrives from a hub redirect and from an LLM tool argument."""
    if not org_id:
        return None
    wanted = str(org_id).strip().lower()
    for org in ORGANIZATIONS:
        if org["id"].lower() == wanted:
            return dict(org)
    return None


def normalize_hub_url(raw: str) -> str:
    """Turn a user-pasted hub address into an absolute origin with no
    trailing slash. Raises ValueError on anything that isn't an http(s) URL.

    Users paste `hub.acme.com`, `https://hub.acme.com/`, and occasionally a
    deep link they were sent; all three have to end up as the one origin the
    `/connect` URL is built on."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Hub URL is empty")
    if "://" not in text:
        text = f"https://{text}"
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Hub URL must be http or https")
    if not parsed.netloc:
        raise ValueError("Hub URL has no host")
    return f"{parsed.scheme}://{parsed.netloc}"


def normalize_gateway_url(raw: str) -> str:
    """Like `normalize_hub_url` but keeps the path, because a gateway can be
    mounted behind a prefix. This value comes from the hub's own config, not
    from a paste box, so there is no deep link to guard against — and
    flattening it to the origin would silently break such a deployment."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Gateway URL is empty")
    if "://" not in text:
        text = f"https://{text}"
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Gateway URL must be http or https")
    if not parsed.netloc:
        raise ValueError("Gateway URL has no host")
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")


def org_hint_from_hub_url(hub_url: str) -> str:
    """A provisional id for a pasted hub, used only until the hub's redirect
    tells us the real `org_id`. Derived from the host so two pasted hubs
    can't collide in the pending-connect map."""
    host = urllib.parse.urlsplit(normalize_hub_url(hub_url)).netloc.split(":")[0]
    slug = "".join(c if (c.isalnum() or c == "-") else "-" for c in host.lower())
    return slug.strip("-") or "org"
