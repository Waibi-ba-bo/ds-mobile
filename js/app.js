import { renderMarkdown, escapeHtml } from "./markdown.js";

const LS_KEY = "ds-mobile-v1";
const FILE_MODEL = "deepseek-flash";
const MAX_ATTACHMENTS = 6;

const DEFAULT_SETTINGS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  system: "你是一个乐于助人的 AI 助手，请用简体中文回答。",
  context: 20,
  temperature: 1,
  thinking: true,
};

const SUGGESTIONS = [
  ["解释一个概念", "用简单的语言解释一下什么是 API，举一个生活化的例子。"],
  ["帮我写一封邮件", "帮我写一封请假邮件，理由是明天上午需要去医院复查，语气礼貌简洁。"],
  ["总结提炼", "我有一份很长的工作汇报，帮我提炼成 5 条要点，每条不超过 30 字。"],
  ["做个出行计划", "给我一份 3 天的城市周边游行程，节奏轻松，包含吃饭建议。"],
];

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const DOC_EXT = new Set(["pdf", "doc", "docx", "ppt", "pptx"]);
const DATA_EXT = new Set([
  "txt", "md", "csv", "json", "xlsx", "xls", "epub", "mobi",
  "js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "cs", "go", "rs",
  "rb", "php", "sh", "sql", "html", "css", "xml", "yml", "yaml", "log", "ini", "conf",
]);

const $ = (selector) => document.querySelector(selector);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const els = {
  messages: $("#messages"),
  title: $("#chat-title"),
  chip: $("#model-chip"),
  input: $("#input"),
  composer: $("#composer"),
  send: $("#btn-send"),
  stop: $("#btn-stop"),
  attach: $("#btn-attach"),
  thinking: $("#btn-thinking"),
  pending: $("#pending"),
  drawer: $("#drawer"),
  scrim: $("#scrim"),
  convList: $("#conv-list"),
  settings: $("#settings"),
  sheet: $("#attach-sheet"),
  lightbox: $("#lightbox"),
  toast: $("#toast"),
};

let state = loadState();
let pending = [];
let streamingId = null;
let abortRef = null;
let busy = false;
let saveTimer = null;
let renderTimer = null;
let deferredInstall = null;

/* ---------------- storage ---------------- */

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function loadState() {
  const fallback = () => ({
    settings: clone(DEFAULT_SETTINGS),
    conversations: [],
    currentId: null,
  });
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback();
    const parsed = JSON.parse(raw);
    return {
      settings: { ...clone(DEFAULT_SETTINGS), ...(parsed.settings || {}) },
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      currentId: parsed.currentId ?? null,
    };
  } catch {
    return fallback();
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      toast("本地存储空间不足，旧记录可能无法保存");
    }
  }, 200);
}

