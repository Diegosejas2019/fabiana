const LINE_START =
  /^(?<date>\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(?<time>\d{1,2}:\d{2})(?:\s*)-\s(?<rest>.*)$/;

const MEDIA_REFERENCE =
  /(?<filename>[\w().\-\s]+?\.(?:opus|ogg|m4a|jpg|jpeg|png|webp|mp4|pdf|vcf))\b/i;

const AUDIO_EXTENSIONS = new Set(["opus", "ogg", "m4a"]);

export function parseWhatsAppText(text, options = {}) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const records = [];
  let current = null;

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index];
    const parsed = parseLineStart(line);

    if (parsed) {
      if (current) {
        records.push(finalizeRecord(current, records.length, options));
      }

      current = {
        ...parsed,
        sourceLineStart: lineNumber,
        sourceLineEnd: lineNumber
      };
      continue;
    }

    if (!current) {
      continue;
    }

    current.body += `\n${line}`;
    current.sourceLineEnd = lineNumber;
  }

  if (current) {
    records.push(finalizeRecord(current, records.length, options));
  }

  return records;
}

export function parseLineStart(line) {
  const match = line.match(LINE_START);
  if (!match?.groups) {
    return null;
  }

  const { date, time, rest } = match.groups;
  const separatorIndex = rest.indexOf(":");

  if (separatorIndex === -1) {
    return {
      kind: "system",
      localDate: date,
      localTime: time,
      timestamp: toTimestamp(date, time),
      author: null,
      body: rest
    };
  }

  const author = rest.slice(0, separatorIndex).trim();
  const body = rest.slice(separatorIndex + 1).trimStart();

  return {
    kind: "message",
    localDate: date,
    localTime: time,
    timestamp: toTimestamp(date, time),
    author: author.length > 0 ? author : null,
    body
  };
}

export function detectMediaReference(body) {
  const match = body.match(MEDIA_REFERENCE);
  if (!match?.groups) {
    return null;
  }

  return {
    filename: match.groups.filename.trim()
  };
}

export function summarizeRecords(records) {
  const byKind = {};
  const byAuthor = {};
  const mediaByExtension = {};
  let mediaMessages = 0;

  for (const record of records) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;

    if (record.kind === "message") {
      const author = record.author ?? "(autor vacio / self)";
      byAuthor[author] = (byAuthor[author] ?? 0) + 1;
    }

    if (record.media) {
      mediaMessages++;
      const extension = record.media.filename.split(".").pop()?.toLowerCase() ?? "";
      mediaByExtension[extension] = (mediaByExtension[extension] ?? 0) + 1;
    }
  }

  return {
    total: records.length,
    byKind,
    byAuthor,
    mediaMessages,
    mediaByExtension,
    firstTimestamp: records[0]?.timestamp ?? null,
    lastTimestamp: records.at(-1)?.timestamp ?? null
  };
}

export function reconcileMediaReferences(records, zipEntries) {
  const available = buildMediaInventory(zipEntries);

  const referenced = records
    .filter((record) => record.media?.filename)
    .map((record) => ({
      messageId: record.id,
      filename: record.media.filename,
      sourceLineStart: record.sourceLineStart
    }));

  const matched = [];
  const missing = [];

  for (const reference of referenced) {
    if (available.has(reference.filename.toLowerCase())) {
      matched.push(reference);
    } else {
      missing.push(reference);
    }
  }

  return {
    referencedCount: referenced.length,
    matchedCount: matched.length,
    missingCount: missing.length,
    missing
  };
}

export function normalizeRecords(records, zipEntries, options = {}) {
  const targetAuthor = options.targetAuthor;
  const selfLabel = options.selfLabel ?? "self";
  const inventory = buildMediaInventory(zipEntries);
  const participantMap = new Map();

  const normalized = records.map((record) => {
    const participant = resolveParticipant(record, {
      targetAuthor,
      selfLabel,
      participantMap
    });

    return {
      id: record.id,
      kind: record.kind,
      timestamp: record.timestamp,
      localDate: record.localDate,
      localTime: record.localTime,
      participantId: participant.id,
      role: participant.role,
      author: record.author,
      text: record.body ?? null,
      textLength: record.bodyLength,
      media: normalizeMedia(record.media, inventory),
      source: {
        format: "whatsapp_export",
        lineStart: record.sourceLineStart,
        lineEnd: record.sourceLineEnd
      }
    };
  });

  return {
    messages: normalized,
    participants: [...participantMap.values()],
    manifest: buildIngestionManifest(normalized, [...participantMap.values()])
  };
}

