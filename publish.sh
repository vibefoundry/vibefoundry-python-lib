#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Set version — use argument if provided, otherwise read from pyproject.toml.
# Both pyproject.toml AND __init__.py carry it: pyproject is what pip reports,
# __init__ is what --version and /api/health report. Bumping only one shipped
# a 0.4.1 wheel that announced itself as 0.4.0 — so they move together here.
if [ -n "$1" ]; then
  VERSION="$1"
  sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" pyproject.toml
  sed -i '' "s/^__version__ = \".*\"/__version__ = \"${VERSION}\"/" src/vibefoundry/__init__.py
  echo "Version updated to ${VERSION}"
else
  VERSION=$(grep '^version' pyproject.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')
fi
echo "Publishing vibefoundry v${VERSION}"

# Clear cache and build artifacts
echo "Clearing cache..."
rm -rf dist build src/vibefoundry.egg-info

echo "Clearing static files..."
rm -rf src/vibefoundry/static/* src/vibefoundry/pane/*

# npm install and build both frontend targets: the standalone app (static/) and
# the single-file pane bundle (pane/) that host MCP servers serve as a widget.
echo "Installing frontend dependencies..."
cd frontend
npm install
echo "Building frontend..."
npm run build
echo "Building pane bundle..."
npm run build:pane
cd ..

# Build Python package
echo "Building Python package..."
python -m build

# Push to PyPI — token lives in .env (PYPI_TOKEN=...), with .pypi_token as a legacy fallback
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi
if [ -z "$PYPI_TOKEN" ] && [ -f "$SCRIPT_DIR/.pypi_token" ]; then
  PYPI_TOKEN=$(cat "$SCRIPT_DIR/.pypi_token")
fi
if [ -z "$PYPI_TOKEN" ]; then
  echo "Error: PYPI_TOKEN not set"
  echo "Add PYPI_TOKEN=pypi-... to .env in the project root"
  exit 1
fi
echo "Uploading to PyPI..."
twine upload dist/* -u __token__ -p "$PYPI_TOKEN"

echo "Done! vibefoundry v${VERSION} published to PyPI"
