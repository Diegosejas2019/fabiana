import argparse
import json
import os
import re
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
    parser.add_argument("--deep-profile", default=None, help="Optional deep persona profile JSON")
    parser.add_argument("--feedback", default=None, help="Optional reviewed response feedback JSONL")
    parser.add_argument("--history-json", default=None, help="Recent chat turns as JSON")
    parser.add_argument(
        "--response-mode",
        default="auto",
        choices=["auto", "dialogue", "memory", "sources"],
        help="Force a high-level answer mode instead of automatic intent routing",
    )
    parser.add_argument(
        "--llm-provider",
        default=os.environ.get("ANSWER_LLM_PROVIDER", "auto"),
        choices=["auto", "none", "ollama", "anthropic"],
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
    parser.add_argument(
        "--anthropic-model",
        default=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
        help="Anthropic model used when Claude generation is enabled",
    )
    parser.add_argument(
        "--anthropic-url",
        default=os.environ.get("ANTHROPIC_URL", "https://api.anthropic.com/v1/messages"),
        help="Anthropic Messages API URL",
    )
    parser.add_argument(
        "--anthropic-key",
        default=os.environ.get("ANTHROPIC_API_KEY", ""),
        help="Anthropic API key. Prefer the ANTHROPIC_API_KEY environment variable.",
    )
    args = parser.parse_args()
    style_profile = read_optional_style_profile(args.style_profile)
    deep_profile = read_optional_deep_profile(args.deep_profile)
    feedback_examples = read_optional_feedback(args.feedback)
    conversation_history = read_optional_history(args.history_json)

    index_dir = Path(args.index_dir)
    manifest = json.loads((index_dir / "embedding-manifest.json").read_text(encoding="utf-8"))
    model_name = args.model or manifest["model"]

    metadata = read_jsonl(index_dir / "embedding-metadata.jsonl")
    chunks_by_id = {chunk["id"]: chunk for chunk in read_jsonl(args.chunks)}

    effective_query = resolve_contextual_query(args.query, conversation_history, deep_profile)
    intent = classify_query_intent(args.query, effective_query, conversation_history, deep_profile, args.response_mode)
    retrieval_query = enrich_query_for_intent(effective_query, intent, deep_profile)
    normalized_query = normalize_for_match(effective_query)
    normalized_retrieval_query = normalize_for_match(retrieval_query)
    fact_terms = None

    if intent["kind"] == "recent":
        retrieval_mode = "chronological"
        include_conversation = asks_recent_conversation(normalized_query) or intent.get("sourcePolicy") == "episodes"
        sources = build_recent_sources(
            metadata,
            chunks_by_id,
            args.top_k,
            args.role,
            args.source_type,
            args.show_text,
            include_conversation,
            asks_whatsapp_messages(normalized_query),
        )
        confidence = "high" if sources else "none"
        draft = build_recent_draft(confidence, sources, args.show_text)
        reply = build_recent_reply(sources, args.show_text)
        generation_mode = "chronological"
    elif intent["kind"] == "fact":
        retrieval_mode = "fact"
        family_entities = build_family_entity_index(deep_profile)
        fact_terms = extract_fact_terms(normalized_query, family_entities)
        profile_reply = build_profile_relation_reply(normalized_query, fact_terms, deep_profile)
        if profile_reply and not fact_terms["names"]:
            sources = []
            confidence = "high"
            draft = "Use el mapa familiar confirmado por Diego para responder sin inventar nombres desde la pregunta."
            reply = profile_reply
            generation_mode = "profile-relation-check"
        else:
            sources = build_fact_sources(metadata, chunks_by_id, args.top_k, args.role, args.source_type, args.show_text, fact_terms)
            confidence = classify_fact_confidence(sources, fact_terms)
            draft = build_fact_draft(confidence, sources, fact_terms)
            reply = build_fact_reply(confidence, sources, fact_terms)
            generation_mode = "fact-check"
    elif intent["kind"] == "dialogue":
        retrieval_mode = "dialogue"
        sources = []
        confidence = "high"
        family_mention_reply = build_family_mention_reply(normalized_query, deep_profile)
        if family_mention_reply:
            reply = family_mention_reply
            generation_mode = "family-mention-check"
        else:
            reply = build_dialogue_reply(normalized_query, args.query)
            generation_mode = "dialogue"
        draft = "Use modo dialogo: no fuerzo recuerdos ni fuentes cuando Diego cuenta algo actual."
    else:
        retrieval_mode = "semantic"
        embeddings = np.load(index_dir / "embeddings.npy")
        model = TextEmbedding(model_name=model_name)
        query_vector = np.array(list(model.query_embed(retrieval_query))[0], dtype=np.float32)
        scores = cosine_scores(embeddings, query_vector)
        sources = build_semantic_sources(metadata, chunks_by_id, scores, args.top_k, args.role, args.source_type, args.show_text, normalized_retrieval_query, intent)
        confidence = classify_confidence(sources)
        draft = build_draft(confidence, sources, args.show_text, intent)
        if intent["kind"] == "source_explorer":
            reply = build_source_explorer_reply(sources)
            generation_mode = "source-explorer"
        else:
            reply, generation_mode = build_persona_reply(
                effective_query,
                confidence,
                sources,
                args.persona_name,
                args.llm_provider,
                args.ollama_model,
                args.ollama_url,
                args.anthropic_model,
                args.anthropic_url,
                args.anthropic_key,
                style_profile,
                deep_profile,
                feedback_examples,
                conversation_history,
                intent,
            )

    validation = validate_and_repair_reply(
        normalized_query,
        reply,
        generation_mode,
        retrieval_mode,
        confidence,
        sources,
        deep_profile,
        fact_terms,
    )
    reply = validation["reply"]
    generation_mode = validation["generationMode"]
    quality = assess_answer_quality(
        reply,
        generation_mode,
        retrieval_mode,
        confidence,
        sources,
        validation,
        intent,
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
        "validation": validation["summary"],
        "quality": quality,
        "intent": intent,
        "styleProfile": summarize_style_profile(style_profile),
        "deepProfile": summarize_deep_profile(deep_profile),
        "feedbackProfile": summarize_feedback_examples(feedback_examples),
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
                "validation": answer["validation"],
                "quality": answer["quality"],
                "intent": answer["intent"],
                "styleProfile": answer["styleProfile"],
                "deepProfile": answer["deepProfile"],
                "feedbackProfile": answer["feedbackProfile"],
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


def build_semantic_sources(metadata, chunks_by_id, scores, top_k, role, source_type, show_text, query, intent=None):
    candidates = []
    latest_timestamp = latest_parseable_timestamp(metadata)
    query_terms = extract_search_terms(query)
    use_recent_boost = asks_recent_context(query)
    intent = intent or {"kind": "memory", "sourcePolicy": "balanced"}

    for row, score in zip(metadata, scores):
        if role and row["role"] != role:
            continue
        if source_type and row["sourceType"] != source_type:
            continue

        chunk = chunks_by_id[row["chunkId"]]
        lexical = lexical_match_score(query_terms, normalize_for_match(chunk.get("text", "")))
        recency = recency_match_score(row, latest_timestamp) if use_recent_boost else 0.0
        source_boost = source_type_boost(row, lexical, query, intent)
        hybrid_score = min(1.0, float(score) + lexical + recency + source_boost)
        source = build_source(row, chunk, hybrid_score, show_text)
        source["ranking"] = {
            "mode": "hybrid",
            "semanticScore": round(float(score), 6),
            "lexicalBoost": round(lexical, 6),
            "recencyBoost": round(recency, 6),
            "sourceBoost": round(source_boost, 6),
        }
        candidates.append(source)

    candidates = expand_episode_neighbors(candidates)
    candidates.sort(
        key=lambda item: (
            item["score"],
            item.get("ranking", {}).get("lexicalBoost", 0),
            item.get("timestamp") or "",
        ),
        reverse=True,
    )
    return select_sources_for_intent(candidates, top_k, intent)


def select_sources_for_intent(candidates, top_k, intent):
    if intent.get("sourcePolicy") not in ["episodes", "memory"]:
        return distinct_sources(candidates, top_k)

    selected = []
    seen = set()

    for source in candidates:
        if source.get("sourceType") != "conversation_context":
            continue
        if add_distinct_source(selected, seen, source, top_k):
            source.setdefault("selectionReason", "episode_context")
        if len(selected) >= min(3, top_k):
            break

    for source in candidates:
        add_distinct_source(selected, seen, source, top_k)
        if len(selected) >= top_k:
            break

    return selected


def add_distinct_source(selected, seen, source, limit):
    key = source.get("memoryId") or source.get("chunkId")
    if key in seen or len(selected) >= limit:
        return False
    seen.add(key)
    selected.append(source)
    return True


def distinct_sources(sources, limit):
    selected = []
    seen = set()
    for source in sources:
        if add_distinct_source(selected, seen, source, limit):
            pass
        if len(selected) >= limit:
            break
    return selected


def expand_episode_neighbors(candidates):
    by_memory_id = {
        source.get("memoryId"): source
        for source in candidates
        if source.get("memoryId")
    }
    expanded = list(candidates)

    for source in candidates:
        evidence = source.get("evidence") or {}
        if evidence.get("kind") != "conversation_context":
            continue
        source["episode"] = build_episode_summary(source)
        base_score = float(source.get("score") or 0)
        for memory_id in evidence.get("memoryIds", [])[:12]:
            neighbor = by_memory_id.get(memory_id)
            if not neighbor:
                continue
            neighbor = dict(neighbor)
            neighbor["score"] = max(float(neighbor.get("score") or 0), min(1.0, base_score - 0.015))
            neighbor["episodeParentId"] = source.get("memoryId")
            neighbor.setdefault("ranking", {})
            neighbor["ranking"]["episodeBoost"] = round(max(0.0, neighbor["score"] - float(by_memory_id[memory_id].get("score") or 0)), 6)
            expanded.append(neighbor)

    return expanded


def build_episode_summary(source):
    evidence = source.get("evidence") or {}
    date_range = evidence.get("dateRange") or {}
    time_range = evidence.get("timeRange") or {}
    text = normalize_for_match(source.get("text") or source.get("displayText") or "")
    return {
        "kind": "conversation_episode",
        "surface": (evidence.get("source") or {}).get("surface"),
        "messageCount": len(evidence.get("messageIds", [])),
        "dateRange": date_range,
        "timeRange": time_range,
        "themes": detect_episode_themes(text),
        "roleCounts": evidence.get("roleCounts") or {},
    }


def detect_episode_themes(text):
    theme_patterns = [
        ("salud", ["estomago", "digest", "medico", "doc", "turno", "endoscopia", "malestar", "siento mal", "tratamiento"]),
        ("hijos", ["leandro", "lean", "agustina", "agus", "bianca", "bian", "chicos", "hijos", "escuela", "clases"]),
        ("casa", ["casa", "limpiar", "orden", "platos", "pieza", "piso", "desastre"]),
        ("familia", ["abuela", "berta", "prima", "tias", "beti", "daiana", "naty"]),
        ("mascotas", ["perro", "perrito", "gato", "gatito", "tilin", "toto", "boran", "piki"]),
        ("rutina", ["manana", "tarde", "horario", "retirar", "buscar", "llevar", "trabajo"]),
    ]
    themes = []
    for label, patterns in theme_patterns:
        if any(pattern in text for pattern in patterns):
            themes.append(label)
    return themes[:4]


SEARCH_STOP_WORDS = {
    "hola",
    "die",
    "fabi",
    "fabiana",
    "acordas",
    "acordaste",
    "recordas",
    "recuerdas",
    "contame",
    "decime",
    "algo",
    "cual",
    "cuales",
    "como",
    "cuando",
    "donde",
    "quien",
    "que",
    "del",
    "con",
    "por",
    "para",
    "una",
    "uno",
    "unos",
    "unas",
    "este",
    "esta",
    "esto",
    "estos",
    "estas",
    "tenias",
    "tenes",
    "tiene",
    "tengo",
    "sos",
    "era",
    "eras",
    "vos",
    "tuyo",
    "tuya",
    "mio",
    "mia",
    "mis",
    "tus",
    "sus",
}


def extract_search_terms(query):
    words = re.findall(r"[a-z0-9]+", query)
    terms = []
    for word in words:
        if len(word) < 4 or word in SEARCH_STOP_WORDS:
            continue
        if word not in terms:
            terms.append(word)
    return terms[:12]


def lexical_match_score(query_terms, text):
    if not query_terms or not text:
        return 0.0

    matched = 0
    for term in query_terms:
        if contains_word(text, term) or (len(term) >= 7 and term[:6] in text):
            matched += 1

    if matched == 0:
        return 0.0

    coverage = matched / max(len(query_terms), 1)
    return min(0.18, 0.04 * matched + 0.08 * coverage)


def asks_recent_context(query):
    triggers = [
        "ultimo",
        "ultimos",
        "ultima",
        "ultimas",
        "reciente",
        "recientes",
        "ultimo año",
        "ultimamente",
        "ultimos meses",
        "ahora",
        "estos dias",
    ]
    return any(trigger in query for trigger in triggers)


def latest_parseable_timestamp(rows):
    timestamps = [
        parse_timestamp(row.get("timestamp"))
        for row in rows
        if row.get("sourceType") != "user_assertion"
    ]
    timestamps = [timestamp for timestamp in timestamps if timestamp]
    return max(timestamps) if timestamps else None


def parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def recency_match_score(row, latest_timestamp):
    if not latest_timestamp or row.get("sourceType") == "user_assertion":
        return 0.0

    timestamp = parse_timestamp(row.get("timestamp"))
    if not timestamp:
        return 0.0

    age_days = max(0, (latest_timestamp - timestamp).days)
    if age_days <= 30:
        return 0.08
    if age_days <= 90:
        return 0.06
    if age_days <= 365:
        return 0.04
    return 0.0


def source_type_boost(row, lexical_score, query, intent=None):
    source_type = row.get("sourceType")
    kind = (intent or {}).get("kind")
    source_policy = (intent or {}).get("sourcePolicy")

    if source_type == "user_assertion":
        if kind in ["memory", "children_memory", "person_memory", "self_profile", "health_context"]:
            return -0.08 if lexical_score < 0.14 else -0.02
        return 0.08 if lexical_score >= 0.08 else -0.04
    if source_type == "conversation_context":
        if source_policy == "episodes" or kind in ["memory", "children_memory", "person_memory", "self_profile", "health_context"]:
            return 0.1 if lexical_score >= 0.08 else 0.07
        if any(term in query for term in [
            "contexto",
            "hablamos",
            "conversacion",
            "conversamos",
            "ultimos",
            "ultimo",
            "recuerdo",
            "recuerdos",
            "cotidiano",
            "rutina",
            "escuela",
            "colegio",
            "casa",
            "chicos",
            "hijos",
            "pasado",
            "paso",
        ]):
            return 0.06
        return 0.02 if lexical_score >= 0.08 else 0.0
    if source_type == "audio_transcript" and (
        any(term in query for term in ["audio", "voz", "nota de voz"])
        or kind in ["memory", "children_memory", "person_memory", "health_context"]
    ):
        return 0.04
    if source_type == "whatsapp_text" and asks_whatsapp_messages(query):
        return 0.04
    return 0.0


def build_recent_sources(metadata, chunks_by_id, top_k, role, source_type, show_text, include_conversation, prefer_whatsapp):
    candidates = []
    for row in metadata:
        if source_type and row["sourceType"] != source_type:
            continue
        if row["sourceType"] == "user_assertion" and source_type != "user_assertion":
            continue
        if prefer_whatsapp and row["sourceType"] not in ["whatsapp_text", "audio_transcript", "conversation_context"]:
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


def build_fact_sources(metadata, chunks_by_id, top_k, role, source_type, show_text, fact_terms):
    candidates = []
    terms = fact_terms["names"] + fact_terms["relations"]
    for row in metadata:
        if role and row["role"] != role:
            continue
        if source_type and row["sourceType"] != source_type:
            continue

        chunk = chunks_by_id[row["chunkId"]]
        normalized_text = normalize_for_match(chunk["text"])
        matched_names = [term for term in fact_terms["names"] if term in normalized_text]
        matched_relations = [term for term in fact_terms["relations"] if relation_matches(term, normalized_text)]

        if not matched_names and not matched_relations:
            continue

        match_count = len(matched_names) + len(matched_relations)
        score = 0.25 + (0.35 * len(matched_names)) + (0.25 * len(matched_relations))
        if all(term in normalized_text for term in terms):
            score += 0.15
        source = build_source(row, chunk, min(score, 1.0), show_text)
        source["factMatches"] = {
            "names": matched_names,
            "relations": matched_relations,
            "matchCount": match_count,
        }
        candidates.append(source)

    candidates.sort(
        key=lambda item: (
            item.get("factMatches", {}).get("matchCount", 0),
            item["score"],
            item.get("timestamp") or "",
        ),
        reverse=True,
    )
    return candidates[:top_k]


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
        display_text = corrected_display_source_text(chunk["text"])
        if display_text != chunk["text"]:
            source["displayText"] = display_text
            source["textCorrections"] = ["bianca_transcription_alias"]

    return source


def classify_fact_confidence(sources, fact_terms):
    if not sources:
        return "none"

    for source in sources:
        matches = source.get("factMatches", {})
        if matches.get("names") and matches.get("relations"):
            if is_user_confirmed_source(source):
                return "high"
            return "medium"

    return "none"


def build_draft(confidence, sources, show_text, intent=None):
    if confidence == "none":
        return (
            "No encontre recuerdos suficientes para responder basandome en el archivo. "
            "Conviene reformular la pregunta o revisar manualmente las fuentes."
        )

    source_count = len(sources)
    date_span = summarize_dates(sources)
    episode_count = sum(1 for source in sources if source.get("sourceType") == "conversation_context")
    intent_label = (intent or {}).get("label", "recuerdo")

    if confidence == "high":
        opening = "Encontre varias fuentes relacionadas en el archivo."
    else:
        opening = "Encontre algunas fuentes relacionadas, pero la evidencia no es concluyente."

    episode_sentence = ""
    if episode_count:
        episode_sentence = f" Priorizo {episode_count} episodio(s) conversacionales para sostener contexto."

    if show_text:
        return (
            f"{opening} Intencion: {intent_label}. Hay {source_count} fuentes recuperadas ({date_span}).{episode_sentence} "
            "Usa los textos y evidencias adjuntas para redactar una respuesta final sin agregar recuerdos nuevos."
        )

    return (
        f"{opening} Intencion: {intent_label}. Hay {source_count} fuentes recuperadas ({date_span}).{episode_sentence} "
        "No incluyo texto privado en consola; revisa el JSON privado o vuelve a correr con --show-text si quieres inspeccionar contenido."
    )


def build_source_explorer_reply(sources):
    if not sources:
        return "No encontre fuentes claras para mostrarte sobre eso."

    episode_count = sum(1 for source in sources if source.get("sourceType") == "conversation_context")
    audio_count = sum(1 for source in sources if source.get("sourceType") == "audio_transcript")
    date_span = summarize_dates(sources)
    type_counts = []
    for source_type, label in [
        ("conversation_context", "episodios"),
        ("audio_transcript", "audios"),
        ("whatsapp_text", "mensajes"),
        ("facebook_text", "Facebook"),
        ("user_assertion", "datos confirmados"),
    ]:
        count = sum(1 for source in sources if source.get("sourceType") == source_type)
        if count:
            type_counts.append(f"{count} {label}")

    lead = "Te dejo las fuentes que encontre"
    if episode_count:
        lead = "Te dejo primero los episodios conversacionales que encontre"
    detail = f": {', '.join(type_counts)}" if type_counts else ""
    audio_hint = " Hay audios recuperados para escuchar." if audio_count else ""
    date_sentence = f" Estan {date_span}." if date_span.startswith("entre ") else f" Fecha: {date_span}."
    return f"{lead}{detail}.{date_sentence}{audio_hint} Revisalas en el panel de fuentes."


def build_fact_draft(confidence, sources, fact_terms):
    names = ", ".join(fact_terms["names"]) or "el nombre consultado"
    relations = ", ".join(fact_terms["relations"]) or "la relacion consultada"
    if confidence == "none":
        return (
            f"No encontre evidencia directa que una {relations} con {names}. "
            f"Hay {len(sources)} fuentes lexicas relacionadas, pero no alcanzan para afirmar el dato."
        )

    if confidence == "high":
        return f"Encontre una fuente manual confirmada por Diego que relaciona {relations} con {names}."

    return (
        f"Encontre fuentes relacionadas con {names} y {relations}, pero esta respuesta debe mantenerse cautelosa "
        "si la relacion no aparece declarada de forma explicita."
    )


def build_fact_reply(confidence, sources, fact_terms):
    display_name = display_fact_name(fact_terms)
    display_names = display_fact_names(fact_terms)
    display_relation = display_fact_relation(fact_terms)
    if confidence == "none":
        if sources:
            return (
                f"No puedo confirmarlo con seguridad. Encuentro menciones a {display_name}, "
                f"pero no una fuente directa que diga que es {display_relation}."
            )
        return f"No encuentro una fuente clara para confirmar si {display_name} es {display_relation}."

    if confidence == "high":
        verb = "son" if len(fact_terms["names"]) > 1 else "es"
        return f"Si, die, {display_names} {verb} {display_relation}."

    return (
        f"Lo tomaria con cautela: encontre menciones que relacionan a {display_name} con {display_relation}, "
        "pero conviene revisar las fuentes antes de darlo por confirmado."
    )


def is_user_confirmed_source(source):
    evidence = source.get("evidence") or {}
    return source.get("sourceType") == "user_assertion" and evidence.get("confidence") == "user_confirmed"


def validate_and_repair_reply(query, reply, generation_mode, retrieval_mode, confidence, sources, deep_profile, fact_terms):
    issues = collect_reply_issues(query, reply, retrieval_mode, sources, deep_profile)
    repaired_reply = reply
    repaired = False

    if issues:
        candidate = build_repair_reply(query, retrieval_mode, confidence, sources, deep_profile, fact_terms, issues)
        if candidate and normalize_for_match(candidate) != normalize_for_match(reply):
            repaired_reply = candidate
            repaired = True
            issues = collect_reply_issues(query, repaired_reply, retrieval_mode, sources, deep_profile)

    status = "repaired" if repaired else ("flagged" if issues else "ok")
    repaired_generation_mode = f"validator-repair:{generation_mode}" if repaired else generation_mode

    return {
        "reply": repaired_reply,
        "generationMode": repaired_generation_mode,
        "summary": {
            "status": status,
            "issues": issues,
            "repaired": repaired,
        },
    }


def collect_reply_issues(query, reply, retrieval_mode, sources, deep_profile):
    normalized_reply = normalize_for_match(reply)
    issues = []

    if has_report_tone(normalized_reply):
        issues.append("report_tone")
    if has_unwanted_citation(query, reply, normalized_reply):
        issues.append("unwanted_citation")
    if has_bad_addressing(normalized_reply):
        issues.append("bad_addressing")
    if has_health_contradiction(query, normalized_reply, sources, deep_profile):
        issues.append("health_contradiction")
    if has_children_context_confusion(query, normalized_reply):
        issues.append("children_context_confusion")
    if has_children_memory_drift(query, normalized_reply):
        issues.append("children_memory_drift")
    if has_speaker_inversion(query, normalized_reply):
        issues.append("speaker_inversion")
    if retrieval_mode == "fact" and has_fact_report_leak(normalized_reply):
        issues.append("fact_report_leak")

    return unique_items(issues)


def build_repair_reply(query, retrieval_mode, confidence, sources, deep_profile, fact_terms, issues):
    if "children_memory_drift" in issues or asks_children_memory_context(query):
        children_memory_reply = build_children_memory_reply(query, sources)
        if children_memory_reply:
            return children_memory_reply

    if "children_context_confusion" in issues or asks_children_context(query):
        children_reply = build_children_context_reply(query, deep_profile)
        if children_reply:
            return children_reply

    if "health_contradiction" in issues or asks_health_context_question(query) or asks_self_description(query):
        health_reply = build_health_context_reply(query, sources, deep_profile)
        if health_reply:
            return health_reply

    if retrieval_mode == "fact" and fact_terms:
        return build_fact_reply(confidence, sources, fact_terms)

    preference_reply = build_preference_reply(query, sources)
    if preference_reply:
        return preference_reply

    family_mention_reply = build_family_mention_reply(query, deep_profile)
    if family_mention_reply:
        return family_mention_reply

    if asks_recent_messages(query):
        return build_recent_reply(sources, True)

    if "report_tone" in issues or "unwanted_citation" in issues or "bad_addressing" in issues:
        if confidence == "none":
            return "No tengo un recuerdo claro de eso, die. Prefiero no inventarte algo que no aparece bien en las fuentes."
        return "Si, die. Me aparece algo relacionado, pero prefiero contestarte con cuidado y sin inventar detalles que no esten claros."

    return None


def has_report_tone(normalized_reply):
    markers = [
        "fuentes recuperadas",
        "whatsapp_text",
        "audio_transcript",
        "facebook_text",
        "user_assertion",
        "evidencia adjunta",
        "evidencias adjuntas",
        "en orden cronologico",
        "mensaje de fabiana del",
        "source:",
    ]
    return any(marker in normalized_reply for marker in markers)


def has_unwanted_citation(query, reply, normalized_reply):
    if asks_recent_messages(query) and re.search(r"\b\d{1,2}/\d{1,2}/\d{4}\b", reply):
        return True
    if asks_recent_messages(query) and ('"' in reply or "“" in reply or "”" in reply):
        return True
    return "te puso:" in normalized_reply or "diciendo:" in normalized_reply


def has_bad_addressing(normalized_reply):
    return any(marker in normalized_reply for marker in ["¿die?", "?die", ", ¿die", ", ?die"])


def has_children_context_confusion(query, normalized_reply):
    return asks_children_context(query) and any(term in normalized_reply for term in ["prima", "primas", "primo", "primos"])


def has_children_memory_drift(query, normalized_reply):
    if not asks_children_memory_context(query):
        return False

    drift_markers = [
        "no estoy aqui",
        "ya no estoy aqui",
        "no puedo hablar",
        "no puedo seguir",
        "estoy en paz",
        "siempre estare contigo",
        "siempre los ame",
        "los ame",
    ]
    return any(marker in normalized_reply for marker in drift_markers)


def has_speaker_inversion(query, normalized_reply):
    normalized_query = normalize_for_match(query)
    user_action_markers = [
        "visite a",
        "visite la",
        "fui a ver",
        "pase a ver",
        "estuve con",
        "me encontre",
        "me cruce",
        "hable con",
        "charle con",
    ]
    if not any(marker in normalized_query for marker in user_action_markers):
        return False

    inverted_markers = [
        "yo fui",
        "fui a visitar",
        "yo visite",
        "hoy fui",
        "hoy visite",
        "me la encontre",
        "me lo encontre",
        "yo hable",
        "estuve hablando con",
    ]
    return any(marker in normalized_reply for marker in inverted_markers)


def has_health_contradiction(query, normalized_reply, sources, deep_profile):
    if not asks_health_context_question(query) and not asks_self_description(query):
        return False

    has_health_context = bool(find_profile_health_facts(deep_profile))
    if not has_health_context:
        has_health_context = bool([
            source
            for source in sources
            if any(term in normalize_for_match(source.get("text", "")) for term in ["estomago", "estomac", "digest", "gases", "acidez", "antiacido", "malestar"])
        ])

    if not has_health_context:
        return False

    contradiction_markers = [
        "no hay problema",
        "no tiene problemas",
        "no tenia problemas",
        "tenes un problema",
        "tenes problema",
        "tu problema con el estomago",
    ]
    return any(marker in normalized_reply for marker in contradiction_markers)


def has_fact_report_leak(normalized_reply):
    markers = [
        "figuran como",
        "confirmado por diego",
        "dato confirmado",
        "acordas y",
    ]
    return any(marker in normalized_reply for marker in markers)


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
        return "No me aparece un intercambio reciente suficiente para contestarte bien."

    latest = sources[0]
    text = clean_source_text(latest.get("text", ""))

    if show_text and text:
        return build_latest_message_sentence(latest, text)

    return "Si, die. Me aparece el ultimo intercambio, pero prefiero dejar el detalle exacto solo en las fuentes."


def display_speaker(source):
    if source["role"] == "targetPerson":
        return "Fabiana"
    if source["role"] == "self":
        return "Vos"
    return source["role"]


def build_latest_message_sentence(source, text):
    summary = summarize_message_meaning(source, text)
    if source["role"] == "self":
        return f"Si, die. Lo ultimo fue que vos {summary}."
    if source["role"] == "targetPerson":
        return f"Si, die. Lo ultimo fue que yo {summary}."
    return f"Si, die. Lo ultimo fue algo relacionado con esto: {summary}."


def summarize_message_meaning(source, text):
    normalized = normalize_for_match(text)

    if "cargar" in normalized and "dato" in normalized:
        return "estaba hablando de unos datos que no se podian cargar"

    if "veo" in normalized and "manana" in normalized:
        if source["role"] == "self":
            return "me decias que me veias al dia siguiente"
        return "hablaba de vernos al dia siguiente"

    if "gracias" in normalized:
        return "agradecia algo cortito"

    if "buen dia" in normalized or "buenos dias" in normalized:
        return "saludaba con un buen dia"

    keywords = extract_meaning_keywords(normalized)
    if keywords:
        return f"hablaba de {', '.join(keywords)}"

    return "prefiero dejar el detalle exacto en las fuentes para no copiarlo textual"


def extract_meaning_keywords(text):
    stop_words = {
        "que",
        "para",
        "con",
        "los",
        "las",
        "una",
        "uno",
        "del",
        "por",
        "pero",
        "todo",
        "esta",
        "este",
        "eso",
        "aca",
        "ahi",
        "no",
        "si",
    }
    words = [
        word
        for word in text.split()
        if len(word) > 3 and word not in stop_words and word.isalnum()
    ]
    seen = []
    for word in words:
        if word not in seen:
            seen.append(word)
    return seen[:4]


def build_persona_reply(query, confidence, sources, persona_name, llm_provider, ollama_model, ollama_url, anthropic_model, anthropic_url, anthropic_key, style_profile, deep_profile, feedback_examples, conversation_history, intent=None):
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

    preference_reply = build_preference_reply(lower_query, sources)
    if preference_reply:
        return preference_reply, "preference-check"

    health_reply = build_health_context_reply(lower_query, sources, deep_profile)
    if health_reply:
        return health_reply, "health-context-check"

    children_memory_reply = build_children_memory_reply(lower_query, sources, force=(intent or {}).get("kind") == "children_memory")
    if children_memory_reply:
        return children_memory_reply, "children-memory-check"

    children_reply = build_children_context_reply(lower_query, deep_profile)
    if children_reply:
        return children_reply, "children-context-check"

    person_memory_reply = build_profile_person_memory_reply(lower_query, sources, deep_profile, force=(intent or {}).get("kind") == "person_memory")
    if person_memory_reply:
        return person_memory_reply, "profile-person-memory-check"

    person_reply = build_profile_person_reply(lower_query, deep_profile)
    if person_reply:
        return person_reply, "profile-person-check"

    family_mention_reply = build_family_mention_reply(lower_query, deep_profile)
    if family_mention_reply:
        return family_mention_reply, "family-mention-check"

    if llm_provider in ("auto", "ollama") and source_texts:
        generated = build_ollama_reply(query, sources, persona_name, ollama_model, ollama_url, style_profile, deep_profile, feedback_examples, conversation_history)
        if generated:
            return generated, f"ollama:{ollama_model}"

    if llm_provider == "anthropic" and source_texts:
        generated = build_anthropic_reply(query, sources, persona_name, anthropic_model, anthropic_url, anthropic_key, style_profile, deep_profile, feedback_examples, conversation_history)
        if generated:
            return generated, f"anthropic:{anthropic_model}"

    if asks_for_encouragement(lower_query):
        return build_encouragement_reply(persona_name, top_text, second_text), "fallback"

    if asks_for_last_request(lower_query):
        return build_last_request_reply(dates, top_text), "fallback"

    if asks_memory_question(lower_query):
        return build_memory_reply(top_text, second_text, dates), "fallback"

    return build_general_reply(top_text, second_text, dates), "fallback"


def build_generation_prompts(query, sources, persona_name, style_profile, deep_profile, feedback_examples, conversation_history):
    prompt_sources = format_sources_for_prompt(sources)
    if not prompt_sources:
        return None, None

    style_prompt = format_style_profile_for_prompt(style_profile)
    deep_prompt = format_deep_profile_for_prompt(deep_profile)
    feedback_prompt = format_feedback_for_prompt(feedback_examples)
    history_prompt = format_history_for_prompt(conversation_history)
    system_prompt = (
        "Sos un motor de redaccion para una app privada de memoria familiar. "
        f"Redacta como {persona_name}: cercana, simple, afectuosa y natural. "
        "Usa los mensajes recuperados como fuente de recuerdos y los datos personales confirmados por Diego solo como contexto factual. "
        "Usa los perfiles de estilo y profundo solo para forma de hablar, relaciones y contexto general; no los uses como unica fuente de hechos nuevos. "
        "Usa el feedback aprobado o corregido por Diego solo como ejemplos de calidad y tono; no lo trates como recuerdo ni como hecho nuevo. "
        "Podes inventar frases nuevas y tono conversacional, pero no inventes recuerdos, hechos, pedidos, promesas ni fechas. "
        "Si Diego cuenta algo que hizo el o algo que vio hoy, no lo transformes en una accion propia de Fabiana; responde acompanando lo que Diego conto. "
        "Si la evidencia no alcanza, decilo suavemente. "
        "No digas que sos IA, no menciones IDs tecnicos y no copies mensajes largos literalmente. "
        "Responde en primera persona, en espanol rioplatense natural, con 1 a 4 frases."
    )
    user_prompt = (
        f"Pregunta de Diego:\n{query}\n\n"
        f"Perfil de estilo de Fabiana:\n{style_prompt}\n\n"
        f"Perfil profundo de Fabiana:\n{deep_prompt}\n\n"
        f"Feedback de calidad aprobado/corregido por Diego:\n{feedback_prompt}\n\n"
        f"Historial reciente de este chat:\n{history_prompt}\n\n"
        "Fuentes recuperadas (mensajes reales y datos personales confirmados):\n"
        f"{prompt_sources}\n\n"
        "Escribi una respuesta final nueva, como si Fabiana le respondiera ahora, manteniendote fiel a esas fuentes."
    )
    return system_prompt, user_prompt


def build_ollama_reply(query, sources, persona_name, model, url, style_profile, deep_profile, feedback_examples, conversation_history):
    system_prompt, user_prompt = build_generation_prompts(query, sources, persona_name, style_profile, deep_profile, feedback_examples, conversation_history)
    if not system_prompt or not user_prompt:
        return None

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


def build_anthropic_reply(query, sources, persona_name, model, url, api_key, style_profile, deep_profile, feedback_examples, conversation_history):
    if not api_key:
        return None

    system_prompt, user_prompt = build_generation_prompts(query, sources, persona_name, style_profile, deep_profile, feedback_examples, conversation_history)
    if not system_prompt or not user_prompt:
        return None

    payload = {
        "model": model,
        "max_tokens": 220,
        "temperature": 0.65,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": user_prompt},
        ],
    }

    try:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=75) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None

    parts = []
    for block in result.get("content", []):
        if block.get("type") == "text" and block.get("text"):
            parts.append(block["text"])
    return clean_generated_reply("\n".join(parts))


