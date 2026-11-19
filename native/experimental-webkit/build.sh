#!/bin/bash
# 构建 AchiPaint.app（macOS 原生壳 + WKWebView）
#
# 为什么不用 Electron：macOS 27 拒绝 ad-hoc 签名进程的 task_name_for_pid，
# Electron 启动必查这一项，没有开发者证书就打不开（连官方原版都打不开）。
# WKWebView 是原生进程，绕过这个问题，而且实测支持 desynchronized canvas。
set -e
cd "$(dirname "$0")/.."

APP="native/build/AchiPaint.app"
ENT="build/entitlements.mac.plist"

echo "1/5 编译 Swift 壳"
mkdir -p native/build
swiftc -O -swift-version 5 -strict-concurrency=minimal \
  native/AchiPaint.swift -o native/build/AchiPaint \
  -framework Cocoa -framework WebKit

echo "2/5 组装 bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp native/build/AchiPaint "$APP/Contents/MacOS/AchiPaint"
cp build/icon.icns "$APP/Contents/Resources/icon.icns"
# 目标目录已存在时 cp -R src 会复制成 web/src/src，必须先删
rm -rf "$APP/Contents/Resources/web/src"
cp -R src "$APP/Contents/Resources/web/src"
cp native/Info.plist "$APP/Contents/Info.plist"

echo "3/5 ad-hoc 签名"
codesign --force --sign - "$APP" 2>&1 | grep -v "replacing" || true

echo "4/5 校验"
codesign --verify --strict "$APP"
echo "5/5 完成：$APP"
du -sh "$APP"
