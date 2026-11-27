#!/bin/sh
#
# Turn a Nerves firmware file into the pieces JSNerves serves to the browser.
#
# Usage:
#   ./extract_firmware.sh [--no-snapshot] <firmware.fw> <system_images_dir>
#
# Example:
#   ./extract_firmware.sh ../my_app/_build/jslinux_dev/nerves/images/my_app.fw \
#     ~/.nerves/artifacts/nerves_system_jslinux-portable-0.4.3/images
#
# Needs fwup and GNU coreutils and sed (on a Mac, Homebrew's gnubin
# directories first on PATH); the snapshot needs Node.js (see
# make_snapshot.sh).
#
# Produces:
#   opensbi.bin   - OpenSBI fw_jump (TinyEMU "bios")
#   u-boot.bin    - U-Boot, S-mode (TinyEMU "kernel"; it boots the real kernel
#                   from the disk image)
#   disk/<id>/    - the fwup-written disk image (MBR, U-Boot env, A/B kernels,
#                   A/B rootfs, application partition, and 8 MB of scratch
#                   area after it that the page writes firmware updates
#                   to, see vm.writeDisk and board.sendUpdate) split into 256 KB
#                   blocks for lazy loading, plus blk.txt describing them.
#                   <id> is a hash of the image, so every image has its own
#                   URLs and can be cached forever (see "Hosting" in the
#                   README); disk/ is replaced, older images are removed
#   nerves.cfg    - drive0 updated to point at disk/<id>/blk.txt
#   disk/<id>/snapshot-<hash>.gz
#                 - the machine saved at the IEx prompt, restored instead of
#                   booting (make_snapshot.sh, about a minute; skipped with
#                   --no-snapshot, and then the page boots the image)
#

set -e

BLOCK_SIZE=256  # KB
SCRATCH_MB=8    # after the last partition; WebDemoNerves.Update and board.js agree on it

SNAPSHOT=1
if [ "$1" = "--no-snapshot" ]; then
    SNAPSHOT=
    shift
fi

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 [--no-snapshot] <firmware.fw> <system_images_dir>"
    echo ""
    echo "  firmware.fw        Path to the Nerves .fw file"
    echo "  system_images_dir  The Nerves system's images/ directory"
    echo "  --no-snapshot      Do not make the boot snapshot (make_snapshot.sh)"
    echo ""
    echo "The system images directory is typically (the prebuilt system mix deps.get fetched):"
    echo "  ~/.nerves/artifacts/nerves_system_jslinux-portable-<version>/images"
    echo "or, in a system checkout built from source:"
    echo "  .nerves/artifacts/nerves_system_jslinux-portable-<version>/images"
    exit 1
fi

FW_FILE="$1"
IMAGES_DIR="$2"

if [ ! -f "$FW_FILE" ]; then
    echo "Error: Firmware file not found: $FW_FILE"
    exit 1
fi

for f in fw_jump.bin u-boot.bin; do
    if [ ! -f "$IMAGES_DIR/$f" ]; then
        echo "Error: $f not found in $IMAGES_DIR"
        exit 1
    fi
done

echo "Writing the disk image with fwup..."
rm -rf disk disk.img
fwup -a -d disk.img -i "$FW_FILE" -t complete
# the scratch area: all zeros, so none of its blocks is served
truncate -s "+${SCRATCH_MB}M" disk.img

cp "$IMAGES_DIR/fw_jump.bin" opensbi.bin
cp "$IMAGES_DIR/u-boot.bin" u-boot.bin

# The id identifies this disk image: it names the directory the blocks are
# served from, and the browser keeps the guest's writes in IndexedDB under
# it, so a new image starts clean instead of inheriting stale blocks.
DISK_ID=$(sha256sum disk.img | cut -c1-16)
DIR="disk/${DISK_ID}"

