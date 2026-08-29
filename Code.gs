/**
 * PDF 互動講義批改系統，Google Apps Script API。
 *
 * 使用方式：將本檔貼到 Google 試算表的 Apps Script 專案，
 * 首次執行 initDatabase，再部署成網頁應用程式。
 */

const TABLES = {
  settings: {
    name: "系統設定",
    headers: ["設定項", "設定值"],
    keys: ["key", "value"]
  },
  boards: {
    name: "教材版面",
    headers: ["版面ID", "版面名稱", "版面說明", "PDF檔案ID", "PDF檔名", "PDF類型", "狀態", "建立時間", "修改時間"],
    keys: ["id", "name", "description", "pdfFileId", "pdfFileName", "pdfMime", "status", "createdAt", "updatedAt"]
  },
  areas: {
    name: "問答區",
    headers: ["問答區ID", "版面ID", "頁碼", "左座標", "上座標", "寬度", "高度", "區域標題", "題目指示", "排序", "狀態", "建立時間", "修改時間"],
    keys: ["id", "boardId", "page", "x", "y", "width", "height", "title", "prompt", "order", "status", "createdAt", "updatedAt"]
  },
  ink: {
    name: "教師手寫",
    headers: ["筆跡ID", "版面ID", "頁碼", "筆跡資料", "修改時間"],
    keys: ["id", "boardId", "page", "strokes", "updatedAt"]
  },
  classroomState: {
    name: "課堂狀態",
    headers: ["狀態ID", "版面ID", "目前頁碼", "縮放比例", "修改時間"],
    keys: ["id", "boardId", "page", "zoom", "updatedAt"]
  },
  submissions: {
    name: "作答紀錄",
    headers: ["作答ID", "版面ID", "問答區ID", "學生暱稱", "文字答案", "圖片檔案ID", "圖片檔名", "教師筆跡", "教師評語", "批改狀態", "裝置代碼", "建立時間", "修改時間"],
    keys: ["id", "boardId", "areaId", "nickname", "text", "imageFileIds", "imageFileNames", "teacherStrokes", "teacherComment", "status", "clientId", "createdAt", "updatedAt"]
  },
  files: {
    name: "檔案索引",
    headers: ["檔案索引ID", "檔案用途", "原始檔名", "MIME類型", "Drive檔案ID", "檔案大小", "版面ID", "作答ID", "建立時間"],
    keys: ["id", "purpose", "name", "mime", "driveId", "size", "boardId", "submissionId", "createdAt"]
  }
};

const SETTINGS_DEFAULTS = [
  ["GeminiAPIKey", ""],
  ["GeminiModel", "gemini-flash-lite-latest"],
  ["AdminPassword", ""],
  ["DriveRootFolderName", "PDF互動講義檔案"],
  ["MaxImageBytes", "2097152"],
  ["MaxPdfBytes", "20971520"]
];

const MAX_TEXT = {
  name: 80,
  description: 300,
  title: 100,
  prompt: 500,
  nickname: 40,
  answer: 5000,
  comment: 1000,
  fileName: 120
};

const MAX_SHEET_JSON_CHARS = 45000;
const TABLE_CACHE_SECONDS = 8;
const TABLE_CACHE_MAX_CHARS = 90000;
const TABLE_CACHE_PREFIX = "pdfw_table_v1_";
const DATABASE_READY_CACHE_KEY = "pdfw_database_ready_v1";

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error("找不到資料試算表，請將 Code.gs 貼在試算表的 Apps Script 專案中。");
}

function setSpreadsheetId(id) {
  const value = String(id || "").trim();
  if (!value) throw new Error("請提供有效的試算表 ID。");
  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", value);
  CacheService.getScriptCache().remove(DATABASE_READY_CACHE_KEY);
  clearAllTableCaches_();
  return "資料試算表 ID 已設定。";
}

function initDatabase() {
  ensureDatabase_();
  getOrCreateRootFolder_();
  return "資料表與雲端硬碟資料夾初始化完成。";
}

function requestDriveScope() {
  const folder = getOrCreateRootFolder_();
  return "雲端硬碟讀寫權限已驗證：「" + folder.getName() + "」。";
}

function ensureDatabase_() {
  const cache = CacheService.getScriptCache();
  if (cache.get(DATABASE_READY_CACHE_KEY) === "1") return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error("目前正在初始化資料表，請稍後再試。");
  try {
    Object.keys(TABLES).forEach(function (key) { ensureTable_(key); });
    const sheet = getSheet_("settings");
    const existing = readTable_("settings");
    const present = existing.map(function (row) { return String(row.key || ""); });
    let changed = false;
    SETTINGS_DEFAULTS.forEach(function (item) {
      if (present.indexOf(item[0]) < 0) {
        sheet.appendRow(item);
        changed = true;
      }
    });
    if (changed) clearTableCache_("settings");
    cache.put(DATABASE_READY_CACHE_KEY, "1", 300);
  } finally {
    lock.releaseLock();
  }
}

