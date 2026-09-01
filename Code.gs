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
  materials: {
    name: "課堂教材",
    headers: ["教材ID", "版面ID", "教材名稱", "教材說明", "PDF檔案ID", "PDF檔名", "PDF類型", "排序", "狀態", "建立時間", "修改時間"],
    keys: ["id", "boardId", "name", "description", "pdfFileId", "pdfFileName", "pdfMime", "order", "status", "createdAt", "updatedAt"]
  },
  areas: {
    name: "問答區",
    headers: ["問答區ID", "版面ID", "教材ID", "頁碼", "左座標", "上座標", "寬度", "高度", "區域標題", "題目指示", "排序", "狀態", "建立時間", "修改時間"],
    keys: ["id", "boardId", "materialId", "page", "x", "y", "width", "height", "title", "prompt", "order", "status", "createdAt", "updatedAt"]
  },
  ink: {
    name: "教師手寫",
    headers: ["筆跡ID", "版面ID", "教材ID", "頁碼", "筆跡資料", "修改時間"],
    keys: ["id", "boardId", "materialId", "page", "strokes", "updatedAt"]
  },
  classroomState: {
    name: "課堂狀態",
    headers: ["狀態ID", "版面ID", "教材ID", "目前頁碼", "縮放比例", "修改時間"],
    keys: ["id", "boardId", "materialId", "page", "zoom", "updatedAt"]
  },
  submissions: {
    name: "作答紀錄",
    headers: ["作答ID", "版面ID", "教材ID", "問答區ID", "學生暱稱", "文字答案", "圖片檔案ID", "圖片檔名", "教師筆跡", "教師評語", "批改狀態", "裝置代碼", "建立時間", "修改時間"],
    keys: ["id", "boardId", "materialId", "areaId", "nickname", "text", "imageFileIds", "imageFileNames", "teacherStrokes", "teacherComment", "status", "clientId", "createdAt", "updatedAt"]
  },
  files: {
    name: "檔案索引",
    headers: ["檔案索引ID", "檔案用途", "原始檔名", "MIME類型", "Drive檔案ID", "檔案大小", "版面ID", "教材ID", "作答ID", "建立時間"],
    keys: ["id", "purpose", "name", "mime", "driveId", "size", "boardId", "materialId", "submissionId", "createdAt"]
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
const TABLE_CACHE_PREFIX = "pdfw_table_v2_materials_";
const DATABASE_READY_CACHE_KEY = "pdfw_database_ready_v3_materials";
const JSON_REFERENCE_CACHE_PREFIX = "pdfw_json_v1_";
const JSON_REFERENCE_CACHE_SECONDS = 300;
const INK_DELTA_CACHE_PREFIX = "pdfw_ink_delta_v1_";
const INK_DELTA_CACHE_SECONDS = 300;

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
    migrateLegacyMaterials_();
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
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(headers.map(function (header) {
    const fieldIndex = table.headers.indexOf(header);
    const field = fieldIndex < 0 ? "" : table.keys[fieldIndex];
    const value = field && item[field] !== undefined && item[field] !== null ? item[field] : "";
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

function saveDriveFile_(filePayload, purpose, boardId, submissionId, materialId) {
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
    materialId: materialId || "",
    submissionId: submissionId || "",
    createdAt: now_()
  };
  appendRow_("files", index);
  return { driveId: file.getId(), name: fileName, mime: mime, size: bytes.length };
}

function storeJson_(value, purpose, boardId, submissionId, materialId) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (text.length <= MAX_SHEET_JSON_CHARS) return text;
  const file = saveDriveFile_({
    name: purpose + "-" + (submissionId || boardId || "資料") + ".json",
    mime: "application/json",
    data: Utilities.base64Encode(Utilities.newBlob(text).getBytes())
  }, purpose, boardId, submissionId, materialId);
  const reference = "drive:" + file.driveId;
  cacheJsonReference_(reference, text);
  return reference;
}

function jsonReferenceCacheKey_(reference) {
  return JSON_REFERENCE_CACHE_PREFIX + String(reference || "").slice(6);
}

function cacheJsonReference_(reference, text) {
  try {
    CacheService.getScriptCache().put(jsonReferenceCacheKey_(reference), String(text || ""), JSON_REFERENCE_CACHE_SECONDS);
  } catch (error) {
    // 大型 JSON 可能超過 CacheService 單筆大小限制，改由 Drive 讀取。
  }
}

function readJsonReference_(value) {
  const text = String(value || "");
  if (text.indexOf("drive:") !== 0) return parseObject_(text, {});
  let cached = "";
  try {
    cached = CacheService.getScriptCache().get(jsonReferenceCacheKey_(text));
  } catch (error) {}
  if (cached) return parseObject_(cached, {});
  try {
    const file = DriveApp.getFileById(text.slice(6));
    const parsed = parseObject_(file.getBlob().getDataAsString("UTF-8"), {});
    cacheJsonReference_(text, JSON.stringify(parsed));
    return parsed;
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

function legacyMaterialId_(boardId) {
  return "M-" + String(boardId || "") + "-legacy";
}

function legacyMaterial_(board) {
  if (!board || !board.pdfFileId) return null;
  return {
    id: legacyMaterialId_(board.id),
    boardId: board.id,
    name: board.pdfFileName || "主要教材",
    description: "既有單一 PDF 教材",
    pdfFileId: board.pdfFileId,
    pdfFileName: board.pdfFileName,
    pdfMime: board.pdfMime || "application/pdf",
    order: 1,
    status: "啟用",
    createdAt: board.createdAt || "",
    updatedAt: board.updatedAt || "",
    legacy: true
  };
}

function publicMaterial_(item) {
  return {
    id: item.id,
    boardId: item.boardId,
    name: item.name || "未命名教材",
    description: item.description || "",
    pdfFileId: item.pdfFileId || "",
    pdfFileName: item.pdfFileName || "",
    pdfMime: item.pdfMime || "application/pdf",
    order: Number(item.order) || 1,
    status: item.status || "啟用",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
    legacy: Boolean(item.legacy) || String(item.id) === legacyMaterialId_(item.boardId)
  };
}

function materialsForBoard_(boardId, board) {
  const targetBoard = board || getBoard_(boardId, false);
  const rows = readTable_("materials")
    .filter(function (item) { return String(item.boardId) === String(targetBoard.id) && String(item.status || "啟用") === "啟用"; })
    .map(publicMaterial_)
    .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)); });
  if (rows.length || !targetBoard.pdfFileId) return rows;
  return [publicMaterial_(legacyMaterial_(targetBoard))];
}

