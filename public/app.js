const STORAGE_PREFS_KEY = "cf_b2_img_prefs_v1";
const STORAGE_THEME_KEY = "cf_b2_img_theme";

const state = {
  activeTab: "upload",
  activeUploadFormat: "direct",
  uploadedItems: [], // { key, url, name, size, originalSize, type, links }
  galleryItems: [],
  selectedKeys: new Set(),
  nextCursor: null,
  galleryLoadedOnce: false,
  publicBaseUrl: window.location.origin,
};

// ---------------- Theme ----------------
function initTheme() {
  const saved = localStorage.getItem(STORAGE_THEME_KEY);
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(STORAGE_THEME_KEY, next);
}

// ---------------- Toast & Clipboard ----------------
function showToast(msg, isError = false) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast${isError ? " error" : ""}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 2600);
}

async function copyText(text, label = "已复制到剪贴板") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showToast(label);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : val < 10 ? 2 : 1)} ${units[idx]}`;
}

function formatDateShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------- Animation Detection & Client-Side WebP / Compression ----------------
async function isAnimatedImage(file) {
  const type = (file.type || "").toLowerCase();
  if (type !== "image/gif" && type !== "image/webp") return false;

  const buf = new Uint8Array(await file.slice(0, 65536).arrayBuffer());

  // Animated GIF: count Graphic Control Extension blocks (0x21 0xF9 0x04)
  if (type === "image/gif") {
    let frames = 0;
    for (let i = 0; i < buf.length - 3; i++) {
      if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) {
        frames++;
        if (frames > 1) return true;
      }
    }
    return false;
  }

  // Animated WebP: check RIFF....WEBP + VP8X animation bit or ANIM chunk
  if (type === "image/webp" && buf.length > 21) {
    for (let i = 12; i < buf.length - 4; i++) {
      if (
        buf[i] === 0x41 && // A
        buf[i + 1] === 0x4e && // N
        buf[i + 2] === 0x49 && // I
        buf[i + 3] === 0x4d // M
      ) {
        return true;
      }
    }
  }

  return false;
}

function replaceExtension(filename, newExt) {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}.${newExt}`;
}

async function processImageClientSide(file, prefs) {
  const mode = prefs.processMode; // 'webp' | 'compress' | 'original'
  if (mode === "original") return file;

  const mime = (file.type || "").toLowerCase();
  // Never rasterize SVG, ICO, or multi-frame animated GIF/WebP
  if (mime === "image/svg+xml" || mime === "image/x-icon" || mime === "image/vnd.microsoft.icon") {
    return file;
  }
  if (await isAnimatedImage(file)) {
    return file;
  }

  const quality = Math.min(Math.max((Number(prefs.quality) || 84) / 100, 0.4), 0.98);
  const maxDim = Number(prefs.maxDim) || 0;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  let { width, height } = bitmap;
  const resized = maxDim > 0 && (width > maxDim || height > maxDim);
  if (resized) {
    if (width >= height) {
      height = Math.round((height * maxDim) / width);
      width = maxDim;
    } else {
      width = Math.round((width * maxDim) / height);
      height = maxDim;
    }
  }

  const targetMime =
    mode === "webp"
      ? "image/webp"
      : mime === "image/jpeg" || mime === "image/webp"
        ? mime
        : "image/webp";

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, targetMime, quality));
  if (!blob) return file;

  // If keeping same format without resizing and output grew larger, keep original
  if (blob.size >= file.size && !resized && (mode === "compress" || mime === targetMime)) {
    return file;
  }

  const extMap = {
    "image/webp": "webp",
    "image/jpeg": "jpg",
    "image/png": "png",
  };
  const newName = replaceExtension(file.name || "image.png", extMap[targetMime] || "webp");
  return new File([blob], newName, { type: targetMime });
}

// ---------------- Preferences ----------------
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFS_KEY) || "{}");
    if (saved.processMode) document.getElementById("opt-process").value = saved.processMode;
    if (saved.quality) document.getElementById("opt-quality").value = saved.quality;
    if (saved.maxDim) document.getElementById("opt-max-dim").value = saved.maxDim;
    if (saved.naming) document.getElementById("opt-naming").value = saved.naming;
    if (typeof saved.folder === "string") document.getElementById("opt-folder").value = saved.folder;
  } catch {
    // ignore invalid storage
  }
  syncPrefsUi();
}

