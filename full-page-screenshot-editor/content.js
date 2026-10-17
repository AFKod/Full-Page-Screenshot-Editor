(() => {
  // Injection is idempotent; listener lives in the isolated extension world.
  if (globalThis.__FPSE_INSTALLED__) return;
  globalThis.__FPSE_INSTALLED__ = true;
  let session = null;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  function metrics() {
    const root = document.documentElement, body = document.body;
    return { x: scrollX, y: scrollY, width: Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth),
      height: Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight),
      viewportWidth: Math.min(innerWidth, root.clientWidth || innerWidth),
      viewportHeight: Math.min(innerHeight, root.clientHeight || innerHeight),
      visualWidth: visualViewport?.width, visualHeight: visualViewport?.height,
      innerWidth, innerHeight, dpr: devicePixelRatio, visualScale: visualViewport?.scale || 1 };
  }

  function check(s) {
    if (session !== s) throw new Error("Сеанс захвата завершён.");
    s.touched = Date.now();
  }

  function setProperty(s, element, name, value) {
    let saved = s.styles.get(element);
    if (!saved) { saved = { attribute: element.getAttribute("style"), properties: new Map() }; s.styles.set(element, saved); }
    if (!saved.properties.has(name)) saved.properties.set(name, [element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
    element.style.setProperty(name, value, "important");
  }

  function scan(s, root = document.documentElement) {
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (element === s.host || element === s.sheet || s.seen.has(element)) continue;
      s.seen.add(element);
      if (element instanceof HTMLImageElement && element.loading === "lazy") {
        s.images.set(element, element.getAttribute("loading"));
        element.loading = "eager";
      }
      const position = getComputedStyle(element).position;
      if (getComputedStyle(element).contentVisibility === "auto") setProperty(s, element, "content-visibility", "visible");
      if (position === "fixed") s.fixed.add(element);
      if (position === "sticky" || position === "-webkit-sticky") {
        // Keep sticky content in its natural document flow, so it is captured once.
        setProperty(s, element, "position", "relative");
        for (const edge of ["top", "right", "bottom", "left"]) setProperty(s, element, edge, "auto");
      }
    }
    if (!s.first) for (const element of s.fixed) setProperty(s, element, "visibility", "hidden");
  }

  function restore() {
    const s = session;
    if (!s) return;
    session = null;
    clearInterval(s.watchdog);
    s.observer?.disconnect();
    for (const [name, handler, options] of s.listeners) window.removeEventListener(name, handler, options);
    // Scroll while smooth scrolling/snap are still disabled.
    window.scrollTo({ left: s.scrollX, top: s.scrollY, behavior: "instant" });
    for (const [element, saved] of s.styles) {
      // Restore the attribute too: CSSOM normalizes serialization and can leave style="".
      // Only elements whose inline styles were changed by this session are included.
      if (saved.attribute === null) element.removeAttribute("style");
      else element.setAttribute("style", saved.attribute);
    }
    for (const [image, loading] of s.images) {
      if (loading === null) image.removeAttribute("loading"); else image.setAttribute("loading", loading);
    }
    s.sheet?.remove(); s.host?.remove();
  }

  function cancel(reason) {
    const s = session;
    if (!s) return;
    restore();
    void chrome.runtime.sendMessage({ type: "FPSE_CANCEL", id: s.id, reason }).catch(() => {});
  }

  async function begin(id) {
    restore();
    if (!document.body) throw new Error("Страница ещё не готова. Дождитесь её загрузки.");
    if ((visualViewport?.scale || 1) !== 1) throw new Error("Сбросьте жестовый (pinch) зум страницы. Обычный масштаб Chrome поддерживается.");
    const s = { id, scrollX, scrollY, styles: new Map(), images: new Map(), fixed: new Set(),
      seen: new WeakSet(), first: true, touched: Date.now(), listeners: [] };
    session = s;
    try {
      const sheet = document.createElement("style");
      sheet.textContent = `html, body, * { scroll-behavior: auto !important; scroll-snap-type: none !important;
        overflow-anchor: none !important; animation-play-state: paused !important;
        transition: none !important; caret-color: transparent !important; }`;
      s.sheet = sheet; document.documentElement.append(sheet);
      for (const element of [document.documentElement, document.body]) {
        setProperty(s, element, "scroll-behavior", "auto");
        setProperty(s, element, "scroll-snap-type", "none");
        setProperty(s, element, "overflow-anchor", "none");
      }
      const host = document.createElement("div");
      s.host = host;
      host.style.cssText = "all:initial!important;position:fixed!important;right:20px!important;top:20px!important;z-index:2147483647!important;visibility:visible!important;";
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `<style>:host{color-scheme:dark}section{box-sizing:border-box;width:320px;padding:18px;background:#191b26;color:#f4f3ff;border:1px solid #77708d;border-radius:14px;box-shadow:0 10px 40px #0006;font:13px/1.5 system-ui,sans-serif}strong{display:block;font-size:14px;margin-bottom:6px}p{margin:6px 0 12px;color:#c8c5dc}progress{width:100%;height:8px;accent-color:#a99aff}button{margin-top:12px;background:#343044;color:white;border:1px solid #746989;border-radius:7px;padding:7px 12px;cursor:pointer}</style><section role="status"><strong>Full Page Screenshot Editor</strong><p>Подготовка захвата…</p><progress max="100" value="0"></progress><button type="button">Отменить · Esc</button></section>`;
      s.label = shadow.querySelector("p"); s.progress = shadow.querySelector("progress");
      shadow.querySelector("button").addEventListener("click", () => cancel("Захват отменён."));
      document.documentElement.append(host);
      const onKey = event => {
        if (["Escape", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); cancel("Захват отменён с клавиатуры.");
        }
      };
      const onScrollIntent = event => { event.preventDefault(); cancel("Захват отменён: пользователь начал прокрутку."); };
      const onHidden = () => { if (document.hidden) cancel("Захват отменён: вкладка скрыта."); };
      const onLeave = () => restore();
      s.listeners = [["keydown", onKey, true], ["wheel", onScrollIntent, { passive: false, capture: true }],
        ["touchmove", onScrollIntent, { passive: false, capture: true }], ["visibilitychange", onHidden, true], ["pagehide", onLeave, true]];
      for (const [name, handler, options] of s.listeners) window.addEventListener(name, handler, options);
      scan(s);
      s.observer = new MutationObserver(records => {
        if (session !== s) return;
        for (const record of records) for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(s, node);
      });
      s.observer.observe(document.documentElement, { childList: true, subtree: true });
      s.watchdog = setInterval(() => {
        if (Date.now() - s.touched > 15000) cancel("Связь с расширением потеряна. Положение страницы восстановлено.");
      }, 2000);
      await Promise.race([document.fonts.ready, delay(1200)]);
      check(s);
      return metrics();
    } catch (error) { restore(); throw error; }
  }

  async function waitForImages(s) {
    const visible = [...document.images].filter(image => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    });
    await Promise.race([Promise.allSettled(visible.map(image => image.decode())), delay(900)]);
    check(s);
  }

  async function move(s, message, warm) {
    check(s);
    s.host.style.setProperty("visibility", "visible", "important");
    s.first = !!message.first;
    // Fixed chrome appears once in the first frame; it is hidden everywhere else.
    for (const element of s.fixed) {
      if (s.first) {
        const saved = s.styles.get(element)?.properties.get("visibility");
        if (saved?.[0]) element.style.setProperty("visibility", ...saved);
        else element.style.removeProperty("visibility");
      } else setProperty(s, element, "visibility", "hidden");
    }
    window.scrollTo({ left: message.x, top: message.y, behavior: "instant" });
    await paint();
    await delay(warm ? 120 : 160);
    check(s);
    await waitForImages(s);
    await paint();
    check(s);
    return metrics();
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (!message?.type?.startsWith("FPSE_")) return;
    const run = async () => {
      if (message.type === "FPSE_BEGIN") return begin(message.id);
      if (message.type === "FPSE_RESTORE") { if (session?.id === message.id) restore(); return; }
      const s = session;
      if (!s || s.id !== message.id) throw new Error("Захват завершён или отменён.");
      check(s);
      switch (message.type) {
        case "FPSE_METRICS": case "FPSE_VERIFY": return metrics();
        case "FPSE_WARM": return move(s, message, true);
        case "FPSE_MOVE": return move(s, message, false);
        case "FPSE_PROGRESS":
          s.host.style.setProperty("visibility", "visible", "important"); s.label.textContent = message.text; s.progress.value = message.percent; return;
        case "FPSE_HIDE":
          s.host.style.setProperty("visibility", "hidden", "important"); await paint(); await delay(40); check(s); return;
        default: throw new Error("Неизвестная команда.");
      }
    };
    void run().then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error.message }));
    return true;
  });
})();
