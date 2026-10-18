const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const { createDatabase, getDriverInfo } = require("./db-driver");

const app = express();
const PORT = process.env.PORT || 3010;
const HOST = process.env.HOST || "0.0.0.0";
const sttStandalone = process.env.STT_STANDALONE === "1";

const baseDir = __dirname;
const appDir = baseDir;
const dataDir = process.env.DB_DIR ? String(process.env.DB_DIR) : baseDir;
const uploadsDir = process.env.UPLOADS_DIR ? String(process.env.UPLOADS_DIR) : path.join(baseDir, "Data", "uploads");
const knowledgeUploadsDir = path.join(dataDir, "knowledge-uploads");
const settingsFile = path.join(dataDir, "app-settings.json");
const defaultMobilePhotosDir = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), "Downloads", "Mobile Devices");

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function writeSettings(next) {
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), "utf8");
}

// Env var wins (fixed by deployment); otherwise a saved setting; otherwise the
// running user's Downloads\Mobile Devices folder.
function getMobilePhotosDir() {
  if (process.env.MOBILE_PHOTOS_DIR) return String(process.env.MOBILE_PHOTOS_DIR);
  const saved = readSettings().mobilePhotosDir;
  return saved ? String(saved) : defaultMobilePhotosDir;
}

const portalRootDir = path.join(baseDir, "portal");

// Per-process asset version. It changes on every server restart, so any URL that
// carries "?v=<ASSET_VERSION>" is refetched after a deploy while otherwise being
// cached aggressively by the browser. This fixes the previous behaviour where the
// literal "__ASSET_VERSION__" placeholder was served and cache-busting depended on
// a manual hard refresh (Ctrl+F5).
const ASSET_VERSION = String(Date.now());

// Serve an HTML file with the __ASSET_VERSION__ placeholder replaced by the
// current ASSET_VERSION. HTML itself is sent with no-store because it embeds the
// version stamps that fingerprint the assets it loads.
function serveVersionedHtml(res, filePath) {
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html.split("__ASSET_VERSION__").join(ASSET_VERSION));
  });
}

// Cache policy for statically served files. Assets referenced with a version
// stamp (?v=<ASSET_VERSION>) can be cached forever because the URL changes on
// every restart/deploy; HTML (and any unversioned js/css, as a safety net) must
// never be cached so a fresh copy is always fetched.
function staticAssetHeaders(res, filePath) {
  if (/\.html?$/i.test(filePath)) {
    res.setHeader("Cache-Control", "no-store");
    return;
  }
  if (/\.(js|css|woff2?|ttf|eot|otf|svg|ico)$/i.test(filePath)) {
    const versioned = res.req && res.req.query && res.req.query.v;
    res.setHeader(
      "Cache-Control",
      versioned ? "public, max-age=31536000, immutable" : "no-store"
    );
  }
}

const allowedOriginsFromEnv = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(knowledgeUploadsDir)) fs.mkdirSync(knowledgeUploadsDir, { recursive: true });

// Verify the data directory is writable. SQLite (especially in WAL mode) must
// create journal/-wal/-shm files here, so if the directory is not writable the
// app can read but every write fails ("attempt to write a readonly database").
try {
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch (_) {
  console.error(
    "[DB Error] Data directory is NOT writable: " + dataDir + "\n" +
      "Reads may work but saving data will fail. Fix ownership/permissions, e.g.:\n" +
      "  chown -R <user>:users \"" + dataDir + "\"\n" +
      "  chmod -R u+rwX \"" + dataDir + "\"\n" +
      "Or set DB_DIR to a writable folder."
  );
}

const dbFile = path.join(dataDir, "app.db");
const db = createDatabase(dbFile);
// WAL mode keeps writes in a separate app.db-wal file (so the main app.db looks
// unchanged) and relies on shared-memory (-shm) that can fail or lock on some
// NAS filesystems, breaking writes. Default to DELETE so writes land directly in
// app.db and are visible immediately. Override with JOURNAL_MODE if desired.
const journalMode = (process.env.JOURNAL_MODE || "DELETE").trim().toUpperCase();
try {
  db.pragma("journal_mode = " + journalMode);
} catch (walError) {
  console.error("[DB Warning] Could not set journal mode '" + journalMode + "':", walError && walError.message ? walError.message : walError);
}

// Fail fast with a clear message if the database cannot be written to.
try {
  db.exec("CREATE TABLE IF NOT EXISTS _write_test (id INTEGER);");
  db.exec("DROP TABLE IF EXISTS _write_test;");
} catch (writeError) {
  console.error(
    "[DB Error] Database write test FAILED for " + dbFile + ": " +
      (writeError && writeError.message ? writeError.message : writeError) + "\n" +
      "This is almost always a file/folder permission problem. Ensure the user\n" +
      "running the server owns the data folder and the app.db file, then restart."
  );
}

const tokenStore = new Map();

function makeGuid() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeGuidValues() {
  const guidTables = [
    "users",
    "vehicles",
    "vehicle_logs",
    "petrol_receipts",
    "movements",
    "companies",
    "locations",
    "contractors",
    "notifications",
    "audit_logs",
    "vehicle_invoices",
  ];

  for (const tableName of guidTables) {
    db.prepare(`UPDATE ${tableName} SET guid = replace(lower(guid), '-', '') WHERE instr(guid, '-') > 0`).run();
  }
}

function normalizeExistingRemarks() {
  const statements = [
    "UPDATE vehicles SET remarks = 'N.A' WHERE remarks IS NULL OR trim(remarks) = ''",
    "UPDATE vehicle_logs SET remarks = 'N.A' WHERE remarks IS NULL OR trim(remarks) = ''",
    "UPDATE movements SET remarks = 'N.A' WHERE remarks IS NULL OR trim(remarks) = ''",
    "UPDATE contractors SET remarks = 'N.A' WHERE remarks IS NULL OR trim(remarks) = ''",
  ];

  for (const sql of statements) {
    db.prepare(sql).run();
  }
}

function normalizeExistingSecurityPlates() {
  db.prepare("UPDATE vehicles SET security_plates = '[\"N.A\"]' WHERE security_plates IS NULL OR trim(security_plates) = '' OR trim(security_plates) = '[]'").run();
}

function normalizeExistingCurrentPlates() {
  db.prepare("UPDATE vehicles SET current_plate = upper(trim(plate_no)) WHERE current_plate IS NULL OR trim(current_plate) = ''").run();
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT,
      owned_vehicle TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      alert_days_coe INTEGER NOT NULL DEFAULT 30,
      alert_days_roadtax INTEGER NOT NULL DEFAULT 30,
      alert_enabled_vehicle INTEGER NOT NULL DEFAULT 0,
      alert_enabled_contractor INTEGER NOT NULL DEFAULT 0,
      alert_enabled INTEGER NOT NULL DEFAULT 0,
      preferences TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      plate_no TEXT NOT NULL UNIQUE,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      vehicle_type TEXT,
      registration_date TEXT,
      coe_expiry TEXT NOT NULL,
      road_tax_expiry TEXT NOT NULL,
      image_path TEXT,
      security_plates TEXT,
      current_plate TEXT,
      next_inspection_due TEXT,
      next_servicing_due TEXT,
      insurance_due_date TEXT,
      insurance_cert_path TEXT,
      remarks TEXT,
      assigned_codename TEXT,
      assigned_user_id INTEGER,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(assigned_user_id) REFERENCES users(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS vehicle_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      vehicle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      datetime_out TEXT,
      datetime_in TEXT,
      mileage_out REAL,
      mileage_in REAL,
      purpose TEXT,
      remarks TEXT,
      fuel_pump_cost REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS petrol_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      vehicle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      pump_datetime TEXT NOT NULL,
      receipt_number TEXT NOT NULL,
      odometer_at_pump REAL NOT NULL,
      amount REAL,
      receipt_image_path TEXT,
      guard_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'With Guard',
      withdrawn_by INTEGER,
      withdrawn_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(guard_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      person_type TEXT NOT NULL CHECK(person_type IN ('officer', 'contractor')),
      person_name TEXT NOT NULL,
      company TEXT,
      vehicle TEXT,
      destination TEXT,
      datetime_out TEXT,
      datetime_in TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      id_number TEXT NOT NULL,
      company TEXT NOT NULL,
      company_id INTEGER,
      vehicle TEXT NOT NULL,
      clearance_start_date TEXT NOT NULL,
      clearance_end_date TEXT NOT NULL,
      remarks TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(company_id) REFERENCES companies(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT NOT NULL UNIQUE,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      actor_user_id INTEGER,
      actor_username TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      summary TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(actor_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS damage_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      reporter_user_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      vehicle_label TEXT,
      incident_datetime TEXT,
      description TEXT,
      photo_path TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Transport IC Actions',
      resolution_remarks TEXT,
      resolved_by INTEGER,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(reporter_user_id) REFERENCES users(id),
      FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY(resolved_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS vehicle_washes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      reporter_user_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      vehicle_label TEXT,
      team_id INTEGER,
      wash_date TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(reporter_user_id) REFERENCES users(id),
      FOREIGN KEY(vehicle_id) REFERENCES vehicles(id)
    );

    CREATE TABLE IF NOT EXISTS vehicle_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      vehicle_id INTEGER NOT NULL,
      invoice_type TEXT NOT NULL,
      invoice_date TEXT,
      amount REAL,
      description TEXT,
      file_path TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
  `);

  const usersSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const usersSchemaSql = String(usersSchema && usersSchema.sql ? usersSchema.sql : "");
  const expectedUsersSchema = "role TEXT NOT NULL CHECK(role IN ('admin', 'user'))";
  if (!usersSchemaSql.includes(expectedUsersSchema) || !usersSchemaSql.includes("alert_enabled")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE users RENAME TO users_legacy;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL UNIQUE,
        full_name TEXT,
        owned_vehicle TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
        alert_days_coe INTEGER NOT NULL DEFAULT 30,
        alert_days_roadtax INTEGER NOT NULL DEFAULT 30,
        alert_enabled_vehicle INTEGER NOT NULL DEFAULT 0,
        alert_enabled_contractor INTEGER NOT NULL DEFAULT 0,
        alert_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users (id, guid, username, full_name, owned_vehicle, password_hash, role, alert_days_coe, alert_days_roadtax, alert_enabled_vehicle, alert_enabled_contractor, alert_enabled, created_at)
      SELECT
        id,
        lower(hex(randomblob(16))),
        username,
        full_name,
        '',
        password_hash,
        CASE
          WHEN lower(role) = 'guard' THEN 'admin'
          WHEN lower(role) = 'transport-team' THEN 'admin'
          WHEN lower(role) = 'transport' THEN 'admin'
          WHEN lower(role) = 'admin' THEN 'admin'
          ELSE 'user'
        END,
        COALESCE(alert_days_coe, 30),
        COALESCE(alert_days_roadtax, 30),
        COALESCE(alert_enabled, 0),
        COALESCE(alert_enabled, 0),
        COALESCE(alert_enabled, 0),
        created_at
      FROM users_legacy;
      DROP TABLE users_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const vehicleColumns = db.prepare("PRAGMA table_info(vehicles)").all();
  if (!vehicleColumns.some((column) => column.name === "assigned_codename")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN assigned_codename TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "vehicle_type")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN vehicle_type TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "registration_date")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN registration_date TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "security_plates")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN security_plates TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "current_plate")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN current_plate TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "next_inspection_due")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN next_inspection_due TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "next_servicing_due")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN next_servicing_due TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "insurance_due_date")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN insurance_due_date TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "insurance_cert_path")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN insurance_cert_path TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "remarks")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN remarks TEXT");
  }
  if (!vehicleColumns.some((column) => column.name === "image_paths")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN image_paths TEXT");
    // Backfill the JSON array from the legacy single image_path so existing
    // vehicles keep their picture.
    db.prepare(
      "UPDATE vehicles SET image_paths = json_array(image_path) WHERE image_paths IS NULL AND image_path IS NOT NULL AND trim(image_path) <> ''"
    ).run();
  }

  const damageColumns = db.prepare("PRAGMA table_info(damage_reports)").all();
  if (damageColumns.length && !damageColumns.some((column) => column.name === "photo_paths")) {
    db.exec("ALTER TABLE damage_reports ADD COLUMN photo_paths TEXT");
    // Backfill the JSON array from the legacy single photo_path so existing
    // damage reports keep their photo.
    db.prepare(
      "UPDATE damage_reports SET photo_paths = json_array(photo_path) WHERE photo_paths IS NULL AND photo_path IS NOT NULL AND trim(photo_path) <> ''"
    ).run();
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((column) => column.name === "alert_enabled")) {
    db.exec("ALTER TABLE users ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!userColumns.some((column) => column.name === "alert_enabled_vehicle")) {
    db.exec("ALTER TABLE users ADD COLUMN alert_enabled_vehicle INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE users SET alert_enabled_vehicle = COALESCE(alert_enabled, 0)");
  }
  if (!userColumns.some((column) => column.name === "alert_enabled_contractor")) {
    db.exec("ALTER TABLE users ADD COLUMN alert_enabled_contractor INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE users SET alert_enabled_contractor = COALESCE(alert_enabled, 0)");
  }
  if (!userColumns.some((column) => column.name === "owned_vehicle")) {
    db.exec("ALTER TABLE users ADD COLUMN owned_vehicle TEXT");
  }
  if (!userColumns.some((column) => column.name === "preferences")) {
    db.exec("ALTER TABLE users ADD COLUMN preferences TEXT");
  }

  const notificationColumns = db.prepare("PRAGMA table_info(notifications)").all();
  if (!notificationColumns.some((column) => column.name === "is_deleted")) {
    db.exec("ALTER TABLE notifications ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
  }

  const companyColumns = db.prepare("PRAGMA table_info(companies)").all();
  if (!companyColumns.length) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  const locationColumns = db.prepare("PRAGMA table_info(locations)").all();
  if (!locationColumns.length) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  const teamColumns = db.prepare("PRAGMA table_info(teams)").all();
  if (!teamColumns.length) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  if (!userColumns.some((column) => column.name === "team_id")) {
    db.exec("ALTER TABLE users ADD COLUMN team_id INTEGER");
  }
  if (!vehicleColumns.some((column) => column.name === "team_id")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN team_id INTEGER");
  }

  const washColumns = db.prepare("PRAGMA table_info(vehicle_washes)").all();
  if (washColumns.length && !washColumns.some((column) => column.name === "team_id")) {
    db.exec("ALTER TABLE vehicle_washes ADD COLUMN team_id INTEGER");
  }

  const contractorColumns = db.prepare("PRAGMA table_info(contractors)").all();
  if (!contractorColumns.some((column) => column.name === "company_id")) {
    db.exec("ALTER TABLE contractors ADD COLUMN company_id INTEGER");
  }

  const existingCompanies = db.prepare("SELECT id, name FROM companies ORDER BY id ASC").all();
  if (!existingCompanies.length) {
    const distinctCompanyNames = db.prepare("SELECT DISTINCT TRIM(company) AS company_name FROM contractors WHERE TRIM(COALESCE(company, '')) <> '' ORDER BY company_name ASC").all();
    const insertCompany = db.prepare("INSERT OR IGNORE INTO companies (guid, name) VALUES (?, ?)");
    for (const row of distinctCompanyNames) {
      insertCompany.run(makeGuid(), String(row.company_name || "").trim());
    }
  }

  const existingLocations = db.prepare("SELECT id, name FROM locations ORDER BY id ASC").all();
  if (!existingLocations.length) {
    const distinctLocationNames = db.prepare("SELECT DISTINCT TRIM(destination) AS location_name FROM movements WHERE TRIM(COALESCE(destination, '')) <> '' ORDER BY location_name ASC").all();
    const insertLocation = db.prepare("INSERT OR IGNORE INTO locations (guid, name) VALUES (?, ?)");
    for (const row of distinctLocationNames) {
      insertLocation.run(makeGuid(), String(row.location_name || "").trim());
    }
  }

  const movementColumns = db.prepare("PRAGMA table_info(movements)").all();
  if (!movementColumns.some((column) => column.name === "vehicle")) {
    db.exec("ALTER TABLE movements ADD COLUMN vehicle TEXT");
  }

  db.prepare(
    `UPDATE contractors
     SET company_id = (
       SELECT id FROM companies c WHERE lower(c.name) = lower(TRIM(contractors.company))
     )
     WHERE company_id IS NULL OR company_id = 0`
  ).run();

  const vehiclesSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vehicles'").get();
  const vehiclesSchemaSql = String(vehiclesSchema && vehiclesSchema.sql ? vehiclesSchema.sql : "");
  const expectedVehiclesSchema = "FOREIGN KEY(assigned_user_id) REFERENCES users(id)";
  if (vehiclesSchemaSql.includes("users_legacy") || !vehiclesSchemaSql.includes(expectedVehiclesSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE vehicles RENAME TO vehicles_legacy;
      CREATE TABLE vehicles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        plate_no TEXT NOT NULL UNIQUE,
        make TEXT NOT NULL,
        model TEXT NOT NULL,
        coe_expiry TEXT NOT NULL,
        road_tax_expiry TEXT NOT NULL,
        image_path TEXT,
        current_plate TEXT,
        assigned_codename TEXT,
        assigned_user_id INTEGER,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(assigned_user_id) REFERENCES users(id),
        FOREIGN KEY(created_by) REFERENCES users(id)
      );
      INSERT INTO vehicles (id, guid, plate_no, make, model, coe_expiry, road_tax_expiry, image_path, current_plate, assigned_codename, assigned_user_id, created_by, created_at)
      SELECT id, lower(hex(randomblob(16))), plate_no, make, model, coe_expiry, road_tax_expiry, image_path, upper(trim(plate_no)), assigned_codename, assigned_user_id, created_by, created_at
      FROM vehicles_legacy;
      DROP TABLE vehicles_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const vehicleLogsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vehicle_logs'").get();
  const vehicleLogsSchemaSql = String(vehicleLogsSchema && vehicleLogsSchema.sql ? vehicleLogsSchema.sql : "");
  const expectedVehicleLogsSchema = "FOREIGN KEY(user_id) REFERENCES users(id)";
  if (vehicleLogsSchemaSql.includes("users_legacy") || !vehicleLogsSchemaSql.includes(expectedVehicleLogsSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE vehicle_logs RENAME TO vehicle_logs_legacy;
      CREATE TABLE vehicle_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        vehicle_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        datetime_out TEXT,
        datetime_in TEXT,
        mileage_out REAL,
        mileage_in REAL,
        purpose TEXT,
        remarks TEXT,
        fuel_pump_cost REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      INSERT INTO vehicle_logs (id, guid, vehicle_id, user_id, datetime_out, datetime_in, mileage_out, mileage_in, purpose, remarks, fuel_pump_cost, created_at)
      SELECT id, lower(hex(randomblob(16))), vehicle_id, user_id, datetime_out, datetime_in, mileage_out, mileage_in, purpose, remarks, fuel_pump_cost, created_at
      FROM vehicle_logs_legacy;
      DROP TABLE vehicle_logs_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const vehicleLogColumns = db.prepare("PRAGMA table_info(vehicle_logs)").all();
  if (!vehicleLogColumns.some((column) => column.name === "movement_id")) {
    db.exec("ALTER TABLE vehicle_logs ADD COLUMN movement_id INTEGER");
  }

  const petrolReceiptsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'petrol_receipts'").get();
  const petrolReceiptsSchemaSql = String(petrolReceiptsSchema && petrolReceiptsSchema.sql ? petrolReceiptsSchema.sql : "");
  const expectedPetrolReceiptsSchema = "FOREIGN KEY(user_id) REFERENCES users(id)";
  if (petrolReceiptsSchemaSql.includes("users_legacy") || !petrolReceiptsSchemaSql.includes(expectedPetrolReceiptsSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE petrol_receipts RENAME TO petrol_receipts_legacy;
      CREATE TABLE petrol_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        vehicle_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        pump_datetime TEXT NOT NULL,
        receipt_number TEXT NOT NULL,
        odometer_at_pump REAL NOT NULL,
        amount REAL,
        guard_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(guard_id) REFERENCES users(id)
      );
      INSERT INTO petrol_receipts (id, guid, vehicle_id, user_id, pump_datetime, receipt_number, odometer_at_pump, amount, guard_id, created_at)
      SELECT id, lower(hex(randomblob(16))), vehicle_id, user_id, pump_datetime, receipt_number, odometer_at_pump, amount, guard_id, created_at
      FROM petrol_receipts_legacy;
      DROP TABLE petrol_receipts_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const petrolReceiptColumns = db.prepare("PRAGMA table_info(petrol_receipts)").all();
  if (petrolReceiptColumns.length && !petrolReceiptColumns.some((column) => column.name === "receipt_image_path")) {
    db.exec("ALTER TABLE petrol_receipts ADD COLUMN receipt_image_path TEXT");
  }
  if (petrolReceiptColumns.length && !petrolReceiptColumns.some((column) => column.name === "status")) {
    db.exec("ALTER TABLE petrol_receipts ADD COLUMN status TEXT NOT NULL DEFAULT 'With Guard'");
  }
  if (petrolReceiptColumns.length && !petrolReceiptColumns.some((column) => column.name === "withdrawn_by")) {
    db.exec("ALTER TABLE petrol_receipts ADD COLUMN withdrawn_by INTEGER");
  }
  if (petrolReceiptColumns.length && !petrolReceiptColumns.some((column) => column.name === "withdrawn_at")) {
    db.exec("ALTER TABLE petrol_receipts ADD COLUMN withdrawn_at TEXT");
  }

  const movementsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'movements'").get();
  const movementsSchemaSql = String(movementsSchema && movementsSchema.sql ? movementsSchema.sql : "");
  const expectedMovementsSchema = "FOREIGN KEY(user_id) REFERENCES users(id)";
  if (movementsSchemaSql.includes("users_legacy") || !movementsSchemaSql.includes(expectedMovementsSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE movements RENAME TO movements_legacy;
      CREATE TABLE movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        person_type TEXT NOT NULL CHECK(person_type IN ('officer', 'contractor')),
        person_name TEXT NOT NULL,
        company TEXT,
        vehicle TEXT,
        destination TEXT,
        datetime_out TEXT,
        datetime_in TEXT,
        remarks TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      INSERT INTO movements (id, guid, user_id, person_type, person_name, company, vehicle, destination, datetime_out, datetime_in, remarks, created_at)
      SELECT id, lower(hex(randomblob(16))), user_id, person_type, person_name, company, NULL, destination, datetime_out, datetime_in, remarks, created_at
      FROM movements_legacy;
      DROP TABLE movements_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const auditLogsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'").get();
  const auditLogsSchemaSql = String(auditLogsSchema && auditLogsSchema.sql ? auditLogsSchema.sql : "");
  const expectedAuditLogsSchema = "FOREIGN KEY(actor_user_id) REFERENCES users(id)";
  if (auditLogsSchemaSql.includes("users_legacy") || !auditLogsSchemaSql.includes(expectedAuditLogsSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE audit_logs RENAME TO audit_logs_legacy;
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        actor_user_id INTEGER,
        actor_username TEXT,
        actor_role TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        summary TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(actor_user_id) REFERENCES users(id)
      );
      INSERT INTO audit_logs (id, guid, actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary, details_json, created_at)
      SELECT id, lower(hex(randomblob(16))), actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary, COALESCE(details_json, '{}'), created_at
      FROM audit_logs_legacy;
      DROP TABLE audit_logs_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const contractorsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contractors'").get();
  const contractorsSchemaSql = String(contractorsSchema && contractorsSchema.sql ? contractorsSchema.sql : "");
  const expectedContractorsSchema = "FOREIGN KEY(created_by) REFERENCES users(id)";
  if (contractorsSchemaSql.includes("users_legacy") || !contractorsSchemaSql.includes(expectedContractorsSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE contractors RENAME TO contractors_legacy;
      CREATE TABLE contractors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        id_number TEXT NOT NULL,
        company TEXT NOT NULL,
        company_id INTEGER,
        vehicle TEXT NOT NULL,
        clearance_start_date TEXT NOT NULL,
        clearance_end_date TEXT NOT NULL,
        remarks TEXT,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(company_id) REFERENCES companies(id),
        FOREIGN KEY(created_by) REFERENCES users(id)
      );
      INSERT INTO contractors (id, guid, full_name, id_number, company, company_id, vehicle, clearance_start_date, clearance_end_date, remarks, created_by, created_at, updated_at)
      SELECT id, lower(hex(randomblob(16))), full_name, id_number, company, company_id, vehicle, clearance_start_date, clearance_end_date, remarks, created_by, created_at, updated_at
      FROM contractors_legacy;
      DROP TABLE contractors_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const notificationsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get();
  const notificationsSchemaSql = String(notificationsSchema && notificationsSchema.sql ? notificationsSchema.sql : "");
  const expectedNotificationsSchema = "FOREIGN KEY(user_id) REFERENCES users(id)";
  if (notificationsSchemaSql.includes("users_legacy") || !notificationsSchemaSql.includes(expectedNotificationsSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      ALTER TABLE notifications RENAME TO notifications_legacy;
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        dedupe_key TEXT NOT NULL UNIQUE,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      INSERT INTO notifications (id, guid, user_id, kind, title, message, payload_json, dedupe_key, is_read, is_deleted, read_at, created_at, updated_at)
      SELECT id, lower(hex(randomblob(16))), user_id, kind, title, message, COALESCE(payload_json, '{}'), dedupe_key, is_read, is_deleted, read_at, created_at, updated_at
      FROM notifications_legacy;
      DROP TABLE notifications_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
}

function ensureDefaultAdmin() {
  db.prepare("UPDATE users SET role = 'admin' WHERE role = 'guard'").run();

  const existing = db.prepare("SELECT id, password_hash FROM users WHERE lower(username) = lower(?)").get("TOS");
  if (existing) {
    // Normalize legacy hashed default admin password to plain-text as requested.
    if (existing.password_hash !== "79461556") {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run("79461556", existing.id);
    }
    return;
  }
  db.prepare(
     `INSERT INTO users (guid, username, full_name, password_hash, role, alert_days_coe, alert_days_roadtax)
      VALUES (?, ?, ?, ?, 'admin', 30, 30)`
    ).run(makeGuid(), "TOS", "Interim Admin", "79461556");
  console.log("Created default admin account: TOS / 79461556");
}

function canUserReceiveNotifications(user) {
  return Boolean(user && user.alertsEnabled);
}

function normalizeSecurityPlates(value) {
  let items = [];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      items = Array.isArray(parsed) ? parsed : value.split(",");
    } catch (_) {
      items = value.split(",");
    }
  }

  const normalized = items
    .map((item) => String(item || "").trim().toUpperCase())
    .filter((item, index, all) => item && all.indexOf(item) === index);

  return normalized.length ? normalized : ["N.A"];
}

function normalizePlateValue(value) {
  return String(value || "").trim().toUpperCase();
}

// Parses the vehicles.image_paths JSON column into an array of image URLs,
// falling back to the legacy single image_path when the array is empty.
function parseImagePaths(imagePathsJson, legacyImagePath) {
  let items = [];
  if (Array.isArray(imagePathsJson)) {
    items = imagePathsJson;
  } else if (typeof imagePathsJson === "string" && imagePathsJson.trim()) {
    try {
      const parsed = JSON.parse(imagePathsJson);
      if (Array.isArray(parsed)) items = parsed;
    } catch (_) {
      items = [];
    }
  }
  const normalized = items
    .map((item) => String(item || "").trim())
    .filter((item, index, all) => item && all.indexOf(item) === index);
  if (!normalized.length) {
    const legacy = String(legacyImagePath || "").trim();
    if (legacy) return [legacy];
  }
  return normalized;
}

const INVOICE_TYPES = ["Repair", "Inspection Fee", "Road Tax Receipt", "Insurance", "Other"];

function normalizeInvoiceType(value) {
  const raw = String(value || "").trim();
  const match = INVOICE_TYPES.find((type) => type.toLowerCase() === raw.toLowerCase());
  return match || "Other";
}

// Inserts vehicle_invoices rows from a JSON metadata array and its aligned
// uploaded files. Each meta entry is { type, date, amount, description, hasFile };
// files are consumed in order for entries where hasFile is truthy.
function insertVehicleInvoices(vehicleId, invoicesMeta, invoiceFiles, createdBy) {
  let items = [];
  if (Array.isArray(invoicesMeta)) {
    items = invoicesMeta;
  } else if (typeof invoicesMeta === "string" && invoicesMeta.trim()) {
    try {
      const parsed = JSON.parse(invoicesMeta);
      if (Array.isArray(parsed)) items = parsed;
    } catch (_) {
      items = [];
    }
  }
  if (!items.length) return 0;

  const files = Array.isArray(invoiceFiles) ? invoiceFiles : [];
  let fileIndex = 0;
  const insert = db.prepare(
    `INSERT INTO vehicle_invoices (guid, vehicle_id, invoice_type, invoice_date, amount, description, file_path, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  for (const item of items) {
    const invoiceType = normalizeInvoiceType(item && item.type);
    const invoiceDate = String((item && item.date) || "").trim() || null;
    const amountRaw = item && item.amount != null ? Number(item.amount) : NaN;
    const amount = Number.isFinite(amountRaw) ? amountRaw : null;
    const description = String((item && item.description) || "").trim() || null;
    let filePath = null;
    if (item && item.hasFile && fileIndex < files.length) {
      filePath = `/uploads/${files[fileIndex].filename}`;
      fileIndex += 1;
    }
    insert.run(makeGuid(), vehicleId, invoiceType, invoiceDate, amount, description, filePath, createdBy || null);
    inserted += 1;
  }
  return inserted;
}

function getAllowedCurrentPlates(plateNo, securityPlates) {
  return [normalizePlateValue(plateNo), ...normalizeSecurityPlates(securityPlates)].filter(
    (plate, index, all) => plate && all.indexOf(plate) === index
  );
}

function resolveCurrentAssignedPlate({ plateNo, securityPlates, currentPlate, existingCurrentPlate }) {
  const normalizedPlateNo = normalizePlateValue(plateNo);
  const allowedPlates = getAllowedCurrentPlates(plateNo, securityPlates);

  const requestedCurrentPlate = normalizePlateValue(currentPlate);
  const fallbackCurrentPlate = normalizePlateValue(existingCurrentPlate) || normalizedPlateNo;
  const chosen = requestedCurrentPlate || fallbackCurrentPlate;

  if (allowedPlates.includes(chosen)) {
    return chosen;
  }
  return normalizedPlateNo;
}

function getExpiryAlertsForUser(user) {
  if (!canUserReceiveNotifications(user)) {
    return [];
  }

  const vehicleAlertsEnabled = Boolean(user.alertsEnabledVehicle ?? user.alertsEnabled);
  const contractorAlertsEnabled = Boolean(user.alertsEnabledContractor ?? user.alertsEnabled);
  const vehicles = db.prepare("SELECT * FROM vehicles ORDER BY id DESC").all();
  const contractors = db.prepare("SELECT * FROM contractors ORDER BY id DESC").all();
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  const alerts = [];

  if (vehicleAlertsEnabled) {
    for (const v of vehicles) {
      const vehicleExpiryItems = [
        { type: "COE", dateValue: v.coe_expiry },
        { type: "Road Tax", dateValue: v.road_tax_expiry },
        { type: "Inspection", dateValue: v.next_inspection_due },
        { type: "Servicing", dateValue: v.next_servicing_due },
        { type: "Insurance", dateValue: v.insurance_due_date },
      ];

      for (const item of vehicleExpiryItems) {
        const dueDate = new Date(item.dateValue);
        if (Number.isNaN(dueDate.getTime())) {
          continue;
        }

        const daysLeft = Math.ceil((dueDate - now) / msPerDay);
        if (daysLeft <= user.alertDaysCoe) {
          alerts.push({
            category: "vehicle-expiry",
            type: item.type,
            plateNo: v.plate_no,
            expiryDate: item.dateValue,
            daysLeft,
          });
        }
      }
    }
  }

  if (contractorAlertsEnabled) {
    for (const c of contractors) {
      const clearanceDate = new Date(c.clearance_end_date);
      if (Number.isNaN(clearanceDate.getTime())) {
        continue;
      }

      const daysLeft = Math.ceil((clearanceDate - now) / msPerDay);
      if (daysLeft <= user.alertDaysRoadTax) {
        alerts.push({
          category: "contractor-clearance",
          type: "Contractor Clearance",
          contractorId: c.id,
          contractorName: c.full_name,
          idNumber: c.id_number,
          vehicle: c.vehicle,
          expiryDate: c.clearance_end_date,
          daysLeft,
        });
      }
    }
  }

  return alerts;
}

function syncNotificationsForUser(user) {
  const alerts = getExpiryAlertsForUser(user);
  if (!alerts.length) {
    return [];
  }

  const upsertNotification = db.prepare(
    `INSERT INTO notifications (guid, user_id, kind, title, message, payload_json, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       title = excluded.title,
       message = excluded.message,
       payload_json = excluded.payload_json,
       kind = excluded.kind,
       updated_at = CURRENT_TIMESTAMP`
  );

  const tx = db.transaction((items) => {
    for (const alert of items) {
      if (alert.category === "contractor-clearance") {
        const payload = {
          type: alert.type,
          contractorId: alert.contractorId,
          contractorName: alert.contractorName,
          idNumber: alert.idNumber,
          vehicle: alert.vehicle,
          expiryDate: alert.expiryDate,
          daysLeft: alert.daysLeft,
        };
        upsertNotification.run(
          makeGuid(),
          user.id,
          "contractor-clearance-alert",
          `${alert.type} expiry for ${alert.contractorName}`,
          `${alert.contractorName} clearance expires on ${alert.expiryDate} (${alert.daysLeft < 0 ? `${Math.abs(alert.daysLeft)} day(s) overdue` : `${alert.daysLeft} day(s) left`})`,
          JSON.stringify(payload),
          `contractor-clearance-alert:${user.id}:${alert.contractorId}:${alert.expiryDate}`
        );
        continue;
      }

      const payload = {
        type: alert.type,
        plateNo: alert.plateNo,
        expiryDate: alert.expiryDate,
        daysLeft: alert.daysLeft,
      };
      upsertNotification.run(
        makeGuid(),
        user.id,
        "expiry-alert",
        `${alert.type} expiry for ${alert.plateNo}`,
        `${alert.type} for ${alert.plateNo} expires on ${alert.expiryDate} (${alert.daysLeft < 0 ? `${Math.abs(alert.daysLeft)} day(s) overdue` : `${alert.daysLeft} day(s) left`})`,
        JSON.stringify(payload),
        `expiry-alert:${user.id}:${alert.type}:${alert.plateNo}:${alert.expiryDate}`
      );
    }
  });

  tx(alerts);
  return alerts;
}

function getNotificationsForUser(user) {
  if (!canUserReceiveNotifications(user)) {
    return [];
  }
  syncNotificationsForUser(user);
  const vehicleAlertsEnabled = Boolean(user.alertsEnabledVehicle ?? user.alertsEnabled);
  const contractorAlertsEnabled = Boolean(user.alertsEnabledContractor ?? user.alertsEnabled);

  return db
    .prepare(
      `SELECT id, user_id, kind, title, message, payload_json, is_read, read_at, created_at, updated_at
       FROM notifications
       WHERE user_id = ? AND COALESCE(is_deleted, 0) = 0
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 50`
    )
    .all(user.id)
    .map((row) => {
      let payload = {};
      try {
        payload = row.payload_json ? JSON.parse(row.payload_json) : {};
      } catch (_) {
        payload = {};
      }
      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        message: row.message,
        payload,
        isRead: Boolean(row.is_read),
        readAt: row.read_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    })
    .filter((notification) => {
      if (!vehicleAlertsEnabled && notification.kind === "expiry-alert") {
        return false;
      }
      if (!contractorAlertsEnabled && notification.kind === "contractor-clearance-alert") {
        return false;
      }
      return true;
    });
}

// The standalone transcriber has its own stt_* schema below. Do not create
// the unrelated portal/vehicle tables in its dedicated database.
if (!sttStandalone) {
  initDb();
  normalizeGuidValues();
  normalizeExistingRemarks();
  normalizeExistingSecurityPlates();
  normalizeExistingCurrentPlates();
  ensureDefaultAdmin();
}

// ---------------------------------------------------------------------------
// Speech-to-text (Ops Transcriber) backend
// ---------------------------------------------------------------------------
// Mirrors the Python "Ops Transcriber" desktop app: a raw table for freshly
// ingested transcription files and a processed table for reviewed/edited
// entries shown in the Live Transcript view. New .txt files dropped into the
// input folder are ingested automatically (like the Python file monitor), and
// live browser transcripts (Web Speech API) are saved straight to processed.
const sttAppDir = process.env.STT_APP_DIR
  ? path.resolve(String(process.env.STT_APP_DIR))
  : baseDir;
const sttDefaultOutputDir = process.env.STT_INPUT_DIR
  ? path.resolve(String(process.env.STT_INPUT_DIR))
  : path.join(sttAppDir, "Transcribed Text Files");
const sttDefaultAudioFolder1 = process.env.STT_AUDIO_DIR_1
  ? path.resolve(String(process.env.STT_AUDIO_DIR_1))
  : path.join(sttAppDir, "Input Audio", "Channel 1");
const sttDefaultAudioFolder2 = process.env.STT_AUDIO_DIR_2
  ? path.resolve(String(process.env.STT_AUDIO_DIR_2))
  : path.join(sttAppDir, "Input Audio", "Channel 2");
const sttDefaultLogsAssistantDir = process.env.STT_LOGS_DIR
  ? path.resolve(String(process.env.STT_LOGS_DIR))
  : path.join(sttAppDir, "Log Assistant");
const sttLegacyLogsAssistantDir = path.join(sttAppDir, "AI Logs");

function initSttDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stt_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      source_timestamp TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stt_processed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_id INTEGER,
      filename TEXT NOT NULL,
      original_content TEXT,
      edited_content TEXT,
      source_timestamp TEXT,
      source TEXT NOT NULL DEFAULT 'file',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (raw_id) REFERENCES stt_raw(id)
    );

    CREATE TABLE IF NOT EXISTS stt_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS stt_audio_seen (
      path TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stt_report_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      processed_id INTEGER UNIQUE,
      filename TEXT,
      source_timestamp TEXT,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stt_report_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position INTEGER NOT NULL DEFAULT 0,
      source_ids TEXT NOT NULL DEFAULT '[]',
      time_label TEXT,
      time_start TEXT,
      time_end TEXT,
      movements TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stt_report_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_mtime_ms REAL NOT NULL,
      content TEXT NOT NULL,
      scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(folder, relative_path)
    );

    CREATE TABLE IF NOT EXISTS stt_knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_image INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

  `);
}
initSttDb();
db.exec("DROP TABLE IF EXISTS stt_report_samples");

// Older installations created the queue before recording timestamps were
// tracked. Keep the migration idempotent so existing queues retain their work.
const sttAudioSeenColumns = db.prepare("PRAGMA table_info(stt_audio_seen)").all();
if (!sttAudioSeenColumns.some((column) => column.name === "recorded_at")) {
  db.exec("ALTER TABLE stt_audio_seen ADD COLUMN recorded_at TEXT");
}

// --- STT settings (folder paths, model, code-name map) ---------------------
const sttSettingDefaults = {
  audioFolder1: sttDefaultAudioFolder1,
  audioFolder2: sttDefaultAudioFolder2,
  outputFolder: sttDefaultOutputDir,
  whisperModel: "large-v3-turbo",
  logsAssistantFolder: sttDefaultLogsAssistantDir,
  codeNames: "[]", // JSON array of { from, to }
  autoTranscribe: "1",
  liveDirect: "0", // when '1', new transcriptions skip Raw and go straight to Live
};

function getSttSetting(key) {
  const row = db.prepare("SELECT value FROM stt_settings WHERE key = ?").get(key);
  if (row && row.value != null) return row.value;
  return sttSettingDefaults[key] != null ? sttSettingDefaults[key] : "";
}

function setSttSetting(key, value) {
  db.prepare(
    `INSERT INTO stt_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value == null ? "" : String(value));
}

function getSttSettings() {
  const out = {};
  for (const key of Object.keys(sttSettingDefaults)) out[key] = getSttSetting(key);
  return out;
}

// The report-template uploader was retired. Remove its persisted setting from
// existing databases so a portable transcriber database contains no stale path.
db.prepare("DELETE FROM stt_settings WHERE key = 'reportTemplatePath'").run();

// Live routing is intentionally session-scoped. New transcriptions remain in
// Raw Transcript after startup until the user explicitly starts Live routing.
setSttSetting("liveDirect", "0");

// Retain the Logs Assistant folder setting when upgrading from the former
// default directory name.
if (path.resolve(String(getSttSetting("logsAssistantFolder") || "")) === path.resolve(sttLegacyLogsAssistantDir)) {
  setSttSetting("logsAssistantFolder", sttDefaultLogsAssistantDir);
}

// Current transcribed-text folder (whisper writes here, the txt scanner reads it).
function sttOutputDir() {
  const configured = String(getSttSetting("outputFolder") || "").trim();
  return configured || sttDefaultOutputDir;
}

// Keep a playback copy beside the generated transcripts. Input folders may be
// purged daily, so source audio must not be the only playback location.
function sttProcessedAudioDir() {
  return path.join(sttOutputDir(), "Processed Audio");
}

function sttArchivedAudioPath(sourcePath) {
  const parent = path.basename(path.dirname(sourcePath)).replace(/[<>:"/\\|?*]+/g, "_");
  return path.join(sttProcessedAudioDir(), `${parent}__${path.basename(sourcePath)}`);
}

function sttArchiveAudioFile(sourcePath) {
  const archivePath = sttArchivedAudioPath(sourcePath);
  fs.mkdirSync(sttProcessedAudioDir(), { recursive: true });
  fs.copyFileSync(sourcePath, archivePath);
  return archivePath;
}

// Parse the code-name map (mishearing -> correct name) into a usable list.
function sttCodeNamePairs() {
  try {
    const arr = JSON.parse(getSttSetting("codeNames") || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => ({ from: String(p.from || "").trim(), to: String(p.to || "").trim() }))
      .filter((p) => p.from && p.to);
  } catch (_) {
    return [];
  }
}

// Apply whole-word, case-insensitive code-name substitutions to transcript text.
function sttApplyCodeNames(text) {
  let out = String(text || "");
  for (const { from, to } of sttCodeNamePairs()) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), to);
  }
  return out;
}

// Convert whisper-style timestamp brackets like "[0.00s -> 6.80s]" into the
// source filename (matches the Python app's convert_timestamps_to_filename).
function sttConvertTimestamps(content, filename) {
  const stem = String(filename || "").replace(/\.[^.]+$/, "");
  return String(content || "").replace(/\[\d+\.?\d*s\s*->\s*\d+\.?\d*s\]/g, `[${stem}]`);
}

// Best-effort extraction of a human-readable timestamp from a filename such as
// "19022026_14:35:42.txt" (ddmmyyyy_hh:mm:ss). Falls back to the raw stem.
function sttParseSourceTimestamp(filename) {
  const stem = String(filename || "").replace(/\.[^.]+$/, "");
  const match = stem.match(/^(\d{2})(\d{2})(\d{4})[_ ]?(\d{2})[:.]?(\d{2})[:.]?(\d{2})$/);
  if (match) {
    const [, dd, mm, yyyy, hh, min, ss] = match;
    return `${yyyy}-${mm}-${dd} ${hh.padStart(2, "0")}:${min}:${ss}`;
  }
  return stem;
}

// Scan the output folder for new .txt files and ingest them into stt_raw. Returns
// the number of newly ingested files. Safe to call repeatedly (idempotent on
// filename via UNIQUE + INSERT OR IGNORE).
let sttInputScanRetryAt = 0;

function scanSttInputFolder() {
  if (Date.now() < sttInputScanRetryAt) return 0;

  let ingested = 0;
  const dir = sttOutputDir();
  try {
    if (!fs.existsSync(dir)) {
      // On a network (UNC) share, existsSync can transiently report false and
      // recursive mkdir then throws UNKNOWN even though the folder exists, so
      // skip this cycle instead of trying to create it.
      const isUnc = /^\\\\|^\/\//.test(dir);
      if (isUnc) return 0;
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
      return 0;
    }
    const entries = fs.readdirSync(dir).filter((name) => /\.txt$/i.test(name));
    const insert = db.prepare(
      `INSERT OR IGNORE INTO stt_raw (filename, content, source_timestamp) VALUES (?, ?, ?)`
    );
    // When live mode is on, promote each new transcription straight to Live.
    const liveDirect = String(getSttSetting("liveDirect")) === "1";
    const promote = db.prepare(
      `INSERT INTO stt_processed (raw_id, filename, original_content, edited_content, source_timestamp, source)
       VALUES (?, ?, ?, ?, ?, 'file')`
    );
    for (const name of entries) {
      const exists = db.prepare("SELECT 1 FROM stt_raw WHERE filename = ?").get(name);
      if (exists) continue;
      let raw = "";
      try {
        raw = fs.readFileSync(path.join(dir, name), "utf8");
      } catch (_) {
        continue;
      }
      if (!raw.trim()) continue;
      const content = sttConvertTimestamps(raw, name);
      const stamp = sttParseSourceTimestamp(name);
      const result = insert.run(name, content, stamp);
      if (result.changes > 0) {
        ingested += 1;
        if (liveDirect) {
          promote.run(result.lastInsertRowid, name, content, content, stamp);
          db.prepare("UPDATE stt_raw SET processed = 1 WHERE id = ?").run(result.lastInsertRowid);
        }
      }
    }
  } catch (error) {
    // A disconnected or unhealthy network folder can block synchronous file
    // operations. Retry later instead of stalling every five-second poll.
    sttInputScanRetryAt = Date.now() + 60 * 1000;
    console.error("[STT] Folder scan failed:", error && error.message ? error.message : error);
  }
  return ingested;
}

// --- Audio folder monitoring + server-side Whisper transcription -----------
const sttAudioExtensions = /\.(wav|mp3|m4a|flac|ogg|webm|aac|wma)$/i;
let sttTranscribing = false;
let sttDiscovering = false;
const sttFileStability = new Map();
const STT_FILE_STABLE_MS = 1000;
let sttHistoricalFolderCursor = 0;

function sttRecordedAtFromFilename(filename) {
  const stem = String(filename || "").replace(/\.[^.]+$/, "");
  const isoMatch = stem.match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})(?:\D|$)/);
  if (isoMatch) {
    const [, year, month, day, hour, minute, second] = isoMatch;
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }
  const match = stem.match(/(?:^|\D)(\d{2})(\d{2})(\d{4})[_ -]?(\d{2})[:.]?(\d{2})[:.]?(\d{2})(?:\D|$)/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function sttTodayDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Return one dated child folder per poll. This gradually catches up on older
// recordings without recursively walking a large archive every five seconds.
async function sttNextHistoricalFolders(folders) {
  const candidates = [];
  for (const folder of folders) {
    try {
      const entries = await fs.promises.readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) candidates.push(path.join(folder, entry.name));
      }
    } catch (_) {
      // The normal root scan will surface a folder availability problem later.
    }
  }
  if (!candidates.length) return [];
  candidates.sort((left, right) => right.localeCompare(left));
  const folder = candidates[sttHistoricalFolderCursor % candidates.length];
  sttHistoricalFolderCursor = (sttHistoricalFolderCursor + 1) % candidates.length;
  return folder ? [folder] : [];
}

