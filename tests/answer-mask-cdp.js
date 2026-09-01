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
    const ready = await waitFor(() => state.view === "student" && state.pdf && document.getElementById("pageStage"), 15000);
    if (!ready) return JSON.stringify({ ready: false, view: state.view });
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const original = {
      view: state.view,
      masks: state.answerMasks,
      revealed: state.revealedAnswerMaskIds,
      activeMaterialId: state.activeMaterialId,
      currentPage: state.currentPage,
      drawing: state.answerMaskDrawing
    };
    const materialId = String(state.activeMaterialId || "M-test-mask");
    const masks = [
      { id: "AM-test-1", boardId: state.board.id, materialId, page: 1, x: .1, y: .12, width: .22, height: .12, title: "遮罩一", order: 1 },
      { id: "AM-test-2", boardId: state.board.id, materialId, page: 1, x: .52, y: .48, width: .25, height: .14, title: "遮罩二", order: 2 }
    ];
    state.answerMasks = normalizeAnswerMasks(masks, state.board.id);
    state.revealedAnswerMaskIds = new Set();
    state.activeMaterialId = materialId;
    state.currentPage = 1;
    state.view = "student";
    renderRevealControls();
    renderRevealMasks();
    const studentInitial = document.querySelectorAll(".answer-mask:not(.is-revealed)").length === 2;
    const firstMask = document.querySelector(".answer-mask");
    if (firstMask) firstMask.click();
    const studentSingleReveal = state.revealedAnswerMaskIds.has("AM-test-1") && document.querySelectorAll(".answer-mask:not(.is-revealed)").length === 1;
    hideAllAnswerMasks();
    const studentHideAll = state.revealedAnswerMaskIds.size === 0 && document.querySelectorAll(".answer-mask:not(.is-revealed)").length === 2;
    state.view = "review";
    renderRevealControls();
    renderRevealMasks();
    const classroomMasked = document.querySelectorAll(".answer-mask:not(.is-revealed)").length === 2;
    state.view = "editor";
    renderRevealControls();
    renderRevealMasks();
    const editorShowsOriginal = document.querySelectorAll(".answer-mask.is-editor").length === 2 && document.querySelectorAll(".answer-mask:not(.is-editor)").length === 0;
    state.answerMasks = [];
    state.answerMaskDrawing = true;
    renderRevealMasks();
    const layer = document.getElementById("answerMaskLayer");
    const layerRect = layer && layer.getBoundingClientRect();
    if (layer && layerRect && layerRect.width && layerRect.height) {
      const eventAt = (type, x, y) => new PointerEvent(type, { bubbles: true, clientX: layerRect.left + layerRect.width * x, clientY: layerRect.top + layerRect.height * y, pointerId: 37, pointerType: "mouse", button: 0, isPrimary: true });
      layer.dispatchEvent(eventAt("pointerdown", .2, .2));
      layer.dispatchEvent(eventAt("pointermove", .42, .38));
      layer.dispatchEvent(eventAt("pointerup", .42, .38));
    }
    const editorDrag = state.answerMasks.length === 1 && state.answerMasks[0].width > .2 && state.answerMasks[0].height > .1;
    let localPersistence = false;
    if (editorDrag) {
      const savedMask = Object.assign({}, state.answerMasks[0]);
      await localRequest("updateBoard", { boardId: state.board.id, answerMasks: [savedMask] });
      const fetched = await localRequest("getBoard", { boardId: state.board.id });
      localPersistence = Array.isArray(fetched.answerMasks) && fetched.answerMasks.length === 1 && String(fetched.answerMasks[0].id) === String(savedMask.id);
      await localRequest("updateBoard", { boardId: state.board.id, answerMasks: original.masks || [] });
    }
    state.view = original.view;
    state.answerMasks = original.masks;
    state.revealedAnswerMaskIds = original.revealed;
    state.activeMaterialId = original.activeMaterialId;
    state.currentPage = original.currentPage;
    state.answerMaskDrawing = original.drawing;
    renderRevealControls();
    renderRevealMasks();
    return JSON.stringify({ ready: true, studentInitial, studentSingleReveal, studentHideAll, classroomMasked, editorShowsOriginal, editorDrag, localPersistence });
  })()`);

  const checks = JSON.parse(result);
  assert(checks.ready === true, "答案遮罩測試頁面未準備完成");
  assert(checks.studentInitial === true, "學生端初始沒有全部遮住答案");
  assert(checks.studentSingleReveal === true, "學生端無法逐一揭示答案");
  assert(checks.studentHideAll === true, "學生端全部遮回失敗");
  assert(checks.classroomMasked === true, "課堂投影端初始沒有遮住答案");
  assert(checks.editorShowsOriginal === true, "教材編輯端沒有保留原文可見");
  assert(checks.editorDrag === true, "教材編輯端無法拖曳建立答案遮罩");
  assert(checks.localPersistence === true, "答案遮罩無法保存並重新載入");
  console.log("answer-mask-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("answer-mask-cdp-error=" + error.message);
  process.exit(1);
});