/* ---------------- helpers ---------------- */

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokens(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function normalizeBase(url) {
  let base = (url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base;
}

function isImageFile(file) {
  const type = file.type || "";
  if (type.startsWith("image/")) return true;
  return !type && IMAGE_EXT.test(file.name || "");
}

function purposeFor(file) {
  if (isImageFile(file)) return "user_data";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  return DOC_EXT.has(ext) ? "text_recognition" : "user_data";
}

function maxBytesFor(purpose, file) {
  if (isImageFile(file)) return 64 * 1024 * 1024;
  if (purpose === "text_recognition") return 100 * 1024 * 1024;
  return 32 * 1024 * 1024;
}

function isSupportedFile(file) {
  const type = file.type || "";
  if (type.startsWith("image/")) return type !== "image/svg+xml";
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!type && IMAGE_EXT.test("." + ext)) return true;
  return DOC_EXT.has(ext) || DATA_EXT.has(ext);
}

/* ---------------- conversation helpers ---------------- */

function currentConversation() {
  return state.conversations.find((c) => c.id === state.currentId) || null;
}

function ensureConversation() {
  let conv = currentConversation();
  if (conv) return conv;
  conv = {
    id: uid(),
    title: "新对话",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.conversations.unshift(conv);
  state.currentId = conv.id;
  return conv;
}

function newChat() {
  if (busy) abortRef?.abort();
  const conv = {
    id: uid(),
    title: "新对话",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.conversations.unshift(conv);
  state.currentId = conv.id;
  save();
  renderAll();
  closeDrawer();
}

function openConversation(id) {
  if (busy) abortRef?.abort();
  state.currentId = id;
  save();
  renderAll();
  closeDrawer();
  scrollToBottom();
}

function deleteConversation(id) {
  if (!confirm("删除这段对话？删除后无法恢复。")) return;
  if (busy && state.currentId === id) abortRef?.abort();
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.currentId === id) {
    state.currentId = state.conversations[0]?.id ?? null;
  }
  save();
  renderAll();
}

/* ---------------- rendering ---------------- */

function renderAll() {
  renderHeader();
  renderConversationList();
  renderMessages();
  renderThinking();
}

function renderHeader() {
  const conv = currentConversation();
  els.title.textContent = conv ? conv.title : "新对话";
  els.chip.textContent = state.settings.model || "deepseek-flash";
}

function renderThinking() {
  els.thinking.setAttribute("aria-pressed", String(Boolean(state.settings.thinking)));
}

function renderConversationList() {
  const items = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  els.convList.innerHTML = items
    .map(
      (conv) => `
      <div class="conv-item ${conv.id === state.currentId ? "active" : ""}" data-conv="${conv.id}">
        <button class="conv-open" type="button" data-open="${conv.id}">${escapeHtml(conv.title || "新对话")}</button>
        <button class="conv-del" type="button" data-del="${conv.id}" aria-label="删除对话">×</button>
      </div>`
    )
    .join("");
  if (!items.length) {
    els.convList.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:10px 12px">还没有对话</p>`;
  }
}

function emptyHtml() {
  const needKey = !state.settings.apiKey;
  const chips = SUGGESTIONS.map(
    ([label, prompt]) =>
      `<button class="suggest" type="button" data-prompt="${escapeHtml(prompt)}">${escapeHtml(label)}</button>`
  ).join("");
  return `
    <div id="empty" class="empty">
      <img class="empty-logo" src="./icons/icon-192.png" alt="" width="76" height="76">
      <h2>有什么可以帮你的？</h2>
      <p class="muted">对话只保存在这台手机上 · 可发图片和文件</p>
      ${
        needKey
          ? `<button class="suggest" type="button" data-action="open-settings" style="grid-column:1/-1;text-align:center">先填写 API Key 开始</button>`
          : `<div class="suggestions">${chips}</div>`
      }
    </div>`;
}

function reasoningHtml(message, streaming) {
  const streamingReasoning = streaming && !message.content;
  const seconds = Math.max(1, Math.round(message.reasoningSeconds || 0));
  let label;
  if (streamingReasoning) label = "深度思考中…";
  else if (seconds) label = `已深度思考（用时 ${seconds} 秒）`;
  else label = "已深度思考";

  const open = streamingReasoning ? " open" : "";
  const cls = streamingReasoning ? " reasoning streaming" : " reasoning";
  return `<details class="${cls}"${open}>
      <summary>${label}</summary>
      <div class="reasoning-body">${renderMarkdown(message.reasoning)}</div>
    </details>`;
}

function assistantBodyHtml(message, streaming) {
  let html = "";

  if (message.reasoning) html += reasoningHtml(message, streaming);
  if (message.content) html += renderMarkdown(message.content);

  if (message.error) {
    html += `<div class="error-box">${escapeHtml(message.error)}<br>
      <button class="retry" type="button" data-action="regen">重试</button>
      <button class="retry" type="button" data-action="open-settings">打开设置</button>
    </div>`;
  } else if (streaming) {
    if (message.content) html += `<span class="cursor"></span>`;
    else if (!message.reasoning) html += `<span class="thinking"><i></i><i></i><i></i></span>`;
  } else if (message.stopped && !message.content) {
    html += `<div class="msg-meta">已停止生成</div>`;
  }

  return html;
}

function userMessageHtml(message) {
  const attachments = message.attachments || [];
  const images = attachments.filter((a) => a.kind === "image" && a.preview);
  const files = attachments.filter((a) => a.kind !== "image" || !a.preview);

  const imagesHtml = images.length
    ? `<div class="msg-images">${images
        .map(
          (a) =>
            `<img class="msg-image" src="${a.preview}" alt="${escapeHtml(a.name)}" data-image="${a.id}">`
        )
        .join("")}</div>`
    : "";

  const filesHtml = files.length
    ? `<div class="msg-files">${files
        .map(
          (a) =>
            `<div class="file-chip"><span class="file-ico">📄</span><span class="file-name">${escapeHtml(
              a.name
            )}</span><span class="file-size">${formatSize(a.size)}</span></div>`
        )
        .join("")}</div>`
    : "";

  const bubble = message.content ? `<div class="bubble">${escapeHtml(message.content)}</div>` : "";

  return `<div class="msg user" data-id="${message.id}"><div class="user-stack">${imagesHtml}${filesHtml}${bubble}</div></div>`;
}

function messageHtml(message, conv, streaming) {
  if (message.role === "user") return userMessageHtml(message);

  const isLast = conv.messages[conv.messages.length - 1]?.id === message.id;
  const actions =
    !streaming && message.content && !message.error
      ? `<div class="msg-actions">
           <button class="msg-action" type="button" data-action="copy" data-id="${message.id}">复制</button>
           ${isLast ? '<button class="msg-action" type="button" data-action="regen">重新生成</button>' : ""}
         </div>`
      : "";

  const usage =
    message.usage &&
    Number.isFinite(message.usage.prompt_tokens) &&
    Number.isFinite(message.usage.completion_tokens)
      ? `<div class="msg-meta">输入 ${formatTokens(message.usage.prompt_tokens)} · 输出 ${formatTokens(
          message.usage.completion_tokens
        )} tokens</div>`
      : "";

  return `<div class="msg assistant" data-id="${message.id}">
      <div class="assistant-body">${assistantBodyHtml(message, streaming)}</div>
      ${actions}
      ${usage}
    </div>`;
}

function renderMessages() {
  const conv = currentConversation();
  const el = els.messages;
  const prevTop = el.scrollTop;
  const nearBottom = isNearBottom();

  if (!conv || !conv.messages.length) {
    el.innerHTML = emptyHtml();
    return;
  }

  el.innerHTML = `<div class="messages-inner">${conv.messages
    .map((m) => messageHtml(m, conv, m.id === streamingId))
    .join("")}</div>`;

  if (el.scrollHeight > el.clientHeight) {
    el.scrollTop = nearBottom ? el.scrollHeight : prevTop;
  }
}

function updateStreamingMessage(message) {
  const body = els.messages.querySelector(`.msg[data-id="${message.id}"] .assistant-body`);
  if (!body) return;
  const nearBottom = isNearBottom();
  body.innerHTML = assistantBodyHtml(message, true);
  if (nearBottom) scrollToBottom();
}

function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 160;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

/* ---------------- attachments ---------------- */

function renderPending() {
  if (!pending.length) {
    els.pending.hidden = true;
    els.pending.innerHTML = "";
    return;
  }
  els.pending.hidden = false;
  els.pending.innerHTML = pending
    .map((item) => {
      const thumb =
        item.kind === "image" && item.preview
          ? `<img class="pending-thumb" src="${item.preview}" alt="">`
          : `<div class="pending-file"><span class="name">${escapeHtml(
              item.name
            )}</span><span class="size">${item.status === "uploading" ? "上传中…" : formatSize(item.size)}</span></div>`;
      const mask = item.status === "uploading" ? `<div class="pending-mask"></div>` : "";
      const error = item.status === "failed" ? `<span class="pending-error">上传失败</span>` : "";
      return `<div class="pending-item ${item.status}" data-id="${item.id}">
        ${thumb}${mask}
        <button class="pending-remove" type="button" data-remove="${item.id}" aria-label="移除">×</button>
        ${error}
      </div>`;
    })
    .join("");
}

function removePending(id) {
  pending = pending.filter((item) => item.id !== id);
  renderPending();
  updateSendState();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };
    img.src = url;
  });
}

