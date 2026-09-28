#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const stopWords = new Set([
  "que",
  "de",
  "el",
  "la",
  "lo",
  "le",
  "me",
  "mi",
  "se",
  "te",
  "en",
  "un",
  "por",
  "para",
  "con",
  "una",
  "uno",
  "los",
  "las",
  "del",
  "estoy",
  "esta",
  "este",
  "pero",
  "como",
  "cuando",
  "donde",
  "porque",
  "mas",
  "menos",
  "todo",
  "todos",
  "algo",
  "ahi",
  "aca",
  "voy",
  "tenes",
  "tengo",
  "hacer",
  "audio",
  "omitido",
  "archivo",
  "adjunto"
]);

const [, , memoriesPath, outputPath, ...rawFlags] = process.argv;

if (!memoriesPath || !outputPath) {
  console.error("Uso: node scripts/build-style-profile.js <memories.jsonl> <output.json> [--role targetPerson] [--sample-size 400]");
  process.exit(1);
}

const flags = parseFlags(rawFlags);
const role = flags.role ?? "targetPerson";
const sampleSize = Number(flags["sample-size"] ?? 400);
const memories = readJsonLines(await readFile(memoriesPath, "utf8"))
  .filter((memory) => memory.role === role && memory.eligibleForPersona && memory.text)
  .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

const profile = buildProfile(memories, role, sampleSize);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      role,
      messageCount: profile.messageCount,
      sampleCount: profile.sampleCount,
      commonPhraseCount: profile.commonPhrases.length,
      commonWordCount: profile.commonWords.length,
      emojiCount: profile.emoji.count
    },
    null,
    2
  )
);

function buildProfile(rows, role, sampleSize) {
  const sampled = rows.slice(-sampleSize);
  const texts = sampled.map((row) => cleanText(row.text)).filter(Boolean);
  const tokens = texts.flatMap((text) => tokenize(text));
  const phraseCounts = countPhrases(texts);
  const emojiCounts = countEmojis(texts);
  const punctuation = countPunctuation(texts);
  const messageLengths = texts.map((text) => text.length);
  const wordLengths = texts.map((text) => tokenize(text).length);
  const questionCount = texts.filter((text) => text.includes("?") || text.includes("¿")).length;
  const exclamationCount = texts.filter((text) => text.includes("!") || text.includes("¡")).length;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    role,
    messageCount: rows.length,
    sampleCount: sampled.length,
    dateRange: {
      first: rows[0]?.localDate ?? null,
      last: rows.at(-1)?.localDate ?? null
    },
    length: {
      averageCharacters: average(messageLengths),
      medianCharacters: median(messageLengths),
      averageWords: average(wordLengths),
      medianWords: median(wordLengths)
    },
    toneHints: buildToneHints(texts, tokens, questionCount, exclamationCount),
    commonWords: topEntries(countItems(tokens.filter((token) => !stopWords.has(token))), 30),
    commonPhrases: topEntries(phraseCounts, 30),
    emoji: {
      count: sum(Object.values(emojiCounts)),
      common: topEntries(emojiCounts, 20)
    },
    punctuation,
    promptSummary: buildPromptSummary(texts, tokens, phraseCounts, emojiCounts, messageLengths, wordLengths)
  };
}

function buildToneHints(texts, tokens, questionCount, exclamationCount) {
  const hints = [];
  const avgWords = average(texts.map((text) => tokenize(text).length));
  if (avgWords <= 6) {
    hints.push("mensajes muy breves y directos");
  } else if (avgWords <= 14) {
    hints.push("mensajes cortos, naturales y conversacionales");
  } else {
    hints.push("mensajes medianos con algo de desarrollo");
  }
  if (questionCount / Math.max(texts.length, 1) > 0.18) {
    hints.push("suele preguntar o pedir confirmacion");
  }
  if (exclamationCount / Math.max(texts.length, 1) > 0.08) {
    hints.push("usa enfasis con exclamaciones");
  }
  if (tokens.includes("die")) {
    hints.push("usa el apodo die");
  }
  if (tokens.includes("si")) {
    hints.push("responde afirmaciones simples como si");
  }
  return hints;
}

function buildPromptSummary(texts, tokens, phraseCounts, emojiCounts, messageLengths, wordLengths) {
  const phrases = topEntries(phraseCounts, 12).map((entry) => entry.value);
  const emojis = topEntries(emojiCounts, 8).map((entry) => entry.value);
  const common = topEntries(countItems(tokens.filter((token) => !stopWords.has(token))), 12).map((entry) => entry.value);
  const avgChars = average(messageLengths);
  const avgWords = average(wordLengths);

  const lines = [
    `Longitud tipica: ${Math.round(avgChars)} caracteres y ${Math.round(avgWords)} palabras por mensaje.`,
    `Rasgos detectados: ${buildToneHints(texts, tokens, 0, 0).join("; ") || "tono conversacional simple"}.`
  ];
  if (common.length > 0) {
    lines.push(`Palabras frecuentes: ${common.join(", ")}.`);
  }
  if (phrases.length > 0) {
    lines.push(`Frases o formas frecuentes: ${phrases.join(" | ")}.`);
  }
  if (emojis.length > 0) {
    lines.push(`Emojis frecuentes: ${emojis.join(" ")}.`);
  }
  return lines.join("\n");
}

function countPhrases(texts) {
  const counts = {};
  for (const text of texts) {
    const normalized = normalize(text);
    const words = tokenize(normalized).filter((word) => !stopWords.has(word));
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= words.length - size; index++) {
        const phrase = words.slice(index, index + size).join(" ");
        if (phrase.length < 5) {
          continue;
        }
        counts[phrase] = (counts[phrase] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function countEmojis(texts) {
  const counts = {};
  const regex = /\p{Extended_Pictographic}/gu;
  for (const text of texts) {
    for (const match of text.matchAll(regex)) {
      counts[match[0]] = (counts[match[0]] ?? 0) + 1;
    }
  }
  return counts;
}

function countPunctuation(texts) {
  return {
    questionMessages: texts.filter((text) => text.includes("?") || text.includes("¿")).length,
    exclamationMessages: texts.filter((text) => text.includes("!") || text.includes("¡")).length,
    ellipsisMessages: texts.filter((text) => text.includes("...")).length,
    audioMarkerMessages: texts.filter((text) => text.toLowerCase().includes("audio omitido")).length
  };
}

function cleanText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9áéíóúüñ]+/i)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function countItems(items) {
  const counts = {};
  for (const item of items) {
    counts[item] = (counts[item] ?? 0) + 1;
  }
  return counts;
}

function topEntries(counts, limit) {
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function average(numbers) {
  if (numbers.length === 0) {
    return 0;
  }
  return Math.round((sum(numbers) / numbers.length) * 10) / 10;
}

function median(numbers) {
  if (numbers.length === 0) {
    return 0;
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
  }
  return sorted[middle];
}

function sum(numbers) {
  return numbers.reduce((total, value) => total + value, 0);
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

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
