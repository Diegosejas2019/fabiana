#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeRecords,
  parseWhatsAppText,
  reconcileMediaReferences,
  summarizeRecords
} from "./index.js";

const [, , command, filePath, inventoryPath, outputDir, ...rawFlags] = process.argv;

if (!["summary", "media-check", "ingest"].includes(command) || !filePath) {
  console.error(
    [
      "Uso:",
      "  node packages/whatsapp-parser/src/cli.js summary <chat.txt>",
      "  node packages/whatsapp-parser/src/cli.js media-check <chat.txt> <zip-inventory.json>",
      "  node packages/whatsapp-parser/src/cli.js ingest <chat.txt> <zip-inventory.json> <output-dir> --target <nombre> [--self-label <nombre>]"
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
  if (!inventoryPath) {
    console.error("Falta <zip-inventory.json>.");
    process.exit(1);
  }

  const records = parseWhatsAppText(text, { omitBody: true });
  const inventory = await readJson(inventoryPath);
  const reconciliation = reconcileMediaReferences(records, inventory.entries ?? []);
  console.log(JSON.stringify(reconciliation, null, 2));
}

if (command === "ingest") {
  if (!inventoryPath || !outputDir) {
    console.error("Faltan <zip-inventory.json> y/o <output-dir>.");
    process.exit(1);
  }

  const flags = parseFlags(rawFlags);
  const targetAuthor = flags.target;

  if (!targetAuthor) {
    console.error("Falta --target <nombre>.");
    process.exit(1);
  }

  const inventory = await readJson(inventoryPath);
  const records = parseWhatsAppText(text);
  const ingestion = normalizeRecords(records, inventory.entries ?? [], {
    targetAuthor,
    selfLabel: flags["self-label"] ?? "self"
  });

  await mkdir(outputDir, { recursive: true });

  const messagesJsonl = ingestion.messages.map((message) => JSON.stringify(message)).join("\n");
  const missingMedia = ingestion.messages
    .filter((message) => message.media?.status === "missing")
    .map((message) => ({
      messageId: message.id,
      filename: message.media.filename,
      source: message.source
    }));

  await writeFile(join(outputDir, "messages.jsonl"), `${messagesJsonl}\n`, "utf8");
  await writeFile(
    join(outputDir, "participants.json"),
    `${JSON.stringify(ingestion.participants, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(ingestion.manifest, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(outputDir, "media-missing.json"),
    `${JSON.stringify(missingMedia, null, 2)}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputDir,
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
