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

const memoryWebhookDeliveries = new Map();
const WEBHOOK_MEMORY_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_MEMORY_MAX = 1000;

function validWebhookKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
}

export async function claimWebhookDelivery(provider, eventId, { db = getPool(), now = Date.now() } = {}) {
  if (!validWebhookKey(provider) || !validWebhookKey(eventId)) return false;
  if (db) {
    try {
      const result = await db.query(`
        INSERT INTO webhook_deliveries (provider, event_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        RETURNING event_id
      `, [provider, eventId]);
      void db.query("DELETE FROM webhook_deliveries WHERE created_at < NOW() - INTERVAL '7 days'")
        .catch(err => console.warn('Webhook idempotency cleanup failed:', err.message));
      return result.rowCount === 1;
    } catch (err) {
      console.error('Webhook idempotency claim failed:', err.message);
      return false;
    }
  }

  for (const [key, createdAt] of memoryWebhookDeliveries) {
    if (now - createdAt > WEBHOOK_MEMORY_TTL_MS) memoryWebhookDeliveries.delete(key);
  }
  const key = `${provider}:${eventId}`;
  if (memoryWebhookDeliveries.has(key)) return false;
  memoryWebhookDeliveries.set(key, now);
  while (memoryWebhookDeliveries.size > WEBHOOK_MEMORY_MAX) {
    const oldest = memoryWebhookDeliveries.keys().next();
    if (oldest.done) break;
    memoryWebhookDeliveries.delete(oldest.value);
  }
  return true;
}

export async function releaseWebhookDelivery(provider, eventId, { db = getPool() } = {}) {
  if (!validWebhookKey(provider) || !validWebhookKey(eventId)) return;
  if (db) {
    try {
      await db.query('DELETE FROM webhook_deliveries WHERE provider = $1 AND event_id = $2', [provider, eventId]);
    } catch (err) {
      console.error('Webhook idempotency release failed:', err.message);
    }
    return;
  }
  memoryWebhookDeliveries.delete(`${provider}:${eventId}`);
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

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (provider, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at);

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
    const [total, today, topIssues, versions, outcomes, serviceManagers, sigterms, zombies] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM diagnoses'),
      db.query("SELECT COUNT(*) as count FROM diagnoses WHERE created_at > NOW() - INTERVAL '24 hours'"),
      db.query('SELECT id, title, severity, times_detected, success_rate FROM patterns ORDER BY times_detected DESC LIMIT 10'),
      db.query('SELECT openclaw_version, COUNT(*) as count FROM diagnoses WHERE openclaw_version IS NOT NULL GROUP BY openclaw_version ORDER BY count DESC LIMIT 5'),
      db.query("SELECT outcome, COUNT(*) as count FROM diagnoses GROUP BY outcome"),
      db.query("SELECT service_manager, COUNT(*) as count FROM diagnoses WHERE service_manager IS NOT NULL GROUP BY service_manager ORDER BY count DESC"),
      db.query("SELECT COUNT(*) as count FROM diagnoses WHERE sigterm_count > 0 OR service_state = 'sigterm'"),
      db.query("SELECT COUNT(*) as count FROM diagnoses WHERE service_state = 'crashed' OR service_state = 'failed'"),
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
