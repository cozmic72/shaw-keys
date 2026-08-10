#!/bin/bash
#
# Substitute {{FONT_URL}} in a staged copy of shaw-keys.css, then verify
# no token survived.
#
#   tools/substitute-font-url.sh URL FILE...
#
# The verification is the point. An unsubstituted {{FONT_URL}} is not a valid
# URL, so the browser drops the @font-face and paints in a fallback face with
# nothing logged — a page that renders, is wrong, and says so nowhere. Failing
# here puts the error in front of whoever ran the staging step.

set -euo pipefail

[ $# -ge 2 ] || { echo "substitute-font-url.sh: usage: URL FILE..." >&2; exit 1; }

FONT_URL="$1"
shift

case "$FONT_URL" in
    *'|'*|*'&'*|*'\'*)
        echo "substitute-font-url.sh: font URL contains a character sed would" >&2
        echo "  reinterpret (| & \\): $FONT_URL" >&2
        exit 1 ;;
esac

for file in "$@"; do
    [ -f "$file" ] || { echo "substitute-font-url.sh: no such file: $file" >&2; exit 1; }

    grep -q '{{FONT_URL}}' "$file" || {
        echo "substitute-font-url.sh: $file contains no {{FONT_URL}} token." >&2
        echo "  Either it was already substituted (staging ran twice against the same" >&2
        echo "  destination) or the file is not the one this step expects." >&2
        exit 1
    }

    # `|` as the delimiter: the URL contains `/` and may be absolute.
    tmp="$file.tmp.$$"
    sed "s|{{FONT_URL}}|$FONT_URL|g" "$file" > "$tmp"
    mv "$tmp" "$file"

    if grep -n '{{FONT_URL}}' "$file"; then
        echo "substitute-font-url.sh: {{FONT_URL}} survived substitution in $file" >&2
        exit 1
    fi
done
