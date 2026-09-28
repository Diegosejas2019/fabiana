const form = document.querySelector("#askForm");
const input = document.querySelector("#queryInput");
const askButton = document.querySelector("#askButton");
const messages = document.querySelector("#messages");
const sources = document.querySelector("#sources");
const statusText = document.querySelector("#statusText");
const sourceSummary = document.querySelector("#sourceSummary");
const roleSelect = document.querySelector("#roleSelect");
const sourceSelect = document.querySelector("#sourceSelect");

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
        topK: 8
      })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const answer = await response.json();
    appendAnswer(answer);
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

function appendAnswer(answer) {
  const article = document.createElement("article");
  article.className = "bubble assistant";
  const reply = answer.reply || answer.draft || "No tengo una respuesta suficiente con las fuentes disponibles.";
  const retrieval = answer.retrievalMode ?? "semantic";
  const generation = answer.generationMode ?? "fallback";
  const mode = `Busqueda: ${retrieval} - Respuesta: ${generation}`;
  article.innerHTML = `
    <div class="bubble-meta">Fabiana (sintesis con fuentes)</div>
    <p>${escapeHtml(reply)}</p>
    <div class="bubble-note">${escapeHtml(mode)}</div>
    <span class="confidence ${answer.confidence}">${answer.confidence}</span>
  `;
  messages.append(article);
  article.scrollIntoView({ block: "end" });
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
          <span>${escapeHtml(row.localDate)} - ${escapeHtml(row.sourceType)}</span>
          <span>${row.score.toFixed(3)}</span>
        </div>
        <div class="source-meta">${escapeHtml(row.messageId)} - ${escapeHtml(row.role)}</div>
      </summary>
      <div class="source-body">${escapeHtml(row.text ?? "Texto no incluido.")}</div>
    `;
    sources.append(item);
  }
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
