#!/bin/sh
set -eu
node /local/prepare-frontend.cjs
cd /usr/src/app/platform/app
exec node /local/frontend-server.cjs