echo "Splitting the disk image into ${BLOCK_SIZE}KB blocks..."
BLOCK_BYTES=$((BLOCK_SIZE * 1024))
FILE_SIZE=$(stat -c%s disk.img)
N_BLOCKS=$(( (FILE_SIZE + BLOCK_BYTES - 1) / BLOCK_BYTES ))

mkdir -p "$DIR"
split -b "${BLOCK_BYTES}" -d -a 9 --additional-suffix=.bin disk.img "$DIR/blk"

# Pad the last block to full size (TinyEMU requires all blocks to be identical size)
LAST_BLOCK=$(ls "$DIR"/blk*.bin | sort | tail -1)
truncate -s "${BLOCK_BYTES}" "${LAST_BLOCK}"

# Blocks that are entirely zero are not served. blk.txt lists them as
# [first, count] ranges so the emulator never asks for them (an older
# emulator, or a missing block, falls back to treating a 404 as zeros).
# Most of the kernel slots and the empty B/application partitions fall in
# this category.
ZERO_BLOCK=$(mktemp)
ZERO_LIST=$(mktemp)
truncate -s "${BLOCK_BYTES}" "$ZERO_BLOCK"
N_ZERO=0
PRESENT=""
for blk in "$DIR"/blk*.bin; do
    n=$(basename "$blk" .bin | sed 's/^blk0*//; s/^$/0/')
    if cmp -s "$blk" "$ZERO_BLOCK"; then
        rm -f "$blk"
        N_ZERO=$((N_ZERO + 1))
        echo "$n" >> "$ZERO_LIST"
    else
        PRESENT="${PRESENT:+$PRESENT, }$n"
    fi
done
ZERO_RANGES=$(awk '
    { n = $1 + 0
      if (have && n == prev + 1) { count++ }
      else { if (have) { out = out sep "[" first ", " count "]"; sep = ", " }
             first = n; count = 1; have = 1 }
      prev = n }
    END { if (have) out = out sep "[" first ", " count "]"; print out }' "$ZERO_LIST")
rm -f "$ZERO_BLOCK" "$ZERO_LIST"

# Create the block descriptor
# NOTE: TinyEMU block_size is in KB. prefetch lists every block that is
# served: the emulator downloads them in the background (prefetch_parallel
# at a time) while the guest boots, so the whole image arrives once and the
# page can show the download's progress.
cat > "$DIR/blk.txt" << EOT
{
  block_size: ${BLOCK_SIZE},
  n_block: ${N_BLOCKS},
  id: "${DISK_ID}",
  zero: [${ZERO_RANGES}],
  prefetch: [${PRESENT}],
  prefetch_parallel: 4,
}
EOT

rm -f disk.img

# Point the VM at the new image (the blocks are fetched relative to blk.txt)
sed -i "s|drive0: { file: \"[^\"]*\" }|drive0: { file: \"${DIR}/blk.txt\" }|" nerves.cfg
grep -q "\"${DIR}/blk.txt\"" nerves.cfg || { echo "Error: could not update drive0 in nerves.cfg"; exit 1; }

echo "Done!"
echo "  OpenSBI: opensbi.bin ($(du -h opensbi.bin | cut -f1))"
echo "  U-Boot:  u-boot.bin ($(du -h u-boot.bin | cut -f1))"
echo "  Disk:    ${N_BLOCKS} blocks of ${BLOCK_SIZE}KB in ${DIR}/, $((N_BLOCKS - N_ZERO)) non-empty ($(du -sh "$DIR" | cut -f1))"
echo ""

if [ -n "$SNAPSHOT" ]; then
    echo "Making the boot snapshot (about a minute)..."
    if ! "$(dirname "$0")/make_snapshot.sh"; then
        echo ""
        echo "Error: no snapshot. The disk image is in place and boots without"
        echo "one; run ./make_snapshot.sh again once the problem above is fixed."
        exit 1
    fi
    echo ""
fi

echo "Serve this directory, e.g.: python3 -m http.server 8000"
echo "Then open: http://localhost:8000/index.html"