function ensureTable_(key) {
  const table = TABLES[key];
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(table.name);
  if (!sheet) sheet = ss.insertSheet(table.name);
  const lastColumn = Math.max(sheet.getLastColumn(), table.headers.length);
  const firstRow = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const hasAny = firstRow.some(function (value) { return String(value || "").trim() !== ""; });
  if (!hasAny) {
    sheet.getRange(1, 1, 1, table.headers.length).setValues([table.headers]);
  } else {
    table.headers.forEach(function (header) {
      if (firstRow.indexOf(header) < 0) sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
    });
  }
  sheet.setFrozenRows(1);
  return sheet;
}

function getSheet_(key) {
  const table = TABLES[key];
  const sheet = getSpreadsheet_().getSheetByName(table.name);
  if (!sheet) throw new Error("資料表不存在：「" + table.name + "」。");
  return sheet;
}

function clearTableCache_(key) {
  CacheService.getScriptCache().remove(TABLE_CACHE_PREFIX + key);
}

function clearAllTableCaches_() {
  Object.keys(TABLES).forEach(function (key) { clearTableCache_(key); });
}

function readTable_(key) {
  const table = TABLES[key];
  const cacheKey = TABLE_CACHE_PREFIX + key;
  const cache = CacheService.getScriptCache();
  try {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (error) {
    // 快取損壞時改讀試算表，不影響主要流程。
  }
  const sheet = getSheet_(key);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) {
    cache.put(cacheKey, "[]", TABLE_CACHE_SECONDS);
    return [];
  }
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values.shift().map(function (value) { return String(value || ""); });
  const rows = values.map(function (row) {
    const item = {};
    table.keys.forEach(function (field, index) {
      const column = headers.indexOf(table.headers[index]);
      item[field] = column >= 0 ? serializeValue_(row[column]) : "";
    });
    return item;
  });
  try {
    const serialized = JSON.stringify(rows);
    if (serialized.length <= TABLE_CACHE_MAX_CHARS) cache.put(cacheKey, serialized, TABLE_CACHE_SECONDS);
  } catch (error) {
    // 大型資料表不寫入快取，避免超過 CacheService 單筆限制。
  }
  return rows;
}

function serializeValue_(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && /^'[=+\-@]/.test(value)) return value.slice(1);
  return value;
}

function safeCellValue_(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function appendRow_(key, item) {
  const table = TABLES[key];
  const sheet = getSheet_(key);
  sheet.appendRow(table.keys.map(function (field) {
    const value = item[field] === undefined || item[field] === null ? "" : item[field];
    return safeCellValue_(value);
  }));
  clearTableCache_(key);
}

function findRowById_(key, id) {
  const rows = readTable_(key);
  const index = rows.findIndex(function (item) { return String(item.id) === String(id); });
  return index < 0 ? -1 : index + 2;
}

function updateRow_(key, id, fields) {
  const table = TABLES[key];
  const sheet = getSheet_(key);
  const row = findRowById_(key, id);
  if (row < 0) throw new Error("找不到指定資料。");
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Object.keys(fields).forEach(function (field) {
    const fieldIndex = table.keys.indexOf(field);
    if (fieldIndex < 0 || fields[field] === undefined) return;
    const column = headers.indexOf(table.headers[fieldIndex]);
    if (column >= 0) sheet.getRange(row, column + 1).setValue(safeCellValue_(fields[field]));
  });
  clearTableCache_(key);
  return row;
}

function deleteRows_(key, predicate) {
  const rows = readTable_(key);
  const matchingRows = [];
  rows.forEach(function (item, index) {
    if (predicate(item)) matchingRows.push(index + 2);
  });
  const sheet = matchingRows.length ? getSheet_(key) : null;
  matchingRows.reverse().forEach(function (row) { sheet.deleteRow(row); });
  if (matchingRows.length) clearTableCache_(key);
  return matchingRows.length;
}

function readSettings_() {
  const settings = {};
  readTable_("settings").forEach(function (row) {
    settings[String(row.key || "").trim()] = String(row.value || "").trim();
  });
  return settings;
}

function loadSettings_() {
  return readSettings_();
}

function getSetting_(key) {
  return loadSettings_()[key] || "";
}

function now_() {
  return new Date().toISOString();
}

function makeId_(prefix) {
  return prefix + "-" + Utilities.getUuid().replace(/-/g, "").slice(0, 14);
}

function jsonOut_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function parsePayload_(event) {
  const parameter = event && event.parameter ? event.parameter : {};
  let raw = parameter.data || "";
  if (!raw && event && event.postData && event.postData.contents) raw = event.postData.contents;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("請求資料格式不正確。");
  }
}

