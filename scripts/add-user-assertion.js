#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [, , assertionsPath, ...rawFlags] = process.argv;

if (!assertionsPath) {
  console.error("Uso: node scripts/add-user-assertion.js <assertions.jsonl> --text <dato> [--target Fabiana] [--author Diego]");
  process.exit(1);
}

const flags = parseFlags(rawFlags);
const text = String(flags.text ?? "").trim();
const target = String(flags.target ?? "Fabiana Sejas").trim();
const author = String(flags.author ?? "Diego").trim();

if (!text) {
  console.error("Falta --text <dato>.");
  process.exit(1);
}

const existing = await readExisting(assertionsPath);
const now = new Date();
const timestamp = now.toISOString();
const id = `assert_${timestamp.replace(/[-:.TZ]/g, "").slice(0, 17)}_${String(existing.length + 1).padStart(4, "0")}`;
const localDateTime = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "numeric",
  month: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
}).formatToParts(now);

const part = (type) => localDateTime.find((item) => item.type === type)?.value;
const localDate = `${Number(part("day"))}/${Number(part("month"))}/${part("year")}`;
const localTime = `${part("hour")}:${part("minute")}`;

const assertion = {
  schemaVersion: 1,
  id,
  timestamp,
  localDate,
  localTime,
  target,
  author,
  text,
  confidence: "user_confirmed",
  sourceType: "user_assertion"
};

await mkdir(dirname(assertionsPath), { recursive: true });
existing.push(assertion);
await writeFile(assertionsPath, `${existing.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      assertionsPath,
      id,
      count: existing.length,
      sourceType: assertion.sourceType,
      confidence: assertion.confidence
    },
    null,
    2
  )
);

async function readExisting(path) {
  try {
    return readJsonLines(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    flags[arg.slice(2)] = args[index + 1];
    index++;
  }
  return flags;
}
