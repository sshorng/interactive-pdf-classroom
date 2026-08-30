# 計畫：iPad Apple Pencil 斷筆與課堂下拉重整

## 1. 現況盤點

目前前端是單檔 `index.html`，採用 Vanilla JavaScript、Canvas、PDF.js、IndexedDB 及 GAS outbox。教師 PDF 使用 `inkCanvas`，學生答案批改使用 `reviewCanvas`，兩者都已具備 PointerEvent、Legacy TouchEvent、coalesced samples、增量繪製及取消事件處理。最新基線包含 commit `7ce4b81` 的自動續接嘗試，工作樹另有把輸入監聽提升至 stage 的未提交差異。

本次症狀是連續線條尚可，但中文各筆之間稍微提筆後下一筆會遺失或停止。前幾輪只驗證合成 PointerEvent，沒有完整覆蓋原生事件目標、PointerEvent 與 TouchEvent 混送、遺失結束事件、批改手勢層及保存快照競速。GoodNotes 等級不能只由模擬器宣稱，必須把可驗收的事件行為寫死，實機結果另行標記。

## 2. 模組切分

1. 輸入路由：在教師 page stage 及批改圖片 stage 捕捉觸控筆事件，排除手指及手勢層誤攔截。
2. 筆畫生命週期：讓每次有效落筆成為獨立筆畫，處理 `pointerup`、`pointercancel`、`lostpointercapture`、無結束事件及重新落筆。
3. 繪製與保存：保留高頻取樣及即時預覽，確保短筆畫立即可見，保存快照不會被較舊非同步結果覆蓋。
4. 課堂下拉重整：只在課堂 PDF 捲動區頂端接收手指下拉，觸發不破壞本機筆跡的課堂同步。
5. 回歸閘門：先寫事件矩陣測試，再逐模組實作，最後跑既有契約、標點、語法、CDP 及部署核對。

依存方向為輸入路由到筆畫生命週期，再到繪製與保存；課堂下拉重整依賴手勢分流及保存狀態，最後由回歸閘門驗證全部模組。

## 3. 介面定義

`InkPointerEvent` 代表瀏覽器 PointerEvent 或 TouchEvent 轉接物件，至少提供 `pointerId`、`pointerType`、`clientX`、`clientY`、`pressure`、`preventDefault()` 及可選的 `getCoalescedEvents()`。

`InkPoint` 固定為 `{ x: number, y: number, pressure: number }`，`x` 與 `y` 為零到一的畫布相對座標。`InkStroke` 固定保留 `tool`、`shape`、`color`、`width` 及 `points`。

`pointerSamples(event: InkPointerEvent | null): InkPointerEvent[]` 回傳目前事件及可取得的所有 coalesced samples；事件無效或取樣讀取失敗時回傳空清單，不拋出例外。

`canvasPoint(event: InkPointerEvent, canvas: HTMLCanvasElement): InkPoint` 依畫布目前 bounding rect 轉換座標，座標超出範圍時限制在零到一。

`bindTeacherInkCanvas(): void` 將教師輸入事件綁定至 page stage，避免只依賴單一 canvas 子元素。`bindReviewCanvas(canvas: HTMLCanvasElement): void` 將批改輸入事件綁定至答案圖片 stage。

`bindClassroomPullToRefresh(scroll: HTMLElement): void` 將課堂 PDF 捲動區的單指下拉手勢綁定至既有提示元件。`refreshClassroomView(): Promise<void>` 只重新讀取課堂狀態及學生作答，成功或失敗都必須清除 refreshing 狀態，不得呼叫會清空本機筆跡的 `loadBoardContext()`。

`beginTeacherInk(event: InkPointerEvent): void`、`moveTeacherInk(event: InkPointerEvent): void`、`finishTeacherInk(event: InkPointerEvent | null, cancelled: boolean): void` 共同管理教師單一觸控筆 session。`cancelTeacherInk(event: InkPointerEvent | null): void` 必須保存已有取樣的短筆畫並清除活動 session。

`beginReviewInk(event: InkPointerEvent): void`、`moveReviewInk(event: InkPointerEvent): void`、`finishReviewStroke(event: InkPointerEvent | null, cancelled: boolean): void`、`cancelReviewStroke(event: InkPointerEvent | null): void` 對批改 session 遵守同一生命週期契約。

`saveInk` API payload 維持 `{ id, boardId, page, strokes }`，回傳既有 `{ ok, annotation }` 格式。不得修改 GAS API 簽名、試算表欄位或 Drive JSON 格式。

## 4. 資料流

觸控筆事件由 page stage 或答案圖片 stage 進入，先判斷輸入來源，再經 coalesced samples 轉成 `InkPoint`，放入活動 `InkStroke`。每次有效落筆都立即封存為獨立筆畫，Canvas 先繪出本機狀態，再由 debounce 保存至 IndexedDB，最後以同一頁面的最新快照放入 outbox 並同步 GAS。

手指事件只進入捲動、捏合或批改圖片手勢，不建立 `InkStroke`。不同落筆接觸不人工合併幾何路徑；「不中斷」定義為下一筆不遺失、不被舊 session 擋住，並非把兩個中文字筆畫接成一條線。

必測邊界包含單點短筆畫、兩點短筆畫、高頻取樣、`pointerup`、`pointercancel`、`lostpointercapture`、無結束事件後重新落筆、數字與字串 pointer ID、PointerEvent 與 TouchEvent 重複通知、手指事件、stage 子元素命中、頁面或圖片切換、清除操作及保存快照競速。

下拉重整必測頂端觸發、非頂端不觸發、未達門檻不觸發、觸控筆不觸發、觸控筆活動期間不觸發、觸控取消復原、重複觸發鎖定、同步失敗復原及本機筆跡保留。

## 5. 測試計畫

先新增 `tests/ink-lifecycle-cdp.js` 及 `tests/classroom-pull-refresh-cdp.js`，在現行基線執行並記錄至少一項紅燈，再開始修改 `index.html`。筆畫測試必須涵蓋教師 stage 子元素落筆、教師短筆取消、教師遺失結束後重新落筆、批改圖片短筆取消、批改遺失結束後重新落筆，以及觸控筆事件不觸發批改雙擊縮放。下拉測試必須涵蓋課堂頂端手指下拉觸發同步、非頂端不觸發、觸控筆不觸發及本機筆跡保留。

每完成一個模組就執行該測試。全部模組完成後執行既有 `pdfw-cdp-smoke.js`、`pdfw-ink-cdp.js`，再執行 HTML／JavaScript 語法、GAS 契約、全形標點及 `git diff --check`。測試結果必須列出實際輸出，不以理論通過替代。

## 6. 實作順序與風險

先建立並跑紅燈測試，接著修正輸入路由，再修正 session 清理，接著移除會把獨立中文字筆畫暫存合併的自動續接狀態，並補上保存快照的最新版本保護，最後加入課堂下拉重整。每一步完成定義是新增測試的對應斷言變綠，且既有測試沒有新增失敗。下拉重整只允許調用課堂同步函式，禁止重建版面上下文。

本次 pre-mortem 已另存於 `premortem.md`。其防範條款會分別回填 coding 契約的驗收標準、介面契約及失敗協議。若三輪修正後實體 iPad 仍失敗，停止繼續猜測，改交付事件記錄版給實機測試或升級模型處理。
