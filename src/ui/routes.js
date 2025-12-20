const fs = require("fs/promises");
const path = require("path");

const UI_DIR = __dirname;

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function resolveUiFile(relativePath) {
  const safeRel = relativePath.replace(/^\/+/, "");
  const fullPath = path.resolve(UI_DIR, safeRel);
  if (!fullPath.startsWith(path.resolve(UI_DIR) + path.sep)) {
    return null;
  }
  return fullPath;
}

async function serveFile(filePath) {
  const data = await fs.readFile(filePath);
  return {
    status: 200,
    headers: { "Content-Type": contentTypeFor(filePath), "Cache-Control": "no-store" },
    body: data,
  };
}

async function handleUiRoute(req, parsedUrl) {
  const pathname = parsedUrl.pathname;

  if (pathname === "/favicon.ico") {
    return { status: 204, headers: {}, body: "" };
  }

  if ((pathname === "/" || pathname === "/ui" || pathname === "/ui/") && req.method === "GET") {
    return serveFile(resolveUiFile("index.html"));
  }

  if (pathname.startsWith("/ui/") && req.method === "GET") {
    const rel = pathname.slice("/ui/".length);
    const fullPath = resolveUiFile(rel);
    if (!fullPath) {
      return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Not Found" };
    }
    try {
      return await serveFile(fullPath);
    } catch (e) {
      return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Not Found" };
    }
  }

  return null;
}

module.exports = {
  handleUiRoute,
};