def format_sources_for_prompt(sources):
    rows = []
    for index, source in enumerate(sources[:8], start=1):
        text = clean_source_text(source.get("displayText") or source.get("text", ""))
        if not text:
            continue
        date = source.get("localDate") or "sin fecha"
        source_type = display_source_type(source.get("sourceType") or "fuente")
        rows.append(f"{index}. {date} ({source_type}): {shorten(text, 520)}")
    return "\n".join(rows)


def display_source_type(source_type):
    labels = {
        "user_assertion": "dato personal confirmado por Diego",
        "conversation_context": "contexto conversacional",
        "whatsapp_text": "mensaje de WhatsApp",
        "audio_transcript": "audio transcripto de WhatsApp",
        "facebook_text": "mensaje de Facebook",
    }
    return labels.get(source_type, source_type)


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


def read_optional_deep_profile(path):
    if not path:
        return None
    profile_path = Path(path)
    if not profile_path.exists():
        return None
    return json.loads(profile_path.read_text(encoding="utf-8"))


def read_optional_feedback(path):
    if not path:
        return []
    feedback_path = Path(path)
    if not feedback_path.exists():
        return []

    rows = []
    for line in feedback_path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        rating = row.get("rating")
        if rating not in ["approved", "corrected"]:
            continue
        query = clean_source_text(row.get("query", ""))
        reply = clean_source_text(row.get("correctedReply") or row.get("reply", ""))
        if query and reply:
            rows.append({
                "rating": rating,
                "reason": row.get("reason"),
                "query": query,
                "reply": reply,
            })
    return rows[-8:]