function materialForBoard_(board, materialId) {
  const targetId = String(materialId || legacyMaterialId_(board.id));
  const material = materialsForBoard_(board.id, board).find(function (item) { return String(item.id) === targetId; });
  if (!material) throw new Error("找不到指定課堂教材。");
  return material;
}

function materialIdForItem_(board, materialId) {
  return String(materialId || legacyMaterialId_(board.id));
}

function isLegacyMaterialId_(board, materialId) {
  return String(materialId || "") === legacyMaterialId_(board.id);
}

function areasForBoard_(boardId, board) {
  const targetBoard = board || getBoard_(boardId, false);
  const legacyId = legacyMaterialId_(targetBoard.id);
  return readTable_("areas")
    .filter(function (item) { return String(item.boardId) === String(targetBoard.id) && String(item.status || "啟用") === "啟用"; })
    .map(function (item) { return Object.assign({}, item, { materialId: String(item.materialId || legacyId) }); })
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

function removeSubmissionsForAreas_(boardId, areaIds, materialId) {
  const targetAreas = {};
  (areaIds || []).forEach(function (areaId) { targetAreas[String(areaId)] = true; });
  const targetMaterialId = materialId ? String(materialId) : "";
  const submissions = readTable_("submissions").filter(function (item) {
    if (String(item.boardId) !== String(boardId)) return false;
    if (targetAreas[String(item.areaId)]) return true;
    return Boolean(targetMaterialId) && String(item.materialId || legacyMaterialId_(boardId)) === targetMaterialId;
  });
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
  return deleteRows_("submissions", function (item) {
    if (String(item.boardId) !== String(boardId)) return false;
    if (targetAreas[String(item.areaId)]) return true;
    return Boolean(targetMaterialId) && String(item.materialId || legacyMaterialId_(boardId)) === targetMaterialId;
  });
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
    updatedAt: board.updatedAt,
    materials: materialsForBoard_(board.id, board)
  };
}

