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
  await sleep(5000);

  const result = await evaluate(`(async () => {
    const waitFor = async (predicate, timeout) => {
      const deadline = Date.now() + (timeout || 15000);
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    };
    const ready = await waitFor(() => state.view === "student" && state.materials.length > 1 && document.querySelector("[data-material-select]"), 15000);
    if (!ready) return JSON.stringify({ ready: false, view: state.view, materialCount: state.materials.length });
    const pdfOptions = typeof pdfDocumentOptions === "function" ? pdfDocumentOptions(new Uint8Array([1])) : {};
    const pdfTextAssetsConfigured = String(pdfOptions.cMapUrl || "").endsWith("/cmaps/") && pdfOptions.cMapPacked === true && String(pdfOptions.standardFontDataUrl || "").endsWith("/standard_fonts/");
    const select = document.querySelector("[data-material-select]");
    const label = select.closest(".material-select-label");
    const originalSync = window.loadClassroomSync;
    const originalSubmissions = window.loadStudentSubmissions;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    window.loadClassroomSync = async function () {};
    window.loadStudentSubmissions = async function () {};
    const originalId = state.activeMaterialId;
    const target = Array.from(select.options).find((option) => option.value !== originalId);
    const options = Array.from(select.options).map((option) => option.textContent);
    const compact = label && label.firstChild && label.firstChild.nodeValue.trim() === "教材" && label.getBoundingClientRect().width <= 100;
    if (!target) return JSON.stringify({ ready: true, compact, options, switched: false });
    select.value = target.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const switched = await waitFor(() => state.activeMaterialId === target.value && select.value === target.value && state.pdf && state.pdf.numPages > 0 && state.materialPdfCache.has(target.value), 15000);
    const originalView = state.view;
    const originalRevision = state.classroomStateRevision;
    const originalActiveId = state.activeMaterialId;
    const originalLoadPdf = window.loadMaterialPdf;
    const originalLoadInk = window.loadTeacherInk;
    const originalLoadReviews = window.loadReviewSubmissions;
    const originalRenderPdf = window.renderPdfPage;
    const originalPersistState = window.persistClassroomState;
    let revisionAtLoad = 0;
    window.loadMaterialPdf = async function () { revisionAtLoad = state.classroomStateRevision; return state.pdf; };
    window.loadTeacherInk = async function () {};
    window.loadReviewSubmissions = async function () {};
    window.renderPdfPage = async function () {};
    window.persistClassroomState = async function () {};
    state.view = "review";
    state.classroomStateRevision = 0;
    const reviewTarget = state.materials.find((material) => material.id !== originalActiveId);
    if (reviewTarget) await selectMaterial(reviewTarget.id);
    const reviewSelectionGuarded = Boolean(reviewTarget) && revisionAtLoad > 0;
    clearTimeout(state.classroomStateTimer);
    state.classroomStateTimer = null;
    state.view = originalView;
    state.classroomStateRevision = originalRevision;
    state.activeMaterialId = originalActiveId;
    select.value = originalActiveId;
    window.loadMaterialPdf = originalLoadPdf;
    window.loadTeacherInk = originalLoadInk;
    window.loadReviewSubmissions = originalLoadReviews;
    window.renderPdfPage = originalRenderPdf;
    window.persistClassroomState = originalPersistState;
    const result = { ready: true, compact, options, target: target.value, active: state.activeMaterialId, selected: select.value, pages: state.pdf && state.pdf.numPages, switched, reviewSelectionGuarded, pdfTextAssetsConfigured };
    window.loadClassroomSync = originalSync;
    window.loadStudentSubmissions = originalSubmissions;
    return JSON.stringify(result);
  })()`);

  const checks = JSON.parse(result);
  assert(checks.ready === true, "教材切換測試頁面未準備完成");
  assert(checks.compact === true, "教材控制未固定為緊湊的「教材」按鈕");
  assert(checks.options.length > 1, "教材下拉選單缺少教材選項");
  assert(checks.switched === true, "選擇其他教材後 PDF 未切換");
  assert(checks.reviewSelectionGuarded === true, "教師切換教材未在載入前鎖住本地選擇");
  assert(checks.pdfTextAssetsConfigured === true, "PDF 直式文字所需字型資源未設定");
  console.log("material-switch-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("material-switch-cdp-error=" + error.message);
  process.exit(1);
});
