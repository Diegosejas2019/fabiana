#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  "pero",
  "como",
  "cuando",
  "donde",
  "porque",
  "mas",
  "todo",
  "todos",
  "algo",
  "ahi",
  "aca",
  "voy",
  "tengo",
  "tenes",
  "audio",
  "omitido",
  "archivo",
  "adjunto"
]);

const affectionTerms = new Set([
  "die",
  "amor",
  "reina",
  "beso",
  "besos",
  "gracias",
  "querido",
  "querida",
  "hermano",
  "hermana",
  "mami",
  "ma",
  "pa"
]);

const [, , memoriesPath, outputPath, ...rawFlags] = process.argv;

if (!memoriesPath || !outputPath) {
  console.error("Uso: node scripts/build-deep-profile.js <memories.jsonl> <output.json> [--role targetPerson] [--sample-size 1400]");
  process.exit(1);
}

const flags = parseFlags(rawFlags);
const role = flags.role ?? "targetPerson";
const sampleSize = Number(flags["sample-size"] ?? 1400);
const memories = readJsonLines(await readFile(memoriesPath, "utf8"));
const personaMessages = memories
  .filter((memory) => memory.role === role && memory.eligibleForPersona && memory.text)
  .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
const sampledMessages = personaMessages.slice(-sampleSize);
const userAssertions = memories
  .filter((memory) => memory.sourceType === "user_assertion" && memory.text)
  .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

const profile = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  role,
  sourceCounts: {
    personaMessages: personaMessages.length,
    sampledMessages: sampledMessages.length,
    userAssertions: userAssertions.length
  },
  dateRange: {
    first: personaMessages[0]?.localDate ?? null,
    last: personaMessages.at(-1)?.localDate ?? null
  },
  voicebook: buildVoicebook(sampledMessages),
  relationshipMap: buildRelationshipMap(userAssertions),
  biography: buildBiography(userAssertions),
  usagePolicy: {
    messages: "Usar mensajes reales de Fabiana como fuente de recuerdos y de estilo.",
    userAssertions: "Usar datos personales confirmados por Diego solo como contexto factual; no son recuerdos ni voz de Fabiana.",
    approvedResponses: "Usar respuestas aprobadas como ejemplos de calidad, no como hechos nuevos.",
    refusal: "Si no hay fuente suficiente, responder con cuidado y no inventar hechos concretos."
  },
  promptSummary: ""
};

profile.promptSummary = buildPromptSummary(profile);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      personaMessages: profile.sourceCounts.personaMessages,
      sampledMessages: profile.sourceCounts.sampledMessages,
      userAssertions: profile.sourceCounts.userAssertions,
      relationshipCount: profile.relationshipMap.relationships.length,
      voiceCueCount: profile.voicebook.cues.length
    },
    null,
    2
  )
);

function buildVoicebook(rows) {
  const texts = rows.map((row) => cleanText(row.text)).filter(Boolean);
  const tokens = texts.flatMap((text) => tokenize(text));
  const emojiCounts = countEmojis(texts);
  const phraseCounts = countPhrases(texts);
  const openerCounts = countLineEdges(texts, "start");
  const closerCounts = countLineEdges(texts, "end");
  const affectionWords = topEntries(countItems(tokens.filter((token) => affectionTerms.has(token))), 20);
  const questionRatio = ratio(texts.filter((text) => text.includes("?") || text.includes("¿")).length, texts.length);
  const exclamationRatio = ratio(texts.filter((text) => text.includes("!") || text.includes("¡")).length, texts.length);
  const shortRatio = ratio(texts.filter((text) => tokenize(text).length <= 6).length, texts.length);

  return {
    messageCount: rows.length,
    averageWords: average(texts.map((text) => tokenize(text).length)),
    averageCharacters: average(texts.map((text) => text.length)),
    ratios: {
      shortMessages: shortRatio,
      questions: questionRatio,
      exclamations: exclamationRatio
    },
    cues: buildVoiceCues(tokens, shortRatio, questionRatio, exclamationRatio),
    frequentWords: topEntries(countItems(tokens.filter((token) => !stopWords.has(token))), 35),
    frequentPhrases: topEntries(phraseCounts, 35),
    openers: topEntries(openerCounts, 15),
    closers: topEntries(closerCounts, 15),
    affectionWords,
    emoji: {
      count: sum(Object.values(emojiCounts)),
      common: topEntries(emojiCounts, 20)
    }
  };
}

