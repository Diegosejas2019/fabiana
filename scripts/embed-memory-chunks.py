import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding


def main():
    parser = argparse.ArgumentParser(description="Create a local vector index for memory chunks.")
    parser.add_argument("--chunks", required=True, help="Path to chunks.jsonl")
    parser.add_argument("--output-dir", required=True, help="Output directory for vector index")
    parser.add_argument("--model", default="minishlab/potion-multilingual-128M", help="FastEmbed model")
    parser.add_argument("--batch-size", type=int, default=64, help="Embedding batch size")
    parser.add_argument("--limit", type=int, default=0, help="Optional limit for smoke tests")
    args = parser.parse_args()

    chunks_path = Path(args.chunks)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    chunks = read_jsonl(chunks_path)
    if args.limit > 0:
        chunks = chunks[: args.limit]

    model = TextEmbedding(model_name=args.model)
    texts = [chunk["text"] for chunk in chunks]
    vectors = np.array(list(model.embed(texts, batch_size=args.batch_size)), dtype=np.float32)

    embeddings_path = output_dir / "embeddings.npy"
    metadata_path = output_dir / "embedding-metadata.jsonl"
    manifest_path = output_dir / "embedding-manifest.json"

    np.save(embeddings_path, vectors)

    metadata_rows = [metadata_from_chunk(chunk, index) for index, chunk in enumerate(chunks)]
    metadata_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in metadata_rows) + "\n",
        encoding="utf-8",
    )

    manifest = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "chunksPath": str(chunks_path),
        "model": args.model,
        "embeddingCount": int(vectors.shape[0]),
        "dimensions": int(vectors.shape[1]) if vectors.size else 0,
        "embeddingsPath": str(embeddings_path),
        "metadataPath": str(metadata_path),
        "byRole": count_by(metadata_rows, "role"),
        "bySourceType": count_by(metadata_rows, "sourceType"),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "outputDir": str(output_dir),
                "model": args.model,
                "embeddingCount": manifest["embeddingCount"],
                "dimensions": manifest["dimensions"],
                "byRole": manifest["byRole"],
                "bySourceType": manifest["bySourceType"],
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


def metadata_from_chunk(chunk, index):
    return {
        "index": index,
        "chunkId": chunk["id"],
        "memoryId": chunk["memoryId"],
        "messageId": chunk["messageId"],
        "timestamp": chunk["timestamp"],
        "localDate": chunk["localDate"],
        "localTime": chunk["localTime"],
        "role": chunk["role"],
        "participantId": chunk["participantId"],
        "sourceType": chunk["sourceType"],
        "textLength": chunk["textLength"],
        "eligibleForPersona": chunk["eligibleForPersona"],
        "evidence": chunk["evidence"],
    }


def count_by(rows, key):
    counts = {}
    for row in rows:
        value = row.get(key)
        counts[value] = counts.get(value, 0) + 1
    return counts


def now_iso():
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    main()

