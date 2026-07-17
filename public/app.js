const fieldIds = [
  "fileThreshold", "implementationFileThreshold", "planAuditEnabled", "auditScope", "auditHighRisk",
  "auditUnverified", "auditAmbiguity", "auditExplicit", "packetTokens", "responseTokens",
  "normalAuditModel", "highRiskAuditModel", "normalAuditEffort", "highRiskAuditEffort",
  "allowReaudit", "skipNearLimit", "smallModel", "normalModel", "riskModel", "smallEffort",
  "normalEffort", "riskEffort", "xhighPolicy", "postReview"
];

const numericFields = new Set(["fileThreshold", "implementationFileThreshold", "packetTokens", "responseTokens"]);
const checkboxFields = new Set([
  "planAuditEnabled", "auditScope", "auditHighRisk", "auditUnverified", "auditAmbiguity",
  "auditExplicit", "allowReaudit", "skipNearLimit"
]);

const presets = {
  economy: {
    fileThreshold: 6, implementationFileThreshold: 5, packetTokens: 450, responseTokens: 300, normalAuditEffort: "medium",
    highRiskAuditEffort: "high", normalAuditModel: "gpt-5.6-terra", highRiskAuditModel: "gpt-5.6-sol",
    allowReaudit: false, skipNearLimit: true, smallModel: "gpt-5.6-luna", normalModel: "gpt-5.6-terra",
    riskModel: "gpt-5.6-sol", smallEffort: "medium", normalEffort: "medium", riskEffort: "high",
    xhighPolicy: "explicit", postReview: "off"
  },
  balanced: {
    fileThreshold: 4, implementationFileThreshold: 3, packetTokens: 600, responseTokens: 400, normalAuditEffort: "medium",
    highRiskAuditEffort: "high", normalAuditModel: "gpt-5.6-terra", highRiskAuditModel: "gpt-5.6-sol",
    allowReaudit: true, skipNearLimit: true, smallModel: "gpt-5.6-luna", normalModel: "gpt-5.6-terra",
    riskModel: "gpt-5.6-sol", smallEffort: "medium", normalEffort: "high", riskEffort: "high",
    xhighPolicy: "failed-or-explicit", postReview: "risk-only"
  },
  strict: {
    fileThreshold: 3, implementationFileThreshold: 2, packetTokens: 700, responseTokens: 500, normalAuditEffort: "high",
    highRiskAuditEffort: "high", normalAuditModel: "gpt-5.6-sol", highRiskAuditModel: "gpt-5.6-sol",
    allowReaudit: true, skipNearLimit: false, smallModel: "gpt-5.6-terra", normalModel: "gpt-5.6-sol",
    riskModel: "gpt-5.6-sol", smallEffort: "high", normalEffort: "high", riskEffort: "high",
    xhighPolicy: "failed-or-explicit", postReview: "always"
  }
};

const elements = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id)]));
const preview = document.getElementById("preview");
const saveButton = document.getElementById("saveButton");
const restoreButton = document.getElementById("restoreButton");
const managedBadge = document.getElementById("managedBadge");
const saveState = document.getElementById("saveState");
const dirtyDot = document.getElementById("dirtyDot");
const auditControls = document.getElementById("auditControls");
let revision = "";
let dirty = false;
let previewTimer;
let toastTimer;
let installPrompt = null;
let historyLoaded = false;
let historyItems = [];
let historyFilter = "all";
let historyPeriod = "today";
let delegatedTasksBusy = false;
let delegatedPollTimer = null;
let activeCostProfile = "balanced";
let telemetryBusy = false;
let setupLoaded = false;
let setupBusy = false;
let setupPollTimer = null;
let initialViewResolved = false;

function readForm() {
  const config = { version: 2, costProfile: activeCostProfile, subscriptionOnly: true, normalAudits: 1 };
  for (const id of fieldIds) {
    if (checkboxFields.has(id)) config[id] = elements[id].checked;
    else if (numericFields.has(id)) config[id] = Number(elements[id].value);
    else config[id] = elements[id].value.trim();
  }
  return config;
}

function writeForm(config) {
  for (const id of fieldIds) {
    if (config[id] === undefined) continue;
    if (checkboxFields.has(id)) elements[id].checked = Boolean(config[id]);
    else elements[id].value = config[id];
  }
  syncAuditState();
  syncDynamicLabels();
}

function syncAuditState() {
  auditControls.classList.toggle("disabled", !elements.planAuditEnabled.checked);
}

function syncDynamicLabels() {
  document.getElementById("scopeThresholdText").textContent = `${elements.fileThreshold.value}+`;
  document.getElementById("implementationThresholdText").textContent = `${elements.implementationFileThreshold.value}+`;
}

function setDirty(value) {
  dirty = value;
  dirtyDot.classList.toggle("active", value);
  saveState.textContent = value ? "Unsaved routing changes" : "Configuration is in sync";
}

