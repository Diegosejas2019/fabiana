import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAudioCandidates,
  buildMemoryChunks,
  buildMemories,
  buildTranscriptionJobs,
  detectMediaReference,
  normalizeRecords,
  parseLineStart,
  parseWhatsAppText,
  reconcileMediaReferences,
  summarizeRecords
} from "../src/index.js";

test("parses a regular WhatsApp message", () => {
  const parsed = parseLineStart("31/12/2023, 13:09 - Fabiana Sejas: Hola");

  assert.equal(parsed.kind, "message");
  assert.equal(parsed.author, "Fabiana Sejas");
  assert.equal(parsed.body, "Hola");
  assert.equal(parsed.localDate, "31/12/2023");
  assert.equal(parsed.localTime, "13:09");
});

test("parses system messages without author", () => {
  const parsed = parseLineStart("30/12/2023, 18:50 - Los mensajes estan cifrados");

  assert.equal(parsed.kind, "system");
  assert.equal(parsed.author, null);
  assert.equal(parsed.body, "Los mensajes estan cifrados");
});

test("keeps empty author as null", () => {
  const parsed = parseLineStart("31/12/2023, 11:49 - : Mensaje propio");

  assert.equal(parsed.kind, "message");
  assert.equal(parsed.author, null);
  assert.equal(parsed.body, "Mensaje propio");
});

test("joins multiline messages", () => {
  const records = parseWhatsAppText(
    [
      "31/12/2023, 13:09 - Fabiana Sejas: Primera linea",
      "segunda linea",
      "31/12/2023, 13:10 - : Respuesta"
    ].join("\n")
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].body, "Primera linea\nsegunda linea");
  assert.equal(records[0].sourceLineStart, 1);
  assert.equal(records[0].sourceLineEnd, 2);
});

test("detects media references", () => {
  assert.deepEqual(detectMediaReference("PTT-20240101-WA0018.opus (archivo adjunto)"), {
    filename: "PTT-20240101-WA0018.opus"
  });
});

test("summarizes without exposing bodies", () => {
  const records = parseWhatsAppText(
    [
      "31/12/2023, 13:09 - Fabiana Sejas: PTT-20240101-WA0018.opus (archivo adjunto)",
      "31/12/2023, 13:10 - : Hola"
    ].join("\n"),
    { omitBody: true }
  );

  const summary = summarizeRecords(records);

  assert.equal(records[0].body, undefined);
  assert.equal(summary.total, 2);
  assert.equal(summary.byAuthor["Fabiana Sejas"], 1);
  assert.equal(summary.byAuthor["(autor vacio / self)"], 1);
  assert.equal(summary.mediaMessages, 1);
  assert.equal(summary.mediaByExtension.opus, 1);
});

test("reconciles referenced media against zip inventory", () => {
  const records = parseWhatsAppText(
    [
      "31/12/2023, 13:09 - Fabiana Sejas: IMG-20240101-WA0049.jpg (archivo adjunto)",
      "31/12/2023, 13:10 - : PTT-20240101-WA0018.opus (archivo adjunto)"
    ].join("\n"),
    { omitBody: true }
  );

  const result = reconcileMediaReferences(records, [
    { name: "IMG-20240101-WA0049.jpg" }
  ]);

  assert.equal(result.referencedCount, 2);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.missing[0].filename, "PTT-20240101-WA0018.opus");
});

test("normalizes records with participants, roles, sources, and media status", () => {
  const records = parseWhatsAppText(
    [
      "30/12/2023, 18:50 - Mensaje de sistema",
      "31/12/2023, 13:09 - Fabiana Sejas: IMG-20240101-WA0049.jpg (archivo adjunto)",
      "31/12/2023, 13:10 - : Respuesta propia",
      "31/12/2023, 13:11 - Otra Persona: Documento.pdf (archivo adjunto)"
    ].join("\n")
  );

  const ingestion = normalizeRecords(records, [{ name: "IMG-20240101-WA0049.jpg", length: 123 }], {
    targetAuthor: "Fabiana Sejas",
    selfLabel: "Diego"
  });

  assert.equal(ingestion.messages.length, 4);
  assert.equal(ingestion.messages[0].role, "system");
  assert.equal(ingestion.messages[1].role, "targetPerson");
  assert.equal(ingestion.messages[1].media.status, "matched");
  assert.equal(ingestion.messages[2].role, "self");
  assert.equal(ingestion.messages[3].role, "other");
  assert.equal(ingestion.messages[3].media.status, "missing");
  assert.equal(ingestion.messages[1].source.format, "whatsapp_export");
  assert.equal(ingestion.manifest.byRole.targetPerson, 1);
  assert.equal(ingestion.manifest.byRole.self, 1);
  assert.equal(ingestion.manifest.mediaByStatus.matched, 1);
  assert.equal(ingestion.manifest.mediaByStatus.missing, 1);
});