async function compressImage(file) {
  if (file.type === "image/gif" || /\.gif$/i.test(file.name || "")) return file;
  try {
    const img = await loadImage(file);
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024 && file.type === "image/jpeg") return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function makePreview(file) {
  try {
    const img = await loadImage(file);
    const max = 480;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return "";
  }
}

async function uploadToDeepSeek(file, purpose) {
  if (!state.settings.apiKey) throw new Error("请先填写 API Key");
  const base = normalizeBase(state.settings.baseUrl);
  const form = new FormData();
  form.append("purpose", purpose); // 必须在 file 之前
  form.append("file", file, file.name || "file");

  const response = await fetch(`${base}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${state.settings.apiKey}` },
    body: form,
  });

  if (!response.ok) throw new Error(await readError(response));
  const data = await response.json();
  if (!data || !data.id) throw new Error("上传失败：接口没有返回文件 ID");
  return data.id;
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (!state.settings.apiKey) {
    openSettings("先填写 API Key 才能上传图片或文件");
    return;
  }

  for (const file of files) {
    if (pending.length >= MAX_ATTACHMENTS) {
      toast(`一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
      break;
    }
    if (!isSupportedFile(file)) {
      toast(`暂不支持「${file.name}」这种格式`);
      continue;
    }

    const kind = isImageFile(file) ? "image" : "file";
    const item = {
      id: uid(),
      kind,
      name: file.name || (kind === "image" ? "图片" : "文件"),
      size: file.size,
      mime: file.type || "",
      status: "uploading",
      preview: "",
    };
    pending.push(item);
    renderPending();
    updateSendState();

    try {
      let upload = file;
      if (kind === "image") {
        upload = await compressImage(file);
        item.preview = await makePreview(upload);
      }
      const purpose = purposeFor(upload);
      if (upload.size > maxBytesFor(purpose, upload)) throw new Error("文件太大，超出接口限制");
      item.fileId = await uploadToDeepSeek(upload, purpose);
      item.size = upload.size;
      item.status = "ready";
    } catch (error) {
      item.status = "failed";
      item.error = error.message || "上传失败";
      toast(`「${item.name}」上传失败：${item.error}`);
    }
    renderPending();
    updateSendState();
  }
}

/* ---------------- streaming ---------------- */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readError(response) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message || json?.message || "";
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    /* ignore */
  }

  const status = response.status;
  if (status === 401) return "API Key 无效或已过期，请到设置里检查。";
  if (status === 402) return "账户余额不足，请到 DeepSeek 开放平台充值后再试。";
  if (status === 413) return "文件太大，超过了接口限制。";
  if (status === 408) return "上传超时，请换个小一点的文件或重试。";
  if (status === 429) return "请求太频繁了，稍等一会儿再试。";
  if (status === 504) return "文档解析超时，请重试或换一份文件。";
  if (status >= 500) return `DeepSeek 服务暂时不可用（${status}），稍后再试。`;
  return `请求失败（${status}）${detail ? "：" + detail : ""}`;
}

function apiContent(message) {
  const files = (message.attachments || []).filter((a) => a.fileId);
  if (!files.length) return message.content || "";
  const blocks = [];
  for (const file of files) blocks.push({ type: "file", file_id: file.fileId });
  if (message.content) blocks.push({ type: "text", text: message.content });
  return blocks;
}

function buildPayload(conv, assistantId) {
  const { system, context, model, thinking, temperature } = state.settings;
  const history = conv.messages.filter(
    (m) => m.id !== assistantId && (m.role === "user" || m.content)
  );
  const trimmed = history.slice(-Math.max(2, Number(context) || 20));

  const messages = [];
  if (system && system.trim()) messages.push({ role: "system", content: system.trim() });
  for (const m of trimmed) {
    messages.push({
      role: m.role,
      content: m.role === "user" ? apiContent(m) : m.content || "",
    });
  }

  const payload = { model: model || "deepseek-flash", messages, stream: true };
  if (/^deepseek/i.test(payload.model)) {
    payload.thinking = { type: thinking ? "enabled" : "disabled" };
  }
  if (!thinking) {
    const temp = Number(temperature);
    if (Number.isFinite(temp)) payload.temperature = Math.min(2, Math.max(0, temp));
  }
  return payload;
}

function handleSseChunk(raw, assistant) {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.usage) assistant.usage = json.usage;
    if (json.error) throw new ApiError(json.error.message || "服务返回了错误", 0);

    const delta = json.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.reasoning_content) {
      if (!assistant.reasoningStartedAt) assistant.reasoningStartedAt = Date.now();
      assistant.reasoning += delta.reasoning_content;
    }
    if (delta.content) {
      if (assistant.reasoningStartedAt && !assistant.reasoningSeconds) {
        assistant.reasoningSeconds = (Date.now() - assistant.reasoningStartedAt) / 1000;
      }
      assistant.content += delta.content;
    }
  }
}

function scheduleStreamRender(assistant) {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    updateStreamingMessage(assistant);
  }, 60);
}

async function runCompletion(conv, assistant, signal) {
  const base = normalizeBase(state.settings.baseUrl);
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.settings.apiKey}`,
    },
    body: JSON.stringify(buildPayload(conv, assistant.id)),
    signal,
  });

  if (!response.ok) throw new ApiError(await readError(response), response.status);

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    throw new ApiError("接口没有返回流式响应，请检查接口地址是否正确。", 0);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      handleSseChunk(buffer.slice(0, cut), assistant);
      buffer = buffer.slice(cut + 2);
      scheduleStreamRender(assistant);
    }
  }
  if (buffer.trim()) handleSseChunk(buffer, assistant);
  scheduleStreamRender(assistant);
}

