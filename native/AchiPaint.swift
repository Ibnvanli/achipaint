// AchiPaint 的 macOS 原生壳
//
// 为什么不是 Electron：
//   macOS 27 对 ad-hoc 签名的进程拒绝 task_name_for_pid，
//   Electron 启动时要做这个检查，于是连官方原版 Electron.app 都打不开。
//   没有开发者证书（$99/年）就绕不过去。
//
// 为什么是 WKWebView：
//   它是系统自带的 Chrome 级引擎，原生进程，不需要那套签名检查；
//   而且 Tauri 在 macOS 上用的也是它 —— 外壳换成它，等于提前把 Tauri 那条路走通。
//
// 用自定义 achi:// 协议而不是 file://：
//   页面是原生 ES module，还用 fetch 取 .myb 笔刷和 wasm，
//   file:// 下这些会被 WebKit 拦掉。

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
            "Cache-Control": "no-store",
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
        // 无需处理：文件是一次读完的
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
        guard let res = Bundle.main.resourceURL else { return }
        let webRoot = res.appendingPathComponent("web")

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(WebHandler(root: webRoot), forURLScheme: SCHEME)

        // 页面里用 .electron 这个类给 macOS 红绿灯让位、把标题栏变成可拖动区，
        // 复用网页版已有的适配，壳这边只负责打上标记。
        let js = "document.documentElement.classList.add('electron');"
        config.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // 绘画应用：别让 WebKit 在后台把 rAF 掐掉
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

    // 无头自检：跑一段脚本把引擎状态、工具数、能否合成写出来
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard selfTest else { return }
        let js = """
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60 && !(window.__achi && __achi.hk && __achi.hk.ready); i++) await wait(100);

        const view = document.getElementById('view');
        const ctx = view.getContext('2d');
        const attrs = ctx.getContextAttributes ? ctx.getContextAttributes() : null;

        // 合成输入 + rAF：量从「事件送出」到「浏览器排帧」的调度延迟
        const rect = view.getBoundingClientRect();
        const out = [];
        for (let n = 0; n < 30; n++) {
          const t0 = performance.now();
          view.dispatchEvent(new PointerEvent('pointermove', {
            clientX: rect.left + 200 + n * 3,
            clientY: rect.top + 300,
            pressure: 1, pointerId: 1, pointerType: 'mouse', bubbles: true, isPrimary: true,
          }));
          await new Promise(r => requestAnimationFrame(r));
          out.push(performance.now() - t0);
        }
        out.sort((a,b)=>a-b);
        const pct = p => out[Math.min(out.length-1, Math.floor(out.length*p))];

        return JSON.stringify({
          desynchronized: attrs ? attrs.desynchronized : 'no-getContextAttributes',
          alpha: attrs ? attrs.alpha : null,
          coalescedEvents: typeof PointerEvent.prototype.getCoalescedEvents === 'function',
          offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
          rafFrameMs: { median: +pct(0.5).toFixed(2), p90: +pct(0.9).toFixed(2), max: +out[out.length-1].toFixed(2) },
          pixelRatio: devicePixelRatio,
          canvas: [view.width, view.height],
        });
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

        // 不放撤销/重做：撤销是画布自己的事，走页面的 ⌘Z。
        // 菜单一旦绑上 Cmd+Z，页面就再也收不到这个键。
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