function buildRelationshipMap(assertions) {
  const relationships = [];
  for (const assertion of assertions) {
    const sentences = splitSentences(assertion.text);
    for (const sentence of sentences) {
      relationships.push(...extractRelationships(sentence, assertion));
    }
  }

  return {
    relationships: dedupeRelationships(relationships),
    confirmedBy: "Diego",
    confidence: "user_confirmed"
  };
}

function buildBiography(assertions) {
  const contextTexts = assertions
    .map((assertion) => assertion.text)
    .filter((text) => text.length > 500);
  const facts = assertions
    .flatMap((assertion) => splitSentences(assertion.text).map((sentence) => ({
      sentence,
      id: assertion.messageId,
      sourceLength: assertion.text.length
    })))
    .filter((item) => item.sentence.length > 35 && item.sentence.length < 260)
    .sort((left, right) => left.sourceLength - right.sourceLength || left.id.localeCompare(right.id))
    .slice(0, 80);

  return {
    contextSourceCount: contextTexts.length,
    note: "Contexto biografico escrito o confirmado por Diego; no debe usarse como estilo literal de Fabiana.",
    highlights: facts.map((item) => ({
      text: item.sentence,
      sourceId: item.id
    }))
  };
}

function buildPromptSummary(profile) {
  const cues = profile.voicebook.cues.slice(0, 8).join("; ");
  const words = profile.voicebook.frequentWords.slice(0, 12).map((entry) => entry.value).join(", ");
  const phrases = profile.voicebook.frequentPhrases.slice(0, 10).map((entry) => entry.value).join(" | ");
  const emojis = profile.voicebook.emoji.common.slice(0, 8).map((entry) => entry.value).join(" ");
  const relationLines = profile.relationshipMap.relationships
    .slice(0, 18)
    .map((item) => `${item.subject} -> ${item.relation} -> ${item.object}`)
    .join("; ");

  return [
    `Voz: ${cues || "conversacional, simple y cercana"}.`,
    words ? `Palabras frecuentes: ${words}.` : null,
    phrases ? `Formas frecuentes: ${phrases}.` : null,
    emojis ? `Emojis frecuentes: ${emojis}.` : null,
    relationLines ? `Mapa familiar confirmado por Diego: ${relationLines}.` : null,
    "Regla: los datos confirmados por Diego son contexto factual, no recuerdos ni estilo de Fabiana."
  ]
    .filter(Boolean)
    .join("\n");
}

function buildVoiceCues(tokens, shortRatio, questionRatio, exclamationRatio) {
  const cues = [];
  if (shortRatio >= 0.55) {
    cues.push("tiende a mensajes breves y directos");
  }
  if (tokens.includes("die")) {
    cues.push("usa el apodo die");
  }
  if (tokens.includes("si")) {
    cues.push("usa afirmaciones simples");
  }
  if (questionRatio >= 0.15) {
    cues.push("pregunta y pide confirmacion con frecuencia");
  }
  if (exclamationRatio >= 0.08) {
    cues.push("usa enfasis con exclamaciones");
  }
  if (tokens.includes("gracias")) {
    cues.push("agradece de forma cotidiana");
  }
  return cues;
}