function getCurrentPrefs() {
  return {
    processMode: document.getElementById("opt-process").value,
    quality: document.getElementById("opt-quality").value,
    maxDim: document.getElementById("opt-max-dim").value,
    naming: document.getElementById("opt-naming").value,
    folder: document.getElementById("opt-folder").value.trim(),
  };
}

function syncPrefsUi() {
  const prefs = getCurrentPrefs();
  document.getElementById("quality-val").textContent = `${prefs.quality}%`;
  const disableCompressionOpts = prefs.processMode === "original";
  document.getElementById("opt-quality").disabled = disableCompressionOpts;
  document.getElementById("opt-max-dim").disabled = disableCompressionOpts;
  localStorage.setItem(STORAGE_PREFS_KEY, JSON.stringify(prefs));
}

// ---------------- Auth & Status ----------------
async function checkAuthOnBoot() {
  try {
    const res = await fetch("/api/auth/verify");
    const data = await res.json();
    if (res.status === 503 && data.configured === false) {
      showAuthScreen(data.error);
      return;
    }
    if (res.ok && data.authenticated) {
      await enterApp();
    } else {
      showAuthScreen();
    }
  } catch {
    showAuthScreen();
  }
}

function showAuthScreen(unconfiguredMsg) {
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
  const alertEl = document.getElementById("unconfigured-alert");
  if (unconfiguredMsg) {
    document.getElementById("unconfigured-msg").textContent = unconfiguredMsg;
    alertEl.classList.remove("hidden");
  } else {
    alertEl.classList.add("hidden");
  }
}

async function enterApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  await loadStatus(false);
  renderClientIntegrationSnippets();
}

async function loadStatus(withPing = false) {
  try {
    const res = await fetch(`/api/status${withPing ? "?ping=1" : ""}`);
    if (res.status === 401) {
      showAuthScreen();
      return;
    }
    const data = await res.json();
    const warnBanner = document.getElementById("b2-config-warning");
    if (!data.b2Configured) {
      warnBanner.classList.remove("hidden");
      document.getElementById("b2-config-warning-text").textContent =
        data.error || "请检查 B2_BUCKET / B2_ENDPOINT / B2_KEY_ID / B2_APPLICATION_KEY 配置。";
      return;
    }
    warnBanner.classList.add("hidden");

    state.publicBaseUrl = data.publicBaseUrl || window.location.origin;
    document.getElementById("header-bucket-badge").textContent = `${data.bucket} (${data.region})`;
    document.getElementById("max-size-hint").textContent = `· 单图上限 ${data.maxFileSizeMb} MB`;

    document.getElementById("st-bucket").textContent = data.bucket;
    document.getElementById("st-endpoint").textContent = data.endpoint;
    document.getElementById("st-region").textContent = data.region;
    document.getElementById("st-baseurl").textContent = state.publicBaseUrl;
    document.getElementById("st-maxsize").textContent = `${data.maxFileSizeMb} MB`;
    document.getElementById("st-cache").textContent = `${data.cacheTtlSeconds} 秒 (${Math.round(data.cacheTtlSeconds / 86400)} 天)`;
    document.getElementById("st-hotlink").textContent = data.hotlinkEnabled
      ? `已开启 (${data.allowedReferers.join(", ")}${data.allowEmptyReferer ? " · 允许空 Referer" : " · 禁止空 Referer"})`
      : "未开启（公开直链）";

    if (data.ping) {
      const pingEl = document.getElementById("ping-result");
      pingEl.classList.remove("hidden");
      if (data.ping.ok) {
        pingEl.textContent = `✅ Backblaze B2 连接正常！响应耗时 ${data.ping.latencyMs} ms`;
        pingEl.style.color = "var(--success)";
      } else {
        pingEl.textContent = `❌ B2 连接失败: ${data.ping.error}`;
        pingEl.style.color = "var(--danger)";
      }
    }

    renderClientIntegrationSnippets();
  } catch (err) {
    showToast(`获取系统状态失败: ${err.message}`, true);
  }
}

// ---------------- Upload Flow ----------------
async function handleFilesSelected(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && f.size > 0);
  if (files.length === 0) return;

  const prefs = getCurrentPrefs();
  const concurrency = 3;
  let index = 0;

  showToast(`正在处理并上传 ${files.length} 张图片...`);

  async function worker() {
    while (index < files.length) {
      const file = files[index++];
      await uploadSingleFile(file, prefs);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);

  if (state.galleryLoadedOnce) {
    // Mark gallery stale so switching back refreshes automatically
    state.galleryLoadedOnce = false;
  }
}

