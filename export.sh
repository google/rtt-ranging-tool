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

# Change to the directory where the script is located
cd "$(dirname "$0")"

HTML_FILE="rtt-ranging-tool.html"
OUT_FILE="rtt-ranging-tool-out.html"

if [ ! -f "$HTML_FILE" ]; then
    echo "Error: $HTML_FILE not found!"
    exit 1
fi

# Parse arguments
INLINE=false
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --inline) INLINE=true ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

# Clear or create the output file
> "$OUT_FILE"

BUFFERING=false
BUFFER=""

while IFS= read -r line || [ -n "$line" ]; do
    # Check for the specific local CSS file (single line)
    if [[ "$line" =~ '<link rel="stylesheet" href="rtt-ranging-tool.css' ]]; then
        echo "    <style>" >> "$OUT_FILE"
        cat "rtt-ranging-tool.css" >> "$OUT_FILE"
        echo "    </style>" >> "$OUT_FILE"
        continue
    fi

    # Handle multi-line script blocks
    if [[ "$line" =~ "<script>" ]] && [[ ! "$line" =~ "</script>" ]]; then
        BUFFERING=true
        BUFFER="$line"$'\n'
        continue
    fi

    if [ "$BUFFERING" = true ]; then
        BUFFER+="$line"$'\n'
        if [[ "$line" =~ "</script>" ]]; then
            BUFFERING=false
            # Check if this is the dynamic loader block and we want to inline
            if [[ "$BUFFER" =~ "rtt-ranging-tool.css" ]] && [ "$INLINE" = true ]; then
                echo "    <style>" >> "$OUT_FILE"
                cat "rtt-ranging-tool.css" >> "$OUT_FILE"
                echo "    </style>" >> "$OUT_FILE"
            elif [[ "$BUFFER" =~ "var scripts = [" ]] && [ "$INLINE" = true ]; then
                echo "    <!-- Inlined JS files -->" >> "$OUT_FILE"
                while IFS= read -r l; do
                    if [[ "$l" =~ \"(js/[^\"]+\.js)\" ]]; then
                        script_path="${BASH_REMATCH[1]}"
                        if [ -f "$script_path" ]; then
                            echo "    <script>" >> "$OUT_FILE"
                            cat "$script_path" >> "$OUT_FILE"
                            echo "    </script>" >> "$OUT_FILE"
                        else
                            echo "Warning: $script_path not found!"
                        fi
                    fi
                done <<< "$BUFFER"
            else
                # Otherwise, keep the original block (dynamic or other script)
                echo -n "$BUFFER" >> "$OUT_FILE"
            fi
            BUFFER=""
        fi
        continue
    fi

    # Pass through all other lines untouched
    echo "$line" >> "$OUT_FILE"
done < "$HTML_FILE"

if [ "$INLINE" = true ]; then
    echo "Standalone HTML successfully generated at $OUT_FILE (Inlined mode)"
else
    echo "HTML successfully generated at $OUT_FILE (Dynamic mode)"
fi
