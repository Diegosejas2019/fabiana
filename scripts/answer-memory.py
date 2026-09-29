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
    deep_profile = read_optional_deep_profile(args.deep_profile)
    feedback_examples = read_optional_feedback(args.feedback)
    conversation_history = read_optional_history(args.history_json)

    index_dir = Path(args.index_dir)
    manifest = json.loads((index_dir / "embedding-manifest.json").read_text(encoding="utf-8"))
    model_name = args.model or manifest["model"]

    metadata = read_jsonl(index_dir / "embedding-metadata.jsonl")
    chunks_by_id = {chunk["id"]: chunk for chunk in read_jsonl(args.chunks)}

    effective_query = resolve_contextual_query(args.query, conversation_history, deep_profile)
    normalized_query = normalize_for_match(effective_query)
    fact_terms = None

    if asks_recent_messages(normalized_query):
        retrieval_mode = "chronological"
        include_conversation = asks_recent_conversation(normalized_query)
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
    elif asks_identity_fact(normalized_query):
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
    else:
        retrieval_mode = "semantic"
        embeddings = np.load(index_dir / "embeddings.npy")
        model = TextEmbedding(model_name=model_name)
        query_vector = np.array(list(model.query_embed(effective_query))[0], dtype=np.float32)
        scores = cosine_scores(embeddings, query_vector)
        sources = build_semantic_sources(metadata, chunks_by_id, scores, args.top_k, args.role, args.source_type, args.show_text, normalized_query)
        confidence = classify_confidence(sources)
        draft = build_draft(confidence, sources, args.show_text)
        reply, generation_mode = build_persona_reply(
            effective_query,
            confidence,
            sources,
            args.persona_name,
            args.llm_provider,
            args.ollama_model,
            args.ollama_url,
            style_profile,
            deep_profile,
            feedback_examples,
            conversation_history,
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


def build_semantic_sources(metadata, chunks_by_id, scores, top_k, role, source_type, show_text, query):
    candidates = []
    latest_timestamp = latest_parseable_timestamp(metadata)
    query_terms = extract_search_terms(query)
    use_recent_boost = asks_recent_context(query)

    for row, score in zip(metadata, scores):
        if role and row["role"] != role:
            continue
        if source_type and row["sourceType"] != source_type:
            continue

        chunk = chunks_by_id[row["chunkId"]]
        lexical = lexical_match_score(query_terms, normalize_for_match(chunk.get("text", "")))
        recency = recency_match_score(row, latest_timestamp) if use_recent_boost else 0.0
        source_boost = source_type_boost(row, lexical, query)
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

    candidates.sort(
        key=lambda item: (
            item["score"],
            item.get("ranking", {}).get("lexicalBoost", 0),
            item.get("timestamp") or "",
        ),
        reverse=True,
    )
    return candidates[:top_k]


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


def source_type_boost(row, lexical_score, query):
    source_type = row.get("sourceType")
    if source_type == "user_assertion":
        return 0.08 if lexical_score >= 0.08 else -0.04
    if source_type == "audio_transcript" and any(term in query for term in ["audio", "voz", "nota de voz"]):
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
        if prefer_whatsapp and row["sourceType"] not in ["whatsapp_text", "audio_transcript"]:
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


def build_draft(confidence, sources, show_text):
    if confidence == "none":
        return (
            "No encontre recuerdos suficientes para responder basandome en el archivo. "
            "Conviene reformular la pregunta o revisar manualmente las fuentes."
        )

    source_count = len(sources)
    date_span = summarize_dates(sources)

    if confidence == "high":
        opening = "Encontre varias fuentes relacionadas en el archivo."
    else:
        opening = "Encontre algunas fuentes relacionadas, pero la evidencia no es concluyente."

    if show_text:
        return (
            f"{opening} Hay {source_count} fuentes recuperadas ({date_span}). "
            "Usa los textos y evidencias adjuntas para redactar una respuesta final sin agregar recuerdos nuevos."
        )

    return (
        f"{opening} Hay {source_count} fuentes recuperadas ({date_span}). "
        "No incluyo texto privado en consola; revisa el JSON privado o vuelve a correr con --show-text si quieres inspeccionar contenido."
    )


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
    if retrieval_mode == "fact" and has_fact_report_leak(normalized_reply):
        issues.append("fact_report_leak")

    return unique_items(issues)


def build_repair_reply(query, retrieval_mode, confidence, sources, deep_profile, fact_terms, issues):
    if "health_contradiction" in issues or asks_health_context_question(query) or asks_self_description(query):
        health_reply = build_health_context_reply(query, sources, deep_profile)
        if health_reply:
            return health_reply

    if retrieval_mode == "fact" and fact_terms:
        return build_fact_reply(confidence, sources, fact_terms)

    preference_reply = build_preference_reply(query, sources)
    if preference_reply:
        return preference_reply

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


def build_persona_reply(query, confidence, sources, persona_name, llm_provider, ollama_model, ollama_url, style_profile, deep_profile, feedback_examples, conversation_history):
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

    person_reply = build_profile_person_reply(lower_query, deep_profile)
    if person_reply:
        return person_reply, "profile-person-check"

    if llm_provider in ("auto", "ollama") and source_texts:
        generated = build_ollama_reply(query, sources, persona_name, ollama_model, ollama_url, style_profile, deep_profile, feedback_examples, conversation_history)
        if generated:
            return generated, f"ollama:{ollama_model}"

    if asks_for_encouragement(lower_query):
        return build_encouragement_reply(persona_name, top_text, second_text), "fallback"

    if asks_for_last_request(lower_query):
        return build_last_request_reply(dates, top_text), "fallback"

    if asks_memory_question(lower_query):
        return build_memory_reply(top_text, second_text, dates), "fallback"

    return build_general_reply(top_text, second_text, dates), "fallback"


def build_ollama_reply(query, sources, persona_name, model, url, style_profile, deep_profile, feedback_examples, conversation_history):
    prompt_sources = format_sources_for_prompt(sources)
    if not prompt_sources:
        return None

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
        source_type = display_source_type(source.get("sourceType") or "fuente")
        rows.append(f"{index}. {date} ({source_type}): {shorten(text, 520)}")
    return "\n".join(rows)


def display_source_type(source_type):
    labels = {
        "user_assertion": "dato personal confirmado por Diego",
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


def resolve_contextual_query(query, history, deep_profile):
    normalized_query = normalize_for_match(query)
    if not needs_context_resolution(normalized_query):
        return query

    referenced_name = find_recent_profile_name(history, deep_profile)
    if not referenced_name:
        return query

    return f"{query} {referenced_name}"


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


def asks_identity_fact(query):
    relation_terms = FAMILY_RELATION_TERMS
    identity_triggers = ["se llama", "llama", "es tu", "tu ", "tus "]
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
    triggers = ["contame algo de vos", "hablame de vos", "contame de vos", "algo de vos"]
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

    relation_rows = profile_relation_rows(deep_profile, relations)
    if relation_rows:
        return format_relation_rows_reply(relation_rows)

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
        {"abuela", "abuelas", "abuelo", "abuelos"},
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

    names = profile_known_names(deep_profile)
    matched_names = [
        name
        for name in names
        if contains_word(query, normalize_for_match(name))
    ]
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
