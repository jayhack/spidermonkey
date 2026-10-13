#!/bin/sh
# Full-resolution stills of the explainer at the given times: scripts/stills.sh 7 20 45
# COMP=square for the social cut. Needs the dev server (pnpm dev) and Google Chrome.
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
COMP="${COMP:-wide}"
SIZE=$([ "$COMP" = wide ] && echo 1600,900 || echo 1080,1080)
mkdir -p frames
for t in "$@"; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=$SIZE --virtual-time-budget=4000 \
    --screenshot="frames/$COMP-t$t.png" "http://localhost:4310/frame?comp=$COMP&t=$t" >/dev/null 2>&1
  echo "frames/$COMP-t$t.png"
done
