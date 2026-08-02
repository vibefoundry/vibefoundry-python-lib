"""
CLI entry point for VibeFoundry IDE
"""

import argparse
import os
import signal
import socket
import sys
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

import uvicorn

from vibefoundry import __version__
from vibefoundry.browser import launch_app_mode


def find_available_port(start_port: int = 8765, max_attempts: int = 100) -> int:
    """Find an available port starting from start_port"""
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"Could not find available port in range {start_port}-{start_port + max_attempts}")


def run_server(port: int, host: str = "127.0.0.1"):
    """Run the FastAPI server"""
    uvicorn.run(
        "vibefoundry.server:app",
        host=host,
        port=port,
        log_level="warning",
        access_log=False
    )


# --- the quiet, branded terminal ------------------------------------------------
# The backend's window is the user's first impression of the product, and it
# used to greet them with uvicorn chatter, watcher prints and PTY notices. Now
# it shows a purple VF splash and then goes silent: everything the process (and
# its children — the redirect is at the file-descriptor level, so subprocesses
# inherit it) would have printed lands in a per-port log instead. The history
# is never lost, just moved: `vibefoundry --show-log` prints it in full.

PURPLE = "\033[38;5;135m"
DIM = "\033[2m"
RESET = "\033[0m"

BANNER = r"""
  ██╗   ██╗ ███████╗
  ██║   ██║ ██╔════╝
  ██║   ██║ █████╗
  ╚██╗ ██╔╝ ██╔══╝
   ╚████╔╝  ██║
    ╚═══╝   ╚═╝
"""


def _log_dir() -> Path:
    d = Path.home() / ".vibefoundry" / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def show_log() -> int:
    """Print the most recent backend log in full (the --show-log command)."""
    logs = sorted(_log_dir().glob("backend-*.log"), key=lambda p: p.stat().st_mtime)
    if not logs:
        print("No backend logs yet — launch VibeFoundry first.")
        return 0
    latest = logs[-1]
    print(f"── {latest} ──\n")
    print(latest.read_text(errors="replace"))
    return 0


def _uptime_text(started_at: float) -> str:
    secs = int(time.time() - started_at)
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    parts = []
    if days:
        parts.append(f"{days} day{'s' if days != 1 else ''}")
    if hours:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    parts.append(f"{minutes} minute{'s' if minutes != 1 else ''}")
    return ", ".join(parts)


def _current_folder(url: str, fallback) -> str:
    """The folder the SERVER believes in right now — it can change after launch
    via the IDE's picker, so the splash asks rather than remembers."""
    try:
        import json
        with urllib.request.urlopen(f"{url}/api/health", timeout=1) as r:
            folder = json.load(r).get("project_folder")
            return folder or (str(fallback) if fallback else "")
    except Exception:
        return str(fallback) if fallback else ""


def render_splash(tty, url: str, project_folder, started_at: float) -> None:
    """The whole screen, redrawn: the backend introducing itself, with live
    uptime and the folder it is actually serving."""
    folder = _current_folder(url, project_folder)
    lines = [
        PURPLE + BANNER + RESET,
        f"  {PURPLE}Hi! I'm your VibeFoundry Backend.{RESET}  (v{__version__})",
        "",
        "  I'm the engine that lets you preview big datasets, run code,",
        "  and monitor app activity.",
        "",
    ]
    if folder:
        lines.append(f"  I'm currently operating out of:")
        lines.append(f"    {folder}")
    else:
        lines.append(f"  {DIM}No project folder chosen yet — pick one in the IDE.{RESET}")
    lines += [
        "",
        f"  I've been open for {_uptime_text(started_at)}.",
        "",
        f"  Once you're done with VibeFoundry in Claude or Codex,",
        f"  please shut me down!  {DIM}(Ctrl+C here){RESET}",
        "",
        f"  {DIM}Running {url}  ·  full log: vibefoundry --show-log{RESET}",
        "",
    ]
    tty.write("\033[2J\033[H" + "\n".join(lines) + "\n")
    tty.flush()


def redirect_output_to_log(port: int):
    """
    Send every future print — this process's AND its children's — to the log
    file, keeping the splash as the only thing on screen. Returns a writer for
    the real terminal, for the one message that still belongs there (shutdown).
    """
    tty_fd = os.dup(1)
    tty = os.fdopen(tty_fd, "w", buffering=1)
    log_path = _log_dir() / f"backend-{port}.log"
    log = open(log_path, "w", buffering=1)
    sys.stdout.flush()
    sys.stderr.flush()
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    sys.stdout = os.fdopen(os.dup(1), "w", buffering=1)
    sys.stderr = os.fdopen(os.dup(2), "w", buffering=1)
    return tty


