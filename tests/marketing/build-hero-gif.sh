#!/usr/bin/env bash
# FMN-127: assemble docs/marketing/hero.gif from frame PNGs.
# Captured by the 'hero flow' Playwright test in capture.spec.js.
set -euo pipefail

cd "$(dirname "$0")/../.."
FRAMES=docs/marketing/frames
OUT=docs/marketing/hero.gif

# Concat list with per-frame durations. The Results frame holds longer
# so the "all succeeded" payoff lands.
LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT
cat > "$LIST" <<EOF
file '$PWD/$FRAMES/01-load.png'
duration 3
file '$PWD/$FRAMES/02-review.png'
duration 3
file '$PWD/$FRAMES/04-results.png'
duration 4
file '$PWD/$FRAMES/04-results.png'
EOF

# Static slideshow: each frame holds for the duration declared in the
# concat list. fps=2 gives smooth-enough timing with only ~20 output
# frames total (2 * ~10s held = 20).
ffmpeg -y -f concat -safe 0 -i "$LIST" \
  -vf "fps=2,scale=1024:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none" \
  -loop 0 \
  "$OUT"

echo "Built $OUT"
ls -lh "$OUT"