def read_optional_history(raw_history):
    if not raw_history:
        return []
    try:
        rows = json.loads(raw_history)
    except json.JSONDecodeError:
        return []
    if not isinstance(rows, list):
        return []
    history = []
    for row in rows[-8:]:
        if not isinstance(row, dict):
            continue
        role = str(row.get("role", "")).strip()
        content = str(row.get("content", "")).strip()
        if role in ["user", "assistant"] and content:
            history.append({"role": role, "content": shorten(content, 500)})
    return history


def classify_query_intent(original_query, effective_query, history, deep_profile, response_mode="auto"):
    normalized_original = normalize_for_match(original_query)
    normalized_query = normalize_for_match(effective_query)
    names = resolve_profile_person_names(normalized_query, deep_profile)

    if response_mode == "dialogue":
        return build_intent("dialogue", "dialogo elegido", "dialogue", "none", response_mode)
    if response_mode == "sources":
        return build_intent("source_explorer", "explorar fuentes", "semantic", "episodes", response_mode)
    if response_mode == "memory":
        if asks_recent_messages(normalized_query):
            return build_intent("recent", "ultimos mensajes", "chronological", "dated", response_mode)
        if needs_children_memory_resolution(normalized_original, history) or asks_children_context(normalized_query):
            return build_intent("children_memory", "recuerdo de los chicos", "semantic", "episodes", response_mode)
        if asks_health_context_question(normalized_query) or asks_self_description(normalized_query):
            return build_intent("health_context", "contexto personal/salud", "semantic", "episodes", response_mode)
        if len(names) == 1:
            return build_intent("person_memory", f"recuerdo sobre {names[0]}", "semantic", "episodes", response_mode)
        return build_intent("memory", "recuerdo real elegido", "semantic", "episodes", response_mode)

    if asks_recent_messages(normalized_query):
        return build_intent("recent", "ultimos mensajes", "chronological", "dated", response_mode)

    if asks_identity_fact(normalized_query) and not asks_deeper_profile_person_context(normalized_query):
        return build_intent("fact", "dato familiar", "fact", "profile", response_mode)

    if is_simple_check_in(normalized_query):
        return build_intent("dialogue", "saludo cotidiano", "dialogue", "none", response_mode)

    if is_dialogue_update(normalized_query):
        return build_intent("dialogue", "dialogo actual", "dialogue", "none", response_mode)

    if needs_children_memory_resolution(normalized_original, history) or asks_children_memory_context(normalized_query):
        return build_intent("children_memory", "recuerdo de los chicos", "semantic", "episodes", response_mode)

    if asks_children_context(normalized_query):
        return build_intent("children_context", "contexto de los chicos", "semantic", "profile", response_mode)

    if asks_health_context_question(normalized_query) or asks_self_description(normalized_query):
        return build_intent("health_context", "contexto personal/salud", "semantic", "episodes", response_mode)

    if asks_deeper_profile_person_context(normalized_query) and len(names) == 1:
        relation = profile_relation_for_person(names[0], deep_profile)
        if relation in ["hijo", "hija", "marido", "hermano", "hermana", "abuela", "abuelo", "prima", "primo"]:
            return build_intent("person_memory", f"recuerdo sobre {names[0]}", "semantic", "episodes", response_mode)

    if asks_preference_question(normalized_query):
        return build_intent("preference", "preferencia confirmada", "semantic", "balanced", response_mode)

    if asks_profile_person_context(normalized_query) or is_family_conversation_statement(normalized_query):
        return build_intent("profile", "perfil familiar", "semantic", "profile", response_mode)

    if asks_memory_question(normalized_query) or asks_open_memory_prompt(normalized_query):
        return build_intent("memory", "recuerdo narrativo", "semantic", "episodes", response_mode)

    return build_intent("semantic", "busqueda general", "semantic", "balanced", response_mode)


