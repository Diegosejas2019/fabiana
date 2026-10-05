#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [, , memoriesPath, deepProfilePath, outputPath, ...rawFlags] = process.argv;

if (!memoriesPath || !deepProfilePath || !outputPath) {
  console.error(
    "Uso: node scripts/build-dimensional-profile.js <memories.jsonl> <deep-profile.json> <output.json> [--role targetPerson] [--evidence-limit 14]"
  );
  process.exit(1);
}

const flags = parseFlags(rawFlags);
const role = flags.role ?? "targetPerson";
const evidenceLimit = Number(flags["evidence-limit"] ?? 14);
const memories = readJsonLines(await readFile(memoriesPath, "utf8"));
const deepProfile = JSON.parse(await readFile(deepProfilePath, "utf8"));
const aliasMap = buildAliasMap(deepProfile);
const dimensions = buildDimensionDefinitions(deepProfile);
const sourceRows = memories
  .filter((memory) => memory.text && (memory.role === role || memory.sourceType === "conversation_context" || memory.sourceType === "user_assertion"))
  .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

const classified = sourceRows.map((memory) => classifyMemory(memory, dimensions, aliasMap));
const profile = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  role,
  source: {
    memoriesPath,
    deepProfilePath,
    memoryCount: memories.length,
    classifiedCount: classified.filter((row) => row.dimensions.length > 0).length,
  },
  dimensions: dimensions.map((dimension) => buildDimensionSummary(dimension, classified, evidenceLimit)),
  entities: buildEntitySummary(classified),
  usagePolicy: {
    evidenceFirst: "Usar recuerdos aprobados o fuentes reales antes que datos generales del perfil.",
    userAssertions: "Los datos confirmados por Diego son hechos de contexto, no recuerdos ni forma de hablar.",
    dimensions: "Las dimensiones ayudan a elegir fuentes y tono; no autorizan inventar recuerdos.",
    rejectedFutureUse: "En etapas siguientes cada recuerdo tendra estado revisado/no usar/corregido.",
  },
  promptSummary: "",
};

profile.promptSummary = buildPromptSummary(profile);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      outputPath,
      dimensionCount: profile.dimensions.length,
      classifiedCount: profile.source.classifiedCount,
      strongestDimensions: profile.dimensions
        .slice()
        .sort((left, right) => right.evidenceCount - left.evidenceCount)
        .slice(0, 5)
        .map((dimension) => `${dimension.label}: ${dimension.evidenceCount}`),
    },
    null,
    2
  )
);

