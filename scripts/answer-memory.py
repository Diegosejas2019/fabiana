import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding


def main():
    parser = argparse.ArgumentParser(description="Build a grounded answer draft from local memory.")
    parser.add_argument("--query", required=True, help="User question")
    parser.add_argument("--chunks", required=True, help="Path to chunks.jsonl")
    parser.add_argument("--index-dir", required=True, help="Directory containing embeddings.npy")
    parser.add_argument("--output", default=None, help="Optional private JSON output path")
    parser.add_argument("--model", default=None, help="Override embedding model")
    parser.add_argument("--top-k", type=int, default=8, help="Number of sources to keep")
    parser.add_argument("--role", default="targetPerson", help="Role filter")
    parser.add_argument("--source-type", default=None, help="Optional source type filter")
    parser.add_argument("--show-text", action="store_true", help="Include private source text in output")
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

    candidates = []
    for row, score in zip(metadata, scores):
        if args.role and row["role"] != args.role:
            continue
        if args.source_type and row["sourceType"] != args.source_type:
            continue

        chunk = chunks_by_id[row["chunkId"]]
        source = {
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
            source["text"] = chunk["text"]

        candidates.append(source)

    candidates.sort(key=lambda item: item["score"], reverse=True)
    sources = candidates[: args.top_k]
    confidence = classify_confidence(sources)
    draft = build_draft(confidence, sources, args.show_text)

    answer = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "query": args.query,
        "model": model_name,
        "roleFilter": args.role,
        "sourceTypeFilter": args.source_type,
        "confidence": confidence,
        "draft": draft,
        "evidenceCount": len(sources),
        "sources": sources,
    }

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(answer, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "query": answer["query"],
                "confidence": answer["confidence"],
                "draft": answer["draft"],
                "evidenceCount": answer["evidenceCount"],
                "topScore": sources[0]["score"] if sources else None,
                "output": args.output,
                "sources": sources,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def classify_confidence(sources):
    if not sources:
        return "none"

    top_score = sources[0]["score"]
    strong_count = sum(1 for source in sources if source["score"] >= 0.38)
    medium_count = sum(1 for source in sources if source["score"] >= 0.28)

    if top_score >= 0.45 and strong_count >= 2:
        return "high"
    if top_score >= 0.32 and medium_count >= 2:
        return "medium"
    return "none"


def build_draft(confidence, sources, show_text):
    if confidence == "none":
        return (
            "No encontre recuerdos suficientes para responder basandome en el archivo. "
            "Conviene reformular la pregunta o revisar manualmente las fuentes."
        )

    source_count = len(sources)
    date_span = summarize_dates(sources)

    if confidence == "high":
        opening = "Encontre varios recuerdos relacionados en el archivo."
    else:
        opening = "Encontre algunos recuerdos relacionados, pero la evidencia no es concluyente."

    if show_text:
        return (
            f"{opening} Hay {source_count} fuentes recuperadas ({date_span}). "
            "Usa los textos y evidencias adjuntas para redactar una respuesta final sin agregar recuerdos nuevos."
        )

    return (
        f"{opening} Hay {source_count} fuentes recuperadas ({date_span}). "
        "No incluyo texto privado en consola; revisa el JSON privado o vuelve a correr con --show-text si quieres inspeccionar contenido."
    )


def summarize_dates(sources):
    dates = [source["localDate"] for source in sources if source.get("localDate")]
    if not dates:
        return "sin fechas disponibles"
    if dates[0] == dates[-1]:
        return dates[0]
    return f"entre {dates[-1]} y {dates[0]}"


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


def now_iso():
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    main()

