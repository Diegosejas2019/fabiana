const form = document.querySelector("#askForm");
const input = document.querySelector("#queryInput");
const askButton = document.querySelector("#askButton");
const messages = document.querySelector("#messages");
const sources = document.querySelector("#sources");
const statusText = document.querySelector("#statusText");
const sourceSummary = document.querySelector("#sourceSummary");
const modeSelect = document.querySelector("#modeSelect");
const providerSelect = document.querySelector("#providerSelect");
const roleSelect = document.querySelector("#roleSelect");
const sourceSelect = document.querySelector("#sourceSelect");
const profileSummary = document.querySelector("#profileSummary");
const profileContent = document.querySelector("#profileContent");
const refreshProfileButton = document.querySelector("#refreshProfileButton");
const learningSummary = document.querySelector("#learningSummary");
const learningContent = document.querySelector("#learningContent");
const refreshLearningButton = document.querySelector("#refreshLearningButton");
const exportLearningButton = document.querySelector("#exportLearningButton");
const entitySummary = document.querySelector("#entitySummary");
const entityCandidates = document.querySelector("#entityCandidates");
const refreshEntitiesButton = document.querySelector("#refreshEntitiesButton");
const videoSummary = document.querySelector("#videoSummary");
const videoItems = document.querySelector("#videoItems");
const refreshVideosButton = document.querySelector("#refreshVideosButton");
const extractVideosButton = document.querySelector("#extractVideosButton");
const answerStore = new Map();
const conversationTurns = [];

refreshProfileButton?.addEventListener("click", () => loadProfile());
refreshLearningButton?.addEventListener("click", () => loadLearning());
exportLearningButton?.addEventListener("click", () => exportLearning());
refreshEntitiesButton?.addEventListener("click", () => loadFamilyEntities({ rebuild: true }));
refreshVideosButton?.addEventListener("click", () => loadVideos());
extractVideosButton?.addEventListener("click", () => loadVideos({ extract: true }));
loadProfile();
loadLearning();
loadFamilyEntities();
loadVideos();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const query = input.value.trim();
  if (!query) {
    return;
  }

  appendMessage("user", "Vos", query);
  input.value = "";
  setLoading(true);

  try {
    const response = await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        responseMode: modeSelect?.value || "auto",
        llmProvider: providerSelect?.value || "auto",
        role: roleSelect.value || null,
        sourceType: sourceSelect.value || null,
        topK: 8,
        history: conversationTurns.slice(-8)
      })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const answer = await response.json();
    appendAnswer(answer, query);
    rememberTurn("user", query);
    rememberTurn("assistant", answer.reply || answer.draft || "");
    renderSources(answer.sources ?? []);
    sourceSummary.textContent = `${answer.evidenceCount} fuentes - ${answer.confidence} - ${answer.retrievalMode ?? "semantic"}`;
  } catch (error) {
    appendMessage("assistant", "Sistema", "No pude completar la busqueda local.");
    sourceSummary.textContent = "Error";
    console.error(error);
  } finally {
    setLoading(false);
  }
});

