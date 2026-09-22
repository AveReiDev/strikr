#!/usr/bin/env python3
"""
Dev server. Not part of the app — the finished app is plain static files.

Two reasons it exists:

  1. The app loads data/config.json and data/combos.json at runtime, which
     browsers refuse to do from a file:// path. It needs to be served.
  2. Wake Lock only works in a "secure context", meaning https or localhost.
     Plain http on a LAN address does not count, so on the phone
     navigator.wakeLock would simply be missing and the screen would sleep
     mid-workout. Hence https with a self-signed certificate.

  python3 serve.py            -> https on port 8443
  python3 serve.py 9000       -> https on port 9000
  python3 serve.py --http     -> plain http on 8000 (fine on this Mac, no
                                 wake lock on the phone)

Certificate is generated on first run and is tied to your current Wi-Fi
address. If your Mac's IP changes, delete dev-cert.pem and dev-key.pem and
run this again. Nothing leaves your LAN.
"""

import errno
import http.server
import os
import socket
import ssl
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(HERE, "dev-cert.pem")
KEY = os.path.join(HERE, "dev-key.pem")


def lan_ip():
    """Best-effort local address. No packets are actually sent."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 1))   # TEST-NET-1, unroutable
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    print(f"generating self-signed certificate for {ip} ...")
    subprocess.check_call([
        "openssl", "req", "-x509",
        "-newkey", "rsa:2048",
        "-sha256",
        "-days", "30",
        "-nodes",
        "-keyout", KEY,
        "-out", CERT,
        "-subj", f"/CN={ip}",
        "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost",
        "-addext", "extendedKeyUsage=serverAuth",
        "-addext", "basicConstraints=critical,CA:FALSE",
    ])
    print("done\n")


class Handler(http.server.SimpleHTTPRequestHandler):
    """No caching, so a reload on the phone always gets the newest file."""

    def do_GET(self):
        if self.path == "/install-cert":
            self._serve_cert()
            return
        super().do_GET()

    def _serve_cert(self):
        """Serve the dev certificate for installation on iOS."""
        try:
            with open(CERT, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-pem-file")
            self.send_header("Content-Disposition", "attachment; filename=strikr-dev.pem")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_error(404, "No certificate found")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    args = sys.argv[1:]
    plain = "--http" in args
    args = [a for a in args if a != "--http"]
    port = int(args[0]) if args else (8000 if plain else 8443)

    os.chdir(HERE)
    ip = lan_ip()
    scheme = "http" if plain else "https"

    try:
        httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        print(f"\nPort {port} is already in use.\n")
        print("Almost always this means you already have a server running in")
        print("another terminal tab. It reads files fresh from disk on every")
        print("request, so it is already serving the latest code — you do not")
        print("need a second one.\n")
        print(f"  Just open:  {scheme}://{ip}:{port}/index.html\n")
        print("If you would rather restart it cleanly:\n")
        print(f"  kill $(lsof -ti tcp:{port})\n")
        print(f"Or run this one on a different port:  python3 serve.py {port + 1}\n")
        sys.exit(1)

    if not plain:
        ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    print("STRIKR dev server")
    print(f"  on this Mac : {scheme}://localhost:{port}/index.html")
    print(f"  on the phone: {scheme}://{ip}:{port}/index.html")
    if plain:
        print("\n  NOTE: plain http — navigator.wakeLock will be unavailable on the phone.")
    else:
        print("\n  Safari will warn the certificate is untrusted. That is expected:")
        print("  tap Show Details, then 'visit this website', then Visit.")
        print(f"\n  ── OFFLINE / GYM USE ──")
        print(f"  After loading the app, go to Settings → About and check that")
        print(f"  'Offline ready' says 'Yes'. If it says 'No' or 'error', you may")
        print(f"  need to install the dev certificate on your phone:")
        print(f"    1. Open {scheme}://{ip}:{port}/install-cert in Safari on the phone")
        print(f"    2. Settings → General → VPN & Device Management → install the profile")
        print(f"    3. Settings → General → About → Certificate Trust Settings → enable trust")
        print(f"    4. Reload the app")
    print("\n  ctrl-C to stop\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
