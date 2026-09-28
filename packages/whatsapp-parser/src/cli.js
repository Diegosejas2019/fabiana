#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAudioCandidates,
  buildMemoryChunks,
  buildMemories,
  buildTranscriptionJobs,
  normalizeRecords,
  parseWhatsAppText,
  reconcileMediaReferences,
  summarizeRecords
} from "./index.js";

const [, , command, filePath, secondPath, thirdPath, ...rawFlags] = process.argv;

if (
  ![
    "summary",
    "media-check",
    "ingest",
    "audio-inventory",
    "transcription-batch",
    "memory-build",
    "memory-chunk"
  ].includes(command) ||
  !filePath
) {
  console.error(
    [
      "Uso:",
      "  node packages/whatsapp-parser/src/cli.js summary <chat.txt>",
      "  node packages/whatsapp-parser/src/cli.js media-check <chat.txt> <zip-inventory.json>",
      "  node packages/whatsapp-parser/src/cli.js ingest <chat.txt> <zip-inventory.json> <output-dir> --target <nombre> [--self-label <nombre>]",
      "  node packages/whatsapp-parser/src/cli.js audio-inventory <messages.jsonl> <output-dir>",
      "  node packages/whatsapp-parser/src/cli.js transcription-batch <audio-candidates.jsonl> <extraction-manifest.json> <output-dir>",
      "  node packages/whatsapp-parser/src/cli.js memory-build <messages.jsonl> <transcripts-dir> <output-dir>",
      "  node packages/whatsapp-parser/src/cli.js memory-chunk <memories.jsonl> <output-dir> [--max-chars 900] [--overlap-chars 120]"
    ].join("\n")
  );
  process.exit(1);
}

const text = await readFile(filePath, "utf8");

if (command === "summary") {
  const records = parseWhatsAppText(text, { omitBody: true });
  console.log(JSON.stringify(summarizeRecords(records), null, 2));
}

if (command === "media-check") {
  if (!secondPath) {
    console.error("Falta <zip-inventory.json>.");
    process.exit(1);
  }

  const records = parseWhatsAppText(text, { omitBody: true });
  const inventory = await readJson(secondPath);
  const reconciliation = reconcileMediaReferences(records, inventory.entries ?? []);
  console.log(JSON.stringify(reconciliation, null, 2));
}