// G.711 A-law / mu-law decode tables (byte -> signed 16-bit PCM). Radio
// recorders often save A-law WAVs, which browsers cannot decode natively (they
// play a fraction of a second then stop), so we transcode to PCM on the fly.
const sttAlawTable = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const a = i ^ 0x55;
    let val = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    if (seg === 0) val += 8;
    else if (seg === 1) val += 0x108;
    else { val += 0x108; val <<= seg - 1; }
    t[i] = (a & 0x80) ? val : -val;
  }
  return t;
})();
const sttUlawTable = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    let val = ((u & 0x0f) << 3) + 0x84;
    val <<= (u & 0x70) >> 4;
    t[i] = (u & 0x80) ? 0x84 - val : val - 0x84;
  }
  return t;
})();

function sttBuildPcmWav(pcm, channels, sampleRate) {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// If the WAV uses A-law (0x06) or mu-law (0x07), return a PCM16 WAV Buffer the
// browser can play; otherwise return null so the file is streamed unchanged.
function sttTranscodeCompandedWav(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let pos = 12;
  let fmtTag = 0;
  let channels = 1;
  let sampleRate = 8000;
  let dataOffset = -1;
  let dataSize = 0;
  while (pos + 8 <= buf.length) {
    const cid = buf.toString("ascii", pos, pos + 4);
    const sz = buf.readUInt32LE(pos + 4);
    if (cid === "fmt ") {
      fmtTag = buf.readUInt16LE(pos + 8);
      channels = buf.readUInt16LE(pos + 10) || 1;
      sampleRate = buf.readUInt32LE(pos + 12) || 8000;
    } else if (cid === "data") {
      dataOffset = pos + 8;
      dataSize = sz;
    }
    pos += 8 + sz + (sz & 1);
  }
  if (dataOffset < 0 || (fmtTag !== 6 && fmtTag !== 7)) return null;
  if (dataOffset + dataSize > buf.length) dataSize = buf.length - dataOffset;
  const table = fmtTag === 6 ? sttAlawTable : sttUlawTable;
  const pcm = Buffer.alloc(dataSize * 2);
  for (let i = 0; i < dataSize; i++) pcm.writeInt16LE(table[buf[dataOffset + i]], i * 2);
  return sttBuildPcmWav(pcm, channels, sampleRate);
}

// Discover new audio files in the two configured input folders and queue them.
// Background polling scans only the configured folder itself; a user-requested
// rescan can also traverse dated subfolders.
async function sttDiscoverAudioFiles({ recursive = false, scanFolders, includeHistorical = false } = {}) {
  // A scan of a large archive over the network can take many seconds; never let
  // a new poll start another scan while one is still running.
  if (sttDiscovering) return;
  sttDiscovering = true;
  try {
    const folders = (Array.isArray(scanFolders) ? scanFolders : [getSttSetting("audioFolder1"), getSttSetting("audioFolder2")])
      .map((f) => String(f || "").trim())
      .filter(Boolean);
    const insert = db.prepare(
      `INSERT INTO stt_audio_seen (path, filename, status, recorded_at) VALUES (?, ?, 'pending', ?)
       ON CONFLICT(path) DO UPDATE SET recorded_at = COALESCE(excluded.recorded_at, stt_audio_seen.recorded_at)`
    );
    // A file previously flagged 'missing' (absent when the queue reached it, e.g.
    // recorder/mirror churn) is back on disk if we can read it here, so requeue it.
    const requeue = db.prepare(
      `UPDATE stt_audio_seen SET status = 'pending', message = NULL WHERE path = ? AND status = 'missing'`
    );
    let scanned = 0;
    let queued = 0;
    let requeued = 0;
    const queueFiles = db.transaction((files) => {
      for (const full of files) {
        const name = path.basename(full);
        scanned += 1;
        const added = insert.run(full, name, sttRecordedAtFromFilename(name));
        if (added.changes > 0) queued += 1;
        const restored = requeue.run(full);
        if (restored.changes > 0) requeued += 1;
      }
    });
    const foldersToScan = includeHistorical
      ? folders.concat(await sttNextHistoricalFolders(folders))
      : folders;
    for (const folder of foldersToScan) {
      try {
        const files = [];
        const foldersToScan = [folder];
        while (foldersToScan.length) {
          const current = foldersToScan.pop();
          let entries;
          try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
          } catch (_) {
            continue; // unreadable/missing folder
          }
          for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isFile() && sttAudioExtensions.test(entry.name)) {
              files.push(full);
            } else if (recursive && entry.isDirectory()) {
              foldersToScan.push(full);
            }
          }
        }
        queueFiles(files);
      } catch (error) {
        console.error("[STT] Audio discovery failed:", error && error.message ? error.message : error);
      }
    }
    return { scanned, queued, requeued };
  } finally {
    sttDiscovering = false;
  }
}

// Locate a source audio file for playback WITHOUT scanning the folder (a scan of
// a huge archive over the network would block the server). Tries the exact path
// recorded in stt_audio_seen first (works even when the input folders were
// cleared for a bulk run), then builds candidate paths directly inside the
// configured folders. Returns the full path or null.
function sttFindAudioFile(stem) {
  const exts = ["wav", "mp3", "m4a", "flac", "ogg", "webm", "aac", "wma"];
  const candidates = exts.map((e) => `${stem}.${e}`);
  try {
    const placeholders = candidates.map(() => "?").join(",");
    const rows = db.prepare(`SELECT path FROM stt_audio_seen WHERE filename IN (${placeholders})`).all(...candidates);
    for (const r of rows) {
      if (r && r.path && fs.existsSync(r.path)) return r.path;
    }
    for (const r of rows) {
      const archived = r && r.path ? sttArchivedAudioPath(r.path) : "";
      if (archived && fs.existsSync(archived)) return archived;
    }
  } catch (_) {
    /* fall through to direct path build */
  }
  const folders = [getSttSetting("audioFolder1"), getSttSetting("audioFolder2")]
    .map((f) => String(f || "").trim())
    .filter(Boolean);
  for (const folder of folders) {
    for (const e of exts) {
      const full = path.join(folder, `${stem}.${e}`);
      try {
        if (fs.existsSync(full)) return full;
      } catch (_) {
        /* ignore unreadable candidates */
      }
    }
  }
  try {
    const archived = fs.readdirSync(sttProcessedAudioDir());
    for (const name of archived) {
      if (name.endsWith(`__${stem}.wav`) || name.endsWith(`__${stem}.mp3`) || name.endsWith(`__${stem}.m4a`) ||
          name.endsWith(`__${stem}.flac`) || name.endsWith(`__${stem}.ogg`) || name.endsWith(`__${stem}.webm`) ||
          name.endsWith(`__${stem}.aac`) || name.endsWith(`__${stem}.wma`)) {
        return path.join(sttProcessedAudioDir(), name);
      }
    }
  } catch (_) {
    /* archive has not been created yet */
  }
  return null;
}

// Write a tiny progress file into the output folder so another machine (e.g. the
// NAS portal, which does not transcribe) can display this machine's live queue.
function sttWriteStatusFile() {
  try {
    const counts = db
      .prepare("SELECT status, COUNT(*) AS n FROM stt_audio_seen GROUP BY status")
      .all()
      .reduce((acc, r) => { acc[r.status] = r.n; return acc; }, {});
    const nowRow = db
      .prepare("SELECT filename FROM stt_audio_seen WHERE status = 'processing' ORDER BY created_at ASC LIMIT 1")
      .get();
    const dir = sttOutputDir();
    if (!fs.existsSync(dir)) return;
    const payload = {
      source: os.hostname(),
      updatedAt: new Date().toISOString(),
      transcribing: sttTranscribing,
      now: nowRow ? nowRow.filename : null,
      counts,
    };
    fs.writeFileSync(path.join(dir, "_transcription_status.json"), JSON.stringify(payload), "utf8");
  } catch (_) {
    /* best effort only */
  }
}

