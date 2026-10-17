import { getCapture, listCaptures, deleteCapture, closeDB } from "./lib/db.js";
import { clamp, normalizeRect, moveRect, resizeRect, splitRect, clientToImage } from "./lib/geometry.js";
import { createCanvas, releaseCanvas, renderRegion, encodeCanvas } from "./lib/render.js";
import { exportPNG, canExportJPEG } from "./lib/export.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let capture, view, selection = null, cropMode = false, zoom = 1, fit = true;
let drag = null, dragAnimation = 0, previewController, previewTimer, previewCanvas, exportController;
let exporting = false, exportParts = [], exportType = "png";
let partsKey = "";
let clearingUI = false, layoutAnimation = 0;
const downloadURLs = new Map();
const workspace = $("workspace"), stage = $("stage"), selectionElement = $("selection");
const fields = ["x", "y", "width", "height"];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function status(text, error = false) { $("status").textContent = text; $("status").classList.toggle("status-error", error); }
function exportRect() { return { ...(selection || view) }; }
function readyControls() {
  for (const id of ["crop-button", "reset-button", "zoom", "zoom-in", "zoom-out", "save-button", "parts-button", "copy-button"]) $(id).disabled = !capture || exporting || clearingUI;
  $("apply-button").disabled = !selection || !selection.width || !selection.height || exporting;
  $("cancel-crop-button").disabled = exporting;
  for (const field of fields) $("rect-" + field).disabled = !cropMode || !selection || exporting;
  for (const id of ["clear-all-button", "library-clear-all", "library-button", "clear-clipboard"]) $(id).disabled = clearingUI;
  $("clear-clipboard").disabled = clearingUI || exporting;
}

function updateSelection() {
  selectionElement.hidden = !selection || !cropMode;
  if (selection) {
    Object.assign(selectionElement.style, { left: `${(selection.x - view.x) * zoom}px`, top: `${(selection.y - view.y) * zoom}px`,
      width: `${selection.width * zoom}px`, height: `${selection.height * zoom}px` });
    $("selection-label").textContent = `${selection.width} × ${selection.height}`;
  }
  const rect = selection || view;
  if (!rect) return;
  if (partsKey && partsKey !== JSON.stringify(rect)) {
    $("parts-panel").hidden = true; exportParts = []; partsKey = "";
  }
  $("size-width").textContent = rect.width.toLocaleString("ru");
  $("size-height").textContent = rect.height.toLocaleString("ru");
  for (const field of fields) $("rect-" + field).value = rect[field];
  $("inspector-title").textContent = cropMode ? "Обрезка" : view.width === capture.width && view.height === capture.height ? "Оригинал" : "Результат обрезки";
  readyControls();
}

function setCrop(enabled) {
  if (!capture || exporting) return;
  cropMode = enabled; selection = null;
  stage.classList.toggle("cropping", enabled);
  $("crop-button").classList.toggle("active", enabled);
  $("apply-button").hidden = $("cancel-crop-button").hidden = !enabled;
  $("crop-help").textContent = enabled ? "Потяните мышью для выделения. Границы и углы можно перетаскивать. У края окна включается прокрутка." : "Нажмите «Обрезать» и выделите нужный участок мышью.";
  updateSelection();
  status(enabled ? "Выделите прямоугольник · Enter — применить · Esc — отменить" : "Обрезка отменена. Изображение сохранено.");
}

function applyCrop() {
  if (!selection?.width || !selection?.height || exporting) return;
  view = { ...selection };
  setCrop(false);
  workspace.scrollTo(0, 0);
  layout();
  status(`Обрезано до ${view.width} × ${view.height} px. Оригинал доступен через «Сбросить».`);
}

