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
  await call("Page.reload");
  await sleep(1400);
  const boardId = await evaluate("new URL(location.href).searchParams.get('board')");
  if (!boardId) throw new Error("目前頁面沒有 board 參數。");
  await evaluate("goView('review', new URL(location.href).searchParams.get('board'))");
  await sleep(1300);

  const result = await evaluate(`(async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const makePointer = (type, pointerId, x, y, pointerType = "pen") => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType,
      isPrimary: true,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
      clientX: x,
      clientY: y,
      pressure: pointerType === "pen" ? .5 : 0
    });
    const resetTeacher = () => {
      teacherInkActiveStroke = null;
      teacherInkActivePointerId = null;
      state.teacherInk.set(Number(state.currentPage), []);
      state.inkTool = "pen";
      renderTeacherInk();
    };
    const stroke = (target, id, x, y) => {
      target.dispatchEvent(makePointer("pointerdown", id, x, y));
      target.dispatchEvent(makePointer("pointermove", id, x + 18, y + 7));
      target.dispatchEvent(makePointer("pointerup", id, x + 18, y + 7));
    };
    const pageStage = document.getElementById("pageStage");
    const pdfCanvas = document.getElementById("pdfCanvas");
    if (!pageStage || !pdfCanvas) throw new Error("教師 page stage 不存在。");

    resetTeacher();
    stroke(pdfCanvas, 1001, 250, 220);
    stroke(pdfCanvas, 1002, 255, 223);
    await wait(360);
    const teacherSeparateStrokes = (state.teacherInk.get(state.currentPage) || []).length === 2;

    resetTeacher();
    pageStage.dispatchEvent(makePointer("pointerdown", 1003, 300, 260));
    pageStage.dispatchEvent(makePointer("pointercancel", 1003, 300, 260));
    await wait(360);
    const teacherShortCancel = (state.teacherInk.get(state.currentPage) || []).length === 1 && (state.teacherInk.get(state.currentPage) || [])[0].points.length >= 1;

    resetTeacher();
    pageStage.dispatchEvent(makePointer("pointerdown", 1004, 340, 300));
    pageStage.dispatchEvent(makePointer("pointermove", 1004, 360, 308));
    pageStage.dispatchEvent(makePointer("pointerdown", 1005, 430, 340));
    pageStage.dispatchEvent(makePointer("pointermove", 1005, 450, 348));
    pageStage.dispatchEvent(makePointer("pointerup", 1005, 450, 348));
    await wait(360);
    const teacherStaleRecovery = (state.teacherInk.get(state.currentPage) || []).length === 2 && teacherInkActivePointerId === null;

    resetTeacher();
    stroke(pageStage, 1006, 380, 380);
    pageStage.dispatchEvent(makePointer("pointerdown", 1007, 390, 390, "touch"));
    pageStage.dispatchEvent(makePointer("pointermove", 1007, 410, 398, "touch"));
    pageStage.dispatchEvent(makePointer("pointerup", 1007, 410, 398, "touch"));
    const teacherFingerIgnored = (state.teacherInk.get(state.currentPage) || []).length === 1;

    const area = state.areas[0];
    const svgBase64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAwIiBoZWlnaHQ9IjYwMCI+PHJlY3Qgd2lkdGg9IjEwMDAiIGhlaWdodD0iNjAwIiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==";
    await localPut("files", { id: "L-ink-lifecycle-canvas", mime: "image/svg+xml", base64: svgBase64 });
    await localPut("submissions", { id: "S-ink-lifecycle-canvas", boardId: state.board.id, areaId: area.id, nickname: "筆跡生命週期測試", text: "", imageFileIds: ["L-ink-lifecycle-canvas"], imageFileNames: ["測試.svg"], teacherStrokes: {}, teacherComment: "", status: "待批改" });
    await openClassroomAnswerModal(area);
    await wait(500);
    const reviewImage = document.getElementById("reviewImage");
    if (!reviewImage) throw new Error("批改答案圖片不存在。");
    reviewActiveStroke = null;
    reviewActivePointerId = null;
    state.reviewStrokes = [];
    state.reviewTool = "pen";
    const reviewStroke = (id, x, y) => {
      reviewImage.dispatchEvent(makePointer("pointerdown", id, x, y));
      reviewImage.dispatchEvent(makePointer("pointermove", id, x + 18, y + 7));
      reviewImage.dispatchEvent(makePointer("pointerup", id, x + 18, y + 7));
    };
    reviewStroke(1101, 180, 180);
    reviewStroke(1102, 185, 183);
    await wait(360);
    const reviewSeparateStrokes = state.reviewStrokes.length === 2;
    const reviewZoomBeforeTouch = state.reviewZoom;
    const makeTouch = (identifier, x, y) => {
      const touch = new Touch({ identifier, target: reviewImage, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, force: .5 });
      try { Object.defineProperty(touch, "touchType", { value: "stylus" }); } catch (error) {}
      return touch;
    };
    const stylusStroke = (identifier, x, y) => {
      const start = makeTouch(identifier, x, y);
      const move = makeTouch(identifier, x + 15, y + 6);
      reviewImage.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [start], targetTouches: [start], changedTouches: [start] }));
      reviewImage.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [move], targetTouches: [move], changedTouches: [move] }));
      reviewImage.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [move] }));
    };
    const reviewBeforeTouchStrokes = state.reviewStrokes.length;
    stylusStroke(1103, 240, 220);
    stylusStroke(1104, 245, 223);
    const reviewStylusGestureSafe = state.reviewZoom === reviewZoomBeforeTouch && state.reviewStrokes.length === reviewBeforeTouchStrokes + 2;

    await wait(500);
    window.clearTimeout(state.inkSaveTimer);
    state.inkSaveTimer = null;
    teacherInkSaveChains.clear();
    teacherInkRevision.clear();
    const originalCommitLocalMutation = window.commitLocalMutation;
    const pendingSaves = [];
    window.commitLocalMutation = function (action, payload) {
      return new Promise((resolve) => pendingSaves.push({ action, payload, resolve }));
    };
    const oldStroke = { tool: "pen", shape: "freehand", color: "#315f59", width: .0025, points: [{ x: .2, y: .2, pressure: .5 }] };
    const newStroke = { tool: "pen", shape: "freehand", color: "#315f59", width: .0025, points: [{ x: .3, y: .3, pressure: .5 }] };
    state.teacherInk.set(Number(state.currentPage), [oldStroke]);
    markTeacherInkChanged(Number(state.currentPage));
    const oldSave = persistTeacherInk(Number(state.currentPage), state.board.id);
    await wait(0);
    state.teacherInk.set(Number(state.currentPage), [oldStroke, newStroke]);
    markTeacherInkChanged(Number(state.currentPage));
    const newSave = persistTeacherInk(Number(state.currentPage), state.board.id);
    await wait(0);
    if (pendingSaves.length !== 1) throw new Error("保存競速測試未建立串行佇列。");
    pendingSaves[0].resolve({ ok: true, annotation: { strokes: [oldStroke] } });
    await wait(0);
    if (pendingSaves.length !== 2) throw new Error("保存競速測試未等待前一筆完成。");
    pendingSaves[1].resolve({ ok: true, annotation: { strokes: [oldStroke, newStroke] } });
    await Promise.all([oldSave, newSave]);
    const saveRaceProtected = JSON.stringify(state.teacherInk.get(Number(state.currentPage)) || []) === JSON.stringify([oldStroke, newStroke]);
    window.commitLocalMutation = originalCommitLocalMutation;
    return JSON.stringify({ teacherSeparateStrokes, teacherShortCancel, teacherStaleRecovery, teacherFingerIgnored, reviewSeparateStrokes, reviewStylusGestureSafe, saveRaceProtected, teacherActivePointer: teacherInkActivePointerId, reviewActivePointer: reviewActivePointerId });
  })()`);

  const checks = JSON.parse(result);
  Object.entries(checks).forEach(([name, value]) => {
    if (name.endsWith("Pointer")) return;
    assert(value === true, name + " 未通過");
  });
  console.log("ink-lifecycle-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("ink-lifecycle-cdp-error=" + error.message);
  process.exit(1);
});