// Transcribe one pending audio file. Returns "done" if a file was handled,
// "empty" if the queue is empty, or "retry" if the AI service was unreachable
// (the file is put back to pending so it is retried on the next poll).
async function sttTranscribeOne() {
  const today = sttTodayDate();
  const next = db
    .prepare(
      `SELECT * FROM stt_audio_seen
       WHERE status = 'pending'
       ORDER BY CASE WHEN substr(recorded_at, 1, 10) = ? THEN 0 ELSE 1 END,
                CASE WHEN substr(recorded_at, 1, 10) = ? THEN recorded_at END ASC,
                CASE WHEN substr(recorded_at, 1, 10) <> ? THEN recorded_at END DESC,
                created_at ASC
       LIMIT 1`
    )
    .get(today, today, today);
  if (!next) return "empty";
  let fileStat;
  try {
    fileStat = await fs.promises.stat(next.path);
  } catch (_) {
    db.prepare("UPDATE stt_audio_seen SET status = 'missing' WHERE path = ?").run(next.path);
    return "done";
  }
  const fileSignature = `${fileStat.size}:${fileStat.mtimeMs}`;
  const previous = sttFileStability.get(next.path);
  if (!previous || previous.signature !== fileSignature) {
    sttFileStability.set(next.path, { signature: fileSignature, observedAt: Date.now() });
    return "empty";
  }
  if (Date.now() - previous.observedAt < STT_FILE_STABLE_MS) return "empty";
  sttFileStability.delete(next.path);
  db.prepare("UPDATE stt_audio_seen SET status = 'processing' WHERE path = ?").run(next.path);
  try {
    if (!fs.existsSync(next.path)) {
      db.prepare("UPDATE stt_audio_seen SET status = 'missing' WHERE path = ?").run(next.path);
      return "done";
    }
    const r = await sttAiRequest("/transcribe", { path: next.path }, "POST", 600000);
    if (!r.ok) {
      const msg = (r.data && r.data.error) || "Transcription failed.";
      db.prepare("UPDATE stt_audio_seen SET status = 'error', message = ? WHERE path = ?").run(msg, next.path);
      return "done";
    }
    const text = sttApplyCodeNames((r.data && r.data.text) || "");
    const stem = next.filename.replace(/\.[^.]+$/, "");
    const outDir = sttOutputDir();
    if (!fs.existsSync(outDir)) {
      // Don't mkdir a UNC share (throws UNKNOWN when existsSync flakes); the
      // folder already exists there, so just proceed to write.
      const isUnc = /^\\\\|^\/\//.test(outDir);
      if (!isUnc) { try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) { /* ignore */ } }
    }
    fs.writeFileSync(path.join(outDir, `${stem}.txt`), text, "utf8");
    sttArchiveAudioFile(next.path);
    db.prepare("UPDATE stt_audio_seen SET status = 'done', message = NULL WHERE path = ?").run(next.path);
    scanSttInputFolder();
    return "done";
  } catch (error) {
    // Network/connection failure (AI service restarting or down): do NOT mark
    // the file as a permanent error. Revert to pending and back off.
    db.prepare("UPDATE stt_audio_seen SET status = 'pending' WHERE path = ?").run(next.path);
    return "retry";
  }
}

// Drain the pending queue continuously (Whisper is serialized). Processes the
// next file immediately after finishing one instead of waiting for the poll.
// Stops early if the AI service is unreachable so it can retry on the next poll.
async function sttProcessNextAudio() {
  if (sttTranscribing) return;
  sttTranscribing = true;
  try {
    // eslint-disable-next-line no-await-in-loop
    let result = await sttTranscribeOne();
    // eslint-disable-next-line no-await-in-loop
    while (result === "done") result = await sttTranscribeOne();
  } finally {
    sttTranscribing = false;
  }
}

// Ingest at startup, then poll like the Python monitor (default 5s). The audio
// folders are auto-transcribed in the background when enabled in Settings.
scanSttInputFolder();
// Recover files left mid-transcription or failed by a transient AI-service
// outage (e.g. the service restarting) so they are retried instead of stranded.
db.prepare("UPDATE stt_audio_seen SET status = 'pending' WHERE status = 'processing'").run();
db.prepare("UPDATE stt_audio_seen SET status = 'pending', message = NULL WHERE status = 'error' AND message = 'fetch failed'").run();
const sttScanIntervalMs = Math.max(1000, sanitizeInt(process.env.STT_SCAN_INTERVAL_MS, 5000));
setInterval(() => {
  scanSttInputFolder();
  if (String(getSttSetting("autoTranscribe") || "") === "1") {
    sttDiscoverAudioFiles()
      .then(() => sttProcessNextAudio())
      .then(() => sttDiscoverAudioFiles({ includeHistorical: true }))
      .then(() => sttProcessNextAudio())
      .catch(() => {});
    sttWriteStatusFile();
  }
}, sttScanIntervalMs).unref();

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const isLocalhostOrigin = origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");
  const isAllowedEnvOrigin = allowedOriginsFromEnv.includes(origin);
  // Allow same-domain, different-port requests (e.g. portal on http://host:80
  // calling this API on http://host:3010). The port differs so it is a
  // cross-origin fetch that needs CORS, but it is still the same site, so we
  // reflect it without requiring ALLOWED_ORIGINS to be configured.
  let isSameHostOrigin = false;
  let isNasPortalOrigin = false;
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      isSameHostOrigin = originHost === req.hostname;
      isNasPortalOrigin = originHost === "3happs.com" && req.hostname === "192.168.5.103";
    } catch (_) {
      isSameHostOrigin = false;
    }
  }
  if (!origin || origin === "null" || isLocalhostOrigin || isAllowedEnvOrigin || isSameHostOrigin || isNasPortalOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token");
    res.setHeader("Access-Control-Expose-Headers", "X-File-Size, X-Photo-Name, X-Photo-Mtime");
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || "interim-vehicle-app-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      // No maxAge/expires: this is a browser-session cookie so the login ends
      // automatically when the user closes the browser (auto log out on close).
    },
  })
);

// Versioned HTML entry points. Registered before the static handlers below so
// their __ASSET_VERSION__ placeholders are replaced and the HTML is never cached
// (the assets it references carry the version stamp instead, and stay cached).
const publicDir = path.join(appDir, "public");
const administratorDir = path.join(baseDir, "administrator");
app.get(["/administrator", "/administrator/", "/administrator/index.html"], (_req, res) =>
  serveVersionedHtml(res, path.join(administratorDir, "index.html"))
);
app.get(
  ["/vehicle-index.html", "/vehicle-logs_officers-contractors-movement/public/vehicle-index.html"],
  (_req, res) => serveVersionedHtml(res, path.join(publicDir, "vehicle-index.html"))
);
app.get(
  ["/movement-index.html", "/vehicle-logs_officers-contractors-movement/public/movement-index.html"],
  (_req, res) => serveVersionedHtml(res, path.join(publicDir, "movement-index.html"))
);

const staticOptions = { setHeaders: staticAssetHeaders };
app.use("/uploads", express.static(uploadsDir, staticOptions));
app.use("/administrator", express.static(administratorDir, staticOptions));
app.use("/assets", express.static(path.join(baseDir, "assets"), staticOptions));
app.use("/apps", express.static(path.join(baseDir, "apps"), staticOptions));
// Serve ONLY the STT web page from the Ops Transcriber folder (not the whole
// folder, so models/config/transcripts stay private). Express 4 matches the raw
// (encoded) path, so the regex accepts both "%20" and a literal space.
app.get(["/", "/speech-to-text.html", /^\/Ops(?:%20| )Transcriber\/speech-to-text\.html$/], (_req, res) =>
  res.sendFile(path.join(baseDir, "speech-to-text.html"))
);
app.use("/data-matching", express.static(path.join(baseDir, "data-matching"), staticOptions));
function resolveMapDir() {
  if (process.env.MAP_DIR) return String(process.env.MAP_DIR);
  const candidates = [path.join(baseDir, "map"), path.join(baseDir, "Map")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
const mapDir = resolveMapDir();
app.use("/Map", express.static(mapDir, staticOptions));
app.use("/map", express.static(mapDir, staticOptions));
app.use("/vehicle-logs_officers-contractors-movement/public", express.static(publicDir, staticOptions));
app.use(express.static(publicDir, staticOptions));

app.get("/index.html", (_, res) => {
  res.sendFile(path.join(portalRootDir, "index.html"));
});

app.get("/styles.css", (_, res) => {
  res.sendFile(path.join(portalRootDir, "styles.css"));
});

app.get("/portal.css", (_, res) => {
  res.sendFile(path.join(portalRootDir, "styles.css"));
});

app.get("/script.js", (_, res) => {
  res.sendFile(path.join(portalRootDir, "script.js"));
});

app.get("/user-profile.html", (_, res) => {
  res.sendFile(path.join(portalRootDir, "user-profile.html"));
});

app.get("/user-profile.js", (_, res) => {
  res.sendFile(path.join(portalRootDir, "user-profile.js"));
});

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeName = `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
    cb(null, safeName);
  },
});
const upload = multer({ storage });
const vehicleUpload = upload.fields([
  { name: "picture", maxCount: 1 },
  { name: "pictures", maxCount: 12 },
  { name: "insuranceCertificate", maxCount: 1 },
  { name: "invoiceFiles", maxCount: 12 },
]);
const vehiclePicturesUpload = upload.array("pictures", 12);
const invoiceUpload = upload.array("invoiceFiles", 12);
const damageUpload = upload.fields([
  { name: "damagePhotos", maxCount: 12 },
  { name: "damagePhoto", maxCount: 1 },
]);
const receiptUpload = upload.single("receiptImage");
const knowledgeDocumentExtensions = new Set([
  ".doc", ".docx", ".pdf", ".txt", ".md", ".csv", ".json",
  ".png", ".jpg", ".jpeg", ".webp",
]);
const knowledgeStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, knowledgeUploadsDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  },
});
const knowledgeUpload = multer({
  storage: knowledgeStorage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (_, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    cb(null, knowledgeDocumentExtensions.has(extension));
  },
}).array("documents", 10);

function sanitizeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Resolves a submitted team id to a valid teams.id, or null when unassigned/invalid.
function resolveTeamId(value) {
  if (value === undefined || value === null || value === "") return null;
  const teamId = Number.parseInt(value, 10);
  if (!Number.isFinite(teamId) || teamId <= 0) return null;
  const exists = db.prepare("SELECT id FROM teams WHERE id = ?").get(teamId);
  return exists ? teamId : null;
}

function normalizeOwnedVehicles(value) {
  const segments = String(value || "")
    .split(/[\n,;]+/)
    .map((segment) => segment.trim().toUpperCase())
    .filter(Boolean);
  const deduped = [];
  for (const segment of segments) {
    if (!deduped.includes(segment)) {
      deduped.push(segment);
    }
  }
  return deduped.length ? deduped.join(", ") : "N.A";
}

function normalizeRemarks(value) {
  const text = String(value ?? "").trim();
  return text || "N.A";
}

function stringifyAuditDetails(details) {
  try {
    return JSON.stringify(details || {});
  } catch (_) {
    return "{}";
  }
}

function writeAuditLog(req, { action, entityType, entityId = "", summary = "", details = {} }) {
  const actor = req && req.session ? req.session.user : null;
  db.prepare(
    `INSERT INTO audit_logs
      (guid, actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    makeGuid(),
    actor && actor.id ? actor.id : null,
    actor && actor.username ? actor.username : "system",
    actor && actor.role ? actor.role : "system",
    String(action || "").trim().toLowerCase(),
    String(entityType || "").trim().toLowerCase(),
    String(entityId || ""),
    String(summary || "").trim(),
    stringifyAuditDetails(details)
  );
}

function authRequired(req, res, next) {
  if (sttStandalone && req.path.startsWith("/api/stt/")) {
    return next();
  }

  const authHeader = String(req.headers.authorization || "");
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const headerToken = String(req.headers["x-auth-token"] || "").trim();
  const token = bearerToken || headerToken;
  const tokenUser = token ? tokenStore.get(token) : null;

  if (req.session.user) {
    req.authToken = token || "";
    return next();
  }

  if (tokenUser) {
    req.session.user = tokenUser;
    req.authToken = token;
    return next();
  }

  if (!req.session.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  return next();
}

function adminRequired(req, res, next) {
  if (!req.session.user) {
    const authHeader = String(req.headers.authorization || "");
    const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const headerToken = String(req.headers["x-auth-token"] || "").trim();
    const token = bearerToken || headerToken;
    const tokenUser = token ? tokenStore.get(token) : null;
    if (tokenUser) {
      req.session.user = tokenUser;
      req.authToken = token;
    }
  }

  if (!req.session.user) return res.status(401).json({ error: "Authentication required." });
  if (req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  return next();
}

function buildUserPayload(user) {
  const alertsEnabledVehicle = Boolean(user.alert_enabled_vehicle ?? user.alert_enabled);
  const alertsEnabledContractor = Boolean(user.alert_enabled_contractor ?? user.alert_enabled);
  return {
    id: user.id,
    guid: user.guid || "",
    username: user.username,
    role: user.role,
    fullName: user.full_name || "",
    ownedVehicle: user.owned_vehicle || "",
    alertDaysCoe: user.alert_days_coe,
    alertDaysRoadTax: user.alert_days_roadtax,
    alertsEnabledVehicle,
    alertsEnabledContractor,
    alertsEnabled: alertsEnabledVehicle || alertsEnabledContractor,
    mustChangePassword: String(user.password_hash || "") === "password",
  };
}

function refreshSessionUserFromDb(req) {
  if (!req.session.user || !req.session.user.id) {
    return null;
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
  if (!user) {
    return null;
  }

  const userPayload = buildUserPayload(user);
  req.session.user = userPayload;
  if (req.authToken) {
    tokenStore.set(req.authToken, userPayload);
  }
  return userPayload;
}

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(username);
  if (!user) return res.status(401).json({ error: "Invalid credentials." });

  const ok = password === String(user.password_hash || "");
  if (!ok) return res.status(401).json({ error: "Invalid credentials." });

  const userPayload = buildUserPayload(user);
  req.session.user = userPayload;
  const token = crypto.randomBytes(24).toString("hex");
  tokenStore.set(token, userPayload);

  return res.json({ user: req.session.user, token });
});

app.post("/api/auth/logout", authRequired, (req, res) => {
  if (req.authToken) {
    tokenStore.delete(req.authToken);
  }
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  const authHeader = String(req.headers.authorization || "");
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const headerToken = String(req.headers["x-auth-token"] || "").trim();
  const providedToken = bearerToken || headerToken;

  if (req.session.user) {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
    if (!user) {
      req.session.destroy(() => null);
      return res.json({ user: null });
    }
    const userPayload = buildUserPayload(user);
    req.session.user = userPayload;
    const token = providedToken || crypto.randomBytes(24).toString("hex");
    tokenStore.set(token, userPayload);
    return res.json({ user: userPayload, token });
  }

  const token = providedToken;
  const tokenUser = token ? tokenStore.get(token) : null;

  if (!tokenUser) return res.json({ user: null });
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(tokenUser.id);
  if (!user) {
    tokenStore.delete(token);
    return res.json({ user: null });
  }
  const userPayload = buildUserPayload(user);
  tokenStore.set(token, userPayload);
  return res.json({ user: userPayload });
});

// Per-user UI preferences (e.g. vehicle table column order/visibility) so they
// follow the account across logout/login and across devices.
app.get("/api/me/preferences", authRequired, (req, res) => {
  const row = db.prepare("SELECT preferences FROM users WHERE id = ?").get(req.session.user.id);
  let preferences = {};
  try {
    preferences = row && row.preferences ? JSON.parse(row.preferences) : {};
  } catch (_) {
    preferences = {};
  }
  return res.json({ preferences });
});

app.put("/api/me/preferences", authRequired, (req, res) => {
  const body = req.body || {};
  const incoming =
    body.preferences && typeof body.preferences === "object" ? body.preferences : body;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "Invalid preferences payload." });
  }
  const row = db.prepare("SELECT preferences FROM users WHERE id = ?").get(req.session.user.id);
  let current = {};
  try {
    current = row && row.preferences ? JSON.parse(row.preferences) : {};
  } catch (_) {
    current = {};
  }
  const merged = { ...current, ...incoming };
  db.prepare("UPDATE users SET preferences = ? WHERE id = ?").run(
    JSON.stringify(merged),
    req.session.user.id
  );
  return res.json({ ok: true, preferences: merged });
});

app.post("/api/migrate/local-db", authRequired, (req, res) => {
  const payload = req.body && req.body.db ? req.body.db : req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Invalid migration payload." });
  }

  const sourceUsers = Array.isArray(payload.users) ? payload.users : [];
  const sourceVehicles = Array.isArray(payload.vehicles) ? payload.vehicles : [];
  const sourceLogs = Array.isArray(payload.vehicle_logs) ? payload.vehicle_logs : [];
  const sourceReceipts = Array.isArray(payload.petrol_receipts) ? payload.petrol_receipts : [];
  const sourceMovements = Array.isArray(payload.movements) ? payload.movements : [];

  const userIdMap = new Map();
  const vehicleIdMap = new Map();
  let usersImported = 0;
  let vehiclesImported = 0;
  let logsImported = 0;
  let receiptsImported = 0;
  let movementsImported = 0;

  const tx = db.transaction(() => {
    for (const sourceUser of sourceUsers) {
      const username = String(sourceUser.username || "").trim();
      if (!username) continue;

      const existing = db.prepare("SELECT id FROM users WHERE lower(username) = lower(?)").get(username);
      let userId;
      if (existing) {
        userId = existing.id;
      } else {
        const role = String(sourceUser.role || "user").toLowerCase();
        const safeRole = ["admin", "user"].includes(role) ? role : "user";
        const result = db.prepare(
          `INSERT INTO users (guid, username, full_name, password_hash, role, alert_days_coe, alert_days_roadtax, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          makeGuid(),
          username,
          String(sourceUser.full_name || ""),
          String(sourceUser.password_hash || "password"),
          safeRole,
          Math.max(0, sanitizeInt(sourceUser.alert_days_coe, 30)),
          Math.max(0, sanitizeInt(sourceUser.alert_days_roadtax, 30)),
          String(sourceUser.created_at || new Date().toISOString())
        );
        userId = Number(result.lastInsertRowid);
        usersImported += 1;
      }
      if (sourceUser.id != null) {
        userIdMap.set(Number(sourceUser.id), userId);
      }
    }

    for (const sourceVehicle of sourceVehicles) {
      const plateNo = String(sourceVehicle.plate_no || "").trim().toUpperCase();
      const make = String(sourceVehicle.make || "").trim();
      const model = String(sourceVehicle.model || "").trim();
      const coeExpiry = String(sourceVehicle.coe_expiry || "").trim();
      const roadTaxExpiry = String(sourceVehicle.road_tax_expiry || "").trim();
      if (!plateNo || !make || !model || !coeExpiry || !roadTaxExpiry) continue;

      const existing = db.prepare("SELECT id FROM vehicles WHERE lower(plate_no) = lower(?)").get(plateNo);
      let vehicleId;
      if (existing) {
        vehicleId = existing.id;
      } else {
        const mappedAssigned = sourceVehicle.assigned_user_id != null
          ? (userIdMap.get(Number(sourceVehicle.assigned_user_id)) || null)
          : null;
        const mappedCreatedBy = sourceVehicle.created_by != null
          ? (userIdMap.get(Number(sourceVehicle.created_by)) || req.session.user.id)
          : req.session.user.id;
        const securityPlates = normalizeSecurityPlates(sourceVehicle.security_plates);
        const currentPlate = resolveCurrentAssignedPlate({
          plateNo,
          securityPlates,
          currentPlate: sourceVehicle.current_plate,
          existingCurrentPlate: plateNo,
        });

        const result = db.prepare(
          `INSERT INTO vehicles
            (guid, plate_no, make, model, coe_expiry, road_tax_expiry, image_path, security_plates, current_plate, next_inspection_due, next_servicing_due, insurance_due_date, insurance_cert_path, remarks, assigned_codename, assigned_user_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          makeGuid(),
          plateNo,
          make,
          model,
          coeExpiry,
          roadTaxExpiry,
          String(sourceVehicle.image_path || ""),
          JSON.stringify(securityPlates),
          currentPlate,
          String(sourceVehicle.next_inspection_due || ""),
          String(sourceVehicle.next_servicing_due || ""),
          String(sourceVehicle.insurance_due_date || ""),
          String(sourceVehicle.insurance_cert_path || ""),
          normalizeRemarks(sourceVehicle.remarks),
          String(sourceVehicle.assigned_codename || ""),
          mappedAssigned,
          mappedCreatedBy,
          String(sourceVehicle.created_at || new Date().toISOString())
        );
        vehicleId = Number(result.lastInsertRowid);
        vehiclesImported += 1;
      }

      if (sourceVehicle.id != null) {
        vehicleIdMap.set(Number(sourceVehicle.id), vehicleId);
      }
    }

    for (const sourceLog of sourceLogs) {
      const vehicleId = vehicleIdMap.get(Number(sourceLog.vehicle_id));
      const userId = userIdMap.get(Number(sourceLog.user_id)) || req.session.user.id;
      if (!vehicleId) continue;

      const duplicate = db.prepare(
        `SELECT 1 FROM vehicle_logs
         WHERE vehicle_id = ? AND user_id = ? AND datetime_out = ? AND datetime_in = ? AND purpose = ?
         LIMIT 1`
      ).get(
        vehicleId,
        userId,
        String(sourceLog.datetime_out || ""),
        String(sourceLog.datetime_in || ""),
        String(sourceLog.purpose || "")
      );
      if (duplicate) continue;

      db.prepare(
        `INSERT INTO vehicle_logs
          (guid, vehicle_id, user_id, datetime_out, datetime_in, mileage_out, mileage_in, purpose, remarks, fuel_pump_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        makeGuid(),
        vehicleId,
        userId,
        String(sourceLog.datetime_out || ""),
        String(sourceLog.datetime_in || ""),
        sourceLog.mileage_out == null ? null : Number(sourceLog.mileage_out),
        sourceLog.mileage_in == null ? null : Number(sourceLog.mileage_in),
        String(sourceLog.purpose || ""),
        normalizeRemarks(sourceLog.remarks),
        sourceLog.fuel_pump_cost == null ? null : Number(sourceLog.fuel_pump_cost),
        String(sourceLog.created_at || new Date().toISOString())
      );
      logsImported += 1;
    }

    for (const sourceReceipt of sourceReceipts) {
      const vehicleId = vehicleIdMap.get(Number(sourceReceipt.vehicle_id));
      const userId = userIdMap.get(Number(sourceReceipt.user_id)) || req.session.user.id;
      const guardId = userIdMap.get(Number(sourceReceipt.guard_id)) || req.session.user.id;
      if (!vehicleId) continue;

      const duplicate = db.prepare(
        `SELECT 1 FROM petrol_receipts
         WHERE vehicle_id = ? AND receipt_number = ? AND pump_datetime = ?
         LIMIT 1`
      ).get(
        vehicleId,
        String(sourceReceipt.receipt_number || ""),
        String(sourceReceipt.pump_datetime || "")
      );
      if (duplicate) continue;

      db.prepare(
        `INSERT INTO petrol_receipts
          (guid, vehicle_id, user_id, pump_datetime, receipt_number, odometer_at_pump, amount, guard_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        makeGuid(),
        vehicleId,
        userId,
        String(sourceReceipt.pump_datetime || ""),
        String(sourceReceipt.receipt_number || ""),
        Number(sourceReceipt.odometer_at_pump || 0),
        sourceReceipt.amount == null ? null : Number(sourceReceipt.amount),
        guardId,
        String(sourceReceipt.created_at || new Date().toISOString())
      );
      receiptsImported += 1;
    }

    for (const sourceMove of sourceMovements) {
      const userId = userIdMap.get(Number(sourceMove.user_id)) || req.session.user.id;
      const personType = String(sourceMove.person_type || "").toLowerCase();
      if (!["officer", "contractor"].includes(personType)) continue;

      const duplicate = db.prepare(
        `SELECT 1 FROM movements
         WHERE user_id = ? AND person_type = ? AND person_name = ? AND datetime_out = ?
         LIMIT 1`
      ).get(
        userId,
        personType,
        String(sourceMove.person_name || ""),
        String(sourceMove.datetime_out || "")
      );
      if (duplicate) continue;

      db.prepare(
        `INSERT INTO movements
          (guid, user_id, person_type, person_name, company, destination, datetime_out, datetime_in, remarks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        makeGuid(),
        userId,
        personType,
        String(sourceMove.person_name || ""),
        String(sourceMove.company || ""),
        String(sourceMove.destination || ""),
        String(sourceMove.datetime_out || ""),
        String(sourceMove.datetime_in || ""),
        normalizeRemarks(sourceMove.remarks),
        String(sourceMove.created_at || new Date().toISOString())
      );
      movementsImported += 1;
    }
  });

  try {
    tx();
    return res.json({
      ok: true,
      imported: {
        users: usersImported,
        vehicles: vehiclesImported,
        vehicle_logs: logsImported,
        petrol_receipts: receiptsImported,
        movements: movementsImported,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: "Migration failed.", detail: String(error.message || error) });
  }
});

app.patch("/api/auth/change-password", authRequired, (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current password and new password are required." });
  }
  if (!newPassword.trim()) {
    return res.status(400).json({ error: "New password is required." });
  }
  if (newPassword.toLowerCase() === "password") {
    return res.status(400).json({ error: "Default password is not allowed." });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
  if (!user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  if (String(user.password_hash || "") !== currentPassword) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newPassword, user.id);
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  const userPayload = buildUserPayload(updated);
  req.session.user = userPayload;
  if (req.authToken) {
    tokenStore.set(req.authToken, userPayload);
  }

  return res.json({ ok: true });
});

app.get("/api/users", authRequired, (req, res) => {
  const users = db
    .prepare("SELECT id, guid, username, full_name, owned_vehicle, role, team_id, alert_days_coe, alert_days_roadtax, alert_enabled_vehicle, alert_enabled_contractor, alert_enabled, created_at FROM users ORDER BY id DESC")
    .all();
  res.json({ users });
});

app.post("/api/users", adminRequired, (req, res) => {
  const username = String(req.body.username || "").trim();
  const fullName = String(req.body.fullName || "").trim();
  const ownedVehicle = normalizeOwnedVehicles(req.body.ownedVehicle);
  const password = String(req.body.password || "");
  const role = String(req.body.role || "user").trim().toLowerCase();
  const alertDaysCoe = Math.max(0, sanitizeInt(req.body.alertDaysCoe, 30));
  const alertDaysRoadTax = Math.max(0, sanitizeInt(req.body.alertDaysRoadTax, 30));
  const alertsEnabledVehicle = req.body.alertsEnabledVehicle ? 1 : 0;
  const alertsEnabledContractor = req.body.alertsEnabledContractor ? 1 : 0;
  const alertsEnabled = req.body.alertsEnabled == null ? (alertsEnabledVehicle || alertsEnabledContractor ? 1 : 0) : (req.body.alertsEnabled ? 1 : 0);
  const teamId = resolveTeamId(req.body.teamId);

  if (!username || !password) return res.status(400).json({ error: "Username and password are required." });
  if (!["admin", "user"].includes(role)) return res.status(400).json({ error: "Role must be admin or user." });

  const duplicateUser = db.prepare("SELECT id FROM users WHERE lower(username) = lower(?)").get(username);
  if (duplicateUser) return res.status(409).json({ error: "Username already exists." });

  try {
    const result = db
      .prepare(
        `INSERT INTO users (guid, username, full_name, owned_vehicle, password_hash, role, team_id, alert_days_coe, alert_days_roadtax, alert_enabled_vehicle, alert_enabled_contractor, alert_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(makeGuid(), username, fullName, ownedVehicle, password, role, teamId, alertDaysCoe, alertDaysRoadTax, alertsEnabledVehicle, alertsEnabledContractor, alertsEnabled);

    writeAuditLog(req, {
      action: "add",
      entityType: "user",
      entityId: result.lastInsertRowid,
      summary: `Created user ${username} (${role})`,
      details: { username, role },
    });

    return res.json({ id: result.lastInsertRowid });
  } catch (error) {
    const message = String(error.message || "");
    if (message.includes("UNIQUE")) {
      return res.status(409).json({ error: "Username already exists." });
    }
    return res.status(500).json({ error: `Failed to create user: ${message}` });
  }
});

app.patch("/api/users/:id", adminRequired, (req, res) => {
  const userId = sanitizeInt(req.params.id, 0);
  if (!userId) return res.status(400).json({ error: "Invalid user id." });

  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!existing) return res.status(404).json({ error: "User not found." });

  const username = String(req.body.username ?? existing.username ?? "").trim();
  if (!username) {
    return res.status(400).json({ error: "Username is required." });
  }
  const duplicateUsername = db
    .prepare("SELECT id FROM users WHERE lower(username) = lower(?) AND id != ?")
    .get(username, userId);
  if (duplicateUsername) {
    return res.status(409).json({ error: "Username already exists." });
  }

  const fullName = String(req.body.fullName ?? existing.full_name ?? "").trim();
  const ownedVehicle = normalizeOwnedVehicles(req.body.ownedVehicle ?? existing.owned_vehicle ?? "");
  const role = String(req.body.role ?? existing.role ?? "user").trim().toLowerCase();
  const alertDaysCoe = Math.max(0, sanitizeInt(req.body.alertDaysCoe, existing.alert_days_coe || 30));
  const alertDaysRoadTax = Math.max(0, sanitizeInt(req.body.alertDaysRoadTax, existing.alert_days_roadtax || 30));
  const alertsEnabledVehicle =
    req.body.alertsEnabledVehicle == null
      ? Number(existing.alert_enabled_vehicle ?? existing.alert_enabled ?? 0)
      : (req.body.alertsEnabledVehicle ? 1 : 0);
  const alertsEnabledContractor =
    req.body.alertsEnabledContractor == null
      ? Number(existing.alert_enabled_contractor ?? existing.alert_enabled ?? 0)
      : (req.body.alertsEnabledContractor ? 1 : 0);
  const alertsEnabled = req.body.alertsEnabled == null ? (alertsEnabledVehicle || alertsEnabledContractor ? 1 : 0) : (req.body.alertsEnabled ? 1 : 0);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const teamId = req.body.teamId === undefined ? (existing.team_id ?? null) : resolveTeamId(req.body.teamId);

  if (!["admin", "user"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin or user." });
  }

  if (password && password.trim()) {
    db.prepare(
      "UPDATE users SET username = ?, full_name = ?, owned_vehicle = ?, role = ?, team_id = ?, alert_days_coe = ?, alert_days_roadtax = ?, alert_enabled_vehicle = ?, alert_enabled_contractor = ?, alert_enabled = ?, password_hash = ? WHERE id = ?"
    ).run(username, fullName, ownedVehicle, role, teamId, alertDaysCoe, alertDaysRoadTax, alertsEnabledVehicle, alertsEnabledContractor, alertsEnabled, password, userId);
  } else {
    db.prepare("UPDATE users SET username = ?, full_name = ?, owned_vehicle = ?, role = ?, team_id = ?, alert_days_coe = ?, alert_days_roadtax = ?, alert_enabled_vehicle = ?, alert_enabled_contractor = ?, alert_enabled = ? WHERE id = ?").run(
      username,
      fullName,
      ownedVehicle,
      role,
      teamId,
      alertDaysCoe,
      alertDaysRoadTax,
      alertsEnabledVehicle,
      alertsEnabledContractor,
      alertsEnabled,
      userId
    );
  }

  writeAuditLog(req, {
    action: "edit",
    entityType: "user",
    entityId: userId,
    summary: `Updated user ${username}`,
    details: { username, previousUsername: existing.username, role },
  });

  if (req.session.user && req.session.user.id === userId) {
    req.session.user.username = username;
    req.session.user.role = role;
    req.session.user.fullName = fullName;
    req.session.user.ownedVehicle = ownedVehicle;
    req.session.user.alertDaysCoe = alertDaysCoe;
    req.session.user.alertDaysRoadTax = alertDaysRoadTax;
    req.session.user.alertsEnabledVehicle = Boolean(alertsEnabledVehicle);
    req.session.user.alertsEnabledContractor = Boolean(alertsEnabledContractor);
    req.session.user.alertsEnabled = Boolean(alertsEnabled);
    if (req.authToken) {
      tokenStore.set(req.authToken, req.session.user);
    }
  }

  return res.json({ ok: true });
});

app.delete("/api/users/:id", adminRequired, (req, res) => {
  const userId = sanitizeInt(req.params.id, 0);
  if (!userId) return res.status(400).json({ error: "Invalid user id." });
  if (req.session.user && req.session.user.id === userId) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!existing) return res.status(404).json({ error: "User not found." });

  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "user",
    entityId: userId,
    summary: `Deleted user id ${userId}`,
    details: {},
  });
  return res.json({ ok: true });
});

app.patch("/api/users/me/alerts", authRequired, (req, res) => {
  const alertDaysCoe = Math.max(0, sanitizeInt(req.body.alertDaysCoe, req.session.user.alertDaysCoe || 30));
  const alertDaysRoadTax = Math.max(0, sanitizeInt(req.body.alertDaysRoadTax, req.session.user.alertDaysRoadTax || 30));

  db.prepare("UPDATE users SET alert_days_coe = ?, alert_days_roadtax = ? WHERE id = ?").run(
    alertDaysCoe,
    alertDaysRoadTax,
    req.session.user.id
  );

  req.session.user.alertDaysCoe = alertDaysCoe;
  req.session.user.alertDaysRoadTax = alertDaysRoadTax;

  if (canUserReceiveNotifications(req.session.user)) {
    syncNotificationsForUser(req.session.user);
  }

  res.json({ ok: true });
});

app.get("/api/vehicles", authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT v.*, COALESCE(NULLIF(v.assigned_codename, ''), u.username, '') AS assigned_username
       FROM vehicles v
       LEFT JOIN users u ON u.id = v.assigned_user_id
       ORDER BY v.id DESC`
    )
    .all();

  const invoiceRows = db
    .prepare("SELECT id, vehicle_id, invoice_type, invoice_date, amount, description, file_path, created_at FROM vehicle_invoices ORDER BY invoice_date DESC, id DESC")
    .all();
  const invoicesByVehicle = new Map();
  for (const invoice of invoiceRows) {
    if (!invoicesByVehicle.has(invoice.vehicle_id)) invoicesByVehicle.set(invoice.vehicle_id, []);
    invoicesByVehicle.get(invoice.vehicle_id).push(invoice);
  }

  const vehicles = rows.map((row) => ({
    ...row,
    security_plates: normalizeSecurityPlates(row.security_plates),
    image_paths: parseImagePaths(row.image_paths, row.image_path),
    invoices: invoicesByVehicle.get(row.id) || [],
  }));
  res.json({ vehicles });
});

app.post("/api/vehicles", adminRequired, vehicleUpload, (req, res) => {
  const plateNo = String(req.body.plateNo || "").trim().toUpperCase();
  const make = String(req.body.make || "").trim();
  const model = String(req.body.model || "").trim();
  const vehicleType = String(req.body.vehicleType || "").trim();
  const registrationDate = String(req.body.registrationDate || "").trim();
  const coeExpiry = String(req.body.coeExpiry || "").trim();
  const roadTaxExpiry = String(req.body.roadTaxExpiry || "").trim();
  const assignedCodename = String(req.body.assignedCodename || "").trim();
  const securityPlates = normalizeSecurityPlates(req.body.securityPlates);
  const requestedCurrentPlate = normalizePlateValue(req.body.currentPlate);
  const allowedCurrentPlates = getAllowedCurrentPlates(plateNo, securityPlates);
  if (requestedCurrentPlate && !allowedCurrentPlates.includes(requestedCurrentPlate)) {
    return res.status(400).json({ error: "Current Assigned Plate must match original or security plate." });
  }
  const currentPlate = resolveCurrentAssignedPlate({
    plateNo,
    securityPlates,
    currentPlate: requestedCurrentPlate,
    existingCurrentPlate: plateNo,
  });
  const nextInspectionDue = String(req.body.nextInspectionDue || "").trim();
  const nextServicingDue = String(req.body.nextServicingDue || "").trim();
  const insuranceDueDate = String(req.body.insuranceDueDate || "").trim();
  const remarks = normalizeRemarks(req.body.remarks);
  const teamId = resolveTeamId(req.body.teamId);

  if (!plateNo || !make || !model || !coeExpiry || !roadTaxExpiry) {
    return res.status(400).json({ error: "Plate no, make, model, COE expiry, and road tax expiry are required." });
  }

  const pictureFile = req.files && Array.isArray(req.files.picture) ? req.files.picture[0] : null;
  const pictureFiles = req.files && Array.isArray(req.files.pictures) ? req.files.pictures : [];
  const insuranceCertificateFile = req.files && Array.isArray(req.files.insuranceCertificate) ? req.files.insuranceCertificate[0] : null;
  // Collect every uploaded picture (new multi-file `pictures[]` plus the legacy
  // single `picture`/data URL fallback) into the image_paths JSON array.
  const imagePathList = [];
  for (const file of pictureFiles) imagePathList.push(`/uploads/${file.filename}`);
  if (pictureFile) imagePathList.push(`/uploads/${pictureFile.filename}`);
  const legacyImageValue = String(req.body.pictureData || req.body.pictureName || "").trim();
  if (!imagePathList.length && legacyImageValue) imagePathList.push(legacyImageValue);
  const dedupedImagePaths = imagePathList.filter((item, index, all) => item && all.indexOf(item) === index);
  const imagePath = dedupedImagePaths[0] || null;
  const imagePathsJson = JSON.stringify(dedupedImagePaths);
  const insuranceCertPath = insuranceCertificateFile
    ? `/uploads/${insuranceCertificateFile.filename}`
    : String(req.body.insuranceCertificateData || req.body.insuranceCertificateName || "").trim() || null;

  try {
    const result = db
      .prepare(
        `INSERT INTO vehicles (guid, plate_no, make, model, vehicle_type, registration_date, coe_expiry, road_tax_expiry, image_path, image_paths, security_plates, current_plate, next_inspection_due, next_servicing_due, insurance_due_date, insurance_cert_path, remarks, team_id, assigned_codename, assigned_user_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        makeGuid(),
        plateNo,
        make,
        model,
        vehicleType,
        registrationDate,
        coeExpiry,
        roadTaxExpiry,
        imagePath,
        imagePathsJson,
        JSON.stringify(securityPlates),
        currentPlate,
        nextInspectionDue,
        nextServicingDue,
        insuranceDueDate,
        insuranceCertPath,
        remarks,
        teamId,
        assignedCodename,
        req.session.user.id
      );
    // Insert any invoices submitted together with the new vehicle.
    const invoiceFiles = req.files && Array.isArray(req.files.invoiceFiles) ? req.files.invoiceFiles : [];
    insertVehicleInvoices(result.lastInsertRowid, req.body.invoices, invoiceFiles, req.session.user.id);
    writeAuditLog(req, {
      action: "add",
      entityType: "vehicle",
      entityId: result.lastInsertRowid,
      summary: `Created vehicle ${plateNo}`,
      details: { plateNo, assignedCodename },
    });
    return res.json({ id: result.lastInsertRowid });
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return res.status(409).json({ error: "Vehicle plate number already exists." });
    }
    return res.status(500).json({ error: "Failed to create vehicle." });
  }
});