function setZoom(value, anchor) {
  if (!capture) return;
  const old = zoom;
  const wrect = workspace.getBoundingClientRect(), srect = stage.getBoundingClientRect();
  const point = anchor || { x: wrect.left + workspace.clientWidth / 2, y: wrect.top + workspace.clientHeight / 2 };
  const imagePoint = clientToImage(point.x, point.y, srect, old, view);
  fit = value === "fit";
  zoom = fit ? Math.min(1, Math.max(0.01, (workspace.clientWidth - 88) / view.width)) : clamp(Number(value), 0.05, 4);
  layout();
  const nextRect = stage.getBoundingClientRect();
  workspace.scrollLeft += nextRect.left + (imagePoint.x - view.x) * zoom - point.x;
  workspace.scrollTop += nextRect.top + (imagePoint.y - view.y) * zoom - point.y;
  schedulePreview();
}

function layout() {
  if (!capture || clearingUI) return;
  if (fit) zoom = Math.min(1, Math.max(0.01, (workspace.clientWidth - 88) / view.width));
  stage.style.width = `${view.width * zoom}px`;
  stage.style.height = `${view.height * zoom}px`;
  const value = String(zoom);
  const custom = $("zoom").querySelector("option[data-custom]");
  if (custom && (fit || custom.value !== value)) custom.remove();
  if (fit) $("zoom").value = "fit";
  else {
    if (![...$("zoom").options].some(option => option.value === value)) {
      const option = new Option(`${Math.round(zoom * 100)}%`, value); option.dataset.custom = "true"; $("zoom").add(option);
    }
    $("zoom").value = value;
  }
  $("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  updateSelection(); schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer); previewController?.abort();
  if (!capture || clearingUI) return;
  previewTimer = setTimeout(() => void renderPreview(), 60);
}

async function renderPreview() {
  if (!capture) return;
  const controller = new AbortController(); previewController = controller;
  const srect = stage.getBoundingClientRect(), wrect = workspace.getBoundingClientRect();
  const x = clamp(Math.floor((wrect.left - srect.left) / zoom) - 80, 0, view.width - 1);
  const y = clamp(Math.floor((wrect.top - srect.top) / zoom) - 80, 0, view.height - 1);
  const rect = { x: view.x + x, y: view.y + y, width: Math.min(view.width - x, Math.ceil(workspace.clientWidth / zoom) + 160),
    height: Math.min(view.height - y, Math.ceil(workspace.clientHeight / zoom) + 160) };
  const renderScale = Math.min(zoom * Math.min(devicePixelRatio, 2), 1, Math.sqrt(4000000 / (rect.width * rect.height)), 8192 / rect.width, 8192 / rect.height);
  let canvas;
  try {
    const surface = createCanvas(Math.max(1, Math.ceil(rect.width * renderScale)), Math.max(1, Math.ceil(rect.height * renderScale)));
    canvas = surface.canvas;
    const context = surface.context;
    await renderRegion(capture, rect, context, renderScale, controller.signal);
    controller.signal.throwIfAborted();
    canvas.className = "preview";
    Object.assign(canvas.style, { left: `${x * zoom}px`, top: `${y * zoom}px`, width: `${rect.width * zoom}px`, height: `${rect.height * zoom}px` });
    if (previewCanvas) { previewCanvas.remove(); releaseCanvas(previewCanvas); }
    stage.prepend(canvas); previewCanvas = canvas;
  } catch (error) {
    if (canvas) releaseCanvas(canvas);
    if (error.name !== "AbortError" && !clearingUI) status(error.message, true);
  }
}

function point(event) { return clientToImage(event.clientX, event.clientY, stage.getBoundingClientRect(), zoom, view); }
function updateDrag(event) {
  if (!drag) return;
  drag.last = { clientX: event.clientX, clientY: event.clientY };
  const end = point(event), dx = end.x - drag.start.x, dy = end.y - drag.start.y;
  const relative = { ...drag.rect, x: drag.rect.x - view.x, y: drag.rect.y - view.y };
  if (drag.kind === "draw") selection = normalizeRect(drag.start, end, capture.width, capture.height);
  else {
    const changed = drag.kind === "move" ? moveRect(relative, dx, dy, view) : resizeRect(relative, drag.kind, dx, dy, view);
    selection = { ...changed, x: changed.x + view.x, y: changed.y + view.y };
  }
  updateSelection();
}
function autoScroll() {
  if (!drag) return;
  const bounds = workspace.getBoundingClientRect(), { clientX: x, clientY: y } = drag.last;
  const velocity = (v, lo, hi) => v < lo + 32 ? -Math.min(22, (lo + 32 - v) / 2) : v > hi - 32 ? Math.min(22, (v - hi + 32) / 2) : 0;
  const dx = velocity(x, bounds.left, bounds.right), dy = velocity(y, bounds.top, bounds.bottom);
  if (dx || dy) { workspace.scrollBy(dx, dy); updateDrag(drag.last); }
  dragAnimation = requestAnimationFrame(autoScroll);
}
stage.addEventListener("pointerdown", event => {
  if (!cropMode || exporting || event.button !== 0) return;
  event.preventDefault();
  const start = point(event);
  const kind = event.target.dataset.handle || (event.target.closest(".selection") ? "move" : "draw");
  drag = { start, rect: { ...(selection || { x: start.x, y: start.y, width: 0, height: 0 }) }, kind,
    last: { clientX: event.clientX, clientY: event.clientY } };
  stage.setPointerCapture(event.pointerId);
  updateDrag(event); autoScroll();
});
stage.addEventListener("pointermove", event => { if (drag) updateDrag(event); });
function endDrag() {
  drag = null; cancelAnimationFrame(dragAnimation);
  if (selection && (!selection.width || !selection.height)) selection = null;
  updateSelection();
}
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);
stage.addEventListener("lostpointercapture", () => { if (drag) endDrag(); });