def build_intent(kind, label, route, source_policy, response_mode="auto"):
    return {
        "kind": kind,
        "label": label,
        "route": route,
        "sourcePolicy": source_policy,
        "responseMode": response_mode,
    }


def asks_open_memory_prompt(query):
    triggers = [
        "contame",
        "decime",
        "hablame",
        "algo sobre",
        "que paso",
        "que pasaba",
        "recordas",
        "acordas",
    ]
    return any(trigger in query for trigger in triggers)


def enrich_query_for_intent(query, intent, deep_profile):
    kind = intent.get("kind")
    normalized_query = normalize_for_match(query)

    if kind == "children_memory":
        return f"{query} los chicos hijos Leandro Agustina Bianca escuela colegio casa rutina cotidiano horarios cuidar"

    if kind == "health_context":
        return f"{query} estomago digestivo malestar medico estudios tratamiento turnos endoscopia peso sentir mal"

    if kind == "person_memory":
        matched_names = resolve_profile_person_names(normalized_query, deep_profile)
        if len(matched_names) == 1:
            name = matched_names[0]
            normalized_name = normalize_for_match(name)
            if normalized_name == "leandro":
                return (
                    f"{query} Leandro Lean Lea Leo ayuda ayudar organizar casa "
                    "retirar buscar sentia mal termino cotidiano rutina escuela"
                )
            if normalized_name == "agustina":
                return f"{query} Agustina Agus casa ayuda escuela colegio rutina cotidiano"
            if normalized_name == "bianca":
                return f"{query} Bianca Bian escuela casa retirar buscar rutina cotidiano"
        return f"{query} cotidiano rutina casa familia charla episodio"

    if kind == "memory":
        return f"{query} recuerdo episodio conversacion audio whatsapp rutina cotidiano"

    return query


def resolve_contextual_query(query, history, deep_profile):
    normalized_query = normalize_for_match(query)
    if needs_children_memory_resolution(normalized_query, history):
        return f"{query} los chicos hijos Leandro Agustina Bianca escuela colegio casa rutina cotidiano"

    enriched_profile_query = enrich_deeper_profile_person_query(query, normalized_query, deep_profile)
    if enriched_profile_query:
        return enriched_profile_query

    if not needs_context_resolution(normalized_query):
        return query

    referenced_name = find_recent_profile_name(history, deep_profile)
    if not referenced_name:
        return query

    return f"{query} {referenced_name}"


def enrich_deeper_profile_person_query(query, normalized_query, deep_profile):
    if not asks_deeper_profile_person_context(normalized_query):
        return None

    matched_names = resolve_profile_person_names(normalized_query, deep_profile)
    if len(matched_names) != 1:
        return None

    name = matched_names[0]
    relation = profile_relation_for_person(name, deep_profile)
    if relation not in ["hijo", "hija"]:
        return None

    normalized_name = normalize_for_match(name)
    if normalized_name == "leandro":
        return (
            f"{query} Leandro Lean Lea Leo ayuda ayudar organizar casa "
            "retirar buscar sentia mal termino cotidiano rutina"
        )

    return f"{query} {name} cotidiano rutina casa escuela colegio familia"


def needs_context_resolution(query):
    triggers = [
        "acerca de el",
        "sobre el",
        "de el",
        "acerca de ella",
        "sobre ella",
        "de ella",
        "acerca de eso",
        "sobre eso",
        "de eso",
        "contame mas",
        "decime mas",
    ]
    return any(trigger in query for trigger in triggers)


def needs_children_memory_resolution(query, history):
    if not recent_history_mentions_children(history):
        return False

    triggers = [
        "ellos",
        "con ellos",
        "sobre ellos",
        "ese tema",
        "este tema",
        "tiempo pasado",
        "haya pasado",
        "que paso",
        "que paso con",
        "pasado",
        "cotidiano",
        "cotidianas",
        "cotidianos",
    ]
    return any(trigger in query for trigger in triggers)


def recent_history_mentions_children(history):
    child_terms = [
        "los chicos",
        "mis chicos",
        "mis hijos",
        "mis hijas",
        "leandro",
        "lean",
        "lea",
        "leo",
        "agustina",
        "agus",
        "bianca",
        "bian",
    ]
    for row in reversed(history[-6:]):
        content = normalize_for_match(row.get("content", ""))
        if any(contains_word(content, term) for term in child_terms):
            return True
    return False


def find_recent_profile_name(history, deep_profile):
    names = profile_known_names(deep_profile)
    if not names:
        return None

    for row in reversed(history[-6:]):
        content = normalize_for_match(row.get("content", ""))
        for name in names:
            if contains_word(content, normalize_for_match(name)):
                return name
    return None


def profile_known_names(deep_profile):
    if not deep_profile:
        return []

    candidates = []
    for relation in deep_profile.get("relationshipMap", {}).get("relationships", []):
        for key in ["subject", "object"]:
            value = str(relation.get(key) or "").strip()
            if is_profile_name_candidate(value):
                candidates.append(value)

    for highlight in deep_profile.get("biography", {}).get("highlights", []):
        text = str(highlight.get("text") or "")
        for match in re.findall(r"\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}\b", text):
            if is_profile_name_candidate(match):
                candidates.append(match)

    return unique_items(candidates)


def resolve_profile_person_names(query, deep_profile):
    entities = build_family_entity_index(deep_profile)
    matched = resolve_family_entity_names(query, entities)
    if matched:
        names_by_normalized = {
            normalize_for_match(entity.get("name", "")): entity.get("name", "")
            for entity in entities
            if entity.get("name")
        }
        return unique_items([names_by_normalized.get(name, name.capitalize()) for name in matched])

    names = profile_known_names(deep_profile)
    return [
        name
        for name in names
        if contains_word(query, normalize_for_match(name))
    ]


def is_profile_name_candidate(value):
    if not value:
        return False
    normalized = normalize_for_match(value)
    blocked = {
        "fabiana",
        "diego",
        "sejas",
        "usar",
        "buenas",
        "quiero",
        "gracias",
        "durante",
        "los",
        "las",
        "mis",
        "tus",
        "sus",
        "tambien",
        "chicos",
        "chicas",
    }
    return len(normalized) > 2 and normalized not in blocked and re.match(r"^[a-z]+$", normalized) is not None


