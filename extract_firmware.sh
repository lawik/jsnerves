#!/bin/sh
#
# Extract kernel and rootfs from a Nerves firmware file for use with JSNerves.
#
# Usage:
#   ./extract_firmware.sh <firmware.fw> <system_artifacts_dir>
#
# Example:
#   ./extract_firmware.sh ../my_app/_build/jslinux_dev/nerves/images/my_app.fw \
#     ../nerves_system_jslinux/.nerves/artifacts/nerves_system_jslinux-portable-0.2.0
#

set -e

BLOCK_SIZE=256  # KB

if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <firmware.fw> <system_artifacts_dir>"
    echo ""
    echo "  firmware.fw          Path to the Nerves .fw file"
    echo "  system_artifacts_dir Path to the system build artifacts"
    echo ""
    echo "The system artifacts directory is typically:"
    echo "  ../nerves_system_jslinux/.nerves/artifacts/nerves_system_jslinux-portable-*"
    exit 1
fi

FW_FILE="$1"
ARTIFACTS_DIR="$2"

if [ ! -f "$FW_FILE" ]; then
    echo "Error: Firmware file not found: $FW_FILE"
    exit 1
fi

if [ ! -d "$ARTIFACTS_DIR" ]; then
    echo "Error: Artifacts directory not found: $ARTIFACTS_DIR"
    exit 1
fi

KERNEL_IMAGE="$ARTIFACTS_DIR/images/Image"
if [ ! -f "$KERNEL_IMAGE" ]; then
    echo "Error: Kernel image not found: $KERNEL_IMAGE"
    exit 1
fi

echo "Extracting firmware..."

# Clean up old files
rm -f root-riscv64/* root-riscv64.bin kernel-riscv64.bin

# Extract rootfs from firmware using fwup
fwup "$FW_FILE" -d root-riscv64.bin

# Copy the kernel
cp "$KERNEL_IMAGE" kernel-riscv64.bin

# Split the rootfs into chunks for lazy loading in the browser
echo "Splitting rootfs into ${BLOCK_SIZE}KB blocks..."
BLOCK_BYTES=$((BLOCK_SIZE * 1024))
FILE_SIZE=$(stat -c%s root-riscv64.bin)
N_BLOCKS=$(( (FILE_SIZE + BLOCK_BYTES - 1) / BLOCK_BYTES ))

mkdir -p root-riscv64

# Split the file
split -b "${BLOCK_BYTES}" -d -a 9 --additional-suffix=.bin root-riscv64.bin root-riscv64/blk

# Pad the last block to full size (TinyEMU requires all blocks to be identical size)
LAST_BLOCK=$(ls root-riscv64/blk*.bin | sort | tail -1)
truncate -s "${BLOCK_BYTES}" "${LAST_BLOCK}"

# Create the block descriptor
# NOTE: TinyEMU block_size is in KB
cat > root-riscv64/blk.txt << EOF
{
  block_size: ${BLOCK_SIZE},
  n_block: ${N_BLOCKS},
}
EOF

echo "Done!"
echo "  Kernel: kernel-riscv64.bin ($(du -h kernel-riscv64.bin | cut -f1))"
echo "  Rootfs: ${N_BLOCKS} blocks of ${BLOCK_SIZE}KB in root-riscv64/"
echo ""
echo "Start the server with: ./start.sh"
echo "Then open: http://localhost:8000/index.html"