async function uploadSingleFile(rawFile, prefs) {
  const originalSize = rawFile.size;
  let processedFile = rawFile;
  try {
    processedFile = await processImageClientSide(rawFile, prefs);
  } catch {
    processedFile = rawFile;
  }

  const fd = new FormData();
  fd.append("file", processedFile, processedFile.name);
  fd.append("naming", prefs.naming);
  if (prefs.folder) {
    fd.append("folder", prefs.folder);
  }

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || `上传 ${rawFile.name} 失败`, true);
      return;
    }

    state.uploadedItems.unshift({
      key: data.key,
      url: data.url,
      name: processedFile.name,
      size: data.size,
      originalSize,
      type: data.type,
      links: data.links,
    });

    renderUploadedItems();
    showToast(`上传成功: ${processedFile.name}`);
  } catch (err) {
    showToast(`网络错误 (${rawFile.name}): ${err.message}`, true);
  }
}

function renderUploadedItems() {
  const section = document.getElementById("upload-results-section");
  const listEl = document.getElementById("upload-list");
  const counter = document.getElementById("upload-counter-badge");

  if (state.uploadedItems.length === 0) {
    section.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  counter.textContent = String(state.uploadedItems.length);
  listEl.innerHTML = "";

  for (const item of state.uploadedItems) {
    const row = document.createElement("div");
    row.className = "upload-item";

    const thumb = document.createElement("img");
    thumb.className = "upload-thumb";
    thumb.src = item.url;
    thumb.alt = item.name;
    thumb.loading = "lazy";
    thumb.addEventListener("click", () => openLightbox(item.url, item.key));

    const right = document.createElement("div");

    const top = document.createElement("div");
    top.className = "upload-info-top";

    const nameSpan = document.createElement("span");
    nameSpan.className = "upload-filename";
    nameSpan.textContent = item.key;

    const badges = document.createElement("div");
    badges.className = "upload-badges";

    const extBadge = document.createElement("span");
    extBadge.className = "badge badge-subtle";
    extBadge.textContent = (item.type.split("/")[1] || "IMG").toUpperCase().replace("+XML", "");
    badges.appendChild(extBadge);

    const sizeBadge = document.createElement("span");
    if (item.originalSize && item.size < item.originalSize) {
      const savedPct = Math.round((1 - item.size / item.originalSize) * 100);
      sizeBadge.className = "badge badge-success";
      sizeBadge.textContent = `${formatBytes(item.originalSize)} → ${formatBytes(item.size)} (-${savedPct}%)`;
    } else {
      sizeBadge.className = "badge badge-subtle";
      sizeBadge.textContent = formatBytes(item.size);
    }
    badges.appendChild(sizeBadge);

    top.append(nameSpan, badges);

    const linkRow = document.createElement("div");
    linkRow.className = "upload-link-row";

    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = item.links[state.activeUploadFormat] || item.url;
    input.addEventListener("click", () => input.select());

    const quickBtns = document.createElement("div");
    quickBtns.className = "quick-fmt-btns";
    const fmtDefs = [
      ["direct", "URL"],
      ["markdown", "MD"],
      ["html", "HTML"],
      ["bbcode", "BBCode"],
    ];
    for (const [fmtKey, label] of fmtDefs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-secondary btn-sm";
      b.textContent = label;
      b.addEventListener("click", () => {
        input.value = item.links[fmtKey];
        copyText(item.links[fmtKey], `已复制 ${label}`);
      });
      quickBtns.appendChild(b);
    }

    linkRow.append(input, quickBtns);
    right.append(top, linkRow);
    row.append(thumb, right);
    listEl.appendChild(row);
  }
}

// ---------------- Gallery Flow ----------------
async function loadGallery({ append = false } = {}) {
  const prefix = document.getElementById("gallery-folder-select").value;
  const search = document.getElementById("gallery-search").value.trim();
  const statsEl = document.getElementById("gallery-stats");
  statsEl.textContent = "加载中...";

  const params = new URLSearchParams();
  if (prefix) params.set("prefix", prefix);
  if (search) params.set("search", search);
  if (append && state.nextCursor) params.set("cursor", state.nextCursor);
  params.set("limit", "300");

  try {
    const res = await fetch(`/api/images?${params.toString()}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "加载相册失败", true);
      statsEl.textContent = "加载失败";
      return;
    }

    if (append) {
      state.galleryItems.push(...data.items);
    } else {
      state.galleryItems = data.items;
      state.selectedKeys.clear();
    }

    state.nextCursor = data.isTruncated ? data.nextCursor : null;
    state.galleryLoadedOnce = true;

    populateFolderOptions(data.folders || [], prefix);
    renderGallery(data.totalBytesInBatch);
  } catch (err) {
    showToast(`相册请求异常: ${err.message}`, true);
    statsEl.textContent = "请求失败";
  }
}

function populateFolderOptions(folders, currentValue) {
  const sel = document.getElementById("gallery-folder-select");
  const existing = new Set(["", ...folders]);
  if (currentValue) existing.add(currentValue);

  sel.innerHTML = "";
  for (const folder of existing) {
    const opt = document.createElement("option");
    opt.value = folder;
    opt.textContent = folder ? `📁 ${folder}` : "全部目录";
    if (folder === currentValue) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderGallery(totalBytes) {
  const grid = document.getElementById("gallery-grid");
  const emptyEl = document.getElementById("gallery-empty");
  const statsEl = document.getElementById("gallery-stats");
  const loadMoreWrap = document.getElementById("gallery-load-more-wrap");

  const bytesSum =
    typeof totalBytes === "number"
      ? totalBytes
      : state.galleryItems.reduce((s, it) => s + (it.size || 0), 0);

  statsEl.textContent = `共 ${state.galleryItems.length} 张 · ${formatBytes(bytesSum)}`;

  if (state.galleryItems.length === 0) {
    grid.innerHTML = "";
    emptyEl.classList.remove("hidden");
    loadMoreWrap.classList.add("hidden");
    syncBatchBar();
    return;
  }

  emptyEl.classList.add("hidden");
  loadMoreWrap.classList.toggle("hidden", !state.nextCursor);
  grid.innerHTML = "";

  for (const item of state.galleryItems) {
    const card = document.createElement("div");
    card.className = `gallery-card${state.selectedKeys.has(item.key) ? " selected" : ""}`;

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "card-thumb-wrap";

    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.name;
    img.loading = "lazy";
    img.addEventListener("click", () => openLightbox(item.url, item.key));

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "card-checkbox";
    cb.checked = state.selectedKeys.has(item.key);
    cb.title = "选择图片";
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedKeys.add(item.key);
      else state.selectedKeys.delete(item.key);
      card.classList.toggle("selected", cb.checked);
      syncBatchBar();
    });

    const ext = (item.key.split(".").pop() || "img").slice(0, 5);
    const extBadge = document.createElement("span");
    extBadge.className = "card-ext-badge";
    extBadge.textContent = ext;

    thumbWrap.append(img, cb, extBadge);

    const body = document.createElement("div");
    body.className = "card-body";

    const keyDiv = document.createElement("div");
    keyDiv.className = "card-key";
    keyDiv.title = item.key;
    keyDiv.textContent = item.key;

    const sub = document.createElement("div");
    sub.className = "card-submeta";
    const s1 = document.createElement("span");
    s1.textContent = formatBytes(item.size);
    const s2 = document.createElement("span");
    s2.textContent = formatDateShort(item.lastModified);
    sub.append(s1, s2);

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const btnUrl = document.createElement("button");
    btnUrl.type = "button";
    btnUrl.className = "btn btn-secondary btn-sm";
    btnUrl.textContent = "URL";
    btnUrl.addEventListener("click", () => copyText(item.links.direct, "已复制直链 URL"));

    const btnMd = document.createElement("button");
    btnMd.type = "button";
    btnMd.className = "btn btn-secondary btn-sm";
    btnMd.textContent = "MD";
    btnMd.addEventListener("click", () => copyText(item.links.markdown, "已复制 Markdown"));

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn btn-ghost btn-sm";
    btnDel.style.color = "var(--danger)";
    btnDel.textContent = "删除";
    btnDel.addEventListener("click", () => deleteKeys([item.key]));

    actions.append(btnUrl, btnMd, btnDel);
    body.append(keyDiv, sub, actions);
    card.append(thumbWrap, body);
    grid.appendChild(card);
  }

  syncBatchBar();
}

function syncBatchBar() {
  const bar = document.getElementById("batch-bar");
  const count = state.selectedKeys.size;
  document.getElementById("batch-count").textContent = String(count);
  bar.classList.toggle("hidden", count === 0);
}

async function deleteKeys(keys) {
  if (!keys || keys.length === 0) return;
  const ok = window.confirm(
    keys.length === 1
      ? `确定要从 Backblaze B2 永久删除 "${keys[0]}" 吗？`
      : `确定要从 Backblaze B2 永久删除选中的 ${keys.length} 张图片吗？`,
  );
  if (!ok) return;

  try {
    const res = await fetch("/api/images", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "删除失败", true);
      return;
    }

    const removed = new Set(keys);
    state.galleryItems = state.galleryItems.filter((it) => !removed.has(it.key));
    state.uploadedItems = state.uploadedItems.filter((it) => !removed.has(it.key));
    for (const k of keys) state.selectedKeys.delete(k);

    renderGallery();
    renderUploadedItems();
    showToast(`已成功删除 ${keys.length} 张图片`);
  } catch (err) {
    showToast(`删除请求失败: ${err.message}`, true);
  }
}

// ---------------- Client Config Snippets ----------------
function buildSharexConfigJson() {
  const endpoint = `${window.location.origin}/api/upload`;
  const token = document.getElementById("sharex-token-input").value.trim() || "YOUR_AUTH_TOKEN";
  return JSON.stringify(
    {
      Version: "16.1.0",
      Name: "CF-B2 私有图床",
      DestinationType: "ImageUploader",
      RequestMethod: "POST",
      RequestURL: endpoint,
      Headers: {
        "X-API-Key": token,
      },
      Body: "MultipartFormData",
      FileFormName: "file",
      URL: "{json:url}",
      ErrorMessage: "{json:error}",
    },
    null,
    2,
  );
}

function renderClientIntegrationSnippets() {
  const uploadEndpoint = `${window.location.origin}/api/upload`;
  document.getElementById("cfg-picgo-url").value = uploadEndpoint;
  document.getElementById("cfg-sharex-preview").textContent = buildSharexConfigJson();
  document.getElementById("cfg-curl-preview").textContent =
    `curl -X POST "${uploadEndpoint}" \\\n  -H "X-API-Key: YOUR_AUTH_TOKEN" \\\n  -F "file=@./photo.png"`;
}

// ---------------- Lightbox ----------------
function openLightbox(url, title) {
  document.getElementById("lightbox-img").src = url;
  document.getElementById("lightbox-title").textContent = title || "";
  document.getElementById("lightbox-open-raw").href = url;
  document.getElementById("lightbox-copy-url").onclick = () => copyText(url, "已复制直链 URL");
  document.getElementById("lightbox").classList.remove("hidden");
}

function closeLightbox() {
  document.getElementById("lightbox").classList.add("hidden");
  document.getElementById("lightbox-img").src = "";
}

// ---------------- Event Bindings ----------------
function bindEvents() {
  document.getElementById("theme-toggle-btn").addEventListener("click", toggleTheme);

  // Password show/hide
  document.getElementById("toggle-pwd-btn").addEventListener("click", () => {
    const inp = document.getElementById("login-password");
    inp.type = inp.type === "password" ? "text" : "password";
  });

  // Login submit
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwd = document.getElementById("login-password").value.trim();
    const errEl = document.getElementById("login-error");
    const btn = document.getElementById("login-submit-btn");
    errEl.classList.add("hidden");
    btn.disabled = true;

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        errEl.textContent = data.error || "登录失败";
        errEl.classList.remove("hidden");
        return;
      }
      document.getElementById("login-password").value = "";
      await enterApp();
    } catch (err) {
      errEl.textContent = `请求错误: ${err.message}`;
      errEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  // Logout
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    showAuthScreen();
  });

  // Navigation Tabs
  for (const tabBtn of document.querySelectorAll(".nav-tab")) {
    tabBtn.addEventListener("click", () => {
      const target = tabBtn.dataset.tab;
      state.activeTab = target;
      for (const b of document.querySelectorAll(".nav-tab")) {
        b.classList.toggle("active", b === tabBtn);
      }
      for (const panel of document.querySelectorAll(".tab-panel")) {
        panel.classList.toggle("active", panel.id === `tab-${target}`);
      }
      if (target === "gallery" && !state.galleryLoadedOnce) {
        loadGallery();
      }
    });
  }

  // Preferences listeners
  for (const id of ["opt-process", "opt-quality", "opt-max-dim", "opt-naming", "opt-folder"]) {
    document.getElementById(id).addEventListener("input", syncPrefsUi);
    document.getElementById(id).addEventListener("change", syncPrefsUi);
  }

  // Dropzone & File Picker
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");

  document.getElementById("pick-files-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    handleFilesSelected(fileInput.files);
    fileInput.value = "";
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) {
      handleFilesSelected(e.dataTransfer.files);
    }
  });

  // Global Ctrl+V / Cmd+V Clipboard Paste
  window.addEventListener("paste", (e) => {
    if (document.getElementById("app-shell").classList.contains("hidden")) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      if (state.activeTab !== "upload") {
        document.querySelector('.nav-tab[data-tab="upload"]')?.click();
      }
      handleFilesSelected(imageFiles);
    }
  });

  // Upload result format pills & bulk copy
  for (const pill of document.querySelectorAll("#upload-format-pills .pill")) {
    pill.addEventListener("click", () => {
      state.activeUploadFormat = pill.dataset.fmt;
      for (const p of document.querySelectorAll("#upload-format-pills .pill")) {
        p.classList.toggle("active", p === pill);
      }
      renderUploadedItems();
    });
  }

  document.getElementById("copy-all-uploaded-btn").addEventListener("click", () => {
    const lines = state.uploadedItems.map((it) => it.links[state.activeUploadFormat] || it.url);
    if (lines.length > 0) {
      copyText(lines.join("\n"), `已复制全部 ${lines.length} 条链接`);
    }
  });

  document.getElementById("clear-uploaded-btn").addEventListener("click", () => {
    state.uploadedItems = [];
    renderUploadedItems();
  });

  // Gallery filters & batch actions
  let searchTimer = null;
  document.getElementById("gallery-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadGallery(), 280);
  });
  document.getElementById("gallery-folder-select").addEventListener("change", () => loadGallery());
  document.getElementById("gallery-refresh-btn").addEventListener("click", () => loadGallery());
  document.getElementById("gallery-load-more-btn").addEventListener("click", () =>
    loadGallery({ append: true }),
  );

  document.getElementById("gallery-select-all-btn").addEventListener("click", () => {
    const allSelected =
      state.galleryItems.length > 0 &&
      state.galleryItems.every((it) => state.selectedKeys.has(it.key));
    if (allSelected) {
      state.selectedKeys.clear();
    } else {
      for (const it of state.galleryItems) state.selectedKeys.add(it.key);
    }
    renderGallery();
  });

  for (const btn of document.querySelectorAll("[data-batch-copy]")) {
    btn.addEventListener("click", () => {
      const fmt = btn.dataset.batchCopy;
      const selected = state.galleryItems.filter((it) => state.selectedKeys.has(it.key));
      const text = selected.map((it) => it.links[fmt] || it.url).join("\n");
      if (text) copyText(text, `已复制 ${selected.length} 张图片的链接`);
    });
  }

  document.getElementById("batch-delete-btn").addEventListener("click", () => {
    deleteKeys(Array.from(state.selectedKeys));
  });
  document.getElementById("batch-cancel-btn").addEventListener("click", () => {
    state.selectedKeys.clear();
    renderGallery();
  });

  // Clients & Status buttons
  document.getElementById("ping-b2-btn").addEventListener("click", () => loadStatus(true));

  for (const btn of document.querySelectorAll("[data-copy-target]")) {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (target) copyText(target.value);
    });
  }

  document.getElementById("sharex-token-input").addEventListener("input", () => {
    document.getElementById("cfg-sharex-preview").textContent = buildSharexConfigJson();
  });

  document.getElementById("copy-sxcu-btn").addEventListener("click", () => {
    copyText(buildSharexConfigJson(), "已复制 ShareX 配置 JSON");
  });

  document.getElementById("download-sxcu-btn").addEventListener("click", () => {
    const blob = new Blob([buildSharexConfigJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cf-b2-image-host-${window.location.hostname}.sxcu`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById("copy-curl-btn").addEventListener("click", () => {
    copyText(document.getElementById("cfg-curl-preview").textContent, "已复制 cURL 命令");
  });

  // Lightbox close
  document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") closeLightbox();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });
}

// Boot
initTheme();
loadPrefs();
bindEvents();
checkAuthOnBoot();