function issueAdminToken_() {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put("pdfw_admin_" + token, "1", 21600);
  return token;
}

function isAdminToken_(token) {
  const value = String(token || "").trim();
  return Boolean(value && CacheService.getScriptCache().get("pdfw_admin_" + value) === "1");
}

function requireManager_(payload) {
  const password = getSetting_("AdminPassword");
  if (!password) return;
  if (!isAdminToken_(payload && payload.adminToken)) throw new Error("需要教師管理權限。");
}

function verifyAdmin_(payload) {
  const configured = getSetting_("AdminPassword");
  if (!configured) return { ok: true, token: issueAdminToken_(), expiresIn: 21600, configured: false };
  if (String(payload.password || "") !== configured) throw new Error("教師管理密語不正確。");
  return { ok: true, token: issueAdminToken_(), expiresIn: 21600, configured: true };
}

function cleanText_(value, limit) {
  return String(value == null ? "" : value).trim().slice(0, limit);
}

function safeFileName_(value) {
  return cleanText_(String(value || "檔案").replace(/[\\/:*?"<>|]/g, "_"), MAX_TEXT.fileName) || "檔案";
}

function parseArray_(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function parseObject_(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function spreadsheetParent_() {
  const file = DriveApp.getFileById(getSpreadsheet_().getId());
  const parents = file.getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

function getOrCreateFolder_(name, parent) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function getOrCreateRootFolder_() {
  return getOrCreateFolder_(getSetting_("DriveRootFolderName") || "PDF互動講義檔案", spreadsheetParent_());
}

function boardFolderName_(board) {
  if (!board) return "未命名教材";
  const name = cleanText_(board.name, 60) || "未命名教材";
  return safeFileName_("【" + name + "】");
}

function getBoardByIdQuiet_(boardId) {
  if (!boardId) return null;
  try {
    const boards = readTable_("boards");
    return boards.find(function (b) { return String(b.id) === String(boardId); }) || null;
  } catch (e) {
    return null;
  }
}

function getOrCreateBoardFolder_(boardId) {
  const root = getOrCreateRootFolder_();
  const board = getBoardByIdQuiet_(boardId);
  const targetName = board ? boardFolderName_(board) : safeFileName_(boardId);
  
  const targetFolders = root.getFoldersByName(targetName);
  if (targetFolders.hasNext()) return targetFolders.next();
  
  const legacyFolders = root.getFoldersByName(safeFileName_(boardId));
  if (legacyFolders.hasNext()) {
    const legacyFolder = legacyFolders.next();
    try { legacyFolder.setName(targetName); } catch (e) {}
    return legacyFolder;
  }
  
  return root.createFolder(targetName);
}

function getBoardFolderIfExists_(boardId) {
  const parent = spreadsheetParent_();
  const rootFolders = parent.getFoldersByName(getSetting_("DriveRootFolderName") || "PDF互動講義檔案");
  if (!rootFolders.hasNext()) return null;
  const root = rootFolders.next();
  const board = getBoardByIdQuiet_(boardId);
  const targetName = board ? boardFolderName_(board) : safeFileName_(boardId);
  
  const targetFolders = root.getFoldersByName(targetName);
  if (targetFolders.hasNext()) return targetFolders.next();
  
  const legacyFolders = root.getFoldersByName(safeFileName_(boardId));
  if (legacyFolders.hasNext()) return legacyFolders.next();
  
  return null;
}

function decodeBase64_(value) {
  const raw = String(value || "");
  const comma = raw.indexOf(",");
  return comma >= 0 ? raw.slice(comma + 1) : raw;
}

function saveDriveFile_(filePayload, purpose, boardId, submissionId) {
  const data = String(filePayload && (filePayload.data || filePayload.base64) || "");
  if (!data) throw new Error("檔案資料是空的。");
  const body = decodeBase64_(data);
  const mime = String(filePayload.mime || "application/octet-stream").slice(0, 120);
  const fileName = safeFileName_(filePayload.name || "教學檔案");
  const bytes = Utilities.base64Decode(body);
  const isImage = /^image\//i.test(mime);
  const limit = isImage ? Number(getSetting_("MaxImageBytes")) || 2097152 : Number(getSetting_("MaxPdfBytes")) || 20971520;
  if (bytes.length > limit) throw new Error((isImage ? "圖片" : "PDF") + "超過系統允許的大小限制。");
  const folder = getOrCreateBoardFolder_(boardId);
  const file = folder.createFile(Utilities.newBlob(bytes, mime, fileName));
  const index = {
    id: makeId_("F"),
    purpose: purpose,
    name: fileName,
    mime: mime,
    driveId: file.getId(),
    size: bytes.length,
    boardId: boardId || "",
    submissionId: submissionId || "",
    createdAt: now_()
  };
  appendRow_("files", index);
  return { driveId: file.getId(), name: fileName, mime: mime, size: bytes.length };
}

function storeJson_(value, purpose, boardId, submissionId) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (text.length <= MAX_SHEET_JSON_CHARS) return text;
  const file = saveDriveFile_({
    name: purpose + "-" + (submissionId || boardId || "資料") + ".json",
    mime: "application/json",
    data: Utilities.base64Encode(Utilities.newBlob(text).getBytes())
  }, purpose, boardId, submissionId);
  return "drive:" + file.driveId;
}

function readJsonReference_(value) {
  const text = String(value || "");
  if (text.indexOf("drive:") !== 0) return parseObject_(text, {});
  try {
    const file = DriveApp.getFileById(text.slice(6));
    return parseObject_(file.getBlob().getDataAsString("UTF-8"), {});
  } catch (error) {
    return {};
  }
}

function getBoard_(boardId, includeArchived) {
  const board = readTable_("boards").find(function (item) { return String(item.id) === String(boardId); });
  if (!board) throw new Error("找不到指定教材版面。");
  if (!includeArchived && String(board.status || "啟用") !== "啟用") throw new Error("這個教材版面目前已封存。");
  return board;
}

function areasForBoard_(boardId) {
  return readTable_("areas")
    .filter(function (item) { return String(item.boardId) === String(boardId) && String(item.status || "啟用") === "啟用"; })
    .sort(compareAreasByPosition_);
}

function compareAreasByPosition_(a, b) {
  return (Number(a.page) || 1) - (Number(b.page) || 1) || (Number(a.y) || 0) - (Number(b.y) || 0) || (Number(a.x) || 0) - (Number(b.x) || 0) || (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id || "").localeCompare(String(b.id || ""));
}

function submissionDriveIds_(submission) {
  const ids = parseArray_(submission.imageFileIds).map(function (id) { return String(id || "").trim(); }).filter(Boolean);
  const feedback = String(submission.teacherStrokes || "");
  if (feedback.indexOf("drive:") === 0) ids.push(feedback.slice(6));
  return ids.filter(Boolean);
}

function removeSubmissionsForAreas_(boardId, areaIds) {
  const targetAreas = {};
  (areaIds || []).forEach(function (areaId) { targetAreas[String(areaId)] = true; });
  const submissions = readTable_("submissions").filter(function (item) { return String(item.boardId) === String(boardId) && targetAreas[String(item.areaId)]; });
  if (!submissions.length) return 0;
  const targetSubmissions = {};
  const driveIds = {};
  submissions.forEach(function (submission) {
    targetSubmissions[String(submission.id)] = true;
    submissionDriveIds_(submission).forEach(function (driveId) { driveIds[driveId] = true; });
  });
  readTable_("files").filter(function (file) { return String(file.boardId) === String(boardId) && targetSubmissions[String(file.submissionId)]; }).forEach(function (file) {
    if (file.driveId) driveIds[String(file.driveId)] = true;
  });
  const remainingDriveIds = {};
  readTable_("submissions").filter(function (item) { return !targetSubmissions[String(item.id)]; }).forEach(function (submission) {
    submissionDriveIds_(submission).forEach(function (driveId) { remainingDriveIds[driveId] = true; });
  });
  Object.keys(driveIds).forEach(function (driveId) {
    if (remainingDriveIds[driveId]) return;
    try {
      DriveApp.getFileById(driveId).setTrashed(true);
    } catch (error) {
      // 檔案可能已被手動移除，資料清理仍應繼續。
    }
  });
  deleteRows_("files", function (file) { return String(file.boardId) === String(boardId) && targetSubmissions[String(file.submissionId)]; });
  return deleteRows_("submissions", function (item) { return String(item.boardId) === String(boardId) && targetAreas[String(item.areaId)]; });
}

function publicBoard_(board) {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    pdfFileId: board.pdfFileId,
    pdfFileName: board.pdfFileName,
    pdfMime: board.pdfMime,
    status: board.status,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt
  };
}

function publicInk_(item) {
  return {
    id: item.id,
    boardId: item.boardId,
    page: Number(item.page) || 1,
    strokes: readJsonReference_(item.strokes),
    updatedAt: item.updatedAt
  };
}

function inkVersion_(rows) {
  return rows.map(function (item) { return String(item.id || "") + ":" + String(item.updatedAt || ""); }).sort().join("|");
}

function publicSubmission_(item, includePrivate) {
  const output = {
    id: item.id,
    boardId: item.boardId,
    areaId: item.areaId,
    nickname: item.nickname,
    text: item.text,
    imageFileIds: parseArray_(item.imageFileIds),
    imageFileNames: parseArray_(item.imageFileNames),
    teacherStrokes: readJsonReference_(item.teacherStrokes),
    teacherComment: item.teacherComment,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
  if (includePrivate) {
    output.clientId = item.clientId;
  }
  return output;
}

function listBoards_(payload) {
  requireManager_(payload || {});
  return {
    ok: true,
    data: readTable_("boards").filter(function (item) { return String(item.status || "啟用") === "啟用"; }).map(publicBoard_),
    serverTime: now_()
  };
}

function getBoardData_(payload) {
  const board = getBoard_(payload.boardId, false);
  return { ok: true, board: publicBoard_(board), areas: areasForBoard_(board.id), serverTime: now_() };
}

function listInk_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, false);
  const rows = readTable_("ink").filter(function (item) { return String(item.boardId) === String(board.id); });
  return {
    ok: true,
    data: rows.map(publicInk_),
    inkVersion: inkVersion_(rows),
    serverTime: now_()
  };
}

function saveInk_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, true);
  const page = Math.max(1, Number(payload.page) || 1);
  const strokes = Array.isArray(payload.strokes) ? payload.strokes : [];
  const id = "INK-" + board.id + "-" + page;
  const reference = storeJson_(strokes, "教師頁面手寫", board.id, id);
  const item = { id: id, boardId: board.id, page: page, strokes: reference, updatedAt: now_() };
  const existing = readTable_("ink").find(function (row) { return String(row.id) === id; });
  if (existing) updateRow_("ink", id, item);
  else appendRow_("ink", item);
  return { ok: true, annotation: publicInk_(item) };
}

function publicClassroomState_(item, boardId) {
  return {
    id: item ? item.id : "STATE-" + boardId,
    boardId: boardId,
    page: Math.max(1, Number(item && item.page) || 1),
    zoom: Math.max(0.6, Math.min(2.2, Number(item && item.zoom) || 1)),
    updatedAt: item ? item.updatedAt : ""
  };
}

function classroomSync_(payload) {
  const board = getBoard_(payload.boardId, false);
  const rows = readTable_("classroomState");
  const state = rows.find(function (item) { return String(item.boardId) === String(board.id); });
  const inkRows = readTable_("ink").filter(function (item) { return String(item.boardId) === String(board.id); });
  const inkVersion = inkVersion_(inkRows);
  const inkChanged = String(payload.inkVersion || "") !== inkVersion;
  return {
    ok: true,
    state: publicClassroomState_(state, board.id),
    inkVersion: inkVersion,
    inkChanged: inkChanged,
    ink: inkChanged ? inkRows.map(publicInk_) : null,
    serverTime: now_()
  };
}

function saveClassroomState_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, true);
  const item = {
    id: "STATE-" + board.id,
    boardId: board.id,
    page: Math.max(1, Number(payload.page) || 1),
    zoom: Math.max(0.6, Math.min(2.2, Number(payload.zoom) || 1)),
    updatedAt: now_()
  };
  const existing = readTable_("classroomState").find(function (row) { return String(row.id) === item.id; });
  if (existing) updateRow_("classroomState", item.id, item);
  else appendRow_("classroomState", item);
  return { ok: true, state: publicClassroomState_(item, board.id) };
}