async function startStream(conv) {
  if (busy) return;
  const assistant = {
    id: uid(),
    role: "assistant",
    content: "",
    reasoning: "",
    thinking: Boolean(state.settings.thinking),
    reasoningStartedAt: 0,
    reasoningSeconds: 0,
    usage: null,
    ts: Date.now(),
  };
  conv.messages.push(assistant);
  conv.updatedAt = Date.now();
  streamingId = assistant.id;
  busy = true;
  setBusyUi(true);
  renderMessages();
  scrollToBottom();

  const controller = new AbortController();
  abortRef = controller;

  try {
    await runCompletion(conv, assistant, controller.signal);
  } catch (error) {
    if (error.name === "AbortError") {
      assistant.stopped = true;
    } else if (error instanceof ApiError) {
      assistant.error = error.message;
    } else {
      assistant.error =
        "网络请求失败：可能是手机网络不稳定、接口地址不正确，或浏览器拦截了请求。";
    }
  } finally {
    clearTimeout(renderTimer);
    renderTimer = null;

    if (assistant.reasoningStartedAt && !assistant.reasoningSeconds) {
      assistant.reasoningSeconds = (Date.now() - assistant.reasoningStartedAt) / 1000;
    }
    if (!assistant.content && !assistant.reasoning && !assistant.error) {
      const index = conv.messages.findIndex((m) => m.id === assistant.id);
      if (index !== -1) conv.messages.splice(index, 1);
    }

    conv.updatedAt = Date.now();
    streamingId = null;
    busy = false;
    abortRef = null;
    setBusyUi(false);
    save();
    renderAll();
    if (assistant.error) scrollToBottom();
  }
}

