#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [, , assertionsPath, outputPath] = process.argv;

if (!assertionsPath || !outputPath) {
  console.error("Uso: node scripts/build-user-assertion-memories.js <assertions.jsonl> <memories.jsonl>");
  process.exit(1);
}

const assertions = readJsonLines(await readFile(assertionsPath, "utf8"));
const memories = assertions.map(assertionToMemory);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${memories.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
await writeFile(
  join(dirname(outputPath), "memory-manifest.json"),
  `${JSON.stringify(buildManifest(memories, assertionsPath), null, 2)}\n`,
  "utf8"
);

console.log(
  JSON.stringify(
    {
      outputPath,
      assertionCount: assertions.length,
      memoryCount: memories.length,
      sourceType: "user_assertion"
    },
    null,
    2
  )
);

function assertionToMemory(assertion) {
  const text = String(assertion.text ?? "").trim();
  return {
    id: `mem_${assertion.id}_user_assertion`,
    messageId: assertion.id,
    timestamp: assertion.timestamp,
    localDate: assertion.localDate,
    localTime: assertion.localTime,
    role: "targetPerson",
    participantId: "participant_manual",
    sourceType: "user_assertion",
    text,
    textLength: text.length,
    eligibleForPersona: false,
    evidence: {
      kind: "user_assertion",
      assertionId: assertion.id,
      confidence: assertion.confidence ?? "user_confirmed",
      author: assertion.author ?? "Diego",
      target: assertion.target ?? "Fabiana Sejas",
      source: {
        format: "manual_user_assertion"
      }
    }
  };
}

function buildManifest(memories, inputPath) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputPath,
    memoryCount: memories.length,
    targetPersonCount: memories.filter((memory) => memory.eligibleForPersona).length,
    byRole: countBy(memories, "role"),
    bySourceType: countBy(memories, "sourceType"),
    firstTimestamp: memories[0]?.timestamp ?? null,
    lastTimestamp: memories.at(-1)?.timestamp ?? null
  };
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  }
  return counts;
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
