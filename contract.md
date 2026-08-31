<role>
你是本任務的執行員。你的職責是嚴格依照 spec 區塊完成程式產出，
不重新詮釋需求、不順手重構範圍外的程式、不省略自檢區塊。
實作前先寫測試；測試紅燈時修實作，不修測試遷就實作。
你不評價規格本身；規格有疑義時走失敗協議第 3 條，不自行裁決。
</role>

<spec>
【任務目標】修正互動 PDF 教室在 iPad／Apple Pencil 中文短筆畫間提筆再落筆時遺失或停止的問題，讓每一筆都穩定出現並維持接近 GoodNotes 的即時書寫感；同時為課堂 PDF 捲動區加入不干擾書寫的手指下拉重整，並讓同一版面可隔離管理多份 PDF 教材。
【交付物】修改 `index.html` 與 `Code.gs`，完成輸入路由、筆畫生命週期、繪製、保存、課堂下拉重整及多教材資料隔離；新增 `tests/ink-lifecycle-cdp.js`、`tests/classroom-pull-refresh-cdp.js` 及 `tests/multi-material-cdp.js`，提供事件矩陣、保存行為、課堂手勢及教材隔離回歸測試；保留 `plan.md`、`premortem.md`、`contract.md` 作為本次治理證據。
【介面契約】
`InkPointerEvent` 必須提供 `pointerId`、`pointerType`、`clientX`、`clientY`、`pressure`、`preventDefault()` 及可選的 `getCoalescedEvents()`。
`InkPoint` 固定為 `{ x: number, y: number, pressure: number }`，`x` 與 `y` 必須限制在零到一；`InkStroke` 固定保留 `tool`、`shape`、`color`、`width` 及 `points`。
`pointerSamples(event: InkPointerEvent | null): InkPointerEvent[]` 必須回傳目前事件及可取得的 coalesced samples；事件無效或讀取失敗時回傳空清單，不得拋出例外。
`canvasPoint(event: InkPointerEvent, canvas: HTMLCanvasElement): InkPoint` 必須依目前 bounding rect 轉換座標，超出範圍時限制在零到一。
`bindTeacherInkCanvas(): void` 必須將教師輸入綁定至 page stage；`bindReviewCanvas(canvas: HTMLCanvasElement): void` 必須將批改輸入綁定至答案圖片 stage。
`bindClassroomPullToRefresh(scroll: HTMLElement): void` 必須將課堂 PDF 捲動區的單指下拉綁定至既有提示元件；`refreshClassroomView(): Promise<void>` 必須只讀取課堂狀態及學生作答，成功或失敗都清除 refreshing 狀態，不得呼叫 `loadBoardContext()`。
`beginTeacherInk(event: InkPointerEvent): void`、`moveTeacherInk(event: InkPointerEvent): void`、`finishTeacherInk(event: InkPointerEvent | null, cancelled: boolean): void`、`cancelTeacherInk(event: InkPointerEvent | null): void` 必須共同管理教師單一觸控筆 session。
`beginReviewInk(event: InkPointerEvent): void`、`moveReviewInk(event: InkPointerEvent): void`、`finishReviewStroke(event: InkPointerEvent | null, cancelled: boolean): void`、`cancelReviewStroke(event: InkPointerEvent | null): void` 必須對批改 session 遵守同一生命週期規則。
每次有效落筆必須建立獨立 `InkStroke`。下一次有效落筆必須先封存殘留 session，再建立新的活動 session；不得以時間或距離自動合併不同接觸。
`saveInk` payload 在既有單一教材資料上維持 `{ id, boardId, page, strokes }`；多教材資料可附加 `materialId`，回傳格式維持 `{ ok, annotation }`。`materialId` 必須同步寫入教材、問答區、筆跡、課堂狀態、作答及檔案索引，Drive JSON 內容格式不變。
【凍結契約】只使用原生 HTML、Vanilla JavaScript、Vanilla CSS、PDF.js、Canvas、IndexedDB 及既有 GAS API，不新增第三方相依。中文文字使用全形標點，禁止破折號。保留既有輸入來源分流、預設筆畫粗細 2、手指捲動與捏合縮放、離線 outbox 及錯誤 Modal。不得加入生產環境事件除錯面板或改變既有 API 欄位。
【範圍邊界】Apple Pencil 與課堂下拉重整原始契約只涉及 `index.html`、`tests/ink-lifecycle-cdp.js`、`tests/classroom-pull-refresh-cdp.js` 及治理文件；本輪經使用者授權擴充為可修改 `Code.gs`、`README.md` 及新增 `tests/multi-material-cdp.js`，以完成多教材資料層。不得修改 `rdq/`、既有其他專案或外層 AI_Agent 工作樹檔案。diff 必須逐檔可對帳。
</spec>

