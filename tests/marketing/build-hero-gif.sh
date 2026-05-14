#!/usr/bin/env bash
# FMN-127: assemble docs/marketing/hero.gif from frame PNGs.
#
# Inputs are the captioned frames produced by capture.spec.js's
# 'hero captions' test (under docs/marketing/frames/captioned/), already
# normalized to a uniform 1024x960 with a caption band burned in. This
# script's only job is to chain them through cross-fade transitions and
# encode the GIF.
#
# Captions and normalization happen in Playwright (not ImageMagick)
# because the local ImageMagick build lacks Freetype, and the local
# ffmpeg lacks drawtext.
set -euo pipefail

cd "$(dirname "$0")/../.."
SRC=docs/marketing/frames/captioned
OUT=docs/marketing/hero.gif

# Cross-fade timing. Each phase is fully visible for `Hn` seconds, then a
# 0.5s fade overlaps into the next phase. xfade output length = offset +
# input2_duration; chained offsets are cumulative phase holds.
FADE=0.5
H0=3 ; H1=3 ; H2=3 ; H3=4
# Each input loops for hold + fade so the trailing fade has frames to
# bleed from. The final input has no trailing fade, so it gets hold only.
L0=$(echo "$H0 + $FADE" | bc)
L1=$(echo "$H1 + $FADE" | bc)
L2=$(echo "$H2 + $FADE" | bc)
L3=$H3
OFF1=$H0
OFF2=$(echo "$OFF1 + $H1" | bc)
OFF3=$(echo "$OFF2 + $H2" | bc)

ffmpeg -y \
  -loop 1 -t "$L0" -i "$SRC/01-popup.png" \
  -loop 1 -t "$L1" -i "$SRC/02-load.png" \
  -loop 1 -t "$L2" -i "$SRC/03-action.png" \
  -loop 1 -t "$L3" -i "$SRC/04-configure.png" \
  -filter_complex "\
    [0:v][1:v]xfade=transition=fade:duration=${FADE}:offset=${OFF1}[v01]; \
    [v01][2:v]xfade=transition=fade:duration=${FADE}:offset=${OFF2}[v012]; \
    [v012][3:v]xfade=transition=fade:duration=${FADE}:offset=${OFF3}[final]; \
    [final]fps=15,split[a][b]; \
    [a]palettegen=stats_mode=full[p]; \
    [b][p]paletteuse=dither=bayer:bayer_scale=5" \
  -loop 0 \
  "$OUT"

echo "Built $OUT"
ls -lh "$OUT"
