"""SpriteForge sync server.

Serves the web pixel editor and stores sprites straight into a Unity project:
  <Unity>/SpriteForge/<name>.sforge.json   - editable source (layers, frames)
  <Unity>/SpriteForge/<name>.info.json     - small sidecar the Unity importer reads
  <Unity>/Assets/<folder>/<name>.png       - horizontal sprite sheet Unity imports

The Unity editor script polls /api/unity/poll and calls AssetDatabase.Refresh()
whenever a sprite changes. Only standard library is used.
"""
import base64
import json
import os
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "docs")
CONFIG_PATH = os.path.join(ROOT, "config.json")
HOST = "127.0.0.1"
PORT = int(os.environ.get("SPRITEFORGE_PORT", "7777"))
NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
FOLDER_RE = re.compile(r"^[A-Za-z0-9_\-/ ]{1,128}$")
# Pages allowed to talk to this server from the browser (the GitHub Pages site + the local copy).
ALLOWED_ORIGINS = {
    "https://sunakle.github.io",
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
}

DEFAULT_CONFIG = {"unity_project": "", "sprites_folder": "Sprites/SpriteForge", "ppu": 16}

lock = threading.Lock()
state = {"rev": 0, "changes": [], "unity_seen": 0.0, "unity_name": "", "unity_path": ""}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def unity_valid(path):
    return bool(path) and os.path.isdir(os.path.join(path, "Assets"))


def dirs(cfg):
    """Returns (source_dir, png_dir). Falls back to ./data when no Unity project is set."""
    unity = cfg.get("unity_project", "")
    if unity_valid(unity):
        src = os.path.join(unity, "SpriteForge")
        out = os.path.join(unity, "Assets", *cfg["sprites_folder"].strip("/").split("/"))
    else:
        src = os.path.join(ROOT, "data", "projects")
        out = os.path.join(ROOT, "data", "export")
    os.makedirs(src, exist_ok=True)
    os.makedirs(out, exist_ok=True)
    return src, out


def bump(name, action):
    with lock:
        state["rev"] += 1
        state["changes"].append({"rev": state["rev"], "name": name, "action": action})
        state["changes"] = state["changes"][-200:]