for (const field of fields) $("rect-" + field).addEventListener("change", () => {
  if (!selection) return;
  const values = Object.fromEntries(fields.map(key => [key, Math.round(Number($("rect-" + key).value))]));
  if (!Object.values(values).every(Number.isFinite)) return updateSelection();
  values.x = clamp(values.x, view.x, view.x + view.width - 1); values.y = clamp(values.y, view.y, view.y + view.height - 1);
  values.width = clamp(values.width, 1, view.x + view.width - values.x); values.height = clamp(values.height, 1, view.y + view.height - values.y);
  selection = values; updateSelection();
});

function download(blob, filename) {
  if (clearingUI) return;
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  downloadURLs.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloadURLs.delete(url); }, 15000));
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
}
function filename(type, suffix = "") {
  const name = (capture.title || "screenshot").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 85);
  return `${name}${suffix}.${type === "jpeg" ? "jpg" : "png"}`;
}
async function makeBlob(rect, type, signal) {
  if (type === "png" && splitRect(rect).length > 1) return exportPNG(capture, rect, signal, value => { $("export-progress").value = value; });
  if (type === "jpeg" && !canExportJPEG(rect)) throw new Error("Эта область слишком велика для JPEG. Выберите PNG для сохранения одним файлом в полном разрешении или «Частями».");
  const { canvas, context } = createCanvas(rect.width, rect.height);
  try {
    await renderRegion(capture, rect, context, 1, signal, value => { $("export-progress").value = value; });
    signal.throwIfAborted();
    const blob = await encodeCanvas(canvas, `image/${type}`);
    signal.throwIfAborted();
    return blob;
  } finally { releaseCanvas(canvas); }
}
async function runExport(work) {
  if (exporting || !capture || clearingUI) return;
  exporting = true; endDrag(); exportController = new AbortController(); readyControls();
  $("export-progress").hidden = $("cancel-export").hidden = false; $("export-progress").value = 0;
  try { await work(exportController.signal); }
  catch (error) { if (!clearingUI) status(error.name === "AbortError" ? "Экспорт отменён." : error.message, error.name !== "AbortError"); }
  finally { exporting = false; exportController = null; readyControls(); $("export-progress").hidden = $("cancel-export").hidden = true; }
}
function prepareParts(rect, type) {
  exportParts = splitRect(rect); exportType = type;
  partsKey = JSON.stringify(rect);
  $("parts-panel").hidden = false;
  $("parts-info").textContent = `${exportParts.length} файлов в исходном разрешении. Порядок: сверху вниз, слева направо. Для нескольких загрузок Chrome может запросить разрешение.`;
  $("parts-list").replaceChildren();
  exportParts.forEach((part, index) => {
    const button = document.createElement("button");
    button.textContent = `${index + 1}. ${part.width} × ${part.height} · x=${part.x}, y=${part.y}`;
    button.addEventListener("click", () => void runExport(async signal => {
      status(`Подготовка части ${index + 1}…`);
      download(await makeBlob(part, type, signal), filename(type, `-part-${String(index + 1).padStart(3, "0")}`));
      status(`Часть ${index + 1} передана в загрузки Chrome.`);
    }));
    $("parts-list").append(button);
  });
  // Coordinates make reassembly unambiguous even for two-dimensional splits.
  const map = document.createElement("button"); map.textContent = "Скачать карту частей (JSON)";
  map.addEventListener("click", () => download(new Blob([JSON.stringify({ source: { width: capture.width, height: capture.height }, selection: rect,
    parts: exportParts.map((part, index) => ({ ...part, filename: filename(type, `-part-${String(index + 1).padStart(3, "0")}`) })) }, null, 2)], { type: "application/json" }), "screenshot-parts.json"));
  $("parts-list").append(map);
  status(`Большой результат разделён на ${exportParts.length} частей. Выберите файлы справа. Разрешение сохранено.`);
}

