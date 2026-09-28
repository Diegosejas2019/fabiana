#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const publicDir = resolve(root, "apps/chat");
const pythonPath = resolve(root, ".venv/Scripts/python.exe");
const answerScript = resolve(root, "scripts/answer-memory.py");
const combinedChunksPath = resolve(root, "data/processed/combined-memory/chunks.jsonl");
const combinedIndexDir = resolve(root, "data/processed/combined-rag");
const defaultChunksPath = resolve(root, "data/processed/memory/chunks.jsonl");
const defaultIndexDir = resolve(root, "data/processed/rag");
const styleProfilePath = resolve(root, "data/processed/persona/persona-style.json");
const port = Number(process.env.PORT ?? 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/answer") {
      await handleAnswer(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(url.pathname, response, request.method === "HEAD");
      return;
    }

    response.writeHead(405).end("Method not allowed");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, () => {
  console.log(`Memoria AI local: http://localhost:${port}`);
});

async function handleAnswer(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const query = String(payload.query ?? "").trim();

  if (!query) {
    response.writeHead(400).end("Missing query");
    return;
  }

  const args = [
    answerScript,
    "--query",
    query,
    "--chunks",
    resolveChunksPath(),
    "--index-dir",
    resolveIndexDir(),
    "--top-k",
    String(Number(payload.topK ?? 8)),
    "--show-text"
  ];

  if (existsSync(styleProfilePath)) {
    args.push("--style-profile", styleProfilePath);
  }

  if (payload.role) {
    args.push("--role", String(payload.role));
  }

  if (payload.sourceType) {
    args.push("--source-type", String(payload.sourceType));
  }

  const result = await runPython(args);
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(result);
}

function resolveChunksPath() {
  return existsSync(combinedChunksPath) ? combinedChunksPath : defaultChunksPath;
}

function resolveIndexDir() {
  return existsSync(resolve(combinedIndexDir, "embeddings.npy")) ? combinedIndexDir : defaultIndexDir;
}

async function serveStatic(pathname, response, headOnly = false) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(resolve(publicDir, `.${requested}`));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream"
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function runPython(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(pythonPath, args, {
      cwd: root,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Python exited with ${code}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}
