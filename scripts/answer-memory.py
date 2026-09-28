import argparse
import json
import os
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Build a grounded persona answer from local memory.")
    parser.add_argument("--query", required=True, help="User question")
    parser.add_argument("--chunks", required=True, help="Path to chunks.jsonl")
    parser.add_argument("--index-dir", required=True, help="Directory containing embeddings.npy")
    parser.add_argument("--output", default=None, help="Optional private JSON output path")
    parser.add_argument("--model", default=None, help="Override embedding model")
    parser.add_argument("--top-k", type=int, default=8, help="Number of sources to keep")
    parser.add_argument("--role", default="targetPerson", help="Role filter")
    parser.add_argument("--source-type", default=None, help="Optional source type filter")
    parser.add_argument("--show-text", action="store_true", help="Include private source text in output")
    parser.add_argument("--persona-name", default="Fabi", help="Name to use for persona replies")
    parser.add_argument("--style-profile", default=None, help="Optional persona style profile JSON")
    parser.add_argument(
        "--llm-provider",
        default=os.environ.get("ANSWER_LLM_PROVIDER", "auto"),
        choices=["auto", "none", "ollama"],
        help="Generative engine for persona replies",
    )
    parser.add_argument(
        "--ollama-model",
        default=os.environ.get("OLLAMA_MODEL", "llama3.2"),
        help="Ollama model used when local generation is enabled",
    )
    parser.add_argument(
        "--ollama-url",
        default=os.environ.get("OLLAMA_URL", "http://localhost:11434/api/chat"),
        help="Ollama chat API URL",
    )
    args = parser.parse_args()
    style_profile = read_optional_style_profile(args.style_profile)

    index_dir = Path(args.index_dir)
    manifest = json.loads((index_dir / "embedding-manifest.json").read_text(encoding="utf-8"))
    model_name = args.model or manifest["model"]

    metadata = read_jsonl(index_dir / "embedding-metadata.jsonl")
    chunks_by_id = {chunk["id"]: chunk for chunk in read_jsonl(args.chunks)}

    if asks_recent_messages(normalize_for_match(args.query)):
        retrieval_mode = "chronological"
        include_conversation = asks_recent_conversation(normalize_for_match(args.query))
        sources = build_recent_sources(
            metadata,
            chunks_by_id,
            args.top_k,
            args.role,
            args.source_type,
            args.show_text,
            include_conversation,
        )
        confidence = "high" if sources else "none"
        draft = build_recent_draft(confidence, sources, args.show_text)
        reply = build_recent_reply(sources, args.show_text)
        generation_mode = "chronological"
    else:
        retrieval_mode = "semantic"
        embeddings = np.load(index_dir / "embeddings.npy")
        model = TextEmbedding(model_name=model_name)
        query_vector = np.array(list(model.query_embed(args.query))[0], dtype=np.float32)
        scores = cosine_scores(embeddings, query_vector)
        sources = build_semantic_sources(metadata, chunks_by_id, scores, args.top_k, args.role, args.source_type, args.show_text)
        confidence = classify_confidence(sources)
        draft = build_draft(confidence, sources, args.show_text)
        reply, generation_mode = build_persona_reply(
            args.query,
            confidence,
            sources,
            args.persona_name,
            args.llm_provider,
            args.ollama_model,
            args.ollama_url,
            style_profile,
        )

    answer = {
        "schemaVersion": 2,
        "generatedAt": now_iso(),
        "query": args.query,
        "model": model_name,
        "roleFilter": args.role,
        "sourceTypeFilter": args.source_type,
        "confidence": confidence,
        "retrievalMode": retrieval_mode,
        "reply": reply,
        "generationMode": generation_mode,
        "styleProfile": summarize_style_profile(style_profile),
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
                "schemaVersion": answer["schemaVersion"],
                "query": answer["query"],
                "confidence": answer["confidence"],
                "retrievalMode": answer["retrievalMode"],
                "reply": answer["reply"],
                "generationMode": answer["generationMode"],
                "styleProfile": answer["styleProfile"],
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


def build_semantic_sources(metadata, chunks_by_id, scores, top_k, role, source_type, show_text):
    candidates = []
    for row, score in zip(metadata, scores):
        if role and row["role"] != role:
            continue
        if source_type and row["sourceType"] != source_type:
            continue

        candidates.append(build_source(row, chunks_by_id[row["chunkId"]], float(score), show_text))

    candidates.sort(key=lambda item: item["score"], reverse=True)
    return candidates[:top_k]


def build_recent_sources(metadata, chunks_by_id, top_k, role, source_type, show_text, include_conversation):
    candidates = []
    for row in metadata:
        if source_type and row["sourceType"] != source_type:
            continue
        if role and not include_conversation and row["role"] != role:
            continue
        candidates.append(row)

    candidates.sort(key=lambda item: (item.get("timestamp") or "", item.get("messageId") or ""), reverse=True)
    sources = []
    for index, row in enumerate(candidates[:top_k], start=1):
        score = max(0.0, 1.0 - ((index - 1) * 0.001))
        sources.append(build_source(row, chunks_by_id[row["chunkId"]], score, show_text))
    return sources


def build_source(row, chunk, score, show_text):
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

    if show_text:
        source["text"] = chunk["text"]

    return source


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


def build_recent_draft(confidence, sources, show_text):
    if confidence == "none":
        return "No encontre mensajes fechados para ordenar cronologicamente."

    date_span = summarize_dates(sources)
    if show_text:
        return f"Use orden cronologico directo. Hay {len(sources)} mensajes recientes recuperados ({date_span})."

    return (
        f"Use orden cronologico directo. Hay {len(sources)} mensajes recientes recuperados ({date_span}). "
        "No incluyo texto privado en consola sin --show-text."
    )


def build_recent_reply(sources, show_text):
    if not sources:
        return "No me aparecen mensajes recientes suficientes para responderte con fecha."

    latest = sources[0]
    speaker = display_speaker(latest)
    text = clean_source_text(latest.get("text", ""))

    if show_text and text:
        return build_latest_message_sentence(latest, speaker, text)

    return (
        f"Lo ultimo que encuentro esta fechado el {latest['localDate']} a las {latest['localTime']}. "
        "Te dejo las fuentes al costado para ver el texto exacto."
    )


def display_speaker(source):
    if source["role"] == "targetPerson":
        return "Fabiana"
    if source["role"] == "self":
        return "Vos"
    return source["role"]


def build_latest_message_sentence(source, speaker, text):
    message = shorten(text, 220)
    if source["role"] == "self":
        return f"Lo ultimo que encuentro fue un mensaje tuyo del {source['localDate']} a las {source['localTime']}, diciendo {message}."
    return f"Lo ultimo que encuentro fue un mensaje de {speaker} del {source['localDate']} a las {source['localTime']}, diciendo {message}."


def build_persona_reply(query, confidence, sources, persona_name, llm_provider, ollama_model, ollama_url, style_profile):
    if confidence == "none":
        return (
            "No tengo un recuerdo claro de eso en lo que guardaste. "
            "No quiero inventarte algo que no aparece en mis mensajes."
        ), "fallback"

    source_texts = [source.get("text", "").strip() for source in sources if source.get("text")]
    dates = [source["localDate"] for source in sources if source.get("localDate")]
    top_text = clean_source_text(source_texts[0]) if source_texts else ""
    second_text = clean_source_text(source_texts[1]) if len(source_texts) > 1 else ""
    lower_query = normalize_for_match(query)

    if llm_provider in ("auto", "ollama") and source_texts:
        generated = build_ollama_reply(query, sources, persona_name, ollama_model, ollama_url, style_profile)
        if generated:
            return generated, f"ollama:{ollama_model}"

    if asks_for_encouragement(lower_query):
        return build_encouragement_reply(persona_name, top_text, second_text), "fallback"

    if asks_for_last_request(lower_query):
        return build_last_request_reply(dates, top_text), "fallback"

    if asks_memory_question(lower_query):
        return build_memory_reply(top_text, second_text, dates), "fallback"

    return build_general_reply(top_text, second_text, dates), "fallback"


def build_ollama_reply(query, sources, persona_name, model, url, style_profile):
    prompt_sources = format_sources_for_prompt(sources)
    if not prompt_sources:
        return None

    style_prompt = format_style_profile_for_prompt(style_profile)
    system_prompt = (
        "Sos un motor de redaccion para una app privada de memoria familiar. "
        f"Redacta como {persona_name}: cercana, simple, afectuosa y natural. "
        "Usa los mensajes recuperados como fuente de hechos y como guia de estilo. "
        "Usa el perfil de estilo solo para forma de hablar, no como fuente de hechos. "
        "Podes inventar frases nuevas y tono conversacional, pero no inventes recuerdos, hechos, pedidos, promesas ni fechas. "
        "Si la evidencia no alcanza, decilo suavemente. "
        "No digas que sos IA, no menciones IDs tecnicos y no copies mensajes largos literalmente. "
        "Responde en primera persona, en espanol rioplatense natural, con 1 a 4 frases."
    )
    user_prompt = (
        f"Pregunta de Diego:\n{query}\n\n"
        f"Perfil de estilo de Fabiana:\n{style_prompt}\n\n"
        "Mensajes/transcripciones recuperados de Fabiana:\n"
        f"{prompt_sources}\n\n"
        "Escribi una respuesta final nueva, como si Fabiana le respondiera ahora, manteniendote fiel a esas fuentes."
    )
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "options": {
            "temperature": 0.72,
            "top_p": 0.9,
            "num_predict": 180,
        },
    }

    try:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None

    content = result.get("message", {}).get("content", "").strip()
    return clean_generated_reply(content)