function buildDimensionDefinitions(profile) {
  const relationships = profile.relationshipMap?.relationships ?? [];
  const relationTerms = relationships.flatMap((row) => [row.object, row.relation]).filter(Boolean);
  const aliases = profile.familyAliases?.flatMap((row) => [row.name, ...(row.aliases ?? [])]) ?? [];
  return [
    {
      id: "identity",
      label: "Identidad",
      description: "Nombre, apodos, forma general de presentarse y marcas basicas de voz.",
      keywords: [
        "fabi",
        "fabiana",
        "die",
        "hermana",
        "soy",
        "estoy",
        "gracias",
        "hola",
        "buen dia",
        "buenas",
      ],
      entityHints: ["Fabiana", "Diego"],
      policy: "Usar para tono e identidad conversacional, no para inferir hechos nuevos.",
    },
    {
      id: "family_bonds",
      label: "Familia y vinculos",
      description: "Hijos, hermano, pareja, abuela, primas, tias, mascotas y vinculos afectivos.",
      keywords: [
        "hijo",
        "hija",
        "hijos",
        "chicos",
        "familia",
        "hermano",
        "marido",
        "abuela",
        "prima",
        "tia",
        "perro",
        "perrito",
        "gato",
        "gatito",
        ...relationTerms,
        ...aliases,
      ],
      entityHints: relationTerms.concat(aliases),
      policy: "Usar como contexto familiar fuerte cuando la fuente sea confirmada o aparezca en mensajes reales.",
    },
    {
      id: "life_story",
      label: "Historia",
      description: "Momentos, hitos, cambios, recuerdos fechados y contexto biografico.",
      keywords: [
        "antes",
        "despues",
        "año",
        "anos",
        "cumple",
        "velorio",
        "recuerdo",
        "paso",
        "pasaba",
        "cuando",
        "siempre",
        "nunca",
      ],
      entityHints: [],
      policy: "Usar con fecha y fuente; si no hay fecha clara, responder con cautela.",
    },
    {
      id: "daily_routine",
      label: "Rutina cotidiana",
      description: "Casa, horarios, tramites, escuela, mandados, organizacion familiar y cosas de todos los dias.",
      keywords: [
        "casa",
        "mañana",
        "manana",
        "tarde",
        "noche",
        "horario",
        "retirar",
        "buscar",
        "llevar",
        "colegio",
        "escuela",
        "datos",
        "cargar",
        "limpiar",
        "comida",
        "cocinar",
        "mate",
        "trabajo",
        "organizar",
        "ayudar",
        "ayuda",
      ],
      entityHints: aliases,
      policy: "Priorizar episodios conversacionales porque suelen tener mas contexto que mensajes sueltos.",
    },
    {
      id: "health_body",
      label: "Salud y cuerpo",
      description: "Estomago, malestares, medicos, tratamientos, cansancio y cuidados fisicos.",
      keywords: [
        "estomago",
        "digestivo",
        "malestar",
        "medico",
        "doctor",
        "turno",
        "endoscopia",
        "dolor",
        "fiebre",
        "agua",
        "siento mal",
        "panza",
        "leche",
        "lechita",
        "tratamiento",
        "cansada",
      ],
      entityHints: [],
      policy: "Responder con cuidado y sin consejos medicos nuevos; usar solo contexto conversacional.",
    },
    {
      id: "emotional_voice",
      label: "Voz emocional",
      description: "Maneras de expresar cariño, preocupacion, gratitud, humor, cansancio o enojo.",
      keywords: [
        "gracias",
        "te quiero",
        "amo",
        "amor",
        "beso",
        "besos",
        "orgullosa",
        "perdon",
        "preocupada",
        "tranquilo",
        "jaja",
        "ja",
        "dios",
        "bendicion",
        "miedo",
      ],
      entityHints: [],
      policy: "Usar para redactar con tono natural, evitando despedidas o duelo si no fueron pedidos.",
    },
    {
      id: "preferences",
      label: "Gustos y preferencias",
      description: "Cine, comidas, musica, costumbres, intereses y elecciones personales.",
      keywords: [
        "pelicula",
        "peliculas",
        "terror",
        "suspenso",
        "comedia",
        "musica",
        "comida",
        "rico",
        "gusta",
        "gustan",
        "prefiero",
        "online",
      ],
      entityHints: [],
      policy: "Distinguir preferencias confirmadas por Diego de gustos inferidos por mensajes.",
    },
    {
      id: "evidence_limits",
      label: "Evidencia y limites",
      description: "Datos confirmados, fuentes dudosas, transcripciones sospechosas y reglas de uso.",
      keywords: [
        "dato confirmado",
        "confirmado",
        "no usar",
        "corregido",
        "transcripcion",
        "avianca",
        "vianca",
        "vian",
        "bianca",
        "fuente",
        "evidencia",
      ],
      entityHints: [],
      policy: "Usar para auditoria y para decidir si una fuente necesita revision humana.",
    },
  ].map((dimension) => ({
    ...dimension,
    keywords: unique(dimension.keywords.map((word) => normalize(word)).filter(Boolean)),
    entityHints: unique(dimension.entityHints.map((word) => String(word).trim()).filter(Boolean)),
  }));
}

function classifyMemory(memory, dimensions, aliasMap) {
  const text = String(memory.text ?? "");
  const normalized = normalize(text);
  const foundEntities = findEntities(normalized, aliasMap);
  const rows = [];

  for (const dimension of dimensions) {
    const matchedKeywords = dimension.keywords.filter((keyword) => keyword && normalized.includes(keyword));
    const matchedEntities = foundEntities.filter((entity) =>
      dimension.entityHints.some((hint) => normalize(hint) === normalize(entity.name) || entity.aliases.some((alias) => normalize(hint) === normalize(alias)))
    );
    const score = matchedKeywords.length + matchedEntities.length * 2 + sourceBoost(memory, dimension.id);
    if (score <= 0) {
      continue;
    }
    rows.push({
      id: dimension.id,
      score,
      matchedKeywords: matchedKeywords.slice(0, 8),
      matchedEntities: matchedEntities.map((entity) => entity.name).slice(0, 8),
    });
  }

  return {
    memory,
    entities: foundEntities.map((entity) => entity.name),
    dimensions: rows.sort((left, right) => right.score - left.score).slice(0, 4),
  };
}

function sourceBoost(memory, dimensionId) {
  if (dimensionId === "evidence_limits" && memory.sourceType === "user_assertion") {
    return 2;
  }
  if (dimensionId === "daily_routine" && memory.sourceType === "conversation_context") {
    return 1;
  }
  if (dimensionId === "identity" && memory.eligibleForPersona) {
    return 1;
  }
  return 0;
}