$("save-button").addEventListener("click", () => {
  const rect = exportRect(), type = $("format").value;
  void runExport(async signal => { status("Собираем один файл в исходном разрешении…"); download(await makeBlob(rect, type, signal), filename(type)); status(`${rect.width} × ${rect.height} px · один ${type.toUpperCase()} передан в загрузки Chrome.`); });
});
$("parts-button").addEventListener("click", () => prepareParts(exportRect(), $("format").value));
$("save-all").addEventListener("click", () => void runExport(async signal => {
  for (let i = 0; i < exportParts.length; i++) {
    signal.throwIfAborted(); status(`Экспорт части ${i + 1} из ${exportParts.length}…`);
    download(await makeBlob(exportParts[i], exportType, signal), filename(exportType, `-part-${String(i + 1).padStart(3, "0")}`));
    await wait(300);
  }
  status("Все части переданы в загрузки Chrome. При запросе разрешите несколько скачиваний.");
}));
$("copy-button").addEventListener("click", () => {
  const rect = exportRect();
  if (splitRect(rect).length > 1) { status("Эта область слишком велика для буфера. Выделите меньший участок или сохраните по частям.", true); return; }
  void runExport(async signal => {
    status("Готовим PNG для буфера обмена…");
    const blob = await makeBlob(rect, "png", signal);
    signal.throwIfAborted();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    status(`PNG ${rect.width} × ${rect.height} px скопирован в буфер обмена.`);
  });
});
$("cancel-export").addEventListener("click", () => exportController?.abort());
$("crop-button").addEventListener("click", () => setCrop(!cropMode));
$("apply-button").addEventListener("click", applyCrop);
$("cancel-crop-button").addEventListener("click", () => setCrop(false));
$("reset-button").addEventListener("click", () => {
  if (exporting) return;
  view = { x: 0, y: 0, width: capture.width, height: capture.height }; setCrop(false); layout(); workspace.scrollTo(0, 0); status("Восстановлен оригинальный снимок.");
});
$("zoom").addEventListener("change", event => setZoom(event.target.value));
$("zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
$("zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
workspace.addEventListener("scroll", schedulePreview, { passive: true });
workspace.addEventListener("wheel", event => {
  if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX, y: event.clientY }); }
}, { passive: false });
let observedWidth = -1, observedHeight = -1;
const resizeObserver = new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  if (width === observedWidth && height === observedHeight) return;
  observedWidth = width; observedHeight = height;
  if (!capture || clearingUI || layoutAnimation) return;
  // Never resize the observed layout during ResizeObserver delivery. Chrome
  // otherwise defers notifications and reports an undelivered-notifications loop.
  layoutAnimation = requestAnimationFrame(() => { layoutAnimation = 0; layout(); });
});
resizeObserver.observe(workspace);
document.addEventListener("keydown", event => {
  if (!capture || event.target.matches("input,select,textarea") || $("library").open) return;
  if (event.key === "Escape") { event.preventDefault(); if (exporting) exportController.abort(); else { endDrag(); setCrop(false); } }
  if (exporting) return;
  if (event.key.toLowerCase() === "c" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); setCrop(!cropMode); }
  if (event.key === "Enter" && cropMode) { event.preventDefault(); applyCrop(); }
  if (selection && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault(); const step = event.shiftKey ? 10 : 1;
    const relative = { ...selection, x: selection.x - view.x, y: selection.y - view.y };
    const moved = moveRect(relative, event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0, view);
    selection = { ...moved, x: moved.x + view.x, y: moved.y + view.y }; updateSelection();
  }
});

