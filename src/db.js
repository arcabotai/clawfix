import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('Unexpected DB error:', err.message);
    });
  }
  return pool;
}

/**
 * Initialize database schema
 */
export async function initDB() {
  const db = getPool();
  if (!db) {
    console.log('⚠️  No DATABASE_URL — running without persistence');
    return false;
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS diagnoses (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        host_hash TEXT,
        os TEXT,
        arch TEXT,
        node_version TEXT,
        openclaw_version TEXT,
        issues_pattern JSONB DEFAULT '[]',
        issues_ai JSONB DEFAULT '[]',
        issues_count INTEGER DEFAULT 0,
        ai_model TEXT,
        ai_tokens INTEGER,
        fix_script TEXT,
        ai_summary TEXT,
        outcome TEXT DEFAULT 'unknown',
        paid BOOLEAN DEFAULT FALSE,
        amount NUMERIC(10,2) DEFAULT 0,
        payment_method TEXT,
        source TEXT DEFAULT 'unknown'
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        times_detected INTEGER DEFAULT 0,
        times_fixed INTEGER DEFAULT 0,
        success_rate REAL,
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        source TEXT DEFAULT 'manual'
      );

      CREATE TABLE IF NOT EXISTS ai_discoveries (
        id SERIAL PRIMARY KEY,
        issue_hash TEXT,
        issue_summary TEXT NOT NULL,
        similar_count INTEGER DEFAULT 1,
        first_seen TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        graduated BOOLEAN DEFAULT FALSE,
        pattern_id TEXT REFERENCES patterns(id)
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        fix_id TEXT REFERENCES diagnoses(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        success BOOLEAN,
        issues_remaining INTEGER,
        comment TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_diagnoses_created ON diagnoses(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_diagnoses_host ON diagnoses(host_hash);
      CREATE INDEX IF NOT EXISTS idx_diagnoses_version ON diagnoses(openclaw_version);
      CREATE INDEX IF NOT EXISTS idx_ai_discoveries_hash ON ai_discoveries(issue_hash);
    `);

    console.log('✅ Database initialized');
    return true;
  } catch (err) {
    console.error('DB init failed:', err.message);
    return false;
  }
}

/**
 * Store a diagnosis result
 */
export async function storeDiagnosis(result, source = 'cli') {
  const db = getPool();
  if (!db) return;

  try {
    await db.query(`
      INSERT INTO diagnoses (id, host_hash, os, arch, node_version, openclaw_version,
        issues_pattern, issues_ai, issues_count, ai_model, fix_script, ai_summary, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      result.fixId,
      result._hostHash || null,
      result._os || null,
      result._arch || null,
      result._nodeVersion || null,
      result._openclawVersion || null,
      JSON.stringify(result.knownIssues?.map(i => i.id) || []),
      JSON.stringify(result._aiIssues || []),
      result.issuesFound || 0,
      result.model || null,
      result.fixScript || null,
      result.analysis || null,
      source,
    ]);

    // Update pattern detection counts
    if (result.knownIssues) {
      for (const issue of result.knownIssues) {
        await db.query(`
          INSERT INTO patterns (id, title, severity, times_detected, last_seen)
          VALUES ($1, $2, $3, 1, NOW())
          ON CONFLICT (id) DO UPDATE SET
            times_detected = patterns.times_detected + 1,
            last_seen = NOW()
        `, [issue.id, issue.title, issue.severity]);
      }
    }
  } catch (err) {
    console.error('Store diagnosis failed:', err.message);
  }
}

/**
 * Record fix feedback
 */
export async function storeFeedback(fixId, success, issuesRemaining, comment) {
  const db = getPool();
  if (!db) return;

  try {
    await db.query(`
      INSERT INTO feedback (fix_id, success, issues_remaining, comment)
      VALUES ($1, $2, $3, $4)
    `, [fixId, success, issuesRemaining, comment]);

    // Update diagnosis outcome
    await db.query(`
      UPDATE diagnoses SET outcome = $2 WHERE id = $1
    `, [fixId, success ? 'success' : 'failed']);

    // Update pattern success rates
    if (success) {
      const diag = await db.query('SELECT issues_pattern FROM diagnoses WHERE id = $1', [fixId]);
      if (diag.rows[0]) {
        const patterns = diag.rows[0].issues_pattern || [];
        for (const patternId of patterns) {
          await db.query(`
            UPDATE patterns SET 
              times_fixed = times_fixed + 1,
              success_rate = (times_fixed + 1)::REAL / GREATEST(times_detected, 1)
            WHERE id = $1
          `, [patternId]);
        }
      }
    }
  } catch (err) {
    console.error('Store feedback failed:', err.message);
  }
}

/**
 * Get stats for the dashboard
 */
export async function getStats() {
  const db = getPool();
  if (!db) return null;

  try {
    const [total, today, topIssues, versions, outcomes] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM diagnoses'),
      db.query("SELECT COUNT(*) as count FROM diagnoses WHERE created_at > NOW() - INTERVAL '24 hours'"),
      db.query('SELECT id, title, severity, times_detected, success_rate FROM patterns ORDER BY times_detected DESC LIMIT 10'),
      db.query('SELECT openclaw_version, COUNT(*) as count FROM diagnoses WHERE openclaw_version IS NOT NULL GROUP BY openclaw_version ORDER BY count DESC LIMIT 5'),
      db.query("SELECT outcome, COUNT(*) as count FROM diagnoses GROUP BY outcome"),
    ]);

    return {
      totalDiagnoses: parseInt(total.rows[0].count),
      last24h: parseInt(today.rows[0].count),
      topIssues: topIssues.rows,
      versionBreakdown: versions.rows,
      outcomes: outcomes.rows,
    };
  } catch (err) {
    console.error('Get stats failed:', err.message);
    return null;
  }
}
