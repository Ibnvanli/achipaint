#!/usr/bin/env python3
"""本地静态服务。

不能直接双击 index.html：项目是原生 ES module + fetch 加载 .myb 笔刷和 wasm，
file:// 协议下浏览器会拦掉。所以起一个本地 http 服务。

    python3 serve.py            # 默认 8899
    python3 serve.py 9000       # 换端口

打开 http://127.0.0.1:8899/src/index.html
"""
import http.server
import socketserver
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 开发期别让浏览器缓存住脚本，改完刷新就是新的
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # 默认 backlog 只有 5，浏览器一口气开六七个连接就会被拒，
    # 表现成随机的 ERR_CONNECTION_RESET
    request_queue_size = 128


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    with Server(('127.0.0.1', port), Handler) as httpd:
        print(f'http://127.0.0.1:{port}/src/index.html')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
