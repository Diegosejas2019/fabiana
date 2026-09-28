const LINE_START =
  /^(?<date>\d{1,2}\/\d{1,2}\/\d{2,4}),\s+(?<time>\d{1,2}:\d{2})(?:\s*)-\s(?<rest>.*)$/;

const MEDIA_REFERENCE =
  /(?<filename>[\w().\-\s]+?\.(?:opus|ogg|m4a|jpg|jpeg|png|webp|mp4|pdf|vcf))\b/i;

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
  const available = new Map();

  for (const entry of zipEntries) {
    const name = basename(entry.name ?? entry.FullName ?? "");
    if (!name) {
      continue;
    }

    available.set(name.toLowerCase(), entry);
  }

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

function toTimestamp(date, time) {
  const [day, month, year] = date.split("/").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const fullYear = year < 100 ? 2000 + year : year;

  return new Date(Date.UTC(fullYear, month - 1, day, hour + 3, minute)).toISOString();
}

function basename(path) {
  return path.split(/[\\/]/).at(-1);
}