function appendAnswer(answer, query) {
  const article = document.createElement("article");
  article.className = "bubble assistant";
  const answerId = crypto.randomUUID();
  answerStore.set(answerId, { ...answer, query });
  const reply = answer.reply || answer.draft || "No tengo una respuesta suficiente con las fuentes disponibles.";
  const retrieval = answer.retrievalMode ?? "semantic";
  const generation = answer.generationMode ?? "fallback";
  const intent = answer.intent?.label ? ` - Intencion: ${answer.intent.label}` : "";
  const style = answer.styleProfile ? ` - Estilo: ${answer.styleProfile.sampleCount} muestras` : "";
  const mode = `Busqueda: ${retrieval} - Respuesta: ${generation}${intent}${style}`;
  const quality = answer.quality ? renderAnswerQuality(answer.quality) : "";
  article.dataset.answerId = answerId;
  article.innerHTML = `
    <div class="bubble-meta">Fabiana</div>
    <p>${escapeHtml(reply)}</p>
    <div class="bubble-note">${escapeHtml(mode)}</div>
    ${quality}
    <div class="bubble-actions">
      <span class="confidence ${answer.confidence}">${answer.confidence}</span>
      <button class="approve-button" type="button" data-approve-id="${answerId}">Confiable</button>
      <button class="reject-button" type="button" data-reject-id="${answerId}">No confiable</button>
      <button class="correct-button" type="button" data-correct-id="${answerId}">Corregir</button>
    </div>
    <form class="feedback-panel" data-feedback-panel="${answerId}" hidden>
      <label>
        Motivo
        <select name="reason">
          <option value="subject_confusion">Confunde quien es quien</option>
          <option value="invented_fact">Inventa datos</option>
          <option value="quote_or_report">Cita o suena a reporte</option>
          <option value="bad_style">No suena natural</option>
          <option value="wrong_memory">Recuerdo incorrecto</option>
          <option value="other">Otro</option>
        </select>
      </label>
      <textarea name="correctedReply" rows="3" placeholder="Escribi como deberia responder mejor"></textarea>
      <div class="feedback-actions">
        <button type="submit">Guardar correccion</button>
        <button type="button" data-cancel-feedback="${answerId}">Cancelar</button>
      </div>
    </form>
  `;
  article.querySelector("[data-approve-id]")?.addEventListener("click", handleApproveAnswer);
  article.querySelector("[data-reject-id]")?.addEventListener("click", handleRejectAnswer);
  article.querySelector("[data-correct-id]")?.addEventListener("click", handleShowCorrection);
  article.querySelector("[data-cancel-feedback]")?.addEventListener("click", handleCancelCorrection);
  article.querySelector("[data-feedback-panel]")?.addEventListener("submit", handleSaveCorrection);
  messages.append(article);
  article.scrollIntoView({ block: "end" });
}

function rememberTurn(role, content) {
  if (!content) {
    return;
  }
  conversationTurns.push({ role, content });
  while (conversationTurns.length > 12) {
    conversationTurns.shift();
  }
}

async function handleApproveAnswer(event) {
  const button = event.currentTarget;
  const answerId = button.dataset.approveId;
  const answer = answerStore.get(answerId);
  if (!answer) {
    return;
  }

  button.disabled = true;
  button.textContent = "Guardando";

  try {
    const response = await sendFeedback(answer, { rating: "approved" });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    button.textContent = "Guardada";
    button.classList.add("approved");
    loadLearning();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Confiable";
    console.error(error);
  }
}

