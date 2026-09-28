#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [, , outputPath, ...inputPaths] = process.argv;

if (!outputPath || inputPaths.length === 0) {
  console.error("Uso: node scripts/merge-memories.js <output-memories.jsonl> <input...jsonl>");
  process.exit(1);
}

const memories = [];
for (const inputPath of inputPaths) {
  const rows = readJsonLines(await readFile(inputPath, "utf8"));
  memories.push(...rows);
}

memories.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)));

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${memories.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

const manifest = buildManifest(memories, inputPaths);
await writeFile(join(dirname(outputPath), "memory-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      inputCount: inputPaths.length,
      memoryCount: memories.length,
      targetPersonCount: manifest.targetPersonCount,
      byRole: manifest.byRole,
      bySourceType: manifest.bySourceType
    },
    null,
    2
  )
);

function buildManifest(rows, inputs) {
  const byRole = {};
  const bySourceType = {};
  let targetPersonCount = 0;
  let totalCharacters = 0;

  for (const row of rows) {
    byRole[row.role] = (byRole[row.role] ?? 0) + 1;
    bySourceType[row.sourceType] = (bySourceType[row.sourceType] ?? 0) + 1;
    totalCharacters += row.textLength ?? 0;
    if (row.eligibleForPersona) {
      targetPersonCount++;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputs,
    memoryCount: rows.length,
    targetPersonCount,
    byRole,
    bySourceType,
    totalCharacters,
    firstTimestamp: rows[0]?.timestamp ?? null,
    lastTimestamp: rows.at(-1)?.timestamp ?? null
  };
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