function publicInk_(item, strokesOverride) {
  return {
    id: item.id,
    boardId: item.boardId,
    materialId: item.materialId || legacyMaterialId_(item.boardId),
    page: Number(item.page) || 1,
    strokes: strokesOverride === undefined ? readJsonReference_(item.strokes) : strokesOverride,
    updatedAt: item.updatedAt
  };
}

function inkVersion_(rows) {
  return rows.map(function (item) { return String(item.id || "") + ":" + String(item.updatedAt || ""); }).sort().join("|");
}

function inkVersionMap_(value) {
  const output = {};
  String(value || "").split("|").forEach(function (entry) {
    const delimiter = entry.indexOf(":");
    if (delimiter < 1) return;
    output[entry.slice(0, delimiter)] = entry.slice(delimiter + 1);
  });
  return output;
}

function inkDeltaCacheKey_(inkId) {
  return INK_DELTA_CACHE_PREFIX + String(inkId || "");
}

function readInkDeltaRecords_(inkId) {
  try {
    return parseArray_(CacheService.getScriptCache().get(inkDeltaCacheKey_(inkId))).filter(function (record) { return record && typeof record === "object"; });
  } catch (error) {
    return [];
  }
}

function clearInkDeltaRecords_(inkId) {
  try {
    CacheService.getScriptCache().remove(inkDeltaCacheKey_(inkId));
  } catch (error) {}
}

function writeInkDeltaRecord_(inkId, baseVersion, version, strokes) {
  try {
    const records = readInkDeltaRecords_(inkId);
    const last = records[records.length - 1];
    const chain = !last || String(last.version || "") === String(baseVersion || "") ? records : [];
    chain.push({ baseVersion: String(baseVersion || ""), version: String(version || ""), strokes: Array.isArray(strokes) ? strokes : [] });
    CacheService.getScriptCache().put(inkDeltaCacheKey_(inkId), JSON.stringify(chain.slice(-12)), INK_DELTA_CACHE_SECONDS);
  } catch (error) {
    // 筆跡增量過大時改回傳完整筆跡，不影響保存結果。
  }
}

function inkAppendDelta_(item, clientVersion) {
  const targetVersion = String(clientVersion || "");
  const currentVersion = String(item.updatedAt || "");
  if (targetVersion === currentVersion) return null;
  const records = readInkDeltaRecords_(item.id);
  if (!records.length) return null;
  const seen = {};
  const strokes = [];
  let version = targetVersion;
  while (version !== currentVersion) {
    if (seen[version]) return null;
    seen[version] = true;
    const record = records.find(function (candidate) { return String(candidate.baseVersion || "") === version; });
    if (!record || String(record.version || "") === version || !Array.isArray(record.strokes)) return null;
    record.strokes.forEach(function (stroke) { strokes.push(stroke); });
    version = String(record.version || "");
  }
  return { strokes: strokes };
}

function publicInkDelta_(item, clientVersions) {
  const delta = inkAppendDelta_(item, clientVersions[String(item.id)] || "");
  if (!delta) return null;
  const output = publicInk_(item, delta.strokes);
  output.strokesMode = "append";
  return output;
}

function compactPublicInk_(item) {
  return {
    id: item.id,
    boardId: item.boardId,
    materialId: item.materialId || legacyMaterialId_(item.boardId),
    page: Number(item.page) || 1,
    updatedAt: item.updatedAt
  };
}

function strokesHavePrefix_(prefix, strokes) {
  if (!Array.isArray(prefix) || !Array.isArray(strokes) || prefix.length > strokes.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(prefix[index]) !== JSON.stringify(strokes[index])) return false;
  }
  return true;
}