function createBoard_(payload) {
  requireManager_(payload);
  const name = cleanText_(payload.name, MAX_TEXT.name);
  if (!name) throw new Error("請填寫教材版面名稱。");
  const now = now_();
  let boardId = cleanText_(payload.clientBoardId, 80);
  if (!boardId || readTable_("boards").some(function (item) { return String(item.id) === boardId; })) boardId = makeId_("B");
  const board = {
    id: boardId,
    name: name,
    description: cleanText_(payload.description, MAX_TEXT.description),
    pdfFileId: "",
    pdfFileName: "",
    pdfMime: "",
    status: "啟用",
    createdAt: now,
    updatedAt: now
  };
  appendRow_("boards", board);
  if (payload.pdf && payload.pdf.data) {
    const pdfName = safeFileName_(name + "_" + (payload.pdf.name || "講義.pdf"));
    const file = saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "");
    updateRow_("boards", board.id, { pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, updatedAt: now_() });
    board.pdfFileId = file.driveId;
    board.pdfFileName = file.name;
    board.pdfMime = file.mime;
  }
  saveAreas_(board.id, payload.areas || []);
  return { ok: true, board: publicBoard_(board), areas: areasForBoard_(board.id) };
}

function saveAreas_(boardId, areas) {
  const incomingAreas = parseArray_(areas).slice(0, 80);
  const incomingIds = {};
  incomingAreas.forEach(function (area) { if (area && area.id) incomingIds[String(area.id)] = true; });
  const removedAreaIds = readTable_("areas")
    .filter(function (item) { return String(item.boardId) === String(boardId) && !incomingIds[String(item.id)]; })
    .map(function (item) { return item.id; });
  removeSubmissionsForAreas_(boardId, removedAreaIds);
  deleteRows_("areas", function (item) { return String(item.boardId) === String(boardId); });
  const now = now_();
  incomingAreas.sort(compareAreasByPosition_).forEach(function (area, index) {
    const width = Math.max(0.01, Math.min(1, Number(area.width) || 0.2));
    const height = Math.max(0.01, Math.min(1, Number(area.height) || 0.12));
    const x = Math.max(0, Math.min(1 - width, Number(area.x) || 0));
    const y = Math.max(0, Math.min(1 - height, Number(area.y) || 0));
    appendRow_("areas", {
      id: cleanText_(area.id, 80) || makeId_("Q"),
      boardId: boardId,
      page: Math.max(1, Number(area.page) || 1),
      x: x,
      y: y,
      width: width,
      height: height,
      title: cleanText_(area.title || "問答區 " + (index + 1), MAX_TEXT.title),
      prompt: cleanText_(area.prompt || "請輸入你的答案，或拍照上傳。", MAX_TEXT.prompt),
      order: index + 1,
      status: "啟用",
      createdAt: now,
      updatedAt: now
    });
  });
}