app.patch("/api/vehicles/:id", adminRequired, (req, res) => {
  const vehicleId = sanitizeInt(req.params.id, 0);
  if (!vehicleId) return res.status(400).json({ error: "Invalid vehicle id." });

  const existing = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(vehicleId);
  if (!existing) return res.status(404).json({ error: "Vehicle not found." });

  const plateNo = String(req.body.plateNo || existing.plate_no || "").trim().toUpperCase();
  const make = String(req.body.make || existing.make || "").trim();
  const model = String(req.body.model || existing.model || "").trim();
  const vehicleType = String(req.body.vehicleType ?? existing.vehicle_type ?? "").trim();
  const registrationDate = String(req.body.registrationDate ?? existing.registration_date ?? "").trim();
  const coeExpiry = String(req.body.coeExpiry || existing.coe_expiry || "").trim();
  const roadTaxExpiry = String(req.body.roadTaxExpiry || existing.road_tax_expiry || "").trim();
  const assignedCodename = String(req.body.assignedCodename ?? existing.assigned_codename ?? "").trim();
  const securityPlates = normalizeSecurityPlates(req.body.securityPlates == null ? existing.security_plates : req.body.securityPlates);
  const requestedCurrentPlate = normalizePlateValue(req.body.currentPlate);
  const allowedCurrentPlates = getAllowedCurrentPlates(plateNo, securityPlates);
  if (requestedCurrentPlate && !allowedCurrentPlates.includes(requestedCurrentPlate)) {
    return res.status(400).json({ error: "Current Assigned Plate must match original or security plate." });
  }
  const currentPlate = resolveCurrentAssignedPlate({
    plateNo,
    securityPlates,
    currentPlate: requestedCurrentPlate,
    existingCurrentPlate: existing.current_plate || existing.plate_no,
  });
  const nextInspectionDue = String(req.body.nextInspectionDue ?? existing.next_inspection_due ?? "").trim();
  const nextServicingDue = String(req.body.nextServicingDue ?? existing.next_servicing_due ?? "").trim();
  const insuranceDueDate = String(req.body.insuranceDueDate ?? existing.insurance_due_date ?? "").trim();
  const remarks = normalizeRemarks(req.body.remarks ?? existing.remarks ?? "");
  const teamId = req.body.teamId === undefined ? (existing.team_id ?? null) : resolveTeamId(req.body.teamId);

  if (!plateNo || !make || !model || !coeExpiry || !roadTaxExpiry) {
    return res.status(400).json({ error: "Plate no, make, model, COE expiry, and road tax expiry are required." });
  }

  const duplicate = db.prepare("SELECT id FROM vehicles WHERE lower(plate_no) = lower(?) AND id <> ?").get(plateNo, vehicleId);
  if (duplicate) {
    return res.status(409).json({ error: "Vehicle plate number already exists." });
  }

  // Optional kept-picture list: an array of existing image URLs the client wants
  // to retain. When provided we rewrite image_paths (and the legacy image_path).
  let keptImagePathsClause = "";
  let keptImagePathsValue = null;
  let keptImagePathValue = null;
  if (req.body.imagePaths !== undefined) {
    const kept = parseImagePaths(req.body.imagePaths, "");
    keptImagePathsValue = JSON.stringify(kept);
    keptImagePathValue = kept[0] || null;
    keptImagePathsClause = ", image_paths = ?, image_path = ?";
  }

  const updateParams = [plateNo, make, model, vehicleType, registrationDate, coeExpiry, roadTaxExpiry, JSON.stringify(securityPlates), currentPlate, nextInspectionDue, nextServicingDue, insuranceDueDate, remarks, teamId, assignedCodename];
  if (keptImagePathsClause) {
    updateParams.push(keptImagePathsValue, keptImagePathValue);
  }
  updateParams.push(vehicleId);

  db.prepare(
    `UPDATE vehicles SET plate_no = ?, make = ?, model = ?, vehicle_type = ?, registration_date = ?, coe_expiry = ?, road_tax_expiry = ?, security_plates = ?, current_plate = ?, next_inspection_due = ?, next_servicing_due = ?, insurance_due_date = ?, remarks = ?, team_id = ?, assigned_codename = ?${keptImagePathsClause} WHERE id = ?`
  ).run(...updateParams);

  writeAuditLog(req, {
    action: "edit",
    entityType: "vehicle",
    entityId: vehicleId,
    summary: `Updated vehicle ${plateNo}`,
    details: { plateNo, assignedCodename },
  });

  return res.json({ ok: true });
});

app.delete("/api/vehicles/:id", adminRequired, (req, res) => {
  const vehicleId = sanitizeInt(req.params.id, 0);
  if (!vehicleId) return res.status(400).json({ error: "Invalid vehicle id." });

  const existing = db.prepare("SELECT id FROM vehicles WHERE id = ?").get(vehicleId);
  if (!existing) return res.status(404).json({ error: "Vehicle not found." });

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM vehicle_logs WHERE vehicle_id = ?").run(vehicleId);
    db.prepare("DELETE FROM petrol_receipts WHERE vehicle_id = ?").run(vehicleId);
    db.prepare("DELETE FROM vehicle_invoices WHERE vehicle_id = ?").run(vehicleId);
    db.prepare("DELETE FROM vehicles WHERE id = ?").run(vehicleId);
  });

  tx();
  writeAuditLog(req, {
    action: "delete",
    entityType: "vehicle",
    entityId: vehicleId,
    summary: `Deleted vehicle id ${vehicleId}`,
    details: {},
  });
  return res.json({ ok: true });
});

// Append one or more pictures to an existing vehicle (used by the edit form).
app.post("/api/vehicles/:id/pictures", adminRequired, vehiclePicturesUpload, (req, res) => {
  const vehicleId = sanitizeInt(req.params.id, 0);
  if (!vehicleId) return res.status(400).json({ error: "Invalid vehicle id." });

  const existing = db.prepare("SELECT * FROM vehicles WHERE id = ?").get(vehicleId);
  if (!existing) return res.status(404).json({ error: "Vehicle not found." });

  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return res.status(400).json({ error: "No pictures uploaded." });

  const current = parseImagePaths(existing.image_paths, existing.image_path);
  for (const file of files) current.push(`/uploads/${file.filename}`);
  const deduped = current.filter((item, index, all) => item && all.indexOf(item) === index);
  db.prepare("UPDATE vehicles SET image_paths = ?, image_path = ? WHERE id = ?").run(
    JSON.stringify(deduped),
    deduped[0] || null,
    vehicleId
  );

  writeAuditLog(req, {
    action: "edit",
    entityType: "vehicle",
    entityId: vehicleId,
    summary: `Added ${files.length} picture(s) to vehicle ${existing.plate_no}`,
    details: { added: files.length },
  });
  return res.json({ ok: true, image_paths: deduped });
});

// Add one or more invoices to an existing vehicle (used by the edit form).
app.post("/api/vehicles/:id/invoices", adminRequired, invoiceUpload, (req, res) => {
  const vehicleId = sanitizeInt(req.params.id, 0);
  if (!vehicleId) return res.status(400).json({ error: "Invalid vehicle id." });

  const existing = db.prepare("SELECT id, plate_no FROM vehicles WHERE id = ?").get(vehicleId);
  if (!existing) return res.status(404).json({ error: "Vehicle not found." });

  const files = Array.isArray(req.files) ? req.files : [];
  const inserted = insertVehicleInvoices(vehicleId, req.body.invoices, files, req.session.user.id);
  if (!inserted) return res.status(400).json({ error: "No invoices provided." });

  writeAuditLog(req, {
    action: "edit",
    entityType: "vehicle",
    entityId: vehicleId,
    summary: `Added ${inserted} invoice(s) to vehicle ${existing.plate_no}`,
    details: { added: inserted },
  });
  return res.json({ ok: true });
});

// Delete a single invoice from a vehicle.
app.delete("/api/vehicles/:id/invoices/:invoiceId", adminRequired, (req, res) => {
  const vehicleId = sanitizeInt(req.params.id, 0);
  const invoiceId = sanitizeInt(req.params.invoiceId, 0);
  if (!vehicleId || !invoiceId) return res.status(400).json({ error: "Invalid id." });

  const invoice = db.prepare("SELECT id FROM vehicle_invoices WHERE id = ? AND vehicle_id = ?").get(invoiceId, vehicleId);
  if (!invoice) return res.status(404).json({ error: "Invoice not found." });

  db.prepare("DELETE FROM vehicle_invoices WHERE id = ?").run(invoiceId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "vehicle",
    entityId: vehicleId,
    summary: `Deleted invoice id ${invoiceId} from vehicle id ${vehicleId}`,
    details: { invoiceId },
  });
  return res.json({ ok: true });
});

app.post("/api/vehicle-logs", authRequired, (req, res) => {
  const vehicleId = sanitizeInt(req.body.vehicleId, 0);
  const datetimeOut = String(req.body.datetimeOut || "").trim();
  const datetimeIn = String(req.body.datetimeIn || "").trim();
  const mileageOut = req.body.mileageOut == null || req.body.mileageOut === "" ? null : Number(req.body.mileageOut);
  const mileageIn = req.body.mileageIn === "" ? null : Number(req.body.mileageIn);
  const purpose = String(req.body.purpose || "").trim();
  const remarks = normalizeRemarks(req.body.remarks);
  const fuelPumpCost = req.body.fuelPumpCost === "" ? null : Number(req.body.fuelPumpCost);

  if (!vehicleId) return res.status(400).json({ error: "Vehicle is required." });

  const logInsert = db.prepare(
    `INSERT INTO vehicle_logs
      (guid, vehicle_id, user_id, datetime_out, datetime_in, mileage_out, mileage_in, purpose, remarks, fuel_pump_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(makeGuid(), vehicleId, req.session.user.id, datetimeOut, datetimeIn, mileageOut, mileageIn, purpose, remarks, fuelPumpCost);

  writeAuditLog(req, {
    action: "add",
    entityType: "vehicle_log",
    entityId: logInsert.lastInsertRowid,
    summary: `Created vehicle log for vehicle id ${vehicleId}`,
    details: { vehicleId, fuelPumpCost },
  });

  return res.json({ ok: true });
});

app.patch("/api/vehicle-logs/:id", authRequired, (req, res) => {
  const logId = sanitizeInt(req.params.id, 0);
  if (!logId) return res.status(400).json({ error: "Invalid vehicle log id." });

  const existing = db.prepare("SELECT * FROM vehicle_logs WHERE id = ?").get(logId);
  if (!existing) return res.status(404).json({ error: "Vehicle log not found." });

  const vehicleId = sanitizeInt(req.body.vehicleId, existing.vehicle_id || 0);
  const datetimeOut = String(req.body.datetimeOut || existing.datetime_out || "").trim();
  const datetimeIn = String(req.body.datetimeIn || existing.datetime_in || "").trim();
  const mileageIn = req.body.mileageIn === "" ? null : Number(req.body.mileageIn);
  const purpose = String(req.body.purpose || existing.purpose || "").trim();
  const remarks = normalizeRemarks(req.body.remarks ?? existing.remarks ?? "");
  const fuelPumpCost = req.body.fuelPumpCost === "" ? null : Number(req.body.fuelPumpCost);

  if (!vehicleId) return res.status(400).json({ error: "Vehicle is required." });

  db.prepare(
    "UPDATE vehicle_logs SET vehicle_id = ?, datetime_out = ?, datetime_in = ?, mileage_in = ?, purpose = ?, remarks = ?, fuel_pump_cost = ? WHERE id = ?"
  ).run(vehicleId, datetimeOut, datetimeIn, mileageIn, purpose, remarks, fuelPumpCost, logId);

  writeAuditLog(req, {
    action: "edit",
    entityType: "vehicle_log",
    entityId: logId,
    summary: `Updated vehicle log id ${logId}`,
    details: { vehicleId, fuelPumpCost },
  });

  return res.json({ ok: true });
});

app.delete("/api/vehicle-logs/:id", authRequired, (req, res) => {
  const logId = sanitizeInt(req.params.id, 0);
  if (!logId) return res.status(400).json({ error: "Invalid vehicle log id." });

  const existing = db.prepare("SELECT id FROM vehicle_logs WHERE id = ?").get(logId);
  if (!existing) return res.status(404).json({ error: "Vehicle log not found." });

  db.prepare("DELETE FROM vehicle_logs WHERE id = ?").run(logId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "vehicle_log",
    entityId: logId,
    summary: `Deleted vehicle log id ${logId}`,
    details: {},
  });
  return res.json({ ok: true });
});

app.get("/api/settings/mobile-photos-dir", authRequired, (req, res) => {
  const dir = getMobilePhotosDir();
  let exists = false;
  try {
    exists = fs.statSync(dir).isDirectory();
  } catch (_) {
    exists = false;
  }
  return res.json({
    path: dir,
    exists,
    default: defaultMobilePhotosDir,
    locked: Boolean(process.env.MOBILE_PHOTOS_DIR),
  });
});

// Lists sub-folders of a server directory so an admin can navigate and pick the
// mobile photos folder without typing the full path. Uses async fs so a slow or
// hanging mount (common on a NAS) never blocks the whole event loop.
app.get("/api/settings/browse-dirs", adminRequired, async (req, res) => {
  const requested = String((req.query && req.query.path) || "").trim();

  if (!requested && process.platform === "win32") {
    const drives = [];
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        await fs.promises.access(drive);
        drives.push({ name: drive, path: drive });
      } catch (_) {
        // Drive not present; skip.
      }
    }
    return res.json({ path: "", parent: null, isRoot: true, entries: drives });
  }

  const current = path.resolve(requested || os.homedir() || "/");
  let raw;
  try {
    raw = await fs.promises.readdir(current, { withFileTypes: true });
  } catch (error) {
    return res.status(400).json({ error: `Cannot open folder: ${current}` });
  }

  const entries = [];
  for (const entry of raw) {
    let isDir = false;
    try {
      if (entry.isDirectory()) {
        isDir = true;
      } else if (entry.isSymbolicLink()) {
        const stat = await fs.promises.stat(path.join(current, entry.name));
        isDir = stat.isDirectory();
      }
    } catch (_) {
      isDir = false;
    }
    if (isDir) {
      entries.push({ name: entry.name, path: path.join(current, entry.name) });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(current);
  return res.json({
    path: current,
    parent: parent === current ? null : parent,
    isRoot: false,
    entries,
  });
});

app.put("/api/settings/mobile-photos-dir", adminRequired, (req, res) => {
  if (process.env.MOBILE_PHOTOS_DIR) {
    return res.status(400).json({ error: "Folder is fixed by the MOBILE_PHOTOS_DIR environment variable and cannot be changed here." });
  }
  const nextPath = String((req.body && req.body.path) || "").trim();
  if (!nextPath) {
    return res.status(400).json({ error: "Folder path is required." });
  }
  let exists = false;
  try {
    exists = fs.statSync(nextPath).isDirectory();
  } catch (_) {
    exists = false;
  }
  if (!exists) {
    return res.status(400).json({ error: `Folder not found on the server: ${nextPath}` });
  }
  const settings = readSettings();
  settings.mobilePhotosDir = nextPath;
  writeSettings(settings);
  return res.json({ ok: true, path: nextPath, exists: true });
});

app.get("/api/petrol-receipts/latest-photo", authRequired, (req, res) => {
  const mobilePhotosDir = getMobilePhotosDir();
  const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif", ".pdf"]);
  let entries;
  try {
    entries = fs.readdirSync(mobilePhotosDir, { withFileTypes: true });
  } catch (error) {
    return res.status(404).json({ error: `Mobile photos folder not found: ${mobilePhotosDir}` });
  }

  let latest = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!imageExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const fullPath = path.join(mobilePhotosDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = { name: entry.name, fullPath, mtimeMs: stat.mtimeMs };
    }
  }

  if (!latest) {
    return res.status(404).json({ error: "No photo found in the mobile photos folder yet." });
  }

  // Only surface a photo that was captured/saved TODAY. If the newest file is
  // from a previous day, treat it as "no photo" so the preview stays hidden.
  const photoDate = new Date(latest.mtimeMs);
  const now = new Date();
  const isToday =
    photoDate.getFullYear() === now.getFullYear() &&
    photoDate.getMonth() === now.getMonth() &&
    photoDate.getDate() === now.getDate();
  if (!isToday) {
    return res.status(404).json({ error: "No photo captured today." });
  }

  res.setHeader("X-Photo-Name", encodeURIComponent(latest.name));
  res.setHeader("X-Photo-Mtime", String(Math.round(latest.mtimeMs)));
  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(latest.fullPath);
});

app.post("/api/petrol-receipts", authRequired, receiptUpload, (req, res) => {
  const vehicleId = sanitizeInt(req.body.vehicleId, 0);
  const pumpDatetime = String(req.body.pumpDatetime || "").trim();
  const receiptNumber = String(req.body.receiptNumber || "").trim();
  const odometerAtPump = Number(req.body.odometerAtPump);
  const amount = req.body.amount === "" ? null : Number(req.body.amount);
  const guardUsername = String(req.body.guardUsername || "").trim();
  const guardPassword = String(req.body.guardPassword || "");
  const receiptImagePath = req.file ? `/uploads/${req.file.filename}` : null;

  if (!vehicleId || !pumpDatetime || !receiptNumber || !Number.isFinite(odometerAtPump)) {
    return res.status(400).json({ error: "Vehicle, pump datetime, receipt no, and odometer are required." });
  }

  const guard = db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(guardUsername);
  if (!guard) return res.status(403).json({ error: "Administrator username not found." });
  if (guard.role !== "admin") {
    return res.status(403).json({ error: "Only administrator can authenticate petrol receipt." });
  }
  if (guardPassword !== String(guard.password_hash || "")) {
    return res.status(403).json({ error: "Incorrect administrator password." });
  }

  const receiptInsert = db.prepare(
    `INSERT INTO petrol_receipts
      (guid, vehicle_id, user_id, pump_datetime, receipt_number, odometer_at_pump, amount, receipt_image_path, guard_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(makeGuid(), vehicleId, req.session.user.id, pumpDatetime, receiptNumber, odometerAtPump, amount, receiptImagePath, guard.id);

  writeAuditLog(req, {
    action: "add",
    entityType: "petrol_receipt",
    entityId: receiptInsert.lastInsertRowid,
    summary: `Created petrol receipt ${receiptNumber}`,
    details: { vehicleId, receiptNumber, amount },
  });

  return res.json({ ok: true });
});

app.patch("/api/petrol-receipts/:id", authRequired, receiptUpload, (req, res) => {
  const receiptId = sanitizeInt(req.params.id, 0);
  if (!receiptId) return res.status(400).json({ error: "Invalid petrol receipt id." });

  const existing = db.prepare("SELECT * FROM petrol_receipts WHERE id = ?").get(receiptId);
  if (!existing) return res.status(404).json({ error: "Petrol receipt not found." });

  const vehicleId = sanitizeInt(req.body.vehicleId, existing.vehicle_id || 0);
  const pumpDatetime = String(req.body.pumpDatetime ?? existing.pump_datetime ?? "").trim();
  const receiptNumber = String(req.body.receiptNumber ?? existing.receipt_number ?? "").trim();
  const odometerAtPump = req.body.odometerAtPump === "" ? null : Number(req.body.odometerAtPump ?? existing.odometer_at_pump);
  const amount = req.body.amount === "" ? null : Number(req.body.amount ?? existing.amount);
  const guardUsername = String(req.body.guardUsername || "").trim();
  const guardPassword = String(req.body.guardPassword || "");

  if (!vehicleId || !pumpDatetime || !receiptNumber || !Number.isFinite(odometerAtPump)) {
    return res.status(400).json({ error: "Vehicle, pump datetime, receipt no, and odometer are required." });
  }

  let guardId = existing.guard_id;
  if (guardUsername || guardPassword) {
    const guard = db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(guardUsername);
    if (!guard) return res.status(403).json({ error: "Administrator username not found." });
    if (guard.role !== "admin") {
      return res.status(403).json({ error: "Only administrator can authenticate petrol receipt." });
    }
    if (guardPassword !== String(guard.password_hash || "")) {
      return res.status(403).json({ error: "Incorrect administrator password." });
    }
    guardId = guard.id;
  }

  const receiptImagePath = req.file ? `/uploads/${req.file.filename}` : existing.receipt_image_path;

  db.prepare(
    "UPDATE petrol_receipts SET vehicle_id = ?, pump_datetime = ?, receipt_number = ?, odometer_at_pump = ?, amount = ?, receipt_image_path = ?, guard_id = ? WHERE id = ?"
  ).run(vehicleId, pumpDatetime, receiptNumber, odometerAtPump, amount, receiptImagePath, guardId, receiptId);

  writeAuditLog(req, {
    action: "edit",
    entityType: "petrol_receipt",
    entityId: receiptId,
    summary: `Updated petrol receipt id ${receiptId}`,
    details: { vehicleId, receiptNumber, amount },
  });

  return res.json({ ok: true });
});

app.delete("/api/petrol-receipts/:id", authRequired, (req, res) => {
  const receiptId = sanitizeInt(req.params.id, 0);
  if (!receiptId) return res.status(400).json({ error: "Invalid petrol receipt id." });

  const existing = db.prepare("SELECT id FROM petrol_receipts WHERE id = ?").get(receiptId);
  if (!existing) return res.status(404).json({ error: "Petrol receipt not found." });

  db.prepare("DELETE FROM petrol_receipts WHERE id = ?").run(receiptId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "petrol_receipt",
    entityId: receiptId,
    summary: `Deleted petrol receipt id ${receiptId}`,
    details: {},
  });
  return res.json({ ok: true });
});

// Administrator changes a petrol receipt's status. "With Guard" is the state a
// receipt is in after a user submits it; an admin can move it to "Withdrawn"
// (and back if needed).
app.patch("/api/petrol-receipts/:id/status", authRequired, (req, res) => {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Only administrator can change receipt status." });
  }

  const receiptId = sanitizeInt(req.params.id, 0);
  if (!receiptId) return res.status(400).json({ error: "Invalid petrol receipt id." });

  const existing = db.prepare("SELECT * FROM petrol_receipts WHERE id = ?").get(receiptId);
  if (!existing) return res.status(404).json({ error: "Petrol receipt not found." });

  const status = String(req.body.status || "").trim();
  const allowed = ["With Guard", "Withdrawn"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Status must be 'With Guard' or 'Withdrawn'." });
  }

  if (status === "Withdrawn") {
    db.prepare(
      "UPDATE petrol_receipts SET status = ?, withdrawn_by = ?, withdrawn_at = ? WHERE id = ?"
    ).run(status, req.session.user.id, new Date().toISOString(), receiptId);
  } else {
    db.prepare(
      "UPDATE petrol_receipts SET status = ?, withdrawn_by = NULL, withdrawn_at = NULL WHERE id = ?"
    ).run(status, receiptId);
  }

  writeAuditLog(req, {
    action: "edit",
    entityType: "petrol_receipt",
    entityId: receiptId,
    summary: `Set petrol receipt id ${receiptId} status to ${status}`,
    details: { status },
  });

  return res.json({ ok: true, status });
});