function showToast(message, error = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed: ${response.status}`);
  return result;
}

async function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const result = await api("/api/preview", { method: "POST", body: JSON.stringify({ config: readForm() }) });
      preview.textContent = result.preview;
    } catch (error) {
      preview.textContent = `Configuration error\n\n${error.message}`;
    }
  }, 140);
}

function updatePresetBadge(name = null) {
  activeCostProfile = name || "custom";
  document.querySelectorAll("[data-preset]").forEach((button) => button.classList.toggle("active", button.dataset.preset === name));
  const label = name ? name[0].toUpperCase() + name.slice(1) : "Custom";
  document.getElementById("costBadge").textContent = label;
}

function detectPreset(config) {
  return Object.entries(presets).find(([, values]) => (
    Object.entries(values).every(([key, value]) => config[key] === value)
  ))?.[0] || null;
}

function onFormChange() {
  syncAuditState();
  syncDynamicLabels();
  updatePresetBadge();
  setDirty(true);
  refreshPreview();
}

async function load() {
  try {
    const state = await api("/api/config");
    revision = state.revision;
    writeForm(state.config);
    preview.textContent = state.preview;
    document.getElementById("routingPath").textContent = state.routingPath;
    managedBadge.textContent = state.managed ? "UI managed" : "Existing config";
    managedBadge.classList.toggle("muted", !state.managed);
    restoreButton.disabled = state.backupCount === 0;
    updatePresetBadge(state.config.costProfile || detectPreset(readForm()));
    setDirty(false);
  } catch (error) {
    showToast(error.message, true);
    saveState.textContent = "Could not load configuration";
  }
}

async function save() {
  saveButton.disabled = true;
  try {
    const result = await api("/api/save", {
      method: "POST",
      body: JSON.stringify({ config: readForm(), revision })
    });
    revision = result.revision;
    preview.textContent = result.preview;
    managedBadge.textContent = "UI managed";
    managedBadge.classList.remove("muted");
    restoreButton.disabled = restoreButton.disabled && !result.backupPath;
    setDirty(false);
    showToast(result.backupPath ? "Policy applied · previous version backed up" : "Policy applied");
  } catch (error) {
    showToast(error.message, true);
    if (error.message.includes("Reload")) await load();
  } finally {
    saveButton.disabled = false;
  }
}

async function restore() {
  if (!window.confirm("Restore the latest routing backup? The current file will also be preserved.")) return;
  restoreButton.disabled = true;
  try {
    const result = await api("/api/restore", { method: "POST", body: JSON.stringify({ revision }) });
    revision = result.revision;
    writeForm(result.config);
    updatePresetBadge(result.config.costProfile || detectPreset(readForm()));
    preview.textContent = result.preview;
    managedBadge.textContent = result.managed ? "UI managed" : "Restored manual config";
    managedBadge.classList.toggle("muted", !result.managed);
    setDirty(false);
    showToast("Latest backup restored");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    restoreButton.disabled = false;
  }
}

for (const element of Object.values(elements)) {
  element.addEventListener("input", onFormChange);
  element.addEventListener("change", onFormChange);
}

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    writeForm({ ...readForm(), ...presets[button.dataset.preset] });
    updatePresetBadge(button.dataset.preset);
    setDirty(true);
    refreshPreview();
  });
});

document.querySelectorAll("[data-step]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.target);
    const next = Number(input.value) + Number(button.dataset.step);
    input.value = Math.min(Number(input.max), Math.max(Number(input.min), next));
    onFormChange();
  });
});

document.getElementById("copyButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(preview.textContent);
    showToast("Generated policy copied");
  } catch {
    showToast("Clipboard permission was denied", true);
  }
});

saveButton.addEventListener("click", save);
restoreButton.addEventListener("click", restore);
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) event.preventDefault();
});

const tokenFormatter = new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 });
const exactTokenFormatter = new Intl.NumberFormat("uk-UA");
const dateFormatter = new Intl.DateTimeFormat("uk-UA", { dateStyle: "medium", timeStyle: "short" });
const shortDateFormatter = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", year: "numeric" });

function startOfDay(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, amount) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

function localDateValue(value = new Date()) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function historyDateRange() {
  const today = startOfDay();
  let from = null;
  let to = null;
  let label = "Увесь час";
  if (historyPeriod === "today") {
    from = today;
    to = addDays(today, 1);
    label = "Сьогодні";
  } else if (historyPeriod === "yesterday") {
    from = addDays(today, -1);
    to = today;
    label = "Вчора";
  } else if (historyPeriod === "week") {
    const weekday = today.getDay() || 7;
    from = addDays(today, -(weekday - 1));
    to = addDays(today, 1);
    label = "Цей тиждень";
  } else if (historyPeriod === "month") {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
    to = addDays(today, 1);
    label = "Цей місяць";
  } else if (historyPeriod === "custom") {
    const fromValue = document.getElementById("historyDateFrom").value;
    const toValue = document.getElementById("historyDateTo").value;
    if (!fromValue || !toValue) throw new Error("Оберіть обидві дати для custom-періоду");
    from = startOfDay(new Date(`${fromValue}T00:00:00`));
    const lastDay = startOfDay(new Date(`${toValue}T00:00:00`));
    if (from > lastDay) throw new Error("Дата «Від» має бути не пізніше дати «До»");
    to = addDays(lastDay, 1);
    label = `${shortDateFormatter.format(from)} — ${shortDateFormatter.format(lastDay)}`;
  }
  return {
    from: from?.toISOString() || null,
    to: to?.toISOString() || null,
    label
  };
}

function formatTokens(value) {
  const amount = Number(value) || 0;
  return { compact: tokenFormatter.format(amount), exact: exactTokenFormatter.format(amount) };
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function tokenCell(value, note = "") {
  const formatted = formatTokens(value);
  const cell = makeElement("span", "token-cell", formatted.compact);
  cell.title = `${formatted.exact} tokens${note ? ` · ${note}` : ""}`;
  return cell;
}

function elapsedLabel(value, now = Date.now()) {
  const started = Date.parse(value || "");
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.floor(minutes / 60);
  return `${hours} год ${minutes % 60} хв`;
}

async function copyDelegatedTaskId(id) {
  try {
    await navigator.clipboard.writeText(id);
    showToast(`Task ID copied · ${id}`);
  } catch {
    showToast("Clipboard permission was denied", true);
  }
}

async function cancelDelegatedTask(item, button) {
  const stale = item.status === "stalled";
  const confirmed = window.confirm(stale
    ? `Clear stale task ${item.id}? It will be marked cancelled and removed from the active list. Existing logs will be kept.`
    : `Cancel active task ${item.id}? This will stop its Codex worker and keep existing logs.`);
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = stale ? "Clearing…" : "Cancelling…";
  try {
    const result = await api("/api/delegated-tasks/cancel", {
      method: "POST",
      body: JSON.stringify({ id: item.id })
    });
    renderDelegatedTasks(result.live);
    showToast(stale ? "Stale task cleared" : "Codex task cancelled");
  } catch (error) {
    showToast(`Task control: ${error.message}`, true);
    await loadDelegatedTasks({ quiet: true });
  }
}

async function retryDelegatedTask(item, button) {
  const retryDescription = item.retryMode === "replay"
    ? "Codex will replay its saved request with the original model, effort, and write mode."
    : "Codex will continue the same saved thread with the original model, effort, and write mode.";
  const confirmed = window.confirm(`Retry stale task ${item.id}? The stale run will be cancelled first. ${retryDescription}`);
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = "Retrying…";
  try {
    await api("/api/delegated-tasks/retry", {
      method: "POST",
      body: JSON.stringify({ id: item.id })
    });
    showToast("Codex task retry started");
    window.setTimeout(() => loadDelegatedTasks({ quiet: true }), 500);
  } catch (error) {
    showToast(`Task retry: ${error.message}`, true);
    await loadDelegatedTasks({ quiet: true });
  }
}

function renderDelegatedTasks(snapshot = {}) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const labels = { queued: "У черзі", running: "Виконується", stalled: "Не виконується" };
  const rows = items.map((item) => {
    const row = makeElement("article", `delegated-live-row ${item.status}`);
    const status = makeElement("span", `live-task-status ${item.status}`);
    status.append(makeElement("i", "", ""), makeElement("b", "", labels[item.status] || item.status));

    const task = makeElement("div", "live-task-main");
    const heading = makeElement("div", "live-task-name");
    heading.append(
      makeElement("strong", "", item.title || "Codex task"),
      makeElement("code", "", item.id || "—")
    );
    const route = item.route === "audit" ? "Audit" : "Delegated";
    const details = [item.project, route, item.taskClass, item.model, item.effort, item.write ? "write" : "read-only"].filter(Boolean).join(" · ");
    const detail = makeElement("small", "", details || "Codex companion");
    detail.title = item.workspaceRoot || "Codex companion job state";
    task.append(heading, detail);

    const timing = makeElement("div", "live-task-timing");
    timing.append(
      makeElement("strong", "", elapsedLabel(item.startedAt || item.createdAt)),
      makeElement("small", "", item.startedAt ? `від ${dateFormatter.format(new Date(item.startedAt))}` : "Очікує запуску")
    );

    const actions = makeElement("div", "live-task-actions");
    const copy = makeElement("button", "live-task-button", "Copy ID");
    copy.type = "button";
    copy.addEventListener("click", () => copyDelegatedTaskId(item.id));
    actions.append(copy);
    if (item.canRetry) {
      const retry = makeElement("button", "live-task-button", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => retryDelegatedTask(item, retry));
      actions.prepend(retry);
    }
    if (item.canCancel) {
      const cancel = makeElement("button", "live-task-button danger", item.status === "stalled" ? "Clear stale" : "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => cancelDelegatedTask(item, cancel));
      actions.append(cancel);
    }

    const note = makeElement("p", "live-task-note");
    if (item.status === "stalled") {
      note.textContent = `Companion досі записує ${item.reportedStatus}, але PID${item.pid ? ` ${item.pid}` : ""} вже не існує. Задача фактично не виконується.`;
    } else if (item.status === "queued") {
      note.textContent = "Codex companion створив задачу й очікує запуску worker-процесу.";
    } else {
      note.textContent = `Worker-процес${item.pid ? ` PID ${item.pid}` : ""} активний.`;
    }
    row.append(status, task, timing, actions, note);
    return row;
  });

  document.getElementById("delegatedLiveRows").replaceChildren(...rows);
  document.getElementById("delegatedLiveEmpty").hidden = rows.length > 0;
  const counts = snapshot.counts || {};
  const active = (counts.running || 0) + (counts.queued || 0);
  const stalled = counts.stalled || 0;
  const badge = document.getElementById("delegatedLiveCount");
  badge.textContent = stalled ? `${active} active · ${stalled} stale` : `${active} active`;
  badge.className = `telemetry-status ${stalled ? "stalled" : active ? "active" : "muted"}`;
  document.getElementById("delegatedLiveUpdatedAt").textContent = snapshot.generatedAt
    ? `Live · ${new Intl.DateTimeFormat("uk-UA", { timeStyle: "medium" }).format(new Date(snapshot.generatedAt))}`
    : "—";
}

async function loadDelegatedTasks({ quiet = false } = {}) {
  if (delegatedTasksBusy) return;
  delegatedTasksBusy = true;
  try {
    renderDelegatedTasks(await api("/api/delegated-tasks"));
  } catch (error) {
    if (!quiet) showToast(`Live tasks: ${error.message}`, true);
  } finally {
    delegatedTasksBusy = false;
  }
}

function startDelegatedPolling() {
  clearInterval(delegatedPollTimer);
  loadDelegatedTasks({ quiet: historyLoaded });
  delegatedPollTimer = setInterval(() => {
    if (!document.hidden && !document.getElementById("historyView").hidden) loadDelegatedTasks({ quiet: true });
  }, 3_000);
}

function stopDelegatedPolling() {
  clearInterval(delegatedPollTimer);
  delegatedPollTimer = null;
}

function renderHistory() {
  const rows = document.getElementById("historyRows");
  const visible = historyItems.filter((item) => historyFilter === "all" || item.provider === historyFilter);
  const fragments = visible.map((item) => {
    const row = makeElement("div", "history-row");
    row.dataset.provider = item.provider;

    const task = makeElement("span", "history-task");
    task.append(makeElement("strong", "", item.task));
    const sessionLabel = item.project && item.project !== item.task ? `${item.project} · #${item.sessionId}` : `#${item.sessionId}`;
    const session = makeElement("small", "", sessionLabel);
    session.title = item.cwd || item.source;
    task.append(session);

    const agent = makeElement("span", "history-agent");
    agent.append(makeElement("b", `provider-chip ${item.provider}`, item.provider === "claude" ? "Claude" : "Codex"));
    agent.append(makeElement("strong", "", item.model));
    agent.append(makeElement("small", "", item.effort));

    const cacheNote = item.cacheIsSubset ? "already included in Input and Total" : "added to Total";
    const updated = item.updatedAt ? dateFormatter.format(new Date(item.updatedAt)) : "—";
    row.append(
      task,
      agent,
      tokenCell(item.usage.input),
      tokenCell(item.usage.cached, cacheNote),
      tokenCell(item.usage.output),
      tokenCell(item.usage.total),
      makeElement("span", "history-date", updated)
    );
    return row;
  });
  rows.replaceChildren(...fragments);
  document.getElementById("historyEmpty").hidden = visible.length > 0;
}

