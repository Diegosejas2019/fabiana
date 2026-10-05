#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const publicDir = resolve(root, "apps/chat");
const pythonPath = resolve(root, ".venv/Scripts/python.exe");
const answerScript = resolve(root, "scripts/answer-memory.py");
const addAssertionScript = resolve(root, "scripts/add-user-assertion.js");
const buildAssertionMemoriesScript = resolve(root, "scripts/build-user-assertion-memories.js");
const mergeMemoriesScript = resolve(root, "scripts/merge-memories.js");
const memoryCliScript = resolve(root, "packages/whatsapp-parser/src/cli.js");
const embedScript = resolve(root, "scripts/embed-memory-chunks.py");
const buildConversationMemoryV2Script = resolve(root, "scripts/build-conversation-memory-v2.js");
const buildStyleProfileScript = resolve(root, "scripts/build-style-profile.js");
const buildDeepProfileScript = resolve(root, "scripts/build-deep-profile.js");
const buildDimensionalProfileScript = resolve(root, "scripts/build-dimensional-profile.js");
const extractFamilyEntitiesScript = resolve(root, "scripts/extract-family-entity-candidates.js");
const whatsappMemoriesPath = resolve(root, "data/processed/memory/memories.jsonl");
const facebookMemoriesPath = resolve(root, "data/processed/facebook/memories.jsonl");
const assertionDir = resolve(root, "data/processed/user-assertions");
const assertionsPath = resolve(assertionDir, "assertions.jsonl");
const assertionMemoriesPath = resolve(assertionDir, "memories.jsonl");
const combinedMemoryDir = resolve(root, "data/processed/combined-memory");
const combinedMemoriesPath = resolve(combinedMemoryDir, "memories.jsonl");
const combinedChunksPath = resolve(root, "data/processed/combined-memory/chunks.jsonl");
const combinedIndexDir = resolve(root, "data/processed/combined-rag");
const combinedMemoryV2Dir = resolve(root, "data/processed/combined-memory-v2");
const combinedMemoriesV2Path = resolve(combinedMemoryV2Dir, "memories.jsonl");
const combinedChunksV2Path = resolve(root, "data/processed/combined-memory-v2/chunks.jsonl");
const combinedIndexV2Dir = resolve(root, "data/processed/combined-rag-v2");
const defaultChunksPath = resolve(root, "data/processed/memory/chunks.jsonl");
const defaultIndexDir = resolve(root, "data/processed/rag");
const styleProfilePath = resolve(root, "data/processed/persona/persona-style.json");
const deepProfilePath = resolve(root, "data/processed/persona/deep-profile.json");
const dimensionalProfilePath = resolve(root, "data/processed/persona/dimensional-profile.json");
const approvedResponsesPath = resolve(root, "data/processed/feedback/approved-responses.jsonl");
const responseFeedbackPath = resolve(root, "data/processed/feedback/response-feedback.jsonl");
const evalCasesPath = resolve(root, "quality/eval-cases.json");
const evaluationsDir = resolve(root, "data/processed/evaluations");
const transcriptionJobsPath = resolve(root, "data/processed/transcription/transcription-jobs.jsonl");
const extractedAudioDir = resolve(root, "data/processed/audio/extracted-target");
const videoCandidatesPath = resolve(root, "data/processed/video/video-candidates.jsonl");
const extractedVideoDir = resolve(root, "data/processed/video/extracted-target");
const videoExtractionManifestPath = resolve(extractedVideoDir, "extraction-manifest.json");
const videoDeletionsPath = resolve(root, "data/processed/video/deleted-videos.jsonl");
const extractVideoScript = resolve(root, "scripts/extract-video-candidates.ps1");
const entityReviewDir = resolve(root, "data/processed/entity-review");
const familyCandidatesPath = resolve(entityReviewDir, "family-candidates.json");
const familyReviewsPath = resolve(entityReviewDir, "family-reviews.jsonl");
const port = Number(process.env.PORT ?? 4173);
let assertionQueue = Promise.resolve();
let audioCandidateIndex = null;
let videoCandidateIndex = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".webm": "video/webm"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/answer") {
      await handleAnswer(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/assert") {
      await handleAssertion(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/feedback/approve") {
      await handleApprovedResponse(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/feedback/review") {
      await handleResponseFeedback(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/entities/family") {
      await handleFamilyEntities(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/profile") {
      await handleProfile(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/learning") {
      await handleLearningSummary(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/learning/export") {
      await handleLearningExport(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/entities/family/rebuild") {
      await handleFamilyEntityRebuild(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/entities/family/review") {
      await handleFamilyEntityReview(request, response);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/audio/")) {
      await handleAudio(request, response, url, request.method === "HEAD");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/videos") {
      await handleVideos(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/videos/extract") {
      await handleVideoExtraction(request, response);
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/video/")) {
      await handleVideo(request, response, url, request.method === "HEAD");
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/video/")) {
      await handleVideoDelete(request, response, url);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(url.pathname, response, request.method === "HEAD");
      return;
    }

    response.writeHead(405).end("Method not allowed");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, () => {
  console.log(`Memoria AI local: http://localhost:${port}`);
});

async function handleAnswer(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const query = String(payload.query ?? "").trim();

  if (!query) {
    response.writeHead(400).end("Missing query");
    return;
  }

  const assertionText = extractAssertionText(query);
  if (assertionText) {
    const result = await saveUserAssertion(assertionText, payload);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result, null, 2));
    return;
  }

  const args = [
    answerScript,
    "--query",
    query,
    "--chunks",
    resolveChunksPath(),
    "--index-dir",
    resolveIndexDir(),
    "--top-k",
    String(Number(payload.topK ?? 8)),
    "--show-text"
  ];

  if (existsSync(styleProfilePath)) {
    args.push("--style-profile", styleProfilePath);
  }

  if (existsSync(deepProfilePath)) {
    args.push("--deep-profile", deepProfilePath);
  }

  if (existsSync(responseFeedbackPath)) {
    args.push("--feedback", responseFeedbackPath);
  }

  if (payload.role) {
    args.push("--role", String(payload.role));
  }

  if (payload.sourceType) {
    args.push("--source-type", String(payload.sourceType));
  }

  if (payload.responseMode) {
    args.push("--response-mode", String(payload.responseMode));
  }

  if (payload.llmProvider) {
    args.push("--llm-provider", String(payload.llmProvider));
  }

  if (Array.isArray(payload.history) && payload.history.length > 0) {
    args.push("--history-json", JSON.stringify(payload.history.slice(-8)));
  }

  const result = await runPython(args);
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(result);
}

async function handleAssertion(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const text = String(payload.text ?? payload.query ?? "").trim();

  if (!text) {
    response.writeHead(400).end("Missing assertion text");
    return;
  }

  const result = await saveUserAssertion(text, payload);
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(result, null, 2));
}

async function handleApprovedResponse(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const query = String(payload.query ?? "").trim();
  const reply = String(payload.reply ?? "").trim();

  if (!query || !reply) {
    response.writeHead(400).end("Missing query or reply");
    return;
  }

  const row = buildApprovedResponseRow(payload, query, reply);
  await mkdir(dirname(approvedResponsesPath), { recursive: true });
  await appendFile(approvedResponsesPath, `${JSON.stringify(row)}\n`, "utf8");
  await appendFeedbackRow(buildResponseFeedbackRow(payload, query, reply, "approved"));

  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(
    JSON.stringify(
      {
        ok: true,
        id: row.id,
        outputPath: approvedResponsesPath,
        approvedAt: row.approvedAt
      },
      null,
      2
    )
  );
}

async function handleResponseFeedback(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const query = String(payload.query ?? "").trim();
  const reply = String(payload.reply ?? "").trim();
  const rating = String(payload.rating ?? "").trim();

  if (!query || !reply || !["approved", "rejected", "corrected"].includes(rating)) {
    response.writeHead(400).end("Missing query, reply or valid rating");
    return;
  }

  const row = buildResponseFeedbackRow(payload, query, reply, rating);
  await appendFeedbackRow(row);

  if (rating === "approved") {
    const approved = buildApprovedResponseRow(payload, query, reply);
    await mkdir(dirname(approvedResponsesPath), { recursive: true });
    await appendFile(approvedResponsesPath, `${JSON.stringify(approved)}\n`, "utf8");
  }

  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(
    JSON.stringify(
      {
        ok: true,
        id: row.id,
        outputPath: responseFeedbackPath,
        reviewedAt: row.reviewedAt
      },
      null,
      2
    )
  );
}

async function handleFamilyEntities(_request, response) {
  if (!existsSync(familyCandidatesPath)) {
    await rebuildFamilyEntityCandidates();
  }

  const review = await readFamilyEntityReview();
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(review, null, 2));
}

async function handleProfile(_request, response) {
  if (!existsSync(deepProfilePath)) {
    response.writeHead(404).end("Deep profile not found");
    return;
  }

  const profile = await readJsonFile(deepProfilePath);
  const styleProfile = existsSync(styleProfilePath) ? await readJsonFile(styleProfilePath) : null;
  const dimensionalProfile = existsSync(dimensionalProfilePath) ? await readJsonFile(dimensionalProfilePath) : null;
  const feedbackRows = existsSync(responseFeedbackPath)
    ? readJsonLines(await readFile(responseFeedbackPath, "utf8"))
    : [];
  const payload = buildPublicProfileSummary(profile, styleProfile, dimensionalProfile, feedbackRows);
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function buildPublicProfileSummary(profile, styleProfile, dimensionalProfile, feedbackRows) {
  const relationships = profile.relationshipMap?.relationships ?? [];
  const ownRelations = relationships.filter((row) => normalizeText(row.subject) === "fabiana");
  const grouped = {};
  for (const row of ownRelations) {
    const relation = String(row.relation ?? "relacion");
    grouped[relation] ??= [];
    grouped[relation].push({
      name: row.object,
      confidence: row.confidence,
      sourceType: row.sourceType,
    });
  }

  const highlights = (profile.biography?.highlights ?? [])
    .slice(0, 12)
    .map((row) => ({
      text: shortenText(row.text, 220),
      sourceType: row.sourceType,
      confidence: row.confidence,
    }));

  return {
    schemaVersion: 1,
    generatedAt: profile.generatedAt ?? null,
    dateRange: profile.dateRange ?? null,
    sourceCounts: profile.sourceCounts ?? null,
    voice: {
      cues: profile.voicebook?.cues ?? [],
      frequentWords: (profile.voicebook?.frequentWords ?? []).slice(0, 12),
      frequentPhrases: (profile.voicebook?.frequentPhrases ?? []).slice(0, 10),
      averageWords: profile.voicebook?.averageWords ?? null,
    },
    relationships: grouped,
    aliases: profile.familyAliases ?? [],
    dimensions: summarizeDimensionalProfile(dimensionalProfile),
    highlights,
    feedback: {
      total: feedbackRows.length,
      approved: feedbackRows.filter((row) => row.rating === "approved").length,
      corrected: feedbackRows.filter((row) => row.rating === "corrected").length,
      rejected: feedbackRows.filter((row) => row.rating === "rejected").length,
    },
    policy: profile.usagePolicy ?? null,
  };
}

function summarizeDimensionalProfile(profile) {
  if (!profile) {
    return null;
  }
  return {
    schemaVersion: profile.schemaVersion,
    generatedAt: profile.generatedAt,
    classifiedCount: profile.source?.classifiedCount ?? 0,
    dimensions: (profile.dimensions ?? []).map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      description: dimension.description,
      evidenceCount: dimension.evidenceCount,
      dateRange: dimension.dateRange,
      topEntities: (dimension.topEntities ?? []).slice(0, 8),
      signals: (dimension.signals ?? []).slice(0, 8),
      evidence: (dimension.evidence ?? []).slice(0, 3).map((item) => ({
        memoryId: item.memoryId,
        sourceType: item.sourceType,
        localDate: item.localDate,
        confidence: item.confidence,
        text: shortenText(item.text, 160),
      })),
    })),
  };
}

async function handleLearningSummary(_request, response) {
  const payload = await buildLearningSummary();
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

async function handleLearningExport(_request, response) {
  const payload = await buildLearningSummary({ includePrivateExamples: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="memoria-ai-aprendizaje-${stamp}.json"`
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function buildLearningSummary(options = {}) {
  const includePrivateExamples = Boolean(options.includePrivateExamples);
  const feedbackRows = existsSync(responseFeedbackPath)
    ? readJsonLines(await readFile(responseFeedbackPath, "utf8"))
    : [];
  const approvedRows = existsSync(approvedResponsesPath)
    ? readJsonLines(await readFile(approvedResponsesPath, "utf8"))
    : [];
  const evalCases = existsSync(evalCasesPath) ? await readJsonFile(evalCasesPath) : [];
  const evaluationFiles = existsSync(evaluationsDir) ? await readdir(evaluationsDir) : [];
  const latestEvaluation = await findLatestFile(evaluationsDir, evaluationFiles);

  const byRating = countBy(feedbackRows, "rating");
  const byReason = countBy(feedbackRows.filter((row) => row.reason), "reason");
  const recentFeedback = feedbackRows.slice(-12).reverse().map((row) => ({
    id: row.id,
    reviewedAt: row.reviewedAt,
    rating: row.rating,
    reason: row.reason,
    generationMode: row.generationMode,
    confidence: row.confidence,
    query: shortenText(row.query, 160),
    reply: includePrivateExamples ? row.reply : shortenText(row.reply, 180),
    correctedReply: includePrivateExamples ? row.correctedReply : shortenText(row.correctedReply, 180),
    sourceCount: row.sourceCount,
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: {
      defaultProvider: process.env.ANSWER_LLM_PROVIDER ?? "auto",
      ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.2",
      anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      privacy: "El proveedor anthropic solo se usa si se elige explicitamente y hay ANTHROPIC_API_KEY.",
    },
    feedback: {
      total: feedbackRows.length,
      approved: byRating.approved ?? 0,
      corrected: byRating.corrected ?? 0,
      rejected: byRating.rejected ?? 0,
      approvedExamples: approvedRows.length,
      byReason,
      recent: recentFeedback,
    },
    evaluation: {
      caseCount: Array.isArray(evalCases) ? evalCases.length : 0,
      outputCount: evaluationFiles.filter((name) => name.endsWith(".json")).length,
      latestRunAt: latestEvaluation?.mtime ?? null,
      latestFile: latestEvaluation?.name ?? null,
    },
    files: {
      feedback: responseFeedbackPath,
      approvedResponses: approvedResponsesPath,
      evaluations: evaluationsDir,
    },
  };
}

async function findLatestFile(directory, names) {
  let latest = null;
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const filePath = resolve(directory, name);
    const stat = statSync(filePath);
    const row = {
      name,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
    };
    if (!latest || row.mtime > latest.mtime) {
      latest = row;
    }
  }
  return latest;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function shortenText(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

async function handleFamilyEntityRebuild(_request, response) {
  const result = await rebuildFamilyEntityCandidates();
  const review = await readFamilyEntityReview();
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: true, result, review }, null, 2));
}

async function handleFamilyEntityReview(request, response) {
  const body = await readBody(request);
  const payload = JSON.parse(body || "{}");
  const candidateId = String(payload.candidateId ?? "").trim();
  const action = String(payload.action ?? "").trim();

  if (!candidateId || !["approved", "rejected"].includes(action)) {
    response.writeHead(400).end("Missing candidateId or valid action");
    return;
  }

  const review = await readFamilyEntityReview();
  const candidate = review.candidates.find((item) => item.id === candidateId);
  if (!candidate) {
    response.writeHead(404).end("Candidate not found");
    return;
  }

  let assertionResult = null;
  if (action === "approved") {
    assertionResult = await saveUserAssertion(candidate.assertionText, {
      target: "Fabiana Sejas",
      author: "Diego"
    });
  }

  const row = {
    schemaVersion: 1,
    id: `family_review_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}`,
    reviewedAt: new Date().toISOString(),
    reviewedBy: "Diego",
    candidateId,
    action,
    assertionText: candidate.assertionText,
    candidate: {
      subject: candidate.subject,
      relation: candidate.relation,
      object: candidate.object,
      confidence: candidate.confidence,
      evidenceCount: candidate.evidenceCount
    },
    notes: String(payload.notes ?? "").trim() || null
  };
  await mkdir(dirname(familyReviewsPath), { recursive: true });
  await appendFile(familyReviewsPath, `${JSON.stringify(row)}\n`, "utf8");

  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(
    JSON.stringify(
      {
        ok: true,
        review: row,
        assertion: assertionResult
          ? {
              query: assertionResult.query,
              generationMode: assertionResult.generationMode
            }
          : null
      },
      null,
      2
    )
  );
}

async function handleAudio(request, response, url, headOnly = false) {
  const candidateId = decodeURIComponent(url.pathname.split("/").pop() ?? "").trim();
  if (!/^audio_msg_\d+$/.test(candidateId)) {
    response.writeHead(400).end("Invalid audio id");
    return;
  }

  const candidate = await findAudioCandidate(candidateId);
  const localAudioPath = candidate?.localAudioPath ? normalize(resolve(candidate.localAudioPath)) : null;

  if (!localAudioPath || !isPathInside(localAudioPath, extractedAudioDir) || !existsSync(localAudioPath)) {
    response.writeHead(404).end("Audio not found");
    return;
  }

  const stat = statSync(localAudioPath);
  const contentType = mimeTypes[extname(localAudioPath).toLowerCase()] ?? "application/octet-stream";
  const range = parseRangeHeader(request.headers.range, stat.size);

  if (range) {
    response.writeHead(206, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Cache-Control": "private, max-age=3600"
    });
    if (headOnly) {
      response.end();
      return;
    }
    createReadStream(localAudioPath, { start: range.start, end: range.end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": stat.size,
    "Cache-Control": "private, max-age=3600"
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(localAudioPath).pipe(response);
}

async function findAudioCandidate(candidateId) {
  if (!audioCandidateIndex) {
    audioCandidateIndex = new Map();
    if (existsSync(transcriptionJobsPath)) {
      const rows = readJsonLines(await readFile(transcriptionJobsPath, "utf8"));
      for (const row of rows) {
        if (row.audioCandidateId && row.localAudioPath) {
          audioCandidateIndex.set(row.audioCandidateId, row);
        }
      }
    }
  }

  return audioCandidateIndex.get(candidateId) ?? null;
}

async function handleVideos(_request, response) {
  await ensureVideoInventory();
  const library = await readVideoLibrary();
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(publicVideoLibrary(library), null, 2));
}

async function handleVideoExtraction(_request, response) {
  await ensureVideoInventory();
  const zipPath = await resolveWhatsAppZipPath();
  if (!zipPath || !existsSync(zipPath)) {
    response.writeHead(404).end("WhatsApp zip not found");
    return;
  }

  await mkdir(extractedVideoDir, { recursive: true });
  await runProcess("powershell", [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    extractVideoScript,
    "-ZipPath",
    zipPath,
    "-CandidatesPath",
    videoCandidatesPath,
    "-OutputDir",
    "data/processed/video/extracted-target"
  ]);
  await purgeDeletedVideoFiles();
  videoCandidateIndex = null;

  const library = await readVideoLibrary();
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(publicVideoLibrary(library), null, 2));
}

async function handleVideo(request, response, url, headOnly = false) {
  const candidateId = decodeURIComponent(url.pathname.split("/").pop() ?? "").trim();
  if (!/^video_msg_\d+$/.test(candidateId)) {
    response.writeHead(400).end("Invalid video id");
    return;
  }

  const candidate = await findVideoCandidate(candidateId);
  if (!candidate || candidate.deleted) {
    response.writeHead(404).end("Video not found");
    return;
  }

  const localVideoPath = candidate.localVideoPath ? normalize(resolve(candidate.localVideoPath)) : null;

  if (!localVideoPath || !isPathInside(localVideoPath, extractedVideoDir) || !existsSync(localVideoPath)) {
    response.writeHead(404).end("Video not extracted");
    return;
  }

  await streamMediaFile(request, response, localVideoPath, headOnly);
}

async function handleVideoDelete(_request, response, url) {
  const candidateId = decodeURIComponent(url.pathname.split("/").pop() ?? "").trim();
  if (!/^video_msg_\d+$/.test(candidateId)) {
    response.writeHead(400).end("Invalid video id");
    return;
  }

  const candidate = await findVideoCandidate(candidateId);
  if (!candidate) {
    response.writeHead(404).end("Video not found");
    return;
  }

  const localVideoPath = candidate.localVideoPath ? normalize(resolve(candidate.localVideoPath)) : null;
  if (localVideoPath && isPathInside(localVideoPath, extractedVideoDir) && existsSync(localVideoPath)) {
    await unlink(localVideoPath);
  }

  const row = {
    candidateId,
    messageId: candidate.messageId,
    filename: candidate.filename,
    deletedAt: new Date().toISOString(),
    action: "delete_local_copy"
  };
  await mkdir(dirname(videoDeletionsPath), { recursive: true });
  await appendFile(videoDeletionsPath, `${JSON.stringify(row)}\n`, "utf8");
  videoCandidateIndex = null;

  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: true, deleted: row }, null, 2));
}

async function ensureVideoInventory() {
  if (existsSync(videoCandidatesPath)) {
    return;
  }

  const messagesPath = resolve(root, "data/processed/ingest/messages.jsonl");
  if (!existsSync(messagesPath)) {
    throw new Error("No encuentro data/processed/ingest/messages.jsonl para armar videos.");
  }

  await runNode([
    memoryCliScript,
    "video-inventory",
    messagesPath,
    resolve(root, "data/processed/video")
  ]);
}

async function readVideoLibrary() {
  const candidates = existsSync(videoCandidatesPath)
    ? readJsonLines(await readFile(videoCandidatesPath, "utf8"))
    : [];
  const extractedByCandidateId = await readVideoExtractionIndex();
  const deletedIds = await readDeletedVideoIds();
  const videos = candidates
    .map((candidate) => {
      const extracted = extractedByCandidateId.get(candidate.id);
      const localVideoPath = extracted?.localPath ?? null;
      const isExtracted =
        Boolean(localVideoPath) &&
        ["extracted", "skipped_existing"].includes(extracted?.status) &&
        existsSync(localVideoPath);
      return {
        id: candidate.id,
        messageId: candidate.messageId,
        timestamp: candidate.timestamp,
        localDate: candidate.localDate,
        localTime: candidate.localTime,
        role: candidate.role,
        filename: candidate.filename,
        extension: candidate.extension,
        bytes: extracted?.bytes ?? candidate.bytes ?? null,
        sizeLabel: formatBytes(extracted?.bytes ?? candidate.bytes ?? 0),
        mediaStatus: candidate.mediaStatus,
        localVideoPath,
        extracted: isExtracted,
        deleted: deletedIds.has(candidate.id),
        url: isExtracted && !deletedIds.has(candidate.id) ? `/api/video/${encodeURIComponent(candidate.id)}` : null,
        source: candidate.source
      };
    })
    .filter((video) => !video.deleted);

  const activeVideos = videos.filter((video) => !video.deleted);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      total: candidates.length,
      visible: activeVideos.length,
      extracted: activeVideos.filter((video) => video.extracted).length,
      totalBytes: activeVideos.reduce((sum, video) => sum + (video.bytes ?? 0), 0),
      byRole: countBy(activeVideos, "role")
    },
    videos: activeVideos
  };
}

async function readVideoExtractionIndex() {
  const rows = new Map();
  if (!existsSync(videoExtractionManifestPath)) {
    return rows;
  }

  const manifest = await readJsonFile(videoExtractionManifestPath);
  for (const file of manifest.files ?? []) {
    if (file.candidateId) {
      rows.set(file.candidateId, file);
    }
  }
  return rows;
}

async function readDeletedVideoIds() {
  if (!existsSync(videoDeletionsPath)) {
    return new Set();
  }
  return new Set(readJsonLines(await readFile(videoDeletionsPath, "utf8")).map((row) => row.candidateId));
}

async function purgeDeletedVideoFiles() {
  const deletedIds = await readDeletedVideoIds();
  if (deletedIds.size === 0) {
    return;
  }

  const extractedByCandidateId = await readVideoExtractionIndex();
  for (const candidateId of deletedIds) {
    const extracted = extractedByCandidateId.get(candidateId);
    const localVideoPath = extracted?.localPath ? normalize(resolve(extracted.localPath)) : null;
    if (localVideoPath && isPathInside(localVideoPath, extractedVideoDir) && existsSync(localVideoPath)) {
      await unlink(localVideoPath);
    }
  }
}

async function findVideoCandidate(candidateId) {
  if (!videoCandidateIndex) {
    await ensureVideoInventory();
    const library = await readVideoLibrary();
    videoCandidateIndex = new Map(library.videos.map((video) => [video.id, video]));
  }

  return videoCandidateIndex.get(candidateId) ?? null;
}

function publicVideoLibrary(library) {
  return {
    ...library,
    videos: (library.videos ?? []).map(({ localVideoPath, ...video }) => video)
  };
}

async function resolveWhatsAppZipPath() {
  const inventoryPath = resolve(root, "data/processed/zip-inventory.json");
  if (!existsSync(inventoryPath)) {
    return null;
  }
  const inventory = await readJsonFile(inventoryPath);
  return inventory.zipPath ? normalize(resolve(inventory.zipPath)) : null;
}

async function streamMediaFile(request, response, filePath, headOnly = false) {
  const stat = statSync(filePath);
  const contentType = mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = parseRangeHeader(request.headers.range, stat.size);

  if (range) {
    response.writeHead(206, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Cache-Control": "private, max-age=3600"
    });
    if (headOnly) {
      response.end();
      return;
    }
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": stat.size,
    "Cache-Control": "private, max-age=3600"
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return null;
  }

  const startText = match[1];
  const endText = match[2];
  let start = startText ? Number(startText) : 0;
  let end = endText ? Number(endText) : size - 1;

  if (!startText && endText) {
    const suffixLength = Number(endText);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

function isPathInside(childPath, parentPath) {
  const relation = relative(parentPath, childPath);
  return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
}

async function readFamilyEntityReview() {
  if (!existsSync(familyCandidatesPath)) {
    return {
      schemaVersion: 1,
      generatedAt: null,
      source: null,
      policy: null,
      summary: {
        candidateCount: 0,
        pendingCount: 0,
        approvedCount: 0,
        rejectedCount: 0
      },
      candidates: []
    };
  }

  const data = JSON.parse(await readFile(familyCandidatesPath, "utf8"));
  const reviewRows = existsSync(familyReviewsPath)
    ? readJsonLines(await readFile(familyReviewsPath, "utf8"))
    : [];
  const latestByCandidate = new Map();
  for (const row of reviewRows) {
    latestByCandidate.set(row.candidateId, row);
  }

  const candidates = (data.candidates ?? []).map((candidate) => {
    const review = latestByCandidate.get(candidate.id);
    return {
      ...candidate,
      status: review?.action ?? candidate.status ?? "pending",
      reviewedAt: review?.reviewedAt ?? null
    };
  });

  return {
    ...data,
    summary: {
      ...(data.summary ?? {}),
      pendingCount: candidates.filter((candidate) => candidate.status === "pending").length,
      approvedCount: candidates.filter((candidate) => candidate.status === "approved").length,
      rejectedCount: candidates.filter((candidate) => candidate.status === "rejected").length
    },
    candidates
  };
}

async function rebuildFamilyEntityCandidates() {
  await mkdir(entityReviewDir, { recursive: true });
  return JSON.parse(
    await runNode([
      extractFamilyEntitiesScript,
      resolveMemoriesPath(),
      familyCandidatesPath,
      "--role",
      "targetPerson",
      "--min-confidence",
      "0.9"
    ])
  );
}

function buildApprovedResponseRow(payload, query, reply) {
  const approvedAt = new Date().toISOString();
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  return {
    schemaVersion: 1,
    id: `approved_${approvedAt.replace(/[-:.TZ]/g, "").slice(0, 17)}`,
    approvedAt,
    approvedBy: "Diego",
    query,
    reply,
    confidence: payload.confidence ?? null,
    retrievalMode: payload.retrievalMode ?? null,
    generationMode: payload.generationMode ?? null,
    quality: payload.quality ?? null,
    styleProfile: payload.styleProfile ?? null,
    deepProfile: payload.deepProfile ?? null,
    sourceCount: sources.length,
    sources: sources.map((source) => ({
      score: source.score ?? null,
      memoryId: source.memoryId ?? null,
      messageId: source.messageId ?? null,
      timestamp: source.timestamp ?? null,
      localDate: source.localDate ?? null,
      localTime: source.localTime ?? null,
      role: source.role ?? null,
      sourceType: source.sourceType ?? null,
      text: source.text ?? null
    }))
  };
}

function buildResponseFeedbackRow(payload, query, reply, rating) {
  const reviewedAt = new Date().toISOString();
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const correctedReply = String(payload.correctedReply ?? "").trim();
  const reason = String(payload.reason ?? "").trim();
  const notes = String(payload.notes ?? "").trim();
  return {
    schemaVersion: 1,
    id: `feedback_${reviewedAt.replace(/[-:.TZ]/g, "").slice(0, 17)}`,
    reviewedAt,
    reviewedBy: "Diego",
    rating,
    reason: reason || null,
    notes: notes || null,
    query,
    reply,
    correctedReply: correctedReply || null,
    confidence: payload.confidence ?? null,
    retrievalMode: payload.retrievalMode ?? null,
    generationMode: payload.generationMode ?? null,
    validation: payload.validation ?? null,
    quality: payload.quality ?? null,
    styleProfile: payload.styleProfile ?? null,
    deepProfile: payload.deepProfile ?? null,
    sourceCount: sources.length,
    sources: sources.map((source) => ({
      score: source.score ?? null,
      memoryId: source.memoryId ?? null,
      messageId: source.messageId ?? null,
      timestamp: source.timestamp ?? null,
      localDate: source.localDate ?? null,
      localTime: source.localTime ?? null,
      role: source.role ?? null,
      sourceType: source.sourceType ?? null,
      text: source.text ?? null
    }))
  };
}

async function appendFeedbackRow(row) {
  await mkdir(dirname(responseFeedbackPath), { recursive: true });
  await appendFile(responseFeedbackPath, `${JSON.stringify(row)}\n`, "utf8");
}

function extractAssertionText(query) {
  const patterns = [
    /^(?:dato|guardar dato|guarda dato|guardame este dato|guardame dato)\s*[:,-]?\s*(.+)$/i,
    /^(?:recorda|recordá|recuerda|aprende|te confirmo)\s+que\s+(.+)$/i,
    /^(?:quiero que guardes|guarda|guardá|guardar)\s+que\s+(.+)$/i,
    /^(?:para que lo sepas)\s*[:,-]?\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = query.match(pattern);
    const text = match?.[1]?.trim();
    if (text) {
      return text;
    }
  }

  return null;
}

function saveUserAssertion(text, payload) {
  const task = assertionQueue.then(() => saveUserAssertionNow(text, payload));
  assertionQueue = task.catch(() => {});
  return task;
}

async function saveUserAssertionNow(text, payload) {
  const target = String(payload.target ?? "Fabiana Sejas");
  const author = String(payload.author ?? "Diego");
  const addResult = JSON.parse(
    await runNode([
      addAssertionScript,
      assertionsPath,
      "--text",
      text,
      "--target",
      target,
      "--author",
      author
    ])
  );

  await rebuildCombinedMemory();
  const assertion = await findAssertionById(addResult.id);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    query: text,
    confidence: "high",
    retrievalMode: "manual",
    reply: "Listo, lo guarde como dato confirmado por Diego. Desde ahora lo uso como fuente manual.",
    generationMode: "user-assertion",
    styleProfile: null,
    draft: "Dato manual guardado, convertido a memoria y reindexado en la base combinada.",
    evidenceCount: 1,
    topScore: 1,
    output: null,
    sources: [
      {
        score: 1,
        chunkId: `mem_${assertion.id}_user_assertion_chunk_001`,
        memoryId: `mem_${assertion.id}_user_assertion`,
        messageId: assertion.id,
        timestamp: assertion.timestamp,
        localDate: assertion.localDate,
        localTime: assertion.localTime,
        role: "targetPerson",
        sourceType: "user_assertion",
        textLength: assertion.text.length,
        eligibleForPersona: false,
        text: assertion.text,
        evidence: {
          kind: "user_assertion",
          assertionId: assertion.id,
          confidence: assertion.confidence,
          author: assertion.author,
          target: assertion.target,
          source: {
            format: "manual_user_assertion"
          }
        }
      }
    ]
  };
}

async function rebuildCombinedMemory() {
  await runNode([buildAssertionMemoriesScript, assertionsPath, assertionMemoriesPath]);

  const inputPaths = [whatsappMemoriesPath, facebookMemoriesPath, assertionMemoriesPath].filter((path) => existsSync(path));
  if (inputPaths.length === 0) {
    throw new Error("No memory inputs available for merge");
  }

  await runNode([mergeMemoriesScript, combinedMemoriesPath, ...inputPaths]);
  await runNode([memoryCliScript, "memory-chunk", combinedMemoriesPath, combinedMemoryDir]);
  await runPython([embedScript, "--chunks", combinedChunksPath, "--output-dir", combinedIndexDir]);
  await runNode([buildConversationMemoryV2Script, combinedMemoriesPath, combinedMemoriesV2Path]);
  await runNode([memoryCliScript, "memory-chunk", combinedMemoriesV2Path, combinedMemoryV2Dir]);
  await runPython([embedScript, "--chunks", combinedChunksV2Path, "--output-dir", combinedIndexV2Dir]);
  await runNode([
    buildStyleProfileScript,
    combinedMemoriesPath,
    styleProfilePath,
    "--role",
    "targetPerson",
    "--sample-size",
    "900"
  ]);
  await runNode([
    buildDeepProfileScript,
    combinedMemoriesPath,
    deepProfilePath,
    "--role",
    "targetPerson",
    "--sample-size",
    "1400"
  ]);
}

async function findAssertionById(id) {
  const assertions = readJsonLines(await readFile(assertionsPath, "utf8"));
  const assertion = assertions.find((row) => row.id === id);
  if (!assertion) {
    throw new Error(`Assertion not found after save: ${id}`);
  }
  return assertion;
}

function resolveChunksPath() {
  if (existsSync(combinedChunksV2Path) && existsSync(resolve(combinedIndexV2Dir, "embeddings.npy"))) {
    return combinedChunksV2Path;
  }
  return existsSync(combinedChunksPath) ? combinedChunksPath : defaultChunksPath;
}

function resolveMemoriesPath() {
  if (existsSync(combinedMemoriesV2Path)) {
    return combinedMemoriesV2Path;
  }
  return existsSync(combinedMemoriesPath) ? combinedMemoriesPath : whatsappMemoriesPath;
}

function resolveIndexDir() {
  if (existsSync(resolve(combinedIndexV2Dir, "embeddings.npy"))) {
    return combinedIndexV2Dir;
  }
  return existsSync(resolve(combinedIndexDir, "embeddings.npy")) ? combinedIndexDir : defaultIndexDir;
}

async function serveStatic(pathname, response, headOnly = false) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(resolve(publicDir, `.${requested}`));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream"
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function runPython(args) {
  return runProcess(pythonPath, args, {
    PYTHONIOENCODING: "utf-8"
  });
}

function runNode(args) {
  return runProcess(process.execPath, args);
}

function runProcess(command, args, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${command} exited with ${code}`));
        return;
      }
      resolveRun(stdout);
    });
  });
}

function readJsonLines(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function readJsonFile(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}
