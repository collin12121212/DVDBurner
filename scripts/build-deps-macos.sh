#!/usr/bin/env bash
#
# Put the tools Burnhouse needs into <output-dir>, built to run on macOS 12.
#
# macOS only. Invoked by the GitHub Actions macOS build.
#
# WHY THIS EXISTS
#
# The obvious way to get these tools is Homebrew, and it does not work here. On
# the Intel runner image — macOS 15 — every Homebrew bottle is built with a
# minimum of macOS 14.0. The Mac this app is for is a 2017 MacBook Air, whose
# newest possible macOS is 12.7.6, and a binary that needs 14 does not run there
# at all. The app would install, launch, and fail the moment a video was added.
#
# So the tools are either taken prebuilt with a low deployment target, or
# compiled here with one. Nothing is installed with Homebrew.
#
#   ffmpeg, ffprobe  static x86_64 builds for macOS 10.13, from evermeet.cx.
#                    Static means no libraries to relocate and nothing to go
#                    stale on somebody else's machine.
#   dvdauthor,spumux compiled from source with MACOSX_DEPLOYMENT_TARGET=12.0,
#                    linked against libpng (also built here, also for 12) and
#                    otherwise only against libraries macOS ships.
#
# freetype, fontconfig and fribidi are deliberately NOT provided. dvdauthor's
# configure only uses them for text-based subtitles, which this app does not
# produce, and leaving them out keeps the build small and its dependencies to
# system libraries only.
#
# Usage: scripts/build-deps-macos.sh <output-dir>

set -euo pipefail

trap 'status=$?; if [ "${status}" -ne 0 ]; then
        echo "ERROR: build-deps-macos.sh stopped at line ${LINENO} (exit ${status})" >&2
      fi' ERR

OUT_DIR="${1:?usage: build-deps-macos.sh <output-dir>}"
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"

# The whole point of this script. Everything compiled here is built for this.
export MACOSX_DEPLOYMENT_TARGET=12.0

WORK="$(mktemp -d)"
PREFIX="${WORK}/local"
mkdir -p "${PREFIX}" "${WORK}/src"

LIBPNG_VERSION="1.6.44"
DVDAUTHOR_VERSION="0.7.2"

echo "Building for macOS ${MACOSX_DEPLOYMENT_TARGET} on $(uname -m)"
echo "Scratch: ${WORK}"
echo ""

# ------------------------------------------------------------------ ffmpeg ---
# Static Intel builds, documented as requiring macOS 10.13 or newer.
fetch_static() {
  local name="$1"
  local out="${OUT_DIR}/${name}"

  echo "==> ${name}: downloading a static build"
  curl -fL --retry 3 --retry-delay 2 -o "${WORK}/${name}.zip" \
    "https://evermeet.cx/ffmpeg/getrelease/${name}/zip"

  rm -rf "${WORK}/unzip-${name}"
  mkdir -p "${WORK}/unzip-${name}"
  unzip -q -o "${WORK}/${name}.zip" -d "${WORK}/unzip-${name}"

  local found
  found="$(find "${WORK}/unzip-${name}" -type f -name "${name}" | head -1)"
  if [ -z "${found}" ]; then
    echo "ERROR: no ${name} binary inside the downloaded archive" >&2
    ls -la "${WORK}/unzip-${name}" >&2 || true
    exit 1
  fi

  cp "${found}" "${out}"
  chmod +x "${out}"
  echo "    $(lipo -archs "${out}")  $(ls -la "${out}" | awk '{print $5}') bytes"
}

fetch_static ffmpeg
fetch_static ffprobe