function sendMessage(text) {
  const content = text.trim();
  if (busy) return;

  if (pending.some((item) => item.status === "uploading")) {
    toast("附件还在上传，请稍等");
    return;
  }
  const ready = pending.filter((item) => item.status === "ready");
  if (!content && !ready.length) return;

  if (!state.settings.apiKey) {
    openSettings("先填写 API Key 才能开始对话");
    return;
  }

  if (ready.length && state.settings.model !== FILE_MODEL) {
    state.settings.model = FILE_MODEL;
    save();
    toast("图片和文件需要 deepseek-flash，已自动切换");
  }

  const conv = ensureConversation();
  const attachments = ready.map((item) => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    size: item.size,
    mime: item.mime,
    fileId: item.fileId,
    preview: item.preview || "",
  }));

  if (!conv.messages.length) {
    conv.title =
      content.replace(/\s+/g, " ").slice(0, 24) ||
      (attachments[0]?.kind === "image" ? "图片" : attachments[0]?.name || "新对话");
  }

  conv.messages.push({ id: uid(), role: "user", content, attachments, ts: Date.now() });
  conv.updatedAt = Date.now();
  pending = [];
  renderPending();
  save();
  renderAll();
  els.input.value = "";
  autoResize();
  updateSendState();
  startStream(conv);
}