function parseOfficeVehicleCodenames(vehicleValue) {
  const text = String(vehicleValue || "").trim();
  if (!text) return [];
  // Staff movements store the vehicle as free-text "Vehicle Details". When the
  // value matches an assigned office-vehicle codename it should sync to the
  // vehicle logs. Legacy/contractor values may still carry an "Office Vehicle:"
  // prefix, so strip it when present; otherwise treat the whole value as the
  // codename list.
  const officePrefix = "office vehicle:";
  const body = text.toLowerCase().startsWith(officePrefix)
    ? text.slice(officePrefix.length)
    : text;
  return body
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((value) => value.toLowerCase() === item.toLowerCase()) === index);
}

function findVehicleByCodename(codename) {
  const normalized = String(codename || "").trim();
  if (!normalized) return null;
  // Staff office-vehicle labels are formatted as "Codename - CurrentPlate", but
  // legacy movements may store only the codename. Match on any of these parts.
  const parts = normalized.split(" - ");
  const codenamePart = parts.length > 1 ? parts.slice(0, -1).join(" - ").trim() : normalized;
  const platePart = parts.length > 1 ? parts[parts.length - 1].trim() : "";
  return db
    .prepare(
      `SELECT v.*, u.username AS assigned_username
       FROM vehicles v
       LEFT JOIN users u ON u.id = v.assigned_user_id
       WHERE lower(COALESCE(NULLIF(TRIM(v.assigned_codename), ''), u.username, '')) = lower(?)
          OR lower(COALESCE(NULLIF(TRIM(v.assigned_codename), ''), u.username, '')) = lower(?)
          OR lower(TRIM(v.current_plate)) = lower(?)
          OR lower(TRIM(v.plate_no)) = lower(?)
       LIMIT 1`
    )
    .get(normalized, codenamePart, platePart, platePart);
}

// For Staff (officer) movements that use an office vehicle, keep a matching
// vehicle log in sync: create it with the Out time and capture the In time when
// the vehicle is signed back in. Auto-created logs are linked to the movement
// via movement_id so repeated updates never duplicate rows.
function syncOfficeVehicleLogsForMovement(req, movementId) {
  const movement = db.prepare("SELECT * FROM movements WHERE id = ?").get(movementId);
  if (!movement) return;
  if (String(movement.person_type || "").toLowerCase() !== "officer") return;

  const codenames = parseOfficeVehicleCodenames(movement.vehicle);
  if (!codenames.length) return;

  const datetimeOut = String(movement.datetime_out || "").trim();
  const datetimeIn = String(movement.datetime_in || "").trim();
  const sessionUserId = req && req.session && req.session.user ? req.session.user.id : null;
  const purpose = String(movement.destination || "").trim() || "Staff movement";
  const remarks = normalizeRemarks(movement.remarks);

  for (const codename of codenames) {
    const vehicle = findVehicleByCodename(codename);
    if (!vehicle) continue;

    const logUserId = vehicle.assigned_user_id || sessionUserId;
    if (!logUserId) continue;

    const linked = db
      .prepare("SELECT * FROM vehicle_logs WHERE movement_id = ? AND vehicle_id = ?")
      .get(movementId, vehicle.id);

    if (linked) {
      db.prepare("UPDATE vehicle_logs SET datetime_out = ?, datetime_in = ? WHERE id = ?").run(
        datetimeOut,
        datetimeIn,
        linked.id
      );
      continue;
    }

    if (datetimeOut) {
      const logInsert = db
        .prepare(
          `INSERT INTO vehicle_logs
            (guid, vehicle_id, user_id, datetime_out, datetime_in, purpose, remarks, movement_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(makeGuid(), vehicle.id, logUserId, datetimeOut, datetimeIn, purpose, remarks, movementId);
      writeAuditLog(req, {
        action: "add",
        entityType: "vehicle_log",
        entityId: logInsert.lastInsertRowid,
        summary: `Auto-created vehicle log for ${vehicle.plate_no} from staff movement id ${movementId}`,
        details: { vehicleId: vehicle.id, movementId },
      });
      continue;
    }

    if (datetimeIn) {
      // In-only entry that was not merged into the original Out movement: close
      // the most recent open auto-created log for this office vehicle instead.
      const openLog = db
        .prepare(
          `SELECT * FROM vehicle_logs
           WHERE vehicle_id = ? AND movement_id IS NOT NULL
             AND (datetime_in IS NULL OR TRIM(datetime_in) = '')
           ORDER BY id DESC LIMIT 1`
        )
        .get(vehicle.id);
      if (openLog) {
        db.prepare("UPDATE vehicle_logs SET datetime_in = ? WHERE id = ?").run(datetimeIn, openLog.id);
      }
    }
  }
}

app.post("/api/movements", authRequired, (req, res) => {
  const personType = String(req.body.personType || "").trim().toLowerCase();
  const personName = String(req.body.personName || "").trim();
  const company = String(req.body.company || "").trim();
  const vehicle = String(req.body.vehicle || "").trim();
  const destination = String(req.body.destination || "").trim();
  const datetimeOut = String(req.body.datetimeOut || "").trim();
  const datetimeIn = String(req.body.datetimeIn || "").trim();
  const remarks = normalizeRemarks(req.body.remarks);

  if (!["officer", "contractor"].includes(personType)) {
    return res.status(400).json({ error: "Person type must be officer or contractor." });
  }
  if (!personName) return res.status(400).json({ error: "Person name is required." });

  const movementInsert = db.prepare(
    `INSERT INTO movements
      (guid, user_id, person_type, person_name, company, vehicle, destination, datetime_out, datetime_in, remarks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(makeGuid(), req.session.user.id, personType, personName, company, vehicle, destination, datetimeOut, datetimeIn, remarks);

  writeAuditLog(req, {
    action: "add",
    entityType: "movement",
    entityId: movementInsert.lastInsertRowid,
    summary: `Created movement for ${personName}`,
    details: { personType, personName, destination },
  });

  return res.json({ ok: true });
});

app.patch("/api/movements/:id", authRequired, (req, res) => {
  const movementId = sanitizeInt(req.params.id, 0);
  if (!movementId) return res.status(400).json({ error: "Invalid movement id." });

  const existing = db.prepare("SELECT * FROM movements WHERE id = ?").get(movementId);
  if (!existing) return res.status(404).json({ error: "Movement not found." });

  const personType = String(req.body.personType ?? existing.person_type ?? "").trim().toLowerCase();
  const personName = String(req.body.personName ?? existing.person_name ?? "").trim();
  const company = String(req.body.company ?? existing.company ?? "").trim();
  const vehicle = String(req.body.vehicle ?? existing.vehicle ?? "").trim();
  const destination = String(req.body.destination ?? existing.destination ?? "").trim();
  const datetimeOut = String(req.body.datetimeOut ?? existing.datetime_out ?? "").trim();
  const datetimeIn = String(req.body.datetimeIn ?? existing.datetime_in ?? "").trim();
  const remarks = normalizeRemarks(req.body.remarks ?? existing.remarks ?? "");

  if (!['officer', 'contractor'].includes(personType)) {
    return res.status(400).json({ error: "Person type must be officer or contractor." });
  }
  if (!personName) return res.status(400).json({ error: "Person name is required." });

  db.prepare(
    `UPDATE movements
      SET person_type = ?, person_name = ?, company = ?, vehicle = ?, destination = ?, datetime_out = ?, datetime_in = ?, remarks = ?
     WHERE id = ?`
    ).run(personType, personName, company, vehicle, destination, datetimeOut, datetimeIn, remarks, movementId);

  writeAuditLog(req, {
    action: "edit",
    entityType: "movement",
    entityId: movementId,
    summary: `Updated movement id ${movementId}`,
    details: { personType, personName, destination },
  });

  return res.json({ ok: true });
});

app.delete("/api/movements/:id", authRequired, (req, res) => {
  const movementId = sanitizeInt(req.params.id, 0);
  if (!movementId) return res.status(400).json({ error: "Invalid movement id." });

  const existing = db.prepare("SELECT * FROM movements WHERE id = ?").get(movementId);
  if (!existing) return res.status(404).json({ error: "Movement not found." });

  db.prepare("DELETE FROM vehicle_logs WHERE movement_id = ?").run(movementId);
  db.prepare("DELETE FROM movements WHERE id = ?").run(movementId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "movement",
    entityId: movementId,
    summary: `Deleted movement id ${movementId}`,
    details: {},
  });
  return res.json({ ok: true });
});

app.get("/api/contractors", authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.guid, c.full_name, c.id_number, COALESCE(co.name, c.company) AS company, c.company_id, c.vehicle, c.clearance_start_date, c.clearance_end_date, c.remarks, c.created_by, c.created_at, c.updated_at
     FROM contractors c
     LEFT JOIN companies co ON co.id = c.company_id
     ORDER BY c.id DESC`
  ).all();

  res.json({ contractors: rows });
});

app.post("/api/contractors", adminRequired, (req, res) => {
  const fullName = String(req.body.fullName || "").trim();
  const idNumber = String(req.body.idNumber || "").trim();
  const companyId = sanitizeInt(req.body.companyId, 0);
  const vehicle = String(req.body.vehicle || "").trim();
  const clearanceStartDate = String(req.body.clearanceStartDate || "").trim();
  const clearanceEndDate = String(req.body.clearanceEndDate || "").trim();
  const remarks = normalizeRemarks(req.body.remarks);

  if (!fullName || !idNumber || !companyId || !vehicle || !clearanceStartDate || !clearanceEndDate) {
    return res.status(400).json({ error: "Full Name, ID Number, Company, Vehicle, Clearance Start Date, and Clearance End Date are required." });
  }

  const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId);
  if (!company) return res.status(400).json({ error: "Valid company is required." });

  const result = db.prepare(
    `INSERT INTO contractors
      (guid, full_name, id_number, company, company_id, vehicle, clearance_start_date, clearance_end_date, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(makeGuid(), fullName, idNumber, company.name, company.id, vehicle, clearanceStartDate, clearanceEndDate, remarks, req.session.user.id);

  writeAuditLog(req, {
    action: "add",
    entityType: "contractor",
    entityId: result.lastInsertRowid,
    summary: `Created contractor ${fullName}`,
    details: { fullName, company: company.name, vehicle },
  });

  res.json({ id: result.lastInsertRowid });
});

app.patch("/api/contractors/:id", adminRequired, (req, res) => {
  const contractorId = sanitizeInt(req.params.id, 0);
  if (!contractorId) return res.status(400).json({ error: "Invalid contractor id." });

  const existing = db.prepare("SELECT * FROM contractors WHERE id = ?").get(contractorId);
  if (!existing) return res.status(404).json({ error: "Contractor not found." });

  const fullName = String(req.body.fullName ?? existing.full_name ?? "").trim();
  const idNumber = String(req.body.idNumber ?? existing.id_number ?? "").trim();
  const companyId = sanitizeInt(req.body.companyId ?? existing.company_id ?? 0, 0);
  const vehicle = String(req.body.vehicle ?? existing.vehicle ?? "").trim();
  const clearanceStartDate = String(req.body.clearanceStartDate ?? existing.clearance_start_date ?? "").trim();
  const clearanceEndDate = String(req.body.clearanceEndDate ?? existing.clearance_end_date ?? "").trim();
  const remarks = normalizeRemarks(req.body.remarks ?? existing.remarks ?? "");

  if (!fullName || !idNumber || !companyId || !vehicle || !clearanceStartDate || !clearanceEndDate) {
    return res.status(400).json({ error: "Full Name, ID Number, Company, Vehicle, Clearance Start Date, and Clearance End Date are required." });
  }

  const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId);
  if (!company) return res.status(400).json({ error: "Valid company is required." });

  db.prepare(
    `UPDATE contractors
     SET full_name = ?, id_number = ?, company = ?, company_id = ?, vehicle = ?, clearance_start_date = ?, clearance_end_date = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(fullName, idNumber, company.name, company.id, vehicle, clearanceStartDate, clearanceEndDate, remarks, contractorId);

  writeAuditLog(req, {
    action: "edit",
    entityType: "contractor",
    entityId: contractorId,
    summary: `Updated contractor ${fullName}`,
    details: { fullName, company: company.name, vehicle },
  });

  res.json({ ok: true });
});

app.delete("/api/contractors/:id", adminRequired, (req, res) => {
  const contractorId = sanitizeInt(req.params.id, 0);
  if (!contractorId) return res.status(400).json({ error: "Invalid contractor id." });

  const existing = db.prepare("SELECT id FROM contractors WHERE id = ?").get(contractorId);
  if (!existing) return res.status(404).json({ error: "Contractor not found." });

  db.prepare("DELETE FROM contractors WHERE id = ?").run(contractorId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "contractor",
    entityId: contractorId,
    summary: `Deleted contractor id ${contractorId}`,
    details: {},
  });
  res.json({ ok: true });
});

app.get("/api/companies", authRequired, (req, res) => {
  const rows = db.prepare("SELECT id, guid, name, created_at FROM companies ORDER BY name ASC").all();
  res.json({ companies: rows });
});

app.post("/api/companies", adminRequired, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Company name is required." });

  const existing = db.prepare("SELECT id FROM companies WHERE lower(name) = lower(?)").get(name);
  if (existing) return res.status(409).json({ error: "Company already exists." });

  const result = db.prepare("INSERT INTO companies (guid, name) VALUES (?, ?)").run(makeGuid(), name);
  writeAuditLog(req, {
    action: "add",
    entityType: "company",
    entityId: result.lastInsertRowid,
    summary: `Created company ${name}`,
    details: { name },
  });
  res.json({ id: result.lastInsertRowid, name });
});

app.patch("/api/companies/:id", adminRequired, (req, res) => {
  const companyId = sanitizeInt(req.params.id, 0);
  if (!companyId) return res.status(400).json({ error: "Invalid company id." });

  const existing = db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId);
  if (!existing) return res.status(404).json({ error: "Company not found." });

  const name = String(req.body.name ?? existing.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Company name is required." });

  const duplicate = db.prepare("SELECT id FROM companies WHERE lower(name) = lower(?) AND id <> ?").get(name, companyId);
  if (duplicate) return res.status(409).json({ error: "Company already exists." });

  db.prepare("UPDATE companies SET name = ? WHERE id = ?").run(name, companyId);
  db.prepare("UPDATE contractors SET company = ? WHERE company_id = ?").run(name, companyId);
  writeAuditLog(req, {
    action: "edit",
    entityType: "company",
    entityId: companyId,
    summary: `Updated company ${existing.name} -> ${name}`,
    details: { from: existing.name, to: name },
  });
  res.json({ ok: true });
});

app.delete("/api/companies/:id", adminRequired, (req, res) => {
  const companyId = sanitizeInt(req.params.id, 0);
  if (!companyId) return res.status(400).json({ error: "Invalid company id." });

  const existing = db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId);
  if (!existing) return res.status(404).json({ error: "Company not found." });

  const inUse = db.prepare("SELECT 1 FROM contractors WHERE company_id = ? LIMIT 1").get(companyId);
  if (inUse) {
    return res.status(400).json({ error: "Company is in use by contractors and cannot be deleted." });
  }

  db.prepare("DELETE FROM companies WHERE id = ?").run(companyId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "company",
    entityId: companyId,
    summary: `Deleted company id ${companyId}`,
    details: {},
  });
  res.json({ ok: true });
});

app.get("/api/locations", authRequired, (req, res) => {
  const rows = db.prepare("SELECT id, guid, name, created_at FROM locations ORDER BY name ASC").all();
  res.json({ locations: rows });
});

app.post("/api/locations", adminRequired, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Location name is required." });

  const existing = db.prepare("SELECT id FROM locations WHERE lower(name) = lower(?)").get(name);
  if (existing) return res.status(409).json({ error: "Location already exists." });

  const result = db.prepare("INSERT INTO locations (guid, name) VALUES (?, ?)").run(makeGuid(), name);
  writeAuditLog(req, {
    action: "add",
    entityType: "location",
    entityId: result.lastInsertRowid,
    summary: `Created location ${name}`,
    details: { name },
  });
  res.json({ id: result.lastInsertRowid, name });
});

app.patch("/api/locations/:id", adminRequired, (req, res) => {
  const locationId = sanitizeInt(req.params.id, 0);
  if (!locationId) return res.status(400).json({ error: "Invalid location id." });

  const existing = db.prepare("SELECT * FROM locations WHERE id = ?").get(locationId);
  if (!existing) return res.status(404).json({ error: "Location not found." });

  const name = String(req.body.name ?? existing.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Location name is required." });

  const duplicate = db.prepare("SELECT id FROM locations WHERE lower(name) = lower(?) AND id <> ?").get(name, locationId);
  if (duplicate) return res.status(409).json({ error: "Location already exists." });

  db.prepare("UPDATE locations SET name = ? WHERE id = ?").run(name, locationId);
  db.prepare("UPDATE movements SET destination = ? WHERE lower(TRIM(destination)) = lower(TRIM(?))").run(name, existing.name);
  writeAuditLog(req, {
    action: "edit",
    entityType: "location",
    entityId: locationId,
    summary: `Updated location ${existing.name} -> ${name}`,
    details: { from: existing.name, to: name },
  });
  res.json({ ok: true });
});

app.delete("/api/locations/:id", adminRequired, (req, res) => {
  const locationId = sanitizeInt(req.params.id, 0);
  if (!locationId) return res.status(400).json({ error: "Invalid location id." });

  const existing = db.prepare("SELECT * FROM locations WHERE id = ?").get(locationId);
  if (!existing) return res.status(404).json({ error: "Location not found." });

  const inUse = db.prepare("SELECT 1 FROM movements WHERE lower(TRIM(destination)) = lower(TRIM(?)) LIMIT 1").get(existing.name);
  if (inUse) {
    return res.status(400).json({ error: "Location is in use by movements and cannot be deleted." });
  }

  db.prepare("DELETE FROM locations WHERE id = ?").run(locationId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "location",
    entityId: locationId,
    summary: `Deleted location id ${locationId}`,
    details: {},
  });
  res.json({ ok: true });
});

app.get("/api/teams", authRequired, (req, res) => {
  const rows = db.prepare("SELECT id, guid, name, created_at FROM teams ORDER BY name ASC").all();
  res.json({ teams: rows });
});

app.post("/api/teams", adminRequired, (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Team name is required." });

  const existing = db.prepare("SELECT id FROM teams WHERE lower(name) = lower(?)").get(name);
  if (existing) return res.status(409).json({ error: "Team already exists." });

  const result = db.prepare("INSERT INTO teams (guid, name) VALUES (?, ?)").run(makeGuid(), name);
  writeAuditLog(req, {
    action: "add",
    entityType: "team",
    entityId: result.lastInsertRowid,
    summary: `Created team ${name}`,
    details: { name },
  });
  res.json({ id: result.lastInsertRowid, name });
});

app.patch("/api/teams/:id", adminRequired, (req, res) => {
  const teamId = sanitizeInt(req.params.id, 0);
  if (!teamId) return res.status(400).json({ error: "Invalid team id." });

  const existing = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);
  if (!existing) return res.status(404).json({ error: "Team not found." });

  const name = String(req.body.name ?? existing.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Team name is required." });

  const duplicate = db.prepare("SELECT id FROM teams WHERE lower(name) = lower(?) AND id <> ?").get(name, teamId);
  if (duplicate) return res.status(409).json({ error: "Team already exists." });

  db.prepare("UPDATE teams SET name = ? WHERE id = ?").run(name, teamId);
  writeAuditLog(req, {
    action: "edit",
    entityType: "team",
    entityId: teamId,
    summary: `Updated team ${existing.name} -> ${name}`,
    details: { from: existing.name, to: name },
  });
  res.json({ ok: true });
});

app.delete("/api/teams/:id", adminRequired, (req, res) => {
  const teamId = sanitizeInt(req.params.id, 0);
  if (!teamId) return res.status(400).json({ error: "Invalid team id." });

  const existing = db.prepare("SELECT * FROM teams WHERE id = ?").get(teamId);
  if (!existing) return res.status(404).json({ error: "Team not found." });

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET team_id = NULL WHERE team_id = ?").run(teamId);
    db.prepare("UPDATE vehicles SET team_id = NULL WHERE team_id = ?").run(teamId);
    db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
  });
  tx();

  writeAuditLog(req, {
    action: "delete",
    entityType: "team",
    entityId: teamId,
    summary: `Deleted team ${existing.name}`,
    details: { name: existing.name },
  });
  res.json({ ok: true });
});

app.get("/api/alerts", authRequired, (req, res) => {
  const user = refreshSessionUserFromDb(req);
  if (!user) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const alerts = getExpiryAlertsForUser(user);
  res.json({ alerts });
});

app.get("/api/notifications", authRequired, (req, res) => {
  const user = refreshSessionUserFromDb(req);
  if (!user) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const notifications = getNotificationsForUser(user);
  const unreadCount = notifications.filter((notification) => !notification.isRead).length;
  res.json({ notifications, unreadCount });
});

app.delete("/api/notifications/:id", authRequired, (req, res) => {
  const notificationId = sanitizeInt(req.params.id, 0);
  if (!notificationId) return res.status(400).json({ error: "Invalid notification id." });

  const result = db.prepare(
    "UPDATE notifications SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
  ).run(notificationId, req.session.user.id);

  if (!result.changes) {
    return res.status(404).json({ error: "Notification not found." });
  }

  res.json({ ok: true });
});

app.post("/api/notifications/:id/read", authRequired, (req, res) => {
  const notificationId = sanitizeInt(req.params.id, 0);
  if (!notificationId) return res.status(400).json({ error: "Invalid notification id." });

  const result = db.prepare(
    "UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND COALESCE(is_deleted, 0) = 0"
  ).run(notificationId, req.session.user.id);

  if (!result.changes) {
    return res.status(404).json({ error: "Notification not found." });
  }

  res.json({ ok: true });
});

app.post("/api/notifications/:id/unread", authRequired, (req, res) => {
  const notificationId = sanitizeInt(req.params.id, 0);
  if (!notificationId) return res.status(400).json({ error: "Invalid notification id." });

  const result = db.prepare(
    "UPDATE notifications SET is_read = 0, read_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND COALESCE(is_deleted, 0) = 0"
  ).run(notificationId, req.session.user.id);

  if (!result.changes) {
    return res.status(404).json({ error: "Notification not found." });
  }

  res.json({ ok: true });
});

app.post("/api/notifications/read-all", authRequired, (req, res) => {
  db.prepare(
    "UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 0 AND COALESCE(is_deleted, 0) = 0"
  ).run(req.session.user.id);
  res.json({ ok: true });
});

app.post("/api/notifications/unread-all", authRequired, (req, res) => {
  db.prepare(
    "UPDATE notifications SET is_read = 0, read_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = 1 AND COALESCE(is_deleted, 0) = 0"
  ).run(req.session.user.id);
  res.json({ ok: true });
});

app.get("/api/audit-logs", adminRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT id, guid, actor_user_id, actor_username, actor_role, action, entity_type, entity_id, summary, details_json, created_at
     FROM audit_logs
     ORDER BY id DESC LIMIT 500`
  ).all();

  const normalized = rows.map((row) => {
    let details = {};
    try {
      details = row.details_json ? JSON.parse(row.details_json) : {};
    } catch (_) {
      details = {};
    }
    return {
      ...row,
      details,
    };
  });

  res.json({ rows: normalized });
});

app.get("/api/reports/vehicle-logs", authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT vl.id, vl.guid, vl.vehicle_id, v.guid AS vehicle_guid, v.plate_no, COALESCE(NULLIF(v.assigned_codename, ''), v.plate_no) AS vehicle_codename, u.guid AS user_guid, u.username, vl.datetime_out, vl.datetime_in, vl.mileage_out, vl.mileage_in, vl.purpose, vl.remarks, vl.fuel_pump_cost, vl.created_at
     FROM vehicle_logs vl
     JOIN vehicles v ON v.id = vl.vehicle_id
     JOIN users u ON u.id = vl.user_id
     ORDER BY vl.id DESC LIMIT 100`
  ).all();

  res.json({ rows });
});

app.get("/api/reports/vehicle-logs/export", adminRequired, (req, res) => {
  const codename = String(req.query.codename || "").trim();
  const params = [];
  let whereClause = "";
  if (codename) {
    whereClause = `WHERE lower(COALESCE(NULLIF(v.assigned_codename, ''), v.plate_no)) LIKE lower(?)`;
    params.push(`%${codename}%`);
  }

  const rows = db.prepare(
    `SELECT vl.id, vl.guid, vl.vehicle_id, v.guid AS vehicle_guid, v.plate_no, v.current_plate, COALESCE(NULLIF(v.assigned_codename, ''), v.plate_no) AS vehicle_codename, u.guid AS user_guid, u.username, vl.datetime_out, vl.datetime_in, vl.mileage_out, vl.mileage_in, vl.purpose, vl.remarks, vl.fuel_pump_cost, vl.created_at
     FROM vehicle_logs vl
     JOIN vehicles v ON v.id = vl.vehicle_id
     JOIN users u ON u.id = vl.user_id
     ${whereClause}
     ORDER BY lower(COALESCE(NULLIF(v.assigned_codename, ''), v.plate_no)) ASC, vl.datetime_out DESC, vl.id DESC`
  ).all(...params);

  res.json({ rows, codename });
});

app.get("/api/reports/petrol-receipts", authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT pr.id, pr.guid, pr.vehicle_id, v.guid AS vehicle_guid, v.plate_no, COALESCE(NULLIF(v.assigned_codename, ''), v.plate_no) AS vehicle_codename, u.guid AS user_guid, u.username, pr.pump_datetime, pr.receipt_number, pr.odometer_at_pump, pr.amount, pr.receipt_image_path, g.guid AS guard_guid, g.username AS guard_username, pr.status, pr.withdrawn_at, wb.username AS withdrawn_by_username, pr.created_at
     FROM petrol_receipts pr
     JOIN vehicles v ON v.id = pr.vehicle_id
     JOIN users u ON u.id = pr.user_id
     JOIN users g ON g.id = pr.guard_id
     LEFT JOIN users wb ON wb.id = pr.withdrawn_by
     ORDER BY pr.id DESC LIMIT 100`
  ).all();

  res.json({ rows });
});

