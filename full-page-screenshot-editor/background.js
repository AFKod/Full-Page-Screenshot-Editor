import { planAxis, captureDelay, inferPixelScale } from "./lib/geometry.js";
import { buildStitchPlan, contentPixelExtent } from "./lib/stitch.js";
import { putCapture, putFrame, pruneCaptures, deleteCapture, deleteAllData } from "./lib/db.js";
import { pngDataURLToBlob } from "./lib/image-data.js";

const MAX_FRAMES = 600;
const MAX_DURATION = 240000;
let running = null;
let clearing = null;
let clearError = null;
let lastCaptureStart = -Infinity;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

chrome.action.onClicked.addListener(tab => {
  if (clearing) return;
  if (running) { running.cancelled = "Захват отменён повторным нажатием на иконку."; return; }
  const job = { id: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, cancelled: null };
  running = job;
  job.done = capturePage(tab, job);
  void job.done.catch(() => {}); // capturePage records errors and always restores the page.
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === "FPSE_CANCEL" && running && sender.tab?.id === running.tabId && message.id === running.id) {
    running.cancelled = message.reason || "Захват отменён.";
    reply({ ok: true });
    return;
  }
  // Page scripts cannot request deletion. Only this extension's own editor can.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("editor.html"))) return;
  if (message?.type === "FPSE_CLEAR_STATE") {
    reply({ clearing: Boolean(clearing), error: clearError });
  } else if (message?.type === "FPSE_CLEAR_ALL") {
    // Set the barrier before any await, including cancellation of an active job.
    clearing ||= Promise.resolve().then(clearEverything);
    clearing.then(() => reply({ ok: true }), error => reply({ ok: false, error: error.message }));
    return true;
  }
});

async function notifyEditors(message) {
  await chrome.runtime.sendMessage(message).catch(() => {});
}

async function resetEditorTab(tab, url) {
  let finish;
  const loaded = new Promise(resolve => { finish = resolve; });
  const updated = (id, change, current) => {
    if (id === tab.id && change.status === "complete" && current.url === url) finish();
  };
  const removed = id => { if (id === tab.id) finish(); };
  chrome.tabs.onUpdated.addListener(updated);
  chrome.tabs.onRemoved.addListener(removed);
  try {
    await chrome.tabs.update(tab.id, { url });
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete" && current.url === url) finish();
    await loaded;
  } catch (error) {
    // Closing a tab releases its editor too. Other navigation errors must surface.
    if (await chrome.tabs.get(tab.id).then(() => true, () => false)) throw error;
  } finally {
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.tabs.onRemoved.removeListener(removed);
  }
}

async function clearEverything() {
  clearError = null;
  try {
    const job = running;
    if (job) {
      job.discard = true;
      job.cancelled = "Захват отменён: удаляются все локальные данные.";
      await job.done;
    }
    await notifyEditors({ type: "FPSE_WILL_CLEAR" });
    const editorURL = chrome.runtime.getURL("editor.html");
    const tabs = (await chrome.tabs.query({})).filter(tab => tab.url?.split("?")[0] === editorURL);
    // Reload every editor, including older versions and frozen previews. New
    // editors check the barrier before opening IndexedDB, so it stays deleted.
    await Promise.all(tabs.map(tab => resetEditorTab(tab, `${editorURL}?cleared=1`)));
    await deleteAllData();
    for (const key of await caches.keys()) await caches.delete(key);
    lastCaptureStart = -Infinity;
  } catch (error) {
    clearError = error.message || String(error);
    throw error;
  } finally {
    clearing = null;
    await notifyEditors({ type: "FPSE_CLEAR_COMPLETE", error: clearError });
  }
}

chrome.tabs.onActivated.addListener(info => {
  if (running && info.windowId === running.windowId && info.tabId !== running.tabId) running.cancelled = "Захват прерван: активная вкладка изменилась.";
});
chrome.tabs.onRemoved.addListener(id => {
  if (running?.tabId === id) running.cancelled = "Исходная вкладка закрыта.";
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (running?.tabId === id && change.status === "loading") running.cancelled = "Захват прерван: страница перезагрузилась.";
});