if (command === "ingest") {
  if (!secondPath || !thirdPath) {
    console.error("Faltan <zip-inventory.json> y/o <output-dir>.");
    process.exit(1);
  }

  const flags = parseFlags(rawFlags);
  const targetAuthor = flags.target;

  if (!targetAuthor) {
    console.error("Falta --target <nombre>.");
    process.exit(1);
  }

  const inventory = await readJson(secondPath);
  const records = parseWhatsAppText(text);
  const ingestion = normalizeRecords(records, inventory.entries ?? [], {
    targetAuthor,
    selfLabel: flags["self-label"] ?? "self"
  });

  await mkdir(thirdPath, { recursive: true });

  const messagesJsonl = ingestion.messages.map((message) => JSON.stringify(message)).join("\n");
  const missingMedia = ingestion.messages
    .filter((message) => message.media?.status === "missing")
    .map((message) => ({
      messageId: message.id,
      filename: message.media.filename,
      source: message.source
    }));

  await writeFile(join(thirdPath, "messages.jsonl"), `${messagesJsonl}\n`, "utf8");
  await writeFile(
    join(thirdPath, "participants.json"),
    `${JSON.stringify(ingestion.participants, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(thirdPath, "manifest.json"),
    `${JSON.stringify(ingestion.manifest, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(thirdPath, "media-missing.json"),
    `${JSON.stringify(missingMedia, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputDir: thirdPath,
        messageCount: ingestion.manifest.messageCount,
        byRole: ingestion.manifest.byRole,
        mediaByStatus: ingestion.manifest.mediaByStatus,
        missingMediaCount: missingMedia.length
      },
      null,
      2
    )
  );
}

if (command === "audio-inventory") {
  if (!secondPath) {
    console.error("Falta <output-dir>.");
    process.exit(1);
  }

  const messages = readJsonLines(text);
  const inventory = buildAudioCandidates(messages);
  const candidatesJsonl = inventory.candidates
    .map((candidate) => JSON.stringify(candidate))
    .join("\n");

  await mkdir(secondPath, { recursive: true });
  await writeFile(join(secondPath, "audio-candidates.jsonl"), `${candidatesJsonl}\n`, "utf8");
  await writeFile(
    join(secondPath, "audio-manifest.json"),
    `${JSON.stringify(inventory.manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputDir: secondPath,
        candidateCount: inventory.manifest.candidateCount,
        byRole: inventory.manifest.byRole,
        byExtension: inventory.manifest.byExtension,
        byStatus: inventory.manifest.byStatus,
        totalBytes: inventory.manifest.totalBytes
      },
      null,
      2
    )
  );
}

if (command === "transcription-batch") {
  if (!secondPath || !thirdPath) {
    console.error("Faltan <extraction-manifest.json> y/o <output-dir>.");
    process.exit(1);
  }

  const candidates = readJsonLines(text);
  const extractionManifest = await readJson(secondPath);
  const batch = buildTranscriptionJobs(candidates, extractionManifest, {
    outputDir: thirdPath,
    extractionManifestPath: secondPath
  });
  const jobsJsonl = batch.jobs.map((job) => JSON.stringify(job)).join("\n");

  await mkdir(join(thirdPath, "items"), { recursive: true });
  await writeFile(join(thirdPath, "transcription-jobs.jsonl"), `${jobsJsonl}\n`, "utf8");
  await writeFile(
    join(thirdPath, "transcription-manifest.json"),
    `${JSON.stringify(batch.manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputDir: thirdPath,
        jobCount: batch.manifest.jobCount,
        byRole: batch.manifest.byRole,
        byStatus: batch.manifest.byStatus,
        totalBytes: batch.manifest.totalBytes
      },
      null,
      2
    )
  );
}

if (command === "memory-build") {
  if (!secondPath || !thirdPath) {
    console.error("Faltan <transcripts-dir> y/o <output-dir>.");
    process.exit(1);
  }

  const messages = readJsonLines(text);
  const transcripts = await readTranscriptDirectory(secondPath);
  const memory = buildMemories(messages, transcripts);
  const memoriesJsonl = memory.memories.map((row) => JSON.stringify(row)).join("\n");

  await mkdir(thirdPath, { recursive: true });
  await writeFile(join(thirdPath, "memories.jsonl"), `${memoriesJsonl}\n`, "utf8");
  await writeFile(
    join(thirdPath, "memory-manifest.json"),
    `${JSON.stringify(memory.manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputDir: thirdPath,
        memoryCount: memory.manifest.memoryCount,
        targetPersonCount: memory.manifest.targetPersonCount,
        byRole: memory.manifest.byRole,
        bySourceType: memory.manifest.bySourceType,
        totalCharacters: memory.manifest.totalCharacters
      },
      null,
      2
    )
  );
}

if (command === "memory-chunk") {
  if (!secondPath) {
    console.error("Falta <output-dir>.");
    process.exit(1);
  }

  const flags = parseFlags(rawFlags);
  const memories = readJsonLines(text);
  const result = buildMemoryChunks(memories, {
    maxChars: Number(flags["max-chars"] ?? 900),
    overlapChars: Number(flags["overlap-chars"] ?? 120)
  });
  const chunksJsonl = result.chunks.map((row) => JSON.stringify(row)).join("\n");

  await mkdir(secondPath, { recursive: true });
  await writeFile(join(secondPath, "chunks.jsonl"), `${chunksJsonl}\n`, "utf8");
  await writeFile(
    join(secondPath, "chunk-manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputDir: secondPath,
        chunkCount: result.manifest.chunkCount,
        targetPersonCount: result.manifest.targetPersonCount,
        byRole: result.manifest.byRole,
        bySourceType: result.manifest.bySourceType,
        totalCharacters: result.manifest.totalCharacters
      },
      null,
      2
    )
  );
}

async function readJson(path) {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function parseFlags(args) {
  const flags = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = args[index + 1];
    flags[key] = value;
    index++;
  }

  return flags;
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function readTranscriptDirectory(path) {
  const files = (await readdir(path)).filter((file) => file.endsWith(".json"));
  const transcripts = [];

  for (const file of files) {
    const transcript = await readJson(join(path, file));
    transcript.transcriptPath = join(path, file);
    transcripts.push(transcript);
  }

  return transcripts;
}
