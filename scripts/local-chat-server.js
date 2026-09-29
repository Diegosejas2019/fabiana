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
const addAssertionScript = resolve(root, "scripts/add-user-assertion.js");
const buildAssertionMemoriesScript = resolve(root, "scripts/build-user-assertion-memories.js");
const mergeMemoriesScript = resolve(root, "scripts/merge-memories.js");
const memoryCliScript = resolve(root, "packages/whatsapp-parser/src/cli.js");
const embedScript = resolve(root, "scripts/embed-memory-chunks.py");
const buildStyleProfileScript = resolve(root, "scripts/build-style-profile.js");
const whatsappMemoriesPath = resolve(root, "data/processed/memory/memories.jsonl");
const facebookMemoriesPath = resolve(root, "data/processed/facebook/memories.jsonl");
const assertionDir = resolve(root, "data/processed/user-assertions");
const assertionsPath = resolve(assertionDir, "assertions.jsonl");
const assertionMemoriesPath = resolve(assertionDir, "memories.jsonl");
const combinedMemoryDir = resolve(root, "data/processed/combined-memory");
const combinedMemoriesPath = resolve(combinedMemoryDir, "memories.jsonl");
const combinedChunksPath = resolve(root, "data/processed/combined-memory/chunks.jsonl");
const combinedIndexDir = resolve(root, "data/processed/combined-rag");
const defaultChunksPath = resolve(root, "data/processed/memory/chunks.jsonl");
const defaultIndexDir = resolve(root, "data/processed/rag");
const styleProfilePath = resolve(root, "data/processed/persona/persona-style.json");
const port = Number(process.env.PORT ?? 4173);
let assertionQueue = Promise.resolve();

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

    if (request.method === "POST" && url.pathname === "/api/assert") {
      await handleAssertion(request, response);
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

  const assertionText = extractAssertionText(query);
  if (assertionText) {
    const result = await saveUserAssertion(assertionText, payload);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result, null, 2));
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

async function handleAssertion(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const text = String(payload.text ?? payload.query ?? "").trim();

  if (!text) {
    response.writeHead(400).end("Missing assertion text");
    return;
  }

  const result = await saveUserAssertion(text, payload);
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(result, null, 2));
}

function extractAssertionText(query) {
  const patterns = [
    /^(?:dato|guardar dato|guarda dato|guardame este dato|guardame dato)\s*[:,-]?\s*(.+)$/i,
    /^(?:recorda|recordá|recuerda|aprende|te confirmo)\s+que\s+(.+)$/i,
    /^(?:quiero que guardes|guarda|guardá|guardar)\s+que\s+(.+)$/i,
    /^(?:para que lo sepas)\s*[:,-]?\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = query.match(pattern);
    const text = match?.[1]?.trim();
    if (text) {
      return text;
    }
  }

  return null;
}

function saveUserAssertion(text, payload) {
  const task = assertionQueue.then(() => saveUserAssertionNow(text, payload));
  assertionQueue = task.catch(() => {});
  return task;
}

async function saveUserAssertionNow(text, payload) {
  const target = String(payload.target ?? "Fabiana Sejas");
  const author = String(payload.author ?? "Diego");
  const addResult = JSON.parse(
    await runNode([
      addAssertionScript,
      assertionsPath,
      "--text",
      text,
      "--target",
      target,
      "--author",
      author
    ])
  );

  await rebuildCombinedMemory();
  const assertion = await findAssertionById(addResult.id);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    query: text,
    confidence: "high",
    retrievalMode: "manual",
    reply: "Listo, lo guarde como dato confirmado por Diego. Desde ahora lo uso como fuente manual.",
    generationMode: "user-assertion",
    styleProfile: null,
    draft: "Dato manual guardado, convertido a memoria y reindexado en la base combinada.",
    evidenceCount: 1,
    topScore: 1,
    output: null,
    sources: [
      {
        score: 1,
        chunkId: `mem_${assertion.id}_user_assertion_chunk_001`,
        memoryId: `mem_${assertion.id}_user_assertion`,
        messageId: assertion.id,
        timestamp: assertion.timestamp,
        localDate: assertion.localDate,
        localTime: assertion.localTime,
        role: "targetPerson",
        sourceType: "user_assertion",
        textLength: assertion.text.length,
        eligibleForPersona: false,
        text: assertion.text,
        evidence: {
          kind: "user_assertion",
          assertionId: assertion.id,
          confidence: assertion.confidence,
          author: assertion.author,
          target: assertion.target,
          source: {
            format: "manual_user_assertion"
          }
        }
      }
    ]
  };
}

async function rebuildCombinedMemory() {
  await runNode([buildAssertionMemoriesScript, assertionsPath, assertionMemoriesPath]);

  const inputPaths = [whatsappMemoriesPath, facebookMemoriesPath, assertionMemoriesPath].filter((path) => existsSync(path));
  if (inputPaths.length === 0) {
    throw new Error("No memory inputs available for merge");
  }

  await runNode([mergeMemoriesScript, combinedMemoriesPath, ...inputPaths]);
  await runNode([memoryCliScript, "memory-chunk", combinedMemoriesPath, combinedMemoryDir]);
  await runPython([embedScript, "--chunks", combinedChunksPath, "--output-dir", combinedIndexDir]);
  await runNode([
    buildStyleProfileScript,
    combinedMemoriesPath,
    styleProfilePath,
    "--role",
    "targetPerson",
    "--sample-size",
    "900"
  ]);
}

async function findAssertionById(id) {
  const assertions = readJsonLines(await readFile(assertionsPath, "utf8"));
  const assertion = assertions.find((row) => row.id === id);
  if (!assertion) {
    throw new Error(`Assertion not found after save: ${id}`);
  }
  return assertion;
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
  return runProcess(pythonPath, args, {
    PYTHONIOENCODING: "utf-8"
  });
}

function runNode(args) {
  return runProcess(process.execPath, args);
}

function runProcess(command, args, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv
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
        reject(new Error(stderr || `${command} exited with ${code}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