# ------------------------------------------------------------------ libpng ---
# Needed by spumux to read the button highlight images, which are PNGs.
echo ""
echo "==> libpng ${LIBPNG_VERSION}: building (static, macOS ${MACOSX_DEPLOYMENT_TARGET})"
cd "${WORK}/src"
curl -fL --retry 3 --retry-delay 2 -o libpng.tar.gz \
  "https://download.sourceforge.net/libpng/libpng-${LIBPNG_VERSION}.tar.gz" || \
  curl -fL --retry 3 --retry-delay 2 -o libpng.tar.gz \
    "https://downloads.sourceforge.net/project/libpng/libpng16/${LIBPNG_VERSION}/libpng-${LIBPNG_VERSION}.tar.gz"

mkdir -p libpng && tar xzf libpng.tar.gz -C libpng --strip-components=1
cd libpng
./configure --prefix="${PREFIX}" --disable-shared --enable-static >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null
make install >/dev/null
echo "    installed into ${PREFIX}"

# --------------------------------------------------------------- dvdauthor ---
echo ""
echo "==> dvdauthor ${DVDAUTHOR_VERSION}: building (macOS ${MACOSX_DEPLOYMENT_TARGET})"
cd "${WORK}/src"
curl -fL --retry 3 --retry-delay 2 -o dvdauthor.tar.gz \
  "https://downloads.sourceforge.net/project/dvdauthor/dvdauthor/${DVDAUTHOR_VERSION}/dvdauthor-${DVDAUTHOR_VERSION}.tar.gz"

mkdir -p dvdauthor && tar xzf dvdauthor.tar.gz -C dvdauthor --strip-components=1
cd dvdauthor

# If configure refuses an argument, print what it would have accepted — working
# that out from "unrecognized option" is otherwise a build cycle of guesswork.
if ! PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig" \
     CPPFLAGS="-I${PREFIX}/include" \
     LDFLAGS="-L${PREFIX}/lib" \
     ./configure --prefix="${PREFIX}" >"${WORK}/dvdauthor-configure.log" 2>&1; then
  echo "ERROR: dvdauthor's configure failed. Its output:" >&2
  cat "${WORK}/dvdauthor-configure.log" >&2
  echo "" >&2
  echo "Options it accepts:" >&2
  ./configure --help >&2 || true
  exit 1
fi

make -j"$(sysctl -n hw.ncpu)" >/dev/null
make install >/dev/null

for tool in dvdauthor spumux; do
  if [ ! -x "${PREFIX}/bin/${tool}" ]; then
    echo "ERROR: ${tool} was not produced by the build" >&2
    ls -la "${PREFIX}/bin" >&2 || true
    exit 1
  fi
  cp "${PREFIX}/bin/${tool}" "${OUT_DIR}/${tool}"
  chmod +x "${OUT_DIR}/${tool}"
done

echo ""
echo "=============================================================="
echo "Built into ${OUT_DIR}"
for tool in ffmpeg ffprobe dvdauthor spumux; do
  MINOS="$(otool -l "${OUT_DIR}/${tool}" 2>/dev/null \
           | grep -A4 -E 'LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX' \
           | grep -E '^ *(minos|version) ' | head -1 | awk '{print $2}')"
  echo "  ${tool}: $(lipo -archs "${OUT_DIR}/${tool}")  minimum macOS ${MINOS:-unknown}"
done

# Anything that still points into the build machine's Homebrew or the scratch
# prefix would not exist on the user's Mac.
echo ""
echo "Checking nothing points at a build-machine path..."
LEAKS=0
for tool in ffmpeg ffprobe dvdauthor spumux; do
  if otool -L "${OUT_DIR}/${tool}" 2>/dev/null | tail -n +2 \
       | grep -qE '/usr/local|/opt/homebrew|'"${WORK}" ; then
    echo "ERROR: ${tool} references a build-machine path:" >&2
    otool -L "${OUT_DIR}/${tool}" | tail -n +2 \
      | grep -E '/usr/local|/opt/homebrew|'"${WORK}" >&2 || true
    LEAKS=$((LEAKS + 1))
  fi
done
if [ "${LEAKS}" -ne 0 ]; then
  exit 1
fi

echo "All four tools are self-contained."
rm -rf "${WORK}"