def format_feedback_for_prompt(examples):
    if not examples:
        return "Sin feedback aprobado o corregido todavia."

    rows = []
    for index, example in enumerate(examples[-5:], start=1):
        rating = "corregida por Diego" if example.get("rating") == "corrected" else "aprobada por Diego"
        reason = f" Motivo: {example.get('reason')}." if example.get("reason") else ""
        rows.append(
            f"{index}. Respuesta {rating}.{reason}\n"
            f"Pregunta: {shorten(example.get('query', ''), 180)}\n"
            f"Respuesta modelo: {shorten(example.get('reply', ''), 260)}"
        )
    return "\n".join(rows)


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


def format_deep_profile_for_prompt(profile):
    if not profile:
        return "No hay perfil profundo calculado; usa solo las fuentes recuperadas."

    summary = profile.get("promptSummary")
    if summary:
        return shorten(summary, 1800)

    voice = profile.get("voicebook", {})
    relations = profile.get("relationshipMap", {}).get("relationships", [])
    cues = voice.get("cues") or []
    common_words = [entry.get("value") for entry in voice.get("frequentWords", [])[:12] if entry.get("value")]
    relation_rows = [
        f"{item.get('subject')} -> {item.get('relation')} -> {item.get('object')}"
        for item in relations[:14]
    ]
    parts = []
    if cues:
        parts.append(f"Voz: {', '.join(cues)}.")
    if common_words:
        parts.append(f"Palabras frecuentes: {', '.join(common_words)}.")
    if relation_rows:
        parts.append(f"Relaciones confirmadas: {'; '.join(relation_rows)}.")
    parts.append("Los datos confirmados por Diego son contexto factual, no recuerdos ni estilo literal.")
    return "\n".join(parts)


def format_history_for_prompt(history):
    if not history:
        return "Sin historial reciente."
    labels = {
        "user": "Diego",
        "assistant": "Fabiana"
    }
    return "\n".join(f"{labels.get(row['role'], row['role'])}: {row['content']}" for row in history[-8:])


def summarize_style_profile(profile):
    if not profile:
        return None
    return {
        "schemaVersion": profile.get("schemaVersion"),
        "messageCount": profile.get("messageCount"),
        "sampleCount": profile.get("sampleCount"),
        "dateRange": profile.get("dateRange"),
    }


def summarize_deep_profile(profile):
    if not profile:
        return None
    return {
        "schemaVersion": profile.get("schemaVersion"),
        "sourceCounts": profile.get("sourceCounts"),
        "dateRange": profile.get("dateRange"),
        "relationshipCount": len(profile.get("relationshipMap", {}).get("relationships", [])),
    }


def summarize_feedback_examples(examples):
    if not examples:
        return {
            "exampleCount": 0,
            "approvedCount": 0,
            "correctedCount": 0,
        }
    return {
        "exampleCount": len(examples),
        "approvedCount": sum(1 for example in examples if example.get("rating") == "approved"),
        "correctedCount": sum(1 for example in examples if example.get("rating") == "corrected"),
    }


def assess_answer_quality(reply, generation_mode, retrieval_mode, confidence, sources, validation, intent):
    normalized_reply = normalize_for_match(reply)
    source_types = {source.get("sourceType") for source in sources}
    issues = []
    score = 100

    if confidence == "none":
        issues.append({
            "code": "no_evidence",
            "label": "Sin evidencia clara",
            "severity": "high",
        })
        score -= 45
    elif confidence == "low":
        issues.append({
            "code": "low_confidence",
            "label": "Evidencia debil",
            "severity": "medium",
        })
        score -= 20

    if not sources:
        issues.append({
            "code": "empty_sources",
            "label": "No hay fuentes adjuntas",
            "severity": "high",
        })
        score -= 35

    validation_status = validation.get("summary", {}).get("status")
    if validation_status and validation_status != "ok":
        issues.append({
            "code": "validation_repaired",
            "label": f"Validador: {validation_status}",
            "severity": "medium",
        })
        score -= 15

    if generation_mode.startswith(("ollama:", "anthropic:")) and "conversation_context" not in source_types:
        issues.append({
            "code": "generative_without_episode",
            "label": "Generativa sin episodio conversacional",
            "severity": "medium",
        })
        score -= 12

    report_markers = ["lo ultimo que encuentro", "encontre", "fuentes recuperadas", "segun las fuentes"]
    if any(marker in normalized_reply for marker in report_markers):
        issues.append({
            "code": "report_style",
            "label": "Suena a informe o cita",
            "severity": "medium",
        })
        score -= 18

    grief_markers = ["ya no estoy", "estoy en paz", "siempre estare contigo", "desde donde estoy"]
    if any(marker in normalized_reply for marker in grief_markers):
        issues.append({
            "code": "grief_drift",
            "label": "Se fue a despedida o duelo",
            "severity": "high",
        })
        score -= 30

    if intent.get("kind") in {"person_memory", "children_memory"} and "conversation_context" in source_types:
        score += 4

    score = max(0, min(100, score))
    if score >= 82:
        label = "alta"
    elif score >= 62:
        label = "media"
    else:
        label = "baja"

    return {
        "schemaVersion": 1,
        "score": score,
        "label": label,
        "issues": issues,
        "sourceMix": sorted(source_type for source_type in source_types if source_type),
        "recommendedAction": "approve_or_correct" if score >= 62 else "review_before_trusting",
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
        "nos dijimos",
        "me envie con",
        "me envie",
    ]
    return any(trigger in query for trigger in triggers)


def asks_whatsapp_messages(query):
    triggers = ["whatsapp", "watsapp", "wasap", "por whats", "por wsp"]
    return any(trigger in query for trigger in triggers)


FAMILY_RELATION_TERMS = [
    "hijos",
    "hijas",
    "hijo",
    "hija",
    "hermano",
    "hermana",
    "sobrinos",
    "sobrinas",
    "sobrino",
    "sobrina",
    "primos",
    "primas",
    "primo",
    "prima",
    "tios",
    "tias",
    "tio",
    "tia",
    "abuelos",
    "abuelas",
    "abuelo",
    "abuela",
    "abue",
    "abu",
    "companero",
    "pareja",
    "marido",
    "esposo",
    "perritos",
    "perritas",
    "perrito",
    "perrita",
    "perros",
    "perras",
    "perro",
    "perra",
    "gatitos",
    "gatitas",
    "gatito",
    "gatita",
    "gatos",
    "gatas",
    "gato",
    "gata",
    "mascotas",
    "mascota",
    "mama",
    "papa",
    "madre",
    "padre",
]


FACT_NAME_STOP_WORDS = {
    "hola",
    "fabi",
    "fabiana",
    "die",
    "diego",
    "acordas",
    "acordaste",
    "recordas",
    "recorda",
    "recuerdas",
    "recuerda",
    "acordar",
    "recordar",
    "contame",
    "decime",
    "decir",
    "decirme",
    "algo",
    "acerca",
    "sobre",
    "para",
    "cual",
    "cuales",
    "como",
    "quien",
    "que",
    "de",
    "del",
    "el",
    "la",
    "mi",
    "mis",
    "tus",
    "tu",
    "te",
    "se",
    "llama",
    "llaman",
    "llamaba",
    "llamaban",
    "es",
    "son",
    "tenes",
    "tienes",
    "tiene",
    "tengo",
    "tenia",
    "tenias",
    "tenian",
    "hablame",
    "hablar",
    "hablando",
    "podes",
    "puedes",
    "podrias",
    "decis",
    "sus",
    "fa",
    "los",
    "las",
    "un",
    "una",
    "y",
}


FAMILY_TRANSCRIPTION_ALIASES = {
    "bianca": ["avianca", "vianca", "vian"],
}


def asks_identity_fact(query):
    relation_terms = FAMILY_RELATION_TERMS
    identity_triggers = [
        "se llama",
        "llama",
        "es tu",
        "tu ",
        "tus ",
        "tenes",
        "tenias",
        "tiene",
        "tenia",
        "te acordas de",
        "recordas a",
        "recordas de",
    ]
    return any(contains_word(query, term) for term in relation_terms) and any(trigger in query for trigger in identity_triggers)


def extract_fact_terms(query, family_entities=None):
    relation_terms = FAMILY_RELATION_TERMS
    relations = [term for term in relation_terms if contains_word(query, term)]
    names = resolve_family_entity_names(query, family_entities or [])
    return {
        "names": unique_items(names),
        "relations": unique_items(relations),
    }


def build_family_entity_index(deep_profile):
    if not deep_profile:
        return []

    entities = {}
    for relation in deep_profile.get("relationshipMap", {}).get("relationships", []):
        for key in ["subject", "object"]:
            name = str(relation.get(key) or "").strip()
            if not is_profile_name_candidate(name):
                continue
            normalized = normalize_for_match(name)
            entity = entities.setdefault(normalized, {
                "name": name,
                "aliases": set(),
                "relations": [],
            })
            entity["aliases"].add(normalized)
            entity["aliases"].add(normalized.replace(" ", ""))
            entity["relations"].append({
                "subject": relation.get("subject"),
                "relation": relation.get("relation"),
                "object": relation.get("object"),
            })

    for alias_row in deep_profile.get("familyAliases", []):
        name = str(alias_row.get("name") or "").strip()
        if not is_profile_name_candidate(name):
            continue
        normalized = normalize_for_match(name)
        entity = entities.setdefault(normalized, {
            "name": name,
            "aliases": set(),
            "relations": [],
        })
        entity["aliases"].add(normalized)
        entity["aliases"].add(normalized.replace(" ", ""))
        for alias in alias_row.get("aliases", []):
            normalized_alias = normalize_for_match(alias)
            if normalized_alias:
                entity["aliases"].add(normalized_alias)
                entity["aliases"].add(normalized_alias.replace(" ", ""))
        entity["relations"].append({
            "subject": "Fabiana",
            "relation": alias_row.get("relation"),
            "object": name,
        })

    for normalized_name, aliases in FAMILY_TRANSCRIPTION_ALIASES.items():
        entity = entities.get(normalized_name)
        if not entity:
            continue
        for alias in aliases:
            normalized_alias = normalize_for_match(alias)
            if normalized_alias:
                entity["aliases"].add(normalized_alias)
                entity["aliases"].add(normalized_alias.replace(" ", ""))

    for entity in entities.values():
        entity["aliases"] = sorted(alias for alias in entity["aliases"] if alias)

    return list(entities.values())


def resolve_family_entity_names(query, family_entities):
    if not family_entities:
        return fallback_fact_names(query)

    matched = []
    for entity in family_entities:
        aliases = entity.get("aliases", [])
        if any(alias and contains_word(query, alias) for alias in aliases):
            matched.append(normalize_for_match(entity["name"]))
    return matched


def fallback_fact_names(query):
    stop_words = FACT_NAME_STOP_WORDS | set(FAMILY_RELATION_TERMS)
    tokens = re.findall(r"[a-z0-9]+", query)
    return [
        word
        for word in tokens
        if len(word) > 3 and word not in stop_words
    ]