async function showLibrary() {
  if (clearingUI) return;
  $("library-list").replaceChildren();
  const items = await listCaptures();
  if (clearingUI) return;
  for (const item of items.sort((a, b) => b.createdAt - a.createdAt)) {
    const row = document.createElement("div"); row.className = "library-row";
    const link = document.createElement("a"); link.href = `editor.html?id=${encodeURIComponent(item.id)}`; link.textContent = item.title;
    const detail = document.createElement("small"); detail.textContent = `${new Date(item.createdAt).toLocaleString("ru")} · ${item.status === "ready" ? `${item.width} × ${item.height} px` : "незавершённый захват"}`; link.append(detail);
    const remove = document.createElement("button"); remove.textContent = "Удалить";
    remove.addEventListener("click", async () => {
      if (clearingUI) return;
      if (exporting) { status("Дождитесь окончания экспорта."); return; }
      await deleteCapture(item.id); row.remove();
      if (item.id === capture?.id) location.href = "editor.html";
    });
    row.append(link, remove); $("library-list").append(row);
  }
  if (!$("library-list").children.length) $("library-list").textContent = "Сохранённых снимков пока нет.";
  $("library").showModal();
}
$("library-button").addEventListener("click", () => void showLibrary().catch(error => status(error.message, true)));
$("close-library").addEventListener("click", () => $("library").close());

function releaseResources() {
  clearingUI = true;
  clearTimeout(previewTimer);
  cancelAnimationFrame(layoutAnimation); layoutAnimation = 0;
  resizeObserver.disconnect();
  previewController?.abort(); exportController?.abort();
  drag = null; cancelAnimationFrame(dragAnimation);
  if (previewCanvas) { previewCanvas.remove(); releaseCanvas(previewCanvas); previewCanvas = null; }
  for (const [url, timer] of downloadURLs) { clearTimeout(timer); URL.revokeObjectURL(url); }
  downloadURLs.clear();
  capture = view = selection = null; cropMode = false; exportParts = []; partsKey = "";
  $("parts-list").replaceChildren(); $("library-list").replaceChildren();
  $("parts-panel").hidden = $("stage-shell").hidden = true;
  selectionElement.hidden = true;
  $("apply-button").hidden = $("cancel-crop-button").hidden = true;
  $("library").close();
  // Remove the error-diagnostics handler, whose closure can retain old metadata.
  const diagnostics = $("diagnostics-button");
  diagnostics.replaceWith(diagnostics.cloneNode(false)); $("diagnostics-button").hidden = true;
  for (const field of fields) $("rect-" + field).value = "";
  $("size-width").textContent = $("size-height").textContent = $("zoom-label").textContent = "—";
  document.title = "Full Page Screenshot Editor";
  $("document-title").textContent = "Ваш снимок";
  $("document-info").textContent = "Очистка локальных данных…";
  $("empty").hidden = false;
  $("empty-title").textContent = "Очищаем данные";
  $("empty-text").textContent = "Отменяем захват, закрываем изображения во всех редакторах и удаляем локальное хранилище…";
  readyControls(); status("Очистка всех снимков и данных расширения…");
}

function clearEditorMemory() {
  releaseResources();
  localStorage.clear(); sessionStorage.clear();
  // Replace the current entry so Back cannot restore this document's old image.
  history.replaceState(null, "", chrome.runtime.getURL("editor.html?cleared=1"));
  return closeDB();
}