function regenerate() {
  const conv = currentConversation();
  if (!conv || busy) return;
  while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") {
    conv.messages.pop();
  }
  if (!conv.messages.length) {
    renderAll();
    return;
  }
  renderMessages();
  startStream(conv);
}

function stopStreaming() {
  abortRef?.abort();
}

/* ---------------- UI state ---------------- */

function setBusyUi(value) {
  els.stop.hidden = !value;
  els.send.hidden = value;
  updateSendState();
}

function updateSendState() {
  const hasReady = pending.some((item) => item.status === "ready");
  const uploading = pending.some((item) => item.status === "uploading");
  els.send.disabled = busy || uploading || (!els.input.value.trim() && !hasReady);
}

function autoResize() {
  const el = els.input;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      toast("已复制");
    } catch {
      toast("复制失败");
    }
    area.remove();
  }
}

/* ---------------- drawer / sheets ---------------- */

function openDrawer() {
  els.drawer.classList.add("open");
  els.drawer.setAttribute("aria-hidden", "false");
  els.scrim.hidden = false;
}

function closeDrawer() {
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
  els.scrim.hidden = true;
}

function openSheet() {
  els.sheet.hidden = false;
}

function closeSheet() {
  els.sheet.hidden = true;
}

function openLightbox(src) {
  $("#lightbox-img").src = src;
  els.lightbox.hidden = false;
}

function closeLightbox() {
  els.lightbox.hidden = true;
  $("#lightbox-img").src = "";
}

/* ---------------- settings ---------------- */

function openSettings(message) {
  const s = state.settings;
  $("#set-key").value = s.apiKey;
  $("#set-base").value = s.baseUrl;
  $("#set-model").value = s.model;
  $("#set-system").value = s.system;
  $("#set-context").value = s.context;
  $("#set-temp").value = s.temperature;
  const msg = $("#settings-msg");
  msg.hidden = !message;
  msg.textContent = message || "";
  els.settings.hidden = false;
  setTimeout(() => $("#set-key").focus(), 120);
}

function closeSettings() {
  els.settings.hidden = true;
}

function saveSettings() {
  const key = $("#set-key").value.trim();
  const base = $("#set-base").value.trim() || DEFAULT_SETTINGS.baseUrl;
  const model = $("#set-model").value.trim() || "deepseek-flash";
  const system = $("#set-system").value;
  const context = Math.min(100, Math.max(2, Number($("#set-context").value) || 20));
  const temperature = Math.min(2, Math.max(0, Number($("#set-temp").value)));
  const msg = $("#settings-msg");

  if (!/^https?:\/\//i.test(base)) {
    msg.hidden = false;
    msg.textContent = "接口地址需要以 http:// 或 https:// 开头";
    return;
  }

  state.settings = {
    ...state.settings,
    apiKey: key,
    baseUrl: normalizeBase(base),
    model,
    system,
    context,
    temperature: Number.isFinite(temperature) ? temperature : 1,
  };
  save();
  closeSettings();
  renderAll();
  toast(key ? "已保存" : "已保存，但还没有填写 API Key");
}

/* ---------------- backup ---------------- */

