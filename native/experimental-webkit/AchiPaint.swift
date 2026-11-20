// AchiPaint 的 macOS 原生外壳
//
// 不采用 Electron 的原因：
//   macOS 27 拒绝 ad-hoc 签名的进程调用 task_name_for_pid，
//   Electron 启动时会执行该检查，导致官方原版 Electron.app 同样无法启动。
//   未持有开发者证书（$99/年）时无法绕过。
//
// 采用 WKWebView 的原因：
//   它是系统自带的 Chromium 级引擎，且为原生进程，不触发上述签名检查；
//   Tauri 在 macOS 上同样使用它，因此改用此后壳也等同于提前验证 Tauri 路线。
//
// 采用自定义 achi:// 协议而非 file:// 的原因：
//   页面使用原生 ES module，并通过 fetch 获取 .myb 笔刷与 wasm，
//   这些在 file:// 下会被 WebKit 拦截。

import Cocoa
import WebKit

let SCHEME = "achi"

// MARK: - 资源协议

final class WebHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) {
        self.root = root.standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(NSError(domain: SCHEME, code: 400))
            return
        }
        var rel = url.path
        while rel.hasPrefix("/") { rel.removeFirst() }

        let target = root.appendingPathComponent(rel).standardizedFileURL
        guard target.path.hasPrefix(root.path) else {
            task.didFailWithError(NSError(domain: SCHEME, code: 403))
            return
        }
        guard let data = try? Data(contentsOf: target) else {
            task.didFailWithError(NSError(domain: SCHEME, code: 404))
            return
        }

        let headers = [
            "Content-Type": Self.mime(target.pathExtension),
            /* 三项响应头缺一不可：仅设置 Cache-Control 时 WebKit 仍会缓存脚本，
             * 导致修改代码并重启应用后仍加载旧版本（曾出现该问题，且难以察觉）。 */
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*",
        ]
        guard let resp = HTTPURLResponse(url: url, statusCode: 200,
                                         httpVersion: "HTTP/1.1",
                                         headerFields: headers) else {
            task.didFailWithError(NSError(domain: SCHEME, code: 500))
            return
        }
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // 无需处理：文件为一次性完整读取
    }

    static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "myb": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - 应用

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let selfTest = CommandLine.arguments.contains("--selftest")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
    }

    func buildWindow() {
        // 每次启动时清除 URL 缓存，避免旧脚本覆盖新代码
        URLCache.shared.removeAllCachedResponses()
        URLCache.shared.diskCapacity = 0
        URLCache.shared.memoryCapacity = 0

        guard let res = Bundle.main.resourceURL else { return }
        let webRoot = res.appendingPathComponent("web")

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(WebHandler(root: webRoot), forURLScheme: SCHEME)

        // 页面通过 .electron 类为 macOS 窗口控制按钮让位，并将标题栏设为可拖动区域，
        // 复用网页版已有的适配逻辑，外壳仅负责添加该标记。
        let js = "document.documentElement.classList.add('electron');"
        config.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // 绘画应用：避免 WebKit 在后台暂停 rAF 回调
        config.suppressesIncrementalRendering = false

        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")   // 让 CSS 的底色透出来
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "AchiPaint"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 900, height: 600)
        window.backgroundColor = NSColor(srgbRed: 0.078, green: 0.078, blue: 0.075, alpha: 1)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)

        webView.load(URLRequest(url: URL(string: "\(SCHEME)://local/src/index.html")!))
        NSApp.activate(ignoringOtherApps: true)
    }

    // 无头自检：执行一段脚本，输出引擎状态、工具数量与合成能力
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard selfTest else { return }
        let js = """
        const wait = ms => new Promise(r => setTimeout(r, ms));
        window.__errs = [];
        window.onerror = (m, src, line, col) => { window.__errs.push(String(m) + ' @' + line + ':' + col); };
        window.addEventListener('unhandledrejection', e => window.__errs.push('reject: ' + String(e.reason)));
        for (let i = 0; i < 60 && !(window.__achi && window.__achi.hk && __achi.hk.ready); i++) await wait(100);
        const out = {
          hkReady: !!(window.__achi && __achi.hk && __achi.hk.ready),
          visibility: document.visibilityState,
          hidden: document.hidden,
        };

        window.__achiPerf = [];
        __achi.redraw();
        await wait(300);
        out.afterRedraw = (window.__achiPerf || []).length;
        out.zoomText = document.getElementById('st-zoom').textContent;

        const view = document.getElementById('view');
        const rect = view.getBoundingClientRect();
        out.rect = [Math.round(rect.width), Math.round(rect.height)];

        const fire = (t, x, y) => view.dispatchEvent(new PointerEvent(t, {
          clientX: x, clientY: y, pressure: 1, pointerId: 1, pointerType: 'pen',
          bubbles: true, isPrimary: true,
        }));
        fire('pointerdown', rect.left + 150, rect.top + 250);
        out.hkActiveAfterDown = __achi.hk.active;
        for (let i = 0; i < 40; i++) {
          fire('pointermove', rect.left + 150 + i * 8, rect.top + 250);
          await wait(8);
        }
        fire('pointerup', rect.left + 470, rect.top + 250);
        await wait(400);

        out.hist = __achi.history.stack.length;
        out.perfCount = (window.__achiPerf || []).length;
        let ink = 0;
        for (const t of __achi.doc.layer.canvas.tiles.values()) {
          const d = t.ctx.getImageData(0, 0, 256, 256).data;
          for (let k = 3; k < d.length; k += 4) if (d[k] > 8) ink++;
        }
        out.ink = ink;
        out.errs = (window.__errs || []).slice(0, 5);

        const perfs = (window.__achiPerf || []).slice(-300);
        const fr = perfs.map(p => p.frame).filter(v => v > 0).sort((a,b)=>a-b);
        const lag = perfs.map(p => p.inputLag).filter(v => v > 0).sort((a,b)=>a-b);
        const gaps = perfs.map(p => p.gap).filter(v => v > 0).sort((a,b)=>a-b);
        const q = (arr, p) => arr.length ? +arr[Math.min(arr.length-1, Math.floor(arr.length*p))].toFixed(2) : null;
        out.perf = {
          samples: perfs.length,
          frameMs: { p50: q(fr,0.5), p90: q(fr,0.9), max: q(fr,1) },
          inputLagMs: { p50: q(lag,0.5), p90: q(lag,0.9), max: q(lag,1) },
          frameGapMs: { p50: q(gaps,0.5), p90: q(gaps,0.9), max: q(gaps,1) },
          fps: gaps.length ? +(1000 / gaps.reduce((a,b)=>a+b,0) * gaps.length).toFixed(1) : null,
        };

        // 确认页面实际加载的 main.js 版本
        try {
          const txt = await (await fetch('achi://local/src/main.js')).text();
          out.jsVersion = {
            hasFrameQueuedAt: txt.includes('frameQueuedAt'),
            hasPerfMark: txt.includes('perfMark'),
            length: txt.length,
          };
        } catch (e) { out.jsVersion = 'fetch-fail: ' + e; }

        // 手动捕获一帧，检查 st-zoom 是否会被 paint 改写
        const zoomEl = document.getElementById('st-zoom');
        const before = zoomEl.textContent;
        zoomEl.textContent = 'PROBE';
        __achi.redraw();
        await wait(600);
        out.probe = { before, after: zoomEl.textContent };
        // 手动执行一次 requestAnimationFrame，确认其是否回调
        let rafFired = false;
        const t0 = performance.now();
        await new Promise(r => requestAnimationFrame(() => { rafFired = true; r(); }));
        out.raf = { fired: rafFired, ms: +(performance.now() - t0).toFixed(1) };
        return JSON.stringify(out);
        """

        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            var out: String
            switch result {
            case .success(let value): out = (value as? String) ?? "nil"
            case .failure(let error): out = "ERR: \(error)"
            }
            try? out.write(toFile: "/tmp/achi-selftest.json", atomically: true, encoding: .utf8)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
        }
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 AchiPaint", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 AchiPaint", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 AchiPaint", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // 不放置撤销 / 重做菜单项：撤销由画布自身处理，通过页面的 ⌘Z 触发。
        // 菜单一旦绑定 Cmd+Z，页面将无法再收到该按键事件。
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "视图")
        let fs = NSMenuItem(title: "全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.control, .command]
        viewMenu.addItem(fs)
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
