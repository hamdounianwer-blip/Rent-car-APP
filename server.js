/**
 * City Rent Barka — server.js (SQLite edition)
 * Mêmes routes HTTP qu'avant, données dans cityrent.db
 * Dépendance: better-sqlite3 (installée automatiquement par START_SAVE.bat)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── SQLite setup ────────────────────────────────────────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('\n  ❌ better-sqlite3 non installé.');
  console.error('  Lance START_SAVE.bat pour l\'installer automatiquement.\n');
  process.exit(1);
}

const DB_FILE = path.join(__dirname, 'cityrent.db');
const db = new Database(DB_FILE);

// Performance & sécurité
db.pragma('journal_mode = WAL');   // Lecture multi-utilisateur sans bloquer
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL'); // Bon équilibre vitesse/sécurité

// ── Création des tables ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS vehicles (
    id          INTEGER PRIMARY KEY,
    data        TEXT    NOT NULL  -- JSON complet du véhicule
  );

  CREATE TABLE IF NOT EXISTS rentals (
    id          INTEGER PRIMARY KEY,
    vehicle_id  INTEGER,
    contract    TEXT,
    date_out    TEXT,
    date_in     TEXT,
    data        TEXT    NOT NULL  -- JSON complet du contrat
  );

  CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY,
    vehicle_id  INTEGER,
    contract    TEXT,
    rental_id   INTEGER,
    data        TEXT    NOT NULL  -- JSON complet du paiement
  );

  CREATE TABLE IF NOT EXISTS logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT,
    label       TEXT,
    detail      TEXT,
    ref         TEXT,
    ts          TEXT,
    ts_display  TEXT
  );

  CREATE TABLE IF NOT EXISTS moves (
    id          INTEGER PRIMARY KEY,
    data        TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gps_links (
    id          INTEGER PRIMARY KEY,
    data        TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS counters (
    key         TEXT    PRIMARY KEY,
    value       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS meta (
    key         TEXT    PRIMARY KEY,
    value       TEXT
  );

  CREATE TABLE IF NOT EXISTS clients (
    id          INTEGER PRIMARY KEY,
    idcard      TEXT,
    data        TEXT    NOT NULL
  );

  -- Index pour accélérer les recherches par contrat, véhicule et date
  CREATE INDEX IF NOT EXISTS idx_rentals_contract   ON rentals(contract);
  CREATE INDEX IF NOT EXISTS idx_rentals_vehicle_id ON rentals(vehicle_id);
  CREATE INDEX IF NOT EXISTS idx_rentals_date_out   ON rentals(date_out);
  CREATE INDEX IF NOT EXISTS idx_rentals_date_in    ON rentals(date_in);
  CREATE INDEX IF NOT EXISTS idx_payments_contract  ON payments(contract);
  CREATE INDEX IF NOT EXISTS idx_payments_vehicle   ON payments(vehicle_id);
  CREATE INDEX IF NOT EXISTS idx_payments_rental    ON payments(rental_id);
  CREATE INDEX IF NOT EXISTS idx_moves_id           ON moves(id);
  CREATE INDEX IF NOT EXISTS idx_clients_idcard      ON clients(idcard);
`);

// ── Helpers DB ──────────────────────────────────────────────────────────

function dbLoad() {
  const vehicles = db.prepare('SELECT data FROM vehicles ORDER BY id').all()
    .map(r => JSON.parse(r.data));

  const rentals = db.prepare('SELECT data FROM rentals ORDER BY id').all()
    .map(r => JSON.parse(r.data));

  const payments = db.prepare('SELECT data FROM payments ORDER BY id').all()
    .map(r => JSON.parse(r.data));

  const logs = db.prepare('SELECT id, type, label, detail, ref, ts, ts_display as tsDisplay FROM logs ORDER BY id').all();

  const moves = db.prepare('SELECT data FROM moves ORDER BY id').all()
    .map(r => JSON.parse(r.data));

  const gpsLinks = db.prepare('SELECT data FROM gps_links ORDER BY id').all()
    .map(r => JSON.parse(r.data));

  const clients = db.prepare('SELECT data FROM clients ORDER BY id').all()
    .map(r => JSON.parse(r.data));

  const counters = db.prepare('SELECT key, value FROM counters').all()
    .reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});

  const savedAt = db.prepare("SELECT value FROM meta WHERE key = 'savedAt'").get();

  return {
    vehicles,
    rentals,
    payments,
    logs,
    moves,
    gpsLinks,
    clients,
    nextVId:   counters['nextVId']   || 1,
    nextRId:   counters['nextRId']   || 1,
    nextPId:   counters['nextPId']   || 1,
    nextMId:   counters['nextMId']   || 1,
    nextGpsId: counters['nextGpsId'] || 1,
    nextCId:   counters['nextCId']   || 1,
    savedAt:   savedAt ? savedAt.value : null,
  };
}

// ── Statements préparés pour upsert granulaire ──────────────────────────
const stmts = {
  upsertVehicle: db.prepare('INSERT OR REPLACE INTO vehicles (id, data) VALUES (?, ?)'),
  deleteVehicle: db.prepare('DELETE FROM vehicles WHERE id = ?'),
  upsertRental:  db.prepare('INSERT OR REPLACE INTO rentals (id, vehicle_id, contract, date_out, date_in, data) VALUES (?, ?, ?, ?, ?, ?)'),
  deleteRental:  db.prepare('DELETE FROM rentals WHERE id = ?'),
  upsertPayment: db.prepare('INSERT OR REPLACE INTO payments (id, vehicle_id, contract, data) VALUES (?, ?, ?, ?)'),
  deletePayment: db.prepare('DELETE FROM payments WHERE id = ?'),
  upsertMove:    db.prepare('INSERT OR REPLACE INTO moves (id, data) VALUES (?, ?)'),
  deleteMove:    db.prepare('DELETE FROM moves WHERE id = ?'),
  upsertGps:     db.prepare('INSERT OR REPLACE INTO gps_links (id, data) VALUES (?, ?)'),
  deleteGps:     db.prepare('DELETE FROM gps_links WHERE id = ?'),
  upsertCounter: db.prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)'),
  upsertMeta:    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
  upsertLog:     db.prepare('INSERT OR REPLACE INTO logs (id, type, label, detail, ref, ts, ts_display) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  allVehicleIds: db.prepare('SELECT id FROM vehicles'),
  allRentalIds:  db.prepare('SELECT id FROM rentals'),
  allPaymentIds: db.prepare('SELECT id FROM payments'),
  allMoveIds:    db.prepare('SELECT id FROM moves'),
  allGpsIds:     db.prepare('SELECT id FROM gps_links'),
  upsertClient:  db.prepare('INSERT OR REPLACE INTO clients (id, idcard, data) VALUES (?, ?, ?)'),
  deleteClient:  db.prepare('DELETE FROM clients WHERE id = ?'),
  allClientIds:  db.prepare('SELECT id FROM clients'),
};

// Sauvegarde complète optimisée — INSERT OR REPLACE + suppression des orphelins
const dbSave = db.transaction((payload) => {
  const { vehicles, rentals, payments, logs, moves, gpsLinks, clients,
          nextVId, nextRId, nextPId, nextMId, nextGpsId, nextCId, savedAt } = payload;

  // ── Vehicles ──────────────────────────────────────────────────────
  const newVIds = new Set((vehicles || []).map(v => v.id));
  stmts.allVehicleIds.all().forEach(r => { if (!newVIds.has(r.id)) stmts.deleteVehicle.run(r.id); });
  const insVehicle = stmts.upsertVehicle;
  (vehicles || []).forEach(v => insVehicle.run(v.id, JSON.stringify(v)));

  // ── Rentals ───────────────────────────────────────────────────────
  const newRIds = new Set((rentals || []).map(r => r.id));
  stmts.allRentalIds.all().forEach(r => { if (!newRIds.has(r.id)) stmts.deleteRental.run(r.id); });
  (rentals || []).forEach(r =>
    stmts.upsertRental.run(r.id, r.vehicleId, r.contract, r.dateOut, r.dateIn, JSON.stringify(r))
  );

  // ── Payments ──────────────────────────────────────────────────────
  const newPIds = new Set((payments || []).map(p => p.id));
  stmts.allPaymentIds.all().forEach(r => { if (!newPIds.has(r.id)) stmts.deletePayment.run(r.id); });
  (payments || []).forEach(p =>
    stmts.upsertPayment.run(p.id, p.vehicleId, p.contract, JSON.stringify(p))
  );

  // ── Logs (réécriture simple — table bornée à 300 entrées) ─────────
  db.prepare('DELETE FROM logs').run();
  (logs || []).forEach(l => {
    const lid = (l.id !== undefined && l.id !== null) ? parseInt(l.id) : null;
    stmts.upsertLog.run(lid, String(l.type||''), String(l.label||''), String(l.detail||''),
               String(l.ref||''), String(l.ts||''), String(l.tsDisplay||''));
  });

  // ── Moves ─────────────────────────────────────────────────────────
  const newMIds = new Set((moves || []).map(m => parseInt(m.id)));
  stmts.allMoveIds.all().forEach(r => { if (!newMIds.has(r.id)) stmts.deleteMove.run(r.id); });
  const insMove = stmts.upsertMove;
  (moves || []).forEach(m => insMove.run(parseInt(m.id), JSON.stringify(m)));

  // ── GPS Links ─────────────────────────────────────────────────────
  const newGIds = new Set((gpsLinks || []).map(g => parseInt(g.id)));
  stmts.allGpsIds.all().forEach(r => { if (!newGIds.has(r.id)) stmts.deleteGps.run(r.id); });
  (gpsLinks || []).forEach(g => stmts.upsertGps.run(parseInt(g.id), JSON.stringify(g)));

  // ── Clients ──────────────────────────────────────────────────────
  const newCIds = new Set((clients || []).map(c => c.id));
  stmts.allClientIds.all().forEach(r => { if (!newCIds.has(r.id)) stmts.deleteClient.run(r.id); });
  (clients || []).forEach(c => stmts.upsertClient.run(c.id, c.idcard || '', JSON.stringify(c)));

  // ── Compteurs ─────────────────────────────────────────────────────
  stmts.upsertCounter.run('nextVId',   nextVId   || 1);
  stmts.upsertCounter.run('nextRId',   nextRId   || 1);
  stmts.upsertCounter.run('nextPId',   nextPId   || 1);
  stmts.upsertCounter.run('nextMId',   nextMId   || 1);
  stmts.upsertCounter.run('nextGpsId', nextGpsId || 1);
  stmts.upsertCounter.run('nextCId',   nextCId   || 1);

  // ── Méta ──────────────────────────────────────────────────────────
  stmts.upsertMeta.run('savedAt', savedAt || new Date().toISOString());
});

// ── Dossier vidéos ──────────────────────────────────────────────────────
const VIDEOS_DIR  = path.join(__dirname, 'videos');
const VIDEOS_JSON = path.join(__dirname, 'videos.json');
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

function loadVideosIndex() {
  try { return JSON.parse(fs.readFileSync(VIDEOS_JSON, 'utf8')); }
  catch { return {}; }
}
function saveVideosIndex(data) {
  fs.writeFileSync(VIDEOS_JSON, JSON.stringify(data, null, 2), 'utf8');
}

// ── Dossier attachments ─────────────────────────────────────────────────
const ATTACHMENTS_DIR  = path.join(__dirname, 'attachments');
const ATTACHMENTS_JSON = path.join(__dirname, 'attachments.json');
if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

function loadAttachmentsIndex() {
  try { return JSON.parse(fs.readFileSync(ATTACHMENTS_JSON, 'utf8')); }
  catch { return {}; }
}
function saveAttachmentsIndex(data) {
  fs.writeFileSync(ATTACHMENTS_JSON, JSON.stringify(data, null, 2), 'utf8');
}

// ── Dossier templates ───────────────────────────────────────────────────
const TEMPLATES_DIR = path.join(__dirname, 'templates');
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

function loadTemplatesIndex() {
  try {
    const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.docx'));
    const templates = {};
    files.forEach(f => { templates[f.replace('.docx', '')] = true; });
    return templates;
  } catch { return {}; }
}

// ── Migration: anciens chemins absolus → chemins relatifs ───────────────
function migrateAttachmentsToRelativePaths() {
  try {
    const index = loadAttachmentsIndex();
    let modified = false;
    for (const key in index) {
      const entry = index[key];
      if (entry.path && (entry.path.includes('\\') || entry.path.includes(':\\'))) {
        const fileName = entry.path.split('\\').pop() || entry.path;
        entry.path = 'attachments/' + fileName;
        modified = true;
        console.log('🔄 Migration: ' + key + ' → ' + entry.path);
      }
    }
    if (modified) {
      saveAttachmentsIndex(index);
      console.log('✅ Migration des chemins d\'attachements complétée');
    }
  } catch(e) {
    console.log('⚠️  Migration skipped:', e.message);
  }
}
migrateAttachmentsToRelativePaths();

// ── Parser multipart (vidéos) ───────────────────────────────────────────
function parseMultipart(req, callback) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body   = Buffer.concat(chunks);
    const ctype  = req.headers['content-type'] || '';
    const bMatch = ctype.match(/boundary=(.+)$/);
    if (!bMatch) return callback(new Error('No boundary'), null, null, null);
    const boundary = Buffer.from('--' + bMatch[1]);
    const parts = [];
    let start = 0;
    while (true) {
      const idx = indexOfBuf(body, boundary, start);
      if (idx === -1) break;
      if (start > 0) parts.push(body.slice(start, idx - 2));
      start = idx + boundary.length + 2;
      if (body.slice(idx + boundary.length, idx + boundary.length + 2).toString() === '--') break;
    }
    let contractKey = null, fileBuffer = null, fileName = 'video.mp4';
    parts.forEach(part => {
      const headerEnd = indexOfBuf(part, Buffer.from('\r\n\r\n'), 0);
      if (headerEnd === -1) return;
      const headerStr = part.slice(0, headerEnd).toString();
      const data = part.slice(headerEnd + 4);
      if (headerStr.includes('name="contractKey"')) contractKey = data.toString().trim();
      else if (headerStr.includes('name="video"')) {
        const fnMatch = headerStr.match(/filename="([^"]+)"/);
        if (fnMatch) fileName = fnMatch[1];
        fileBuffer = data;
      }
    });
    callback(null, contractKey, fileBuffer, fileName);
  });
}

// ── Parser multipart (templates) ────────────────────────────────────────
function parseMultipartTemplate(req, callback) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body   = Buffer.concat(chunks);
    const ctype  = req.headers['content-type'] || '';
    const bMatch = ctype.match(/boundary=(.+)$/);
    if (!bMatch) return callback(new Error('No boundary'), null, null, null);
    const boundary = Buffer.from('--' + bMatch[1]);
    const parts = [];
    let start = 0;
    while (true) {
      const idx = indexOfBuf(body, boundary, start);
      if (idx === -1) break;
      if (start > 0) parts.push(body.slice(start, idx - 2));
      start = idx + boundary.length + 2;
      if (body.slice(idx + boundary.length, idx + boundary.length + 2).toString() === '--') break;
    }
    let templateType = null, fileBuffer = null, fileName = 'template.docx';
    parts.forEach(part => {
      const headerEnd = indexOfBuf(part, Buffer.from('\r\n\r\n'), 0);
      if (headerEnd === -1) return;
      const headerStr = part.slice(0, headerEnd).toString();
      const data = part.slice(headerEnd + 4);
      if (headerStr.includes('name="templateType"')) templateType = data.toString().trim();
      else if (headerStr.includes('name="file"')) {
        const fnMatch = headerStr.match(/filename="([^"]+)"/);
        if (fnMatch) fileName = fnMatch[1];
        fileBuffer = data;
      }
    });
    callback(null, templateType, fileBuffer, fileName);
  });
}

function indexOfBuf(buf, search, offset) {
  for (let i = offset; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) { if (buf[i+j] !== search[j]) { found = false; break; } }
    if (found) return i;
  }
  return -1;
}

// ── Détection MIME par magic bytes ──────────────────────────────────────
function detectMimeTypeBySignature(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    if (buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50)
      return 'image/webp';
  }
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  return null;
}

const PORT      = 3000;
const HTML_FILE = path.join(__dirname, 'app.html');

// ── Helpers HTTP ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

// ── Serveur HTTP ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // CORS pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ── GET / → app.html ────────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500); return res.end('Cannot read app.html: ' + e.message);
    }
  }

  // ── GET /load → charger données depuis SQLite ────────────────────────
  if (req.method === 'GET' && req.url === '/load') {
    try {
      // Vérifier si la DB a des données
      const count = db.prepare('SELECT COUNT(*) as n FROM vehicles').get();
      if (count.n === 0) {
        // DB vide — vérifier si data.json existe pour migration initiale
        const DATA_FILE = path.join(__dirname, 'data.json');
        if (fs.existsSync(DATA_FILE)) {
          console.log('📦 data.json trouvé — migration automatique vers SQLite...');
          const raw = fs.readFileSync(DATA_FILE, 'utf8');
          const parsed = JSON.parse(raw);
          try {
            dbSave(parsed);
            fs.renameSync(DATA_FILE, DATA_FILE + '.bak');
            console.log('✅ Migration terminée. data.json → data.json.bak');
          } catch (migErr) {
            console.error('❌ Erreur migration:', migErr.message);
            throw migErr;
          }
        } else {
          // Vraiment vide — nouvelle installation
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
          return res.end();
        }
      }
      const data = dbLoad();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify(data));
    } catch (e) {
      console.error('❌ Load error:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /save → sauvegarde complète (INSERT OR REPLACE) ──────────
  if (req.method === 'POST' && req.url === '/save') {
    try {
      const body   = await readBody(req);
      const parsed = JSON.parse(body);
      dbSave(parsed);
      const rCount = (parsed.rentals  || []).length;
      const vCount = (parsed.vehicles || []).length;
      const pCount = (parsed.payments || []).length;
      console.log('[' + new Date().toLocaleTimeString() + '] ✅ SAUVEGARDE OK — '
        + vCount + ' véhicules, ' + rCount + ' contrats, ' + pCount + ' paiements');
      return json(res, 200, { ok: true, rentals: rCount, vehicles: vCount });
    } catch (e) {
      console.error('❌ Save error:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /save-one → upsert d'un seul enregistrement ────────────────
  // Body: { table: 'rentals'|'payments'|'vehicles'|'moves'|'gps_links', record: {...} }
  if (req.method === 'POST' && req.url === '/save-one') {
    try {
      const { table, record } = JSON.parse(await readBody(req));
      const t = db.transaction(() => {
        if (table === 'rentals') {
          stmts.upsertRental.run(record.id, record.vehicleId, record.contract,
            record.dateOut, record.dateIn, JSON.stringify(record));
        } else if (table === 'payments') {
          stmts.upsertPayment.run(record.id, record.vehicleId, record.contract, JSON.stringify(record));
        } else if (table === 'vehicles') {
          stmts.upsertVehicle.run(record.id, JSON.stringify(record));
        } else if (table === 'moves') {
          stmts.upsertMove.run(parseInt(record.id), JSON.stringify(record));
        } else if (table === 'gps_links') {
          stmts.upsertGps.run(parseInt(record.id), JSON.stringify(record));
        } else if (table === 'clients') {
          stmts.upsertClient.run(record.id, record.idcard || '', JSON.stringify(record));
        } else {
          throw new Error('Table inconnue: ' + table);
        }
      });
      t();
      return json(res, 200, { ok: true });
    } catch (e) {
      console.error('❌ save-one error:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /delete-one → suppression d'un seul enregistrement ─────────
  // Body: { table: 'rentals'|'payments'|'vehicles'|'moves'|'gps_links', id: ... }
  if (req.method === 'POST' && req.url === '/delete-one') {
    try {
      const { table, id } = JSON.parse(await readBody(req));
      const t = db.transaction(() => {
        if      (table === 'rentals')   stmts.deleteRental.run(id);
        else if (table === 'payments')  stmts.deletePayment.run(id);
        else if (table === 'vehicles')  stmts.deleteVehicle.run(id);
        else if (table === 'moves')     stmts.deleteMove.run(parseInt(id));
        else if (table === 'gps_links') stmts.deleteGps.run(parseInt(id));
        else if (table === 'clients')   stmts.deleteClient.run(id);
        else throw new Error('Table inconnue: ' + table);
      });
      t();
      return json(res, 200, { ok: true });
    } catch (e) {
      console.error('❌ delete-one error:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /attachments ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/attachments') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(loadAttachmentsIndex()));
  }

  // ── GET /stream-attachment/:key ──────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/stream-attachment/')) {
    const key   = decodeURIComponent(req.url.slice('/stream-attachment/'.length));
    const index = loadAttachmentsIndex();
    const entry = index[key];
    if (!entry) {
      console.log('⚠️  [ATTACHMENTS] Clé non trouvée:', key);
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      return res.end('Not found');
    }
    const fullPath = path.join(__dirname, entry.path);
    if (!fs.existsSync(fullPath)) {
      console.log('⚠️  [ATTACHMENTS] Fichier inexistant:', fullPath);
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      return res.end('File not found: ' + entry.path);
    }
    const stat  = fs.statSync(fullPath);
    const total = stat.size;
    const ext   = path.extname(fullPath).toLowerCase();
    let ctype = 'application/octet-stream';
    try {
      const headerBuf = Buffer.alloc(12);
      const fd = fs.openSync(fullPath, 'r');
      fs.readSync(fd, headerBuf, 0, 12, 0);
      fs.closeSync(fd);
      const detectedMime = detectMimeTypeBySignature(headerBuf);
      if (detectedMime) {
        ctype = detectedMime;
      } else {
        const mimeMap = { '.pdf':'application/pdf','.jpg':'image/jpeg','.jpeg':'image/jpeg',
                          '.png':'image/png','.gif':'image/gif','.webp':'image/webp' };
        ctype = mimeMap[ext] || 'application/octet-stream';
      }
    } catch (e) {
      const mimeMap = { '.pdf':'application/pdf','.jpg':'image/jpeg','.jpeg':'image/jpeg',
                        '.png':'image/png','.gif':'image/gif','.webp':'image/webp' };
      ctype = mimeMap[ext] || 'application/octet-stream';
    }
    const range = req.headers.range;
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      const start  = parseInt(s, 10);
      const end    = e ? parseInt(e, 10) : Math.min(start + 1024*1024, total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': ctype });
      return fs.createReadStream(fullPath, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': ctype,
      'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename="${entry.name}"` });
    return fs.createReadStream(fullPath).pipe(res);
  }

  // ── POST /upload-attachment ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/upload-attachment') {
    parseMultipart(req, (err, contractKey, fileBuffer, fileName) => {
      if (err || !contractKey || !fileBuffer) {
        return json(res, 400, { ok: false, error: err ? err.message : 'Missing data' });
      }
      const safeKey  = contractKey.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const safeFile = fileName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const destPath = path.join(ATTACHMENTS_DIR, safeKey + '__' + safeFile);
      const relPath  = 'attachments/' + safeKey + '__' + safeFile;
      const index    = loadAttachmentsIndex();
      if (index[contractKey]) {
        try { fs.unlinkSync(path.join(__dirname, index[contractKey].path)); } catch {}
      }
      try { fs.writeFileSync(destPath, fileBuffer); } catch(e) {
        return json(res, 500, { ok: false, error: 'Write failed: ' + e.message });
      }
      index[contractKey] = { name: fileName, path: relPath, size: fileBuffer.length };
      saveAttachmentsIndex(index);
      console.log('[' + new Date().toLocaleTimeString() + '] 📎 Pièce jointe — ' + contractKey);
      return json(res, 200, { ok: true, name: fileName, size: fileBuffer.length });
    });
    return;
  }

  // ── POST /remove-attachment ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/remove-attachment') {
    try {
      const body = await readBody(req);
      const { receiptKey } = JSON.parse(body);
      const index = loadAttachmentsIndex();
      if (index[receiptKey]) {
        try { fs.unlinkSync(path.join(__dirname, index[receiptKey].path)); } catch {}
        delete index[receiptKey];
        saveAttachmentsIndex(index);
      }
      return json(res, 200, { ok: true });
    } catch(e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // ── GET /videos ──────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/videos') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(loadVideosIndex()));
  }

  // ── GET /stream/:key ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/stream/')) {
    const key   = decodeURIComponent(req.url.slice('/stream/'.length));
    const index = loadVideosIndex();
    const entry = index[key];
    if (!entry || !fs.existsSync(entry.path)) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end('Not found');
    }
    const stat  = fs.statSync(entry.path);
    const total = stat.size;
    const ext   = path.extname(entry.path).toLowerCase();
    const mime  = { '.mp4':'video/mp4','.webm':'video/webm','.mkv':'video/x-matroska',
                    '.avi':'video/x-msvideo','.mov':'video/quicktime','.wmv':'video/x-ms-wmv' };
    const ctype = mime[ext] || 'video/mp4';
    const range = req.headers.range;
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-');
      const start  = parseInt(s, 10);
      const end    = e ? parseInt(e, 10) : Math.min(start + 1024*1024, total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': ctype });
      return fs.createReadStream(entry.path, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': ctype, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(entry.path).pipe(res);
  }

  // ── POST /upload (vidéo) ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/upload') {
    parseMultipart(req, (err, contractKey, fileBuffer, fileName) => {
      if (err || !contractKey || !fileBuffer) {
        return json(res, 400, { ok: false, error: err ? err.message : 'Missing data' });
      }
      const safeKey  = contractKey.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const safeFile = fileName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const destPath = path.join(VIDEOS_DIR, safeKey + '__' + safeFile);
      const index    = loadVideosIndex();
      if (index[contractKey] && index[contractKey].path !== destPath) {
        try { fs.unlinkSync(index[contractKey].path); } catch {}
      }
      try { fs.writeFileSync(destPath, fileBuffer); } catch(e) {
        return json(res, 500, { ok: false, error: 'Write failed: ' + e.message });
      }
      index[contractKey] = { name: fileName, path: destPath, size: fileBuffer.length };
      saveVideosIndex(index);
      console.log('[' + new Date().toLocaleTimeString() + '] 🎬 Vidéo — ' + contractKey
        + ' (' + (fileBuffer.length/1048576).toFixed(1) + ' MB)');
      return json(res, 200, { ok: true, name: fileName, size: fileBuffer.length });
    });
    return;
  }

  // ── POST /remove-video ───────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/remove-video') {
    try {
      const body = await readBody(req);
      const { contractKey } = JSON.parse(body);
      const index = loadVideosIndex();
      if (index[contractKey]) {
        try { fs.unlinkSync(index[contractKey].path); } catch {}
        delete index[contractKey];
        saveVideosIndex(index);
      }
      return json(res, 200, { ok: true });
    } catch(e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  // ── POST /anthropic → proxy API ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/anthropic') {
    try {
      const body = await readBody(req);
      JSON.parse(body);
      const https  = require('https');
      const apiKey = process.env.ANTHROPIC_API_KEY || '';
      if (!apiKey) {
        return json(res, 500, { error: 'ANTHROPIC_API_KEY non définie.' });
      }
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-api-key':          apiKey,
          'anthropic-version':  '2023-06-01',
          'Content-Length':     Buffer.byteLength(body),
        },
      };
      const proxyReq = https.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => { data += chunk; });
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          });
          res.end(data);
        });
      });
      proxyReq.on('error', (e) => json(res, 502, { error: 'Proxy error: ' + e.message }));
      proxyReq.write(body);
      proxyReq.end();
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    return;
  }

  // ── GET /api/templates ───────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/templates') {
    return json(res, 200, loadTemplatesIndex());
  }

  // ── GET /api/templates/:type ─────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/templates/')) {
    const type     = req.url.slice('/api/templates/'.length);
    const safeName = type.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filePath = path.join(TEMPLATES_DIR, safeName + '.docx');
    if (!fs.existsSync(filePath)) {
      return json(res, 404, { error: 'Template non trouvé: ' + safeName });
    }
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': 'attachment; filename="' + safeName + '.docx"',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(buf);
  }

  // ── POST /api/templates/upload ───────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/templates/upload') {
    parseMultipartTemplate(req, (err, templateType, fileBuffer, fileName) => {
      if (err || !templateType || !fileBuffer) {
        return json(res, 400, { success: false, error: err ? err.message : 'Données manquantes' });
      }
      const safeName = templateType.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const destPath = path.join(TEMPLATES_DIR, safeName + '.docx');
      try {
        fs.writeFileSync(destPath, fileBuffer);
        console.log('[' + new Date().toLocaleTimeString() + '] 📋 Template — ' + safeName);
        return json(res, 200, { success: true, type: safeName });
      } catch(e) {
        return json(res, 500, { success: false, error: 'Écriture échouée: ' + e.message });
      }
    });
    return;
  }

  // 404
  res.writeHead(404); res.end('Not found');
});


// ── Backup automatique toutes les 2h ────────────────────────────────────
const BACKUP_DIR   = path.join(__dirname, 'backups');
const BACKUP_MAX   = 30;
const BACKUP_EVERY = 2 * 60 * 60 * 1000;
const VACUUM_EVERY = 7 * 24 * 60 * 60 * 1000; // Défragmentation hebdomadaire

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function makeBackup() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const now  = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const name = 'cityrent_' + now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate())
               + '_' + pad(now.getHours()) + '-' + pad(now.getMinutes()) + '.db';
    const dest = path.join(BACKUP_DIR, name);
    fs.copyFileSync(DB_FILE, dest);
    console.log('[' + new Date().toLocaleTimeString() + '] Backup auto -> backups/' + name);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('cityrent_') && f.endsWith('.db'))
      .sort();
    if (files.length > BACKUP_MAX) {
      files.slice(0, files.length - BACKUP_MAX).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch(e) {}
      });
    }
  } catch (e) {
    console.error('[' + new Date().toLocaleTimeString() + '] Backup echoue:', e.message);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  console.log('');
  console.log('  City Rent Barka - Serveur demarre');
  console.log('  http://localhost:3000');
  console.log('  Base de donnees : cityrent.db');
  console.log('  Backup auto     : toutes les 2h -> backups/');
  console.log('');

  makeBackup();
  setInterval(makeBackup, BACKUP_EVERY);

  // VACUUM hebdomadaire — défragmente cityrent.db et libère l'espace disque
  function runVacuum() {
    try {
      db.exec('VACUUM;');
      console.log('[' + new Date().toLocaleTimeString() + '] 🧹 VACUUM terminé — base de données optimisée');
    } catch (e) {
      console.error('[' + new Date().toLocaleTimeString() + '] VACUUM échoué:', e.message);
    }
  }
  setInterval(runVacuum, VACUUM_EVERY);

  const { exec } = require('child_process');
  const cmd = process.platform === 'win32'  ? 'start "" "' + url + '"'
            : process.platform === 'darwin' ? 'open "' + url + '"'
            : 'xdg-open "' + url + '"';
  exec(cmd, err => { if(err) console.log('  Ouvre manuellement :', url); });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  ⚠️  Le port ' + PORT + ' est déjà utilisé.');
    console.error('  Ferme l\'autre fenêtre du serveur et réessaie.\n');
  } else {
    console.error('Erreur serveur:', e.message);
  }
  process.exit(1);
});

