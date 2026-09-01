const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

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
  await call("Page.reload");
  await new Promise((resolve) => setTimeout(resolve, 1400));
  const boardId = await evaluate("new URL(location.href).searchParams.get('board')");
  if (!boardId) throw new Error("目前頁面沒有 board 參數。");
  await evaluate("goView('student', new URL(location.href).searchParams.get('board'))");
  const studentReady = await evaluate(`(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (state.view === "student" && document.getElementById("studentNicknameField")) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  })()`);
  if (!studentReady) throw new Error("學生介面未在期限內完成載入。");

   const result = await evaluate(`(async () => {
    const originalMaterials = state.materials;
    const originalAreas = state.areas;
    const originalActiveMaterialId = state.activeMaterialId;
    const materialA = { id: "M-test-a", boardId: state.board.id, name: "教材甲", pdfFileId: "P-a", pdfFileName: "甲.pdf", pdfMime: "application/pdf", order: 1, status: "啟用" };
    const materialB = { id: "M-test-b", boardId: state.board.id, name: "教材乙", pdfFileId: "P-b", pdfFileName: "乙.pdf", pdfMime: "application/pdf", order: 2, status: "啟用" };
    state.materials = [materialA, materialB];
     state.areas = [
       { id: "Q-test-a", boardId: state.board.id, materialId: materialA.id, page: 1 },
       { id: "Q-test-b", boardId: state.board.id, materialId: materialB.id, page: 1 }
     ];
     state.activeMaterialId = materialA.id;
     const areasA = currentMaterialAreas().map((area) => area.id);
     const keyA = studentDraftKey(state.board.id, materialA.id, "Q-test-a", "第一組");
     const keyB = studentDraftKey(state.board.id, materialB.id, "Q-test-b", "第一組");
     const inkKeyA = materialInkKey(materialA.id, 1);
     const inkKeyB = materialInkKey(materialB.id, 1);
     await localPut("drafts", { id: keyA, boardId: state.board.id, materialId: materialA.id, areaId: "Q-test-a", nickname: "第一組", text: "教材甲草稿" });
     const savedDraft = await localGet("drafts", keyA);
     await localDelete("drafts", keyA);
     state.materials = originalMaterials;
    state.areas = originalAreas;
    state.activeMaterialId = originalActiveMaterialId;
    return JSON.stringify({
      hasMaterialState: Array.isArray(originalMaterials),
      hasMaterialSelector: typeof selectMaterial === "function",
      hasMaterialInkKey: typeof materialInkKey === "function",
      hasDraftKey: typeof studentDraftKey === "function",
      hasMaterialPolling: typeof pollClassroomView === "function",
      nicknamePlaceholder: document.getElementById("studentNicknameField") && document.getElementById("studentNicknameField").placeholder === "例如：第一組",
       draftKeysSeparated: keyA !== keyB,
       inkKeysSeparated: inkKeyA !== inkKeyB,
       areasSeparated: areasA.length === 1 && areasA[0] === "Q-test-a",
       draftPersistence: savedDraft && savedDraft.materialId === materialA.id && savedDraft.text === "教材甲草稿"
     });
  })()`);

  const checks = JSON.parse(result);
  Object.entries(checks).forEach(([name, value]) => assert(value === true, name + " 未通過"));
  console.log("multi-material-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("multi-material-cdp-error=" + error.message);
  process.exit(1);
});
