const form = document.querySelector("#askForm");
const input = document.querySelector("#queryInput");
const askButton = document.querySelector("#askButton");
const messages = document.querySelector("#messages");
const sources = document.querySelector("#sources");
const statusText = document.querySelector("#statusText");
const sourceSummary = document.querySelector("#sourceSummary");
const roleSelect = document.querySelector("#roleSelect");
const sourceSelect = document.querySelector("#sourceSelect");
const entitySummary = document.querySelector("#entitySummary");
const entityCandidates = document.querySelector("#entityCandidates");
const refreshEntitiesButton = document.querySelector("#refreshEntitiesButton");
const answerStore = new Map();
const conversationTurns = [];

refreshEntitiesButton?.addEventListener("click", () => loadFamilyEntities({ rebuild: true }));
loadFamilyEntities();

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
  const style = answer.styleProfile ? ` - Estilo: ${answer.styleProfile.sampleCount} muestras` : "";
  const mode = `Busqueda: ${retrieval} - Respuesta: ${generation}${style}`;
  article.dataset.answerId = answerId;
  article.innerHTML = `
    <div class="bubble-meta">Fabiana</div>
    <p>${escapeHtml(reply)}</p>
    <div class="bubble-note">${escapeHtml(mode)}</div>
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
      styleProfile: answer.styleProfile,
      deepProfile: answer.deepProfile,
      feedbackProfile: answer.feedbackProfile,
      sources: answer.sources ?? []
    })
  });
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
    item.innerHTML = `
      <summary>
        <div class="source-title">
          <span>${escapeHtml(row.localDate)} - ${escapeHtml(displaySourceType(row.sourceType))}</span>
          <span>${row.score.toFixed(3)}</span>
        </div>
        <div class="source-meta">${escapeHtml(row.messageId)} - ${escapeHtml(row.role)}</div>
      </summary>
      <div class="source-body">${escapeHtml(row.text ?? "Texto no incluido.")}</div>
    `;
    sources.append(item);
  }
}

function displaySourceType(sourceType) {
  const labels = {
    user_assertion: "dato personal",
    whatsapp_text: "WhatsApp texto",
    audio_transcript: "WhatsApp audio",
    facebook_text: "Facebook"
  };
  return labels[sourceType] ?? sourceType;
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