<acceptance_criteria>
產出必須同時滿足以下全部條件才算完成：
1. `tests/ink-lifecycle-cdp.js` 必須先於 `index.html` 的本輪實作完成，且在基線執行時至少有一項目標斷言紅燈。
2. `node tests/ink-lifecycle-cdp.js` 最終必須以退出碼 0 完成。
3. 教師 page stage 子元素命中時，觸控筆短筆畫必須建立一筆 `InkStroke`。
4. 教師只有一個取樣點的 `pointercancel` 必須保存該筆畫。
5. 教師遺失結束事件後的下一次有效落筆必須建立新筆畫。
6. 批改答案圖片子元素命中時，觸控筆短筆畫必須建立一筆 `InkStroke`。
7. 批改遺失結束事件後的下一次有效落筆必須建立新筆畫。
8. 兩次相鄰觸控筆落筆不得被自動合併為同一個 `InkStroke`。
9. 觸控筆事件不得觸發批改圖片的單指捲動或雙擊縮放。
10. 手指事件不得建立教師筆畫。
11. 保存快照的舊非同步結果不得覆蓋較新的本機筆畫狀態。
12. 高頻取樣測試必須保留所有可取得的 coalesced samples。
13. `node C:\Users\sshor\AppData\Local\Temp\opencode\pdfw-cdp-smoke.js` 必須通過，且輸出 `runtime-exceptions=[]`。
14. `python -X utf8 C:\Users\sshor\.agents\skills\gas-standalone-builder\scripts\validate_contract.py index.html --branch frontend-db` 必須通過。
15. `python -X utf8 C:\Users\sshor\.agents\skills\gas-standalone-builder\scripts\validate_punct.py index.html README.md` 必須通過。
16. JavaScript 語法檢查必須通過，且 `git diff --check` 不得有錯誤。
17. diff 只能落在【範圍邊界】列出的檔案內。
18. 不得新增第三方相依，不得改變 `saveInk` 或 `saveFeedback` 的 API 格式。
19. 教師與批改區預設筆畫粗細都必須為 2。
20. `applepencildoubletap`、畫布 `dblclick` 及其他自動工具切換不得出現在生產程式碼中。
21. `tests/classroom-pull-refresh-cdp.js` 必須先於課堂下拉重整實作完成，且在基線執行時至少有一項目標斷言紅燈。
22. `node tests/classroom-pull-refresh-cdp.js` 最終必須以退出碼 0 完成。
23. 課堂 PDF 捲動區位於頂端時，手指下拉達到門檻必須只觸發一次 `refreshClassroomView()`。
24. 課堂 PDF 捲動區不在頂端時，手指下拉不得觸發 `refreshClassroomView()`。
25. 課堂觸控筆事件不得觸發 `refreshClassroomView()`。
26. 課堂下拉重整期間的本機教師筆跡不得被清除。
27. 課堂下拉重整完成後，提示元件必須離開 refreshing 狀態。
28. 課堂下拉同步失敗後，提示元件必須離開 refreshing 狀態。
29. 新增課堂下拉重整不得修改 GAS API、試算表欄位或 Drive JSON 格式。
30. 同一版面可保存兩份以上 PDF 教材，且每份教材的問答區、筆跡、課堂狀態、作答、草稿及檔案索引不得互相顯示。
31. `classroomSync` 必須回傳教材清單及完整問答區資料，並依要求的 `materialId` 回傳對應筆跡版本與作答數量。
32. 既有單一 PDF 資料首次讀取時，必須可透過 `M-{boardId}-legacy` 映射繼續使用，且缺少 `materialId` 的既有資料不得被捨棄。
33. 學生端課堂輪詢必須能套用教師共享的教材、頁碼與縮放，並保留學生自己的教材位置記錄。
</acceptance_criteria>

<failure_protocol>
遇到以下情況時走降級階梯，不可造假繞過：
1. 資訊不足：標記［待補充：___］，先完成可確定的部分，交付時彙總列出。
2. 測試無法重現問題：回報重現步驟的缺口，不在未重現的情況下硬修。
3. 環境或工具失敗：回報失敗原因與已完成進度，不假裝測試有跑過、不憑空補結果。
4. 規格衝突或介面契約矛盾：停止該模組，列出衝突點請求裁決，其餘模組照常完成。
5. 修正超過 3 輪仍未通過驗收：停止修正，建議升級至更強模型或移交 Claude Code 接手。
6. 實體 iPad 不在執行環境：不得把合成事件測試標記為 GoodNotes 實機等級，只能交付可追溯的模擬結果及實機驗收步驟。
</failure_protocol>

<self_check>
輸出前執行 2 輪自檢，每輪依序完成：
1. 實際執行全部測試並貼上結果摘要，列出通過數、失敗數及關鍵輸出，不得以「應可通過」代替執行。
2. 逐條核對 33 條 acceptance_criteria，每條附證據位置，包含測試名、檔名加行號或 diff 段落。
3. diff 審查：逐檔核對是否落在範圍邊界內，範圍外變更一律停止並回報。
4. 第二輪自檢必須重新確認線上 Pages commit、build 狀態及實際回應內容。
自檢表僅供參考，不取代獨立驗證；不得因自檢通過而省略驗證員移交包。
</self_check>