test("builds audio candidates without message text", () => {
  const messages = [
    {
      id: "msg_000001",
      timestamp: "2024-01-01T04:13:00.000Z",
      localDate: "1/1/2024",
      localTime: "01:13",
      role: "targetPerson",
      participantId: "participant_target",
      text: "contenido privado",
      media: {
        filename: "PTT-20240101-WA0018.opus",
        extension: "opus",
        zipEntryName: "PTT-20240101-WA0018.opus",
        bytes: 64507,
        status: "matched"
      },
      source: {
        lineStart: 12,
        lineEnd: 12
      }
    },
    {
      id: "msg_000002",
      timestamp: "2024-01-01T04:14:00.000Z",
      localDate: "1/1/2024",
      localTime: "01:14",
      role: "self",
      participantId: "participant_self",
      text: "imagen privada",
      media: {
        filename: "IMG-20240101-WA0049.jpg",
        extension: "jpg",
        zipEntryName: "IMG-20240101-WA0049.jpg",
        bytes: 120,
        status: "matched"
      },
      source: {
        lineStart: 13,
        lineEnd: 13
      }
    }
  ];

  const inventory = buildAudioCandidates(messages);

  assert.equal(inventory.candidates.length, 1);
  assert.equal(inventory.candidates[0].messageId, "msg_000001");
  assert.equal(inventory.candidates[0].priority, 100);
  assert.equal("text" in inventory.candidates[0], false);
  assert.equal(inventory.manifest.candidateCount, 1);
  assert.equal(inventory.manifest.byRole.targetPerson, 1);
  assert.equal(inventory.manifest.byExtension.opus, 1);
});

test("builds pending transcription jobs from extracted audio", () => {
  const candidates = [
    {
      id: "audio_msg_000001",
      messageId: "msg_000001",
      role: "targetPerson",
      participantId: "participant_target",
      source: {
        messageId: "msg_000001",
        lineStart: 12,
        lineEnd: 12
      }
    },
    {
      id: "audio_msg_000002",
      messageId: "msg_000002",
      role: "self",
      participantId: "participant_self",
      source: {
        messageId: "msg_000002",
        lineStart: 13,
        lineEnd: 13
      }
    }
  ];

  const batch = buildTranscriptionJobs(
    candidates,
    {
      files: [
        {
          candidateId: "audio_msg_000001",
          localPath: "data/processed/audio/extracted-target/PTT-1.opus",
          bytes: 123,
          status: "extracted"
        }
      ]
    },
    { outputDir: "data/processed/transcription" }
  );

  assert.equal(batch.jobs.length, 1);
  assert.equal(batch.jobs[0].id, "transcript_audio_msg_000001");
  assert.equal(batch.jobs[0].status, "pending");
  assert.equal(batch.jobs[0].engine, null);
  assert.equal(batch.jobs[0].language, "es");
  assert.equal("text" in batch.jobs[0], false);
  assert.equal(batch.manifest.jobCount, 1);
  assert.equal(batch.manifest.byStatus.pending, 1);
});

test("builds memories from written messages and audio transcripts", () => {
  const messages = [
    {
      id: "msg_000001",
      kind: "system",
      role: "system",
      text: "system",
      source: { lineStart: 1, lineEnd: 1 }
    },
    {
      id: "msg_000002",
      kind: "message",
      timestamp: "2024-01-01T00:00:00.000Z",
      localDate: "1/1/2024",
      localTime: "00:00",
      role: "targetPerson",
      participantId: "participant_target",
      text: "Hola escrito",
      media: null,
      source: { lineStart: 2, lineEnd: 2 }
    },
    {
      id: "msg_000003",
      kind: "message",
      timestamp: "2024-01-01T00:01:00.000Z",
      localDate: "1/1/2024",
      localTime: "00:01",
      role: "targetPerson",
      participantId: "participant_target",
      text: "PTT-1.opus (archivo adjunto)",
      media: { filename: "PTT-1.opus", extension: "opus" },
      source: { lineStart: 3, lineEnd: 3 }
    },
    {
      id: "msg_000004",
      kind: "message",
      timestamp: "2024-01-01T00:02:00.000Z",
      localDate: "1/1/2024",
      localTime: "00:02",
      role: "self",
      participantId: "participant_self",
      text: "Respuesta",
      media: null,
      source: { lineStart: 4, lineEnd: 4 }
    }
  ];
  const transcripts = [
    {
      messageId: "msg_000003",
      audioCandidateId: "audio_msg_000003",
      engine: "faster-whisper",
      model: "small",
      text: "Hola desde audio"
    }
  ];

  const memory = buildMemories(messages, transcripts);

  assert.equal(memory.memories.length, 3);
  assert.equal(memory.memories[0].sourceType, "whatsapp_text");
  assert.equal(memory.memories[1].sourceType, "audio_transcript");
  assert.equal(memory.memories[1].text, "Hola desde audio");
  assert.equal(memory.memories[1].eligibleForPersona, true);
  assert.equal(memory.memories[2].eligibleForPersona, false);
  assert.equal(memory.manifest.bySourceType.whatsapp_text, 2);
  assert.equal(memory.manifest.bySourceType.audio_transcript, 1);
  assert.equal(memory.manifest.targetPersonCount, 2);
});

test("builds chunks while preserving evidence", () => {
  const memories = [
    {
      id: "mem_1",
      messageId: "msg_1",
      timestamp: "2024-01-01T00:00:00.000Z",
      localDate: "1/1/2024",
      localTime: "00:00",
      role: "targetPerson",
      participantId: "participant_target",
      sourceType: "whatsapp_text",
      text: "uno dos tres cuatro cinco seis",
      textLength: 30,
      eligibleForPersona: true,
      evidence: { kind: "whatsapp_text", messageId: "msg_1" }
    }
  ];

  const result = buildMemoryChunks(memories, { maxChars: 12, overlapChars: 3 });

  assert.equal(result.chunks.length > 1, true);
  assert.equal(result.chunks[0].memoryId, "mem_1");
  assert.equal(result.chunks[0].eligibleForPersona, true);
  assert.deepEqual(result.chunks[0].evidence, memories[0].evidence);
  assert.equal(result.manifest.byRole.targetPerson, result.chunks.length);
});
