/**
 * Code.gs — 개인 대시보드(PWA) 백엔드 v2
 *
 * Google Sheets를 단순 KV(Key-Value) 저장소로 사용한다.
 * 프런트엔드의 기존 window.storage.get/set 패턴을 그대로 흉내내
 * (key, value, updatedAt) 3열 시트 하나로 모든 상태를 저장한다.
 *
 * v2 변경 (2026-07-05):
 *  - setNotionToken: 앱 화면에서 Notion 토큰을 1회 붙여넣으면 Script Properties에 저장
 *  - notionStatus:   토큰 등록 여부 조회 (토큰 값 자체는 절대 반환하지 않음)
 *  - gcalSync:       태스크를 구글 캘린더 종일 이벤트로 업서트/정리 (CalendarApp)
 *  - KNOWN_KEYS:     tmv3_widgets(위젯 설정)·tmv3_gcal(캘린더 이벤트 매핑) 추가,
 *                    system_dashboard 제거(시스템 현황 탭 폐기)
 *
 * ⚠️ v2 재배포 절차: 이 파일 전체를 Apps Script 편집기에 덮어붙여넣기 →
 *    배포 → 배포 관리 → 연필(✏) → 버전: 새 버전 → 배포.
 *    CalendarApp이 추가되어 최초 실행 시 "Google 캘린더 관리" 권한 재승인 창이 뜬다.
 *
 * 배포 방법 상세: 사용법.md 참조.
 */

var SHEET_NAME = 'KV';
var NOTION_TOKEN_PROP = 'NOTION_TOKEN';
var NOTION_VERSION = '2022-06-28';
var APP_SECRET_PROP = 'APP_SECRET';
var GCAL_TAG = '[TaskBoard]'; // 이 앱이 만든 이벤트임을 식별하는 설명문 마커

// 공유 비밀 토큰 검사 — 스크립트 속성에 APP_SECRET이 설정되어 있으면
// 요청에 실린 secret 값이 정확히 일치해야만 통과시킨다.
// (URL만으로는 접근 못 하게 하는 이중 방어 — GitHub Pages가 Public 저장소라 URL이 노출돼도 안전)
function _checkSecret(provided) {
  var expected = PropertiesService.getScriptProperties().getProperty(APP_SECRET_PROP);
  if (!expected) return true; // 미설정 시 기존 동작 유지(하위 호환)
  return provided === expected;
}

// ── KV 시트 헬퍼 ──────────────────────────────────────────────
function _sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['key', 'value', 'updatedAt']);
  }
  return sh;
}

function _findRow(sh, key) {
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) return i + 1; // 1-indexed
  }
  return -1;
}

function kvGet(key) {
  var sh = _sheet();
  var row = _findRow(sh, key);
  if (row === -1) return { value: null, updatedAt: null };
  var vals = sh.getRange(row, 2, 1, 2).getValues()[0];
  return { value: vals[0], updatedAt: vals[1] };
}

function kvSet(key, value) {
  var sh = _sheet();
  var row = _findRow(sh, key);
  var now = new Date().toISOString();
  if (row === -1) {
    sh.appendRow([key, value, now]);
  } else {
    sh.getRange(row, 2, 1, 2).setValues([[value, now]]);
  }
  return now;
}

// 프런트엔드가 최초 로드 시 한 번에 가져가는 키 목록
var KNOWN_KEYS = [
  'tmv3_proj', 'tmv3_tasks', 'tmv3_notified',
  'tmv3_nconfig', 'tmv3_nsync', 'tmv3_widgets', 'tmv3_gcal'
];

// ── HTTP 엔트리포인트 ──────────────────────────────────────────
function doGet(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!_checkSecret(e.parameter.secret)) {
      return _json({ ok: false, error: 'unauthorized' });
    }
    var key = e.parameter.key;
    if (key) {
      return _json(kvGet(key));
    }
    var out = {};
    for (var i = 0; i < KNOWN_KEYS.length; i++) {
      out[KNOWN_KEYS[i]] = kvGet(KNOWN_KEYS[i]);
    }
    return _json(out);
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (!_checkSecret(body.secret)) {
      return _json({ ok: false, error: 'unauthorized' });
    }
    var action = body.action;

    if (action === 'set') {
      var updatedAt = kvSet(body.key, body.value);
      return _json({ ok: true, key: body.key, updatedAt: updatedAt });
    }

    if (action === 'notionStatus') {
      var t = PropertiesService.getScriptProperties().getProperty(NOTION_TOKEN_PROP);
      return _json({ ok: true, tokenSet: !!t });
    }

    if (action === 'setNotionToken') {
      var token = String(body.token || '').trim();
      if (!token || token.length < 20) {
        return _json({ ok: false, error: '토큰이 비었거나 너무 짧습니다 — Notion Integration Secret(ntn_... 또는 secret_...)을 그대로 붙여넣어 주세요' });
      }
      PropertiesService.getScriptProperties().setProperty(NOTION_TOKEN_PROP, token);
      return _json({ ok: true, tokenSet: true });
    }

    if (action === 'notionSearch') {
      var res = _notionRequest('POST', '/v1/search', {
        filter: { property: 'object', value: 'database' }
      });
      return _json({ ok: true, result: res });
    }

    if (action === 'notionUpsert') {
      var pageId = body.pageId;
      var databaseId = body.databaseId;
      var properties = body.properties;
      var result;
      if (pageId) {
        result = _notionRequest('PATCH', '/v1/pages/' + pageId, { properties: properties });
        if (result.object === 'error') return _json({ ok: false, error: result.message });
        return _json({ ok: true, page_id: pageId, result: result });
      }
      result = _notionRequest('POST', '/v1/pages', {
        parent: { database_id: databaseId },
        properties: properties
      });
      if (result.object === 'error') return _json({ ok: false, error: result.message });
      return _json({ ok: true, page_id: result.id, result: result });
    }

    if (action === 'gcalSync') {
      return _json(_gcalSync(body.tasks || []));
    }

    return _json({ ok: false, error: '알 수 없는 action: ' + action });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ── 구글 캘린더 동기화 ────────────────────────────────────────