function publicSubmission_(item, includePrivate, fallbackMaterialId) {
  const output = {
    id: item.id,
    boardId: item.boardId,
    materialId: item.materialId || fallbackMaterialId || "",
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
  return { ok: true, board: publicBoard_(board), materials: materialsForBoard_(board.id, board), areas: areasForBoard_(board.id, board), serverTime: now_() };
}

function listInk_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, false);
  const materialId = payload.materialId ? materialForBoard_(board, payload.materialId).id : "";
  const rows = readTable_("ink").filter(function (item) {
    const itemMaterialId = String(item.materialId || legacyMaterialId_(board.id));
    return String(item.boardId) === String(board.id) && (!materialId || itemMaterialId === materialId);
  });
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
  const material = materialForBoard_(board, payload.materialId);
  const materialId = material.id;
  const page = Math.max(1, Number(payload.page) || 1);
  const strokes = Array.isArray(payload.strokes) ? payload.strokes : [];
  const id = isLegacyMaterialId_(board, materialId) ? "INK-" + board.id + "-" + page : "INK-" + board.id + "-" + materialId + "-" + page;
  const existing = readTable_("ink").find(function (row) { return String(row.id) === id; });
  const previousValue = existing ? readJsonReference_(existing.strokes) : [];
  const previousStrokes = Array.isArray(previousValue) ? previousValue : [];
  const appendOnly = strokesHavePrefix_(previousStrokes, strokes);
  const previousVersion = existing ? String(existing.updatedAt || "") : "";
  let updatedAt = now_();
  const previousTime = Date.parse(previousVersion);
  const currentTime = Date.parse(updatedAt);
  if (Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime <= previousTime) updatedAt = new Date(previousTime + 1).toISOString();
  const reference = storeJson_(strokes, "教師頁面手寫", board.id, id, materialId);
  const item = { id: id, boardId: board.id, materialId: materialId, page: page, strokes: reference, updatedAt: updatedAt };
  if (existing) updateRow_("ink", id, item);
  else appendRow_("ink", item);
  if (appendOnly) writeInkDeltaRecord_(id, previousVersion, updatedAt, strokes.slice(previousStrokes.length));
  else clearInkDeltaRecords_(id);
  return { ok: true, annotation: payload.compact ? compactPublicInk_(item) : publicInk_(item) };
}

function publicClassroomState_(item, boardId) {
  return {
    id: item ? item.id : "STATE-" + boardId,
    boardId: boardId,
    materialId: item && item.materialId ? item.materialId : legacyMaterialId_(boardId),
    page: Math.max(1, Number(item && item.page) || 1),
    zoom: Math.max(0.6, Math.min(2.2, Number(item && item.zoom) || 1)),
    updatedAt: item ? item.updatedAt : ""
  };
}

function submissionCountsForBoard_(boardId, materialId, board, areas) {
  const targetBoard = board || getBoard_(boardId, false);
  const targetAreas = areas || areasForBoard_(targetBoard.id, targetBoard);
  const areaMap = {};
  targetAreas.forEach(function (area) { areaMap[String(area.id)] = area; });
  const counts = {};
  readTable_("submissions").forEach(function (item) {
    if (String(item.boardId) !== String(targetBoard.id)) return;
    const area = areaMap[String(item.areaId)];
    if (!area || (materialId && String(area.materialId) !== String(materialId))) return;
    counts[String(item.areaId)] = (counts[String(item.areaId)] || 0) + 1;
  });
  return counts;
}

function classroomSync_(payload) {
  const board = getBoard_(payload.boardId, false);
  const materials = materialsForBoard_(board.id, board);
  const rows = readTable_("classroomState");
  const state = rows.find(function (item) { return String(item.boardId) === String(board.id); });
  const requestedMaterial = payload.materialId ? materials.find(function (item) { return String(item.id) === String(payload.materialId); }) : null;
  const stateMaterialId = state && state.materialId ? String(state.materialId) : legacyMaterialId_(board.id);
  const requestedMaterialId = (requestedMaterial && requestedMaterial.id) || (materials.find(function (item) { return String(item.id) === stateMaterialId; }) || materials[0] || { id: legacyMaterialId_(board.id) }).id;
  const inkRows = readTable_("ink").filter(function (item) {
    return String(item.boardId) === String(board.id) && String(item.materialId || legacyMaterialId_(board.id)) === requestedMaterialId;
  });
  const inkVersion = inkVersion_(inkRows);
  const clientInkVersion = String(payload.inkVersion || "");
  const inkChanged = clientInkVersion !== inkVersion;
  const useInkDelta = String(payload.inkDelta || "") === "1";
  const clientInkVersions = inkVersionMap_(clientInkVersion);
  const changedInkRows = inkChanged ? inkRows.filter(function (item) {
    return String(clientInkVersions[String(item.id)] || "") !== String(item.updatedAt || "");
  }) : [];
  const areas = areasForBoard_(board.id, board);
  const includeSubmissionCounts = String(payload.includeSubmissionCounts || "1") !== "0";
  const sharedState = publicClassroomState_(state, board.id);
  if (materials.length && !materials.some(function (item) { return String(item.id) === String(sharedState.materialId); })) sharedState.materialId = materials[0].id;
  return {
    ok: true,
    state: sharedState,
    inkVersion: inkVersion,
    inkChanged: inkChanged,
    ink: inkChanged ? (useInkDelta ? changedInkRows.map(function (item) { return publicInkDelta_(item, clientInkVersions) || publicInk_(item); }) : inkRows.map(publicInk_)) : null,
    inkDelta: useInkDelta,
    inkReset: useInkDelta && !clientInkVersion,
    materialId: requestedMaterialId,
    materials: materials,
    areas: areas,
    submissionCounts: includeSubmissionCounts ? submissionCountsForBoard_(board.id, requestedMaterialId, board, areas) : null,
    serverTime: now_()
  };
}

