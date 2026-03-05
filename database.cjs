"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");

const DEFAULT_DB_PATH = path.join(os.homedir(), ".multi-claude", "history.db");

class HistoryDB {
  constructor(dbPath = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this._migrate();
    this._prepareStatements();
    this._analyticsCache = null;
    this._analyticsCacheTime = 0;
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        model TEXT,
        terminal_count INTEGER,
        outcome TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        duration INTEGER,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        file_changes_count INTEGER DEFAULT 0,
        summary_json TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT,
        duration INTEGER,
        attempts INTEGER DEFAULT 1,
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id);
    `);
  }

  _prepareStatements() {
    this._insertRun = this.db.prepare(`
      INSERT OR REPLACE INTO runs (id, goal, model, terminal_count, outcome,
        started_at, ended_at, duration,
        total_input_tokens, total_output_tokens, estimated_cost,
        file_changes_count, summary_json)
      VALUES (@id, @goal, @model, @terminalCount, @outcome,
        @startedAt, @endedAt, @duration,
        @totalInputTokens, @totalOutputTokens, @estimatedCost,
        @fileChangesCount, @summaryJson)
    `);

    this._insertTask = this.db.prepare(`
      INSERT INTO tasks (run_id, name, status, duration, attempts, error, started_at, completed_at)
      VALUES (@runId, @name, @status, @duration, @attempts, @error, @startedAt, @completedAt)
    `);

    this._getRuns = this.db.prepare(`
      SELECT r.id, r.goal, r.model, r.outcome, r.duration,
        r.started_at as startedAt, r.estimated_cost as estimatedCost,
        r.terminal_count as terminalCount,
        (SELECT COUNT(*) FROM tasks WHERE run_id = r.id) as taskCount
      FROM runs r
      ORDER BY r.started_at DESC
      LIMIT ? OFFSET ?
    `);

    this._getRun = this.db.prepare(`
      SELECT * FROM runs WHERE id = ?
    `);

    this._getRunTasks = this.db.prepare(`
      SELECT name, status, duration, attempts, error, started_at as startedAt, completed_at as completedAt
      FROM tasks WHERE run_id = ?
      ORDER BY id ASC
    `);

    this._deleteRun = this.db.prepare(`DELETE FROM runs WHERE id = ?`);

    this._countRuns = this.db.prepare(`SELECT COUNT(*) as cnt FROM runs`);
  }

  saveRun(runData) {
    const txn = this.db.transaction(() => {
      const tokens = runData.totalTokens || {};
      this._insertRun.run({
        id: runData.id,
        goal: runData.goal || "",
        model: runData.model || null,
        terminalCount: runData.terminalCount || null,
        outcome: runData.outcome || null,
        startedAt: runData.startedAt || null,
        endedAt: runData.endedAt || null,
        duration: runData.duration || null,
        totalInputTokens: tokens.input || 0,
        totalOutputTokens: tokens.output || 0,
        estimatedCost: runData.estimatedCost || 0,
        fileChangesCount: runData.fileChangesCount || 0,
        summaryJson: runData.summary ? JSON.stringify(runData.summary) : null,
      });

      if (runData.tasks && Array.isArray(runData.tasks)) {
        for (const task of runData.tasks) {
          this._insertTask.run({
            runId: runData.id,
            name: task.name,
            status: task.status || null,
            duration: task.duration || null,
            attempts: task.attempts || 1,
            error: task.error || null,
            startedAt: task.startedAt || null,
            completedAt: task.completedAt || null,
          });
        }
      }
    });
    txn();
    this._analyticsCache = null; // invalidate cache
  }

  getRuns(limit = 20, offset = 0) {
    return this._getRuns.all(limit, offset).map(r => ({
      id: r.id,
      goal: r.goal,
      model: r.model,
      outcome: r.outcome,
      duration: r.duration,
      taskCount: r.taskCount,
      estimatedCost: r.estimatedCost,
      totalCost: r.estimatedCost,
      startedAt: r.startedAt,
      terminalCount: r.terminalCount,
    }));
  }

  getRun(id) {
    const row = this._getRun.get(id);
    if (!row) return null;
    const tasks = this._getRunTasks.all(id);
    return {
      id: row.id,
      goal: row.goal,
      model: row.model,
      terminalCount: row.terminal_count,
      outcome: row.outcome,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      duration: row.duration,
      totalTokens: { input: row.total_input_tokens, output: row.total_output_tokens },
      estimatedCost: row.estimated_cost,
      fileChangesCount: row.file_changes_count,
      summary: row.summary_json ? JSON.parse(row.summary_json) : null,
      tasks,
    };
  }

  deleteRun(id) {
    const result = this._deleteRun.run(id);
    if (result.changes > 0) this._analyticsCache = null;
    return result.changes > 0;
  }

  getAnalytics() {
    const now = Date.now();
    if (this._analyticsCache && (now - this._analyticsCacheTime) < 60000) {
      return this._analyticsCache;
    }

    const totals = this.db.prepare(`
      SELECT
        COUNT(*) as totalRuns,
        AVG(duration) as avgDuration,
        SUM(estimated_cost) as totalCost,
        AVG(estimated_cost) as avgCostPerRun
      FROM runs
    `).get();

    const successCount = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM runs
      WHERE outcome = 'completed' OR outcome = 'success'
    `).get().cnt;

    const costPerDay = this.db.prepare(`
      SELECT
        date(started_at / 1000, 'unixepoch') as date,
        SUM(estimated_cost) as cost,
        COUNT(*) as runs
      FROM runs
      WHERE started_at IS NOT NULL
      GROUP BY date(started_at / 1000, 'unixepoch')
      ORDER BY date DESC
      LIMIT 30
    `).all();

    const modelUsage = this.db.prepare(`
      SELECT model, COUNT(*) as count
      FROM runs
      WHERE model IS NOT NULL
      GROUP BY model
    `).all();

    const modelMap = {};
    for (const row of modelUsage) {
      modelMap[row.model] = row.count;
    }

    const taskStats = this.db.prepare(`
      SELECT
        AVG(task_count) as avgTasksPerRun,
        CAST(SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) as retryRate
      FROM (
        SELECT run_id,
          COUNT(*) as task_count,
          SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) as retry_count
        FROM tasks
        GROUP BY run_id
      )
    `).get();

    const analytics = {
      totalRuns: totals.totalRuns || 0,
      avgDuration: Math.round(totals.avgDuration || 0),
      successRate: totals.totalRuns > 0 ? successCount / totals.totalRuns : 0,
      totalCost: totals.totalCost || 0,
      costPerRun: costPerDay.map(r => ({ date: r.date, cost: r.cost, runs: r.runs })),
      modelUsage: modelMap,
      avgTasksPerRun: taskStats.avgTasksPerRun || 0,
      retryRate: taskStats.retryRate || 0,
    };

    this._analyticsCache = analytics;
    this._analyticsCacheTime = now;
    return analytics;
  }

  migrateFromJson(historyDir) {
    if (!fs.existsSync(historyDir)) return 0;
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith(".json"));
    if (files.length === 0) return 0;

    let imported = 0;
    const txn = this.db.transaction(() => {
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(historyDir, file), "utf-8"));
          // Skip if already imported
          const existing = this._getRun.get(data.id);
          if (existing) continue;

          this.saveRun(data);
          imported++;
        } catch (_) {
          // Skip malformed files
        }
      }
    });
    txn();

    // Rename directory to indicate migration is done
    if (imported > 0) {
      const migratedDir = historyDir + "-migrated";
      try {
        if (!fs.existsSync(migratedDir)) {
          fs.renameSync(historyDir, migratedDir);
        }
      } catch (_) {
        // If rename fails, leave files in place
      }
    }

    return imported;
  }

  close() {
    this.db.close();
  }
}

module.exports = { HistoryDB, DEFAULT_DB_PATH };
