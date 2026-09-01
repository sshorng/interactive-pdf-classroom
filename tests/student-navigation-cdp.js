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
    const ready = await waitFor(() => state.view === "student" && state.pdf && document.getElementById("answerPanel"), 15000);
    if (!ready) return JSON.stringify({ ready: false, view: state.view });
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const areas = studentNavigationAreas();
    if (areas.length < 2) return JSON.stringify({ ready: false, reason: "測試教材少於兩個問答區", areaCount: areas.length });
    const first = areas[0];
    const second = areas[1];
    state.currentPage = Number(first.page) || 1;
    await openStudentAnswerPanel(first.id);
    const firstPosition = document.getElementById("studentQuestionPosition").textContent;
    const firstNextEnabled = !document.getElementById("studentNextQuestion").disabled;
    const firstActiveZone = Boolean(document.querySelector('.student-workspace .zone.active[data-area-id="' + first.id + '"]'));
    const firstFocused = document.getElementById("answerPanel").classList.contains("is-focused");
    document.getElementById("studentNextQuestion").click();
    await waitFor(() => String(state.activeAreaId) === String(second.id) && document.getElementById("studentQuestionPosition") && document.getElementById("studentQuestionPosition").textContent.indexOf("2／") === 0, 5000);
    const secondActiveZone = Boolean(document.querySelector('.student-workspace .zone.active[data-area-id="' + second.id + '"]'));
    const secondPosition = document.getElementById("studentQuestionPosition").textContent;
    document.getElementById("studentPrevQuestion").click();
    await waitFor(() => String(state.activeAreaId) === String(first.id), 5000);
    const previousReturned = String(state.activeAreaId) === String(first.id);
    return JSON.stringify({ ready: true, firstPosition, firstNextEnabled, firstActiveZone, firstFocused, secondPosition, secondActiveZone, previousReturned });
  })()`);

  const checks = JSON.parse(result);
  assert(checks.ready === true, "學生導覽測試頁面未準備完成：" + JSON.stringify(checks));
  assert(checks.firstPosition.indexOf("1／") === 0, "學生作答卡未顯示第一題位置");
  assert(checks.firstNextEnabled === true, "學生作答卡未啟用下一題");
  assert(checks.firstActiveZone === true, "學生端目前題目圖釘未高亮");
  assert(checks.firstFocused === true, "學生作答卡未取得視覺焦點");
  assert(checks.secondPosition.indexOf("2／") === 0, "下一題導覽未切換作答卡");
  assert(checks.secondActiveZone === true, "切換下一題後圖釘未高亮");
  assert(checks.previousReturned === true, "上一題導覽未切回前一題");
  console.log("student-navigation-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("student-navigation-cdp-error=" + error.message);
  process.exit(1);
});
