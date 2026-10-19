/**
 * TCM Consult Assistant — patient food log receiver (Google Apps Script web app)   v36
 *
 * Deploy as the CLINIC OWNER: Execute as "Me", Who has access "Anyone".
 * Patients post entries from foodlog.html?c=<code>&s=<deployment id>. They never sign in and can never read anything back.
 *
 * Where entries go (v36): INTO the patient's record in the clinic patient database — the owner-owned data file (shard)
 * that index.json lists for that patient:   shard.patients[i].foodLog = [ { id, at, meal, text, note?, photo?, source:"patient", … } ]
 *   • the code list tcm-clinic-foodlog-codes.json ({ indexId, codes: { <code>: { patientId, active } } }) maps a code to a patient id
 *   • only that patient's foodLog array is changed; visits, other patients and tombstones are written back exactly as read
 *   • compatible with the doctor app's merge: entries are unioned by id (newest updatedAt wins; {deleted:true} = hidden by a doctor)
 *   • lock → re-read → append → compare-and-swap → write → wait → verify, with retries (a doctor saving the same file at the
 *     same moment cannot make an entry disappear: it is re-added if a concurrent save overwrote it)
 * No patient names are read into replies, stored in the code list, or returned. There is no read endpoint.
 */
var FL = {
  CODES: "tcm-clinic-foodlog-codes.json",
  MEALS: ["breakfast", "lunch", "dinner", "snack", "drink"],
  MAX_TEXT: 1000, MAX_NOTE: 500,
  MAX_PHOTO: 112000,                 // data-URL characters ≈ 80 KB JPEG (the page makes photos ≤ 800 px, quality ~0.6)
  PER_CODE_HOUR: 40, ALL_HOUR: 600,  // rate limits
  VERIFY_WAIT_MS: 2500, TRIES: 8
};

function doGet() {   // no read endpoint — only says the service is up
  return out_({ ok: true, service: "tcm-foodlog" });
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || ""); } catch (err) { return out_({ ok: false, error: "bad_request" }); }
  try { return out_(handle_(body)); }
  catch (err) { console.error(err); return out_({ ok: false, error: "server_error" }); }
}

function handle_(b) {
  if (!b || typeof b !== "object" || b.action !== "add") return { ok: false, error: "bad_request" };
  var code = String(b.c || "");
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(code)) return { ok: false, error: "invalid_code" };
  var cache = CacheService.getScriptCache();
  if (!rate_(cache, "all", FL.ALL_HOUR) || !rate_(cache, "c:" + code, FL.PER_CODE_HOUR)) return { ok: false, error: "rate_limited" };

  var en = b.entry || {};
  var id = String(en.id || ""), meal = String(en.meal || ""), text = String(en.text || "").trim(), note = String(en.note || "").trim();
  var photo = en.photo == null || en.photo === "" ? "" : String(en.photo);
  var at = new Date(String(en.at || ""));
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return { ok: false, error: "bad_request" };
  if (FL.MEALS.indexOf(meal) < 0) return { ok: false, error: "bad_meal" };
  if (!text) return { ok: false, error: "empty_text" };
  if (text.length > FL.MAX_TEXT || note.length > FL.MAX_NOTE) return { ok: false, error: "too_long" };
  var now = Date.now();
  if (isNaN(at.getTime()) || at.getTime() < now - 31 * 86400000 || at.getTime() > now + 36 * 3600000) return { ok: false, error: "bad_date" };
  if (photo && !/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(photo)) return { ok: false, error: "bad_photo" };
  if (photo.length > FL.MAX_PHOTO) return { ok: false, error: "photo_too_big" };

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var reg = JSON.parse(file_(FL.CODES).getBlob().getDataAsString() || "{}");
    var r = (reg.codes || {})[code];
    if (!r) return { ok: false, error: "invalid_code" };
    if (r.active !== true || !r.patientId) return { ok: false, error: "inactive_code" };
    var pid = String(r.patientId);
    var shard = shardFileFor_(reg.indexId, pid);
    if (!shard) return { ok: false, error: "not_ready" };
    var stamp = new Date().toISOString();
    var entry = { id: id, at: at.toISOString(), meal: meal, text: text, source: "patient", receivedAt: stamp, updatedAt: stamp };
    if (note) entry.note = note;
    if (photo) entry.photo = photo;
    for (var i = 0; i < FL.TRIES; i++) {
      var raw = shard.getBlob().getDataAsString(), doc = JSON.parse(raw || "{}");
      var p = (doc.patients || []).filter(function (x) { return x && x.id === pid; })[0];
      if (!p) return { ok: false, error: "not_ready" };
      var have = (p.foodLog || []).filter(function (x) { return x && x.id === id; })[0];
      if (have) return { ok: true, id: id, dup: true };                   // already there (retry from the phone, or re-added)
      p.foodLog = (p.foodLog || []).concat([entry]);
      if (shard.getBlob().getDataAsString() !== raw) continue;           // changed since read → re-read and merge again
      shard.setContent(JSON.stringify(doc));
      Utilities.sleep(FL.VERIFY_WAIT_MS);                                // let a doctor's save that was already in flight land…
      if (hasEntry_(shard, pid, id)) return { ok: true, id: id };        // …then check our entry survived (else: append again)
    }
    return { ok: false, error: "busy" };
  } finally { lock.releaseLock(); }
}

// ---- helpers ----
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function rate_(cache, key, max) {
  var k = "rl:" + key + ":" + Math.floor(Date.now() / 3600000), v = parseInt(cache.get(k) || "0", 10) + 1;
  cache.put(k, String(v), 3700);
  return v <= max;
}
function hasEntry_(f, pid, id) {
  var d = JSON.parse(f.getBlob().getDataAsString() || "{}"), p = (d.patients || []).filter(function (x) { return x && x.id === pid; })[0];
  return !!p && (p.foodLog || []).some(function (x) { return x && x.id === id; });
}
function shardFileFor_(indexId, pid) {   // index.json (follows "rebuilt → supersededBy") → the patient's data file
  if (!indexId) return null;
  var me = Session.getEffectiveUser().getEmail(), id = indexId;
  for (var hop = 0; hop < 5; hop++) {
    var f = DriveApp.getFileById(id);
    if (f.isTrashed() || !f.getOwner() || f.getOwner().getEmail() !== me) return null;
    var idx = JSON.parse(f.getBlob().getDataAsString() || "{}");
    if (idx.supersededBy) { id = idx.supersededBy; continue; }
    var e = (idx.patients || {})[pid];
    if (!e || typeof e.shard !== "number") return null;               // patient has no data file yet
    var s = (idx.shards || []).filter(function (x) { return x.n === e.shard; })[0];
    if (!s || !s.fileId) return null;
    var sf = DriveApp.getFileById(s.fileId);
    return sf.isTrashed() || sf.getOwner().getEmail() !== me ? null : sf;
  }
  return null;
}
function file_(name) {   // the owner's own (not trashed) file with this name; id cached in script properties
  var props = PropertiesService.getScriptProperties(), key = "id:" + name, id = props.getProperty(key), me = Session.getEffectiveUser().getEmail();
  if (id) { try { var c = DriveApp.getFileById(id); if (!c.isTrashed() && c.getName() === name) return c; } catch (e) {} }
  var it = DriveApp.getFilesByName(name);
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed() && f.getOwner() && f.getOwner().getEmail() === me) { props.setProperty(key, f.getId()); return f; } }
  throw new Error("missing file " + name + " — open admin.html and press Save access");
}
