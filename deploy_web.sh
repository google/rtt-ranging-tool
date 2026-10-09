#!/bin/bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# deploy_web.sh
# Automates versioning, exporting, and deploying RTT Ranging Tool to web server.

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <server_host>"
    exit 1
fi

SERVER_HOST="$1"
if [[ "$SERVER_HOST" == *"@"* ]]; then
    REMOTE_TARGET="$SERVER_HOST"
else
    REMOTE_TARGET="${USER}@${SERVER_HOST}"
fi

# Change to the directory where the script is located
cd "$(dirname "$0")"

# Derive version string from rtt-ranging-tool.html APP_VERSION (Format: YYMMDD-N or VYYMMDD-N)
VERSION_STR=$(grep -E -o 'APP_VERSION = ["'\'']V?[0-9a-zA-Z\-]+["'\'']' rtt-ranging-tool.html | head -n 1 | sed -E 's/APP_VERSION = ["'\'']V?([^"'\'']+).*/\1/')
if [ -z "$VERSION_STR" ]; then
    VERSION_STR=$(date +"%y%m%d-0")
fi
NEW_VERSION="${VERSION_STR}"
TARGET_FILENAME="rtt-ranging-tool-${VERSION_STR}.html"

echo "=================================================="
echo "    RTT RANGING TOOL - AUTOMATED WEB DEPLOYMENT"
echo "=================================================="
echo "Target Version:      $NEW_VERSION (derived from rtt-ranging-tool.html)"
echo "Target Deployment:   ${REMOTE_TARGET}:~/web/rtt-ranging-tool.html"
echo "Archive Deployment:  ${REMOTE_TARGET}:~/web/old/$TARGET_FILENAME"
echo "--------------------------------------------------"

# 2. Compile standalone HTML
echo ">>> Compiling Standalone HTML using export.sh..."
chmod +x export.sh 2>/dev/null || true
bash ./export.sh --inline

# 3. Create the version-dated release file
echo ">>> Creating release file: $TARGET_FILENAME..."
if [ ! -f "rtt-ranging-tool-out.html" ]; then
    echo "ERROR: rtt-ranging-tool-out.html was not generated!"
    exit 1
fi
cp rtt-ranging-tool-out.html "$TARGET_FILENAME"

# 4. SCP to the web server
echo ">>> Transferring to ${REMOTE_TARGET} via scp..."
echo "    (Please touch your security key / enter credentials if prompted)"
ssh "${REMOTE_TARGET}" "mkdir -p ~/web/old"
if scp "$TARGET_FILENAME" "${REMOTE_TARGET}:~/web/old/$TARGET_FILENAME" && \
   scp rtt-ranging-tool-out.html "${REMOTE_TARGET}:~/web/rtt-ranging-tool.html"; then
    echo ">>> Transfer successful!"
else
    echo "ERROR: SCP transfer failed!"
    echo "Preserving release file locally: $TARGET_FILENAME"
    echo "You can manually transfer them by running:"
    echo "  scp $TARGET_FILENAME ${REMOTE_TARGET}:~/web/old/$TARGET_FILENAME"
    echo "  scp rtt-ranging-tool-out.html ${REMOTE_TARGET}:~/web/rtt-ranging-tool.html"
    exit 1
fi

# 5. Tidy up temporary .html files
echo ">>> Cleaning up temporary HTML artifacts..."
rm -f rtt-ranging-tool-out.html "$TARGET_FILENAME"

echo "--------------------------------------------------"
echo "    DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo "=================================================="