function updateBoard_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, true);
  const fields = { updatedAt: now_() };
  if (payload.name !== undefined) {
    fields.name = cleanText_(payload.name, MAX_TEXT.name);
    if (!fields.name) throw new Error("教材版面名稱不可為空白。");
    try {
      const folder = getBoardFolderIfExists_(board.id);
      if (folder) folder.setName(boardFolderName_({ name: fields.name }));
    } catch (e) {}
  }
  if (payload.description !== undefined) fields.description = cleanText_(payload.description, MAX_TEXT.description);
  if (payload.pdf && payload.pdf.data) {
    const pdfName = safeFileName_((fields.name || board.name || "教材") + "_" + (payload.pdf.name || "講義.pdf"));
    const file = saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "");
    fields.pdfFileId = file.driveId;
    fields.pdfFileName = file.name;
    fields.pdfMime = file.mime;
  }
  updateRow_("boards", board.id, fields);
  if (payload.areas !== undefined) saveAreas_(board.id, payload.areas);
  return { ok: true, board: publicBoard_(Object.assign({}, board, fields)), areas: areasForBoard_(board.id) };
}

function archiveBoard_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, true);
  updateRow_("boards", board.id, { status: "封存", updatedAt: now_() });
  return { ok: true };
}

function deleteBoard_(payload) {
  requireManager_(payload);
  const boardId = cleanText_(payload.boardId, 80);
  if (!boardId) throw new Error("缺少教材版面 ID。");
  clearAllTableCaches_();
  const board = readTable_("boards").find(function (item) { return String(item.id) === boardId; });
  const submissions = readTable_("submissions").filter(function (item) { return String(item.boardId) === boardId; });
  const inkRows = readTable_("ink").filter(function (item) { return String(item.boardId) === boardId; });
  const files = readTable_("files").filter(function (item) { return String(item.boardId) === boardId || submissions.some(function (submission) { return String(submission.id) === String(item.submissionId); }); });
  const driveIds = {};
  if (board && board.pdfFileId) driveIds[String(board.pdfFileId)] = true;
  files.forEach(function (file) { if (file.driveId) driveIds[String(file.driveId)] = true; });
  submissions.forEach(function (submission) { submissionDriveIds_(submission).forEach(function (driveId) { driveIds[driveId] = true; }); });
  inkRows.forEach(function (item) { const reference = String(item.strokes || ""); if (reference.indexOf("drive:") === 0) driveIds[reference.slice(6)] = true; });
  const remainingDriveIds = {};
  readTable_("boards").filter(function (item) { return String(item.id) !== boardId; }).forEach(function (item) { if (item.pdfFileId) remainingDriveIds[String(item.pdfFileId)] = true; });
  readTable_("files").filter(function (item) { return String(item.boardId) !== boardId; }).forEach(function (item) { if (item.driveId) remainingDriveIds[String(item.driveId)] = true; });
  readTable_("submissions").filter(function (item) { return String(item.boardId) !== boardId; }).forEach(function (submission) { submissionDriveIds_(submission).forEach(function (driveId) { remainingDriveIds[driveId] = true; }); });
  let trashedDriveFiles = 0;
  Object.keys(driveIds).forEach(function (driveId) {
    if (!driveId || remainingDriveIds[driveId]) return;
    try {
      DriveApp.getFileById(driveId).setTrashed(true);
      trashedDriveFiles += 1;
    } catch (error) {
      // 檔案可能已被手動移除，資料列仍要繼續清理。
    }
  });
  let trashedBoardFolder = false;
  try {
    const folder = getBoardFolderIfExists_(boardId);
    if (folder) {
      folder.setTrashed(true);
      trashedBoardFolder = true;
    }
  } catch (error) {
    // 找不到資料夾時仍完成試算表資料清理。
  }
  const deleted = {
    files: deleteRows_("files", function (item) { return String(item.boardId) === boardId || submissions.some(function (submission) { return String(submission.id) === String(item.submissionId); }); }),
    submissions: deleteRows_("submissions", function (item) { return String(item.boardId) === boardId; }),
    areas: deleteRows_("areas", function (item) { return String(item.boardId) === boardId; }),
    ink: deleteRows_("ink", function (item) { return String(item.boardId) === boardId; }),
    classroomState: deleteRows_("classroomState", function (item) { return String(item.boardId) === boardId; }),
    boards: deleteRows_("boards", function (item) { return String(item.id) === boardId; })
  };
  return { ok: true, boardId: boardId, deleted: deleted, trashedDriveFiles: trashedDriveFiles, trashedBoardFolder: trashedBoardFolder };
}

