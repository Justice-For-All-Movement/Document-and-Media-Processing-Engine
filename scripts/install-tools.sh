#!/usr/bin/env bash
# Installs the local processing tools this engine shells out to (Debian/Ubuntu). Run as root.
# Language packs (tesseract-ocr-<lang>, apertium-<pair>) are deployment configuration: adjust the two lists below.
set -euo pipefail
OCR_LANGUAGES="${OCR_LANGUAGES:-eng spa ukr}"
TRANSLATION_PAIRS="${TRANSLATION_PAIRS:-eng-spa}"
packages=(poppler-utils tesseract-ocr tesseract-ocr-osd imagemagick ffmpeg libimage-exiftool-perl pandoc
  libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw apertium python3 python3-numpy python3-pip
  util-linux fonts-dejavu-core)
for l in $OCR_LANGUAGES; do packages+=("tesseract-ocr-$l"); done
for p in $TRANSLATION_PAIRS; do packages+=("apertium-$p"); done
# Only needed to generate the test fixtures (synthesised speech):
if [ "${WITH_TEST_TOOLS:-0}" = "1" ]; then packages+=(espeak-ng sox); fi
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update
apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends "${packages[@]}"
# Local speech recognition: the PocketSphinx wheel bundles an en-US acoustic and language model.
python3 -m pip install --no-input pocketsphinx==5.1.1 2>/dev/null || python3 -m pip install --no-input --break-system-packages pocketsphinx==5.1.1
python3 -c "import numpy, pocketsphinx; print('python tools ok')"