def relation_matches(relation, text):
    if relation in ["hijo", "hijos"]:
        return contains_any_word(text, ["hijo", "hijos"])
    if relation in ["hija", "hijas"]:
        return contains_any_word(text, ["hija", "hijas"])
    if relation in ["hermano", "hermanos"]:
        return contains_any_word(text, ["hermano", "hermanos"])
    if relation in ["hermana", "hermanas"]:
        return contains_any_word(text, ["hermana", "hermanas"])
    if relation in ["sobrino", "sobrinos"]:
        return contains_any_word(text, ["sobrino", "sobrinos"])
    if relation in ["sobrina", "sobrinas"]:
        return contains_any_word(text, ["sobrina", "sobrinas"])
    if relation in ["primo", "primos"]:
        return contains_any_word(text, ["primo", "primos"])
    if relation in ["prima", "primas"]:
        return contains_any_word(text, ["prima", "primas"])
    if relation in ["tio", "tios"]:
        return contains_any_word(text, ["tio", "tios"])
    if relation in ["tia", "tias"]:
        return contains_any_word(text, ["tia", "tias"])
    if relation in ["abuelo", "abuelos"]:
        return contains_any_word(text, ["abuelo", "abuelos"])
    if relation in ["abuela", "abuelas"]:
        return contains_any_word(text, ["abuela", "abuelas"])
    if relation in ["perrito", "perritos", "perro", "perros"]:
        return contains_any_word(text, ["perrito", "perritos", "perro", "perros"])
    if relation in ["perrita", "perritas", "perra", "perras"]:
        return contains_any_word(text, ["perrita", "perritas", "perra", "perras"])
    if relation in ["gatito", "gatitos", "gato", "gatos"]:
        return contains_any_word(text, ["gatito", "gatitos", "gato", "gatos"])
    if relation in ["gatita", "gatitas", "gata", "gatas"]:
        return contains_any_word(text, ["gatita", "gatitas", "gata", "gatas"])
    if relation in ["mascota", "mascotas"]:
        return contains_any_word(text, ["mascota", "mascotas"])
    return contains_word(text, relation)


def contains_any_word(text, terms):
    return any(contains_word(text, term) for term in terms)


def contains_word(text, term):
    return re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", text) is not None


def display_fact_name(fact_terms):
    return fact_terms["names"][0].capitalize() if fact_terms["names"] else "esa persona"


def display_fact_names(fact_terms):
    names = [name.capitalize() for name in fact_terms["names"] if name]
    if not names:
        return "esa persona"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} y {names[1]}"
    return f"{', '.join(names[:-1])} y {names[-1]}"


def display_fact_relation(fact_terms):
    if not fact_terms["relations"]:
        return "esa relacion"
    relation = fact_terms["relations"][0]
    if relation in ["hijo", "hija"]:
        return f"mi {relation}"
    if relation in ["hijos", "hijas"]:
        return f"mis {relation}"
    if relation in ["sobrino", "sobrina"]:
        return f"mi {relation}"
    if relation in ["sobrinos", "sobrinas"]:
        return f"mis {relation}"
    if relation in ["hermano", "hermana"]:
        return f"mi {relation}"
    if relation in ["hermanos", "hermanas"]:
        return f"mis {relation}"
    if relation in ["primo", "prima", "tio", "tia", "abuelo", "abuela"]:
        return f"mi {relation}"
    if relation in ["primos", "primas", "tios", "tias", "abuelos", "abuelas"]:
        return f"mis {relation}"
    if relation in ["marido", "esposo"]:
        return f"mi {relation}"
    if relation in ["perrito", "perrita", "perro", "perra", "gatito", "gatita", "gato", "gata", "mascota"]:
        return f"mi {relation}"
    if relation in ["perritos", "perritas", "perros", "perras", "gatitos", "gatitas", "gatos", "gatas", "mascotas"]:
        return f"mis {relation}"
    return relation


def unique_items(items):
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


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


def is_dialogue_update(query):
    if is_question_like(query):
        return False

    openers = [
        "te cuento",
        "queria contarte",
        "queria decirte",
        "te queria contar",
        "hoy",
        "manana",
        "ayer",
        "recien",
    ]
    first_person_markers = [
        " voy ",
        " fui ",
        " visite ",
        " hable ",
        " charle ",
        " estuve ",
        " tengo ",
        " me ",
        " estoy ",
        " necesito ",
        " quiero ",
    ]
    padded = f" {query} "
    return any(query.startswith(opener) for opener in openers) and any(marker in padded for marker in first_person_markers)


def is_simple_check_in(query):
    compact = re.sub(r"[^a-z0-9ñ ]+", " ", query)
    compact = re.sub(r"\s+", " ", compact).strip()
    padded = f" {compact} "
    if any(marker in padded for marker in [" te acordas ", " recordas ", " acordas ", " contame ", " decime ", " hablame "]):
        return False
    if any(marker in padded for marker in [" hijo", " hija", " chicos", " estomago", " medico", " problema", " recuerdo"]):
        return False

    check_in_markers = [
        "como estas",
        "como andas",
        "como va",
        "todo bien",
        "estas bien",
        "que haces",
    ]
    if not any(marker in compact for marker in check_in_markers):
        return False

    words = [word for word in compact.split() if word not in ["hola", "buenas", "buen", "dia", "fabi", "fabiana", "fa"]]
    return len(words) <= 5


def is_question_like(query):
    question_starts = [
        "que ",
        "quien ",
        "quienes ",
        "como ",
        "cuando ",
        "donde ",
        "cual ",
        "cuales ",
        "por que ",
        "te acordas",
        "recordas",
        "acordas",
        "tenes ",
        "sabes ",
    ]
    return "?" in query or any(query.startswith(start) for start in question_starts)


def build_dialogue_reply(query, original_query):
    if is_simple_check_in(query):
        return "Hola die, aca estoy, te leo. Y vos, como estas?"

    if any(term in query for term in ["medico", "doctor", "turno", "consulta", "hospital", "clinica"]):
        when = "mañana" if "manana" in query else "hoy" if "hoy" in query else ""
        when_text = f" {when}" if when else ""
        return f"Ay die, ojalá salga todo bien{when_text} en el médico. Después contame cómo te fue, ¿sí?"

    if any(term in query for term in ["triste", "mal", "angustiado", "angustiada", "preocupado", "preocupada"]):
        return "Ay die, venite despacio con eso. Conta conmigo para hablarlo, si?"

    if any(term in query for term in ["contento", "contenta", "feliz", "bien"]):
        return "Ay die, que bueno leerte asi. Me alegra mucho, de verdad."

    clean = clean_source_text(original_query)
    if len(clean) > 0:
        return "Ay die, gracias por contarme. Despues contame bien como siguio todo, si?"

    return "Ay die, contame un poquito mas y te sigo."


def build_preference_reply(query, sources):
    if not asks_preference_question(query):
        return None

    direct_rows = [
        {
            "text": clean_source_text(source.get("text", "")),
            "normalized": normalize_for_match(source.get("text", "")),
            "sourceType": source.get("sourceType"),
        }
        for source in sources
        if source.get("text")
    ]

    has_confirmed_movie_preference = any(
        row["sourceType"] == "user_assertion"
        and "genero favorito" in row["normalized"]
        and "terror" in row["normalized"]
        and "suspenso" in row["normalized"]
        for row in direct_rows
    )

    if "terror" in query:
        if has_confirmed_movie_preference:
            return "Si, die, las de terror si me gustan. Mi genero favorito era terror/suspenso."
        for row in direct_rows:
            normalized = row["normalized"]
            if "suspenso" in normalized and "terror" in normalized and ("soy mas" in normalized or "mas de" in normalized):
                return "Si, die, las de terror si me gustan. Yo iba mas por suspenso y terror."
            if "pelicula" in normalized and "terror" in normalized:
                return "Si, die, las de terror me gustan. Me aparece que hablaba de una de terror para ver."

    if ("genero" in query or "pelicula" in query or "peliculas" in query) and any("terror" in row["normalized"] or "suspenso" in row["normalized"] for row in direct_rows):
        if has_confirmed_movie_preference:
            return "Die, mi genero favorito era terror/suspenso."
        return "Die, yo era mas de suspenso y terror."

    if any(word in query for word in ["gusta", "gustan", "encanta", "encantan"]):
        strong = [
            row["text"]
            for row in direct_rows[:3]
            if any(marker in row["normalized"] for marker in ["me gusta", "me gustan", "me encanta", "me encantan", "soy mas de"])
        ]
        if not strong:
            return "No me aparece una fuente clara para decirte ese gusto con seguridad, die."

    return None


def build_health_context_reply(query, sources, deep_profile):
    if not asks_health_context_question(query) and not asks_self_description(query):
        return None

    rows = [
        {
            "text": clean_source_text(source.get("text", "")),
            "normalized": normalize_for_match(source.get("text", "")),
            "sourceType": source.get("sourceType"),
        }
        for source in sources
        if source.get("text")
    ]
    stomach_rows = [
        row
        for row in rows
        if any(term in row["normalized"] for term in ["estomago", "estomac", "digest", "gases", "acidez", "antiacido", "malestar"])
    ]
    profile_stomach_facts = find_profile_health_facts(deep_profile)
    if profile_stomach_facts:
        stomach_rows.extend(profile_stomach_facts)
    confirmed = any(row["sourceType"] == "user_assertion" for row in stomach_rows)

    if asks_health_context_question(query):
        if stomach_rows:
            if is_correction_about_fabiana(query):
                return "Si, die, tenes razon. Era yo la que venia hablando de problemas del estomago y malestares digestivos."
            if confirmed:
                return "Si, die, venia hablando bastante de mis problemas del estomago y de malestares digestivos."
            return "Si, die, me aparece que venia con temas del estomago y malestares digestivos."
        if is_correction_about_fabiana(query):
            return "Tenes razon, die. Era yo la que venia hablando de problemas del estomago y malestares digestivos."

    if asks_self_description(query) and stomach_rows:
        return (
            "Die, te puedo contar que en el ultimo año venia hablando bastante de mis problemas del estomago "
            "y de malestares digestivos. Tambien estaba muy pendiente de los chicos y de las cosas de todos los dias."
        )

    return None


def asks_health_context_question(query):
    return any(term in query for term in ["estomago", "estomac", "digest", "gases", "acidez", "antiacido", "malestar"])


def asks_self_description(query):
    triggers = ["contame algo de vos", "contame algo sobre vos", "hablame de vos", "hablame sobre vos", "contame de vos", "contame sobre vos", "algo de vos", "algo sobre vos"]
    return any(trigger in query for trigger in triggers)


def is_correction_about_fabiana(query):
    return any(term in query for term in ["sos vos", "eras vos", "vos fabi", "fabi", "fabiana"])


def find_profile_health_facts(deep_profile):
    if not deep_profile:
        return []

    highlights = deep_profile.get("biography", {}).get("highlights", [])
    rows = []
    for highlight in highlights:
        text = clean_source_text(highlight.get("text", ""))
        normalized = normalize_for_match(text)
        if any(term in normalized for term in ["estomago", "estomac", "digest", "gases", "acidez", "antiacido", "malestar"]):
            rows.append({
                "text": text,
                "normalized": normalized,
                "sourceType": "user_assertion",
            })
    return rows


def build_children_context_reply(query, deep_profile):
    if not asks_children_context(query):
        return None

    children = profile_children(deep_profile)
    if not children:
        return None

    if asks_children_care_context(query):
        return (
            "Si, die, los tenia muy presentes a los tres. Estar pendiente de los chicos era eso: "
            "tener a Leandro, Agustina y Bianca en la cabeza, que estuvieran bien y acompañarlos en las cosas de todos los dias."
        )

    details = []
    for child in children:
        age = child.get("age")
        if age:
            details.append(f"{child['name']} tiene {age} años")
        else:
            relation = "hijo" if child["relation"] == "hijo" else "hija"
            details.append(f"{child['name']} es mi {relation}")

    return f"Si, die, cuando digo los chicos hablo de mis hijos: {format_sentence_list(details)}."


def build_children_memory_reply(query, sources, force=False):
    if not force and not asks_children_memory_context(query):
        return None

    rows = find_children_memory_sources(sources)
    if not rows:
        return None

    themes = detect_children_memory_themes(rows)
    if not themes:
        return None

    theme_sentence = format_children_memory_themes(themes)
    if not theme_sentence:
        return None

    return (
        "Si, die. Me aparecen cosas de todos los dias con Leandro, Agustina y Bianca: "
        f"{theme_sentence}. Era bastante de esa rutina, estar atras de los horarios y que estuvieran bien."
    )


