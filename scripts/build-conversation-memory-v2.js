#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [, , inputPath, outputPath, ...rawFlags] = process.argv;

if (!inputPath || !outputPath) {
  console.error(
    [
      "Uso:",
      "  node scripts/build-conversation-memory-v2.js <input-memories.jsonl> <output-memories.jsonl>",
      "",
      "Opciones:",
      "  --window-size 10",
      "  --step-size 5",
      "  --max-gap-minutes 180"
    ].join("\n")
  );
  process.exit(1);
}

const flags = parseFlags(rawFlags);
const windowSize = Number(flags["window-size"] ?? 10);
const stepSize = Number(flags["step-size"] ?? 5);
const maxGapMinutes = Number(flags["max-gap-minutes"] ?? 180);
const memories = readJsonLines(await readFile(inputPath, "utf8"));
const contextMemories = buildConversationContextMemories(memories, {
  windowSize,
  stepSize,
  maxGapMinutes
});
const output = [...memories, ...contextMemories].sort(compareMemories);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${output.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

const manifest = buildManifest(output, contextMemories, {
  inputPath,
  windowSize,
  stepSize,
  maxGapMinutes
});
await writeFile(join(dirname(outputPath), "memory-v2-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      inputCount: memories.length,
      contextMemoryCount: contextMemories.length,
      memoryCount: output.length,
      bySourceType: manifest.bySourceType
    },
    null,
    2
  )
);

function buildConversationContextMemories(rows, options) {
  const conversational = rows
    .filter(isConversationalMemory)
    .sort(compareMemories);
  const segments = splitIntoSegments(conversational, options.maxGapMinutes);
  const output = [];
  let sequence = 1;

  for (const segment of segments) {
    if (segment.length < 2 || !segment.some((row) => row.role === "targetPerson")) {
      continue;
    }

    for (let index = 0; index < segment.length; index += options.stepSize) {
      const window = segment.slice(index, index + options.windowSize);
      if (window.length < 2 || !window.some((row) => row.role === "targetPerson")) {
        continue;
      }

      output.push(buildContextMemory(window, sequence));
      sequence += 1;

      if (index + options.windowSize >= segment.length) {
        break;
      }
    }
  }

  return output;
}

function splitIntoSegments(rows, maxGapMinutes) {
  const segments = [];
  let current = [];
  let previous = null;
  const maxGapMs = maxGapMinutes * 60 * 1000;

  for (const row of rows) {
    const currentTime = Date.parse(row.timestamp ?? "");
    const previousTime = previous ? Date.parse(previous.timestamp ?? "") : NaN;
    const sameDay = previous && row.localDate === previous.localDate;
    const sameSurface = previous && sourceSurface(row) === sourceSurface(previous);
    const closeEnough = Number.isFinite(currentTime) && Number.isFinite(previousTime)
      ? currentTime - previousTime <= maxGapMs
      : true;

    if (current.length > 0 && (!sameDay || !sameSurface || !closeEnough)) {
      segments.push(current);
      current = [];
    }

    current.push(row);
    previous = row;
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function buildContextMemory(rows, sequence) {
  const first = rows[0];
  const last = rows.at(-1);
  const id = `memv2_ctx_${String(sequence).padStart(6, "0")}`;
  const dateRange = first.localDate === last.localDate
    ? first.localDate
    : `${first.localDate} - ${last.localDate}`;
  const timeRange = first.localTime === last.localTime
    ? first.localTime
    : `${first.localTime} - ${last.localTime}`;
  const text = [
    `Contexto conversacional (${dateRange}, ${timeRange}):`,
    ...rows.map(formatConversationLine)
  ].join("\n");

  return {
    id,
    messageId: `${first.messageId}..${last.messageId}`,
    timestamp: last.timestamp,
    localDate: last.localDate,
    localTime: last.localTime,
    role: "targetPerson",
    participantId: "participant_context",
    sourceType: "conversation_context",
    text,
    textLength: text.length,
    eligibleForPersona: false,
    evidence: {
      kind: "conversation_context",
      schemaVersion: 1,
      messageIds: rows.map((row) => row.messageId),
      memoryIds: rows.map((row) => row.id),
      sourceTypes: [...new Set(rows.map((row) => row.sourceType))],
      roleCounts: countBy(rows, "role"),
      dateRange: {
        first: first.localDate,
        last: last.localDate
      },
      timeRange: {
        first: first.localTime,
        last: last.localTime
      },
      source: {
        format: "memory_v2_conversation_window",
        surface: sourceSurface(first)
      }
    }
  };
}

function formatConversationLine(row) {
  const speaker = row.role === "targetPerson" ? "Fabiana" : row.role === "self" ? "Diego" : "Otro";
  return `${row.localTime} ${speaker}: ${cleanText(row.text)}`;
}

function isConversationalMemory(row) {
  if (!row?.text || row.sourceType === "user_assertion" || row.sourceType === "conversation_context") {
    return false;
  }
  if (!["targetPerson", "self", "other"].includes(row.role)) {
    return false;
  }
  return ["whatsapp_text", "audio_transcript", "facebook_text"].includes(row.sourceType);
}

function sourceSurface(row) {
  if (row.sourceType === "facebook_text") {
    return "facebook";
  }
  return "whatsapp";
}

function compareMemories(a, b) {
  return String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id));
}

function buildManifest(rows, contextRows, options) {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    inputPath: options.inputPath,
    memoryCount: rows.length,
    contextMemoryCount: contextRows.length,
    targetPersonCount: rows.filter((row) => row.eligibleForPersona).length,
    byRole: countBy(rows, "role"),
    bySourceType: countBy(rows, "sourceType"),
    totalCharacters: rows.reduce((total, row) => total + (row.textLength ?? 0), 0),
    conversationWindow: {
      windowSize: options.windowSize,
      stepSize: options.stepSize,
      maxGapMinutes: options.maxGapMinutes
    },
    firstTimestamp: rows[0]?.timestamp ?? null,
    lastTimestamp: rows.at(-1)?.timestamp ?? null
  };
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function cleanText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function parseFlags(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
}
