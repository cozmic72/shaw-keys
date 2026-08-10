#!/bin/bash
#
# Stage the library into a consumer's docroot, substituting {{FONT_URL}} in the
# CSS. Consumers already copy these files; this replaces the bare `cp -R` so the
# font URL is resolved by whoever knows it.
#
#   tools/stage.sh --font-url /fonts DEST
#
# --font-url is mandatory. There is no default: the correct value is a property
# of the consumer's docroot layout, and a guess that renders in the wrong face
# is indistinguishable from success in a browser.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FONT_URL=""
DEST=""

while [ $# -gt 0 ]; do
    case "$1" in
        --font-url)
            [ $# -ge 2 ] || { echo "stage.sh: --font-url needs a value" >&2; exit 1; }
            FONT_URL="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: tools/stage.sh --font-url URL DEST"
            exit 0
            ;;
        -*)
            echo "stage.sh: unknown option: $1" >&2
            exit 1
            ;;
        *)
            [ -z "$DEST" ] || { echo "stage.sh: more than one destination given: $DEST, $1" >&2; exit 1; }
            DEST="$1"
            shift
            ;;
    esac
done

[ -n "$FONT_URL" ] || {
    echo "stage.sh: --font-url is required." >&2
    echo "  It is baked into shaw-keys.css's @font-face rule. Pass the URL" >&2
    echo "  under which the destination serves InterAlia-VF.otf, e.g. /fonts" >&2
    exit 1
}
[ -n "$DEST" ] || { echo "stage.sh: destination directory required" >&2; exit 1; }

case "$FONT_URL" in
    */) echo "stage.sh: --font-url must not end in '/': $FONT_URL" >&2; exit 1 ;;
esac

mkdir -p "$DEST"

# Glob, not `/.`: the source is a repository root, so `/.` would copy its .git
# gitlink and .gitignore into a directory the consumer serves.
cp -R "$SRC_DIR"/* "$DEST"/
rm -rf "$DEST/tools" "$DEST/docs"

"$SRC_DIR/tools/substitute-font-url.sh" "$FONT_URL" "$DEST/shaw-keys.css"

echo "Shaw Keys staged to $DEST/ (FONT_URL=$FONT_URL)"