def find_children_memory_sources(sources):
    rows = []
    child_terms = [
        "leandro",
        "lean",
        "lea",
        "leo",
        "agustina",
        "agus",
        "bianca",
        "bian",
        "los chicos",
        "chicos",
        "hijos",
        "hijas",
        "escuela",
        "colegio",
        "clase",
        "clases",
        "acto",
        "jura",
        "casa",
        "orden",
        "platos",
        "pieza",
    ]
    for source in sources:
        if source.get("sourceType") == "user_assertion":
            continue
        text = clean_source_text(source.get("text", ""))
        normalized = normalize_for_match(text)
        if any(contains_word(normalized, term) for term in child_terms):
            rows.append({
                "text": text,
                "normalized": normalized,
                "timestamp": source.get("timestamp") or "",
            })
    return rows


def detect_children_memory_themes(rows):
    theme_patterns = [
        ("la escuela, clases o actos", ["escuela", "colegio", "clase", "clases", "acto", "jura", "bandera"]),
        ("llevarlos, buscarlos o acomodar horarios", ["buscar", "buscarlos", "llevar", "llevarlos", "voy con", "venia", "venir", "horario", "tarde"]),
        ("la casa, el orden y las cosas domesticas", ["casa", "orden", "ordenar", "platos", "pieza", "desastre", "ensucia", "limpiar"]),
        ("ver que estuvieran bien y acompaniarlos", ["bien", "fiebre", "gripe", "medico", "dolor", "cuid", "acompan"]),
        ("pequenas idas y vueltas de cada dia", ["vamos", "vengan", "salir", "rato", "cumple", "domingo", "manana", "tarde"]),
    ]
    themes = []
    joined = "\n".join(row["normalized"] for row in rows[:10])
    for label, patterns in theme_patterns:
        if any(pattern in joined for pattern in patterns):
            themes.append(label)
    return themes[:3]


def format_children_memory_themes(themes):
    if not themes:
        return None
    if len(themes) == 1:
        return themes[0]
    if len(themes) == 2:
        return f"{themes[0]} y {themes[1]}"
    return f"{themes[0]}, {themes[1]} y {themes[2]}"


def asks_children_memory_context(query):
    memory_terms = [
        "paso",
        "pasaba",
        "pasado",
        "haya pasado",
        "tiempo pasado",
        "cotidiano",
        "cotidiana",
        "cotidianas",
        "cotidianos",
        "rutina",
        "escuela",
        "colegio",
        "casa",
        "dia",
        "dias",
        "tema",
        "mas detalle",
        "mas sobre",
        "más sobre",
    ]
    return asks_children_context(query) and any(term in query for term in memory_terms)


def asks_children_context(query):
    child_terms = [
        "los chicos",
        "mis chicos",
        "chicos",
        "las chicas",
        "mis hijitos",
        "mis hijos",
        "mis hijas",
    ]
    return any(contains_word(query, term) for term in child_terms)


def asks_children_care_context(query):
    care_terms = ["pendiente", "cuid", "tema", "mas sobre", "más sobre", "dia a dia", "dia a día", "todos los dias", "todos los días"]
    return asks_children_context(query) and any(term in query for term in care_terms)


def build_profile_person_memory_reply(query, sources, deep_profile, force=False):
    if not force and not asks_deeper_profile_person_context(query):
        return None

    matched_names = resolve_profile_person_names(query, deep_profile)
    if len(matched_names) != 1:
        return None

    name = matched_names[0]
    relation = profile_relation_for_person(name, deep_profile)
    if relation not in ["hijo", "hija"]:
        return None

    rows = find_profile_person_memory_sources(name, sources, deep_profile)
    if not rows:
        return None

    normalized_name = normalize_for_match(name)
    if normalized_name == "leandro":
        return build_leandro_memory_reply(rows)

    themes = detect_profile_person_memory_themes(rows)
    if not themes:
        return None

    relation_text = "mi hijo" if relation == "hijo" else "mi hija"
    return f"Si, die. Sobre {name}, {relation_text}, me aparecen cosas de todos los dias: {format_children_memory_themes(themes)}."


def build_leandro_memory_reply(rows):
    normalized_blob = "\n".join(row["normalized"] for row in rows[:8])
    parts = []
    if any(term in normalized_blob for term in ["organizar", "ayud", "asude", "asugar", "mando a el", "lo mando"]):
        parts.append("me organizaba con el para que me diera una mano")
    if "retirar" in normalized_blob and "bianca" in normalized_blob:
        parts.append("si yo me sentia mal, podia pedirle que fuera a buscar a Bianca")
    if any(term in normalized_blob for term in ["termino", "todo el dia", "no esta haciendo nada", "tener aca"]):
        parts.append("lo tenia cerca en casa y contaba con el para esas vueltas")

    if not parts:
        themes = detect_profile_person_memory_themes(rows)
        if not themes:
            return None
        parts = themes

    return (
        "Si, die. De Leandro me acuerdo mas de lo cotidiano: "
        f"{format_children_memory_themes(parts)}. "
        "Lo tengo muy asociado a esa organizacion familiar de todos los dias, ayudando cuando hacia falta."
    )


def find_profile_person_memory_sources(name, sources, deep_profile):
    aliases = profile_aliases_for_name(name, deep_profile)
    rows = []
    for source in sources:
        if source.get("sourceType") == "user_assertion":
            continue
        text = clean_source_text(source.get("text", ""))
        normalized = normalize_for_match(text)
        if any(contains_word(normalized, alias) for alias in aliases):
            rows.append({
                "text": text,
                "normalized": normalized,
                "timestamp": source.get("timestamp") or "",
                "sourceType": source.get("sourceType"),
            })
    return rows


def profile_aliases_for_name(name, deep_profile):
    normalized_name = normalize_for_match(name)
    aliases = {normalized_name}
    for entity in build_family_entity_index(deep_profile):
        if normalize_for_match(entity.get("name", "")) == normalized_name:
            aliases.update(entity.get("aliases", []))
    return sorted(alias for alias in aliases if alias)


def detect_profile_person_memory_themes(rows):
    theme_patterns = [
        ("la escuela o el colegio", ["escuela", "colegio", "clase", "clases", "acto", "jura"]),
        ("ayuda y organizacion en casa", ["ayud", "organizar", "casa", "orden", "termino", "todo el dia"]),
        ("ir, venir o retirar a alguien", ["retirar", "buscar", "llevar", "voy con", "mando"]),
        ("que estuviera bien", ["bien", "fiebre", "gripe", "medico", "dolor", "sentia mal", "cuid"]),
        ("planes familiares y salidas", ["vamos", "vengan", "salir", "cumple", "finde"]),
    ]
    themes = []
    joined = "\n".join(row["normalized"] for row in rows[:10])
    for label, patterns in theme_patterns:
        if any(pattern in joined for pattern in patterns):
            themes.append(label)
    return themes[:3]


def asks_deeper_profile_person_context(query):
    triggers = [
        "contame mas",
        "contame más",
        "mas sobre",
        "más sobre",
        "mas detalle",
        "más detalle",
        "algo mas",
        "algo más",
        "profund",
    ]
    return any(trigger in query for trigger in triggers)


def build_profile_person_reply(query, deep_profile):
    if not asks_profile_person_context(query):
        return None

    facts = find_profile_person_facts(query, deep_profile)
    if not facts:
        return None

    fact = facts[0]
    name = fact["name"]
    text = fact["text"]
    normalized = normalize_for_match(text)
    age = extract_age_from_text(normalized)

    if "hijo de fabiana" in normalized:
        suffix = f" Tiene {age} años." if age else ""
        return f"Si, die, {name} es mi hijo.{suffix}"
    if "hija de fabiana" in normalized:
        suffix = f" Tiene {age} años." if age else ""
        return f"Si, die, {name} es mi hija.{suffix}"
    if "hermano" in normalized and "fabiana" in normalized:
        return f"Si, die, {name} es mi hermano."

    rewritten = rewrite_profile_fact_first_person(text)
    if rewritten:
        return f"Si, die, {rewritten}"

    return None


def build_family_mention_reply(query, deep_profile):
    if not is_family_conversation_statement(query):
        return None

    matched_names = resolve_profile_person_names(query, deep_profile)
    if not matched_names:
        relation_reply = build_family_relation_event_reply(query, deep_profile)
        if relation_reply:
            return relation_reply
        return None

    name = matched_names[0]
    relation = profile_relation_for_person(name, deep_profile)
    if not relation:
        return None

    if any(term in query for term in ["hable", "hablaste", "hablando", "charle", "charlaste", "charlando"]):
        return f"Ay die, que bueno que hayas hablado con {name}. {name} es mi {relation}."

    if is_family_visit_statement(query):
        return f"Ay die, que lindo. {name} es mi {relation}."

    return f"Si, die, {name} es mi {relation}."


def build_family_relation_event_reply(query, deep_profile):
    relations = [
        relation
        for relation in FAMILY_RELATION_TERMS
        if contains_word(query, relation)
    ]
    if not relations:
        return None

    rows = profile_relation_rows(deep_profile, relations)
    if not rows:
        return None

    row = rows[0]
    name = row["name"]
    relation = display_relation_from_profile(row["relation"])
    if is_family_conversation_about_talking(query):
        return f"Ay die, que bueno que hayas hablado con {name}. Es {relation}."
    if is_family_visit_statement(query):
        return f"Ay die, que lindo que hayas visitado a {name}. Es {relation}."

    return None


def is_family_conversation_statement(query):
    triggers = [
        "hable",
        "hablaste",
        "hablando",
        "charle",
        "charlaste",
        "charlando",
        "visite",
        "visitaste",
        "visitar",
        "vi a",
        "viste a",
        "fui a ver",
        "pase a ver",
        "estuve con",
        "me encontre",
        "me cruce",
    ]
    return any(trigger in query for trigger in triggers)


def is_family_conversation_about_talking(query):
    return any(term in query for term in ["hable", "hablaste", "hablando", "charle", "charlaste", "charlando"])


def is_family_visit_statement(query):
    return any(term in query for term in ["visite", "visitaste", "visitar", "vi a", "viste a", "fui a ver", "pase a ver", "estuve con", "me encontre", "me cruce"])


def profile_relation_for_person(name, deep_profile):
    normalized_name = normalize_for_match(name)
    for relation in deep_profile.get("relationshipMap", {}).get("relationships", []):
        subject = normalize_for_match(relation.get("subject", ""))
        relation_name = normalize_for_match(relation.get("relation", ""))
        object_name = normalize_for_match(relation.get("object", ""))
        if subject == "fabiana" and object_name == normalized_name and relation_name in ["hijo", "hija", "hermano", "hermana", "sobrina", "sobrino"]:
            return relation_name

    for alias_row in deep_profile.get("familyAliases", []):
        if normalize_for_match(alias_row.get("name", "")) == normalized_name:
            return normalize_for_match(alias_row.get("relation", ""))

    return None


def build_profile_relation_reply(query, fact_terms, deep_profile):
    if not deep_profile or not fact_terms.get("relations"):
        return None

    relations = fact_terms["relations"]
    if any(relation in relations for relation in ["hijo", "hijos", "hija", "hijas"]):
        children = profile_children(deep_profile)
        if not children:
            return None

        if contains_any_word(query, ["hijo"]) and not contains_any_word(query, ["hijos", "hija", "hijas"]):
            sons = [child for child in children if child["relation"] == "hijo"]
            if len(sons) == 1:
                return format_single_child_reply(sons[0])

        return format_children_reply(children)

    pet_reply = build_pet_relation_reply(deep_profile, relations)
    if pet_reply:
        return pet_reply

    relation_rows = profile_relation_rows(deep_profile, relations)
    if relation_rows:
        return format_relation_rows_reply(relation_rows)

    return None


