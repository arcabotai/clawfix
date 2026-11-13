let workerEnv = null;

export function setRuntimeEnv(env) {
  if (env && typeof env === 'object') workerEnv = env;
}

export function clearRuntimeEnv() {
  workerEnv = null;
}

export function getRuntimeEnv(nodeEnv = process.env) {
  return workerEnv || nodeEnv;
}

export function getRuntimeValue(name, nodeEnv = process.env) {
  if (workerEnv && Object.hasOwn(workerEnv, name)) return workerEnv[name];
  return nodeEnv?.[name];
}

export function resolveDatabaseUrl(nodeEnv = process.env) {
  const hyperdrive = workerEnv?.HYPERDRIVE;
  if (typeof hyperdrive?.connectionString === 'string' && hyperdrive.connectionString) {
    return hyperdrive.connectionString;
  }
  const workerDatabaseUrl = workerEnv?.DATABASE_URL;
  if (typeof workerDatabaseUrl === 'string' && workerDatabaseUrl) return workerDatabaseUrl;
  return nodeEnv?.DATABASE_URL || '';
}

export function hasHyperdriveBinding() {
  return typeof workerEnv?.HYPERDRIVE?.connectionString === 'string'
    && workerEnv.HYPERDRIVE.connectionString.length > 0;
}