function showClearResult(error) {
  clearingUI = false; readyControls();
  $("document-info").textContent = error ? "Очистка не завершена" : "Локальное хранилище очищено";
  $("empty-title").textContent = error ? "Не удалось завершить очистку" : "Все данные удалены";
  $("empty-text").textContent = error || "Снимки, кадры и данные страниц удалены. Для нового снимка откройте страницу и нажмите иконку расширения. Скачанные файлы и системный буфер обмена управляются отдельно.";
  status(error || "Данные расширения очищены. Можно сделать новый снимок.", Boolean(error));
}

async function requestClearAll() {
  if (clearingUI) return;
  try {
    await clearEditorMemory();
    const result = await chrome.runtime.sendMessage({ type: "FPSE_CLEAR_ALL" });
    showClearResult(result?.ok ? null : result?.error || "Служба расширения не ответила.");
  } catch (error) { showClearResult(error.message); }
}
$("clear-all-button").addEventListener("click", () => void requestClearAll());
$("library-clear-all").addEventListener("click", () => void requestClearAll());
$("clear-clipboard").addEventListener("click", () => {
  void navigator.clipboard.writeText("").then(() => status("Текущее содержимое буфера обмена очищено."), error => status(`Не удалось очистить буфер: ${error.message}`, true));
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "FPSE_WILL_CLEAR") {
    clearEditorMemory().then(() => reply({ ok: true }), error => reply({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "FPSE_CLEAR_COMPLETE") { showClearResult(message.error); reply({ ok: true }); }
});
addEventListener("pagehide", () => { releaseResources(); void closeDB().catch(() => {}); });
addEventListener("pageshow", event => { if (event.persisted) location.reload(); });

async function init() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "FPSE_CLEAR_STATE" });
    if (state?.clearing || params.has("cleared")) {
      await clearEditorMemory();
      // Read again after releasing resources: completion can race the first reply.
      const latest = await chrome.runtime.sendMessage({ type: "FPSE_CLEAR_STATE" });
      if (!latest?.clearing) showClearResult(latest?.error);
      return;
    }
    if (clearingUI) return;
    const stored = params.get("id") ? await getCapture(params.get("id")) : null;
    if (clearingUI) return;
    if (!stored || stored.status !== "ready") {
      if (stored?.diagnostics) {
        $("diagnostics-button").hidden = false;
        $("diagnostics-button").addEventListener("click", () => {
          const data = structuredClone(stored.diagnostics);
          // Chrome API error messages can contain a page URL. Export geometry only.
          if (data.failure) delete data.failure.message;
          download(new Blob([JSON.stringify({ status: stored.status, ...data }, null, 2)], { type: "application/json" }), "capture-diagnostics.json");
        });
      }
      $("empty-title").textContent = stored?.status === "cancelled" ? "Захват отменён" : "Снимок недоступен";
      $("empty-text").textContent = params.get("error") || stored?.error || (stored?.status === "capturing" ? "Захват прервался или ещё выполняется. Вернитесь на исходную вкладку; при потере связи её положение восстановится автоматически. Затем повторите захват." : "Откройте обычную веб-страницу и нажмите иконку расширения. Предыдущие снимки доступны по кнопке «Снимки».");
      status("Сделайте новый снимок или откройте локальную библиотеку."); return;
    }
    capture = stored; view = { x: 0, y: 0, width: capture.width, height: capture.height };
    document.title = `${capture.title} — Full Page`;
    $("document-title").textContent = capture.title;
    let host = "Локальная страница"; try { host = new URL(capture.url).host || host; } catch { /* Older local records may not have a URL. */ }
    $("document-info").textContent = `${host} · ${capture.width} × ${capture.height} px · ${capture.frames.length} кадров`;
    $("empty").hidden = true; $("stage-shell").hidden = false;
    layout(); readyControls(); status("Снимок готов. Выделите область или сохраните изображение целиком.");
  } catch (error) { $("empty-title").textContent = "Ошибка локального хранилища"; $("empty-text").textContent = error.message; status(error.message, true); }
}
void init();
