#!/bin/zsh
# Build "Lingo Dojo.app" from the AppleScript launcher + icon and install it to
# /Applications (Launchpad and Spotlight pick it up).
#
#   ./macos/build-app.sh
#
# Rebuild any time one of the four sources changes: Lingo Dojo.applescript (the
# Dock face), server-shim.c (the helper's compiled executable), server-runner.sh
# (what the shim execs) or icon-1024.png (render-icon.sh from icon.svg). Needs
# clang for the shim. The .app itself is a build product and is not committed —
# this script is the source of truth.
# Pattern lifted from wine-guide/macos/build-app.sh (Wine Guide.app), itself
# from trail-train/macos/build-app.sh (Basecamp.app).
set -euo pipefail
cd "$(dirname "$0")"
# The checkout this launcher serves is wherever this script lives (macos/..),
# not a hardcoded path: the applet's kill pattern and the runner's cd both get
# it baked in below, so a clone elsewhere just rebuilds.
REPO="$(cd .. && pwd -P)"

APP_NAME="Lingo Dojo"
# /Applications so the app shows up where every other app lives (Finder's
# sidebar favorite, Launchpad, Spotlight); admin-group writable, no sudo
DEST="/Applications/$APP_NAME.app"
ICON_PNG="icon-1024.png"
BUNDLE_ID="com.scalefreegan.lingodojo"

[ -f "$ICON_PNG" ] || { echo "missing $ICON_PNG — run macos/render-icon.sh first"; exit 1; }

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# 0. bake the repo path into the two sources that need it. `|` as the sed
# delimiter because the path has slashes; then refuse to build if a
# placeholder somehow survived (a launcher pointing at "__LINGODOJO_REPO__" would
# fail only at first click, with a confusing log).
bake() { sed "s|__LINGODOJO_REPO__|$REPO|g" "$1" > "$2"; ! grep -q __LINGODOJO_REPO__ "$2"; }
bake "Lingo Dojo.applescript" "$BUILD_DIR/Lingo Dojo.applescript"
bake server-runner.sh "$BUILD_DIR/server-runner.sh"

# 1. compile the stay-open applet (-s = stay open after run handler)
osacompile -s -o "$BUILD_DIR/$APP_NAME.app" "$BUILD_DIR/Lingo Dojo.applescript"

# 1b. kill osacompile's baked-in icon pipeline: modern macOS resolves the
# icon via CFBundleIconName -> Assets.car (which ships the generic scroll
# applet icon) and IGNORES CFBundleIconFile while they exist. Removing both
# makes the system fall back to our icns.
rm -f "$BUILD_DIR/$APP_NAME.app/Contents/Resources/Assets.car"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$BUILD_DIR/$APP_NAME.app/Contents/Info.plist" 2>/dev/null || true

# 2. icns from the 1024 master (iconutil wants the full size ladder)
ICONSET="$BUILD_DIR/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z $retina $retina "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD_DIR/$APP_NAME.app/Contents/Resources/applet.icns"

# 3. identity in the bundle plist (osacompile leaves generic applet values)
PLIST="$BUILD_DIR/$APP_NAME.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST"
# the applet sends Apple Events to Google Chrome (openDashboard focuses the
# app's existing tab instead of opening a new one). macOS only shows the
# Automation prompt for an app that carries a usage string; without one the
# events are refused silently (-1743) and every click falls back to a new tab.
/usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string Lingo Dojo focuses the Chrome tab it already has open instead of opening a new one." "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :NSAppleEventsUsageDescription Lingo Dojo focuses the Chrome tab it already has open instead of opening a new one." "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_NAME" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"

# 3b. helper app: "Lingo Dojo Server.app" — a faceless bundle that keeps the dev
# server as its child. Its executable is a COMPILED shim (server-shim.c) that
# execs server-runner.sh from Resources. History of this shape, because it
# has now inverted twice: pre-26.6.2, the script-as-executable bundle was the
# one whose Documents grant stuck and a compiled applet was silently denied;
# macOS 26.6.2 flipped it — a script executable runs as /bin/zsh (a platform
# binary tccd will neither prompt for nor match a grant to), so the helper
# was denied silently and even a Full Disk Access row didn't take. A real
# Mach-O gives tccd a promptable identity again (measured 2026-08-29).
HELPER="Lingo Dojo Server"
HELPER_APP="$BUILD_DIR/$APP_NAME.app/Contents/Helpers/$HELPER.app"
mkdir -p "$HELPER_APP/Contents/MacOS" "$HELPER_APP/Contents/Resources"
clang -O2 -o "$HELPER_APP/Contents/MacOS/LingoDojoServer" server-shim.c
cp "$BUILD_DIR/server-runner.sh" "$HELPER_APP/Contents/Resources/server-runner.sh"
# +x is a convenience for running it by hand while debugging; it is NOT the
# bundle's entry point any more, and the shim names the interpreter itself
# (execl "/bin/zsh"), so neither this bit nor the shebang is consulted at launch.
chmod +x "$HELPER_APP/Contents/Resources/server-runner.sh"
cp "$BUILD_DIR/$APP_NAME.app/Contents/Resources/applet.icns" "$HELPER_APP/Contents/Resources/helper.icns"
cat > "$HELPER_APP/Contents/Info.plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$HELPER</string>
  <key>CFBundleDisplayName</key><string>$HELPER</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID.server</string>
  <key>CFBundleExecutable</key><string>LingoDojoServer</string>
  <key>CFBundleIconFile</key><string>helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST_EOF

# 4. install (replace wholesale — a half-old bundle confuses LaunchServices)
# Re-sign AFTER every modification: swapping the icns and editing the plist
# breaks osacompile's seal, and Finder shows a broken-seal bundle with the
# generic icon instead of its own.
codesign --force --deep --sign - "$BUILD_DIR/$APP_NAME.app"

# TCC binds the helper's Documents grant to its exact code identity (cdhash).
# A rebuild that changes server-runner.sh changes the hash, and macOS often
# DENIES silently rather than re-prompting — warn when that's about to happen.
# -dvv prints no hash on current macOS; -dvvv prints `CDHash=` and, on some
# releases, only `CandidateCDHash sha256=` — take whichever appears first.
helper_hash() {
  codesign -dvvv "$1" 2>&1 | awk -F= '/^CDHash=/ || /^CandidateCDHash sha256=/ {print $2; exit}'
}
OLD_HASH=""
[ -d "$DEST/Contents/Helpers/$HELPER.app" ] && OLD_HASH="$(helper_hash "$DEST/Contents/Helpers/$HELPER.app")"

rm -rf "$DEST"
cp -R "$BUILD_DIR/$APP_NAME.app" "$DEST"
# refresh the LaunchServices registration so the icon updates immediately
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" 2>/dev/null || true
touch "$DEST"
# the Dock caches app icons aggressively; restart it (instant) so the fresh
# icon shows without a logout
killall Dock 2>/dev/null || true

echo "installed $DEST (serving $REPO)"
NEW_HASH="$(helper_hash "$DEST/Contents/Helpers/$HELPER.app")"
if [ -n "$OLD_HASH" ] && [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo ""
  echo "NOTE: the helper's code identity changed — its Documents grant is now stale"
  echo "and macOS may deny WITHOUT re-prompting. If the server won't start:"
  echo "  tccutil reset SystemPolicyDocumentsFolder $BUNDLE_ID.server"
  echo "then relaunch and approve the prompt (or add the helper under Full Disk Access)."
fi
echo "launch:  open -a \"$APP_NAME\"     quit: right-click the Dock icon → Quit (stops the server)"
