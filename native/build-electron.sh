#!/bin/bash
# 构建 Electron 版 AchiPaint.app
#
# 为什么要套一层 launcher：
#   macOS 27 用 LaunchServices 直接启动 Electron.app 时，Electron 内部的
#   task_name_for_pid 会失败（adhoc 签名没有 Apple 签发的 Team ID），app 起不来。
#   但用同样的二进制、从 shell 直接 exec 却正常运行。
#   所以做一个极小的 Swift launcher（由 LaunchServices 启动），
#   它在 run loop 里用 Process 拉起 Electron 子进程 —— 这样就绕开了那条路径。
#
# 另一个坑：LaunchServices 不接受从 /tmp 启动的 app（lsregister 报 -10811），
# 必须装在 ~/Applications 或 /Applications 下。
set -e
cd "$(dirname "$0")/.."

ROOT="$PWD"
OUT="$ROOT/dist/electron"
SIG="AchiPaint Self Signed"

echo "1/6 准备打包源"
rm -rf "$OUT"
rm -rf /tmp/achi-electron-src && mkdir -p /tmp/achi-electron-src
cp native/electron/main.js /tmp/achi-electron-src/electron-main.js
cp build/icon.icns /tmp/achi-electron-src/icon.icns
rm -rf /tmp/achi-electron-src/src && cp -R src /tmp/achi-electron-src/src
cat > /tmp/achi-electron-src/package.json <<'JSON'
{
  "name": "achipaint",
  "productName": "AchiPaint",
  "version": "0.1.0",
  "main": "electron-main.js",
  "description": "轻核心、边缘插件的绘画工具",
  "license": "MIT"
}
JSON

echo "2/6 打包 Electron"
cd /tmp/achi-electron-src
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
  npx --yes @electron/packager . AchiPaint \
  --platform=darwin --arch=arm64 --electron-version=45.4.1 \
  --out="$OUT" --overwrite \
  --app-bundle-id=org.achipaint.app --app-version=0.1.0 \
  --icon=icon.icns >/dev/null 2>&1

cd "$ROOT"

echo "3/6 编译 launcher"
mkdir -p "$OUT/launcher/Contents/MacOS" "$OUT/launcher/Contents/Resources"
cat > /tmp/achi-launcher.swift <<'SWIFT'
import Cocoa
import Foundation

// 极简 launcher：自己什么都不画，只负责把 Electron 子进程拉起来。
// 存在的唯一理由是「LaunchServices 启动的那一层」不能是 Electron 本身。
class Delegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ n: Notification) {
        let inner = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/AchiPaint.app/Contents/MacOS/AchiPaint")
        let p = Process()
        p.executableURL = inner
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        p.environment = env
        do {
            try p.run()
        } catch {
            NSApp.terminate(nil)
            return
        }
        DispatchQueue.global().async {
            p.waitUntilExit()
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let d = Delegate()
app.delegate = d
app.run()
SWIFT
swiftc -O /tmp/achi-launcher.swift -o "$OUT/launcher/Contents/MacOS/Launcher" -framework Cocoa
rm -rf "$OUT/launcher/Contents/Resources/AchiPaint.app"
cp -R "$OUT/AchiPaint-darwin-arm64/AchiPaint.app" "$OUT/launcher/Contents/Resources/AchiPaint.app"

echo "4/6 写 Info.plist"
cat > "$OUT/launcher/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>AchiPaint</string>
<key>CFBundleDisplayName</key><string>AchiPaint</string>
<key>CFBundleExecutable</key><string>Launcher</string>
<key>CFBundleIdentifier</key><string>org.achipaint.launcher</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
cp build/icon.icns "$OUT/launcher/Contents/Resources/icon.icns"

echo "5/6 签名"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIG"; then
  echo "   用自签名证书：$SIG"
  codesign --force --deep --sign "$SIG" --options runtime "$OUT/AchiPaint-darwin-arm64/AchiPaint.app" 2>/dev/null || true
fi
codesign --force --sign - "$OUT/launcher" 2>&1 | grep -v replacing || true

echo "6/6 安装到 ~/Applications"
rm -rf ~/Applications/AchiPaint.app
cp -R "$OUT/launcher" ~/Applications/AchiPaint.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ~/Applications/AchiPaint.app 2>/dev/null || true
echo "完成：~/Applications/AchiPaint.app"
du -sh ~/Applications/AchiPaint.app