function buildDimensionSummary(dimension, classified, evidenceLimit) {
  const matches = classified
    .map((row) => ({
      ...row,
      dimension: row.dimensions.find((item) => item.id === dimension.id),
    }))
    .filter((row) => row.dimension)
    .sort((left, right) => right.dimension.score - left.dimension.score || String(right.memory.timestamp).localeCompare(String(left.memory.timestamp)));

  const sourceTypes = countItems(matches.map((row) => row.memory.sourceType ?? "unknown"));
  const entities = countItems(matches.flatMap((row) => row.entities));
  const dates = matches.map((row) => row.memory.localDate).filter(Boolean);
  return {
    id: dimension.id,
    label: dimension.label,
    description: dimension.description,
    policy: dimension.policy,
    evidenceCount: matches.length,
    dateRange: {
      first: dates.at(-1) ?? null,
      last: dates[0] ?? null,
    },
    sourceTypes,
    topEntities: topEntries(entities, 12),
    signals: topEntries(countItems(matches.flatMap((row) => row.dimension.matchedKeywords)), 12),
    evidence: matches.slice(0, evidenceLimit).map((row) => buildEvidence(row, dimension.id)),
  };
}

function buildEvidence(row, dimensionId) {
  const memory = row.memory;
  const dimension = row.dimension;
  return {
    memoryId: memory.id,
    messageId: memory.messageId,
    sourceType: memory.sourceType,
    role: memory.role,
    localDate: memory.localDate ?? null,
    localTime: memory.localTime ?? null,
    confidence: confidenceFor(memory, dimensionId),
    score: dimension.score,
    matchedKeywords: dimension.matchedKeywords,
    matchedEntities: dimension.matchedEntities,
    text: shorten(cleanText(memory.text), 360),
  };
}

function confidenceFor(memory, dimensionId) {
  if (memory.sourceType === "user_assertion") {
    return "confirmed_by_diego";
  }
  if (dimensionId === "daily_routine" && memory.sourceType === "conversation_context") {
    return "contextual_episode";
  }
  if (memory.sourceType === "audio_transcript") {
    return "transcribed_audio";
  }
  return "source_memory";
}

function buildEntitySummary(classified) {
  const counts = countItems(classified.flatMap((row) => row.entities));
  return topEntries(counts, 40);
}

function buildAliasMap(profile) {
  const byName = new Map();
  const relationships = profile.relationshipMap?.relationships ?? [];
  for (const row of relationships) {
    addAlias(byName, row.object, row.object);
    addAlias(byName, row.subject, row.subject);
  }
  for (const row of profile.familyAliases ?? []) {
    addAlias(byName, row.name, row.name);
    for (const alias of row.aliases ?? []) {
      addAlias(byName, row.name, alias);
    }
  }
  addAlias(byName, "Fabiana", "Fabi");
  addAlias(byName, "Diego", "Die");
  addAlias(byName, "Bianca", "Avianca");
  addAlias(byName, "Bianca", "Vianca");
  addAlias(byName, "Bianca", "Vian");
  return Array.from(byName.values());
}

function addAlias(map, name, alias) {
  const canonical = titleName(name);
  const cleanAlias = titleName(alias);
  if (!canonical || !cleanAlias) {
    return;
  }
  const key = normalize(canonical);
  const row = map.get(key) ?? { name: canonical, aliases: [] };
  row.aliases.push(cleanAlias);
  map.set(key, row);
}

function findEntities(normalizedText, aliasMap) {
  const found = [];
  for (const entity of aliasMap) {
    const aliases = unique([entity.name, ...entity.aliases]);
    if (aliases.some((alias) => containsTerm(normalizedText, normalize(alias)))) {
      found.push({
        name: entity.name,
        aliases,
      });
    }
  }
  return found;
}

function containsTerm(text, term) {
  if (!term) {
    return false;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "u").test(text);
}

function buildPromptSummary(profile) {
  return profile.dimensions
    .map((dimension) => {
      const entities = dimension.topEntities.slice(0, 6).map((entry) => entry.value).join(", ");
      const signals = dimension.signals.slice(0, 6).map((entry) => entry.value).join(", ");
      return `${dimension.label}: ${dimension.evidenceCount} evidencias. ${entities ? `Entidades: ${entities}. ` : ""}${signals ? `Senales: ${signals}. ` : ""}Regla: ${dimension.policy}`;
    })
    .join("\n");
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function parseFlags(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag.startsWith("--")) {
      continue;
    }
    const key = flag.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function titleName(text) {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function cleanText(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

function shorten(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function countItems(items) {
  const counts = {};
  for (const item of items.filter(Boolean)) {
    counts[item] = (counts[item] ?? 0) + 1;
  }
  return counts;
}

function topEntries(counts, limit) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}