function extractRelationships(sentence, assertion) {
  const normalized = normalize(sentence);
  const rows = [];
  const source = {
    sourceId: assertion.messageId,
    sourceType: assertion.sourceType,
    confidence: assertion.evidence?.confidence ?? "user_confirmed"
  };

  matchList(normalized, /(?:los|las)\s+([\w]+)\s+de\s+fabiana\s+(?:son|se llaman)\s+(.+)/u, (relation, names) => {
    for (const name of splitNames(names)) {
      rows.push(relationship("Fabiana", singularizeRelation(relation), titleName(name), source));
    }
  });

  matchList(normalized, /(?:la|el)\s+([\w]+)\s+de\s+fabiana\s+se\s+llama(?:ba)?\s+(.+)/u, (relation, name) => {
    rows.push(relationship("Fabiana", singularizeRelation(relation), titleName(firstName(name)), source));
  });

  matchList(normalized, /([\w]+)\s+es\s+([\w]+)\s+de\s+fabiana/u, (name, relation) => {
    rows.push(relationship("Fabiana", singularizeRelation(relation), titleName(name), source));
  });

  matchList(normalized, /fabiana\s+amaba\s+mucho\s+a\s+([\w]+)/u, (name) => {
    rows.push(relationship("Fabiana", "amaba mucho a", titleName(name), source));
  });

  matchList(normalized, /(?:el|la)\s+marido\s+de\s+([\w]+)\s+se\s+llama\s+([\w]+)/u, (person, spouse) => {
    rows.push(relationship(titleName(person), "marido", titleName(spouse), source));
  });

  matchList(normalized, /otro\s+perro\s+que\s+vivia\s+con\s+fabiana\s+se\s+llama\s+([\w]+)/u, (name) => {
    rows.push(relationship("Fabiana", "perro que vivia con ella", titleName(name), source));
  });

  matchList(normalized, /(?:los|las)\s+(perritos|perros|mascotas)\s+de\s+fabiana\s+se\s+llaman\s+(.+)/u, (relation, names) => {
    for (const name of splitNames(names)) {
      rows.push(relationship("Fabiana", singularizeRelation(relation), titleName(name), source));
    }
  });

  return rows;
}

function matchList(text, regex, callback) {
  const match = text.match(regex);
  if (match) {
    callback(...match.slice(1));
  }
}

function relationship(subject, relation, object, source) {
  return {
    subject,
    relation,
    object,
    ...source
  };
}

function dedupeRelationships(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.subject}|${row.relation}|${row.object}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitNames(text) {
  return String(text)
    .replace(/\.$/, "")
    .split(/\s*,\s*|\s+y\s+/u)
    .map((name) => firstName(name.trim()))
    .filter(Boolean);
}

function firstName(text) {
  return String(text).split(/\s+/)[0]?.replace(/[^\p{L}0-9]/gu, "") ?? "";
}

function titleName(text) {
  const cleaned = String(text).trim();
  if (!cleaned) {
    return cleaned;
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function singularizeRelation(relation) {
  const map = {
    hijos: "hijo",
    hijas: "hija",
    primas: "prima",
    primos: "primo",
    tias: "tia",
    tios: "tio",
    abuelas: "abuela",
    abuelos: "abuelo",
    perritos: "perrito",
    perros: "perro",
    mascotas: "mascota"
  };
  return map[relation] ?? relation;
}

function countPhrases(texts) {
  const counts = {};
  for (const text of texts) {
    const words = tokenize(text).filter((word) => !stopWords.has(word));
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= words.length - size; index++) {
        const phrase = words.slice(index, index + size).join(" ");
        if (phrase.length >= 5) {
          counts[phrase] = (counts[phrase] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

function countLineEdges(texts, edge) {
  const counts = {};
  for (const text of texts) {
    const words = tokenize(text);
    const slice = edge === "start" ? words.slice(0, 3) : words.slice(-3);
    if (slice.length > 0) {
      const phrase = slice.join(" ");
      counts[phrase] = (counts[phrase] ?? 0) + 1;
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

function ratio(count, total) {
  if (total === 0) {
    return 0;
  }
  return Math.round((count / total) * 1000) / 1000;
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
