import pg from 'pg';

const { Pool } = pg;

let pool = null;

const PUBLIC_DIAGNOSIS_FILTER = "source IS DISTINCT FROM 'canary'";

export function shouldCountDiagnosisInPublicMetrics(source) {
  return source !== 'canary';
}

/** Public dashboard queries over diagnoses. Canary rows stay available for operations only. */
export function getPublicStatsQueries() {
  return Object.freeze({
    total: `SELECT COUNT(*) as count FROM diagnoses WHERE ${PUBLIC_DIAGNOSIS_FILTER}`,
    today: `SELECT COUNT(*) as count FROM diagnoses WHERE ${PUBLIC_DIAGNOSIS_FILTER} AND created_at > NOW() - INTERVAL '24 hours'`,
    versions: `SELECT openclaw_version, COUNT(*) as count FROM diagnoses WHERE ${PUBLIC_DIAGNOSIS_FILTER} AND openclaw_version IS NOT NULL GROUP BY openclaw_version ORDER BY count DESC LIMIT 5`,
    outcomes: `SELECT outcome, COUNT(*) as count FROM diagnoses WHERE ${PUBLIC_DIAGNOSIS_FILTER} GROUP BY outcome`,
    serviceManagers: `SELECT service_manager, COUNT(*) as count FROM diagnoses WHERE ${PUBLIC_DIAGNOSIS_FILTER} AND service_manager IS NOT NULL GROUP BY service_manager ORDER BY count DESC`,
    sigterms: `SELECT COUNT(*) as count FROM diagnoses WHERE ${PUBLIC_DIAGNOSIS_FILTER} AND (sigterm_count > 0 OR service_state = 'sigterm')`,
    zombies: `SELECT COUNT(*) as count FROM diagnoses WHERE ${PUBLIC_DIAGNOSIS_FILTER} AND (service_state = 'crashed' OR service_state = 'failed')`,
  });
}

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
        ai_insights TEXT,
        known_issues_detail JSONB DEFAULT '[]',
        outcome TEXT DEFAULT 'unknown',
        paid BOOLEAN DEFAULT FALSE,
        amount NUMERIC(10,2) DEFAULT 0,
        payment_method TEXT,
        source TEXT DEFAULT 'unknown'
      );

      -- Add columns if they don't exist (for existing deployments)
      DO $$ BEGIN
        ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS ai_insights TEXT;
        ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS known_issues_detail JSONB DEFAULT '[]';
        ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS service_manager TEXT;
        ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS service_state TEXT;
        ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS service_exit_code TEXT;
        ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS err_log_size_mb INTEGER;
        ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS sigterm_count INTEGER;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;

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
  if (!db) return false;

  try {
    await db.query(`
      INSERT INTO diagnoses (id, host_hash, os, arch, node_version, openclaw_version,
        issues_pattern, issues_ai, issues_count, ai_model, fix_script, ai_summary, ai_insights, known_issues_detail,
        service_manager, service_state, service_exit_code, err_log_size_mb, sigterm_count, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
      result.aiInsights || null,
      JSON.stringify(result.knownIssues || []),
      result._serviceManager || null,
      result._serviceState || null,
      result._serviceExitCode || null,
      result._errLogSizeMB || null,
      result._sigtermCount || null,
      source,
    ]);

    // Update pattern detection counts
    if (shouldCountDiagnosisInPublicMetrics(source) && result.knownIssues) {
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
    return true;
  } catch (err) {
    console.error('Store diagnosis failed:', err.message);
    return false;
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
      const diag = await db.query('SELECT issues_pattern, source FROM diagnoses WHERE id = $1', [fixId]);
      if (diag.rows[0] && shouldCountDiagnosisInPublicMetrics(diag.rows[0].source)) {
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
 * Retrieve a diagnosis by fix ID (for results page persistence)
 */
export async function getDiagnosis(fixId) {
  const db = getPool();
  if (!db) return null;

  try {
    const result = await db.query(
      'SELECT * FROM diagnoses WHERE id = $1',
      [fixId]
    );
    if (!result.rows[0]) return null;

    const row = result.rows[0];

    // Use full issue details if available, otherwise reconstruct from patterns table
    let knownIssues = row.known_issues_detail || [];
    if ((!knownIssues || knownIssues.length === 0) && row.issues_pattern?.length > 0) {
      const patterns = await db.query(
        'SELECT id, title, severity FROM patterns WHERE id = ANY($1)',
        [row.issues_pattern]
      );
      knownIssues = row.issues_pattern.map(pid => {
        const p = patterns.rows.find(r => r.id === pid);
        return p ? { id: p.id, title: p.title, severity: p.severity, description: '' } : null;
      }).filter(Boolean);
    }

    return {
      fixId: row.id,
      timestamp: row.created_at.toISOString(),
      issuesFound: row.issues_count,
      knownIssues,
      analysis: row.ai_summary || `Pattern matching found ${row.issues_count} issue(s).`,
      fixScript: row.fix_script || null,
      aiInsights: row.ai_insights || '',
      model: row.ai_model || 'pattern-matching',
      systemInfo: {
        os: row.os ? `${row.os} (${row.arch || ''})` : null,
        nodeVersion: row.node_version || null,
        openclawVersion: row.openclaw_version || null,
        serviceManager: row.service_manager || null,
        serviceState: row.service_state || null,
      },
    };
  } catch (err) {
    console.error('Get diagnosis failed:', err.message);
    return null;
  }
}

/**
 * Get stats for the dashboard
 */
export async function getStats() {
  const db = getPool();
  if (!db) return null;

  try {
    const queries = getPublicStatsQueries();
    const [total, today, topIssues, versions, outcomes, serviceManagers, sigterms, zombies] = await Promise.all([
      db.query(queries.total),
      db.query(queries.today),
      db.query('SELECT id, title, severity, times_detected, success_rate FROM patterns ORDER BY times_detected DESC LIMIT 10'),
      db.query(queries.versions),
      db.query(queries.outcomes),
      db.query(queries.serviceManagers),
      db.query(queries.sigterms),
      db.query(queries.zombies),
    ]);

    return {
      totalDiagnoses: parseInt(total.rows[0].count),
      last24h: parseInt(today.rows[0].count),
      topIssues: topIssues.rows,
      versionBreakdown: versions.rows,
      outcomes: outcomes.rows,
      serviceManagerBreakdown: serviceManagers.rows,
      sigtermCrashes: parseInt(sigterms.rows[0].count),
      zombieProcesses: parseInt(zombies.rows[0].count),
    };
  } catch (err) {
    console.error('Get stats failed:', err.message);
    return null;
  }
}
