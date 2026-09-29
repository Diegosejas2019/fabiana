#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [, , memoriesPath, outputPath, ...rawFlags] = process.argv;

if (!memoriesPath || !outputPath) {
  console.error("Uso: node scripts/extract-family-entity-candidates.js <memories.jsonl> <output.json> [--role targetPerson] [--min-confidence 0.9]");
  process.exit(1);
}

const flags = parseFlags(rawFlags);
const role = flags.role ?? "targetPerson";
const minConfidence = Number(flags["min-confidence"] ?? 0.9);
const maxEvidence = Number(flags["max-evidence"] ?? 6);
const nameStopWords = new Set([
  "algo",
  "alla",
  "alli",
  "aca",
  "asi",
  "bien",
  "boludo",
  "buchona",
  "bueno",
  "calor",
  "casa",
  "chico",
  "como",
  "cosa",
  "cosas",
  "cuando",
  "donde",
  "despues",
  "enfermarse",
  "gra",
  "igual",
  "juega",
  "lechita",
  "mucho",
  "nada",
  "para",
  "parece",
  "porque",
  "quien",
  "que",
  "ravioles",
  "sanos",
  "sorete",
  "tambien",
  "todo",
  "todos",
  "vergüenza",
  "verguenza"
]);
const memories = readJsonLines(await readFile(memoriesPath, "utf8"));
const backupMemories = memories
  .filter((memory) => memory.role === role)
  .filter((memory) => memory.sourceType !== "user_assertion")
  .filter((memory) => memory.text && ["whatsapp_text", "audio_transcript", "facebook_text"].includes(memory.sourceType))
  .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));

const candidates = buildCandidates(backupMemories, { minConfidence, maxEvidence });
const review = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    memoriesPath,
    memoryCount: backupMemories.length,
    role,
    sourceTypes: ["whatsapp_text", "audio_transcript", "facebook_text"]
  },
  policy: {
    targetPrecision: 0.95,
    note: "Candidatos extraidos de backups para revision humana. No se convierten en datos confirmados hasta que Diego los aprueba.",
    acceptance: "Solo patrones explicitos de parentesco con nombre propio o evidencia repetida pasan el umbral."
  },
  summary: {
    candidateCount: candidates.length,
    highConfidenceCount: candidates.filter((candidate) => candidate.confidence >= 0.95).length
  },
  candidates
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      memoryCount: backupMemories.length,
      candidateCount: review.summary.candidateCount,
      highConfidenceCount: review.summary.highConfidenceCount
    },
    null,
    2
  )
);

export function buildCandidates(memories, options = {}) {
  const minConfidence = options.minConfidence ?? 0.9;
  const maxEvidence = options.maxEvidence ?? 6;
  const grouped = new Map();

  for (const memory of memories) {
    for (const match of extractMatches(memory)) {
      const key = `${match.subject}|${match.relation}|${match.object}`.toLowerCase();
      const candidate = grouped.get(key) ?? {
        schemaVersion: 1,
        id: makeCandidateId(match.subject, match.relation, match.object),
        status: "pending",
        subject: match.subject,
        relation: match.relation,
        object: match.object,
        assertionText: `${match.object} es ${displayRelationForAssertion(match.relation)} de ${match.subject}.`,
        confidence: 0,
        supportCount: 0,
        sourceTypes: [],
        dateRange: {
          first: null,
          last: null
        },
        reasons: [],
        evidence: []
      };

      candidate.supportCount += match.weight;
      candidate.reasons.push(match.reason);
      candidate.sourceTypes.push(memory.sourceType);
      candidate.dateRange.first = earlierDate(candidate.dateRange.first, memory.timestamp);
      candidate.dateRange.last = laterDate(candidate.dateRange.last, memory.timestamp);
      if (candidate.evidence.length < maxEvidence) {
        candidate.evidence.push({
          messageId: memory.messageId,
          timestamp: memory.timestamp,
          localDate: memory.localDate,
          localTime: memory.localTime,
          role: memory.role,
          sourceType: memory.sourceType,
          pattern: match.pattern,
          text: shorten(cleanText(memory.text), 360)
        });
      }
      grouped.set(key, candidate);
    }
  }

  return Array.from(grouped.values())
    .map((candidate) => finalizeCandidate(candidate))
    .filter((candidate) => candidate.confidence >= minConfidence)
    .sort((left, right) => right.confidence - left.confidence || right.supportCount - left.supportCount || left.object.localeCompare(right.object));
}

