#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  parseWhatsAppText,
  reconcileMediaReferences,
  summarizeRecords
} from "./index.js";

const [, , command, filePath, inventoryPath] = process.argv;

if (!["summary", "media-check"].includes(command) || !filePath) {
  console.error(
    [
      "Uso:",
      "  node packages/whatsapp-parser/src/cli.js summary <chat.txt>",
      "  node packages/whatsapp-parser/src/cli.js media-check <chat.txt> <zip-inventory.json>"
    ].join("\n")
  );
  process.exit(1);
}

const text = await readFile(filePath, "utf8");
const records = parseWhatsAppText(text, { omitBody: true });

if (command === "summary") {
  console.log(JSON.stringify(summarizeRecords(records), null, 2));
}

if (command === "media-check") {
  if (!inventoryPath) {
    console.error("Falta <zip-inventory.json>.");
    process.exit(1);
  }

  const inventoryText = (await readFile(inventoryPath, "utf8")).replace(/^\uFEFF/, "");
  const inventory = JSON.parse(inventoryText);
  const reconciliation = reconcileMediaReferences(records, inventory.entries ?? []);
  console.log(JSON.stringify(reconciliation, null, 2));
}
