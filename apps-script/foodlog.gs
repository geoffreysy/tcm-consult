/**
 * TCM Consult Assistant — patient food log receiver (Google Apps Script web app)
 *
 * Deploy as the CLINIC OWNER: Execute as "Me", Who has access "Anyone".
 * Patients post entries from foodlog.html?c=<code>&s=<deployment id>. They never sign in and can never read anything back.
 *
 * Files (created by the owner's admin.html "Save access", in the owner's Drive):
 *   tcm-clinic-foodlog-codes.json   { codes: { <code>: { patientId, active } }, shards: 10 }   (doctors: writer)
 *   tcm-clinic-foodlog-00.json … -09.json   { entries: { <id>: entry } }                         (doctors: reader)
 * An entry goes into file  hash(patientId) % shards  (same hash as the doctor app).
 * Photos are stored inside the entry (small JPEG data URL, < 300 KB) so the doctor app — which may only open files
 * the clinic owner shared and the doctor selected once — can show them without any extra permission.
 * No patient names are stored or returned here.
 */
var FL = {
  CODES: "tcm-clinic-foodlog-codes.json",
  SHARD: "tcm-clinic-foodlog-",
  MEALS: ["breakfast", "lunch", "dinner", "snack", "drink"],
  MAX_TEXT: 1000, MAX_NOTE: 500, MAX_PHOTO: 410000,      // data-URL characters (≈ 300 KB of JPEG)
  PER_CODE_HOUR: 40, ALL_HOUR: 600,                      // rate limits
  MAX_FILE_CHARS: 45000000                               // stop adding photos to a full data file (text still accepted)
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
  if (photo && (photo.length > FL.MAX_PHOTO || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(photo))) return { ok: false, error: "bad_photo" };

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var reg = JSON.parse(file_(FL.CODES).getBlob().getDataAsString() || "{}");
    var r = (reg.codes || {})[code];
    if (!r) return { ok: false, error: "invalid_code" };
    if (r.active !== true || !r.patientId) return { ok: false, error: "inactive_code" };
    var n = Math.max(1, Math.min(100, parseInt(reg.shards, 10) || 10));
    var f = file_(FL.SHARD + pad_(shardOf_(String(r.patientId), n)) + ".json");
    var raw = f.getBlob().getDataAsString() || "{}", doc = JSON.parse(raw);
    doc.entries = doc.entries || {};
    if (doc.entries[id]) return { ok: true, id: id, dup: true };                    // retry of an entry already received
    var keepPhoto = photo && raw.length + photo.length < FL.MAX_FILE_CHARS;
    doc.entries[id] = { id: id, patientId: String(r.patientId), at: at.toISOString(), meal: meal, text: text,
      note: note || undefined, photo: keepPhoto ? photo : undefined, photoDropped: photo && !keepPhoto ? true : undefined,
      receivedAt: new Date().toISOString(), code: code.slice(0, 6) };
    doc.kind = "clinic-foodlog"; doc.format = 1; doc.updatedAt = new Date().toISOString();
    f.setContent(JSON.stringify(doc));
    return { ok: true, id: id, photo: photo ? !!keepPhoto : undefined };
  } finally { lock.releaseLock(); }
}

// ---- helpers ----
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function pad_(n) { return (n < 10 ? "0" : "") + n; }
function shardOf_(id, n) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h % n; }
function rate_(cache, key, max) {
  var k = "rl:" + key + ":" + Math.floor(Date.now() / 3600000), v = parseInt(cache.get(k) || "0", 10) + 1;
  cache.put(k, String(v), 3700);
  return v <= max;
}
function file_(name) {   // the owner's own (not trashed) file with this name; id cached in script properties
  var props = PropertiesService.getScriptProperties(), key = "id:" + name, id = props.getProperty(key), me = Session.getEffectiveUser().getEmail();
  if (id) { try { var c = DriveApp.getFileById(id); if (!c.isTrashed() && c.getName() === name) return c; } catch (e) {} }
  var it = DriveApp.getFilesByName(name);
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed() && f.getOwner() && f.getOwner().getEmail() === me) { props.setProperty(key, f.getId()); return f; } }
  throw new Error("missing file " + name + " — open admin.html and press Save access");
}
