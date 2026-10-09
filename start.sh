#!/bin/bash
#
# OHIF-AI Docker Compose Launcher
# ================================
#
# Usage:
#   bash start.sh              Start all services (no rebuild — fastest)
#   bash start.sh viewer       Rebuild only the OHIF viewer, then start all
#   bash start.sh monai        Rebuild only the MONAI backend, then start all
#   bash start.sh all          Rebuild everything, then start all
#   bash start.sh --build      (legacy) same as 'all'
#
# Recommended workflow:
#   - After editing frontend code (Viewers/):        bash start.sh viewer
#   - After editing Python code (monai-label/):      bash start.sh monai
#   - Just restarting (no code changes):             bash start.sh
#   - First time setup / Dockerfile changes:         bash start.sh all
#
# Notes:
#   - The 'viewer' build takes ~5-6 min (yarn install + webpack).
#   - The 'monai' build is fast on code-only changes thanks to Docker layer
#     caching — pip install and SAM weight downloads are cached above the
#     source COPY layer. Only triggers full rebuild if requirements.txt,
#     sam2/, or sam3/ change.
#   - Orthanc uses a prebuilt image and never needs rebuilding.
#   - If the monai container re-downloads SAM weights unexpectedly, check
#     that no changes were made to requirements.txt, sam2/, or sam3/ —
#     those layers sit above the wget commands in the Dockerfile.
#

case "${1:-}" in
  viewer)
    echo "==> Rebuilding ohif_viewer only..."
    docker compose -f ./docker-compose.yml build ohif_viewer
    docker compose -f ./docker-compose.yml up
    ;;
  monai)
    echo "==> Rebuilding monai_sam2 only..."
    docker compose -f ./docker-compose.yml build monai_sam2
    docker compose -f ./docker-compose.yml up
    ;;
  all|--build)
    echo "==> Rebuilding all services..."
    docker compose -f ./docker-compose.yml up --build
    ;;
  *)
    echo "==> Starting all services (no rebuild)..."
    docker compose -f ./docker-compose.yml up
    ;;
esac
