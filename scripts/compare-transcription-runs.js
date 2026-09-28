#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const [, , leftDir, rightDir] = process.argv;

if (!leftDir || !rightDir) {
  console.error("Uso: node scripts/compare-transcription-runs.js <left-items-dir> <right-items-dir>");
  process.exit(1);
}

const left = await readTranscripts(leftDir);
const right = await readTranscripts(rightDir);
const sharedIds = [...left.keys()].filter((id) => right.has(id)).sort();

const summary = {
  leftDir,
  rightDir,
  leftCount: left.size,
  rightCount: right.size,
  sharedCount: sharedIds.length,
  leftOnlyCount: left.size - sharedIds.length,
  rightOnlyCount: right.size - sharedIds.length,
  left: summarize([...left.values()]),
  right: summarize([...right.values()]),
  shared: summarizePairs(sharedIds.map((id) => [left.get(id), right.get(id)]))
};

console.log(JSON.stringify(summary, null, 2));

async function readTranscripts(dir) {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
  const rows = new Map();

  for (const file of files) {
    const row = JSON.parse(await readFile(join(dir, file), "utf8"));
    rows.set(row.audioCandidateId, row);
  }

  return rows;
}

function summarize(rows) {
  const totalCharacters = rows.reduce((sum, row) => sum + (row.text?.length ?? 0), 0);
  const totalSegments = rows.reduce((sum, row) => sum + (row.segments?.length ?? 0), 0);
  const emptyCount = rows.filter((row) => !row.text || row.text.trim().length === 0).length;
  const totalDurationSeconds = rows.reduce((sum, row) => sum + (row.duration ?? 0), 0);

  return {
    count: rows.length,
    totalCharacters,
    averageCharacters: rows.length ? Math.round(totalCharacters / rows.length) : 0,
    totalSegments,
    emptyCount,
    totalDurationSeconds: Math.round(totalDurationSeconds)
  };
}

function summarizePairs(pairs) {
  let sameTextCount = 0;
  let rightLongerCount = 0;
  let leftLongerCount = 0;
  let totalCharacterDelta = 0;

  for (const [left, right] of pairs) {
    const leftLength = left.text?.length ?? 0;
    const rightLength = right.text?.length ?? 0;
    const delta = rightLength - leftLength;
    totalCharacterDelta += delta;

    if ((left.text ?? "") === (right.text ?? "")) {
      sameTextCount++;
    } else if (delta > 0) {
      rightLongerCount++;
    } else if (delta < 0) {
      leftLongerCount++;
    }
  }

  return {
    sameTextCount,
    rightLongerCount,
    leftLongerCount,
    totalCharacterDelta,
    averageCharacterDelta: pairs.length ? Math.round(totalCharacterDelta / pairs.length) : 0
  };
}