function exportBackup() {
  const data = {
    app: "deepseek-mobile",
    version: 2,
    exportedAt: new Date().toISOString(),
    conversations: state.conversations,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `deepseek-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("已导出（不含 API Key）");
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data.conversations;
    if (!Array.isArray(list)) throw new Error("格式不正确");
    const valid = list.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages));
    if (!valid.length) throw new Error("没有可导入的对话");
    if (!confirm(`导入 ${valid.length} 段对话？将替换当前全部对话。`)) return;
    state.conversations = valid;
    state.currentId = valid[0]?.id ?? null;
    save();
    renderAll();
    toast("导入成功");
  } catch (error) {
    toast("导入失败：" + (error.message || "文件无法读取"));
  }
}

/* ---------------- events ---------------- */

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(els.input.value);
});

els.input.addEventListener("input", () => {
  autoResize();
  updateSendState();
});

els.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  sendMessage(els.input.value);
});

els.send.addEventListener("click", () => sendMessage(els.input.value));
els.stop.addEventListener("click", stopStreaming);

els.thinking.addEventListener("click", () => {
  state.settings.thinking = !state.settings.thinking;
  save();
  renderThinking();
  toast(state.settings.thinking ? "深度思考已开启" : "深度思考已关闭");
});

els.attach.addEventListener("click", openSheet);
els.sheet.addEventListener("click", (event) => {
  if (event.target === els.sheet) closeSheet();
});

document.querySelectorAll("[data-pick]").forEach((button) => {
  button.addEventListener("click", () => {
    const pick = button.dataset.pick;
    closeSheet();
    if (pick === "camera") $("#file-camera").click();
    else if (pick === "gallery") $("#file-gallery").click();
    else if (pick === "file") $("#file-doc").click();
  });
});

["#file-camera", "#file-gallery", "#file-doc"].forEach((selector) => {
  const input = $(selector);
  input.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) addFiles(files);
  });
});

els.pending.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) removePending(remove.dataset.remove);
});

els.lightbox.addEventListener("click", closeLightbox);

$("#btn-menu").addEventListener("click", openDrawer);
$("#btn-new").addEventListener("click", newChat);
$("#btn-new-2").addEventListener("click", newChat);
els.scrim.addEventListener("click", closeDrawer);
$("#btn-settings").addEventListener("click", () => {
  closeDrawer();
  openSettings();
});
$("#btn-close-settings").addEventListener("click", closeSettings);
$("#btn-save-settings").addEventListener("click", saveSettings);
$("#btn-clear-key").addEventListener("click", () => {
  if (!confirm("清除本机保存的 API Key？")) return;
  state.settings.apiKey = "";
  save();
  $("#set-key").value = "";
  toast("已清除密钥");
});
$("#btn-export").addEventListener("click", exportBackup);
$("#btn-import").addEventListener("click", () => $("#file-import").click());
$("#file-import").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importBackup(file);
  event.target.value = "";
});

els.settings.addEventListener("click", (event) => {
  if (event.target === els.settings) closeSettings();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!els.lightbox.hidden) closeLightbox();
  else if (!els.sheet.hidden) closeSheet();
  else if (!els.settings.hidden) closeSettings();
  else if (els.drawer.classList.contains("open")) closeDrawer();
});

els.messages.addEventListener("click", (event) => {
  if (event.target.classList.contains("msg-image")) {
    const src = event.target.getAttribute("src");
    if (src) openLightbox(src);
    return;
  }

  const target = event.target.closest("button, [data-prompt]");
  if (!target) return;

  if (target.dataset.prompt) {
    sendMessage(target.dataset.prompt);
    return;
  }

  if (target.dataset.action === "open-settings") {
    openSettings();
    return;
  }

  if (target.classList.contains("copy-code")) {
    const code = target.closest(".code-block")?.querySelector("code");
    if (code) copyText(code.textContent || "");
    return;
  }

  if (target.dataset.action === "copy") {
    const conv = currentConversation();
    const message = conv?.messages.find((m) => m.id === target.dataset.id);
    if (message) copyText(message.content);
    return;
  }

  if (target.dataset.action === "regen") regenerate();
});

els.convList.addEventListener("click", (event) => {
  const del = event.target.closest("[data-del]");
  if (del) {
    deleteConversation(del.dataset.del);
    return;
  }
  const open = event.target.closest("[data-open]");
  if (open) openConversation(open.dataset.open);
});

/* ---------------- PWA ---------------- */

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  $("#btn-install").hidden = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  $("#btn-install").hidden = true;
  toast("已安装到主屏幕");
});

$("#btn-install").addEventListener("click", async () => {
  if (deferredInstall) {
    deferredInstall.prompt();
    const choice = await deferredInstall.userChoice;
    if (choice.outcome === "accepted") {
      deferredInstall = null;
      $("#btn-install").hidden = true;
    }
    return;
  }
  toast("请点浏览器底部的分享按钮 → 添加到主屏幕");
});

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
if (isIos && !isStandalone()) {
  $("#btn-install").hidden = false;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* file:// 打开时会失败，忽略 */
    });
  });
}

/* ---------------- boot ---------------- */

if (!state.conversations.some((c) => c.id === state.currentId)) {
  state.currentId = state.conversations[0]?.id ?? null;
}

renderAll();
renderPending();
updateSendState();
autoResize();