async function send(job, type, data = {}) {
  const result = await chrome.tabs.sendMessage(job.tabId, { type, id: job.id, ...data }, { frameId: 0 });
  if (!result?.ok) throw new Error(result?.error || "Страница не ответила на запрос захвата.");
  return result.data;
}

function check(job) {
  if (job.cancelled) throw new Error(job.cancelled);
  if (Date.now() - job.started > MAX_DURATION) throw new Error("Превышен лимит захвата (4 минуты). Разделите страницу или уменьшите её длину.");
}

async function assertActive(job) {
  check(job);
  const [tab] = await chrome.tabs.query({ active: true, windowId: job.windowId });
  if (tab?.id !== job.tabId) throw new Error("Активная вкладка изменилась. Захват остановлен.");
}

async function setProgress(job, text, percent) {
  await chrome.action.setBadgeText({ tabId: job.tabId, text: `${Math.round(percent)}%` });
  await send(job, "FPSE_PROGRESS", { text, percent });
}

async function capturePage(tab, job) {
  job.started = Date.now();
  const record = { id: job.id, title: tab.title || "Screenshot", url: tab.url || "", createdAt: job.started,
    status: "capturing", frames: [], warnings: [], diagnostics: {
      version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent
    } };
  let injected = false;
  try {
    await putCapture(record);
    await pruneCaptures(job.id);
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#7964f4" });
    if (!tab.id || !/^(https?:|file:)/.test(tab.url || "")) throw new Error("Эта страница защищена Chrome. Откройте обычную HTTP(S)-страницу. Для file:// включите доступ к файлам в настройках расширения.");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    injected = true;
    await send(job, "FPSE_BEGIN");
    await setProgress(job, "Подготовка страницы и загрузка изображений…", 0);
    let metrics = await send(job, "FPSE_METRICS");
    const warmStarted = Date.now();
    let steps = 0, y = 0;
    // Scroll to trigger IntersectionObserver/custom lazy loaders before dimensions are frozen.
    while (true) {
      check(job);
      if (++steps > MAX_FRAMES || Date.now() - warmStarted > 60000) throw new Error("Страница слишком длинная или постоянно растёт: предзагрузка не завершилась за минуту.");
      metrics = await send(job, "FPSE_WARM", { x: 0, y });
      if (metrics.y + metrics.viewportHeight >= metrics.height - 1) break;
      y = Math.min(metrics.height - metrics.viewportHeight, y + metrics.viewportHeight * 0.85);
      await setProgress(job, `Загрузка изображений · участок ${steps}`, Math.min(14, 14 * y / metrics.height));
    }
    metrics = await send(job, "FPSE_MOVE", { x: 0, y: 0, first: true });
    const initial = { ...metrics };
    record.diagnostics.viewport = initial;
    const xs = planAxis(metrics.width, metrics.viewportWidth), ys = planAxis(metrics.height, metrics.viewportHeight);
    const count = xs.length * ys.length;
    if (count > MAX_FRAMES) throw new Error(`Нужно ${count} кадров, лимит — ${MAX_FRAMES}. Сократите страницу.`);
    let scaleX, scaleY, index = 0, bytes = 0;
    for (let row = 0; row < ys.length; row++) {
      for (let col = 0; col < xs.length; col++) {
        await assertActive(job);
        await setProgress(job, `Захват ${index + 1} из ${count} · Esc для отмены`, 15 + 84 * index / count);
        const current = await send(job, "FPSE_MOVE", { x: xs[col], y: ys[row], first: index === 0 });
        if (Math.abs(current.innerWidth - initial.innerWidth) > 0.1 || Math.abs(current.innerHeight - initial.innerHeight) > 0.1 || current.dpr !== initial.dpr || current.visualScale !== initial.visualScale) {
          throw new Error("Размер окна или масштаб изменился во время захвата. Повторите при неизменном размере окна.");
        }
        if (Math.abs(current.width - initial.width) > 1 || Math.abs(current.height - initial.height) > 1) throw new Error("Размер страницы изменился после предзагрузки. Дождитесь загрузки содержимого и повторите.");
        if (Math.abs(current.x - xs[col]) > 1 || Math.abs(current.y - ys[row]) > 1) throw new Error("Страница блокирует прокрутку. Вложенные скроллеры пока не поддерживаются.");
        await sleep(captureDelay(lastCaptureStart, Date.now()));
        await assertActive(job);
        await send(job, "FPSE_HIDE");
        lastCaptureStart = Date.now();
        const dataURL = await chrome.tabs.captureVisibleTab(job.windowId, { format: "png" });
        await assertActive(job);
        const after = await send(job, "FPSE_VERIFY");
        if (Math.abs(after.x - current.x) > 0.5 || Math.abs(after.y - current.y) > 0.5 || after.dpr !== current.dpr || after.innerWidth !== current.innerWidth || after.innerHeight !== current.innerHeight) throw new Error("Страница сдвинулась во время снимка. Повторите захват, не прокручивая страницу.");
        const blob = pngDataURLToBlob(dataURL);
        const bitmap = await createImageBitmap(blob);
        try {
          if (!index) {
            scaleX = inferPixelScale(bitmap.width, bitmap.height, current.innerWidth, current.innerHeight, current);
            // Pixels are square. The last fractional physical row may be clipped by Chrome;
            // dividing that rounded height by innerHeight would accumulate drift on long pages.
            scaleY = scaleX;
            record.width = Math.round(initial.width * scaleX);
            record.height = Math.round(initial.height * scaleY);
            record.scaleX = scaleX; record.scaleY = scaleY; record.dpr = current.dpr;
            record.diagnostics.scale = scaleX;
          } else if (bitmap.width !== record.bitmapWidth || bitmap.height !== record.bitmapHeight) throw new Error("Размер кадра изменился во время захвата.");
          record.bitmapWidth = bitmap.width; record.bitmapHeight = bitmap.height;
          const frame = { index, row, col, cssX: current.x, cssY: current.y,
            originX: Math.round(current.x * scaleX), originY: Math.round(current.y * scaleY),
            pixelWidth: contentPixelExtent(bitmap.width, current.viewportWidth, current.visualWidth, scaleX),
            pixelHeight: contentPixelExtent(bitmap.height, current.viewportHeight, current.visualHeight, scaleY),
            bitmapWidth: bitmap.width, bitmapHeight: bitmap.height };
          record.diagnostics.lastFrame = frame;
          await putFrame({ captureId: job.id, index, blob });
          record.frames.push(frame);
          bytes += blob.size;
          if (bytes > 512 * 1024 * 1024) throw new Error("Снимки заняли более 512 МБ. Разделите страницу на более короткие части.");
          record.bytes = bytes;
          await putCapture(record);
        } finally { bitmap.close(); }
        index++;
      }
    }
    check(job);
    const plan = buildStitchPlan(record.frames, xs.length, ys.length, initial.width, initial.height, scaleX);
    record.frames = plan.frames; record.width = plan.width; record.height = plan.height;
    record.diagnostics.edgeAdjustment = plan.edgeAdjustment;
    record.status = "ready";
  } catch (error) {
    record.status = job.cancelled ? "cancelled" : "error";
    record.error = error.message || String(error);
    record.diagnostics.failure = error.details || { message: record.error };
    if (error.name === "QuotaExceededError") record.error = "Недостаточно локального места. Удалите старые снимки в редакторе и повторите.";
    // No incomplete image is ever presented as a successful capture.
    await deleteCapture(job.id).catch(() => {});
    record.frames = [];
  } finally {
    if (injected) await send(job, "FPSE_RESTORE").catch(() => {});
    if (!job.discard) await putCapture(record).catch(error => { record.status = "error"; record.error = `Не удалось сохранить снимок в IndexedDB: ${error.message}`; });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
    if (!job.discard) {
      const url = new URL(chrome.runtime.getURL("editor.html"));
      url.searchParams.set("id", job.id);
      if (record.status !== "ready") url.searchParams.set("error", record.error || "Захват отменён.");
      await chrome.tabs.create({ url: url.href, active: record.status !== "cancelled" }).catch(() => {});
    }
    if (running === job) running = null;
  }
}