function saveClassroomState_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, true);
  const materialId = materialForBoard_(board, payload.materialId).id;
  const item = {
    id: "STATE-" + board.id,
    boardId: board.id,
    materialId: materialId,
    page: Math.max(1, Number(payload.page) || 1),
    zoom: Math.max(0.6, Math.min(2.2, Number(payload.zoom) || 1)),
    updatedAt: now_()
  };
  const existing = readTable_("classroomState").find(function (row) { return String(row.id) === item.id; });
  if (existing) updateRow_("classroomState", item.id, item);
  else appendRow_("classroomState", item);
  return { ok: true, state: publicClassroomState_(item, board.id) };
}

function materializeLegacyMaterial_(board) {
  const legacyId = legacyMaterialId_(board.id);
  const existing = readTable_("materials").find(function (item) { return String(item.id) === legacyId; });
  const legacy = existing || legacyMaterial_(board);
  if (!legacy) return null;
  if (!existing) appendRow_("materials", legacy);
  readTable_("areas").filter(function (item) {
    return String(item.boardId) === String(board.id) && !item.materialId;
  }).forEach(function (item) { updateRow_("areas", item.id, { materialId: legacyId }); });
  readTable_("ink").filter(function (item) {
    return String(item.boardId) === String(board.id) && !item.materialId;
  }).forEach(function (item) { updateRow_("ink", item.id, { materialId: legacyId }); });
  readTable_("classroomState").filter(function (item) {
    return String(item.boardId) === String(board.id) && !item.materialId;
  }).forEach(function (item) { updateRow_("classroomState", item.id, { materialId: legacyId }); });
  const submissionMaterialIds = {};
  readTable_("submissions").filter(function (item) {
    return String(item.boardId) === String(board.id);
  }).forEach(function (item) {
    const area = readTable_("areas").find(function (candidate) { return String(candidate.id) === String(item.areaId); });
    const materialId = item.materialId || (area && area.materialId) || legacyId;
    submissionMaterialIds[String(item.id)] = materialId;
    if (!item.materialId) updateRow_("submissions", item.id, { materialId: materialId });
  });
  readTable_("files").filter(function (item) {
    return String(item.boardId) === String(board.id) && !item.materialId;
  }).forEach(function (item) {
    const materialId = String(item.driveId) === String(board.pdfFileId) ? legacyId : submissionMaterialIds[String(item.submissionId)] || "";
    if (materialId) updateRow_("files", item.id, { materialId: materialId });
  });
  return legacy;
}

function migrateLegacyMaterials_() {
  readTable_("boards").filter(function (board) { return board && board.pdfFileId; }).forEach(function (board) {
    materializeLegacyMaterial_(board);
  });
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
    const materialId = legacyMaterialId_(board.id);
    const file = saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "", materialId);
    updateRow_("boards", board.id, { pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, updatedAt: now_() });
    board.pdfFileId = file.driveId;
    board.pdfFileName = file.name;
    board.pdfMime = file.mime;
    appendRow_("materials", { id: materialId, boardId: board.id, name: payload.pdf.name || "主要教材", description: "", pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, order: 1, status: "啟用", createdAt: now, updatedAt: now });
  }
  saveAreas_(board.id, payload.areas || []);
  return { ok: true, board: publicBoard_(board), materials: materialsForBoard_(board.id, board), areas: areasForBoard_(board.id, board) };
}

