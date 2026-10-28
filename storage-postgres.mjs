const storageFailure = () => Object.assign(new Error('O armazenamento está temporariamente indisponível. Tente novamente.'), { status: 503 });
const configurationFailure = () => new Error('Configuração do Postgres inválida. Informe uma DATABASE_URL PostgreSQL com TLS verificado.');
const snapshotFailure = () => new Error('O estado persistido do aplicativo está inválido.');

export function postgresConnectionOptions(connectionString) {
  let url;
  try {
    if (typeof connectionString !== 'string' || !connectionString.trim()) throw new Error();
    url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2) throw new Error();
    const mode = url.searchParams.get('sslmode');
    if (mode && !['require', 'verify-ca', 'verify-full'].includes(mode)) throw new Error();
  } catch {
    throw configurationFailure();
  }
  // pg replaces its ssl object when these URL parameters are present. Keep one
  // explicit TLS policy, including certificate and hostname verification.
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('ssl') || key.toLowerCase() === 'uselibpqcompat') url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    query_timeout: 10000,
    allowExitOnIdle: true,
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || !Array.isArray(snapshot.users) || !snapshot.users.length || !Array.isArray(snapshot.requests)) {
    throw snapshotFailure();
  }
}

function parseRow(row) {
  if (!row) throw storageFailure();
  validateSnapshot(row.snapshot);
  let version;
  try {
    version = BigInt(row.version);
    if (version < 1n) throw new Error();
  } catch {
    throw snapshotFailure();
  }
  return { snapshot: row.snapshot, version: version.toString() };
}

export async function createPostgresStore({ connectionString, bootstrapAdmin, Pool: suppliedPool } = {}) {
  const options = postgresConnectionOptions(connectionString);
  let Pool = suppliedPool;
  if (!Pool) {
    try {
      ({ Pool } = await import('pg'));
    } catch {
      throw new Error('Instale as dependências do servidor para usar o Postgres.');
    }
  }
  const pool = new Pool(options);
  pool.on?.('error', () => {});
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await pool.end();
  };
  const readSnapshot = async () => {
    try {
      const result = await pool.query('SELECT snapshot, version::text AS version FROM public.ambulancia_state WHERE singleton = 1');
      return parseRow(result.rows[0]);
    } catch {
      throw storageFailure();
    }
  };
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS public.ambulancia_state (
      singleton smallint PRIMARY KEY CHECK (singleton = 1),
      version bigint NOT NULL CHECK (version >= 1),
      snapshot jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    let result = await pool.query('SELECT snapshot, version::text AS version FROM public.ambulancia_state WHERE singleton = 1');
    if (!result.rows.length) {
      const admin = typeof bootstrapAdmin === 'function' ? bootstrapAdmin() : bootstrapAdmin;
      if (!admin) throw new Error('Banco vazio. Configure BOOTSTRAP_ADMIN_JSON de forma privada para criar o primeiro MASTER.');
      const snapshot = { users: [admin], requests: [] };
      validateSnapshot(snapshot);
      await pool.query(`INSERT INTO public.ambulancia_state (singleton, version, snapshot)
        VALUES (1, 1, $1::jsonb) ON CONFLICT (singleton) DO NOTHING`, [JSON.stringify(snapshot)]);
      result = await pool.query('SELECT snapshot, version::text AS version FROM public.ambulancia_state WHERE singleton = 1');
    }
    const initial = parseRow(result.rows[0]);
    return {
      initial,
      readSnapshot,
      async commit(snapshot, expectedVersion) {
        validateSnapshot(snapshot);
        try {
          const result = await pool.query(`UPDATE public.ambulancia_state
            SET snapshot = $1::jsonb, version = version + 1, updated_at = now()
            WHERE singleton = 1 AND version = $2::bigint
            RETURNING version::text AS version`, [JSON.stringify(snapshot), String(expectedVersion)]);
          if (!result.rows.length) {
            throw Object.assign(new Error('Os dados foram atualizados por outra instância. Atualize a página e tente novamente.'), {
              status: 409, code: 'SNAPSHOT_CONFLICT',
            });
          }
          return { snapshot, version: BigInt(result.rows[0].version).toString() };
        } catch (error) {
          if (error.code === 'SNAPSHOT_CONFLICT') throw error;
          throw storageFailure();
        }
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    // Never attach a driver error: its message can contain connection details.
    if (error.message?.startsWith('Banco vazio.') || error.message === snapshotFailure().message) throw error;
    throw storageFailure();
  }
}
