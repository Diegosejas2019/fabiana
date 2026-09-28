import argparse
import json
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding


def main():
    parser = argparse.ArgumentParser(description="Search local memory vector index.")
    parser.add_argument("--query", required=True, help="Search query")
    parser.add_argument("--chunks", required=True, help="Path to chunks.jsonl")
    parser.add_argument("--index-dir", required=True, help="Directory containing embeddings.npy")
    parser.add_argument("--model", default=None, help="Override embedding model")
    parser.add_argument("--top-k", type=int, default=8, help="Number of results")
    parser.add_argument("--role", default=None, help="Optional role filter, e.g. targetPerson")
    parser.add_argument("--source-type", default=None, help="Optional source type filter")
    parser.add_argument("--show-text", action="store_true", help="Include private chunk text in output")
    args = parser.parse_args()

    index_dir = Path(args.index_dir)
    manifest = json.loads((index_dir / "embedding-manifest.json").read_text(encoding="utf-8"))
    model_name = args.model or manifest["model"]

    embeddings = np.load(index_dir / "embeddings.npy")
    metadata = read_jsonl(index_dir / "embedding-metadata.jsonl")
    chunks_by_id = {chunk["id"]: chunk for chunk in read_jsonl(args.chunks)}

    model = TextEmbedding(model_name=model_name)
    query_vector = np.array(list(model.query_embed(args.query))[0], dtype=np.float32)
    scores = cosine_scores(embeddings, query_vector)

    ranked = []
    for row, score in zip(metadata, scores):
        if args.role and row["role"] != args.role:
            continue
        if args.source_type and row["sourceType"] != args.source_type:
            continue

        result = {
            "score": float(score),
            "chunkId": row["chunkId"],
            "memoryId": row["memoryId"],
            "messageId": row["messageId"],
            "timestamp": row["timestamp"],
            "localDate": row["localDate"],
            "localTime": row["localTime"],
            "role": row["role"],
            "sourceType": row["sourceType"],
            "textLength": row["textLength"],
            "eligibleForPersona": row["eligibleForPersona"],
            "evidence": row["evidence"],
        }

        if args.show_text:
            result["text"] = chunks_by_id[row["chunkId"]]["text"]

        ranked.append(result)

    ranked.sort(key=lambda item: item["score"], reverse=True)

    print(
        json.dumps(
            {
                "query": args.query,
                "model": model_name,
                "topK": args.top_k,
                "roleFilter": args.role,
                "sourceTypeFilter": args.source_type,
                "results": ranked[: args.top_k],
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


def cosine_scores(matrix, vector):
    matrix_norms = np.linalg.norm(matrix, axis=1)
    vector_norm = np.linalg.norm(vector)
    denominator = np.maximum(matrix_norms * vector_norm, 1e-12)
    return matrix.dot(vector) / denominator


if __name__ == "__main__":
    main()