async function handleRejectAnswer(event) {
  const button = event.currentTarget;
  const answerId = button.dataset.rejectId;
  const answer = answerStore.get(answerId);
  if (!answer) {
    return;
  }

  button.disabled = true;
  button.textContent = "Guardando";

  try {
    const response = await sendFeedback(answer, {
      rating: "rejected",
      reason: "not_reliable"
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    button.textContent = "Guardada";
    button.classList.add("rejected");
    loadLearning();
  } catch (error) {
    button.disabled = false;
    button.textContent = "No confiable";
    console.error(error);
  }
}

function handleShowCorrection(event) {
  const answerId = event.currentTarget.dataset.correctId;
  const panel = document.querySelector(`[data-feedback-panel="${answerId}"]`);
  if (panel) {
    panel.hidden = false;
    panel.querySelector("textarea")?.focus();
  }
}

function handleCancelCorrection(event) {
  const answerId = event.currentTarget.dataset.cancelFeedback;
  const panel = document.querySelector(`[data-feedback-panel="${answerId}"]`);
  if (panel) {
    panel.hidden = true;
  }
}

async function handleSaveCorrection(event) {
  event.preventDefault();
  const panel = event.currentTarget;
  const answerId = panel.dataset.feedbackPanel;
  const answer = answerStore.get(answerId);
  if (!answer) {
    return;
  }

  const submit = panel.querySelector("button[type='submit']");
  const formData = new FormData(panel);
  const correctedReply = String(formData.get("correctedReply") ?? "").trim();
  const reason = String(formData.get("reason") ?? "other");

  if (!correctedReply) {
    panel.querySelector("textarea")?.focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = "Guardando";

  try {
    const response = await sendFeedback(answer, {
      rating: "corrected",
      reason,
      correctedReply
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    submit.textContent = "Guardada";
    panel.classList.add("saved");
    loadLearning();
  } catch (error) {
    submit.disabled = false;
    submit.textContent = "Guardar correccion";
    console.error(error);
  }
}

function sendFeedback(answer, feedback) {
  return fetch("/api/feedback/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...feedback,
      query: answer.query,
      reply: answer.reply || answer.draft || "",
      confidence: answer.confidence,
      retrievalMode: answer.retrievalMode,
      generationMode: answer.generationMode,
      validation: answer.validation,
      quality: answer.quality,
      styleProfile: answer.styleProfile,
      deepProfile: answer.deepProfile,
      feedbackProfile: answer.feedbackProfile,
      sources: answer.sources ?? []
    })
  });
}

function renderAnswerQuality(quality) {
  const issues = (quality.issues ?? []).map((issue) => `<span>${escapeHtml(issue.label ?? issue.code)}</span>`).join("");
  return `
    <div class="quality-strip ${escapeHtml(quality.label ?? "media")}">
      <strong>Calidad ${escapeHtml(quality.label ?? "media")} · ${Number(quality.score ?? 0)}/100</strong>
      <div>${issues || "<span>Sin alertas</span>"}</div>
    </div>
  `;
}

function appendMessage(kind, label, text) {
  const article = document.createElement("article");
  article.className = `bubble ${kind}`;
  article.innerHTML = `
    <div class="bubble-meta">${escapeHtml(label)}</div>
    <p>${escapeHtml(text)}</p>
  `;
  messages.append(article);
  article.scrollIntoView({ block: "end" });
}

function renderSources(rows) {
  sources.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "source-meta";
    empty.textContent = "Sin fuentes.";
    sources.append(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("details");
    item.className = "source";
    const audioPlayer = renderSourceAudio(row);
    const episode = renderSourceEpisode(row);
    item.innerHTML = `
      <summary>
        <div class="source-title">
          <span>${escapeHtml(row.localDate)} - ${escapeHtml(displaySourceType(row.sourceType))}</span>
          <span>${row.score.toFixed(3)}</span>
        </div>
        <div class="source-meta">${escapeHtml(row.messageId)} - ${escapeHtml(row.role)}</div>
      </summary>
      <div class="source-body">
        ${episode}
        <div class="source-text">${escapeHtml(row.displayText ?? row.text ?? "Texto no incluido.")}</div>
        ${audioPlayer}
      </div>
    `;
    sources.append(item);
  }
}

function renderSourceEpisode(row) {
  const episode = row.episode;
  if (!episode) {
    return "";
  }

  const themes = (episode.themes ?? []).map((theme) => `<span>${escapeHtml(theme)}</span>`).join("");
  const first = episode.timeRange?.first ?? "";
  const last = episode.timeRange?.last ?? "";
  const time = first && last ? `${first} - ${last}` : "";
  return `
    <div class="episode-meta">
      <strong>Episodio</strong>
      <span>${escapeHtml(time)}</span>
      <span>${Number(episode.messageCount ?? 0)} mensajes</span>
      <div class="episode-themes">${themes}</div>
    </div>
  `;
}

function renderSourceAudio(row) {
  const audioCandidateId = row?.evidence?.audioCandidateId;
  if (row.sourceType !== "audio_transcript" || !audioCandidateId) {
    return "";
  }

  const source = `/api/audio/${encodeURIComponent(audioCandidateId)}`;
  return `
    <div class="source-audio">
      <span>Audio original</span>
      <audio controls preload="none" src="${escapeHtml(source)}"></audio>
    </div>
  `;
}

function displaySourceType(sourceType) {
  const labels = {
    user_assertion: "dato personal",
    conversation_context: "Contexto",
    whatsapp_text: "WhatsApp texto",
    audio_transcript: "WhatsApp audio",
    facebook_text: "Facebook"
  };
  return labels[sourceType] ?? sourceType;
}

async function loadLearning() {
  if (refreshLearningButton) {
    refreshLearningButton.disabled = true;
    refreshLearningButton.textContent = "Cargando";
  }
  if (learningSummary) {
    learningSummary.textContent = "Cargando aprendizaje";
  }

  try {
    const response = await fetch("/api/learning");
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const payload = await response.json();
    renderLearning(payload);
  } catch (error) {
    if (learningSummary) {
      learningSummary.textContent = "No pude cargar aprendizaje";
    }
    console.error(error);
  } finally {
    if (refreshLearningButton) {
      refreshLearningButton.disabled = false;
      refreshLearningButton.textContent = "Cargar";
    }
  }
}

function renderLearning(payload) {
  if (learningSummary) {
    const feedback = payload.feedback ?? {};
    learningSummary.textContent = `${Number(feedback.total ?? 0)} revisiones - ${Number(payload.evaluation?.caseCount ?? 0)} casos`;
  }

  learningContent?.replaceChildren();
  if (!learningContent) {
    return;
  }

  const feedback = payload.feedback ?? {};
  const provider = payload.provider ?? {};
  const evaluation = payload.evaluation ?? {};
  const cards = [
    {
      title: "Feedback",
      body: `${Number(feedback.approved ?? 0)} confiables, ${Number(feedback.corrected ?? 0)} corregidas, ${Number(feedback.rejected ?? 0)} no confiables.`
    },
    {
      title: "Evaluacion",
      body: `${Number(evaluation.caseCount ?? 0)} casos definidos, ${Number(evaluation.outputCount ?? 0)} salidas guardadas.`
    },
    {
      title: "Proveedor",
      body: provider.anthropicConfigured
        ? `Claude API configurado: ${provider.anthropicModel}.`
        : "Claude API no configurado. Para usarlo, falta ANTHROPIC_API_KEY."
    }
  ];

  for (const card of cards) {
    const item = document.createElement("section");
    item.className = "learning-card";
    item.innerHTML = `<h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(card.body)}</p>`;
    learningContent.append(item);
  }

  const recent = document.createElement("section");
  recent.className = "learning-card";
  recent.innerHTML = `
    <h3>Ultimas revisiones</h3>
    ${(feedback.recent ?? []).slice(0, 5).map((row) => `
      <div class="learning-row">
        <strong>${escapeHtml(row.rating ?? "")}</strong>
        <span>${escapeHtml(row.reason ?? row.generationMode ?? "")}</span>
      </div>
    `).join("") || "<p>Sin revisiones todavia.</p>"}
  `;
  learningContent.append(recent);
}

async function exportLearning() {
  if (exportLearningButton) {
    exportLearningButton.disabled = true;
    exportLearningButton.textContent = "Exportando";
  }

  try {
    const response = await fetch("/api/learning/export");
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = `memoria-ai-aprendizaje-${stamp}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error(error);
  } finally {
    if (exportLearningButton) {
      exportLearningButton.disabled = false;
      exportLearningButton.textContent = "Exportar";
    }
  }
}

async function loadProfile() {
  if (refreshProfileButton) {
    refreshProfileButton.disabled = true;
    refreshProfileButton.textContent = "Cargando";
  }
  if (profileSummary) {
    profileSummary.textContent = "Cargando perfil";
  }

  try {
    const response = await fetch("/api/profile");
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const profile = await response.json();
    renderProfile(profile);
  } catch (error) {
    if (profileSummary) {
      profileSummary.textContent = "No pude cargar perfil";
    }
    console.error(error);
  } finally {
    if (refreshProfileButton) {
      refreshProfileButton.disabled = false;
      refreshProfileButton.textContent = "Cargar";
    }
  }
}

function renderProfile(profile) {
  if (profileSummary) {
    const messages = profile.sourceCounts?.personaMessages ?? 0;
    const relationships = Object.values(profile.relationships ?? {}).reduce((total, rows) => total + rows.length, 0);
    profileSummary.textContent = `${messages} mensajes - ${relationships} relaciones`;
  }

  profileContent?.replaceChildren();
  if (!profileContent) {
    return;
  }

  const voice = document.createElement("section");
  voice.className = "profile-card";
  voice.innerHTML = `
    <h3>Voz</h3>
    <p>${escapeHtml((profile.voice?.cues ?? []).join(", ") || "Sin rasgos calculados.")}</p>
    <div class="profile-tags">${(profile.voice?.frequentPhrases ?? []).slice(0, 6).map((item) => `<span>${escapeHtml(item.value ?? item)}</span>`).join("")}</div>
  `;
  profileContent.append(voice);

  const relationGroups = profile.relationships ?? {};
  const family = document.createElement("section");
  family.className = "profile-card";
  family.innerHTML = `
    <h3>Familia y vinculos</h3>
    ${Object.entries(relationGroups).map(([relation, rows]) => `
      <div class="profile-row">
        <strong>${escapeHtml(relation)}</strong>
        <span>${escapeHtml(rows.map((row) => row.name).filter(Boolean).join(", "))}</span>
      </div>
    `).join("")}
  `;
  profileContent.append(family);

  const aliases = document.createElement("section");
  aliases.className = "profile-card";
  aliases.innerHTML = `
    <h3>Alias</h3>
    ${(profile.aliases ?? []).map((row) => `
      <div class="profile-row">
        <strong>${escapeHtml(row.name)}</strong>
        <span>${escapeHtml((row.aliases ?? []).join(", "))}</span>
      </div>
    `).join("") || "<p>Sin alias cargados.</p>"}
  `;
  profileContent.append(aliases);

  const highlights = document.createElement("section");
  highlights.className = "profile-card";
  highlights.innerHTML = `
    <h3>Contexto</h3>
    ${(profile.highlights ?? []).slice(0, 5).map((row) => `<p>${escapeHtml(row.text)}</p>`).join("") || "<p>Sin contexto destacado.</p>"}
  `;
  profileContent.append(highlights);

  const feedback = document.createElement("section");
  feedback.className = "profile-card";
  feedback.innerHTML = `
    <h3>Aprendizaje</h3>
    <p>${Number(profile.feedback?.approved ?? 0)} aprobadas, ${Number(profile.feedback?.corrected ?? 0)} corregidas, ${Number(profile.feedback?.rejected ?? 0)} rechazadas.</p>
  `;
  profileContent.append(feedback);
}

async function loadVideos(options = {}) {
  const extract = Boolean(options.extract);
  if (refreshVideosButton) {
    refreshVideosButton.disabled = true;
  }
  if (extractVideosButton) {
    extractVideosButton.disabled = true;
    extractVideosButton.textContent = extract ? "Extrayendo" : "Extraer";
  }
  if (videoSummary) {
    videoSummary.textContent = extract ? "Extrayendo videos del backup" : "Cargando videos";
  }

  try {
    const response = await fetch(extract ? "/api/videos/extract" : "/api/videos", {
      method: extract ? "POST" : "GET",
      headers: extract ? { "Content-Type": "application/json" } : undefined
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    renderVideos(payload);
  } catch (error) {
    if (videoSummary) {
      videoSummary.textContent = "No pude cargar videos";
    }
    console.error(error);
  } finally {
    if (refreshVideosButton) {
      refreshVideosButton.disabled = false;
    }
    if (extractVideosButton) {
      extractVideosButton.disabled = false;
      extractVideosButton.textContent = "Extraer";
    }
  }
}

function renderVideos(payload) {
  const videos = payload.videos ?? [];
  const summary = payload.summary ?? {};
  if (videoSummary) {
    videoSummary.textContent = `${summary.visible ?? videos.length} visibles - ${summary.extracted ?? 0} extraidos`;
  }

  videoItems?.replaceChildren();
  if (!videoItems) {
    return;
  }

  if (videos.length === 0) {
    const empty = document.createElement("p");
    empty.className = "source-meta";
    empty.textContent = "Sin videos visibles.";
    videoItems.append(empty);
    return;
  }

  for (const video of videos) {
    const item = document.createElement("article");
    item.className = "video-card";
    const player = video.url
      ? `<video controls preload="metadata" src="${escapeHtml(video.url)}"></video>`
      : `<p class="video-missing">No extraido todavia.</p>`;
    item.innerHTML = `
      <div class="video-card-head">
        <div>
          <strong>${escapeHtml(video.localDate ?? "")} ${escapeHtml(video.localTime ?? "")}</strong>
          <span>${escapeHtml(video.filename ?? "")}</span>
        </div>
        <span>${escapeHtml(video.sizeLabel ?? "")}</span>
      </div>
      <div class="entity-meta">${escapeHtml(video.messageId ?? "")} - ${escapeHtml(video.role ?? "")}</div>
      ${player}
      <div class="video-card-actions">
        <button type="button" data-delete-video="${escapeHtml(video.id)}">Eliminar</button>
      </div>
    `;
    item.querySelector("[data-delete-video]")?.addEventListener("click", handleDeleteVideo);
    videoItems.append(item);
  }
}

async function handleDeleteVideo(event) {
  const button = event.currentTarget;
  const videoId = button.dataset.deleteVideo;
  if (!videoId) {
    return;
  }

  const confirmed = window.confirm("Eliminar este video de la biblioteca local? El ZIP original no se modifica.");
  if (!confirmed) {
    return;
  }

  button.disabled = true;
  button.textContent = "Eliminando";

  try {
    const response = await fetch(`/api/video/${encodeURIComponent(videoId)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    await loadVideos();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Eliminar";
    console.error(error);
  }
}

async function loadFamilyEntities(options = {}) {
  const rebuild = Boolean(options.rebuild);
  if (refreshEntitiesButton) {
    refreshEntitiesButton.disabled = true;
    refreshEntitiesButton.textContent = rebuild ? "Analizando" : "Cargando";
  }
  if (entitySummary) {
    entitySummary.textContent = rebuild ? "Analizando backups" : "Cargando candidatos";
  }

  try {
    const response = await fetch(rebuild ? "/api/entities/family/rebuild" : "/api/entities/family", {
      method: rebuild ? "POST" : "GET",
      headers: rebuild ? { "Content-Type": "application/json" } : undefined
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    renderFamilyEntities(payload.review ?? payload);
  } catch (error) {
    if (entitySummary) {
      entitySummary.textContent = "No pude cargar entidades";
    }
    console.error(error);
  } finally {
    if (refreshEntitiesButton) {
      refreshEntitiesButton.disabled = false;
      refreshEntitiesButton.textContent = "Analizar";
    }
  }
}

function renderFamilyEntities(review) {
  const candidates = review.candidates ?? [];
  const pending = candidates.filter((candidate) => candidate.status === "pending");
  const approved = candidates.filter((candidate) => candidate.status === "approved");
  const rejected = candidates.filter((candidate) => candidate.status === "rejected");

  if (entitySummary) {
    entitySummary.textContent = `${pending.length} pendientes - ${approved.length} aprobadas - ${rejected.length} rechazadas`;
  }

  entityCandidates.replaceChildren();
  if (candidates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "source-meta";
    empty.textContent = "Sin candidatos por ahora.";
    entityCandidates.append(empty);
    return;
  }

  for (const candidate of candidates) {
    const card = document.createElement("article");
    card.className = `entity-card ${candidate.status}`;
    card.innerHTML = `
      <div class="entity-card-head">
        <div>
          <strong>${escapeHtml(candidate.object)}</strong>
          <span>${escapeHtml(candidate.relation)} de ${escapeHtml(candidate.subject)}</span>
        </div>
        <span class="entity-score">${Math.round(Number(candidate.confidence ?? 0) * 100)}%</span>
      </div>
      <p>${escapeHtml(candidate.assertionText)}</p>
      <div class="entity-meta">${candidate.evidenceCount ?? 0} evidencias - ${escapeHtml((candidate.sourceTypes ?? []).join(", "))}</div>
      <details>
        <summary>Ver evidencias</summary>
        <div class="entity-evidence">
          ${(candidate.evidence ?? []).map((item) => `
            <div class="entity-evidence-item">
              <div class="entity-meta">${escapeHtml(item.localDate ?? "")} ${escapeHtml(item.localTime ?? "")} - ${escapeHtml(displaySourceType(item.sourceType))}</div>
              <p>${escapeHtml(item.text ?? "")}</p>
            </div>
          `).join("")}
        </div>
      </details>
      <div class="entity-actions">
        ${candidate.status === "pending" ? `
          <button type="button" data-entity-approve="${escapeHtml(candidate.id)}">Aprobar</button>
          <button type="button" data-entity-reject="${escapeHtml(candidate.id)}">Rechazar</button>
        ` : `<span class="entity-status">${escapeHtml(displayEntityStatus(candidate.status))}</span>`}
      </div>
    `;
    card.querySelector("[data-entity-approve]")?.addEventListener("click", () => reviewFamilyEntity(candidate.id, "approved", card));
    card.querySelector("[data-entity-reject]")?.addEventListener("click", () => reviewFamilyEntity(candidate.id, "rejected", card));
    entityCandidates.append(card);
  }
}

async function reviewFamilyEntity(candidateId, action, card) {
  const buttons = card.querySelectorAll("button");
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Guardando";
  });

  try {
    const response = await fetch("/api/entities/family/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, action })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    await loadFamilyEntities();
  } catch (error) {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    console.error(error);
  }
}

function displayEntityStatus(status) {
  const labels = {
    approved: "Aprobada",
    rejected: "Rechazada",
    pending: "Pendiente"
  };
  return labels[status] ?? status;
}

function setLoading(loading) {
  askButton.disabled = loading;
  askButton.textContent = loading ? "Buscando" : "Buscar";
  statusText.textContent = loading ? "Buscando en memoria local" : "Local";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