function extractMatches(memory) {
  const text = cleanText(memory.text);
  const normalized = normalize(text);
  const matches = [];

  collect(normalized, /\bmi\s+(hijo|hija|hermano|hermana|marido|esposo|sobrina|sobrino|sobri|tia|tio|abuela|abuelo|mama|madre|papa|padre)\s+([a-záéíóúüñ]{3,24})\b/gu, (relation, name) => {
    matches.push(buildMatch(relation, name, "posesivo explicito con nombre", "mi-relacion-nombre", 3));
  });

  collect(normalized, /\b(?:la|el)\s+(tia|tio|abuela|abuelo)\s+([a-záéíóúüñ]{3,24})\b/gu, (relation, name) => {
    matches.push(buildMatch(relation, name, "parentesco familiar con articulo y nombre", "articulo-relacion-nombre", 2));
  });

  collect(normalized, /\b([a-záéíóúüñ]{3,24})\s+es\s+mi\s+(hijo|hija|hermano|hermana|marido|esposo|sobrina|sobrino|sobri|tia|tio|abuela|abuelo|mama|madre|papa|padre)\b/gu, (name, relation) => {
    matches.push(buildMatch(relation, name, "nombre enlazado por 'es mi'", "nombre-es-mi-relacion", 3));
  });

  collect(normalized, /\bmis\s+(hijos|hijas|hermanos|hermanas|sobrinos|sobrinas|tias|tios|abuelos|abuelas)\s+([a-záéíóúüñ,\s]+?)\b(?:son|estan|están|y|,|$)/gu, (relation, names) => {
    for (const name of splitPossibleNames(names).slice(0, 5)) {
      matches.push(buildMatch(relation, name, "lista posesiva de familiares", "mis-relacion-lista", 2));
    }
  });

  return matches.filter(Boolean);
}

function buildMatch(relation, rawName, reason, pattern, weight) {
  const object = titleName(rawName);
  if (!isValidName(object)) {
    return null;
  }
  return {
    subject: "Fabiana",
    relation: canonicalRelation(relation),
    object,
    reason,
    pattern,
    weight
  };
}

function finalizeCandidate(candidate) {
  const distinctSources = new Set(candidate.evidence.map((item) => item.messageId)).size;
  const sourceTypes = unique(candidate.sourceTypes);
  const reasons = unique(candidate.reasons);
  const hasTextSource = candidate.evidence.some((item) => item.sourceType === "whatsapp_text" || item.sourceType === "facebook_text");
  const hasRepeatedEvidence = distinctSources >= 2;
  const hasStrongPattern = candidate.evidence.some((item) => ["mi-relacion-nombre", "nombre-es-mi-relacion"].includes(item.pattern));
  let confidence = 0.86;

  if (hasStrongPattern) {
    confidence += 0.07;
  }
  if (hasTextSource) {
    confidence += 0.03;
  }
  if (hasRepeatedEvidence) {
    confidence += 0.04;
  }
  if (distinctSources >= 3) {
    confidence += 0.02;
  }

  return {
    ...candidate,
    confidence: Math.min(0.99, Math.round(confidence * 100) / 100),
    supportCount: Math.round(candidate.supportCount * 100) / 100,
    sourceTypes,
    reasons,
    evidenceCount: candidate.evidence.length
  };
}

function displayRelationForAssertion(relation) {
  const labels = {
    marido: "marido",
    hijo: "hijo",
    hija: "hija",
    hermano: "hermano",
    hermana: "hermana",
    sobrina: "sobrina",
    sobrino: "sobrino",
    tia: "tia",
    tio: "tio",
    abuela: "abuela",
    abuelo: "abuelo",
    madre: "madre",
    padre: "padre"
  };
  return labels[relation] ?? relation;
}

function canonicalRelation(relation) {
  const map = {
    hijos: "hijo",
    hijas: "hija",
    hermanos: "hermano",
    hermanas: "hermana",
    marido: "marido",
    esposo: "marido",
    sobrina: "sobrina",
    sobrino: "sobrino",
    sobri: "sobrina",
    sobrinas: "sobrina",
    sobrinos: "sobrino",
    tias: "tia",
    tia: "tia",
    tios: "tio",
    tio: "tio",
    abuelas: "abuela",
    abuela: "abuela",
    abuelos: "abuelo",
    abuelo: "abuelo",
    mama: "madre",
    madre: "madre",
    papa: "padre",
    padre: "padre"
  };
  return map[relation] ?? relation;
}

function splitPossibleNames(text) {
  return String(text)
    .split(/\s*,\s*|\s+y\s+/u)
    .map((item) => item.trim().split(/\s+/u)[0])
    .filter(Boolean);
}

function isValidName(name) {
  const normalized = normalize(name);
  if (!/^[a-záéíóúüñ]{4,24}$/u.test(normalized)) {
    return false;
  }
  return !nameStopWords.has(normalized);
}

function collect(text, regex, callback) {
  for (const match of text.matchAll(regex)) {
    callback(...match.slice(1));
  }
}

function makeCandidateId(subject, relation, object) {
  return `family_${slug(subject)}_${slug(relation)}_${slug(object)}`;
}

function slug(value) {
  return normalize(value)
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function titleName(text) {
  const normalized = normalize(String(text).trim()).replace(/[^a-záéíóúüñ]/gu, "");
  if (!normalized) {
    return "";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function cleanText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function shorten(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3).trimEnd()}...`;
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function earlierDate(left, right) {
  if (!left) {
    return right ?? null;
  }
  if (!right) {
    return left;
  }
  return String(right).localeCompare(String(left)) < 0 ? right : left;
}

function laterDate(left, right) {
  if (!left) {
    return right ?? null;
  }
  if (!right) {
    return left;
  }
  return String(right).localeCompare(String(left)) > 0 ? right : left;
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
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