def decode_data_url(url):
    if not isinstance(url, str) or not url.startswith("data:image/png;base64,"):
        raise ValueError("expected PNG data URL")
    return base64.b64decode(url.split(",", 1)[1])


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def log_message(self, fmt, *args):
        if "/api/unity/poll" in self.path or "/api/status" in self.path:
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def do_OPTIONS(self):
        # CORS + Private Network Access preflight for the https GitHub Pages site.
        if not self.origin_ok():
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    # ---- helpers -------------------------------------------------------
    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024 * 1024:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def route(self):
        u = urlparse(self.path)
        parts = [unquote(p) for p in u.path.split("/") if p]
        return parts, parse_qs(u.query)

    # ---- verbs ---------------------------------------------------------
    def do_GET(self):
        parts, q = self.route()
        if not parts or parts[0] != "api":
            return super().do_GET()
        try:
            self.api_get(parts[1:], q)
        except Exception as e:  # noqa: BLE001
            self.send_json({"error": str(e)}, 500)

    def do_PUT(self):
        self.dispatch_write("PUT")

    def do_POST(self):
        self.dispatch_write("POST")

    def do_DELETE(self):
        self.dispatch_write("DELETE")

    def dispatch_write(self, verb):
        parts, _ = self.route()
        if not self.origin_ok():
            return self.send_json({"error": "origin not allowed"}, 403)
        try:
            if parts[:1] != ["api"]:
                return self.send_json({"error": "not found"}, 404)
            self.api_write(verb, parts[1:])
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            self.send_json({"error": str(e)}, 500)

    # ---- API -----------------------------------------------------------
    def api_get(self, p, q):
        cfg = load_config()
        if p == ["status"]:
            with lock:
                seen = state["unity_seen"]
                return self.send_json({
                    "rev": state["rev"],
                    "unity_connected": time.time() - seen < 5,
                    "unity_name": state["unity_name"],
                    "unity_path": state["unity_path"],
                    "config": cfg,
                    "unity_project_valid": unity_valid(cfg["unity_project"]),
                })

        if p == ["unity", "poll"]:
            since = int((q.get("since") or ["-1"])[0])
            path = (q.get("project") or [""])[0]
            with lock:
                state["unity_seen"] = time.time()
                state["unity_name"] = (q.get("name") or [""])[0]
                state["unity_path"] = path
                changes = [c for c in state["changes"] if since >= 0 and c["rev"] > since]
                rev = state["rev"]
            # First connection from Unity with nothing configured: adopt that project.
            if path and not unity_valid(cfg["unity_project"]) and unity_valid(path):
                cfg["unity_project"] = path
                save_config(cfg)
            return self.send_json({"rev": rev, "changes": changes})

        if p == ["sprites"]:
            src, out = dirs(cfg)
            names = {}
            for f in os.listdir(src):
                if f.endswith(".sforge.json"):
                    n = f[: -len(".sforge.json")]
                    names.setdefault(n, {})["project"] = True
                    names[n]["mtime"] = os.path.getmtime(os.path.join(src, f))
            for f in os.listdir(out):
                if f.lower().endswith(".png"):
                    n = f[:-4]
                    names.setdefault(n, {})["png"] = True
                    names[n].setdefault("mtime", os.path.getmtime(os.path.join(out, f)))
            items = [{"name": n, "project": v.get("project", False), "png": v.get("png", False),
                      "mtime": v.get("mtime", 0)} for n, v in names.items()]
            items.sort(key=lambda i: -i["mtime"])
            return self.send_json({"sprites": items})

        if len(p) >= 2 and p[0] == "sprites":
            name = p[1]
            if not NAME_RE.match(name):
                return self.send_json({"error": "bad name"}, 400)
            src, out = dirs(cfg)
            if len(p) == 3 and p[2] == "png":
                path = os.path.join(out, name + ".png")
                if not os.path.isfile(path):
                    return self.send_json({"error": "not found"}, 404)
                with open(path, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            path = os.path.join(src, name + ".sforge.json")
            if not os.path.isfile(path):
                return self.send_json({"error": "not found"}, 404)
            with open(path, "r", encoding="utf-8") as f:
                return self.send_json(json.load(f))

        self.send_json({"error": "not found"}, 404)

    def api_write(self, verb, p):
        cfg = load_config()
        if verb == "POST" and p == ["config"]:
            body = self.read_json()
            unity = str(body.get("unity_project", cfg["unity_project"])).strip().strip('"')
            folder = str(body.get("sprites_folder", cfg["sprites_folder"])).strip().strip("/")
            ppu = int(body.get("ppu", cfg["ppu"]))
            if unity and not unity_valid(unity):
                raise ValueError("В этой папке нет Assets — это не Unity-проект")
            if not FOLDER_RE.match(folder) or ".." in folder:
                raise ValueError("Недопустимое имя папки")
            cfg.update({"unity_project": unity, "sprites_folder": folder, "ppu": max(1, min(ppu, 4096))})
            save_config(cfg)
            return self.send_json({"ok": True, "config": cfg})

        if len(p) == 2 and p[0] == "sprites":
            name = p[1]
            if not NAME_RE.match(name):
                raise ValueError("Имя: только латиница, цифры, _ и -")
            src, out = dirs(cfg)
            if verb == "DELETE":
                for path in (os.path.join(src, name + ".sforge.json"),
                             os.path.join(src, name + ".info.json"),
                             os.path.join(out, name + ".png"),
                             os.path.join(out, name + ".anim")):
                    if os.path.isfile(path):
                        os.remove(path)
                bump(name, "delete")
                return self.send_json({"ok": True})
            if verb == "PUT":
                body = self.read_json()
                project = body.get("project")
                info = body.get("info") or {}
                png = decode_data_url(body.get("png"))
                if not isinstance(project, dict):
                    raise ValueError("missing project")
                info["name"] = name
                info.setdefault("ppu", cfg["ppu"])
                write_atomic(os.path.join(src, name + ".sforge.json"),
                             json.dumps(project, ensure_ascii=False).encode("utf-8"))
                write_atomic(os.path.join(src, name + ".info.json"),
                             json.dumps(info, ensure_ascii=False, indent=2).encode("utf-8"))
                write_atomic(os.path.join(out, name + ".png"), png)
                bump(name, "save")
                with lock:
                    rev = state["rev"]
                return self.send_json({"ok": True, "rev": rev, "png_path": os.path.join(out, name + ".png")})

        self.send_json({"error": "not found"}, 404)


def main():
    if not os.path.isfile(CONFIG_PATH):
        save_config(dict(DEFAULT_CONFIG))
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"SpriteForge: http://{HOST}:{PORT}")
    cfg = load_config()
    print("Unity project:", cfg["unity_project"] or "(не задан — откройте Unity с плагином или укажите путь на сайте)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
