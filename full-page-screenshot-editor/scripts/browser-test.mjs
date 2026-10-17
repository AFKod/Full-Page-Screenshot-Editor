// Optional integration suite. Requires Playwright and a Chrome version exposing Extensions.triggerAction.
// It loads the real, unmodified manifest into a disposable profile and invokes the real action.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = join(root, "test-results"); await mkdir(results, { recursive: true });
const report = { date: new Date().toISOString(), passed: [], failed: [], browser: null };
const nativeScale = Number(process.env.TEST_DPR || 1.25);
report.hostPlatform = process.platform;
report.nativeDPR = nativeScale;
report.windowSize = process.env.TEST_WINDOW_SIZE || "1280,1000";
report.classicScrollbars = process.env.TEST_CLASSIC_SCROLLBARS === "1";
let context, server, profile;
const record = name => { report.passed.push(name); console.log(`PASS: ${name}`); };
try {
  const { chromium } = process.env.PLAYWRIGHT_MODULE ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : await import("playwright");
  const fixture = await readFile(join(root, "tests/fixture.html"));
  server = createServer((_req, response) => { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(fixture); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  profile = await mkdtemp(join(tmpdir(), "fpse-browser-"));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || undefined, headless: process.env.HEADED !== "1",
    viewport: null, acceptDownloads: true,
    args: ["--enable-unsafe-extension-debugging", `--window-size=${report.windowSize}`, `--force-device-scale-factor=${nativeScale}`], ignoreDefaultArgs: ["--disable-extensions", "--hide-scrollbars"]
  });
  report.browser = context.browser().version();
  console.log(`Chrome ${report.browser}`);
  context.on("console", message => { if (message.type() === "error") console.log(`Browser console: ${message.text()}`); });
  context.on("serviceworker", worker => console.log(`Worker: ${worker.url()}`));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: root });
  console.log(`Loaded extension ${id}`);
  const worker = context.serviceWorkers().find(worker => worker.url().includes(id)) || await context.waitForEvent("serviceworker");
  assert(await worker.evaluate(() => chrome.action.onClicked.hasListeners()), "Action listener not registered");
  report.extensionVersion=await worker.evaluate(()=>chrome.runtime.getManifest().version);
  const page = await context.newPage();
  const errors = [];
  context.on("page", p => p.on("pageerror", error => errors.push(error.message)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.bringToFront();
  if (report.classicScrollbars) await page.addStyleTag({ content: "html{overflow-y:scroll!important}::-webkit-scrollbar{display:block!important;width:17px!important;height:17px!important}" });
  report.fixtureViewport = await page.evaluate(()=>({innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,dpr:devicePixelRatio}));
  if (report.classicScrollbars) assert(report.fixtureViewport.clientWidth < report.fixtureViewport.innerWidth,"Classic scrollbar gutter must actually be present");
  await page.evaluate(() => scrollTo({ top: 417, behavior: "instant" }));
  const snapshot = () => page.evaluate(() => {
    const style = element => element.getAttribute("style")?.trim() || null;
    return { x: scrollX, y: scrollY, root: style(document.documentElement), body: style(document.body),
      fixed: style(document.getElementById("fixed")), sticky: style(document.getElementById("sticky")), loading: document.getElementById("lazy").getAttribute("loading"),
      fixedPosition: getComputedStyle(document.getElementById("fixed")).position, stickyPosition: getComputedStyle(document.getElementById("sticky")).position,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior };
  });
  const before = await snapshot();
  async function trigger() {
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
    const target = targetInfos.find(target => target.type === "tab" && target.url === page.url());
    assert(target, `No tab target: ${JSON.stringify(targetInfos)}`);
    await cdp.send("Extensions.triggerAction", { id, targetId: target.targetId });
  }
  async function capture() {
    await page.bringToFront(); const next = context.waitForEvent("page", { timeout: 90000 }); next.catch(() => {}); await trigger();
    let editor;
    try { editor = await next; }
    catch (error) {
      const diagnostic = await context.newPage(); await diagnostic.goto(`chrome-extension://${id}/editor.html`);
      report.diagnostic = await diagnostic.evaluate(async () => {
        const { listCaptures } = await import("./lib/db.js");
        return { captures: await listCaptures(), tabs: await chrome.tabs.query({}), workers: await navigator.serviceWorker.getRegistrations().then(registrations => registrations.map(r => ({ scope: r.scope, active: r.active?.state }))) };
      });
      console.log(JSON.stringify({captures:report.diagnostic.captures.map(c=>({id:c.id,status:c.status,frames:c.frames.length,error:c.error})),workers:report.diagnostic.workers},null,2)); throw error;
    }
    await editor.waitForURL(/editor\.html/);
    await editor.waitForFunction(() => !document.getElementById("stage-shell").hidden || document.getElementById("empty-title").textContent !== "Открываем снимок", { timeout: 90000 });
    assert(await editor.locator("#stage-shell").isVisible(), await editor.locator("#empty-text").textContent());
    return editor;
  }
  let editor = await capture();
  assert.deepEqual(await snapshot(), before);
  record("Real action + activeTab capture, DOM/CSS/scroll restoration on success");
  const info = await editor.evaluate(async () => {
    const db = await import("./lib/db.js"), c = await db.getCapture(new URLSearchParams(location.search).get("id"));
    const { createCanvas, renderRegion, releaseCanvas } = await import("./lib/render.js");
    const rect = { x: 0, y: 0, width: c.width, height: c.height }, { canvas, context } = createCanvas(c.width, c.height);
    await renderRegion(c, rect, context);
    const samples = [500, 1200, 2000, 2700, 3400].map(y => [...context.getImageData(Math.round(10 * c.scaleX), Math.round(y * c.scaleY), 1, 1).data].slice(0, 3));
    const progressPixels = [100, 150, 200].map(y => [...context.getImageData(c.width - Math.round(80 * c.scaleX), Math.round(y * c.scaleY), 1, 1).data].slice(0, 3));
    const seams = c.frames.slice(1).map(f => f.region.y).filter(y => y < c.height - 1).map(y => {
      const a = [...context.getImageData(Math.round(10 * c.scaleX), y - 1, 1, 1).data];
      const b = [...context.getImageData(Math.round(10 * c.scaleX), y, 1, 1).data]; return { y, a, b };
    });
    releaseCanvas(canvas); return { width: c.width, height: c.height, sx: c.scaleX, sy: c.scaleY, dpr:c.dpr, frames: c.frames.length, samples, seams, progressPixels };
  });
  assert.equal(info.height, Math.round(3500 * info.sy)); assert(info.frames > 1);
  assert.deepEqual(info.samples, [[247,216,219],[218,231,255],[214,241,223],[252,236,185],[222,213,245]]);
  assert(Math.abs(info.sx - info.sy) < 0.005, "Screenshot must preserve isotropic pixel scale");
  assert(Math.abs(info.dpr - nativeScale) < 0.001, `Native DPR was ${info.dpr}`);
  assert.deepEqual(info.progressPixels, [[247,216,219],[247,216,219],[247,216,219]], "Progress overlay must never be captured");
  for (const seam of info.seams) if (![700,1400,2100,2800].some(y => Math.abs(seam.y - y * info.sy) < 6)) assert.deepEqual(seam.a, seam.b, `Seam at y=${seam.y}`);
  record(`Full-page stitching + pixel colors + frame seams at DPR ${nativeScale} (${info.width}×${info.height})`);
  await editor.waitForSelector("canvas.preview");
  await editor.screenshot({ path: join(results, "editor.png") });
  await editor.locator("#crop-button").click();
  const bounds = await editor.locator("#stage").boundingBox();
  await editor.mouse.move(bounds.x + 100, bounds.y + 100); await editor.mouse.down();
  await editor.mouse.move(bounds.x + 300, bounds.y + 350, { steps: 10 }); await editor.mouse.up();
  assert(await editor.locator("#selection").isVisible());
  for (const [field, value] of Object.entries({ x: 50, y: 780, width: 400, height: 300 })) { await editor.locator(`#rect-${field}`).fill(String(value)); await editor.locator(`#rect-${field}`).dispatchEvent("change"); }
  await editor.locator("#zoom").selectOption("0.5");
  assert.equal(await editor.locator("#rect-width").inputValue(), "400");
  await editor.locator("#apply-button").click();
  assert.equal(await editor.locator("#size-width").textContent(), "400");
  record("Mouse crop, exact original-pixel fields, zoom invariance and apply");
  for (const type of ["png", "jpeg"]) {
    await editor.locator("#format").selectOption(type);
    const downloaded = editor.waitForEvent("download"); await editor.locator("#save-button").click(); const download = await downloaded;
    const path = join(results, `crop.${type === "jpeg" ? "jpg" : "png"}`); await download.saveAs(path);
    const bytes = await readFile(path);
    if (type === "png") { assert.equal(bytes.readUInt32BE(16), 400); assert.equal(bytes.readUInt32BE(20), 300); }
    else assert.equal(bytes.readUInt16BE(0), 0xffd8);
    const size = await editor.evaluate(async ({ base64, type }) => { const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], {type:`image/${type}`}); const image = await createImageBitmap(blob); const size = [image.width, image.height]; image.close(); return size; }, { base64: bytes.toString("base64"), type });
    assert.deepEqual(size, [400,300]); record(`${type.toUpperCase()} download with exact 400×300 original-pixel crop`);
  }
  await editor.locator("#copy-button").click();
  await editor.waitForFunction(() => /скопирован|буфер|clipboard/i.test(document.getElementById("status").textContent) && document.getElementById("cancel-export").hidden);
  assert.match(await editor.locator("#status").textContent(), /скопирован/);
  record("PNG clipboard write from editor user gesture");
  // Cancellation must restore state even during the preload sweep.
  await page.bringToFront(); const cancelledEditor = context.waitForEvent("page"); await trigger();
  await page.waitForFunction(() => [...document.documentElement.children].some(el => el.shadowRoot || el.tagName === "DIV" && el.style.zIndex === "2147483647"));
  await page.keyboard.press("Escape"); const cancelled = await cancelledEditor;
  await cancelled.waitForURL(/editor\.html/); await cancelled.waitForFunction(() => /отменён/.test(document.getElementById("empty-title").textContent));
  assert.deepEqual(await snapshot(), before); record("Escape cancellation restores scroll, styles and lazy image attributes");
  await cancelled.close();
  // A real tab zoom exercises CSS-to-bitmap scale inference independently of DPR.
  const sourceTabId = await editor.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  assert(sourceTabId);
  await editor.evaluate(async tabId => chrome.tabs.setZoom(tabId, 1.25), sourceTabId);
  await page.bringToFront();
  const zoomState = await snapshot();
  const zoomed = await capture();
  const zoomInfo = await zoomed.evaluate(async () => { const { getCapture } = await import("./lib/db.js"); const c = await getCapture(new URLSearchParams(location.search).get("id")); return { height:c.height, scale:c.scaleY, sx:c.scaleX, dpr:c.dpr }; });
  assert.equal(zoomInfo.height, Math.round(3500 * zoomInfo.scale)); assert(zoomInfo.scale > info.sy);
  assert(Math.abs(zoomInfo.sx - zoomInfo.scale) < 0.005);
  assert.deepEqual(await snapshot(), zoomState); record(`Capture at Chrome zoom 125% + native DPR ${nativeScale} (inferred scale ${zoomInfo.scale})`);
  // Inject an API failure in the worker, then verify the production error/finally path.
  await page.bringToFront();
  await worker.evaluate(() => {
    globalThis.__originalCaptureForTest = chrome.tabs.captureVisibleTab;
    let count=0;
    chrome.tabs.captureVisibleTab = async (...args) => {
      if (++count===2) throw new Error("TEST: forced capture failure");
      return globalThis.__originalCaptureForTest(...args);
    };
  });
  const failedPage = context.waitForEvent("page"); failedPage.catch(() => {}); await trigger();
  const failed = await failedPage; await failed.waitForURL(/editor\.html/);
  await failed.waitForFunction(() => document.getElementById("empty-text").textContent.includes("forced capture failure"));
  assert.deepEqual(await snapshot(), zoomState);
  await worker.evaluate(() => { chrome.tabs.captureVisibleTab = globalThis.__originalCaptureForTest; delete globalThis.__originalCaptureForTest; });
  const failedInfo = await failed.evaluate(async () => {
    const db = await import("./lib/db.js"), c = await db.getCapture(new URLSearchParams(location.search).get("id"));
    return { status:c.status, count:c.frames.length, frame:await db.getFrame(c.id,0) };
  });
  assert.deepEqual(failedInfo, { status:"error", count:0, frame:undefined });
  record("Capture API error restores page, reports error and removes incomplete frames");
  const diagnosticDownload = failed.waitForEvent("download"); await failed.locator("#diagnostics-button").click();
  const diagnosticFile = await diagnosticDownload; const diagnosticPath = join(results,"capture-diagnostics.json");
  await diagnosticFile.saveAs(diagnosticPath);
  const diagnosticJSON = JSON.parse(await readFile(diagnosticPath,"utf8"));
  assert.equal(diagnosticJSON.status,"error"); assert(diagnosticJSON.viewport && diagnosticJSON.lastFrame);
  assert(!("url" in diagnosticJSON)); record("Failed capture can export numeric diagnostics without image or page URL");

  // Regression: emulate a capture backend rounding the physical viewport down.
  // This changes only returned PNGs in the test worker; production source is unchanged.
  await worker.evaluate(() => {
    globalThis.__originalCaptureForTest = chrome.tabs.captureVisibleTab;
    chrome.tabs.captureVisibleTab = async (...args) => {
      const dataURL = await globalThis.__originalCaptureForTest(...args);
      const bytes = Uint8Array.from(atob(dataURL.split(",")[1]), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes],{type:"image/png"}));
      const canvas = new OffscreenCanvas(bitmap.width,bitmap.height-2);
      canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();
      const encoded = new Uint8Array(await (await canvas.convertToBlob({type:"image/png"})).arrayBuffer());
      let binary=""; for(let i=0;i<encoded.length;i+=32768) binary+=String.fromCharCode(...encoded.subarray(i,i+32768));
      return `data:image/png;base64,${btoa(binary)}`;
    };
  });
  const rounded = await capture();
  const roundedInfo = await rounded.evaluate(async()=>{
    const {getCapture}=await import("./lib/db.js"),{createCanvas,renderRegion,releaseCanvas}=await import("./lib/render.js");
    const c=await getCapture(new URLSearchParams(location.search).get("id"));
    const rect={x:0,y:c.height-1,width:1,height:1},{canvas,context}=createCanvas(1,1);
    await renderRegion(c,rect,context);const pixel=[...context.getImageData(0,0,1,1).data];releaseCanvas(canvas);
    return {adjustment:c.diagnostics.edgeAdjustment,pixel};
  });
  assert(roundedInfo.adjustment.bottom>0 && roundedInfo.adjustment.bottom<=Math.ceil(nativeScale*1.25)+2);
  // The fixture ends in a 4 CSS px dark border. A missing/blank last row would be white.
  assert.deepEqual(roundedInfo.pixel,[23,34,57,255]); assert.deepEqual(await snapshot(),zoomState);
  await worker.evaluate(()=>{chrome.tabs.captureVisibleTab=globalThis.__originalCaptureForTest;delete globalThis.__originalCaptureForTest;});
  record("Rounded-down PNG regression: real capture, complete stitch, valid last pixel, no resampling");

  // Seed a very tall local image from small real Canvas-generated frames. This tests
  // rendering/export beyond a single conservative canvas allocation, without a giant canvas.
  const largeId = await editor.evaluate(async () => {
    const db = await import("./lib/db.js");
    const id = crypto.randomUUID(), canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 1000;
    const context = canvas.getContext("2d"); context.fillStyle = "#28a176"; context.fillRect(0,0,64,1000);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,"image/png"));
    const frames=[];
    for(let index=0;index<20;index++) {
      await db.putFrame({captureId:id,index,blob});
      frames.push({index,originX:0,originY:index*1000,region:{x:0,y:index*1000,width:64,height:1000}});
    }
    await db.putCapture({id,title:"Tall export fixture",createdAt:Date.now(),url:"",status:"ready",width:64,height:20000,frames});
    canvas.width=canvas.height=1; return id;
  });
  const large=await context.newPage(); await large.goto(`chrome-extension://${id}/editor.html?id=${largeId}`);
  await large.waitForSelector("canvas.preview");
  const canvasPixels=await large.locator("canvas.preview").evaluate(canvas=>canvas.width*canvas.height);
  assert(canvasPixels<=4100000);
  const wholeTallDownload=large.waitForEvent("download"); await large.locator("#save-button").click();
  const wholeTall=await wholeTallDownload, wholeTallPath=join(results,"tall-whole.png");await wholeTall.saveAs(wholeTallPath);
  const wholeTallBytes=await readFile(wholeTallPath);assert.equal(wholeTallBytes.readUInt32BE(16),64);assert.equal(wholeTallBytes.readUInt32BE(20),20000);
  assert(await large.locator("#parts-panel").isHidden());
  record("Default Save exports 64×20,000 as one PNG beyond the old canvas edge budget");
  await large.locator("#parts-button").click();
  await large.locator("#parts-panel").waitFor();
  const partButtons=large.locator("#parts-list button"); assert.equal(await partButtons.count(),4);
  const partDownload=large.waitForEvent("download"); await partButtons.nth(2).click();
  const part=await partDownload, partPath=join(results,"tall-part-003.png"); await part.saveAs(partPath);
  const partBytes=await readFile(partPath); assert.equal(partBytes.readUInt32BE(16),64); assert.equal(partBytes.readUInt32BE(20),3616);
  const finalPixel=await large.evaluate(async base64=>{
    const blob=new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:"image/png"});
    const image=await createImageBitmap(blob),canvas=document.createElement("canvas");canvas.width=64;canvas.height=3616;
    const context=canvas.getContext("2d");context.drawImage(image,0,0);image.close();
    const pixel=[...context.getImageData(32,3615,1,1).data];canvas.width=canvas.height=1;return pixel;
  },partBytes.toString("base64"));
  assert.deepEqual(finalPixel,[40,161,118,255]);
  await large.locator("#copy-button").click(); assert.match(await large.locator("#status").textContent(),/слишком велика/);
  record("20,000 px virtualized editor, lossless split export, final part dimensions and clipboard size guard");

  // Actual dimensions from screenshot-parts.json supplied by the user. Generate
  // local pixel fixtures; the JSON itself contains no screenshot pixels.
  const userSizeId=await editor.evaluate(async()=>{
    const {putCapture,putFrame}=await import("./lib/db.js"),id=crypto.randomUUID(),frames=[];
    const canvas=document.createElement("canvas");canvas.width=3817;
    for(let y=0,index=0;y<10190;y+=1000,index++){
      const height=Math.min(1000,10190-y);canvas.height=height;const context=canvas.getContext("2d");
      context.fillStyle=index%2?"#e65f58":"#2f80ed";context.fillRect(0,0,3817,height);
      context.fillStyle="#1f2937";context.fillRect(3816,0,1,height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
      await putFrame({captureId:id,index,blob});frames.push({index,originX:0,originY:y,region:{x:0,y,width:3817,height}});
    }
    canvas.width=canvas.height=1;
    await putCapture({id,title:"User size regression",createdAt:Date.now(),status:"ready",width:3817,height:10190,frames});return id;
  });
  const userSize=await context.newPage();await userSize.goto(`chrome-extension://${id}/editor.html?id=${userSizeId}`);
  await userSize.waitForSelector("canvas.preview");
  await userSize.locator("#crop-button").click();
  const userBounds=await userSize.locator("#stage").boundingBox();
  await userSize.mouse.move(userBounds.x+20,userBounds.y+20);await userSize.mouse.down();await userSize.mouse.move(userBounds.x+100,userBounds.y+100);await userSize.mouse.up();
  for(const [field,value] of Object.entries({x:0,y:0,width:3817,height:5413})){
    await userSize.locator(`#rect-${field}`).fill(String(value));await userSize.locator(`#rect-${field}`).dispatchEvent("change");
  }
  await userSize.locator("#apply-button").click();
  let userDownloads=0;userSize.on("download",()=>userDownloads++);
  for(const height of [5413,10190]){
    if(height===10190)await userSize.locator("#reset-button").click();
    for(const type of ["png","jpeg"]){
      await userSize.locator("#format").selectOption(type);
      const previous=userDownloads,next=userSize.waitForEvent("download",{timeout:90000});
      await userSize.locator("#save-button").click();const file=await next;
      const filePath=join(results,`user-size-${height}.${type==="png"?"png":"jpg"}`);await file.saveAs(filePath);
      const data=await readFile(filePath);
      const decoded=await userSize.evaluate(async({base64,type,height})=>{
        const blob=new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:`image/${type}`});
        const bitmap=await createImageBitmap(blob),canvas=document.createElement("canvas");canvas.width=canvas.height=1;const context=canvas.getContext("2d");
        const points=[[10,0],[10,999],[10,1000],[10,4394],[10,4395],[10,height-1],[3816,height-1]];
        const pixels=points.map(([x,y])=>{context.drawImage(bitmap,x,y,1,1,0,0,1,1);return [...context.getImageData(0,0,1,1).data];});
        const result={width:bitmap.width,height:bitmap.height,pixels};bitmap.close();canvas.width=canvas.height=1;return result;
      },{base64:data.toString("base64"),type,height});
      assert.equal(decoded.width,3817);assert.equal(decoded.height,height);assert.equal(userDownloads,previous+1);
      assert(await userSize.locator("#parts-panel").isHidden());
      if(type==="png"){
        const blue=[47,128,237,255],red=[230,95,88,255];
        assert.deepEqual(decoded.pixels,[blue,blue,red,blue,blue,height===5413?red:blue,[31,41,55,255]]);
      }
      record(`One ${type.toUpperCase()} at exact user dimensions 3817×${height}, native decode and single download`);
    }
  }

  await page.bringToFront();
  await page.evaluate(()=>{document.body.style.width="2400px";scrollTo({left:350,top:1000,behavior:"instant"});});
  const wideState=await snapshot();const wide=await capture();
  const wideInfo=await wide.evaluate(async()=>{
    const {getCapture}=await import("./lib/db.js"),{createCanvas,renderRegion,releaseCanvas}=await import("./lib/render.js");
    const c=await getCapture(new URLSearchParams(location.search).get("id"));
    const rect={x:0,y:Math.round(1200*c.scaleY),width:c.width,height:5};const {canvas,context}=createCanvas(rect.width,rect.height);
    await renderRegion(c,rect,context);const pixels=[10,800,1400,2000,2390].map(x=>[...context.getImageData(Math.round(x*c.scaleX),2,1,1).data].slice(0,3));
    releaseCanvas(canvas);return {width:c.width,scale:c.scaleX,columns:Math.max(...c.frames.map(f=>f.col))+1,pixels};
  });
  assert.equal(wideInfo.width,Math.round(2400*wideInfo.scale));assert(wideInfo.columns>1);
  assert.deepEqual(wideInfo.pixels,Array(5).fill([218,231,255]));assert.deepEqual(await snapshot(),wideState);
  record("Horizontal + vertical full-page grid stitching and restoration of both scroll axes");

  if (process.env.TEST_PUBLIC_URL) {
    await editor.evaluate(async tabId=>chrome.tabs.setZoom(tabId,1),sourceTabId);
    await page.goto(process.env.TEST_PUBLIC_URL,{waitUntil:"load",timeout:60000});
    await page.waitForTimeout(1500); await page.bringToFront();
    const initialPublicScroll = await page.evaluate(()=>({x:scrollX,y:scrollY}));
    const publicEditor = await capture();
    report.publicPage = await publicEditor.evaluate(async()=>{
      const {getCapture}=await import("./lib/db.js"); const c=await getCapture(new URLSearchParams(location.search).get("id"));
      return {width:c.width,height:c.height,frames:c.frames.length,diagnostics:c.diagnostics};
    });
    assert.deepEqual(await page.evaluate(()=>({x:scrollX,y:scrollY})),initialPublicScroll);
    record(`Public page ${process.env.TEST_PUBLIC_URL}: full capture ${report.publicPage.width}×${report.publicPage.height} at native DPR ${nativeScale}`);
  }

  await page.goto("chrome://version");await page.bringToFront();
  const restrictedEditor=context.waitForEvent("page");restrictedEditor.catch(()=>{});await trigger();
  const restricted=await restrictedEditor;await restricted.waitForURL(/editor\.html/);
  await restricted.waitForFunction(()=>document.getElementById("empty-text").textContent.includes("защищена Chrome"));
  record("Restricted chrome:// page reports a clear error without injection");

  await userSize.locator("#zoom").selectOption("fit");
  for (const width of [1600, 1000, 790, 590, 810, 1450, 1100, 1280]) {
    await userSize.setViewportSize({ width, height: 820 });
    await userSize.waitForFunction(() => {
      const workspace=document.getElementById("workspace"),stage=document.getElementById("stage");
      const expected=3817*Math.min(1,Math.max(.01,(workspace.clientWidth-88)/3817));
      return Math.abs(stage.getBoundingClientRect().width-expected)<.1;
    });
    assert(await userSize.locator("#clear-all-button").isVisible());
  }
  const settled=await userSize.evaluate(async()=>{
    const sizes=[];
    for(let i=0;i<12;i++){
      await new Promise(requestAnimationFrame);
      const w=document.getElementById("workspace"),s=document.getElementById("stage");
      sizes.push([w.clientWidth,w.clientHeight,s.style.width,s.style.height,document.getElementById("zoom-label").textContent]);
    }
    return sizes;
  });
  assert(settled.every(size=>JSON.stringify(size)===JSON.stringify(settled[0])));
  record("Responsive editor resize across 8 widths settles without ResizeObserver errors or layout oscillation");

  // Seed all storage types the extension owns, including an orphan frame, then
  // clear while an export still holds decoded pixels. No test-only permissions.
  const openEditors=context.pages().filter(p=>p.url().startsWith(`chrome-extension://${id}/editor.html`));
  for(const p of openEditors)await p.evaluate(()=>{
    localStorage.setItem("cleanup-test","page metadata");sessionStorage.setItem("cleanup-test","session metadata");
  });
  await editor.evaluate(async()=>{
    const {putFrame}=await import("./lib/db.js");
    await putFrame({captureId:"orphan-without-metadata",index:0,blob:new Blob(["orphan pixels"])});
    const cache=await caches.open("cleanup-test");await cache.put("https://cleanup.invalid/temporary-data",new Response("temporary data"));
  });
  let revokedURLs=0;
  await editor.exposeFunction("__observeRevoke",()=>{revokedURLs++;});
  await editor.evaluate(()=>{
    const revoke=URL.revokeObjectURL;
    URL.revokeObjectURL=url=>{revoke.call(URL,url);void globalThis.__observeRevoke();};
  });
  await editor.locator("#format").selectOption("png");
  const beforeClearDownload=editor.waitForEvent("download");await editor.locator("#save-button").click();await beforeClearDownload;
  await editor.waitForFunction(()=>document.getElementById("cancel-export").hidden);
  // Delay image decoding to make an in-flight export deterministic.
  await userSize.evaluate(()=>{
    const decode=createImageBitmap;
    globalThis.createImageBitmap=async(...args)=>{const image=await decode(...args);await new Promise(resolve=>setTimeout(resolve,2000));return image;};
  });
  await userSize.locator("#format").selectOption("png");
  const completedDownloads=userDownloads;
  await userSize.locator("#save-button").click();
  assert(await userSize.locator("#cancel-export").isVisible());
  const oldEditorURL=editor.url();
  await editor.locator("#clear-all-button").click();
  for(const p of openEditors){
    await p.waitForURL(/editor\.html\?cleared=1$/);
    await p.waitForFunction(()=>document.getElementById("empty-title").textContent==="Все данные удалены");
    const state=await p.evaluate(async()=>({
      databases:(await indexedDB.databases()).map(db=>db.name),caches:await caches.keys(),
      local:localStorage.length,session:sessionStorage.length,canvases:document.querySelectorAll("canvas").length,
      saveDisabled:document.getElementById("save-button").disabled,title:document.title
    }));
    assert.deepEqual(state,{databases:[],caches:[],local:0,session:0,canvases:0,saveDisabled:true,title:"Full Page Screenshot Editor"});
  }
  assert(revokedURLs>0,"Pending download Blob URLs must be explicitly revoked");
  assert.equal(userDownloads,completedDownloads,"Aborted export must not initiate a late download");
  assert((await readFile(join(results,"crop.png"))).length>0,"Previously downloaded user files must remain");
  record("Clear all deletes the database (including orphan frames), caches and web storage, resets all editors and revokes Blob URLs during export");

  await editor.goto(oldEditorURL);
  await editor.waitForFunction(()=>document.getElementById("empty-title").textContent==="Снимок недоступен");
  assert(await editor.locator("#save-button").isDisabled());
  await editor.locator("#library-button").click();
  await editor.locator("#library").waitFor({state:"visible"});
  assert.match(await editor.locator("#library-list").textContent(),/Сохранённых снимков пока нет/);
  await editor.locator("#clear-clipboard").click();
  await editor.waitForFunction(()=>document.getElementById("status").textContent.includes("буфера обмена очищено"));
  record("Deleted IDs cannot reopen images; library is empty; separate clipboard-clear button succeeds");
  await editor.locator("#library-clear-all").click();
  await editor.waitForFunction(()=>document.getElementById("empty-title").textContent==="Все данные удалены");
  assert.deepEqual(await editor.evaluate(()=>indexedDB.databases()),[]);
  record("Clear all from library is repeatable and leaves no database behind");

  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.bringToFront();
  await page.evaluate(()=>scrollTo({top:417,behavior:"instant"}));
  const beforeClearCapture=await snapshot();
  await trigger();
  await page.waitForFunction(()=>[...document.documentElement.children].some(el=>el.tagName==="DIV" && el.style.zIndex==="2147483647"));
  // Do not activate the editor tab: the purge itself must cancel the capture.
  await editor.locator("#clear-all-button").evaluate(button=>button.click());
  await editor.waitForFunction(()=>document.getElementById("empty-title").textContent==="Все данные удалены");
  assert.deepEqual(await snapshot(),beforeClearCapture);
  await page.waitForTimeout(1000);
  assert.deepEqual(await editor.evaluate(()=>indexedDB.databases()),[]);
  assert(context.pages().filter(p=>p.url().startsWith(`chrome-extension://${id}/editor.html`)).every(p=>!p.url().includes("id=")),"Cancelled job must not create another error/capture tab");
  record("Clear all cancels an active capture, restores source scroll/CSS and prevents delayed metadata writes");
  const afterClear=await capture();await afterClear.waitForSelector("canvas.preview");
  record("A new full-page capture works after complete deletion");
  await afterClear.locator("#clear-all-button").click();
  await afterClear.waitForFunction(()=>document.getElementById("empty-title").textContent==="Все данные удалены");
  assert.deepEqual(await afterClear.evaluate(()=>indexedDB.databases()),[]);
  await afterClear.screenshot({path:join(results,"cleared.png")});
  assert.deepEqual(errors, []); record("No uncaught editor page errors");
} catch (error) {
  report.failed.push(error.stack || String(error)); console.error(error); process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (profile) await rm(profile, { recursive: true, force: true });
  await writeFile(join(results, "browser-report.json"), JSON.stringify(report, null, 2));
}