function saveAreas_(boardId, areas) {
  const board = getBoard_(boardId, true);
  const materialIds = new Set(materialsForBoard_(board.id, board).map(function (item) { return String(item.id); }));
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
    const materialId = materialIdForItem_(board, area.materialId);
    if (!materialIds.has(materialId)) throw new Error("問答區所屬教材不存在。");
    const width = Math.max(0.01, Math.min(1, Number(area.width) || 0.2));
    const height = Math.max(0.01, Math.min(1, Number(area.height) || 0.12));
    const x = Math.max(0, Math.min(1 - width, Number(area.x) || 0));
    const y = Math.max(0, Math.min(1 - height, Number(area.y) || 0));
    appendRow_("areas", {
      id: cleanText_(area.id, 80) || makeId_("Q"),
      boardId: boardId,
      materialId: materialId,
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
    const materialId = payload.materialId ? String(payload.materialId) : legacyMaterialId_(board.id);
    const material = materialsForBoard_(board.id, board).find(function (item) { return String(item.id) === materialId; });
    if (!material && !isLegacyMaterialId_(board, materialId)) throw new Error("找不到指定課堂教材。");
    const pdfName = safeFileName_(((material && material.name) || fields.name || board.name || "教材") + "_" + (payload.pdf.name || "講義.pdf"));
    const file = saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "", materialId);
    const materialRow = readTable_("materials").find(function (item) { return String(item.id) === materialId; });
    if (materialRow) {
      updateRow_("materials", materialId, { pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, updatedAt: now_() });
    } else if (isLegacyMaterialId_(board, materialId)) {
      appendRow_("materials", { id: materialId, boardId: board.id, name: payload.pdf.name || board.pdfFileName || "主要教材", description: "", pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, order: 1, status: "啟用", createdAt: board.createdAt || now_(), updatedAt: now_() });
    }
    if (isLegacyMaterialId_(board, materialId)) {
      fields.pdfFileId = file.driveId;
      fields.pdfFileName = file.name;
      fields.pdfMime = file.mime;
    }
  }
  updateRow_("boards", board.id, fields);
  if (payload.areas !== undefined) saveAreas_(board.id, payload.areas);
  const updatedBoard = Object.assign({}, board, fields);
  return { ok: true, board: publicBoard_(updatedBoard), materials: materialsForBoard_(board.id, updatedBoard), areas: areasForBoard_(board.id, updatedBoard) };
}

function createMaterial_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, false);
  const name = cleanText_(payload.name, MAX_TEXT.name);
  if (!name) throw new Error("請填寫教材名稱。");
  if (!payload.pdf || !payload.pdf.data) throw new Error("請選擇 PDF 教材。");
  materializeLegacyMaterial_(board);
  const id = cleanText_(payload.id, 100) || makeId_("M");
  if (readTable_("materials").some(function (item) { return String(item.id) === id; })) throw new Error("教材 ID 已存在。");
  const now = now_();
  const order = materialsForBoard_(board.id, board).length + 1;
  const fileName = safeFileName_(name + "_" + (payload.pdf.name || "講義.pdf"));
  const file = saveDriveFile_(Object.assign({}, payload.pdf, { name: fileName }), "PDF教材", board.id, "", id);
  const material = { id: id, boardId: board.id, name: name, description: cleanText_(payload.description, MAX_TEXT.description), pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, order: order, status: "啟用", createdAt: now, updatedAt: now };
  appendRow_("materials", material);
  updateRow_("boards", board.id, { updatedAt: now });
  const updatedBoard = Object.assign({}, board, { updatedAt: now });
  return { ok: true, material: publicMaterial_(material), board: publicBoard_(updatedBoard), materials: materialsForBoard_(board.id, updatedBoard), areas: areasForBoard_(board.id, updatedBoard) };
}