def build_pet_relation_reply(deep_profile, requested_relations):
    if not any(is_pet_relation(relation) for relation in requested_relations):
        return None

    rows = profile_pet_rows(deep_profile, requested_relations)
    if not rows:
        return None

    perritos = [row["name"] for row in rows if row["kind"] == "perrito"]
    convivientes = [row["name"] for row in rows if row["kind"] == "perro_conviviente"]
    gatitos = [row["name"] for row in rows if row["kind"] == "gatito"]
    parts = []

    if perritos:
        parts.append(f"mis perritos son {format_name_list(perritos)}")
    if convivientes:
        verb = "vivia" if len(convivientes) == 1 else "vivian"
        parts.append(f"{format_name_list(convivientes)} tambien {verb} conmigo")
    if gatitos:
        relation = "mi gatito era" if len(gatitos) == 1 else "mis gatitos eran"
        parts.append(f"{relation} {format_name_list(gatitos)}")

    if not parts:
        return None

    return f"Si, die, {'; '.join(parts)}."


def profile_pet_rows(deep_profile, requested_relations):
    normalized_requests = [normalize_for_match(relation) for relation in requested_relations]
    include_all = any(canonical_profile_relation(relation) == "mascota" for relation in requested_relations)
    include_dogs = include_all or any(canonical_profile_relation(relation) == "perrito" for relation in requested_relations)
    include_conviviente_dogs = include_all or any(relation in ["perro", "perros", "perra", "perras"] for relation in normalized_requests)
    include_cats = include_all or any(canonical_profile_relation(relation) == "gatito" for relation in requested_relations)
    rows = []
    seen = set()

    for relation in deep_profile.get("relationshipMap", {}).get("relationships", []):
        subject = normalize_for_match(relation.get("subject", ""))
        if subject != "fabiana":
            continue

        name = str(relation.get("object") or "").strip()
        kind = pet_kind_from_relation(relation.get("relation"))
        if not name or not kind:
            continue
        if kind in ["perrito", "perro_conviviente"] and not include_dogs:
            continue
        if kind == "perro_conviviente" and not include_conviviente_dogs:
            continue
        if kind == "gatito" and not include_cats:
            continue

        key = (normalize_for_match(name), kind)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"name": name, "kind": kind})

    return rows


def is_pet_relation(relation):
    return canonical_profile_relation(relation) in ["perrito", "gatito", "mascota"]


def pet_kind_from_relation(relation):
    normalized = normalize_for_match(relation or "")
    if "perro que vivia" in normalized:
        return "perro_conviviente"
    canonical = canonical_profile_relation(normalized)
    if canonical in ["perrito", "gatito"]:
        return canonical
    return None


def profile_relation_rows(deep_profile, requested_relations):
    rows = []
    seen = set()

    def add_row(name, relation_name):
        clean_name = str(name or "").strip()
        clean_relation = canonical_profile_relation(relation_name)
        if not clean_name or not clean_relation:
            return
        if not any(relation_matches_request(clean_relation, requested) for requested in requested_relations):
            return
        key = (normalize_for_match(clean_name), clean_relation)
        if key in seen:
            return
        seen.add(key)
        rows.append({
            "name": clean_name,
            "relation": clean_relation,
        })

    for relation in deep_profile.get("relationshipMap", {}).get("relationships", []):
        subject = normalize_for_match(relation.get("subject", ""))
        if subject != "fabiana":
            continue
        add_row(relation.get("object"), relation.get("relation"))

    for relation in profile_biography_relation_rows(deep_profile):
        add_row(relation["name"], relation["relation"])

    return rows


def profile_biography_relation_rows(deep_profile):
    rows = []
    highlights = deep_profile.get("biography", {}).get("highlights", [])
    relation_pattern = r"(marido|esposo|companero|pareja|perrito|perro|gatito|gato)"
    name_pattern = r"([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+)"

    for highlight in highlights:
        text = str(highlight.get("text") or "")
        if not text:
            continue

        for match in re.finditer(rf"\b{name_pattern}\s+es\s+(?:el\s+|la\s+)?{relation_pattern}\s+de\s+Fabiana\b", text, re.IGNORECASE):
            rows.append({
                "name": match.group(1),
                "relation": match.group(2),
            })

        for match in re.finditer(rf"\b(?:el|la)\s+{relation_pattern}\s+de\s+Fabiana\s+se\s+llama(?:ba)?\s+{name_pattern}\b", text, re.IGNORECASE):
            rows.append({
                "name": match.group(2),
                "relation": match.group(1),
            })

    return rows


def canonical_profile_relation(relation):
    relation_name = normalize_for_match(relation)
    aliases = {
        "abu": "abuela",
        "abue": "abuela",
        "companero": "marido",
        "pareja": "marido",
        "esposo": "marido",
        "perritos": "perrito",
        "perritas": "perrito",
        "perros": "perrito",
        "perras": "perrito",
        "perro": "perrito",
        "perra": "perrito",
        "gatitos": "gatito",
        "gatitas": "gatito",
        "gatos": "gatito",
        "gatas": "gatito",
        "gato": "gatito",
        "gata": "gatito",
        "mascotas": "mascota",
    }
    return aliases.get(relation_name, relation_name)


def relation_matches_request(actual, requested):
    actual = canonical_profile_relation(actual)
    requested = canonical_profile_relation(requested)
    groups = [
        {"marido", "esposo", "companero", "pareja"},
        {"perrito", "perritos", "perro", "perros", "mascota", "mascotas"},
        {"gatito", "gatitos", "gato", "gatos", "mascota", "mascotas"},
        {"prima", "primas", "primo", "primos"},
        {"tia", "tias", "tio", "tios"},
        {"abu", "abue", "abuela", "abuelas", "abuelo", "abuelos"},
        {"hermano", "hermanos", "hermana", "hermanas"},
        {"sobrina", "sobrinas", "sobrino", "sobrinos"},
    ]
    if actual == requested:
        return True
    return any(actual in group and requested in group for group in groups)


def format_relation_rows_reply(rows):
    relation = rows[0]["relation"]
    names = format_name_list([row["name"] for row in rows])
    if len(rows) == 1:
        return f"Si, die, {names} es {display_relation_from_profile(relation)}."
    return f"Si, die, {names} son {display_plural_relation_from_profile(relation)}."


def display_relation_from_profile(relation):
    if relation in ["marido", "esposo"]:
        return "mi marido"
    if relation in ["perrito", "perro"]:
        return "mi perrito"
    if relation in ["gatito", "gato"]:
        return "mi gatito"
    if relation in ["prima", "primo", "tia", "tio", "abuela", "abuelo", "hermano", "hermana", "sobrina", "sobrino"]:
        return f"mi {relation}"
    return f"mi {relation}"


def display_plural_relation_from_profile(relation):
    if relation in ["perrito", "perro"]:
        return "mis perritos"
    if relation in ["gatito", "gato"]:
        return "mis gatitos"
    if relation in ["prima", "primo"]:
        return "mis primas" if relation == "prima" else "mis primos"
    if relation in ["tia", "tio"]:
        return "mis tias" if relation == "tia" else "mis tios"
    if relation in ["sobrina", "sobrino"]:
        return "mis sobrinas" if relation == "sobrina" else "mis sobrinos"
    return f"mis {relation}s"


def profile_children(deep_profile):
    children = []
    relations = deep_profile.get("relationshipMap", {}).get("relationships", [])
    for relation in relations:
        subject = normalize_for_match(relation.get("subject", ""))
        relation_name = normalize_for_match(relation.get("relation", ""))
        name = str(relation.get("object") or "").strip()
        if subject == "fabiana" and relation_name in ["hijo", "hija"] and name:
            children.append({
                "name": name,
                "relation": relation_name,
                "age": profile_person_age(name, deep_profile),
            })
    return children


def profile_person_age(name, deep_profile):
    normalized_name = normalize_for_match(name)
    for highlight in deep_profile.get("biography", {}).get("highlights", []):
        text = normalize_for_match(highlight.get("text", ""))
        if contains_word(text, normalized_name):
            age = extract_age_from_text(text)
            if age:
                return age
    return None


def format_single_child_reply(child):
    suffix = f" Tiene {child['age']} años." if child.get("age") else ""
    relation = "hijo" if child["relation"] == "hijo" else "hija"
    return f"Si, die, {child['name']} es mi {relation}.{suffix}"


def format_children_reply(children):
    names = [child["name"] for child in children]
    if not names:
        return None
    return f"Si, die, mis hijos son {format_name_list(names)}."


def format_name_list(names):
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} y {names[1]}"
    return f"{', '.join(names[:-1])} y {names[-1]}"


def format_sentence_list(items):
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} y {items[1]}"
    return f"{', '.join(items[:-1])} y {items[-1]}"


def asks_profile_person_context(query):
    triggers = [
        "acerca de",
        "sobre",
        "contame de",
        "contame algo",
        "decime algo",
        "quien es",
        "quien era",
        "recordas a",
        "te acordas de",
    ]
    return any(trigger in query for trigger in triggers)


def find_profile_person_facts(query, deep_profile):
    if not deep_profile:
        return []

    matched_names = resolve_profile_person_names(query, deep_profile)
    if not matched_names:
        return []

    rows = []
    highlights = deep_profile.get("biography", {}).get("highlights", [])
    for name in matched_names:
        normalized_name = normalize_for_match(name)
        for highlight in highlights:
            text = clean_source_text(highlight.get("text", ""))
            normalized_text = normalize_for_match(text)
            if contains_word(normalized_text, normalized_name):
                rows.append({
                    "name": name,
                    "text": text,
                })

    return rows


def extract_age_from_text(normalized_text):
    match = re.search(r"tiene\s+(\d{1,3})\s+anos", normalized_text)
    return match.group(1) if match else None


def rewrite_profile_fact_first_person(text):
    cleaned = clean_source_text(text).rstrip(".")
    replacements = [
        ("Fabiana tenía", "yo tenia"),
        ("Fabiana tenia", "yo tenia"),
        ("Fabiana tiene", "yo tengo"),
        ("Fabiana era", "yo era"),
        ("Fabiana es", "yo soy"),
        (" de Fabiana", " mio"),
    ]
    for old, new in replacements:
        cleaned = cleaned.replace(old, new)
    if "Fabiana" in cleaned:
        return None
    return cleaned + "."


def asks_preference_question(query):
    triggers = ["gusta", "gustan", "encanta", "encantan", "genero", "pelicula", "peliculas", "terror", "suspenso"]
    return any(trigger in query for trigger in triggers)


def clean_source_text(text):
    return " ".join(text.split())


def corrected_display_source_text(text):
    corrected = str(text or "")
    for alias in FAMILY_TRANSCRIPTION_ALIASES.get("bianca", []):
        corrected = re.sub(rf"(?<![A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]){re.escape(alias)}(?![A-Za-z0-9ÁÉÍÓÚÑáéíóúñ])", "Bianca", corrected, flags=re.IGNORECASE)
    corrected = re.sub(r"\bretirar\s+(?:el|la)\s+Bianca\b", "retirar a Bianca", corrected, flags=re.IGNORECASE)
    corrected = re.sub(r"\bretirar\s+Bianca\b", "retirar a Bianca", corrected, flags=re.IGNORECASE)
    corrected = re.sub(r"\basude\b", "ayude", corrected, flags=re.IGNORECASE)
    corrected = re.sub(r"\basugar\b", "ayudar", corrected, flags=re.IGNORECASE)
    corrected = re.sub(r"\bel pedo\b", "al pedo", corrected, flags=re.IGNORECASE)
    return corrected


def normalize_for_match(text):
    normalized = unicodedata.normalize("NFD", text.lower())
    normalized = "".join(character for character in normalized if unicodedata.category(character) != "Mn")
    return normalize_transcription_aliases(normalized)


def normalize_transcription_aliases(text):
    normalized = text
    for canonical, aliases in FAMILY_TRANSCRIPTION_ALIASES.items():
        for alias in aliases:
            normalized = re.sub(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", canonical, normalized)
    return normalized


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