def main(args: Optional[list[str]] = None):
    """Main entry point for vibefoundry CLI"""
    parser = argparse.ArgumentParser(
        prog="vibefoundry",
        description="VibeFoundry IDE - A local IDE for data science workflows"
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=None,
        help="Project folder to open (optional, can be selected in UI)"
    )
    parser.add_argument(
        "--version", "-v",
        action="version",
        version=f"vibefoundry {__version__}"
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=None,
        help="Port to run the server on (default: auto-detect)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host to bind the server to (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't open the browser automatically"
    )
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Run in development mode (enables CORS, detailed logging)"
    )
    parser.add_argument(
        "--pane-path",
        action="store_true",
        help="Print the path to the bundled pane HTML and exit. How an MCP "
             "server locates the pane without hardcoding install layouts."
    )
    parser.add_argument(
        "--show-log",
        action="store_true",
        help="Print the most recent backend log in full and exit. The running "
             "terminal shows only the splash; everything else lands here."
    )

    parsed_args = parser.parse_args(args)

    if parsed_args.show_log:
        return show_log()

    # Resolve-and-exit: no server, no project folder needed.
    if parsed_args.pane_path:
        pane = Path(__file__).parent / "pane" / "index.pane.html"
        if not pane.exists():
            print(f"Error: pane bundle missing at {pane}", file=sys.stderr)
            return 1
        print(pane)
        return 0

    # Handle project folder - use current directory if not specified
    if parsed_args.folder:
        project_folder = Path(parsed_args.folder).resolve()
    else:
        project_folder = Path.cwd()

    if not project_folder.exists():
        print(f"Error: Folder does not exist: {project_folder}")
        sys.exit(1)
    if not project_folder.is_dir():
        print(f"Error: Not a directory: {project_folder}")
        sys.exit(1)

    # Fail HERE, legibly, if macOS is blocking this process from the folder —
    # otherwise the denial surfaces minutes later as a PermissionError buried
    # in an import-time traceback (rich calls os.getcwd() on import), which
    # reads like a broken install instead of a privacy setting.
    try:
        os.listdir(project_folder)
    except PermissionError:
        print("")
        print("macOS is blocking this app from that folder (Privacy & Security).")
        print("Fix: System Settings > Privacy & Security > Files and Folders >")
        print("     Terminal > enable Documents Folder — then run this again.")
        print("(If a permission dialog appears instead, just click Allow.)")
        sys.exit(1)

    # Set environment variable for server to pick up
    os.environ["VIBEFOUNDRY_PROJECT_PATH"] = str(project_folder)

    # Find available port
    port = parsed_args.port or find_available_port()
    host = parsed_args.host
    local_url = f"http://{host}:{port}"

    # Splash on screen, everything else to the log. --dev keeps the old
    # firehose in the terminal for anyone actually working on the library.
    started_at = time.time()
    if parsed_args.dev:
        tty = sys.stdout
        print(f"Project folder: {project_folder}")
        print(f"Starting VibeFoundry IDE v{__version__}")
        print(f"App: {local_url}")
    else:
        tty = redirect_output_to_log(port)
        render_splash(tty, local_url, project_folder, started_at)

    # Handle Ctrl+C gracefully
    shutdown_event = threading.Event()

    def signal_handler(signum, frame):
        try:
            tty.write(f"\n  {PURPLE}✓{RESET} VibeFoundry stopped.\n")
            tty.flush()
        except Exception:
            pass
        shutdown_event.set()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Start server in background thread
    server_thread = threading.Thread(
        target=run_server,
        args=(port, host),
        daemon=True
    )
    server_thread.start()

    # Wait for server to be ready (health-check poll instead of fixed sleep)
    health_url = f"{local_url}/api/health"
    max_wait = 15  # seconds
    poll_interval = 0.2  # seconds
    waited = 0.0
    server_ready = False

    while waited < max_wait:
        try:
            req = urllib.request.urlopen(health_url, timeout=1)
            if req.status == 200:
                server_ready = True
                break
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(poll_interval)
        waited += poll_interval

    if not server_ready:
        print("Warning: Server may not be fully ready, opening browser anyway...")

    # Open browser
    if not parsed_args.no_browser:
        app_mode = launch_app_mode(local_url)
        if app_mode:
            print("Opened in app mode (Chrome/Edge)")
        else:
            print("Opened in default browser")

    # Keep main thread alive; in quiet mode, refresh the splash every 30s so
    # the uptime ticks and a folder picked later in the IDE shows up.
    try:
        last_render = time.time()
        while not shutdown_event.is_set():
            time.sleep(0.5)
            if not parsed_args.dev and time.time() - last_render >= 30:
                last_render = time.time()
                try:
                    render_splash(tty, local_url, project_folder, started_at)
                except Exception:
                    pass  # a failed redraw must never take the backend down
    except KeyboardInterrupt:
        try:
            tty.write(f"\n  {PURPLE}✓{RESET} VibeFoundry stopped.\n")
            tty.flush()
        except Exception:
            pass


if __name__ == "__main__":
    main()
