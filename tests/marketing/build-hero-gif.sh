#!/usr/bin/env bash
# FMN-127: assemble docs/marketing/hero.gif from frame PNGs.
# Captured by the 'hero flow' Playwright test in capture.spec.js.
set -euo pipefail

cd "$(dirname "$0")/../.."
FRAMES=docs/marketing/frames
OUT=docs/marketing/hero.gif
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Source frames are captured at the wizard's natural fullPage size, which
# varies per step (popup 1280x900, load 1265x1110, review 1265x956,
# results 1280x900). ffmpeg's concat demuxer + palette pipeline produces
# 1x1-delta output (silent regression: GIF appears static) when input
# frames have heterogeneous dimensions, even with scale+crop in the
# filtergraph. Pre-normalize each frame to 1024x880 with ImageMagick so
# concat sees uniform inputs.
for name in 01-popup 02-load 03-review 04-results; do
  magick "$FRAMES/$name.png" -resize 1024x880^ -gravity center -extent 1024x880 "$WORK/$name.png"
done

# Concat list with per-frame durations. Popup launcher -> load -> review
# -> results. Results holds longer so the "all succeeded" payoff lands.
# The trailing duplicate is a concat-demuxer requirement: the last entry's
# duration is ignored, so duplicating the last frame gives it a held tail.
LIST="$WORK/concat.txt"
cat > "$LIST" <<EOF
file '$WORK/01-popup.png'
duration 3
file '$WORK/02-load.png'
duration 3
file '$WORK/03-review.png'
duration 3
file '$WORK/04-results.png'
duration 4
file '$WORK/04-results.png'
EOF

# Static slideshow: each frame holds for the duration declared in the
# concat list. fps=2 gives smooth-enough timing.
ffmpeg -y -f concat -safe 0 -i "$LIST" \
  -vf "fps=2,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none" \
  -loop 0 \
  "$OUT"

echo "Built $OUT"
ls -lh "$OUT"
