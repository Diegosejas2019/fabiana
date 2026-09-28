import assert from "node:assert/strict";
import test from "node:test";
import {
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