app.get("/api/reports/movements", authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT m.id, m.guid, u.guid AS user_guid, u.username, m.person_type, m.person_name, m.company, m.vehicle, m.destination, m.datetime_out, m.datetime_in, m.remarks, m.created_at
     FROM movements m
     JOIN users u ON u.id = m.user_id
     ORDER BY m.id DESC LIMIT 100`
  ).all();

  res.json({ rows });
});

// Today's officer movement occurrences for an office vehicle codename. Used by
// the Vehicle Log Entry form to reflect the Date/Time Out and In that were
// recorded against the same codename in the movement register.
app.get("/api/movements/today", authRequired, (req, res) => {
  const codename = String(req.query.codename || "").trim();
  if (!codename) return res.json({ occurrences: [] });

  const vehicle = findVehicleByCodename(codename);
  if (!vehicle) return res.json({ occurrences: [] });

  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const rows = db
    .prepare(
      `SELECT id, vehicle, person_name, destination, datetime_out, datetime_in
       FROM movements
       WHERE lower(person_type) = 'officer'
         AND (substr(datetime_out, 1, 10) = ? OR substr(datetime_in, 1, 10) = ?)
       ORDER BY id DESC`
    )
    .all(todayStr, todayStr);

  const occurrences = rows
    .filter((row) => {
      const codenames = parseOfficeVehicleCodenames(row.vehicle);
      return codenames.some((name) => {
        const matched = findVehicleByCodename(name);
        return matched && Number(matched.id) === Number(vehicle.id);
      });
    })
    .map((row) => ({
      movementId: row.id,
      personName: row.person_name || "",
      destination: row.destination || "",
      datetimeOut: row.datetime_out || "",
      datetimeIn: row.datetime_in || "",
    }));

  res.json({ vehicleId: vehicle.id, date: todayStr, occurrences });
});

const DAMAGE_STATUSES = ["Pending Transport IC Actions", "Case Closed"];

function mapDamageRow(row) {
  return {
    id: row.id,
    guid: row.guid,
    reporterUserId: row.reporter_user_id,
    reporterUsername: row.reporter_username || "",
    vehicleId: row.vehicle_id,
    vehicleLabel: row.vehicle_label || row.vehicle_codename || "",
    vehicleCodename: row.vehicle_codename || "",
    plateNo: row.plate_no || "",
    incidentDatetime: row.incident_datetime || "",
    description: row.description || "",
    photoPath: row.photo_path || "",
    photoPaths: parseImagePaths(row.photo_paths, row.photo_path),
    status: row.status || "Pending Transport IC Actions",
    resolutionRemarks: row.resolution_remarks || "",
    resolvedBy: row.resolved_by || null,
    resolvedByUsername: row.resolved_by_username || "",
    resolvedAt: row.resolved_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

app.get("/api/damage-reports", authRequired, (req, res) => {
  const isAdmin = req.session.user && req.session.user.role === "admin";
  const params = [];
  let whereClause = "";
  if (!isAdmin) {
    whereClause = "WHERE dr.reporter_user_id = ?";
    params.push(req.session.user.id);
  }

  const rows = db
    .prepare(
      `SELECT dr.*, u.username AS reporter_username,
              COALESCE(NULLIF(v.assigned_codename, ''), v.plate_no) AS vehicle_codename, v.plate_no,
              ru.username AS resolved_by_username
       FROM damage_reports dr
       JOIN users u ON u.id = dr.reporter_user_id
       LEFT JOIN vehicles v ON v.id = dr.vehicle_id
       LEFT JOIN users ru ON ru.id = dr.resolved_by
       ${whereClause}
       ORDER BY dr.id DESC`
    )
    .all(...params)
    .map(mapDamageRow);

  res.json({ rows });
});

app.post("/api/damage-reports", authRequired, damageUpload, (req, res) => {
  const vehicleLabel = String(req.body.vehicleLabel || "").trim();
  const incidentDatetime = String(req.body.incidentDatetime || "").trim();
  const description = String(req.body.description || "").trim();

  if (!vehicleLabel) return res.status(400).json({ error: "Vehicle is required." });
  if (!incidentDatetime) return res.status(400).json({ error: "Date/Time of damage is required." });
  if (!description) return res.status(400).json({ error: "Damage description is required." });

  const matchedVehicle = findVehicleByCodename(vehicleLabel);
  const vehicleId = matchedVehicle ? matchedVehicle.id : null;
  // Collect every uploaded photo (new multi-file `damagePhotos[]` plus the
  // legacy single `damagePhoto`) into the photo_paths JSON array.
  const damagePhotoFiles = req.files && Array.isArray(req.files.damagePhotos) ? req.files.damagePhotos : [];
  const legacyDamagePhoto = req.files && Array.isArray(req.files.damagePhoto) ? req.files.damagePhoto[0] : null;
  const photoPathList = [];
  for (const file of damagePhotoFiles) photoPathList.push(`/uploads/${file.filename}`);
  if (legacyDamagePhoto) photoPathList.push(`/uploads/${legacyDamagePhoto.filename}`);
  const dedupedPhotoPaths = photoPathList.filter((item, index, all) => item && all.indexOf(item) === index);
  const photoPath = dedupedPhotoPaths[0] || null;
  const photoPathsJson = JSON.stringify(dedupedPhotoPaths);

  const result = db
    .prepare(
      `INSERT INTO damage_reports
        (guid, reporter_user_id, vehicle_id, vehicle_label, incident_datetime, description, photo_path, photo_paths, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      makeGuid(),
      req.session.user.id,
      vehicleId,
      vehicleLabel,
      incidentDatetime,
      description,
      photoPath,
      photoPathsJson,
      "Pending Transport IC Actions"
    );

  writeAuditLog(req, {
    action: "add",
    entityType: "damage_report",
    entityId: result.lastInsertRowid,
    summary: `Reported vehicle damage for ${vehicleLabel}`,
    details: { vehicleLabel, incidentDatetime },
  });

  return res.json({ id: result.lastInsertRowid });
});

app.patch("/api/damage-reports/:id", authRequired, damageUpload, (req, res) => {
  const reportId = sanitizeInt(req.params.id, 0);
  if (!reportId) return res.status(400).json({ error: "Invalid damage report id." });

  const existing = db.prepare("SELECT * FROM damage_reports WHERE id = ?").get(reportId);
  if (!existing) return res.status(404).json({ error: "Damage report not found." });

  const requester = req.session.user;
  const isAdmin = requester && requester.role === "admin";
  const isReporter = requester && existing.reporter_user_id === requester.id;
  if (!isAdmin && !isReporter) {
    return res.status(403).json({ error: "You can only edit your own damage reports." });
  }

  // Only administrators may change the case status / resolution remarks.
  // Reporters keep the existing status untouched.
  let status = existing.status || "Pending Transport IC Actions";
  let resolutionRemarks = normalizeRemarks(existing.resolution_remarks ?? "");
  let resolvedBy = existing.resolved_by || null;
  let resolvedAt = existing.resolved_at || null;
  if (isAdmin) {
    status = String(req.body.status || existing.status || "").trim();
    if (!DAMAGE_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid case status." });
    }
    resolutionRemarks = normalizeRemarks(req.body.resolutionRemarks ?? existing.resolution_remarks ?? "");
    const isClosed = status === "Case Closed";
    resolvedBy = isClosed ? requester.id : null;
    resolvedAt = isClosed ? new Date().toISOString() : null;
  }

  // Full-report edit fields (editing the report details itself). Absent for the
  // inline status/remarks save, in which case the existing values are kept.
  const damagePhotoFiles = req.files && Array.isArray(req.files.damagePhotos) ? req.files.damagePhotos : [];
  const legacyDamagePhoto = req.files && Array.isArray(req.files.damagePhoto) ? req.files.damagePhoto[0] : null;
  const hasNewPhotos = damagePhotoFiles.length > 0 || Boolean(legacyDamagePhoto);
  const isFullEdit = req.body.vehicleLabel != null || req.body.incidentDatetime != null || req.body.description != null || req.body.photoPaths != null || hasNewPhotos;
  let vehicleLabel = existing.vehicle_label;
  let vehicleId = existing.vehicle_id;
  let incidentDatetime = existing.incident_datetime;
  let description = existing.description;
  let photoPath = existing.photo_path;
  let photoPathsJson = existing.photo_paths;
  if (isFullEdit) {
    vehicleLabel = String(req.body.vehicleLabel ?? existing.vehicle_label ?? "").trim();
    incidentDatetime = String(req.body.incidentDatetime ?? existing.incident_datetime ?? "").trim();
    description = String(req.body.description ?? existing.description ?? "").trim();
    if (!vehicleLabel) return res.status(400).json({ error: "Vehicle is required." });
    if (!incidentDatetime) return res.status(400).json({ error: "Date/Time of damage is required." });
    if (!description) return res.status(400).json({ error: "Damage description is required." });
    const matchedVehicle = findVehicleByCodename(vehicleLabel);
    vehicleId = matchedVehicle ? matchedVehicle.id : null;

    // Start from the kept-photo list the client sent (if any), otherwise keep
    // the existing photos, then append any newly uploaded ones.
    const keptPhotos = req.body.photoPaths != null
      ? parseImagePaths(req.body.photoPaths, "")
      : parseImagePaths(existing.photo_paths, existing.photo_path);
    for (const file of damagePhotoFiles) keptPhotos.push(`/uploads/${file.filename}`);
    if (legacyDamagePhoto) keptPhotos.push(`/uploads/${legacyDamagePhoto.filename}`);
    const dedupedPhotos = keptPhotos.filter((item, index, all) => item && all.indexOf(item) === index);
    photoPath = dedupedPhotos[0] || null;
    photoPathsJson = JSON.stringify(dedupedPhotos);
  }

  db.prepare(
    `UPDATE damage_reports
      SET status = ?, resolution_remarks = ?, vehicle_label = ?, vehicle_id = ?, incident_datetime = ?, description = ?, photo_path = ?, photo_paths = ?, resolved_by = ?, resolved_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    status,
    resolutionRemarks,
    vehicleLabel,
    vehicleId,
    incidentDatetime,
    description,
    photoPath,
    photoPathsJson,
    resolvedBy,
    resolvedAt,
    reportId
  );

  writeAuditLog(req, {
    action: "edit",
    entityType: "damage_report",
    entityId: reportId,
    summary: `Updated damage report id ${reportId} to "${status}"`,
    details: { status },
  });

  return res.json({ ok: true });
});

app.delete("/api/damage-reports/:id", authRequired, (req, res) => {
  const reportId = sanitizeInt(req.params.id, 0);
  if (!reportId) return res.status(400).json({ error: "Invalid damage report id." });

  const existing = db.prepare("SELECT * FROM damage_reports WHERE id = ?").get(reportId);
  if (!existing) return res.status(404).json({ error: "Damage report not found." });

  const requester = req.session.user;
  const isAdmin = requester && requester.role === "admin";
  const isReporter = requester && existing.reporter_user_id === requester.id;
  if (!isAdmin && !isReporter) {
    return res.status(403).json({ error: "You can only delete your own damage reports." });
  }

  db.prepare("DELETE FROM damage_reports WHERE id = ?").run(reportId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "damage_report",
    entityId: reportId,
    summary: `Deleted damage report id ${reportId}`,
    details: {},
  });
  return res.json({ ok: true });
});

function mapWashRow(row) {
  return {
    id: row.id,
    guid: row.guid,
    reporterUserId: row.reporter_user_id,
    reporterUsername: row.reporter_username || "",
    vehicleId: row.vehicle_id,
    vehicleLabel: row.vehicle_label || row.vehicle_codename || "",
    vehicleCodename: row.vehicle_codename || "",
    plateNo: row.plate_no || "",
    teamId: row.team_id ?? null,
    washDate: row.wash_date || "",
    remarks: row.remarks || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

app.get("/api/vehicle-washes", authRequired, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT vw.*, u.username AS reporter_username,
              COALESCE(NULLIF(v.assigned_codename, ''), v.plate_no) AS vehicle_codename, v.plate_no
       FROM vehicle_washes vw
       JOIN users u ON u.id = vw.reporter_user_id
       LEFT JOIN vehicles v ON v.id = vw.vehicle_id
       ORDER BY vw.wash_date DESC, vw.id DESC`
    )
    .all()
    .map(mapWashRow);

  res.json({ rows });
});

app.post("/api/vehicle-washes", authRequired, (req, res) => {
  const vehicleLabel = String(req.body.vehicleLabel || "").trim();
  const washDate = String(req.body.washDate || "").trim();
  const remarks = normalizeRemarks(req.body.remarks ?? "");
  const teamId = resolveTeamId(req.body.teamId);

  if (!vehicleLabel) return res.status(400).json({ error: "Vehicle is required." });
  if (!washDate) return res.status(400).json({ error: "Date washed is required." });

  const matchedVehicle = findVehicleByCodename(vehicleLabel);
  const vehicleId = matchedVehicle ? matchedVehicle.id : null;

  const result = db
    .prepare(
      `INSERT INTO vehicle_washes
        (guid, reporter_user_id, vehicle_id, vehicle_label, team_id, wash_date, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(makeGuid(), req.session.user.id, vehicleId, vehicleLabel, teamId, washDate, remarks);

  writeAuditLog(req, {
    action: "add",
    entityType: "vehicle_wash",
    entityId: result.lastInsertRowid,
    summary: `Recorded vehicle wash for ${vehicleLabel} on ${washDate}`,
    details: { vehicleLabel, washDate },
  });

  return res.json({ id: result.lastInsertRowid });
});

app.patch("/api/vehicle-washes/:id", authRequired, (req, res) => {
  const washId = sanitizeInt(req.params.id, 0);
  if (!washId) return res.status(400).json({ error: "Invalid wash record id." });

  const existing = db.prepare("SELECT * FROM vehicle_washes WHERE id = ?").get(washId);
  if (!existing) return res.status(404).json({ error: "Wash record not found." });

  const requester = req.session.user;
  const isAdmin = requester && requester.role === "admin";
  const isReporter = requester && existing.reporter_user_id === requester.id;
  if (!isAdmin && !isReporter) {
    return res.status(403).json({ error: "You can only edit your own wash records." });
  }

  const vehicleLabel = String(req.body.vehicleLabel ?? existing.vehicle_label ?? "").trim();
  const washDate = String(req.body.washDate ?? existing.wash_date ?? "").trim();
  const remarks = normalizeRemarks(req.body.remarks ?? existing.remarks ?? "");
  const teamId = req.body.teamId === undefined ? (existing.team_id ?? null) : resolveTeamId(req.body.teamId);

  if (!vehicleLabel) return res.status(400).json({ error: "Vehicle is required." });
  if (!washDate) return res.status(400).json({ error: "Date washed is required." });

  const matchedVehicle = findVehicleByCodename(vehicleLabel);
  const vehicleId = matchedVehicle ? matchedVehicle.id : null;

  db.prepare(
    `UPDATE vehicle_washes
      SET vehicle_label = ?, vehicle_id = ?, team_id = ?, wash_date = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(vehicleLabel, vehicleId, teamId, washDate, remarks, washId);

  writeAuditLog(req, {
    action: "edit",
    entityType: "vehicle_wash",
    entityId: washId,
    summary: `Updated vehicle wash id ${washId} for ${vehicleLabel}`,
    details: { vehicleLabel, washDate },
  });

  return res.json({ ok: true });
});

app.delete("/api/vehicle-washes/:id", authRequired, (req, res) => {
  const washId = sanitizeInt(req.params.id, 0);
  if (!washId) return res.status(400).json({ error: "Invalid wash record id." });

  const existing = db.prepare("SELECT * FROM vehicle_washes WHERE id = ?").get(washId);
  if (!existing) return res.status(404).json({ error: "Wash record not found." });

  const requester = req.session.user;
  const isAdmin = requester && requester.role === "admin";
  const isReporter = requester && existing.reporter_user_id === requester.id;
  if (!isAdmin && !isReporter) {
    return res.status(403).json({ error: "You can only delete your own wash records." });
  }

  db.prepare("DELETE FROM vehicle_washes WHERE id = ?").run(washId);
  writeAuditLog(req, {
    action: "delete",
    entityType: "vehicle_wash",
    entityId: washId,
    summary: `Deleted vehicle wash id ${washId}`,
    details: {},
  });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Speech-to-text (Ops Transcriber) API
// ---------------------------------------------------------------------------
// Derive a descriptive channel label from filenames such as
// "... Channel 1 - HT-Chat (2).txt", without relying on fixed channel names.
function sttParseChannel(filename) {
  const stem = String(filename || "").replace(/\.[^.]+$/, "");
  const timestampPrefix = /^\s*\d{4}-\d{2}-\d{2}\s+\d{2}[-:]\d{2}[-:]\d{2}(?:_to_\d{2}[-:]\d{2}[-:]\d{2})?\s*/i;
  const label = stem.replace(timestampPrefix, "");
  const suffix = label.replace(/^channel\s*\d+\s*-\s*/i, "").trim();
  return (suffix || label).replace(/\s+/g, " ").trim();
}

function sttMapRaw(row) {
  return {
    id: row.id,
    filename: row.filename,
    content: row.content,
    sourceTimestamp: row.source_timestamp || "",
    createdAt: row.created_at,
  };
}

function sttMapProcessed(row) {
  return {
    id: row.id,
    rawId: row.raw_id,
    filename: row.filename,
    content: row.edited_content != null ? row.edited_content : row.original_content,
    originalContent: row.original_content || "",
    editedContent: row.edited_content || "",
    sourceTimestamp: row.source_timestamp || "",
    channel: sttParseChannel(row.filename),
    source: row.source || "file",
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}

// Pending raw transcriptions (ingested from files, not yet reviewed).
app.get("/api/stt/raw", authRequired, (_req, res) => {
  scanSttInputFolder();
  const rows = db
    .prepare("SELECT * FROM stt_raw WHERE deleted = 0 AND processed = 0 ORDER BY id ASC")
    .all();
  return res.json({ items: rows.map(sttMapRaw) });
});

// Processed transcriptions (Live Transcript view). Date bounds keep large
// transcript histories from being downloaded and rendered on every refresh.
app.get("/api/stt/processed", authRequired, (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "")) ? String(req.query.from) : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || "")) ? String(req.query.to) : "";
  const conditions = [];
  const params = [];
  const timestampColumn = "COALESCE(NULLIF(source_timestamp, ''), processed_at)";

  if (from) {
    conditions.push(`${timestampColumn} >= ?`);
    params.push(from);
  }
  if (to) {
    conditions.push(`${timestampColumn} < ?`);
    params.push(`${to}T24:00:00`);
  }

  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM stt_processed${where} ORDER BY id DESC`)
    .all(...params);
  return res.json({ items: rows.map(sttMapProcessed) });
});

// Manually trigger a folder scan.
app.post("/api/stt/scan", authRequired, (_req, res) => {
  const ingested = scanSttInputFolder();
  return res.json({ ok: true, ingested });
});

// Save a raw entry into processed (optionally edited), then mark raw processed.
app.post("/api/stt/raw/:id/save", authRequired, (req, res) => {
  const rawId = sanitizeInt(req.params.id, 0);
  if (rawId <= 0) return res.status(400).json({ error: "Invalid id." });
  const raw = db.prepare("SELECT * FROM stt_raw WHERE id = ? AND deleted = 0").get(rawId);
  if (!raw) return res.status(404).json({ error: "Raw transcription not found." });

  const edited = typeof req.body.editedContent === "string" ? req.body.editedContent : raw.content;
  const info = db
    .prepare(
      `INSERT INTO stt_processed (raw_id, filename, original_content, edited_content, source_timestamp, source)
       VALUES (?, ?, ?, ?, ?, 'file')`
    )
    .run(rawId, raw.filename, raw.content, edited, raw.source_timestamp || "");
  db.prepare("UPDATE stt_raw SET processed = 1 WHERE id = ?").run(rawId);

  const row = db.prepare("SELECT * FROM stt_processed WHERE id = ?").get(info.lastInsertRowid);
  return res.json({ ok: true, item: sttMapProcessed(row) });
});

// Discard a raw entry (soft delete so the file is not re-ingested).
app.post("/api/stt/raw/:id/delete", authRequired, (req, res) => {
  const rawId = sanitizeInt(req.params.id, 0);
  if (rawId <= 0) return res.status(400).json({ error: "Invalid id." });
  const info = db.prepare("UPDATE stt_raw SET deleted = 1 WHERE id = ?").run(rawId);
  if (info.changes === 0) return res.status(404).json({ error: "Raw transcription not found." });
  return res.json({ ok: true });
});

// Live-direct routing: when on, newly transcribed files skip Raw and appear in
// the Live Transcript view. Starting it also ensures auto-transcribe is on.
app.get("/api/stt/live/mode", authRequired, (_req, res) => {
  return res.json({
    active: String(getSttSetting("liveDirect")) === "1",
    autoTranscribe: String(getSttSetting("autoTranscribe")) === "1",
  });
});
app.post("/api/stt/live/mode", authRequired, (req, res) => {
  const active = req.body.active === true || req.body.active === "1";
  setSttSetting("liveDirect", active ? "1" : "0");
  if (active) {
    setSttSetting("autoTranscribe", "1");
    sttDiscoverAudioFiles();
    sttProcessNextAudio().catch(() => {});
  }
  return res.json({ ok: true, active });
});

// Edit a processed entry.
app.patch("/api/stt/processed/:id", authRequired, (req, res) => {
  const id = sanitizeInt(req.params.id, 0);
  if (id <= 0) return res.status(400).json({ error: "Invalid id." });
  if (typeof req.body.editedContent !== "string") {
    return res.status(400).json({ error: "editedContent is required." });
  }
  const info = db
    .prepare("UPDATE stt_processed SET edited_content = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.body.editedContent, id);
  if (info.changes === 0) return res.status(404).json({ error: "Entry not found." });
  const row = db.prepare("SELECT * FROM stt_processed WHERE id = ?").get(id);
  return res.json({ ok: true, item: sttMapProcessed(row) });
});

// Delete a processed entry.
app.delete("/api/stt/processed/:id", authRequired, (req, res) => {
  const id = sanitizeInt(req.params.id, 0);
  if (id <= 0) return res.status(400).json({ error: "Invalid id." });
  const info = db.prepare("DELETE FROM stt_processed WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).json({ error: "Entry not found." });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Speech-to-text AI (proxied to the offline Python GPT4All microservice)
// ---------------------------------------------------------------------------
const sttAiUrl = (process.env.STT_AI_URL || "http://127.0.0.1:8756").replace(/\/+$/, "");
const sttAiOfflineHint =
  "AI service is not reachable. Start it by running \"run-ai-service.bat\" (or \"python ai_service.py\") in the Ops Transcriber folder.";
const knowledgeTextExtensions = new Set([".doc", ".docx", ".pdf", ".txt", ".md", ".csv", ".json"]);
const knowledgeImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const knowledgeMimeTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

function knowledgeMimeType(filename, reportedMimeType) {
  const reported = String(reportedMimeType || "").trim().toLowerCase();
  if (reported && reported !== "application/octet-stream") return reported;
  return knowledgeMimeTypes[path.extname(String(filename || "")).toLowerCase()] || "application/octet-stream";
}

function sttKnowledgeUserId(req) {
  return req.session && req.session.user && Number.isInteger(req.session.user.id)
    ? req.session.user.id
    : 0;
}

async function readKnowledgeDocument(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".doc" || extension === ".docx") {
    return readLogsAssistantDocument(filePath);
  }
  if (extension === ".pdf") {
    const python = process.env.AI_PYTHON ||
      (process.platform === "win32" && fs.existsSync(path.join(baseDir, ".venv", "Scripts", "python.exe"))
        ? path.join(baseDir, ".venv", "Scripts", "python.exe")
        : "python");
    return new Promise((resolve, reject) => {
      execFile(
        python,
        [path.join(baseDir, "document_reader.py"), filePath],
        { maxBuffer: 1024 * 1024, timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || error.message || "PDF extraction failed.").trim()));
            return;
          }
          try {
            const result = JSON.parse(stdout);
            if (!result.ok) throw new Error(result.error || "PDF extraction failed.");
            resolve(String(result.content || ""));
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    });
  }
  return fs.readFileSync(filePath, "utf8");
}

function selectKnowledgeEvidence(documents, question) {
  const terms = new Set((String(question || "").toLowerCase().match(/[a-z0-9]{2,}/g) || [])
    .filter((term) => !new Set(["about", "from", "have", "that", "this", "what", "when", "where", "which", "with", "would", "your"]).has(term)));
  const matches = [];
  for (const document of documents) {
    const content = String(document.content || "").trim();
    if (!content) continue;
    const chunks = content.match(/[\s\S]{1,1600}(?:\n|$)/g) || [content];
    for (const chunk of chunks) {
      const normalized = chunk.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (normalized.includes(term)) score += 1;
      }
      matches.push({ id: document.id, filename: document.original_name, content: chunk.trim(), score });
    }
  }
  return matches
    .sort((left, right) => right.score - left.score || left.filename.localeCompare(right.filename))
    .slice(0, 8);
}
const logsAssistantExtensions = new Set([".doc", ".docx", ".txt", ".md", ".csv", ".json"]);
const logsAssistantCache = {
  folder: "",
  scannedAt: 0,
  documents: [],
  skippedFiles: [],
  files: new Map(),
};

function normalizeLogsAssistantFolder(folder) {
  const requested = String(folder || "").trim();
  if (path.sep === "/") {
    const uncMatch = /^\\\\[^\\/]+\\web(?:\\|\/)?(.*)$/i.exec(requested);
    if (uncMatch) return path.join("/volume1/web", uncMatch[1].replace(/\\/g, "/"));
  }
  return requested;
}

async function readLogsAssistantDocument(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".doc") {
    let WordExtractor;
    try {
      WordExtractor = require("word-extractor");
    } catch (_) {
      throw new Error("DOC support is not installed. Run npm install on the server, then restart it.");
    }
    const document = await new WordExtractor().extract(filePath);
    return String(document.getBody() || "");
  }
  if (extension === ".docx") {
    let mammoth;
    try {
      mammoth = require("mammoth");
    } catch (_) {
      throw new Error("DOCX support is not installed. Run npm install on the NAS, then restart the server.");
    }
    const result = await mammoth.extractRawText({ path: filePath });
    return String(result.value || "");
  }
  return fs.readFileSync(filePath, "utf8");
}

async function scanLogsAssistantFolder(folder, force = false) {
  const requestedFolder = normalizeLogsAssistantFolder(folder);
  if (!requestedFolder) {
    throw new Error("Choose a readable reports folder first.");
  }
  const root = path.resolve(requestedFolder);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("Choose a readable reports folder first.");
  }
  if (!force && logsAssistantCache.folder === root && Date.now() - logsAssistantCache.scannedAt < 60 * 1000) {
    return logsAssistantCache;
  }

  const documents = [];
  const skippedFiles = [];
  const nextFiles = new Map();
  const seenPaths = new Set();
  const pendingFiles = [];
  const cachedDocument = db.prepare(
    "SELECT file_size, file_mtime_ms, content FROM stt_report_documents WHERE folder = ? AND relative_path = ?"
  );
  const saveDocument = db.prepare(
    `INSERT INTO stt_report_documents (folder, relative_path, file_size, file_mtime_ms, content)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(folder, relative_path) DO UPDATE SET
       file_size = excluded.file_size,
       file_mtime_ms = excluded.file_mtime_ms,
       content = excluded.content,
       scanned_at = CURRENT_TIMESTAMP`
  );
  const folders = [root];
  while (folders.length) {
    const current = folders.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        folders.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !logsAssistantExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const relativePath = path.relative(root, fullPath);
      seenPaths.add(relativePath);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 5 * 1024 * 1024) {
          skippedFiles.push(relativePath + " (over 5 MB)");
          continue;
        }
        const fingerprint = stat.size + ":" + stat.mtimeMs;
        const cached = cachedDocument.get(root, relativePath);
        let content = cached && Number(cached.file_size) === stat.size && Number(cached.file_mtime_ms) === stat.mtimeMs
          ? cached.content
          : null;
        if (content === null) {
          pendingFiles.push({ fullPath, relativePath, stat, cached });
          continue;
        }
        if (!content) {
          skippedFiles.push(relativePath + " (empty)");
          continue;
        }
        const storedContent = content.slice(0, 60000);
        if (!cached || Number(cached.file_size) !== stat.size || Number(cached.file_mtime_ms) !== stat.mtimeMs) {
          saveDocument.run(root, relativePath, stat.size, stat.mtimeMs, storedContent);
        }
        nextFiles.set(relativePath, { fingerprint, content: storedContent });
        documents.push({ filename: relativePath, fullPath, content: storedContent, mtimeMs: stat.mtimeMs });
      } catch (error) {
        skippedFiles.push(
          relativePath + " (" + String(error && error.message ? error.message : "unreadable") + ")"
        );
      }
    }
  }
  const processPendingFile = async ({ fullPath, relativePath, stat, cached }) => {
    try {
      const content = (await readLogsAssistantDocument(fullPath))
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!content) {
        skippedFiles.push(relativePath + " (empty)");
        return;
      }
      const storedContent = content.slice(0, 60000);
      saveDocument.run(root, relativePath, stat.size, stat.mtimeMs, storedContent);
      nextFiles.set(relativePath, { fingerprint: stat.size + ":" + stat.mtimeMs, content: storedContent });
      documents.push({ filename: relativePath, fullPath, content: storedContent, mtimeMs: stat.mtimeMs });
    } catch (error) {
      skippedFiles.push(relativePath + " (" + String(error && error.message ? error.message : "unreadable") + ")");
    }
  };
  const workerCount = Math.min(4, Math.max(1, pendingFiles.length));
  let pendingIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (pendingIndex < pendingFiles.length) {
      const currentIndex = pendingIndex++;
      await processPendingFile(pendingFiles[currentIndex]);
    }
  }));
  const storedPaths = db.prepare("SELECT relative_path FROM stt_report_documents WHERE folder = ?").all(root);
  const deleteDocument = db.prepare("DELETE FROM stt_report_documents WHERE folder = ? AND relative_path = ?");
  for (const row of storedPaths) {
    if (!seenPaths.has(row.relative_path)) deleteDocument.run(root, row.relative_path);
  }
  logsAssistantCache.folder = root;
  logsAssistantCache.scannedAt = Date.now();
  logsAssistantCache.documents = documents;
  logsAssistantCache.skippedFiles = skippedFiles;
  logsAssistantCache.files = nextFiles;
  return logsAssistantCache;
}

function selectLogsAssistantEvidence(documents, query) {
  const searchText = String(query || "").trim();
  const words = searchText.match(/[a-z0-9]+/gi) || [];
  if (!words.length) return [];
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dateMatch = /^(\d{1,2})[\s/._-]+(\d{1,2})[\s/._-]+(\d{2}|\d{4})$/.exec(searchText);
  const dateYearPattern = dateMatch
    ? (dateMatch[3].length === 2 ? "(?:20)?" + dateMatch[3] : "(?:" + dateMatch[3] + "|" + dateMatch[3].slice(-2) + ")")
    : "";
  const phrasePattern = dateMatch
    ? new RegExp(
      "\\b0?" + Number(dateMatch[1]) + "[\\s/._-]+0?" + Number(dateMatch[2]) +
      "[\\s/._-]+" + dateYearPattern + "\\b",
      "gi"
    )
    : new RegExp("\\b" + words.map(escapeRegex).join("\\s+") + "\\b", "gi");
  const matches = [];
  for (const document of documents) {
    const paragraphs = String(document.content || "")
      .split(/\n\s*\n|\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    for (const paragraph of paragraphs) {
      const score = (paragraph.match(phrasePattern) || []).length;
      if (score > 0) {
        matches.push({
          filename: document.filename,
          fullPath: document.fullPath || "",
          paragraph,
          score,
          mtimeMs: document.mtimeMs || 0,
        });
      }
    }
  }
  // Newest reports first (e.g. 2026 above 2025), relevance score as tie-breaker.
  return matches
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.score - left.score || left.filename.localeCompare(right.filename))
    .slice(0, 100)
    .map(({ filename, fullPath, paragraph }) => ({ filename, fullPath, paragraph }));
}

function isMapAnnotationRequest(prompt) {
  return /\b(plot|mark|annotate|pin|locate|show)\b.*\b(map|image|diagram|plan|point|location|route)\b|\b(evacuation|assembly)\s+point\b/i.test(
    String(prompt || "")
  );
}

async function sttAiRequest(routePath, payload, method, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
  try {
    const res = await fetch(sttAiUrl + routePath, {
      method: method || "POST",
      headers: { "Content-Type": "application/json" },
      body: (method || "POST") === "GET" ? undefined : JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/stt/ai/health", authRequired, async (_req, res) => {
  try {
    const r = await sttAiRequest("/health", null, "GET", 5000);
    if (r.data && Object.keys(r.data).length) return res.json(r.data);
    return res.json({ ok: false, ready: false, status: "AI service offline." });
  } catch (_) {
    return res.json({ ok: false, ready: false, status: sttAiOfflineHint });
  }
});

// General offline Q&A.
app.post("/api/stt/ai/general", authRequired, async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt is required." });
  const history = Array.isArray(req.body.history)
    ? req.body.history.slice(-6).map((turn) => ({
      prompt: String((turn && turn.prompt) || "").slice(0, 4000),
      answer: String((turn && turn.answer) || "").slice(0, 4000),
    }))
    : [];
  const mode = req.body.mode === "rewrite" ? "rewrite" : "chat";
  try {
    const r = await sttAiRequest("/ask_general", { prompt, history, mode });
    if (!r.ok) return res.status(502).json({ error: (r.data && r.data.error) || "AI service error." });
    return res.json(r.data);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

app.get("/api/stt/ai/knowledge", authRequired, (req, res) => {
  const documents = db.prepare(
    `SELECT id, original_name, mime_type, is_image, created_at
     FROM stt_knowledge_documents WHERE user_id = ? ORDER BY id DESC`
  ).all(sttKnowledgeUserId(req));
  return res.json({ documents });
});

app.post("/api/stt/ai/knowledge/upload", authRequired, (req, res) => {
  knowledgeUpload(req, res, async (uploadError) => {
    if (uploadError) return res.status(400).json({ error: uploadError.message });
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: "Choose at least one supported document or image." });

    const insert = db.prepare(
      `INSERT INTO stt_knowledge_documents
       (user_id, original_name, stored_name, mime_type, content, is_image)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const uploaded = [];
    try {
      for (const file of files) {
        const extension = path.extname(file.originalname || "").toLowerCase();
        const isImage = knowledgeImageExtensions.has(extension);
        const content = isImage ? "" : (await readKnowledgeDocument(file.path)).slice(0, 60000);
        if (!isImage && !content.trim()) throw new Error(`No readable text found in ${file.originalname}.`);
        const result = insert.run(
          sttKnowledgeUserId(req),
          path.basename(file.originalname || file.filename),
          file.filename,
          knowledgeMimeType(file.originalname, file.mimetype),
          content,
          isImage ? 1 : 0
        );
        uploaded.push({ id: result.lastInsertRowid, name: file.originalname, isImage });
      }
    } catch (error) {
      for (const document of uploaded) {
        db.prepare("DELETE FROM stt_knowledge_documents WHERE id = ?").run(document.id);
      }
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch (_) {}
      }
      return res.status(400).json({ error: error.message || "Could not ingest the uploaded file." });
    }
    return res.status(201).json({ documents: uploaded });
  });
});