function writeHistorySummary(history) {
  for (const provider of ["claude", "codex"]) {
    const totals = history.totals[provider];
    const formatted = formatTokens(totals.tokens);
    const prefix = provider === "claude" ? "claude" : "codex";
    const total = document.getElementById(`${prefix}TokenTotal`);
    total.textContent = formatted.compact;
    total.title = `${formatted.exact} tokens across the displayed sessions`;
    document.getElementById(`${prefix}SessionCount`).textContent = `${totals.sessions} сес. у поточній вибірці`;
  }
  document.getElementById("historyUpdatedAt").textContent = `Оновлено ${dateFormatter.format(new Date(history.generatedAt))}`;
  renderCodexLimits(history.codexLimits);
}

function rateLimitWindowLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "Usage window";
  if (value === 300) return "5 годин";
  if (value === 10_080) return "7 днів";
  if (value % 1_440 === 0) return `${value / 1_440} дн.`;
  if (value % 60 === 0) return `${value / 60} год.`;
  return `${value} хв.`;
}

function formatPercent(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

function renderCodexLimits(snapshot) {
  const rows = document.getElementById("codexLimitWindows");
  const empty = document.getElementById("codexLimitsEmpty");
  const badge = document.getElementById("codexLimitsStatus");
  const updated = document.getElementById("codexLimitsUpdatedAt");
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];

  if (!windows.length) {
    rows.replaceChildren();
    empty.hidden = false;
    badge.textContent = "No snapshot";
    badge.className = "telemetry-status muted";
    updated.textContent = "Відкрийте Codex, щоб оновити";
    return;
  }

  const now = Date.now();
  const normalized = windows.map((window) => {
    const resetsAt = Date.parse(window.resetsAt || "");
    return {
      ...window,
      usedPercent: Math.max(0, Math.min(100, Number(window.usedPercent) || 0)),
      resetsAt,
      expired: Number.isFinite(resetsAt) && resetsAt <= now
    };
  });
  const current = normalized.filter((window) => !window.expired);
  const maxUsed = current.length ? Math.max(...current.map((window) => window.usedPercent)) : 0;
  badge.textContent = current.length ? `${formatPercent(maxUsed)}% max used` : "Snapshot expired";
  badge.className = `telemetry-status ${current.length ? maxUsed >= 90 ? "stalled" : maxUsed >= 75 ? "needs-repair" : "active" : "stalled"}`;

  const observedAt = Date.parse(snapshot.observedAt || "");
  const plan = snapshot.planType ? `${snapshot.planType.charAt(0).toUpperCase()}${snapshot.planType.slice(1)}` : "Codex";
  updated.textContent = Number.isFinite(observedAt)
    ? `${plan} · snapshot ${dateFormatter.format(new Date(observedAt))}`
    : `${plan} · snapshot time unavailable`;

  const fragments = normalized.map((window) => {
    const tone = window.expired ? "expired" : window.usedPercent >= 90 ? "danger" : window.usedPercent >= 75 ? "warn" : "";
    const label = rateLimitWindowLabel(window.windowMinutes);
    const article = makeElement("article", `codex-limit-window ${tone}`.trim());
    const header = makeElement("div", "codex-limit-window-header");
    header.append(
      makeElement("span", "", label),
      makeElement("strong", "", window.expired ? "—" : `${formatPercent(window.usedPercent)}%`)
    );

    const track = makeElement("div", "codex-limit-track");
    const fill = makeElement("i");
    fill.style.width = `${window.expired ? 0 : window.usedPercent}%`;
    track.append(fill);
    if (!window.expired) {
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-label", `${label}: використано ${formatPercent(window.usedPercent)}%`);
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(window.usedPercent));
    }

    const details = makeElement("div", "codex-limit-details");
    const remaining = window.expired
      ? "Snapshot expired"
      : `${formatPercent(100 - window.usedPercent)}% доступно`;
    const reset = Number.isFinite(window.resetsAt)
      ? `${window.expired ? "Reset був" : "Reset"} ${dateFormatter.format(new Date(window.resetsAt))}`
      : "Reset time unavailable";
    details.append(makeElement("span", "", remaining), makeElement("span", "", reset));
    article.append(header, track, details);
    return article;
  });

  rows.replaceChildren(...fragments);
  empty.hidden = true;
}