export function buildIngestionManifest(messages, participants) {
  const byRole = {};
  const byKind = {};
  const mediaByStatus = {};

  for (const message of messages) {
    byRole[message.role] = (byRole[message.role] ?? 0) + 1;
    byKind[message.kind] = (byKind[message.kind] ?? 0) + 1;

    if (message.media) {
      mediaByStatus[message.media.status] = (mediaByStatus[message.media.status] ?? 0) + 1;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    messageCount: messages.length,
    participants,
    byRole,
    byKind,
    mediaByStatus,
    firstTimestamp: messages[0]?.timestamp ?? null,
    lastTimestamp: messages.at(-1)?.timestamp ?? null
  };
}

export function buildAudioCandidates(messages) {
  const candidates = messages
    .filter((message) => message.media && AUDIO_EXTENSIONS.has(message.media.extension))
    .map((message) => ({
      id: `audio_${message.id}`,
      messageId: message.id,
      timestamp: message.timestamp,
      localDate: message.localDate,
      localTime: message.localTime,
      role: message.role,
      participantId: message.participantId,
      filename: message.media.filename,
      extension: message.media.extension,
      zipEntryName: message.media.zipEntryName,
      bytes: message.media.bytes,
      mediaStatus: message.media.status,
      priority: audioPriority(message),
      source: {
        messageId: message.id,
        lineStart: message.source.lineStart,
        lineEnd: message.source.lineEnd
      }
    }));

  return {
    candidates,
    manifest: buildAudioManifest(candidates)
  };
}

export function buildAudioManifest(candidates) {
  const byRole = {};
  const byExtension = {};
  const byStatus = {};
  let totalBytes = 0;

  for (const candidate of candidates) {
    byRole[candidate.role] = (byRole[candidate.role] ?? 0) + 1;
    byExtension[candidate.extension] = (byExtension[candidate.extension] ?? 0) + 1;
    byStatus[candidate.mediaStatus] = (byStatus[candidate.mediaStatus] ?? 0) + 1;
    totalBytes += candidate.bytes ?? 0;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    byRole,
    byExtension,
    byStatus,
    totalBytes,
    firstTimestamp: candidates[0]?.timestamp ?? null,
    lastTimestamp: candidates.at(-1)?.timestamp ?? null
  };
}

export function buildTranscriptionJobs(candidates, extractionManifest, options = {}) {
  const outputDir = options.outputDir ?? "data/processed/transcription";
  const language = options.language ?? "es";
  const extractedByCandidateId = new Map(
    (extractionManifest.files ?? [])
      .filter((file) => ["extracted", "skipped_existing"].includes(file.status))
      .map((file) => [file.candidateId, file])
  );

  const jobs = candidates
    .filter((candidate) => extractedByCandidateId.has(candidate.id))
    .map((candidate) => {
      const extracted = extractedByCandidateId.get(candidate.id);

      return {
        id: `transcript_${candidate.id}`,
        audioCandidateId: candidate.id,
        messageId: candidate.messageId,
        role: candidate.role,
        participantId: candidate.participantId,
        localAudioPath: extracted.localPath,
        bytes: extracted.bytes,
        status: "pending",
        engine: null,
        language,
        transcriptPath: `${outputDir}/items/${candidate.id}.json`,
        source: candidate.source
      };
    });

  return {
    jobs,
    manifest: buildTranscriptionManifest(jobs, {
      extractionManifestPath: options.extractionManifestPath ?? null
    })
  };
}

export function buildTranscriptionManifest(jobs, options = {}) {
  const byRole = {};
  const byStatus = {};
  let totalBytes = 0;

  for (const job of jobs) {
    byRole[job.role] = (byRole[job.role] ?? 0) + 1;
    byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    totalBytes += job.bytes ?? 0;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    extractionManifestPath: options.extractionManifestPath,
    jobCount: jobs.length,
    byRole,
    byStatus,
    totalBytes
  };
}

function finalizeRecord(record, index, options) {
  return {
    id: `msg_${String(index + 1).padStart(6, "0")}`,
    kind: record.kind,
    timestamp: record.timestamp,
    localDate: record.localDate,
    localTime: record.localTime,
    author: record.author,
    body: options.omitBody ? undefined : record.body,
    bodyLength: record.body.length,
    media: detectMediaReference(record.body),
    sourceLineStart: record.sourceLineStart,
    sourceLineEnd: record.sourceLineEnd
  };
}

function buildMediaInventory(zipEntries) {
  const available = new Map();

  for (const entry of zipEntries) {
    const name = basename(entry.name ?? entry.FullName ?? "");
    if (!name) {
      continue;
    }

    available.set(name.toLowerCase(), entry);
  }

  return available;
}

function resolveParticipant(record, options) {
  if (record.kind === "system") {
    return ensureParticipant(options.participantMap, {
      id: "participant_system",
      role: "system",
      author: null,
      displayName: "WhatsApp system"
    });
  }

  if (record.author === options.targetAuthor) {
    return ensureParticipant(options.participantMap, {
      id: "participant_target",
      role: "targetPerson",
      author: record.author,
      displayName: record.author
    });
  }

  if (record.author === null) {
    return ensureParticipant(options.participantMap, {
      id: "participant_self",
      role: "self",
      author: null,
      displayName: options.selfLabel
    });
  }

  const id = `participant_other_${slugify(record.author)}`;

  return ensureParticipant(options.participantMap, {
    id,
    role: "other",
    author: record.author,
    displayName: record.author
  });
}

function ensureParticipant(participantMap, participant) {
  if (!participantMap.has(participant.id)) {
    participantMap.set(participant.id, participant);
  }

  return participantMap.get(participant.id);
}

function normalizeMedia(media, inventory) {
  if (!media) {
    return null;
  }

  const entry = inventory.get(media.filename.toLowerCase());
  const extension = media.filename.split(".").pop()?.toLowerCase() ?? "";

  return {
    filename: media.filename,
    extension,
    status: entry ? "matched" : "missing",
    zipEntryName: entry?.name ?? null,
    bytes: entry?.length ?? null
  };
}

function audioPriority(message) {
  if (message.media?.status !== "matched") {
    return 0;
  }

  if (message.role === "targetPerson") {
    return 100;
  }

  if (message.role === "self") {
    return 60;
  }

  if (message.role === "other") {
    return 40;
  }

  return 0;
}

function toTimestamp(date, time) {
  const [day, month, year] = date.split("/").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const fullYear = year < 100 ? 2000 + year : year;

  return new Date(Date.UTC(fullYear, month - 1, day, hour + 3, minute)).toISOString();
}

function basename(path) {
  return path.split(/[\\/]/).at(-1);
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}