def format_sources_for_prompt(sources):
    rows = []
    for index, source in enumerate(sources[:8], start=1):
        text = clean_source_text(source.get("text", ""))
        if not text:
            continue
        date = source.get("localDate") or "sin fecha"
        source_type = source.get("sourceType") or "fuente"
        rows.append(f"{index}. {date} ({source_type}): {shorten(text, 520)}")
    return "\n".join(rows)


def clean_generated_reply(content):
    if not content:
        return None
    cleaned = content.strip().strip("\"'")
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")
    cleaned = "\n".join(line.strip() for line in cleaned.split("\n") if line.strip())
    if not cleaned:
        return None
    return shorten(cleaned, 900)


def read_optional_style_profile(path):
    if not path:
        return None
    profile_path = Path(path)
    if not profile_path.exists():
        return None
    return json.loads(profile_path.read_text(encoding="utf-8"))


def format_style_profile_for_prompt(profile):
    if not profile:
        return "No hay perfil de estilo calculado; usa solo las fuentes recuperadas."

    summary = profile.get("promptSummary")
    if summary:
        return shorten(summary, 1400)

    hints = profile.get("toneHints") or []
    phrases = [entry.get("value") for entry in profile.get("commonPhrases", [])[:10] if entry.get("value")]
    words = [entry.get("value") for entry in profile.get("commonWords", [])[:12] if entry.get("value")]
    parts = []
    if hints:
        parts.append(f"Rasgos: {', '.join(hints)}.")
    if words:
        parts.append(f"Palabras frecuentes: {', '.join(words)}.")
    if phrases:
        parts.append(f"Formas frecuentes: {' | '.join(phrases)}.")
    return "\n".join(parts) if parts else "Perfil disponible, pero sin rasgos resumidos."