function saveSubmission_(payload) {
  const board = getBoard_(payload.boardId, false);
  const area = areasForBoard_(board.id).find(function (item) { return String(item.id) === String(payload.areaId); });
  if (!area) throw new Error("找不到指定問答區。");
  const nickname = cleanText_(payload.nickname, MAX_TEXT.nickname);
  if (!nickname) throw new Error("請先輸入暱稱。");
  const id = cleanText_(payload.id, 120) || makeId_("S");
  const existing = readTable_("submissions").find(function (item) { return String(item.id) === id; });
  const imageIds = parseArray_(payload.keepImageFileIds).slice(0, 2);
  const imageNames = parseArray_(payload.keepImageFileNames).slice(0, 2);
  const rawImages = parseArray_(payload.images);
  const remainingSlots = Math.max(0, 2 - imageIds.length);
  rawImages.slice(0, remainingSlots).forEach(function (image, idx) {
    const customName = nickname + "_" + (cleanText_(area.title, 30) || "問答") + "_第" + (imageIds.length + 1) + "張.jpg";
    const filePayload = Object.assign({}, image, { name: customName });
    const file = saveDriveFile_(filePayload, "學生答案照片", board.id, id);
    imageIds.push(file.driveId);
    imageNames.push(file.name);
  });
  const now = now_();
  const item = {
    id: id,
    boardId: board.id,
    areaId: area.id,
    nickname: nickname,
    text: cleanText_(payload.text, MAX_TEXT.answer),
    imageFileIds: JSON.stringify(imageIds.slice(0, 2)),
    imageFileNames: JSON.stringify(imageNames.slice(0, 2)),
    teacherStrokes: "",
    teacherComment: "",
    status: "待批改",
    clientId: cleanText_(payload.clientId, 100),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
  if (!item.text && !imageIds.length) throw new Error("請輸入文字或上傳至少一張照片。");
  if (existing) updateRow_("submissions", id, item);
  else appendRow_("submissions", item);
  return { ok: true, submission: publicSubmission_(item, false) };
}

function listSubmissions_(payload) {
  const board = getBoard_(payload.boardId, false);
  const isTeacher = String(payload.role || "") === "teacher";
  if (isTeacher) requireManager_(payload);
  const nickname = cleanText_(payload.nickname, MAX_TEXT.nickname);
  const rows = readTable_("submissions").filter(function (item) {
    return String(item.boardId) === String(board.id) && (isTeacher || (nickname && String(item.nickname) === nickname));
  });
  rows.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  return { ok: true, data: rows.map(function (item) { return publicSubmission_(item, isTeacher); }), serverTime: now_() };
}

function saveFeedback_(payload) {
  requireManager_(payload);
  const rows = readTable_("submissions");
  const item = rows.find(function (row) { return String(row.id) === String(payload.submissionId); });
  if (!item) throw new Error("找不到指定作答紀錄。");
  const feedback = payload.strokes || { photoIndex: 0, strokes: [] };
  const reference = storeJson_(feedback, "教師批改筆跡", item.boardId, item.id);
  updateRow_("submissions", item.id, {
    teacherStrokes: reference,
    teacherComment: cleanText_(payload.comment, MAX_TEXT.comment),
    status: "已批改",
    updatedAt: now_()
  });
  return { ok: true, submissionId: item.id, feedback: feedback, updatedAt: now_() };
}

function deleteSubmission_(payload) {
  requireManager_(payload);
  const submissionId = cleanText_(payload.submissionId, 120);
  if (!submissionId) throw new Error("缺少作答紀錄 ID。");
  const rows = readTable_("submissions");
  const item = rows.find(function (row) { return String(row.id) === submissionId; });
  if (!item) return { ok: true, submissionId: submissionId, deleted: 0 };

  const driveIds = submissionDriveIds_(item);
  readTable_("files").filter(function (file) {
    return String(file.boardId) === String(item.boardId) && String(file.submissionId) === submissionId;
  }).forEach(function (file) {
    if (file.driveId) driveIds.push(String(file.driveId));
  });

  const remainingSubmissions = rows.filter(function (row) { return String(row.id) !== submissionId; });
  const remainingDriveIds = {};
  remainingSubmissions.forEach(function (sub) {
    submissionDriveIds_(sub).forEach(function (dId) { remainingDriveIds[dId] = true; });
  });

  driveIds.forEach(function (driveId) {
    if (remainingDriveIds[driveId]) return;
    try {
      DriveApp.getFileById(driveId).setTrashed(true);
    } catch (error) {}
  });

  deleteRows_("files", function (file) {
    return String(file.boardId) === String(item.boardId) && String(file.submissionId) === submissionId;
  });

  const deleted = deleteRows_("submissions", function (row) {
    return String(row.id) === submissionId;
  });

  return { ok: true, submissionId: submissionId, boardId: item.boardId, areaId: item.areaId, deleted: deleted };
}

function getFile_(payload) {
  const fileId = cleanText_(payload.fileId, 160);
  if (!fileId) throw new Error("缺少檔案 ID。");
  const index = readTable_("files").find(function (item) { return String(item.driveId) === fileId; });
  if (!index) throw new Error("找不到檔案索引。");
  if (payload.boardId && String(index.boardId) !== String(payload.boardId)) throw new Error("檔案與版面不一致。");
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  return {
    ok: true,
    fileId: fileId,
    name: file.getName(),
    mime: blob.getContentType(),
    size: blob.getBytes().length,
    base64: Utilities.base64Encode(blob.getBytes())
  };
}

function settingsInfo_() {
  const settings = loadSettings_();
  return {
    adminConfigured: Boolean(settings.AdminPassword),
    maxImageBytes: Number(settings.MaxImageBytes) || 2097152,
    maxPdfBytes: Number(settings.MaxPdfBytes) || 20971520,
    driveRootFolderName: settings.DriveRootFolderName || "PDF互動講義檔案"
  };
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error("目前使用人數較多，請稍後再試。");
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  try {
    ensureDatabase_();
    const parameter = e && e.parameter ? e.parameter : {};
    const action = String(parameter.action || "ping");
    if (action === "settings") return jsonOut_({ ok: true, settings: settingsInfo_() });
    if (action === "listBoards") return jsonOut_(listBoards_(parameter));
    if (action === "getBoard") return jsonOut_(getBoardData_(parameter));
    if (action === "classroomSync") return jsonOut_(classroomSync_(parameter));
    if (action === "getFile") return jsonOut_(getFile_(parameter));
    if (action === "sheetUrl") return jsonOut_({ ok: true, url: getSpreadsheet_().getUrl() });
    return jsonOut_({ ok: true, message: "PDF 互動講義 API 已啟動。", serverTime: now_() });
  } catch (error) {
    return jsonOut_({ ok: false, error: String(error.message || error) });
  }
}

function doPost(e) {
  try {
    ensureDatabase_();
    const payload = parsePayload_(e);
    const action = String((e && e.parameter && e.parameter.action) || payload.action || "");
    let result;
    if (action === "verifyAdmin") result = verifyAdmin_(payload);
    else if (action === "listBoards") result = listBoards_(payload);
    else if (action === "getBoard") result = getBoardData_(payload);
    else if (action === "createBoard") result = withLock_(function () { return createBoard_(payload); });
    else if (action === "updateBoard") result = withLock_(function () { return updateBoard_(payload); });
    else if (action === "archiveBoard") result = withLock_(function () { return archiveBoard_(payload); });
    else if (action === "deleteBoard") result = withLock_(function () { return deleteBoard_(payload); });
    else if (action === "listInk") result = listInk_(payload);
    else if (action === "saveInk") result = withLock_(function () { return saveInk_(payload); });
    else if (action === "classroomSync") result = classroomSync_(payload);
    else if (action === "saveClassroomState") result = withLock_(function () { return saveClassroomState_(payload); });
    else if (action === "saveSubmission") result = withLock_(function () { return saveSubmission_(payload); });
    else if (action === "deleteSubmission") result = withLock_(function () { return deleteSubmission_(payload); });
    else if (action === "listSubmissions") result = listSubmissions_(payload);
    else if (action === "saveFeedback") result = withLock_(function () { return saveFeedback_(payload); });
    else if (action === "getFile") result = getFile_(payload);
    else if (action === "sheetUrl") {
      requireManager_(payload);
      result = { ok: true, url: getSpreadsheet_().getUrl() };
    } else {
      throw new Error("未知的 API 動作：「" + action + "」。");
    }
    return jsonOut_(result);
  } catch (error) {
    return jsonOut_({ ok: false, error: String(error.message || error) });
  }
}
