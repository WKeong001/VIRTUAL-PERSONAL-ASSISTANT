"use strict";

// Database driver loader with a no-native-build fallback.
//
// 1. Prefer better-sqlite3 (fast native module) when its binary matches this OS/CPU.
// 2. If the native binary cannot load (for example the whole folder was copied
//    from Windows to a Linux NAS without reinstalling), fall back to Node's
//    built-in SQLite (node:sqlite). The built-in engine needs no compilation and
//    no internet access, so a plain folder copy keeps working.
//
// The fallback exposes the small subset of the better-sqlite3 API that this app
// uses: pragma(), prepare().run()/get()/all(), exec(), and transaction().

let betterSqlite3 = null;
let betterSqlite3Error = null;

if (process.env.FORCE_NODE_SQLITE !== "1") {
  try {
    betterSqlite3 = require("better-sqlite3");
  } catch (error) {
    betterSqlite3Error = error;
  }
}

function loadNodeSqlite() {
  try {
    // Built-in on Node 22.5+. No native build and no internet download required.
    return require("node:sqlite");
  } catch (error) {
    const guidance =
      "Could not load any SQLite engine.\n" +
      "- better-sqlite3 failed to load (likely a copied binary from another OS/CPU).\n" +
      "- Node's built-in node:sqlite is also unavailable.\n" +
      "If you are on Node 22.x and see this, start the server with the flag:\n" +
      "  node --experimental-sqlite server.js\n" +
      "Original node:sqlite error: " +
      (error && error.message ? error.message : String(error));
    const wrapped = new Error(guidance);
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeRunResult(result) {
  const changesRaw = result ? result.changes : 0;
  const rowidRaw = result ? result.lastInsertRowid : 0;
  return {
    changes: typeof changesRaw === "bigint" ? Number(changesRaw) : changesRaw || 0,
    lastInsertRowid: typeof rowidRaw === "bigint" ? Number(rowidRaw) : rowidRaw || 0,
  };
}

function createNodeSqliteDatabase(filePath) {
  const { DatabaseSync } = loadNodeSqlite();
  const raw = new DatabaseSync(filePath);
  let openTransactions = 0;

  const wrapper = {
    driver: "node:sqlite",
    _raw: raw,

    pragma(statement) {
      const text = String(statement || "").trim();
      if (!text) return [];
      return raw.prepare("PRAGMA " + text).all();
    },

    exec(sql) {
      raw.exec(sql);
      return wrapper;
    },

    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        run(...params) {
          return normalizeRunResult(statement.run(...params));
        },
        get(...params) {
          return statement.get(...params);
        },
        all(...params) {
          return statement.all(...params);
        },
      };
    },

    transaction(fn) {
      return function transactionRunner(...args) {
        const useSavepoint = openTransactions > 0;
        const savepointName = "sp_" + openTransactions;
        raw.exec(useSavepoint ? "SAVEPOINT " + savepointName : "BEGIN");
        openTransactions += 1;
        try {
          const result = fn.apply(this, args);
          raw.exec(useSavepoint ? "RELEASE " + savepointName : "COMMIT");
          openTransactions -= 1;
          return result;
        } catch (error) {
          try {
            raw.exec(useSavepoint ? "ROLLBACK TO " + savepointName : "ROLLBACK");
            if (useSavepoint) raw.exec("RELEASE " + savepointName);
          } catch (_) {
            // Ignore rollback errors and surface the original failure.
          }
          openTransactions -= 1;
          throw error;
        }
      };
    },

    get inTransaction() {
      return openTransactions > 0;
    },

    close() {
      raw.close();
    },
  };

  return wrapper;
}

let activeDriver = "";

function createDatabase(filePath) {
  // better-sqlite3's require() succeeds even when its native binary is wrong for
  // this OS/CPU. The mismatch only throws when the database is constructed, so
  // the fallback decision must happen here (not at require time).
  if (betterSqlite3) {
    try {
      const nativeDb = new betterSqlite3(filePath);
      activeDriver = "better-sqlite3";
      return nativeDb;
    } catch (error) {
      betterSqlite3Error = error;
      const isNativeBinaryMismatch =
        String((error && error.message) || "").toLowerCase().includes("invalid elf header") ||
        String((error && error.code) || "").toUpperCase() === "ERR_DLOPEN_FAILED";
      if (!isNativeBinaryMismatch) {
        throw error;
      }
      console.warn(
        "[db-driver] better-sqlite3 native binary is not usable on this system; " +
          "falling back to built-in node:sqlite."
      );
    }
  }

  const fallbackDb = createNodeSqliteDatabase(filePath);
  activeDriver = "node:sqlite";
  return fallbackDb;
}

function getDriverInfo() {
  return {
    driver: activeDriver || (betterSqlite3 ? "better-sqlite3" : "node:sqlite"),
    betterSqlite3Error:
      betterSqlite3Error && betterSqlite3Error.message
        ? betterSqlite3Error.message
        : String(betterSqlite3Error || ""),
  };
}

module.exports = { createDatabase, getDriverInfo };