const routeLabels = {
  "claude-only": "Claude-only",
  delegated: "Delegated",
  audit: "Audit"
};

function renderRoutingHistory(routing = {}) {
  const totals = routing.totals || {};
  document.getElementById("claudeOnlyCount").textContent = totals["claude-only"] || 0;
  document.getElementById("delegatedCount").textContent = totals.delegated || 0;
  document.getElementById("auditCount").textContent = totals.audit || 0;
  document.getElementById("routingDecisionCount").textContent = routing.decisionCount || 0;

  const items = Array.isArray(routing.items) ? routing.items : [];
  const rows = items.map((item) => {
    const row = makeElement("div", "decision-row");
    const route = makeElement("span", "decision-route");
    route.append(makeElement("b", `route-chip ${item.route}`, routeLabels[item.route] || item.route));
    route.append(makeElement("small", "", `#${String(item.sessionId || "—").slice(0, 8)}`));

    const selection = makeElement("span", "decision-selection");
    selection.append(makeElement("strong", "", item.taskClass || (item.route === "claude-only" ? "Current Claude UI" : "—")));
    selection.append(makeElement("small", "", [item.model, item.effort].filter(Boolean).join(" · ") || "Model and effort from active Claude session"));

    const result = makeElement("span", "decision-result");
    result.append(makeElement("strong", "", item.verdict || item.outcome || (item.route === "claude-only" ? "completed" : "started")));
    result.append(makeElement("small", "", item.cwd ? item.cwd.split("/").filter(Boolean).at(-1) : "local"));

    const timestamp = item.timestamp ? dateFormatter.format(new Date(item.timestamp)) : "—";
    row.append(route, selection, result, makeElement("span", "history-date", timestamp));
    return row;
  });
  document.getElementById("routingDecisionRows").replaceChildren(...rows);
  document.getElementById("routingDecisionEmpty").hidden = rows.length > 0;
}