function updateMaterial_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, true);
  const material = materialForBoard_(board, payload.materialId);
  const materialId = material.id;
  const fields = { updatedAt: now_() };
  if (payload.name !== undefined) {
    fields.name = cleanText_(payload.name, MAX_TEXT.name);
    if (!fields.name) throw new Error("教材名稱不可為空白。");
  }
  if (payload.description !== undefined) fields.description = cleanText_(payload.description, MAX_TEXT.description);
  if (payload.pdf && payload.pdf.data) {
    const pdfName = safeFileName_((fields.name || material.name || board.name || "教材") + "_" + (payload.pdf.name || "講義.pdf"));
    const file = saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "", materialId);
    fields.pdfFileId = file.driveId;
    fields.pdfFileName = file.name;
    fields.pdfMime = file.mime;
  }
  const row = readTable_("materials").find(function (item) { return String(item.id) === materialId; });
  if (!row) {
    if (!isLegacyMaterialId_(board, materialId)) throw new Error("找不到指定課堂教材。");
    const legacy = materializeLegacyMaterial_(board);
    if (!legacy) throw new Error("找不到可更新的 PDF 教材。");
    updateRow_("materials", materialId, Object.assign({}, fields, {
      name: fields.name || material.name,
      description: fields.description || material.description,
      pdfFileId: fields.pdfFileId || material.pdfFileId,
      pdfFileName: fields.pdfFileName || material.pdfFileName,
      pdfMime: fields.pdfMime || material.pdfMime
    }));
  } else {
    updateRow_("materials", materialId, fields);
  }
  const boardFields = { updatedAt: fields.updatedAt };
  if (isLegacyMaterialId_(board, materialId)) {
    boardFields.pdfFileId = fields.pdfFileId || material.pdfFileId;
    boardFields.pdfFileName = fields.pdfFileName || material.pdfFileName;
    boardFields.pdfMime = fields.pdfMime || material.pdfMime;
  }
  updateRow_("boards", board.id, boardFields);
  const updatedBoard = Object.assign({}, board, boardFields);
  return { ok: true, material: publicMaterial_(Object.assign({}, material, fields)), board: publicBoard_(updatedBoard), materials: materialsForBoard_(board.id, updatedBoard), areas: areasForBoard_(board.id, updatedBoard) };
}

function deleteMaterial_(payload) {
  requireManager_(payload);
  const board = getBoard_(payload.boardId, true);
  materializeLegacyMaterial_(board);
  const material = materialForBoard_(board, payload.materialId);
  const materials = materialsForBoard_(board.id, board);
  if (materials.length <= 1) throw new Error("至少要保留一份課堂教材。");
  const materialId = material.id;
  const areaIds = areasForBoard_(board.id, board).filter(function (area) { return String(area.materialId) === materialId; }).map(function (area) { return area.id; });
  removeSubmissionsForAreas_(board.id, areaIds, materialId);
  const driveIds = {};
  if (material.pdfFileId) driveIds[String(material.pdfFileId)] = true;
  readTable_("files").filter(function (file) { return String(file.boardId) === String(board.id) && String(file.materialId || "") === materialId; }).forEach(function (file) { if (file.driveId) driveIds[String(file.driveId)] = true; });
  const remainingDriveIds = {};
  readTable_("materials").filter(function (item) { return String(item.boardId) !== String(board.id) || String(item.id) !== materialId; }).forEach(function (item) { if (item.pdfFileId) remainingDriveIds[String(item.pdfFileId)] = true; });
  readTable_("boards").filter(function (item) { return String(item.id) !== String(board.id); }).forEach(function (item) { if (item.pdfFileId) remainingDriveIds[String(item.pdfFileId)] = true; });
  Object.keys(driveIds).forEach(function (driveId) {
    if (remainingDriveIds[driveId]) return;
    try { DriveApp.getFileById(driveId).setTrashed(true); } catch (error) {}
  });
  deleteRows_("files", function (file) { return String(file.boardId) === String(board.id) && String(file.materialId || "") === materialId; });
  deleteRows_("ink", function (item) { return String(item.boardId) === String(board.id) && String(item.materialId || legacyMaterialId_(board.id)) === materialId; });
  deleteRows_("areas", function (item) { return String(item.boardId) === String(board.id) && String(item.materialId || legacyMaterialId_(board.id)) === materialId; });
  deleteRows_("materials", function (item) { return String(item.id) === materialId; });
  const remainingMaterials = materialsForBoard_(board.id, board).filter(function (item) { return String(item.id) !== materialId; });
  const replacement = remainingMaterials[0];
  const stateRow = readTable_("classroomState").find(function (item) { return String(item.boardId) === String(board.id); });
  if (stateRow && String(stateRow.materialId || legacyMaterialId_(board.id)) === materialId) {
    if (replacement) updateRow_("classroomState", stateRow.id, { materialId: replacement.id, page: 1, zoom: 1, updatedAt: now_() });
  }
  const boardFields = { updatedAt: now_() };
  if (isLegacyMaterialId_(board, materialId) && replacement) {
    boardFields.pdfFileId = replacement.pdfFileId || "";
    boardFields.pdfFileName = replacement.pdfFileName || "";
    boardFields.pdfMime = replacement.pdfMime || "";
  }
  updateRow_("boards", board.id, boardFields);
  const updatedBoard = Object.assign({}, board, boardFields);
  return { ok: true, materialId: materialId, materials: remainingMaterials, areas: areasForBoard_(board.id, updatedBoard), board: publicBoard_(updatedBoard) };
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
  const materials = readTable_("materials").filter(function (item) { return String(item.boardId) === boardId; });
  const submissions = readTable_("submissions").filter(function (item) { return String(item.boardId) === boardId; });
  const inkRows = readTable_("ink").filter(function (item) { return String(item.boardId) === boardId; });
  const files = readTable_("files").filter(function (item) { return String(item.boardId) === boardId || submissions.some(function (submission) { return String(submission.id) === String(item.submissionId); }); });
  const driveIds = {};
  if (board && board.pdfFileId) driveIds[String(board.pdfFileId)] = true;
  materials.forEach(function (material) { if (material.pdfFileId) driveIds[String(material.pdfFileId)] = true; });
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
    materials: deleteRows_("materials", function (item) { return String(item.boardId) === boardId; }),
    boards: deleteRows_("boards", function (item) { return String(item.id) === boardId; })
  };
  return { ok: true, boardId: boardId, deleted: deleted, trashedDriveFiles: trashedDriveFiles, trashedBoardFolder: trashedBoardFolder };
}

