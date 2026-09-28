import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser(description="Transcribe pending local audio jobs.")
    parser.add_argument("--jobs", required=True, help="Path to transcription-jobs.jsonl")
    parser.add_argument("--model", default="tiny", help="faster-whisper model name")
    parser.add_argument("--language", default="es", help="Language code")
    parser.add_argument("--limit", type=int, default=0, help="Maximum pending jobs to process")
    parser.add_argument("--device", default="cpu", help="Device, usually cpu")
    parser.add_argument("--compute-type", default="int8", help="Compute type, usually int8 on CPU")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing transcript files")
    parser.add_argument("--items-dir-name", default="items", help="Directory name for transcript JSON files")
    parser.add_argument(
        "--manifest-name",
        default="transcription-run-manifest.json",
        help="Run manifest filename",
    )
    args = parser.parse_args()

    jobs_path = Path(args.jobs)
    jobs = read_jsonl(jobs_path)
    pending = [job for job in jobs if job.get("status") == "pending"]

    if args.limit > 0:
        pending = pending[: args.limit]

    output_dir = jobs_path.parent
    items_dir = output_dir / args.items_dir_name
    items_dir.mkdir(parents=True, exist_ok=True)

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    processed = []
    skipped = []
    failed = []

    for job in pending:
        try:
            output_path = items_dir / f"{job['audioCandidateId']}.json"

            if output_path.exists() and not args.overwrite:
                skipped.append(
                    {
                        "jobId": job["id"],
                        "audioCandidateId": job["audioCandidateId"],
                        "messageId": job["messageId"],
                        "resultPath": str(output_path),
                    }
                )
                continue

            audio_path = Path(job["localAudioPath"])
            segments, info = model.transcribe(
                str(audio_path),
                language=args.language,
                vad_filter=True,
                beam_size=1,
            )
            segments = list(segments)
            text = "".join(segment.text for segment in segments).strip()

            result = {
                "schemaVersion": 1,
                "generatedAt": now_iso(),
                "jobId": job["id"],
                "audioCandidateId": job["audioCandidateId"],
                "messageId": job["messageId"],
                "role": job["role"],
                "engine": "faster-whisper",
                "model": args.model,
                "language": args.language,
                "duration": getattr(info, "duration", None),
                "text": text,
                "segments": [
                    {
                        "start": segment.start,
                        "end": segment.end,
                        "text": segment.text.strip(),
                    }
                    for segment in segments
                ],
                "source": job["source"],
            }

            output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            processed.append(
                {
                    "jobId": job["id"],
                    "audioCandidateId": job["audioCandidateId"],
                    "messageId": job["messageId"],
                    "resultPath": str(output_path),
                    "duration": result["duration"],
                    "characterCount": len(text),
                    "segmentCount": len(segments),
                }
            )
        except Exception as exc:  # Keep batch moving and record failures locally.
            failed.append(
                {
                    "jobId": job.get("id"),
                    "audioCandidateId": job.get("audioCandidateId"),
                    "messageId": job.get("messageId"),
                    "error": str(exc),
                }
            )

    manifest = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "jobsPath": str(jobs_path),
        "model": args.model,
        "language": args.language,
        "requestedCount": len(pending),
        "processedCount": len(processed),
        "skippedExistingCount": len(skipped),
        "failedCount": len(failed),
        "processed": processed,
        "skipped": skipped,
        "failed": failed,
    }

    manifest_path = output_dir / args.manifest_name
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "model": args.model,
                "requestedCount": len(pending),
                "processedCount": len(processed),
                "skippedExistingCount": len(skipped),
                "failedCount": len(failed),
                "manifestPath": str(manifest_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def read_jsonl(path):
    rows = []
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def now_iso():
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    main()
