#!/bin/sh
#
# Turn a Nerves firmware file into the pieces JSNerves serves to the browser.
#
# Usage:
#   ./extract_firmware.sh <firmware.fw> <system_images_dir>
#
# Example:
#   ./extract_firmware.sh ../my_app/_build/jslinux_dev/nerves/images/my_app.fw \
#     ../nerves_system_jslinux/.nerves/artifacts/nerves_system_jslinux-portable-0.4.0/images
#
# Produces:
#   opensbi.bin   - OpenSBI fw_jump (TinyEMU "bios")
#   u-boot.bin    - U-Boot, S-mode (TinyEMU "kernel"; it boots the real kernel
#                   from the disk image)
#   disk/         - the fwup-written disk image (MBR, U-Boot env, A/B kernels,
#                   A/B rootfs, application partition) split into 256 KB
#                   blocks for lazy loading, plus blk.txt describing them
#

set -e

BLOCK_SIZE=256  # KB

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <firmware.fw> <system_images_dir>"
    echo ""
    echo "  firmware.fw        Path to the Nerves .fw file"
    echo "  system_images_dir  The Nerves system's images/ directory"
    echo ""
    echo "The system images directory is typically:"
    echo "  ../nerves_system_jslinux/.nerves/artifacts/nerves_system_jslinux-portable-*/images"
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

cp "$IMAGES_DIR/fw_jump.bin" opensbi.bin
cp "$IMAGES_DIR/u-boot.bin" u-boot.bin

echo "Splitting the disk image into ${BLOCK_SIZE}KB blocks..."
BLOCK_BYTES=$((BLOCK_SIZE * 1024))
FILE_SIZE=$(stat -c%s disk.img)
N_BLOCKS=$(( (FILE_SIZE + BLOCK_BYTES - 1) / BLOCK_BYTES ))

mkdir -p disk
split -b "${BLOCK_BYTES}" -d -a 9 --additional-suffix=.bin disk.img disk/blk

# Pad the last block to full size (TinyEMU requires all blocks to be identical size)
LAST_BLOCK=$(ls disk/blk*.bin | sort | tail -1)
truncate -s "${BLOCK_BYTES}" "${LAST_BLOCK}"

# Blocks that are entirely zero are not served: the loader treats a missing
# block as zeros. Most of the kernel slots and the empty B/application
# partitions fall in this category.
ZERO_BLOCK=$(mktemp)
truncate -s "${BLOCK_BYTES}" "$ZERO_BLOCK"
N_ZERO=0
for blk in disk/blk*.bin; do
    if cmp -s "$blk" "$ZERO_BLOCK"; then
        rm -f "$blk"
        N_ZERO=$((N_ZERO + 1))
    fi
done
rm -f "$ZERO_BLOCK"

# Create the block descriptor
# NOTE: TinyEMU block_size is in KB
cat > disk/blk.txt << EOT
{
  block_size: ${BLOCK_SIZE},
  n_block: ${N_BLOCKS},
}
EOT

rm -f disk.img

echo "Done!"
echo "  OpenSBI: opensbi.bin ($(du -h opensbi.bin | cut -f1))"
echo "  U-Boot:  u-boot.bin ($(du -h u-boot.bin | cut -f1))"
echo "  Disk:    ${N_BLOCKS} blocks of ${BLOCK_SIZE}KB in disk/, $((N_BLOCKS - N_ZERO)) non-empty ($(du -sh disk | cut -f1))"
echo ""
echo "Serve this directory, e.g.: python3 -m http.server 8000"
echo "Then open: http://localhost:8000/index.html"
