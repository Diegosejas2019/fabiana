import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const defaultCasesPath = join(root, "quality/eval-cases.json");
const casesPath = resolve(process.argv[2] ?? defaultCasesPath);
const pythonPath = join(root, ".venv/Scripts/python.exe");
const answerScript = join(root, "scripts/answer-memory.py");
const combinedChunksPath = join(root, "data/processed/combined-memory/chunks.jsonl");
const combinedIndexDir = join(root, "data/processed/combined-rag");
const fallbackChunksPath = join(root, "data/processed/memory/chunks.jsonl");
const fallbackIndexDir = join(root, "data/processed/rag");
const styleProfilePath = join(root, "data/processed/persona/persona-style.json");
const deepProfilePath = join(root, "data/processed/persona/deep-profile.json");
const outputDir = join(root, "data/processed/evaluations");

function main() {
  const chunksPath = existsSync(combinedChunksPath) ? combinedChunksPath : fallbackChunksPath;
  const indexDir = existsSync(combinedIndexDir) ? combinedIndexDir : fallbackIndexDir;

  if (!existsSync(casesPath)) {
    fail(`No existe el archivo de casos: ${casesPath}`);
  }
  if (!existsSync(chunksPath) || !existsSync(indexDir)) {
    fail("Faltan chunks o embeddings. Ejecuta memory:chunk y rag:embed antes de evaluar calidad.");
  }

  mkdirSync(outputDir, { recursive: true });
  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  const results = cases.map((testCase) => runCase(testCase, chunksPath, indexDir));
  const failed = results.filter((result) => !result.ok);

  for (const result of results) {
    const marker = result.ok ? "OK" : "FAIL";
    const mode = result.answer?.generationMode ?? "sin-modo";
    const confidence = result.answer?.confidence ?? "sin-confianza";
    console.log(`${marker} ${result.id} (${mode}, ${confidence})`);
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }

  console.log(`\nEvaluacion: ${results.length - failed.length}/${results.length} casos OK`);
  console.log(`Detalles privados: ${outputDir}`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function runCase(testCase, chunksPath, indexDir) {
  const outputPath = join(outputDir, `${safeName(testCase.id)}.json`);
  const args = [
    answerScript,
    "--query",
    testCase.query,
    "--chunks",
    chunksPath,
    "--index-dir",
    indexDir,
    "--top-k",
    String(testCase.topK ?? 8),
    "--role",
    testCase.role ?? "targetPerson",
    "--llm-provider",
    testCase.llmProvider ?? "none",
    "--show-text",
    "--output",
    outputPath
  ];

  if (testCase.sourceType) {
    args.push("--source-type", testCase.sourceType);
  }
  if (existsSync(styleProfilePath)) {
    args.push("--style-profile", styleProfilePath);
  }
  if (existsSync(deepProfilePath)) {
    args.push("--deep-profile", deepProfilePath);
  }

  const child = spawnSync(pythonPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024
  });

  if (child.status !== 0) {
    return {
      id: testCase.id,
      ok: false,
      answer: null,
      errors: [`answer-memory fallo con codigo ${child.status}`]
    };
  }

  let answer;
  try {
    answer = JSON.parse(child.stdout);
  } catch {
    return {
      id: testCase.id,
      ok: false,
      answer: null,
      errors: ["No pude parsear la salida JSON de answer-memory."]
    };
  }

  const errors = checkExpectations(answer, testCase.expect ?? {});
  return {
    id: testCase.id,
    ok: errors.length === 0,
    answer,
    errors
  };
}

function checkExpectations(answer, expect) {
  const errors = [];
  const reply = normalize(answer.reply ?? "");

  if (expect.confidenceIn && !expect.confidenceIn.includes(answer.confidence)) {
    errors.push(`confianza esperada: ${expect.confidenceIn.join(", ")}; recibida: ${answer.confidence}`);
  }
  if (expect.retrievalModeIn && !expect.retrievalModeIn.includes(answer.retrievalMode)) {
    errors.push(`busqueda esperada: ${expect.retrievalModeIn.join(", ")}; recibida: ${answer.retrievalMode}`);
  }
  if (expect.generationModeIn && !expect.generationModeIn.includes(answer.generationMode)) {
    errors.push(`respuesta esperada: ${expect.generationModeIn.join(", ")}; recibida: ${answer.generationMode}`);
  }
  if (expect.validationStatusIn && !expect.validationStatusIn.includes(answer.validation?.status)) {
    errors.push(`validacion esperada: ${expect.validationStatusIn.join(", ")}; recibida: ${answer.validation?.status ?? "sin-validacion"}`);
  }

  for (const text of expect.replyIncludes ?? []) {
    if (!reply.includes(normalize(text))) {
      errors.push(`la respuesta no incluye: "${text}"`);
    }
  }

  for (const text of expect.replyExcludes ?? []) {
    if (reply.includes(normalize(text))) {
      errors.push(`la respuesta incluye algo prohibido: "${text}"`);
    }
  }

  return errors;
}

function normalize(value) {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