async function loadHistory() {
  const button = document.getElementById("refreshHistoryButton");
  button.disabled = true;
  button.textContent = "Reading…";
  try {
    const range = historyDateRange();
    const params = new URLSearchParams({ limit: "200" });
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    const history = await api(`/api/history?${params}`);
    historyItems = history.items;
    document.getElementById("historyRangeLabel").textContent = range.label;
    writeHistorySummary(history);
    renderRoutingHistory(history.routing);
    renderHistory();
    historyLoaded = true;
  } catch (error) {
    showToast(`History: ${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

function setTelemetryBusy(value) {
  telemetryBusy = value;
  for (const id of ["installTelemetryButton", "repairTelemetryButton", "uninstallTelemetryButton"]) {
    document.getElementById(id).disabled = value;
  }
}

function renderTelemetryStatus(status) {
  const badge = document.getElementById("telemetryStatus");
  const description = document.getElementById("telemetryDescription");
  const install = document.getElementById("installTelemetryButton");
  const repair = document.getElementById("repairTelemetryButton");
  const uninstall = document.getElementById("uninstallTelemetryButton");
  const labels = {
    "not-installed": "Not installed",
    installed: "Installed · awaiting event",
    active: "Active",
    "needs-repair": "Repair needed",
    "blocked-by-organization": "Blocked by organization"
  };

  badge.textContent = labels[status.state] || status.state;
  badge.className = `telemetry-status ${status.state}`;
  document.getElementById("telemetryLoggerPath").textContent = status.loggerPath || "—";
  document.getElementById("telemetryHistoryPath").textContent = status.historyPath || "—";
  install.hidden = status.state !== "not-installed";
  repair.hidden = status.state !== "needs-repair";
  uninstall.hidden = !(status.configured || status.loggerCurrent);

  if (status.state === "active") {
    const gate = status.policyLoadedAt
      ? `Routing policy завантажена Claude ${dateFormatter.format(new Date(status.policyLoadedAt))}.`
      : "Routing gate активний; підтвердження завантаження policy з’явиться після нової Claude-сесії.";
    description.textContent = `Логер працює: ${status.decisionCount} рішень. ${gate} Промпти й код не зберігаються.`;
  } else if (status.state === "installed") {
    description.textContent = "Hooks і per-turn routing gate встановлено. Відкрийте нову задачу в Claude Code — після першого рішення статус стане Active. Промпти й код не зберігаються.";
  } else if (status.state === "needs-repair") {
    description.textContent = "Частина hooks або файл логера відсутні чи застаріли. Reinstall відновить лише logger і routing-gate hooks цього роутера, збереже інші hooks та локальну історію.";
  } else if (status.state === "blocked-by-organization") {
    description.textContent = `Корпоративна політика дозволяє лише managed hooks (${status.organizationRestriction}). Інсталяція можлива, але Claude не запустить цей user hook без дозволу адміністратора.`;
  } else {
    description.textContent = "Фіксує лише тип рішення та додає короткий routing gate до кожного turn. Промпти й код не зберігаються.";
  }
}

async function loadTelemetryStatus() {
  try {
    renderTelemetryStatus(await api("/api/telemetry/status"));
  } catch (error) {
    showToast(`Telemetry: ${error.message}`, true);
  }
}

async function mutateTelemetry(action) {
  if (telemetryBusy) return;
  setTelemetryBusy(true);
  try {
    const status = await api(`/api/telemetry/${action}`, { method: "POST" });
    renderTelemetryStatus(status);
    await loadHistory();
    const message = action === "uninstall"
      ? "Router logger and gate disabled · local history kept"
      : action === "repair"
        ? "Router logger repaired"
        : "Router logger installed";
    showToast(message);
  } catch (error) {
    showToast(`Telemetry: ${error.message}`, true);
  } finally {
    setTelemetryBusy(false);
  }
}

document.getElementById("installTelemetryButton").addEventListener("click", () => mutateTelemetry("install"));
document.getElementById("repairTelemetryButton").addEventListener("click", () => mutateTelemetry("repair"));
document.getElementById("uninstallTelemetryButton").addEventListener("click", () => {
  if (window.confirm("Disable only the router logger and routing-gate hooks? Existing local history, routing policy, Claude, and Codex will be kept.")) {
    mutateTelemetry("uninstall");
  }
});

function setupFact(label, value, tone = "") {
  const fact = makeElement("span", `setup-fact ${tone}`.trim());
  fact.append(makeElement("b", "", label), makeElement("small", "", value || "—"));
  return fact;
}

function writeSetupFacts(id, facts) {
  document.getElementById(id).replaceChildren(...facts);
}

function renderSetupStep(step) {
  const card = document.querySelector(`[data-setup-step="${step.id}"]`);
  if (!card) return;
  card.classList.toggle("ready", step.ready);
  card.classList.toggle("partial", !step.ready && ["partial", "detected", "ready-to-check"].includes(step.state));
  card.classList.toggle("blocked", !step.ready && ["blocked", "signed-out", "missing"].includes(step.state));
  const labels = {
    ready: "Ready",
    verified: "Verified",
    detected: "Detected",
    partial: "Partial",
    missing: "Missing",
    "signed-out": "Sign-in required",
    "ready-to-check": "Ready to check",
    blocked: "Blocked",
    unknown: "Unknown"
  };
  card.querySelector(".setup-step-status").textContent = step.ready ? "Ready" : (labels[step.state] || step.state);
}

function renderSetupWarnings(status) {
  const warnings = [];
  if (status.restrictions.strictKnownMarketplaces !== null) {
    warnings.push(`Corporate marketplace allowlist detected${status.restrictions.strictKnownMarketplaces === 0 ? ": додавання нових marketplace повністю заблоковане" : ": OpenAI marketplace має бути дозволений адміністратором"}.`);
  }
  if (status.restrictions.allowManagedHooksOnly) warnings.push("Corporate policy allows only managed hooks; локальний decision logger потребує дозволу адміністратора.");
  if (!status.subscriptionBoundary.clean) warnings.push(`У Claude settings знайдено billing overrides: ${status.subscriptionBoundary.conflictingSettings.join(", ")}. Router не використовує їх у setup-процесах, але їх слід прибрати для гарантованого subscription-only режиму.`);
  const box = document.getElementById("setupWarnings");
  box.hidden = warnings.length === 0;
  box.replaceChildren(...warnings.map((warning) => makeElement("p", "", warning)));
}

function renderSetupStatus(status) {
  const completed = status.progress.completed;
  const total = status.progress.total;
  document.getElementById("setupProgressText").textContent = status.progress.ready ? "6 / 6 · Ready" : `${completed} / ${total} кроків`;
  document.getElementById("setupProgressBar").style.width = `${Math.round((completed / total) * 100)}%`;
  status.steps.forEach(renderSetupStep);
  renderSetupWarnings(status);

  writeSetupFacts("runtimeFacts", [
    setupFact("Node", status.runtime.node.version || "not available", status.runtime.node.version ? "ok" : "bad"),
    setupFact("npm", status.runtime.npm.version || "not available", status.runtime.npm.version ? "ok" : "bad"),
    setupFact("Git", status.runtime.git.version || "not available", status.runtime.git.version ? "ok" : "warn")
  ]);

  const claudeAuthLabel = status.claude.auth.state === "verified"
    ? `verified · ${status.claude.auth.method}`
    : status.claude.auth.state === "detected"
      ? "existing Desktop session detected"
      : status.claude.auth.state;
  writeSetupFacts("claudeFacts", [
    setupFact("Desktop", status.claude.desktopInstalled ? "installed" : "not found", status.claude.desktopInstalled ? "ok" : "warn"),
    setupFact("CLI", status.claude.version || "not available", status.claude.cliAvailable ? "ok" : "warn"),
    setupFact("Auth", claudeAuthLabel, ["verified", "detected"].includes(status.claude.auth.state) ? "ok" : "bad")
  ]);

  const codexAuthLabel = status.codex.auth.state === "verified" ? `${status.codex.auth.method}${status.codex.auth.subscriptionOnly ? " · subscription" : " · billed API"}` : status.codex.auth.state;
  writeSetupFacts("codexFacts", [
    setupFact("CLI", status.codex.version || "not installed", status.codex.installed ? "ok" : "bad"),
    setupFact("Auth", codexAuthLabel, status.codex.auth.subscriptionOnly ? "ok" : "bad"),
    setupFact("Billing", status.codex.auth.subscriptionOnly ? "subscription boundary confirmed" : "ChatGPT login required", status.codex.auth.subscriptionOnly ? "ok" : "bad")
  ]);

  writeSetupFacts("pluginFacts", [
    setupFact("Marketplace", status.plugin.marketplaceInstalled ? "openai-codex installed" : "missing", status.plugin.marketplaceInstalled ? "ok" : "bad"),
    setupFact("Plugin", status.plugin.installed ? `${status.plugin.version || "installed"}${status.plugin.enabled ? " · enabled" : " · disabled"}` : "missing", status.plugin.installed && status.plugin.enabled ? "ok" : "bad"),
    setupFact("Agent", status.plugin.agentAvailable ? "codex:codex-rescue available" : "missing", status.plugin.agentAvailable ? "ok" : "bad")
  ]);

  writeSetupFacts("configurationFacts", [
    setupFact("Policy", status.configuration.routingInstalled ? "installed" : "missing", status.configuration.routingInstalled ? "ok" : "bad"),
    setupFact("Logger", status.configuration.telemetryState, status.configuration.telemetryReady ? "ok" : "warn"),
    setupFact("Backups", "created before every settings change", "ok")
  ]);

  const check = status.bridge.check;
  writeSetupFacts("bridgeFacts", [
    setupFact("Static bridge", status.bridge.ready ? "all layers connected" : "complete previous steps", status.bridge.ready ? "ok" : "bad"),
    setupFact("Self-check", check?.ready ? `passed · ${dateFormatter.format(new Date(check.checkedAt))}` : "not run", check?.ready ? "ok" : "warn"),
    setupFact("Model call", "optional · Codex tokens only", "warn")
  ]);

  const installClaude = document.getElementById("installClaudeButton");
  const authClaude = document.getElementById("authClaudeButton");
  installClaude.hidden = status.claude.cliAvailable;
  installClaude.textContent = status.claude.installed ? "Install CLI for automation" : "Install official Claude CLI";
  authClaude.hidden = !status.claude.cliAvailable || status.claude.auth.state === "verified";

  document.getElementById("installCodexButton").hidden = status.codex.installed;
  document.getElementById("authCodexButton").hidden = !status.codex.installed || status.codex.auth.subscriptionOnly;
  document.getElementById("authCodexButton").textContent = status.codex.auth.method === "api-key" ? "Switch to ChatGPT login" : "Open ChatGPT login";
  document.getElementById("installPluginButton").hidden = status.plugin.installed && status.plugin.enabled && status.plugin.agentAvailable;
  document.getElementById("installPluginButton").disabled = !status.claude.cliAvailable || !status.codex.auth.subscriptionOnly;
  document.getElementById("applySetupConfigButton").textContent = status.configuration.routingInstalled && status.configuration.telemetryReady ? "Repair configuration" : "Apply configuration";
  document.getElementById("selfCheckButton").disabled = !status.bridge.ready;
  document.getElementById("liveTestButton").disabled = !status.bridge.ready;
  document.getElementById("setupComplete").hidden = !status.progress.ready;
  setupLoaded = true;
}

function setSetupBusy(value, action = "") {
  setupBusy = value;
  document.querySelectorAll("[data-setup-action]").forEach((button) => { button.disabled = value; });
  const refresh = document.getElementById("refreshSetupButton");
  refresh.disabled = value;
  refresh.textContent = value ? (action === "install-plugin" ? "Installing…" : "Working…") : "Recheck";
}

async function loadSetupStatus({ quiet = false } = {}) {
  if (!quiet) {
    document.getElementById("refreshSetupButton").disabled = true;
    document.getElementById("refreshSetupButton").textContent = "Reading…";
  }
  try {
    const status = await api("/api/setup/status");
    renderSetupStatus(status);
    if (!quiet && !initialViewResolved) {
      initialViewResolved = true;
      if (status.progress.ready) showView("routing");
    }
  } catch (error) {
    initialViewResolved = true;
    showToast(`Setup: ${error.message}`, true);
  } finally {
    if (!setupBusy) {
      document.getElementById("refreshSetupButton").disabled = false;
      document.getElementById("refreshSetupButton").textContent = "Recheck";
    }
  }
}

function startSetupPolling() {
  clearInterval(setupPollTimer);
  let remaining = 60;
  setupPollTimer = setInterval(async () => {
    await loadSetupStatus({ quiet: true });
    remaining -= 1;
    if (remaining <= 0) clearInterval(setupPollTimer);
  }, 3000);
}

async function performSetupAction(action) {
  if (setupBusy) return;
  setSetupBusy(true, action);
  try {
    const result = await api("/api/setup/action", { method: "POST", body: JSON.stringify({ action }) });
    if (result.status) renderSetupStatus(result.status);
    if (["install-claude", "auth-claude", "install-codex", "auth-codex"].includes(action)) {
      showToast("Terminal opened · complete the visible step, then return here");
      startSetupPolling();
    } else if (action === "live-test") {
      showToast("Live handshake opened in Terminal · it uses a small Codex turn");
    } else if (action === "self-check") {
      showToast(result.check?.ready ? "Bridge self-check passed without model tokens" : "Self-check finished with a problem", !result.check?.ready);
    } else {
      showToast(action === "install-plugin" ? "Claude → Codex bridge installed" : "Routing and telemetry configured");
    }
  } catch (error) {
    showToast(`Setup: ${error.message}`, true);
  } finally {
    setSetupBusy(false);
    await loadSetupStatus({ quiet: true });
  }
}

document.querySelectorAll("[data-setup-action]").forEach((button) => {
  button.addEventListener("click", () => performSetupAction(button.dataset.setupAction));
});
document.getElementById("refreshSetupButton").addEventListener("click", () => loadSetupStatus());
document.getElementById("continueToRoutingButton").addEventListener("click", () => showView("routing"));

function showView(name) {
  const isSetup = name === "setup";
  const isHistory = name === "history";
  document.getElementById("setupView").hidden = !isSetup;
  document.getElementById("routingView").hidden = isHistory || isSetup;
  document.getElementById("historyView").hidden = !isHistory;
  document.body.classList.toggle("history-mode", isHistory);
  document.body.classList.toggle("setup-mode", isSetup);
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  if (isSetup && !setupLoaded) loadSetupStatus();
  if (isHistory) {
    if (!historyLoaded) Promise.all([loadHistory(), loadTelemetryStatus(), loadDelegatedTasks()]);
    startDelegatedPolling();
  } else {
    stopDelegatedPolling();
  }
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.querySelectorAll("[data-history-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    historyFilter = button.dataset.historyFilter;
    document.querySelectorAll("[data-history-filter]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    renderHistory();
  });
});

const customDateFrom = document.getElementById("historyDateFrom");
const customDateTo = document.getElementById("historyDateTo");
customDateTo.value = localDateValue();
customDateFrom.value = localDateValue(addDays(new Date(), -6));

document.querySelectorAll("[data-history-period]").forEach((button) => {
  button.addEventListener("click", () => {
    historyPeriod = button.dataset.historyPeriod;
    document.querySelectorAll("[data-history-period]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    document.getElementById("customDateRange").hidden = historyPeriod !== "custom";
    if (historyPeriod !== "custom") loadHistory();
  });
});

document.getElementById("applyCustomDateButton").addEventListener("click", loadHistory);
document.getElementById("refreshHistoryButton").addEventListener("click", () => {
  Promise.all([loadHistory(), loadDelegatedTasks(), loadTelemetryStatus()]);
});

const installButton = document.getElementById("installButton");
const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

function markInstalled() {
  installButton.innerHTML = "<span>✓</span> Installed";
  installButton.classList.add("installed");
  installButton.classList.remove("ready");
  installButton.disabled = true;
}

if (standalone) markInstalled();

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.classList.add("ready");
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  markInstalled();
  showToast("Router installed as a desktop app");
});

installButton.addEventListener("click", async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    installPrompt = null;
    installButton.classList.remove("ready");
    if (choice.outcome !== "accepted") showToast("Installation was cancelled");
    return;
  }
  showToast("У Chrome відкрий меню ⋮ → Cast, save and share → Install page as app");
});

if ("serviceWorker" in navigator) {
  installButton.dataset.serviceWorker = "registering";
  navigator.serviceWorker.register("/sw.js?v=20260717-16", { updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      installButton.dataset.serviceWorker = "ready";
      installButton.dataset.serviceWorkerScope = registration.scope;
    })
    .catch(() => {
      installButton.dataset.serviceWorker = "failed";
      showToast("PWA cache could not be enabled", true);
    });
} else {
  installButton.dataset.serviceWorker = "unsupported";
}

load();
loadTelemetryStatus();
loadSetupStatus();