app.delete("/api/stt/ai/knowledge/:id", authRequired, (req, res) => {
  const id = sanitizeInt(req.params.id, 0);
  const document = db.prepare(
    "SELECT * FROM stt_knowledge_documents WHERE id = ? AND user_id = ?"
  ).get(id, sttKnowledgeUserId(req));
  if (!document) return res.status(404).json({ error: "Knowledge document not found." });
  db.prepare("DELETE FROM stt_knowledge_documents WHERE id = ?").run(id);
  try { fs.unlinkSync(path.join(knowledgeUploadsDir, document.stored_name)); } catch (_) {}
  return res.json({ ok: true });
});

app.get("/api/stt/ai/knowledge/:id/image", authRequired, (req, res) => {
  const id = sanitizeInt(req.params.id, 0);
  const document = db.prepare(
    "SELECT * FROM stt_knowledge_documents WHERE id = ? AND user_id = ? AND is_image = 1"
  ).get(id, sttKnowledgeUserId(req));
  if (!document) return res.status(404).json({ error: "Knowledge image not found." });
  const imagePath = path.join(knowledgeUploadsDir, document.stored_name);
  if (!fs.existsSync(imagePath)) return res.status(404).json({ error: "Knowledge image file is missing." });
  return res.type(knowledgeMimeType(document.original_name, document.mime_type)).sendFile(imagePath);
});