function saveSubmission_(payload) {
  const board = getBoard_(payload.boardId, false);
  const area = areasForBoard_(board.id, board).find(function (item) { return String(item.id) === String(payload.areaId); });
  if (!area) throw new Error("找不到指定問答區。");
  const materialId = area.materialId || legacyMaterialId_(board.id);
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
    const file = saveDriveFile_(filePayload, "學生答案照片", board.id, id, materialId);
    imageIds.push(file.driveId);
    imageNames.push(file.name);
  });
  const now = now_();
  const item = {
    id: id,
    boardId: board.id,
    materialId: materialId,
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
  return { ok: true, submission: publicSubmission_(item, false, materialId) };
}

function listSubmissions_(payload) {
  const board = getBoard_(payload.boardId, false);
  const isTeacher = String(payload.role || "") === "teacher";
  if (isTeacher) requireManager_(payload);
  const nickname = cleanText_(payload.nickname, MAX_TEXT.nickname);
  const materials = materialsForBoard_(board.id, board);
  const materialId = payload.materialId ? String((materials.find(function (item) { return String(item.id) === String(payload.materialId); }) || {}).id || "") : "";
  if (payload.materialId && !materialId) return { ok: true, data: [], serverTime: now_() };
  const areaMap = {};
  areasForBoard_(board.id, board).forEach(function (area) { areaMap[String(area.id)] = area; });
  const rows = readTable_("submissions").filter(function (item) {
    if (String(item.boardId) !== String(board.id)) return false;
    if (materialId) {
      const itemMaterialId = String(item.materialId || (areaMap[String(item.areaId)] && areaMap[String(item.areaId)].materialId) || legacyMaterialId_(board.id));
      if (itemMaterialId !== materialId) return false;
    }
    return isTeacher || (nickname && String(item.nickname) === nickname);
  });
  rows.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  return { ok: true, data: rows.map(function (item) { return publicSubmission_(item, isTeacher, areaMap[String(item.areaId)] && areaMap[String(item.areaId)].materialId || legacyMaterialId_(board.id)); }), serverTime: now_() };
}

function saveFeedback_(payload) {
  requireManager_(payload);
  const rows = readTable_("submissions");
  const item = rows.find(function (row) { return String(row.id) === String(payload.submissionId); });
  if (!item) throw new Error("找不到指定作答紀錄。");
  const feedback = payload.strokes || { photoIndex: 0, strokes: [] };
  const reference = storeJson_(feedback, "教師批改筆跡", item.boardId, item.id, item.materialId || legacyMaterialId_(item.boardId));
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
  if (payload.materialId && String(index.materialId || legacyMaterialId_(index.boardId)) !== String(payload.materialId)) throw new Error("檔案與教材不一致。");
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
    else if (action === "createMaterial") result = withLock_(function () { return createMaterial_(payload); });
    else if (action === "updateMaterial") result = withLock_(function () { return updateMaterial_(payload); });
    else if (action === "deleteMaterial") result = withLock_(function () { return deleteMaterial_(payload); });
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
