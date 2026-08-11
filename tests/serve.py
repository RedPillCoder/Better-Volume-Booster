import http.server, functools, threading, os

def run(port):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(os.path.dirname(os.path.abspath(__file__)), "site"))
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    srv.serve_forever()

for p in (8000, 8001):
    threading.Thread(target=run, args=(p,), daemon=True).start()

print("serving on 8000 and 8001", flush=True)
import time
while True:
    time.sleep(3600)
