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

    parsed_args = parser.parse_args(args)

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
    print(f"Project folder: {project_folder}")

    # Find available port
    port = parsed_args.port or find_available_port()
    host = parsed_args.host
    local_url = f"http://{host}:{port}"

    print(f"Starting VibeFoundry IDE v{__version__}")
    print(f"App: {local_url}")

    # Handle Ctrl+C gracefully
    shutdown_event = threading.Event()

    def signal_handler(signum, frame):
        print("\nShutting down...")
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

    print("\nPress Ctrl+C to stop the server")

    # Keep main thread alive
    try:
        while not shutdown_event.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nShutting down...")


if __name__ == "__main__":
    main()