app.post("/api/stt/ai/knowledge/ask", authRequired, async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt is required." });
  const ids = Array.isArray(req.body.documentIds)
    ? [...new Set(req.body.documentIds.map((id) => sanitizeInt(id, 0)).filter((id) => id > 0))].slice(0, 20)
    : [];
  if (!ids.length) return res.status(400).json({ error: "Select at least one ingested document or image." });
  const placeholders = ids.map(() => "?").join(",");
  const documents = db.prepare(
    `SELECT * FROM stt_knowledge_documents WHERE user_id = ? AND id IN (${placeholders})`
  ).all(sttKnowledgeUserId(req), ...ids);
  if (!documents.length) return res.status(404).json({ error: "Selected knowledge documents are no longer available." });

  const imageDocuments = documents.filter((document) => document.is_image);
  const images = imageDocuments.map((document) => ({
      filename: document.original_name,
      id: document.id,
      mimeType: knowledgeMimeType(document.original_name, document.mime_type),
      data: fs.readFileSync(path.join(knowledgeUploadsDir, document.stored_name)).toString("base64"),
    }));
  const textDocuments = documents.filter((document) => !document.is_image);
  const evidence = selectKnowledgeEvidence(textDocuments, prompt)
    .slice(0, images.length ? 3 : 8)
    .map((item) => ({
      ...item,
      content: item.content.slice(0, images.length ? 1000 : 1600),
    }));
  try {
    const r = await sttAiRequest("/ask_documents", {
      prompt,
      evidence,
      images,
      annotationRequest: images.length > 0 && isMapAnnotationRequest(prompt),
      groundedAnalysis: images.length > 0,
    });
    if (!r.ok) return res.status(502).json({ error: (r.data && r.data.error) || "AI service error." });
    const marker = r.data && r.data.marker;
    if (marker && images.length) {
      r.data.annotation = { ...marker, documentId: images[0].id };
    }
    return res.json(r.data);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

// Q&A grounded in the processed transcripts (Live Transcript view content).
app.post("/api/stt/ai/logs", authRequired, async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt is required." });
  const rows = db.prepare("SELECT * FROM stt_processed ORDER BY id ASC").all();
  const logs = rows.map((row) => ({
    filename: row.filename,
    edited_content: row.edited_content != null ? row.edited_content : row.original_content,
    content: row.original_content || "",
    source_timestamp: row.source_timestamp || "",
    processed_at: row.processed_at || "",
  }));
  try {
    const r = await sttAiRequest("/ask_logs", { prompt, logs });
    if (!r.ok) return res.status(502).json({ error: (r.data && r.data.error) || "AI service error." });
    return res.json(r.data);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

// Q&A grounded only in the curated Relevant SO Report Entries.
app.post("/api/stt/ai/sodraft", authRequired, async (req, res) => {
  const prompt = String(req.body.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt is required." });
  let logs = [];
  // If the client sends the currently filtered Key SO Occurences list, use it
  // instead of scanning all DB entries.
  if (Array.isArray(req.body.logs)) {
    logs = req.body.logs.map((item) => ({
      filename: String((item && item.filename) || ""),
      edited_content: String((item && (item.edited_content || item.content || item.movements)) || "").trim(),
      content: String((item && (item.content || item.edited_content || item.movements)) || "").trim(),
      source_timestamp: String((item && (item.source_timestamp || item.sourceTimestamp || item.time)) || ""),
      processed_at: String((item && (item.processed_at || item.source_timestamp || item.sourceTimestamp || item.time)) || ""),
    })).filter((item) => item.edited_content);
  } else if (Array.isArray(req.body.entries)) {
    logs = req.body.entries.map((item) => ({
      filename: String((item && item.filename) || ""),
      edited_content: String((item && item.content) || "").trim(),
      content: String((item && item.content) || "").trim(),
      source_timestamp: String((item && (item.sourceTimestamp || item.source_timestamp || item.time)) || ""),
      processed_at: String((item && (item.sourceTimestamp || item.source_timestamp || item.time)) || ""),
    })).filter((item) => item.edited_content);
  }
  if (!logs.length) {
    return res.status(400).json({ error: "No Key SO Occurrences are currently displayed. Adjust the date filter or add an occurrence first." });
  }
  try {
    const r = await sttAiRequest("/ask_logs", { prompt, logs }, "POST", 600000);
    if (!r.ok) return res.status(502).json({ error: (r.data && r.data.error) || "AI service error." });
    return res.json(r.data);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

app.post("/api/stt/logs-assistant/scan", authRequired, async (req, res) => {
  const folder = String((req.body && req.body.folder) || getSttSetting("logsAssistantFolder") || "").trim();
  try {
    const index = await scanLogsAssistantFolder(folder, true);
    setSttSetting("logsAssistantFolder", index.folder);
    return res.json({
      folder: index.folder,
      documentCount: index.documents.length,
      skippedFiles: index.skippedFiles,
      files: index.documents.map((document) => document.filename),
    });
  } catch (error) {
    return res.status(400).json({ error: error && error.message ? error.message : "Could not scan the reports folder." });
  }
});

app.post("/api/stt/logs-assistant/ask", authRequired, async (req, res) => {
  const keywords = String(req.body && req.body.keywords || "").trim();
  const folder = String((req.body && req.body.folder) || getSttSetting("logsAssistantFolder") || "").trim();
  if (!keywords) return res.status(400).json({ error: "Enter one or more keywords first." });
  try {
    const index = await scanLogsAssistantFolder(folder);
    const matches = selectLogsAssistantEvidence(index.documents, keywords);
    return res.json({ matches, count: matches.length, keywords });
  } catch (error) {
    return res.status(400).json({ error: error && error.message ? error.message : "Could not read the reports folder." });
  }
});

// Open a scanned report file with the host machine's default application.
app.post("/api/stt/logs-assistant/open", authRequired, async (req, res) => {
  const explicitPath = String((req.body && req.body.path) || "").trim();
  const folder = String((req.body && req.body.folder) || getSttSetting("logsAssistantFolder") || "").trim();
  const filename = String((req.body && req.body.filename) || "").trim();
  if (!explicitPath && !filename) return res.status(400).json({ error: "filename is required." });
  try {
    let target;
    if (explicitPath) {
      // Full path already resolved at scan time — no folder reconstruction,
      // so it can't drift from whatever the folder field currently shows.
      target = path.resolve(explicitPath);
      if (!logsAssistantExtensions.has(path.extname(target).toLowerCase())) {
        return res.status(400).json({ error: "Unsupported file type." });
      }
    } else {
      const root = path.resolve(normalizeLogsAssistantFolder(folder));
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return res.status(400).json({ error: "Choose a readable reports folder first." });
      }
      target = path.resolve(root, filename);
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (!target.startsWith(rootWithSep)) {
        return res.status(400).json({ error: "Invalid file path." });
      }
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ error: "File not found." });
    }
    const platform = process.platform;
    if (platform === "win32") {
      // Windows blocks background processes from stealing focus, so if the
      // file is already open, plain ShellExecute (explorer.exe) silently
      // no-ops instead of visibly popping the window up. Bring an existing
      // window to the foreground (Alt-tap trick to satisfy the foreground
      // lock) instead, and only launch fresh when nothing is open yet.
      const psScript = [
        "Add-Type -Namespace Win32 -Name Native -MemberDefinition '",
        "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
        "[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
        "[DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
        "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);",
        "' -ErrorAction SilentlyContinue",
        "$path = $env:STT_OPEN_TARGET",
        "$name = [System.IO.Path]::GetFileNameWithoutExtension($path)",
        "$existing = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like ('*' + $name + '*') } | Select-Object -First 1",
        "if ($existing) {",
        "  if ([Win32.Native]::IsIconic($existing.MainWindowHandle)) { [Win32.Native]::ShowWindowAsync($existing.MainWindowHandle, 9) | Out-Null }",
        "  [Win32.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)",
        "  [Win32.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)",
        "  [Win32.Native]::SetForegroundWindow($existing.MainWindowHandle) | Out-Null",
        "} else {",
        "  Start-Process -FilePath $path",
        "}",
      ].join("\n");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
        { env: Object.assign({}, process.env, { STT_OPEN_TARGET: target }) },
        (error) => {
          if (error) console.error("[logs-assistant] open failed:", error.message);
        }
      );
      return res.json({ ok: true });
    }
    if (platform === "darwin") {
      execFile("open", [target], (error) => {
        if (error) console.error("[logs-assistant] open failed:", error.message);
      });
      return res.json({ ok: true });
    }
    // Headless server (e.g. the Synology NAS this app is also deployed to)
    // has no desktop/Word to open a file with. Hand back a GET URL instead of
    // streaming the bytes here: a real browser navigation lets the browser's
    // own download manager do the transfer, so completion (file fully written
    // to disk, not still a .crdownload/.tmp) is reported accurately — a
    // manual fetch+Blob in page JS can only ever know when OUR code finished
    // reading the response, not when the OS finished writing the file.
    const downloadUrl = "/api/stt/logs-assistant/download?path=" + encodeURIComponent(target);
    return res.json({ ok: true, download: true, downloadUrl });
  } catch (error) {
    return res.status(400).json({ error: error && error.message ? error.message : "Could not open the file." });
  }
});

// GET counterpart to /open's headless-download fallback: a plain browser
// navigation (not a fetch call) so the browser's native download manager
// handles the transfer, giving an accurate completion signal. Auth via
// session, bearer/x-auth-token header, or a `token` query param (mirrors
// /api/stt/audio/file) since a real navigation can't set custom headers.
app.get("/api/stt/logs-assistant/download", (req, res) => {
  let authed = sttStandalone || Boolean(req.session && req.session.user);
  if (!authed) {
    const authHeader = String(req.headers.authorization || "");
    const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const headerToken = String(req.headers["x-auth-token"] || "").trim();
    const queryToken = String(req.query.token || "").trim();
    const token = bearerToken || headerToken || queryToken;
    if (token && tokenStore.get(token)) authed = true;
  }
  if (!authed) return res.status(401).json({ error: "Authentication required." });

  const target = path.resolve(String(req.query.path || "").trim());
  if (!logsAssistantExtensions.has(path.extname(target).toLowerCase())) {
    return res.status(400).json({ error: "Unsupported file type." });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: "File not found." });
  }
  return res.download(target, path.basename(target));
});

// ---------------------------------------------------------------------------
// STT settings (folders, model, code-name map, auto-transcribe)
// ---------------------------------------------------------------------------
app.get("/api/stt/settings", authRequired, (_req, res) => {
  const s = getSttSettings();
  let codeNames = [];
  try { codeNames = JSON.parse(s.codeNames || "[]"); } catch (_) { codeNames = []; }
  return res.json({
    audioFolder1: s.audioFolder1,
    audioFolder2: s.audioFolder2,
    outputFolder: s.outputFolder,
    outputFolderEffective: sttOutputDir(),
    whisperModel: s.whisperModel,
    logsAssistantFolder: s.logsAssistantFolder,
    codeNames: Array.isArray(codeNames) ? codeNames : [],
    autoTranscribe: String(s.autoTranscribe) === "1",
  });
});

app.put("/api/stt/settings", authRequired, (req, res) => {
  const b = req.body || {};
  if (typeof b.audioFolder1 === "string") setSttSetting("audioFolder1", b.audioFolder1.trim());
  if (typeof b.audioFolder2 === "string") setSttSetting("audioFolder2", b.audioFolder2.trim());
  if (typeof b.outputFolder === "string") setSttSetting("outputFolder", b.outputFolder.trim());
  if (typeof b.whisperModel === "string" && b.whisperModel.trim()) setSttSetting("whisperModel", b.whisperModel.trim());
  if (typeof b.logsAssistantFolder === "string") setSttSetting("logsAssistantFolder", b.logsAssistantFolder.trim());
  if (Array.isArray(b.codeNames)) {
    const clean = b.codeNames
      .map((p) => ({ from: String(p.from || "").trim(), to: String(p.to || "").trim() }))
      .filter((p) => p.from && p.to);
    setSttSetting("codeNames", JSON.stringify(clean));
  }
  if (typeof b.autoTranscribe === "boolean") setSttSetting("autoTranscribe", b.autoTranscribe ? "1" : "0");
  return res.json({ ok: true });
});

// Server-side folder browser for the Settings "Browse" buttons. Lists the
// sub-directories of the given path (or the drive/root list when empty) so the
// user can pick a real server path without typing it. Read-only, dirs only.
app.get("/api/stt/browse", authRequired, (req, res) => {
  const isWin = process.platform === "win32";
  const raw = typeof req.query.path === "string" ? req.query.path.trim() : "";
  try {
    // No path yet: show drive letters (Windows) or filesystem root (Linux/mac).
    if (!raw) {
      if (isWin) {
        const drives = [];
        for (let c = 65; c <= 90; c += 1) {
          const d = String.fromCharCode(c) + ":\\";
          if (fs.existsSync(d)) drives.push({ name: d, path: d });
        }
        return res.json({ platform: process.platform, path: "", parent: null, isRoot: true, folders: drives });
      }
    }
    const current = path.resolve(raw || "/");
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
      return res.status(400).json({ error: "Not a folder: " + current });
    }
    let folders = [];
    try {
      folders = fs
        .readdirSync(current, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(current, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) {
      return res.status(403).json({ error: "Cannot read folder (permission denied)." });
    }
    // Parent: null when at a Windows drive root or the filesystem root.
    const parentPath = path.dirname(current);
    const atRoot = parentPath === current;
    return res.json({
      platform: process.platform,
      path: current,
      parent: atRoot ? (isWin ? "" : null) : parentPath,
      isRoot: false,
      folders,
    });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
});

// Background audio-transcription queue status.
app.get("/api/stt/audio/status", authRequired, (_req, res) => {
  const rows = db
    .prepare("SELECT filename, status, message, created_at FROM stt_audio_seen ORDER BY created_at DESC LIMIT 50")
    .all();
  const counts = db
    .prepare("SELECT status, COUNT(*) AS n FROM stt_audio_seen GROUP BY status")
    .all()
    .reduce((acc, r) => { acc[r.status] = r.n; return acc; }, {});
  // If another machine is transcribing and dropping results into our output
  // folder, surface its live progress so this portal can display it too.
  let remote = null;
  try {
    const f = path.join(sttOutputDir(), "_transcription_status.json");
    if (fs.existsSync(f)) {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
      if (parsed && parsed.source && parsed.source !== os.hostname()) remote = parsed;
    }
  } catch (_) {
    /* ignore a missing/partial status file */
  }
  return res.json({
    autoTranscribe: String(getSttSetting("autoTranscribe")) === "1",
    transcribing: sttTranscribing,
    counts,
    items: rows,
    remote,
  });
});

// Force a rescan of the audio folders now.
app.post("/api/stt/audio/rescan", authRequired, async (req, res) => {
  const folderNumber = String((req.body && req.body.folder) || "");
  if (folderNumber !== "1" && folderNumber !== "2") {
    return res.status(400).json({ error: "Choose audio input folder 1 or 2 to rescan." });
  }
  const folder = String(getSttSetting(`audioFolder${folderNumber}`) || "").trim();
  if (!folder) return res.status(400).json({ error: `Audio input folder ${folderNumber} is not configured.` });
  const discovery = await sttDiscoverAudioFiles({ recursive: true, scanFolders: [folder] });
  sttProcessNextAudio().catch(() => {});
  const pending = db.prepare("SELECT COUNT(*) AS n FROM stt_audio_seen WHERE status = 'pending'").get();
  return res.json({
    ok: true,
    scanned: discovery ? discovery.scanned : 0,
    queued: discovery ? discovery.queued : 0,
    requeued: discovery ? discovery.requeued : 0,
    folder,
    pending: pending ? pending.n : 0,
  });
});

// Stream a source audio file for playback in the Live Transcript view. Accepts
// the processed row's filename (with or without extension) and locates the
// matching audio file inside the configured input folders. Auth via session,
// bearer/x-auth-token header, or a `token` query param so a plain <audio>
// element can authenticate cross-origin without relying on cookies.
app.get("/api/stt/audio/file", (req, res) => {
  let authed = sttStandalone || Boolean(req.session && req.session.user);
  if (!authed) {
    const authHeader = String(req.headers.authorization || "");
    const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const headerToken = String(req.headers["x-auth-token"] || "").trim();
    const queryToken = String(req.query.token || "").trim();
    const token = bearerToken || headerToken || queryToken;
    if (token && tokenStore.get(token)) authed = true;
  }
  if (!authed) return res.status(401).json({ error: "Authentication required." });

  const requested = String(req.query.name || "").trim();
  if (!requested) return res.status(400).json({ error: "Missing file name." });

  // Use only the base name and match on the stem to prevent path traversal.
  const stem = path.basename(requested).replace(/\.[^.]+$/, "");

  const found = sttFindAudioFile(stem);

  if (!found) return res.status(404).json({ error: "Audio file not found." });

  // A-law/mu-law WAVs are not playable in browsers; serve a transcoded PCM copy.
  const transcoded = /\.wav$/i.test(found) ? sttTranscodeCompandedWav(found) : null;
  if (transcoded) {
    const total = transcoded.length;
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`);
        return res.end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      return res.end(transcoded.subarray(start, end + 1));
    }
    res.setHeader("Content-Length", total);
    return res.end(transcoded);
  }

  const mimeTypes = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
    ".wma": "audio/x-ms-wma",
  };
  const contentType = mimeTypes[path.extname(found).toLowerCase()] || "application/octet-stream";

  let stat;
  try {
    stat = fs.statSync(found);
  } catch (_) {
    return res.status(404).json({ error: "Audio file not found." });
  }
  const total = stat.size;

  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`);
      return res.end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", end - start + 1);
    return fs.createReadStream(found, { start, end }).pipe(res);
  }

  res.setHeader("Content-Length", total);
  return fs.createReadStream(found).pipe(res);
});

// Delete all transcribe-app data (for trials). Clears raw, processed, audio
// queue, and SO report entries/rows. Keeps settings (folders, model, mappings).
app.post("/api/stt/admin/reset", authRequired, (_req, res) => {
  // Delete children before parents (stt_processed references stt_raw).
  const tables = ["stt_report_rows", "stt_report_entries", "stt_audio_seen", "stt_processed", "stt_raw"];
  const cleared = {};
  const wipe = db.transaction(() => {
    for (const t of tables) {
      const before = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      db.prepare(`DELETE FROM ${t}`).run();
      cleared[t] = before ? before.n : 0;
    }
  });
  wipe();
  return res.json({ ok: true, cleared });
});

// ---------------------------------------------------------------------------
// Relevant SO Report Entries (curated transcript lines for the report)
// ---------------------------------------------------------------------------
function sttMapReportEntry(row) {
  return {
    id: row.id,
    processedId: row.processed_id,
    filename: row.filename,
    sourceTimestamp: row.source_timestamp || "",
    content: row.content || "",
    createdAt: row.created_at,
  };
}

app.get("/api/stt/report/entries", authRequired, (_req, res) => {
  const rows = db.prepare("SELECT * FROM stt_report_entries ORDER BY source_timestamp DESC, id DESC").all();
  return res.json({ items: rows.map(sttMapReportEntry) });
});

// Add a reviewed transcript to Key SO Occurrences using its recorded timestamp.
app.post("/api/stt/report/entries/from-processed/:id", authRequired, (req, res) => {
  const processedId = sanitizeInt(req.params.id, 0);
  if (processedId <= 0) return res.status(400).json({ error: "Invalid processed transcript id." });
  const processed = db.prepare("SELECT * FROM stt_processed WHERE id = ?").get(processedId);
  if (!processed) return res.status(404).json({ error: "Processed transcript not found." });
  const content = String(processed.edited_content != null ? processed.edited_content : processed.original_content || "").trim();
  if (!content) return res.status(400).json({ error: "Processed transcript has no content." });
  const existing = db.prepare("SELECT * FROM stt_report_entries WHERE processed_id = ?").get(processedId);
  if (existing) return res.status(409).json({ error: "This transcript is already in Key SO Occurrences." });
  const info = db.prepare(
    `INSERT INTO stt_report_entries (processed_id, filename, source_timestamp, content)
     VALUES (?, ?, ?, ?)`
  ).run(processedId, processed.filename || "", processed.source_timestamp || "", content);
  const row = db.prepare("SELECT * FROM stt_report_entries WHERE id = ?").get(info.lastInsertRowid);
  return res.json({ ok: true, item: sttMapReportEntry(row) });
});

// Add a standalone report log entry, entered manually by the Duty Officer.
app.post("/api/stt/report/entries", authRequired, (req, res) => {
  const content = String((req.body && req.body.content) || "").trim();
  if (!content) return res.status(400).json({ error: "Log content is required." });
  const sourceTimestamp = String((req.body && req.body.sourceTimestamp) || "").trim();
  const processedId = sanitizeInt(req.body && req.body.processedId, 0) || null;
  if (processedId) {
    const existing = db.prepare("SELECT id FROM stt_report_entries WHERE processed_id = ?").get(processedId);
    if (existing) return res.status(409).json({ error: "This transcript is already in Key SO Occurrences." });
  }
  const info = db
    .prepare(
      `INSERT INTO stt_report_entries (processed_id, filename, source_timestamp, content)
       VALUES (?, '', ?, ?)`
    )
    .run(processedId, sourceTimestamp, content);
  const row = db.prepare("SELECT * FROM stt_report_entries WHERE id = ?").get(info.lastInsertRowid);
  return res.json({ ok: true, item: sttMapReportEntry(row) });
});

// Edit a report log entry (time and/or content).
app.patch("/api/stt/report/entries/:id", authRequired, (req, res) => {
  const id = sanitizeInt(req.params.id, 0);
  if (id <= 0) return res.status(400).json({ error: "Invalid id." });
  const existing = db.prepare("SELECT * FROM stt_report_entries WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Entry not found." });
  const content =
    typeof (req.body && req.body.content) === "string" ? req.body.content.trim() : existing.content;
  const sourceTimestamp =
    typeof (req.body && req.body.sourceTimestamp) === "string"
      ? req.body.sourceTimestamp.trim()
      : existing.source_timestamp;
  if (!String(content || "").trim()) return res.status(400).json({ error: "Log content is required." });
  db.prepare("UPDATE stt_report_entries SET content = ?, source_timestamp = ? WHERE id = ?").run(
    content,
    sourceTimestamp,
    id
  );
  const row = db.prepare("SELECT * FROM stt_report_entries WHERE id = ?").get(id);
  return res.json({ ok: true, item: sttMapReportEntry(row) });
});

app.delete("/api/stt/report/entries/:id", authRequired, (req, res) => {
  const id = sanitizeInt(req.params.id, 0);
  if (id <= 0) return res.status(400).json({ error: "Invalid id." });
  const info = db.prepare("DELETE FROM stt_report_entries WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).json({ error: "Entry not found." });
  return res.json({ ok: true });
});

app.post("/api/stt/report/entries/clear", authRequired, (_req, res) => {
  db.prepare("DELETE FROM stt_report_entries").run();
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SO Report generation (AI summary / merged rows / .docx export)
// ---------------------------------------------------------------------------
// Build AI log entries from the curated Relevant SO Report Entries.
function sttReportLogEntries() {
  const rows = db.prepare("SELECT * FROM stt_report_entries ORDER BY source_timestamp ASC, id ASC").all();
  return rows.map((row) => ({
    filename: row.filename || "",
    edited_content: row.content || "",
    content: row.content || "",
    source_timestamp: row.source_timestamp || "",
    processed_at: row.source_timestamp || row.created_at || "",
  }));
}

// Same as sttReportLogEntries but keeps the entry id so generated report rows
// can record which entries they cover (needed for incremental generation).
function sttReportLogEntriesWithIds() {
  const rows = db.prepare("SELECT * FROM stt_report_entries ORDER BY source_timestamp ASC, id ASC").all();
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename || "",
    edited_content: row.content || "",
    content: row.content || "",
    source_timestamp: row.source_timestamp || "",
    processed_at: row.source_timestamp || row.created_at || "",
  }));
}

// Parse a "YYYY-MM-DD HH:MM:SS" (or ISO) timestamp to epoch ms, or null.
function sttParseTs(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}

function sttMapReportRow(row) {
  let sourceIds = [];
  try { sourceIds = JSON.parse(row.source_ids || "[]"); } catch (_) { sourceIds = []; }
  return {
    id: row.id,
    time: row.time_label || "",
    timeStart: row.time_start || "",
    timeEnd: row.time_end || "",
    movements: row.movements || "",
    remarks: row.remarks || "",
    sourceIds,
  };
}

// Minutes within which consecutive entries merge into one report row.
const sttMergeGapMinutes = 5;

// How many time-groups to process per generate request. Report generation runs
// one (slow) AI inference per group, so a whole report can take several minutes.
// The NAS portal is reached through an HTTPS proxy (e.g. Cloudflare) that hard-
// caps a single request at ~100s, so we process only a few groups per call and
// let the client loop until done. Each call stays well under the proxy limit.
const sttReportBatchGroups = 2;

// Split time-ordered entries into groups that would merge into one report row.
// A group may never span more than sttMergeGapMinutes from its first entry.
function sttGroupEntriesByGap(entries, gapMinutes) {
  const gapMs = gapMinutes * 60000;
  const groups = [];
  let current = [];
  let firstTs = null;
  for (const e of entries) {
    const ts = sttParseTs(e.source_timestamp);
    if (current.length && firstTs != null && ts != null && ts - firstTs > gapMs) {
      groups.push(current);
      current = [];
      firstTs = null;
    }
    current.push(e);
    if (firstTs == null && ts != null) firstTs = ts;
  }
  if (current.length) groups.push(current);
  return groups;
}

// Extract the YYYY-MM-DD date portion of an entry's source timestamp.
function sttEntryDate(entry) {
  const m = String((entry && entry.source_timestamp) || "").match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

// Keep only entries whose date falls within the selected [from, to] range so
// the report drafts one day's occurrences (or a chosen span) instead of every
// entry ever added. from/to are YYYY-MM-DD strings; empty means unbounded.
function sttFilterEntriesByDate(entries, from, to) {
  from = String(from || "").trim();
  to = String(to || "").trim();
  if (!from && !to) return entries;
  return entries.filter((e) => {
    const d = sttEntryDate(e);
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    return true;
  });
}

function sttReportMeta(body) {
  return {
    subject: String((body && body.subject) || "").trim(),
    ref_no: String((body && body.refNo) || "").trim(),
    date: String((body && body.date) || "").trim(),
  };
}

function sttEscapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sttLevenshteinRatio(a, b) {
  const m = a.length, n = b.length;
  if (!m && !n) return 1;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const dist = dp[n];
  return 1 - dist / Math.max(m, n, 1);
}

// Detect any multi-word proper noun (place/name) from the source that got
// garbled in the output and repair it to the source spelling. Generic fuzzy
// match — no specific names are hardcoded.
function sttRestoreProperNouns(outText, srcText) {
  const candidates = String(srcText || "").match(/\b[A-Z][a-zA-Z]*(?:\s+[A-Z0-9][a-zA-Z0-9]*){1,3}\b/g) || [];
  const ordered = [...new Set(candidates)].sort((a, b) => b.length - a.length);
  let outWords = outText.split(/\s+/);
  for (const phrase of ordered) {
    if (outText.includes(phrase)) continue;
    const phraseWords = phrase.split(/\s+/);
    const n = phraseWords.length;
    let bestRatio = 0;
    let bestSpan = null;
    for (let i = 0; i <= outWords.length - n; i++) {
      const window = outWords.slice(i, i + n).join(" ");
      const ratio = sttLevenshteinRatio(window.toLowerCase(), phrase.toLowerCase());
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestSpan = [i, i + n];
      }
    }
    if (bestSpan && bestRatio >= 0.72 && bestRatio < 1.0) {
      outWords.splice(bestSpan[0], bestSpan[1] - bestSpan[0], ...phraseWords);
      outText = outWords.join(" ");
    }
  }
  return outWords.join(" ");
}

function sttNormalizeMovementText(movementText, sourceText) {
  let out = String(movementText || "");
  const source = String(sourceText || "");

  const sttStopwords = new Set([
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at",
    "for", "with", "his", "her", "he", "she", "they", "them", "was",
    "were", "is", "are", "be", "been", "being", "before", "after",
    "then", "together", "both", "this", "that", "from", "into", "by",
    "as", "it", "its", "their", "subject", "who", "had", "has", "have",
    "not", "seen",
  ]);

  function sttContentWords(text) {
    const words = String(text || "").toLowerCase().match(/[a-z]+/g) || [];
    return words.filter((w) => w.length >= 3 && !sttStopwords.has(w));
  }

  // Append any source log line whose action content is not reflected in the
  // generated text, instead of relying on a fixed keyword list.
  function restoreOmittedActions(outText, srcText) {
    const segments = String(srcText || "")
      .split(/\[[^\]]+\]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    let result = outText;
    for (const seg of segments) {
      const segWords = sttContentWords(seg);
      if (segWords.length < 2) continue;
      const outPrefixes = new Set(sttContentWords(result).map((w) => w.slice(0, 4)));
      const matched = segWords.filter((w) => outPrefixes.has(w.slice(0, 4))).length;
      const ratio = matched / segWords.length;
      if (ratio < 0.4) {
        let snippet = seg.trim();
        if (snippet && !/[.!?]$/.test(snippet)) snippet += ".";
        if (snippet && /[a-z]/.test(snippet[0])) snippet = snippet[0].toUpperCase() + snippet.slice(1);
        const joiner = /[.!?]$/.test(result.trim()) ? " " : ". ";
        result = result.trimEnd() + joiner + snippet;
      }
    }
    return result;
  }
  const vehicleTypes = "car|vehicle|van|truck|lorry|motorcycle|motorbike|bike|bus|taxi|sedan|suv|phv";
  const plateRe = /\b([A-Z]{1,3}\s*\d{1,4}\s*[A-Z])\b/gi;
  const sgPlateRe = /\b(S[A-Z]{1,2}\s*\d{1,4}\s*[A-Z])\b/gi;
  const pairRe = new RegExp(
    `\\b(${vehicleTypes})\\b[^\\n.;:(){}]{0,40}\\b([A-Z]{1,3}\\s*\\d{1,4}\\s*[A-Z])\\b|` +
    `\\b([A-Z]{1,3}\\s*\\d{1,4}\\s*[A-Z])\\b[^\\n.;:(){}]{0,40}\\b(${vehicleTypes})\\b`,
    "gi"
  );

  const pairs = [];
  for (const m of source.matchAll(pairRe)) {
    const groups = [m[1], m[2], m[3], m[4]].filter(Boolean);
    if (groups.length < 2) continue;
    let vehicleType = groups[0];
    let plate = groups[1];
    if (/^[A-Z]{1,3}\s*\d{1,4}\s*[A-Z]$/i.test(vehicleType)) {
      plate = groups[0];
      vehicleType = groups[1];
    }
    const normalizedType = String(vehicleType || "").toLowerCase();
    const normalizedPlate = String(plate || "").replace(/\s+/g, "").toUpperCase();
    if (!normalizedType || !normalizedPlate) continue;
    const key = `${normalizedType}|${normalizedPlate}`;
    if (!pairs.some((p) => p.key === key)) {
      pairs.push({ key, type: normalizedType, plate: normalizedPlate });
    }
  }

  for (const p of pairs) {
    const formatted = `${p.type} [${p.plate}]`;
    const typeEsc = sttEscapeRegExp(p.type);
    const plateEsc = sttEscapeRegExp(p.plate);
    out = out.replace(
      new RegExp(`\\b${typeEsc}\\b\\s*(?:\\[\\s*)?${plateEsc}(?:\\s*\\])?`, "gi"),
      formatted
    );
    if (!new RegExp(sttEscapeRegExp(formatted), "i").test(out) && new RegExp(`\\b${plateEsc}\\b`, "i").test(out)) {
      out = out.replace(new RegExp(`\\b${plateEsc}\\b`, "i"), formatted);
    } else if (!new RegExp(sttEscapeRegExp(formatted), "i").test(out) && new RegExp(`\\b${typeEsc}\\b`, "i").test(out)) {
      out = out.replace(new RegExp(`\\b${typeEsc}\\b`, "i"), formatted);
    }
  }

  const sourcePlates = [];
  for (const m of source.matchAll(sgPlateRe)) {
    const p = String(m[1] || "").replace(/\s+/g, "").toUpperCase();
    if (p && !sourcePlates.includes(p)) sourcePlates.push(p);
  }
  for (const p of sourcePlates) {
    const hasTyped = new RegExp(`\\b(?:${vehicleTypes})\\s*\\[${sttEscapeRegExp(p)}\\]`, "i").test(out);
    if (hasTyped) continue;
    out = out.replace(
      new RegExp(`\\[(\\s*${sttEscapeRegExp(p)}\\s*)\\]`, "gi"),
      `[${p}]`
    );
    if (new RegExp(`\\b${sttEscapeRegExp(p)}\\b`, "i").test(out)) {
      out = out.replace(new RegExp(`\\b${sttEscapeRegExp(p)}\\b`, "i"), `car [${p}]`);
    }
  }

  const allowed = new Set(sourcePlates);
  out = out.replace(/\bcar\s*\[\s*([A-Z]{1,3}\s*\d{1,4}\s*[A-Z])\s*\]/gi, (_m, plateValue) => {
    const normalized = String(plateValue || "").replace(/\s+/g, "").toUpperCase();
    if (allowed.has(normalized)) return `car [${normalized}]`;
    return normalized;
  });
  out = out.replace(/\[(\s*car\s*\[[^\]]+\]\s*)\]/gi, (_m, inner) => String(inner || "").trim());
  out = out.replace(/\b(?!S[A-Z]{1,2}\d{1,4}[A-Z]\b)[A-Z]{3}\d[A-Z]\b\s+(?=car\s*\[S[A-Z]{1,2}\d{1,4}[A-Z]\])/gi, "");

  for (const sourcePlate of source.matchAll(sgPlateRe)) {
    const plateKey = String(sourcePlate[1] || "").replace(/\s+/g, "").toUpperCase();
    const plateDisplay = String(sourcePlate[1] || "").replace(/\s+/g, " ").trim().toUpperCase();
    const parts = /^([A-Z]+)(\d+)([A-Z])$/.exec(plateKey);
    const flexible = parts
      ? `${sttEscapeRegExp(parts[1])}\\s*${sttEscapeRegExp(parts[2])}\\s*${sttEscapeRegExp(parts[3])}`
      : sttEscapeRegExp(plateKey);
    out = out.replace(new RegExp(`\\[\\s*${flexible}\\s*\\]`, "gi"), `[${plateDisplay}]`);
    const first = new RegExp(`\\[\\s*${sttEscapeRegExp(plateDisplay)}\\s*\\]`, "i").exec(out);
    if (!first) continue;
    const head = out.slice(0, first.index + first[0].length);
    let tail = out.slice(first.index + first[0].length);
    tail = tail.replace(new RegExp(`\\s*\\[\\s*${sttEscapeRegExp(plateDisplay)}\\s*\\]`, "gi"), "");
    tail = tail.replace(new RegExp(`,?\\s*(?:and\\s+)?\\b${flexible}\\b`, "gi"), "");
    out = head + tail;
  }
  out = out.replace(/\s*\[\s*\]/g, "");

  out = sttRestoreProperNouns(out, source);

  out = out.replace(/\bBlock\s+(\d+)\b/gi, "Blk $1");
  const sttNumberWords = {
    one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
    seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  };
  out = out.replace(
    new RegExp(`\\b(Avenue|Street|Ave|St)\\s+(${Object.keys(sttNumberWords).join("|")})\\b`, "gi"),
    (_m, label, word) => `${label} ${sttNumberWords[word.toLowerCase()]}`
  );

  out = out.replace(/\b(?:in\s+)?Singapore\s*\((\d{6})\)/gi, "S($1)");
  return out;
}

// Stored generated report rows (for resuming a draft).
app.get("/api/stt/report/rows", authRequired, (_req, res) => {
  const rows = db.prepare("SELECT * FROM stt_report_rows ORDER BY position ASC, id ASC").all();
  return res.json({ items: rows.map(sttMapReportRow) });
});

// Persist edits made to the generated report rows (movements / remarks / time).
app.post("/api/stt/report/rows/save", authRequired, (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const update = db.prepare(
    "UPDATE stt_report_rows SET time_label = ?, movements = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  );
  const maxPos = db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM stt_report_rows").get().p;
  const insert = db.prepare(
    "INSERT INTO stt_report_rows (position, source_ids, time_label, time_start, time_end, movements, remarks) VALUES (?, '[]', ?, '', '', ?, ?)"
  );
  let pos = maxPos + 1;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const id = sanitizeInt(r.id, 0);
      const time = String(r.time || "");
      const movements = String(r.movements || "");
      const remarks = String(r.remarks || "");
      if (id > 0) {
        update.run(time, movements, remarks, id);
      } else if (movements || time || remarks) {
        insert.run(pos++, time, movements, remarks);
      }
    }
  });
  tx();
  const out = db.prepare("SELECT * FROM stt_report_rows ORDER BY position ASC, id ASC").all();
  return res.json({ ok: true, items: out.map(sttMapReportRow) });
});

// Clear the stored generated report (start a fresh draft).
app.post("/api/stt/report/rows/clear", authRequired, (_req, res) => {
  db.prepare("DELETE FROM stt_report_rows").run();
  return res.json({ ok: true });
});

// Incrementally generate the AI report: only new entries are sent to the model,
// and the last stored row is re-merged when a new entry falls within the merge
// gap of it, so resuming continues the report instead of regenerating it.
app.post("/api/stt/report/rows/generate", authRequired, async (req, res) => {
  const entries = sttReportLogEntriesWithIds();
  if (!entries.length) return res.status(400).json({ error: "Add some entries first." });

  const stored = db.prepare("SELECT * FROM stt_report_rows ORDER BY position ASC, id ASC").all();
  const covered = new Set();
  for (const row of stored) {
    let ids = [];
    try { ids = JSON.parse(row.source_ids || "[]"); } catch (_) { ids = []; }
    ids.forEach((id) => covered.add(id));
  }

  // Only draft the selected date's occurrences, not every entry ever added.
  const scoped = sttFilterEntriesByDate(entries, req.body && req.body.dateFrom, req.body && req.body.dateTo);
  if (!scoped.length) {
    return res.json({ items: stored.map(sttMapReportRow), added: 0, hasMore: false, message: "No entries for the selected date." });
  }

  const pending = scoped.filter((e) => !covered.has(e.id));
  if (!pending.length) {
    return res.json({ items: stored.map(sttMapReportRow), added: 0, hasMore: false, message: "No new entries to add." });
  }

  // Report generation runs one slow AI inference per time-group, so a full
  // report can take minutes. The NAS portal is behind an HTTPS proxy that caps a
  // single request at ~100s, so process only the first few groups this call and
  // let the client loop (calling generate again) until hasMore is false.
  const pendingGroups = sttGroupEntriesByGap(pending, sttMergeGapMinutes);
  const batchPending = pendingGroups.slice(0, sttReportBatchGroups).flat();
  const hasMore = batchPending.length < pending.length;

  let toProcess = batchPending;
  let tailRowId = 0;
  if (stored.length) {
    const lastRow = stored[stored.length - 1];
    const lastEnd = sttParseTs(lastRow.time_end);
    const firstPendingTs = sttParseTs(batchPending[0].source_timestamp);
    const gapMs = sttMergeGapMinutes * 60000;
    if (lastEnd != null && firstPendingTs != null && firstPendingTs - lastEnd <= gapMs) {
      let tailIds = [];
      try { tailIds = JSON.parse(lastRow.source_ids || "[]"); } catch (_) { tailIds = []; }
      const tailEntries = entries.filter((e) => tailIds.includes(e.id));
      toProcess = tailEntries.concat(batchPending);
      toProcess.sort((a, b) => (sttParseTs(a.source_timestamp) || 0) - (sttParseTs(b.source_timestamp) || 0));
      tailRowId = lastRow.id;
    }
  }

  let data;
  try {
    const r = await sttAiRequest(
      "/report_rows",
      {
        entries: toProcess,
        reportMeta: sttReportMeta(req.body),
      },
      "POST",
      600000
    );
    if (!r.ok) return res.status(502).json({ error: (r.data && r.data.error) || "AI service error." });
    data = r.data;
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
  if (data && data.error) return res.status(502).json({ error: data.error });

  const newRows = (data && Array.isArray(data.rows)) ? data.rows : [];
  const insert = db.prepare(
    "INSERT INTO stt_report_rows (position, source_ids, time_label, time_start, time_end, movements, remarks) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    if (tailRowId) db.prepare("DELETE FROM stt_report_rows WHERE id = ?").run(tailRowId);
    let pos = db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM stt_report_rows").get().p + 1;
    for (const row of newRows) {
      const sourceIds = Array.isArray(row.source_ids) ? row.source_ids : [];
      const sourceIdSet = new Set(sourceIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)));
      const sourceText = toProcess
        .filter((entry) => sourceIdSet.has(Number(entry.id)))
        .map((entry) => String(entry.edited_content || ""))
        .join(" ");
      const normalizedMovements = sttNormalizeMovementText(String(row.movements || ""), sourceText);
      insert.run(
        pos++,
        JSON.stringify(sourceIds),
        String(row.time || ""),
        String(row.time_start || ""),
        String(row.time_end || ""),
        normalizedMovements,
        String(row.remarks || "")
      );
    }
  });
  tx();

  const out = db.prepare("SELECT * FROM stt_report_rows ORDER BY position ASC, id ASC").all();
  return res.json({ items: out.map(sttMapReportRow), added: newRows.length, hasMore });
});

// AI narrative summary of the curated occurrences.
app.post("/api/stt/report/summary", authRequired, async (req, res) => {
  const entries = sttReportLogEntries();
  if (!entries.length) return res.status(400).json({ error: "Add some entries to the report first." });
  try {
    const r = await sttAiRequest(
      "/report_summary",
      { entries, reportMeta: sttReportMeta(req.body) },
      "POST",
      600000
    );
    if (!r.ok) return res.status(502).json({ error: (r.data && r.data.error) || "AI service error." });
    return res.json(r.data);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

// AI-merged structured report (rows of Time / Movements / Remarks).
app.post("/api/stt/report/merged", authRequired, async (req, res) => {
  const entries = sttReportLogEntries();
  if (!entries.length) return res.status(400).json({ error: "Add some entries to the report first." });
  try {
    const r = await sttAiRequest(
      "/report_merged",
      { entries, reportMeta: sttReportMeta(req.body) },
      "POST",
      600000
    );
    if (!r.ok) return res.status(502).json({ error: (r.data && r.data.error) || "AI service error." });
    return res.json(r.data);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

// Fill the configured .docx template with report rows and return it for download.
app.post("/api/stt/report/docx", authRequired, async (req, res) => {
  const templatePath = String(getSttSetting("reportTemplatePath") || "").trim();
  if (!templatePath || !fs.existsSync(templatePath)) {
    return res.status(400).json({ error: "Upload a .docx report template in Settings first." });
  }
  if (path.extname(templatePath).toLowerCase() !== ".docx") {
    return res.status(400).json({ error: "The saved template is not a .docx file." });
  }
  const meta = sttReportMeta(req.body);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const reportData = {
    title: "NORMAL REPORT",
    date: meta.date || "Not available",
    ref_no: meta.ref_no || "Not available",
    subject: meta.subject || "Not available",
    rows: rows.map((r) => ({
      time: String(r.time || ""),
      movements: String(r.movements || ""),
      remarks: String(r.remarks || ""),
    })),
  };
  // Send the template bytes so the AI service (which may run on another host in
  // the LAN setup) does not need filesystem access to this server's path.
  let templateB64;
  try {
    templateB64 = fs.readFileSync(templatePath).toString("base64");
  } catch (_) {
    return res.status(500).json({ error: "Could not read the report template." });
  }
  try {
    const r = await sttAiRequest("/report_docx", { templatePath, templateB64, reportData }, "POST", 120000);
    if (!r.ok || !r.data || !r.data.docx) {
      return res.status(502).json({ error: (r.data && r.data.error) || "Could not generate the report." });
    }
    const buf = Buffer.from(r.data.docx, "base64");
    const name = `operation_report_${Date.now()}.docx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    return res.send(buf);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

// Live Transcript View export: build the report .docx programmatically
// (Ops Reference / Name / Entity / Date / DO header + light-blue Time | Movement
// table) without needing an uploaded template.
app.post("/api/stt/report/live-docx", authRequired, async (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const reportData = {
    ops_reference: String(body.opsReference || "").trim(),
    subject: String(body.subject || "").trim(),
    date: String(body.date || "").trim(),
    do: String(body.do || "").trim(),
    rows: rows.map((r) => ({
      time: String(r.time || ""),
      movements: String(r.movements || r.movement || ""),
    })),
  };
  if (!reportData.ops_reference || !reportData.subject) {
    return res.status(400).json({ error: "Ops Reference and Name / Entity are required." });
  }
  try {
    const r = await sttAiRequest("/report_docx_builtin", { reportData }, "POST", 120000);
    if (!r.ok || !r.data || !r.data.docx) {
      return res.status(502).json({ error: (r.data && r.data.error) || "Could not generate the report." });
    }
    const buf = Buffer.from(r.data.docx, "base64");
    const name = `operation_report_${Date.now()}.docx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    return res.send(buf);
  } catch (_) {
    return res.status(503).json({ error: sttAiOfflineHint });
  }
});

app.get("/", (_, res) => {
  res.redirect("/index.html");
});

// Global error handler: convert any error thrown in a route/middleware into a
// JSON 500 response instead of letting it bubble up and potentially crash the
// process. Must be registered after all routes.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[Request Error]", req && req.method, req && req.originalUrl, err && err.stack ? err.stack : err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ error: "Server error." });
});

// Process-level safety nets: log the real cause and keep the API running so a
// single unexpected error does not take the whole server down "halfway".
process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", reason && reason.stack ? reason.stack : reason);
});

process.on("uncaughtException", (error) => {
  console.error("[Uncaught Exception]", error && error.stack ? error.stack : error);
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`SQLite DB: ${path.join(dataDir, "app.db")}`);
  console.log(`SQLite driver: ${getDriverInfo().driver}`);
  console.log(`SQLite journal mode: ${journalMode}`);
  console.log(`Map directory: ${mapDir} (exists: ${fs.existsSync(mapDir)})`);
});
