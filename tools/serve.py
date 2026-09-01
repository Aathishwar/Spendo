#!/usr/bin/env python3
"""
Spendo - development server.

    python tools/serve.py [port]        default 8123

`python -m http.server` sends no cache headers at all, which lets the browser apply
heuristic freshness and quietly keep serving an edited ES module from memory. That
wastes a lot of time looking at a change that is already on disk. This sends
no-store on everything, so a reload is always a reload.

The phase 2 Express server sets no-cache on the same files for the same reason. Use
this only for development; it is not a production server.
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is noise while iterating; errors still surface.
        if not args or not str(args[1]).startswith('2'):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', port), handler) as httpd:
        print(f'Spendo dev server on http://127.0.0.1:{port}  (no-store, Ctrl+C to stop)')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
