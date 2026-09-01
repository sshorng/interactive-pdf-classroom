const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

(async () => {
  const targets = await (await fetch("http://127.0.0.1:9224/json")).json();
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error("找不到 CDP page，請先啟動瀏覽器測試環境。");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error((result.exceptionDetails.text || "runtime-evaluate-error") + ": " + ((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || ""));
    }
    return result.result && result.result.value;
  };

  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: "http://127.0.0.1:4173/index.html?board=B-ecef9584f5874c" });
  await sleep(1200);

  const result = await evaluate(`(async () => {
    const waitFor = async (predicate, timeout) => {
      const deadline = Date.now() + (timeout || 15000);
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    };
    const ready = await waitFor(() => state.view === "student" && state.pdf && document.getElementById("pageStage") && state.materials.length > 0, 15000);
    if (!ready) return JSON.stringify({ ready: false, view: state.view, pages: state.pdf && state.pdf.numPages });
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const originalSync = window.loadClassroomSync;
    const originalSubmissions = window.loadStudentSubmissions;
    window.loadClassroomSync = async function () {};
    window.loadStudentSubmissions = async function () {};
    const originalMaterialId = state.activeMaterialId;
    const originalPage = state.currentPage;
    let targetMaterial = null;
    let targetPage = 0;
    const materialErrors = [];
    for (const material of state.materials) {
      try {
        if (String(material.id) !== String(state.activeMaterialId)) await selectMaterial(material.id);
      } catch (error) {
        materialErrors.push({ name: material.name, message: error.message });
        continue;
      }
      if (!state.pdf) continue;
      for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
        if (await pdfPageNeedsPdfium(await state.pdf.getPage(pageNumber))) {
          targetMaterial = material;
          targetPage = pageNumber;
          break;
        }
      }
      if (targetPage) break;
    }
    if (!targetPage) {
      window.loadClassroomSync = originalSync;
      window.loadStudentSubmissions = originalSubmissions;
      return JSON.stringify({ ready: false, reason: "測試教材中找不到直排文字頁", materials: state.materials.map((item) => item.name), materialErrors });
    }
    const originalTargetPage = state.currentPage;
    state.currentPage = targetPage;
    const pdfPage = await state.pdf.getPage(targetPage);
    const needsPdfium = await pdfPageNeedsPdfium(pdfPage);
    disposePdfiumDocument();
    await renderPdfPage();
    const canvas = document.getElementById("pdfCanvas");
    const context = canvas && canvas.getContext("2d");
    const sample = canvas && context ? context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data : [];
    const renderedWithPdfium = Boolean(state.pdfiumDocument && canvas && canvas.width > 0 && canvas.height > 0);
    if (String(state.activeMaterialId) !== String(originalMaterialId)) await selectMaterial(originalMaterialId, { page: originalPage });
    else {
      state.currentPage = originalPage;
      await renderPdfPage();
    }
    window.loadClassroomSync = originalSync;
    window.loadStudentSubmissions = originalSubmissions;
    return JSON.stringify({ ready: true, material: targetMaterial && targetMaterial.name, page: targetPage, originalTargetPage, needsPdfium, renderedWithPdfium, canvasWidth: canvas && canvas.width, canvasHeight: canvas && canvas.height, sample: Array.from(sample || []) });
  })()`);

  const checks = JSON.parse(result);
  assert(checks.ready === true, "PDFium 測試頁面未準備完成：" + JSON.stringify(checks));
  assert(checks.needsPdfium === true, "問題頁面未被辨識為直排文字頁：" + JSON.stringify(checks));
  assert(checks.renderedWithPdfium === true, "直排文字頁未建立 PDFium 文件或 Canvas：" + JSON.stringify(checks));
  console.log("pdfium-fallback-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("pdfium-fallback-cdp-error=" + error.message);
  process.exit(1);
});