def summarize_style_profile(profile):
    if not profile:
        return None
    return {
        "schemaVersion": profile.get("schemaVersion"),
        "messageCount": profile.get("messageCount"),
        "sampleCount": profile.get("sampleCount"),
        "dateRange": profile.get("dateRange"),
    }


def asks_for_encouragement(query):
    triggers = ["empezar bien", "semana", "consejo", "decime algo", "animo"]
    return any(trigger in query for trigger in triggers)


def asks_recent_messages(query):
    triggers = [
        "ultimo mensaje",
        "ultimos mensaje",
        "ultimos mensajes",
        "ultimo que",
        "lo ultimo",
        "mas reciente",
        "reciente",
        "que hablamos",
        "conversacion reciente",
        "orden cronologico",
    ]
    return any(trigger in query for trigger in triggers)


def asks_recent_conversation(query):
    triggers = [
        "con mi hermana",
        "con fabiana",
        "que hablamos",
        "conversacion",
        "nos enviamos",
        "me envie con",
        "me envie",
    ]
    return any(trigger in query for trigger in triggers)


def asks_for_last_request(query):
    triggers = ["ultimo", "pediste", "me pediste", "lo ultimo"]
    return any(trigger in query for trigger in triggers)


def asks_memory_question(query):
    triggers = ["te acordas", "recordas", "acordas"]
    return any(trigger in query for trigger in triggers)


def build_encouragement_reply(persona_name, top_text, second_text):
    detail = top_text or second_text
    if detail:
        return (
            f"Hola, soy {persona_name}. Arranca la semana de a poquito, sin cargarte todo encima. "
            f"Me quedo cerca de esto que aparece en mis recuerdos: \"{shorten(detail, 180)}\". "
            "Hace una cosa por vez, come algo rico, respira, y no te olvides de que podes."
        )

    return (
        f"Hola, soy {persona_name}. Arranca tranqui, una cosa por vez. "
        "No tengo un recuerdo concreto para apoyarme, pero te diria que no te apures y que te cuides."
    )


def build_last_request_reply(dates, top_text):
    if not top_text:
        return "No encuentro un pedido claro en los recuerdos recuperados. No quiero inventarte uno."

    date_part = f"Lo mas cercano que encuentro es del {dates[0]}. " if dates else ""
    return f"{date_part}Me aparece esto: \"{shorten(top_text, 220)}\". Eso es lo que puedo decirte con fuente."


def build_memory_reply(top_text, second_text, dates):
    if not top_text:
        return "No me aparece un recuerdo suficientemente claro de eso."

    date_part = f"Me aparece por aca, cerca del {dates[0]}, " if dates else "Me aparece por aca "
    reply = f"Si, {date_part}algo relacionado con esto: \"{shorten(top_text, 220)}\"."

    if second_text:
        reply += f" Tambien hay otro recuerdo que va por aca: \"{shorten(second_text, 160)}\"."

    return reply


def build_general_reply(top_text, second_text, dates):
    if not top_text:
        return "No tengo suficiente recuerdo concreto para contestarte bien."

    date_part = f"En lo que aparece del {dates[0]}, " if dates else "En lo que aparece, "
    reply = f"{date_part}yo te diria esto: \"{shorten(top_text, 220)}\"."

    if second_text:
        reply += f" Y tambien me aparece: \"{shorten(second_text, 140)}\"."

    return reply


def clean_source_text(text):
    return " ".join(text.split())


def normalize_for_match(text):
    normalized = unicodedata.normalize("NFD", text.lower())
    return "".join(character for character in normalized if unicodedata.category(character) != "Mn")


def shorten(text, limit):
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


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