// tasks: [{id, title, start, due, done, category, project}]
// start/due는 'YYYY-MM-DD' (날짜만, 종일 이벤트)
// 마감일(due)이 있는 태스크만 대상. start~due 기간이 있으면 기간 이벤트,
// 없으면 due 이벤트. 모두 종일 이벤트로 생성.
// 매핑(taskId→eventId)은 KV 'tmv3_gcal'에 서버가 직접 보관.
// 앱에서 삭제된 태스크의 이벤트는 정리(삭제)한다.
function _gcalSync(tasks) {
  var cal = CalendarApp.getDefaultCalendar();
  var mapRaw = kvGet('tmv3_gcal').value;
  var map = {};
  try { if (mapRaw) map = JSON.parse(mapRaw); } catch (ignore) {}

  var created = 0, updated = 0, removed = 0, skipped = 0;
  var liveIds = {};

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t || !t.id) continue;
    liveIds[t.id] = true;
    if (!t.due) { skipped++; continue; }

    var prefix = t.category === 'LIFE' ? '🟢' : '🔵';
    var title = (t.done ? '✅ ' : prefix + ' ') + t.title;
    var desc = GCAL_TAG + ' task:' + t.id + (t.project ? '\n프로젝트: ' + t.project : '') + '\nTaskBoard 앱에서 자동 동기화된 일정입니다.';

    var startDt = t.start && t.start <= t.due ? t.start : t.due;
    var endDt = t.due;

    var ev = null;
    if (map[t.id]) {
      try { ev = cal.getEventById(map[t.id]); } catch (ignore2) { ev = null; }
    }

    // 모든 이벤트는 종일 이벤트 (YYYY-MM-DD 형식)
    if (ev) {
      ev.setTitle(title);
      var startDate = _parseDay(startDt);
      var endExclusive = _addDays(_parseDay(endDt), 1);
      ev.setAllDayDates(startDate, endExclusive);
      ev.setDescription(desc);
      updated++;
    } else {
      var startDate = _parseDay(startDt);
      var endExclusive = _addDays(_parseDay(endDt), 1);
      ev = cal.createAllDayEvent(title, startDate, endExclusive, { description: desc });
      map[t.id] = ev.getId();
      created++;
    }
  }

  // 앱에서 사라진 태스크의 이벤트 정리
  for (var taskId in map) {
    if (!liveIds[taskId]) {
      try {
        var stale = cal.getEventById(map[taskId]);
        if (stale) { stale.deleteEvent(); removed++; }
      } catch (ignore3) {}
      delete map[taskId];
    }
  }

  var updatedAt = kvSet('tmv3_gcal', JSON.stringify(map));
  return { ok: true, created: created, updated: updated, removed: removed, skipped: skipped, map: map, updatedAt: updatedAt };
}

function _parseDay(s) {
  var p = String(s).split('T')[0].split('-'); // 'T' 이전 부분만 (시간 제거)
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function _parseDateTime(s) {
  // 'YYYY-MM-DD' 또는 'YYYY-MM-DDTHH:MM' 형식 파싱
  var parts = String(s).split('T');
  var dateParts = parts[0].split('-');
  var timeParts = parts[1] ? parts[1].split(':') : ['0', '0'];
  return new Date(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]),
                  Number(timeParts[0]), Number(timeParts[1]), 0, 0);
}

function _addDays(d, n) {
  var out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

// ── Notion API 프록시 ────────────────────────────────────────
// 브라우저에서 api.notion.com을 직접 호출하면 CORS로 차단되므로
// Apps Script가 서버 역할로 대신 호출한다. 토큰은 클라이언트에
// 절대 노출되지 않고 Script Properties에만 보관된다.
function _notionRequest(method, path, payload) {
  var token = PropertiesService.getScriptProperties().getProperty(NOTION_TOKEN_PROP);
  if (!token) {
    throw new Error('Notion 토큰 미등록 — 앱의 [🔗 Notion 연동 설정] 창에서 토큰을 한 번만 붙여넣어 저장하세요');
  }
  var options = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch('https://api.notion.com' + path, options);
  return JSON.parse(res.getContentText());
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
