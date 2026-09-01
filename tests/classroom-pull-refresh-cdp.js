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
    const scroll = document.getElementById("editorPdfScroll");
    const stage = document.getElementById("pageStage");
    const inkCanvas = document.getElementById("inkCanvas");
    const indicator = document.getElementById("pullRefreshIndicator");
    const hasBinding = typeof window.bindClassroomPullToRefresh === "function";
    const hasRefresh = typeof window.refreshClassroomView === "function";
    const hasClassroomPolling = typeof window.pollClassroomView === "function";
    if (!scroll || !stage || !inkCanvas || !indicator) throw new Error("課堂下拉重整測試元件不存在。");

    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    let syncCalls = 0;
    let submissionCalls = 0;
    const syncOptions = [];
    let failSync = false;
    const originalSync = window.loadClassroomSync;
    const originalReviewSubmissions = window.loadReviewSubmissions;
    const originalClassroomSubmissions = window.loadClassroomSubmissions;
    window.loadClassroomSync = async function (options) {
      syncCalls += 1;
      syncOptions.push(options || {});
      if (failSync) throw new Error("測試同步失敗");
    };
    window.loadReviewSubmissions = async function () {
      submissionCalls += 1;
    };
    window.loadClassroomSubmissions = async function () {
      submissionCalls += 1;
    };

    const setScrollTop = (value) => {
      scroll.scrollTop = value;
      if (scroll.scrollTop !== value) {
        try {
          Object.defineProperty(scroll, "scrollTop", { configurable: true, writable: true, value });
        } catch (error) {}
      }
    };
    const makeTouch = (identifier, y, stylus) => {
      const touch = new Touch({ identifier, target: scroll, clientX: 220, clientY: y, pageX: 220, pageY: y, screenX: 220, screenY: y, force: stylus ? .5 : 0 });
      if (stylus) {
        try { Object.defineProperty(touch, "touchType", { value: "stylus" }); } catch (error) {}
      }
      return touch;
    };
    const dispatchTouch = (type, identifier, y, stylus) => {
      const touch = makeTouch(identifier, y, stylus);
      const activeTouches = type === "touchend" || type === "touchcancel" ? [] : [touch];
      scroll.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: activeTouches,
        targetTouches: activeTouches,
        changedTouches: [touch]
      }));
    };
    const pull = (identifier, stylus = false) => {
      dispatchTouch("touchstart", identifier, 120, stylus);
      dispatchTouch("touchmove", identifier, 300, stylus);
      dispatchTouch("touchend", identifier, 300, stylus);
    };
    const resetIndicator = () => {
      indicator.classList.remove("visible", "refreshing");
      indicator.style.top = "-60px";
    };
    const localInk = {
      tool: "pen",
      shape: "freehand",
      color: "#315f59",
      width: 2,
      points: [{ x: .12, y: .18, pressure: .5 }]
    };
    const page = Number(state.currentPage) || 1;

    const beforeCalls = { sync: syncCalls, submissions: submissionCalls };
     const inkKey = materialInkKey(state.activeMaterialId, page);
     state.teacherInk.set(inkKey, [localInk]);
    setScrollTop(0);
    resetIndicator();
    if (hasBinding && hasRefresh) pull(2101);
    await wait(160);
    const topPullTriggeredOnce = syncCalls - beforeCalls.sync === 1 && submissionCalls - beforeCalls.submissions === 1;
     const localInkPreserved = JSON.stringify(state.teacherInk.get(inkKey) || []) === JSON.stringify([localInk]);
    const successIndicatorReset = !indicator.classList.contains("refreshing") && !indicator.classList.contains("visible");

    const callsAfterTopPull = syncCalls;
    setScrollTop(80);
    pull(2102);
    await wait(100);
    const nonTopPullIgnored = syncCalls === callsAfterTopPull;

    setScrollTop(0);
    pull(2103, true);
    await wait(100);
    const stylusPullIgnored = syncCalls === callsAfterTopPull;

    inkCanvas.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 2201,
      pointerType: "pen",
      isPrimary: true,
      buttons: 1,
      clientX: 250,
      clientY: 240,
      pressure: .5
    }));
    setScrollTop(0);
    pull(2104);
    await wait(100);
    inkCanvas.dispatchEvent(new PointerEvent("pointercancel", {
      bubbles: true,
      cancelable: true,
      pointerId: 2201,
      pointerType: "pen",
      isPrimary: true,
      buttons: 0,
      clientX: 250,
      clientY: 240,
      pressure: 0
    }));
    const activeStylusPullIgnored = syncCalls === callsAfterTopPull;

    failSync = true;
    setScrollTop(0);
    pull(2105);
    await wait(160);
    const failureIndicatorReset = !indicator.classList.contains("refreshing") && !indicator.classList.contains("visible");

    failSync = false;
    const pollingBefore = { sync: syncCalls, submissions: submissionCalls };
    if (hasClassroomPolling) await window.pollClassroomView();
    const teacherPollingSync = syncCalls - pollingBefore.sync === 1;
    const teacherPollingSubmissions = submissionCalls - pollingBefore.submissions === 1;
    const teacherPollingUsesPulse = syncOptions.some((options) => options.pulse === true);

    const pendingSyncResolvers = [];
    window.loadClassroomSync = function () {
      syncCalls += 1;
      return new Promise((resolve) => pendingSyncResolvers.push(resolve));
    };
    const firstSlowPoll = window.pollClassroomView();
    const secondSlowPoll = window.pollClassroomView();
    await wait(40);
    const singleSyncFlight = pendingSyncResolvers.length === 1;
    pendingSyncResolvers.forEach((resolve) => resolve());
    await Promise.all([firstSlowPoll, secondSlowPoll]);

    window.loadClassroomSync = originalSync;
    window.loadReviewSubmissions = originalReviewSubmissions;
    if (originalClassroomSubmissions) window.loadClassroomSubmissions = originalClassroomSubmissions;
    else delete window.loadClassroomSubmissions;
    return JSON.stringify({ hasBinding, hasRefresh, hasClassroomPolling, topPullTriggeredOnce, nonTopPullIgnored, stylusPullIgnored, activeStylusPullIgnored, localInkPreserved, successIndicatorReset, failureIndicatorReset, teacherPollingSync, teacherPollingSubmissions, teacherPollingUsesPulse, singleSyncFlight });
  })()`);

  const checks = JSON.parse(result);
  Object.entries(checks).forEach(([name, value]) => assert(value === true, name + " 未通過"));
  console.log("classroom-pull-refresh-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("classroom-pull-refresh-cdp-error=" + error.message);
  process.exit(1);
});
