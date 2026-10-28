import { createServer } from 'node:http';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { createPostgresStore } from './storage-postgres.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const hashOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const sessionLifetime = 8 * 60 * 60 * 1000;
const attemptWindow = 15 * 60 * 1000;
const cookieName = 'ambulancia_session';
const roles = new Set(['mlp', 'master']);
const statuses = new Set(['pendente', 'aprovada', 'reprovada']);
const allXpts = Object.freeze(['ECE2', 'ECE3', 'ECE4', 'ECE5', 'ECE6', 'ECE7', 'ECE8', 'EPI1', 'EPI8']);
const sce1Carriers = Object.freeze(['50 MAIS', 'AC2 LOGISTICA', 'DHL', 'E-LOG', 'KANGU LOGISTICS', 'LOG SERVICOS', 'MAXXLOG', 'MORAIS', 'RODACOOP', 'WLS CARGO']);
const sce2Carriers = Object.freeze(['AC2 LOGISTICA', '50 MAIS', 'RODACOOP', 'ECO EXPRESS', 'WLS CARGO', 'E-LOG']);
const options = Object.freeze({
  svcs: Object.freeze(['SCE1', 'SCE2']),
  xpts: Object.freeze([...allXpts, 'SVC']),
  reasons: Object.freeze(['Escoamentos de Insucessos', 'Dispersão', 'SPR Alto', 'Excesso de Cubagem', 'Rota Manual']),
  carriers: Object.freeze([...sce1Carriers, 'ECO EXPRESS']),
  svcOptions: Object.freeze({
    SCE1: Object.freeze({ carriers: sce1Carriers, xpts: Object.freeze(['ECE3', 'SVC']) }),
    SCE2: Object.freeze({ carriers: sce2Carriers, xpts: allXpts }),
  }),
});
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/inicio', ['inicio.html', 'text/html; charset=utf-8']],
  ['/inicio.html', ['inicio.html', 'text/html; charset=utf-8']],
  ['/src/style.css', ['src/style.css', 'text/css; charset=utf-8']],
  ['/src/app.css', ['src/app.css', 'text/css; charset=utf-8']],
  ['/src/login.js', ['src/login.js', 'text/javascript; charset=utf-8']],
  ['/src/home.js', ['src/home.js', 'text/javascript; charset=utf-8']],
  ['/src/icons.js', ['src/icons.js', 'text/javascript; charset=utf-8']],
  ['/src/dashboard.js', ['src/dashboard.js', 'text/javascript; charset=utf-8']],
  ['/src/dashboard.css', ['src/dashboard.css', 'text/css; charset=utf-8']],
  ['/src/assets/mercadolivre-logo.webp', ['src/assets/mercadolivre-logo.webp', 'image/webp']],
  ['/src/assets/favicon.svg', ['src/assets/favicon.svg', 'image/svg+xml']],
]);

const digest = (token) => createHash('sha256').update(token).digest('hex');
const cookie = (token, maxAge, secure = false) => `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const fail = (status, message, retryAfter) => Object.assign(new Error(message), { status, retryAfter });
const canonicalEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (value) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isActiveUser = (user) => Boolean(user) && !user.deletedAt;

function sessionToken(request) {
  const match = (request.headers.cookie || '').split(';').map((value) => value.trim())
    .find((value) => value.startsWith(`${cookieName}=`));
  const token = match?.slice(cookieName.length + 1) || '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    return Promise.reject(fail(400, 'Envie os dados no formato JSON.'));
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const reject = (error) => {
      if (!settled) {
        settled = true;
        chunks.length = 0;
        rejectBody(error);
      }
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > 4096) {
        reject(fail(400, 'Dados maiores que o limite permitido.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        settled = true;
        resolveBody(value);
      } catch {
        reject(fail(400, 'Dados inválidos.'));
      }
    });
    request.on('aborted', () => reject(fail(400, 'Envio de dados interrompido.')));
    request.on('error', () => reject(fail(400, 'Não foi possível receber os dados.')));
  });
}

function requiredString(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw fail(400, `${label} deve conter de 1 a ${maximum} caracteres.`);
  }
  return value.trim();
}

function selectedOptions(value, allowed, label) {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || !allowed.includes(value[0])) {
    throw fail(400, `Selecione exatamente uma opção válida para ${label}.`);
  }
  return [value[0]];
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 1000000) {
    throw fail(400, `${label} deve ser um número inteiro entre 1 e 1000000.`);
  }
  return value;
}

function publicUser(user, includeCreatedAt = false) {
  const value = { id: user.id, name: user.name, email: user.email, role: user.role };
  if (includeCreatedAt) value.createdAt = user.createdAt;
  return value;
}

function publicRequest(record) {
  return {
    id: record.id,
    protocol: record.protocol,
    name: record.name,
    email: record.email,
    carrier: record.carrier || '',
    svcs: [...record.svcs],
    xpts: [...record.xpts],
    routeId: record.routeId,
    loadedModal: record.loadedModal,
    packageCount: record.packageCount,
    stopCount: record.stopCount,
    ambulanceModal: record.ambulanceModal,
    reasons: [...record.reasons],
    createdAt: record.createdAt,
    status: record.status,
    createdById: record.createdById,
    decision: record.decision ? {
      byId: record.decision.byId,
      byName: record.decision.byName,
      byEmail: record.decision.byEmail,
      at: record.decision.at,
      note: record.decision.note,
    } : null,
  };
}

function requestFields(body, user) {
  const name = requiredString(body.name, 120, 'Nome');
  const email = canonicalEmail(body.email);
  if (!validEmail(email) || email !== user.email) {
    throw fail(400, 'O e-mail da solicitação deve ser o mesmo da sua conta.');
  }
  const svcs = selectedOptions(body.svcs, options.svcs, 'SVC');
  const svcOptions = options.svcOptions[svcs[0]];
  if (typeof body.carrier !== 'string' || !svcOptions.carriers.includes(body.carrier)) {
    throw fail(400, 'Selecione uma transportadora válida para o SVC informado.');
  }
  return {
    name,
    email: user.email,
    carrier: body.carrier,
    svcs,
    xpts: selectedOptions(body.xpts, svcOptions.xpts, 'XPT do SVC informado'),
    routeId: requiredString(body.routeId, 80, 'ID da rota'),
    loadedModal: requiredString(body.loadedModal, 80, 'Modal carregado'),
    packageCount: positiveInteger(body.packageCount, 'Quantidade de pacotes'),
    stopCount: positiveInteger(body.stopCount, 'Quantidade de paradas'),
    ambulanceModal: requiredString(body.ambulanceModal, 80, 'Modal da ambulância'),
    reasons: selectedOptions(body.reasons, options.reasons, 'motivo'),
  };
}

function protocolFor(records, date) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  const prefix = `AMB-${parts.year}${parts.month}${parts.day}-`;
  let sequence = 0;
  for (const record of records) {
    if (typeof record.protocol !== 'string' || !record.protocol.startsWith(prefix)) continue;
    const suffix = record.protocol.slice(prefix.length);
    if (/^\d+$/.test(suffix)) sequence = Math.max(sequence, Number(suffix));
  }
  return `${prefix}${String(sequence + 1).padStart(4, '0')}`;
}

async function atomicWriteJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function validateUsers(records) {
  if (!Array.isArray(records) || !records.length || records.some((user) =>
    !user || typeof user !== 'object' || Array.isArray(user) ||
    !validEmail(canonicalEmail(user.email)) || user.algorithm !== 'scrypt' ||
    !/^[a-f0-9]{64}$/.test(user.salt) || !/^[a-f0-9]{128}$/.test(user.hash)
  )) throw new Error('Cadastro de usuários indisponível ou inválido.');
}

function validateRequests(requests) {
  if (!Array.isArray(requests) || requests.some((record) =>
    !record || typeof record !== 'object' || Array.isArray(record) ||
    typeof record.id !== 'string' || typeof record.protocol !== 'string' ||
    typeof record.createdById !== 'string' || !statuses.has(record.status) ||
    !Array.isArray(record.svcs) || !Array.isArray(record.xpts) || !Array.isArray(record.reasons)
  )) throw new Error('O arquivo de solicitações está inválido.');
}

function validatedPublicOrigin(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error('PUBLIC_ORIGIN deve ser uma origem HTTPS válida, sem caminho, credenciais ou parâmetros.');
  }
}

function bootstrapAdmin(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 8192) throw new Error();
    const user = JSON.parse(value);
    if (!user || typeof user !== 'object' || Array.isArray(user) || Object.hasOwn(user, 'password')
      || user.deletedAt || (user.role !== undefined && user.role !== 'master')) throw new Error();
    const record = {
      id: user.id || randomUUID(),
      name: requiredString(user.name, 120, 'Nome'),
      email: canonicalEmail(user.email),
      role: 'master',
      createdAt: user.createdAt || new Date().toISOString(),
      algorithm: user.algorithm,
      salt: user.salt,
      hash: user.hash,
    };
    validateUsers([record]);
    if (typeof record.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id)
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error();
    return record;
  } catch {
    throw new Error('BOOTSTRAP_ADMIN_JSON inválido. Informe um registro MASTER scrypt, sem senha em texto.');
  }
}

export async function createLocalServer({
  dataDir = join(root, 'data'), databaseUrl = '', publicOrigin = '',
  trustProxyHops = 0, bootstrapAdminJson = '', postgresPool,
} = {}) {
  const configuredOrigin = validatedPublicOrigin(publicOrigin);
  if (databaseUrl && !configuredOrigin) throw new Error('O modo Postgres exige PUBLIC_ORIGIN HTTPS.');
  if (trustProxyHops !== 0 && trustProxyHops !== 1) throw new Error('TRUST_PROXY_HOPS deve ser 0 ou 1.');
  const storage = resolve(dataDir);
  const usersFile = join(storage, 'users.json');
  const requestsFile = join(storage, 'requests.json');
  let records;
  let requests;
  let allUsersByEmail;
  let usersById;
  let postgresStore = null;
  let storageVersion;
  try {
    if (databaseUrl) {
      postgresStore = await createPostgresStore({
        connectionString: databaseUrl,
        bootstrapAdmin: () => bootstrapAdmin(bootstrapAdminJson),
        Pool: postgresPool,
      });
      records = postgresStore.initial.snapshot.users;
      requests = postgresStore.initial.snapshot.requests;
      storageVersion = postgresStore.initial.version;
    } else {
      records = JSON.parse(await readFile(usersFile, 'utf8'));
    }
    validateUsers(records);
    const migrationTime = new Date().toISOString();
    let migrated = false;
    records = records.map((user) => {
      const migratedUser = {
        ...user,
        id: typeof user.id === 'string' && user.id.trim() ? user.id : randomUUID(),
        name: typeof user.name === 'string' && user.name.trim() ? user.name : 'Administrador',
        email: canonicalEmail(user.email),
        role: roles.has(user.role) ? user.role : 'master',
        createdAt: typeof user.createdAt === 'string' && Number.isFinite(Date.parse(user.createdAt)) ? user.createdAt : migrationTime,
      };
      if (Object.entries(migratedUser).some(([key, value]) => user[key] !== value)) migrated = true;
      return migratedUser;
    });
    allUsersByEmail = new Map(records.map((user) => [user.email, user]));
    usersById = new Map(records.filter(isActiveUser).map((user) => [user.id, user]));
    if (allUsersByEmail.size !== records.length || new Set(records.map((user) => user.id)).size !== records.length) {
      throw new Error('O cadastro possui e-mails ou identificadores repetidos.');
    }
    let missingRequests = false;
    if (!postgresStore) {
      try {
        requests = JSON.parse(await readFile(requestsFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        requests = [];
        missingRequests = true;
      }
    }
    validateRequests(requests);
    if (postgresStore) {
      if (migrated) {
        const committed = await postgresStore.commit({ users: records, requests }, storageVersion);
        storageVersion = committed.version;
      }
    } else {
      await mkdir(storage, { recursive: true, mode: 0o700 });
      if (migrated) await atomicWriteJson(usersFile, records);
      if (missingRequests) await atomicWriteJson(requestsFile, requests);
    }
  } catch (error) {
    await postgresStore?.close().catch(() => {});
    throw error;
  }

  let pendingWrites = Promise.resolve();
  const enqueue = (operation) => {
    const result = pendingWrites.then(operation);
    pendingWrites = result.catch(() => {});
    return result;
  };
  const sessions = new Map();
  const attempts = new Map();
  let activeHashes = 0;

  const refreshUnlocked = async () => {
    if (!postgresStore) return;
    try {
      const next = await postgresStore.readSnapshot();
      validateUsers(next.snapshot.users);
      validateRequests(next.snapshot.requests);
      if (BigInt(next.version) < BigInt(storageVersion) || next.snapshot.users.some((user) =>
        typeof user.id !== 'string' || !user.id || typeof user.name !== 'string' || !user.name.trim()
        || !roles.has(user.role) || user.email !== canonicalEmail(user.email)
      ) || new Set(next.snapshot.users.map((user) => user.id)).size !== next.snapshot.users.length
        || new Set(next.snapshot.users.map((user) => user.email)).size !== next.snapshot.users.length) throw new Error();
      records = next.snapshot.users;
      requests = next.snapshot.requests;
      storageVersion = next.version;
      reindexUsers();
      for (const [key, session] of sessions) {
        if (!usersById.has(session.userId)) sessions.delete(key);
      }
    } catch {
      throw fail(503, 'O armazenamento está temporariamente indisponível. Tente novamente.');
    }
  };
  const refreshState = () => postgresStore ? enqueue(refreshUnlocked) : Promise.resolve();
  const serializeWrite = (operation) => enqueue(async () => {
    await refreshUnlocked();
    try {
      return await operation();
    } catch (error) {
      if (error.code === 'SNAPSHOT_CONFLICT') await refreshUnlocked();
      throw error;
    }
  });
  const persistUsers = async (nextRecords) => {
    if (postgresStore) {
      const committed = await postgresStore.commit({ users: nextRecords, requests }, storageVersion);
      storageVersion = committed.version;
    } else {
      await atomicWriteJson(usersFile, nextRecords);
    }
  };
  const persistRequests = async (nextRequests) => {
    if (postgresStore) {
      const committed = await postgresStore.commit({ users: records, requests: nextRequests }, storageVersion);
      storageVersion = committed.version;
    } else {
      await atomicWriteJson(requestsFile, nextRequests);
    }
  };

  function currentUser(request) {
    const token = sessionToken(request);
    if (!token) return null;
    const key = digest(token);
    const session = sessions.get(key);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return usersById.get(session.userId) || null;
  }

  function reindexUsers() {
    allUsersByEmail = new Map(records.map((user) => [user.email, user]));
    usersById = new Map(records.filter(isActiveUser).map((user) => [user.id, user]));
  }

  function requireOperationalActor(request, role) {
    const actor = currentUser(request);
    if (!actor) throw fail(401, 'Este acesso foi revogado. Entre para continuar.');
    requireRole(actor, role);
    return actor;
  }

  function assertEmailAvailable(email) {
    const existing = allUsersByEmail.get(email);
    if (!existing) return;
    throw fail(409, isActiveUser(existing)
      ? 'Já existe uma conta com este e-mail.'
      : 'Este e-mail pertence a uma conta excluída e permanece reservado.');
  }

  function enforceRate(request, category, limit) {
    let address = request.socket.remoteAddress;
    if (trustProxyHops === 1 && typeof request.headers['x-forwarded-for'] === 'string') {
      const candidate = request.headers['x-forwarded-for'].split(',').at(-1).trim();
      if (isIP(candidate)) address = candidate;
    }
    const key = `${category}:${address}`;
    let counter = attempts.get(key);
    if (!counter || counter.resetAt <= Date.now()) {
      counter = { count: 0, resetAt: Date.now() + attemptWindow };
      attempts.set(key, counter);
    }
    if (counter.count >= limit) {
      throw fail(429, 'Muitas tentativas. Aguarde antes de tentar novamente.', Math.max(1, Math.ceil((counter.resetAt - Date.now()) / 1000)));
    }
    counter.count += 1;
  }

  async function derivePassword(password, salt) {
    if (activeHashes >= 2) throw fail(429, 'Aguarde um instante e tente novamente.', 2);
    activeHashes += 1;
    try {
      return await derive(password, salt, 64, hashOptions);
    } finally {
      activeHashes -= 1;
    }
  }

  function requireRole(user, role) {
    if (user.role !== role) throw fail(403, 'Sua conta não tem permissão para esta ação.');
  }

  function requireMethod(request, response, allowed) {
    if (!allowed.includes(request.method)) {
      response.setHeader('Allow', allowed.join(', '));
      throw fail(405, 'Método não permitido.');
    }
  }

  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const port = server.address()?.port;
    const allowedHosts = configuredOrigin ? [new URL(configuredOrigin).host] : [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(request.headers.host)) {
      json(response, 403, { error: 'Endereço não permitido.' });
      return;
    }
    const origin = configuredOrigin || `http://${request.headers.host}`;
    if (request.headers['sec-fetch-site'] === 'cross-site' ||
      ((request.method === 'POST' || request.method === 'DELETE') && request.headers.origin !== origin)) {
      json(response, 403, { error: 'Origem não permitida.' });
      return;
    }

    try {
      const pathname = new URL(request.url, origin).pathname;
      if (pathname.startsWith('/api/')) await refreshState();
      if (pathname === '/api/health') {
        requireMethod(request, response, ['GET']);
        json(response, 200, { ok: true, storage: postgresStore ? 'postgres' : 'json' });
        return;
      }
      if (pathname === '/api/login') {
        requireMethod(request, response, ['POST']);
        enforceRate(request, 'login', 10);
        const body = await readJson(request);
        if (typeof body.email !== 'string' || typeof body.password !== 'string' ||
          !body.email.trim() || body.email.length > 254 || !body.password || Buffer.byteLength(body.password) > 1024) {
          throw fail(400, 'Informe e-mail e senha válidos.');
        }
        const candidate = allUsersByEmail.get(canonicalEmail(body.email));
        const user = isActiveUser(candidate) ? candidate : null;
        const record = user || records[0];
        let derived;
        try {
          derived = await derivePassword(body.password, Buffer.from(record.salt, 'hex'));
        } finally {
          body.password = '';
        }
        const matches = timingSafeEqual(derived, Buffer.from(record.hash, 'hex'));
        derived.fill(0);
        await refreshState();
        const activeUser = user && usersById.get(user.id);
        if (!user || !matches || !activeUser || activeUser.hash !== record.hash || activeUser.salt !== record.salt || activeUser.email !== user.email) {
          throw fail(401, 'E-mail ou senha inválidos.');
        }
        const previous = sessionToken(request);
        if (previous) sessions.delete(digest(previous));
        for (const [sessionKey, session] of sessions) {
          if (session.userId === user.id || session.expires <= Date.now()) sessions.delete(sessionKey);
        }
        const token = randomBytes(32).toString('hex');
        sessions.set(digest(token), { userId: user.id, expires: Date.now() + sessionLifetime });
        response.setHeader('Set-Cookie', cookie(token, sessionLifetime / 1000, Boolean(configuredOrigin)));
        json(response, 200, { ok: true });
        return;
      }

      if (pathname.startsWith('/api/')) {
        const user = currentUser(request);
        if (!user) throw fail(401, 'Entre para continuar.');

        if (pathname === '/api/session') {
          requireMethod(request, response, ['GET']);
          json(response, 200, { user: publicUser(user) });
          return;
        }

        if (pathname === '/api/logout') {
          requireMethod(request, response, ['POST']);
          const token = sessionToken(request);
          if (token) sessions.delete(digest(token));
          response.setHeader('Set-Cookie', cookie('', 0, Boolean(configuredOrigin)));
          json(response, 200, { ok: true });
          return;
        }

        if (pathname === '/api/options') {
          requireMethod(request, response, ['GET']);
          json(response, 200, options);
          return;
        }

        if (pathname === '/api/users') {
          requireRole(user, 'master');
          requireMethod(request, response, ['GET', 'POST']);
          if (request.method === 'GET') {
            json(response, 200, { users: records.filter(isActiveUser).map((record) => publicUser(record, true)) });
            return;
          }
          enforceRate(request, 'create-user', 20);
          const body = await readJson(request);
          const name = requiredString(body.name, 120, 'Nome');
          const email = canonicalEmail(body.email);
          if (!validEmail(email)) throw fail(400, 'Informe um e-mail válido.');
          if (!roles.has(body.role)) throw fail(400, 'Selecione o perfil MLP ou MASTER.');
          if (typeof body.password !== 'string' || body.password.length < 8 || Buffer.byteLength(body.password) > 1024) {
            throw fail(400, 'A senha deve conter ao menos 8 caracteres e até 1024 bytes.');
          }
          assertEmailAvailable(email);
          const salt = randomBytes(32);
          let derived;
          try {
            derived = await derivePassword(body.password, salt);
          } finally {
            body.password = '';
          }
          const record = {
            id: randomUUID(), name, email, role: body.role,
            createdAt: new Date().toISOString(),
            algorithm: 'scrypt', salt: salt.toString('hex'), hash: derived.toString('hex'),
          };
          derived.fill(0);
          await serializeWrite(async () => {
            requireOperationalActor(request, 'master');
            assertEmailAvailable(email);
            const nextRecords = [...records, record];
            await persistUsers(nextRecords);
            records = nextRecords;
            reindexUsers();
          });
          json(response, 201, { user: publicUser(record, true) });
          return;
        }

        const userPath = pathname.match(/^\/api\/users\/([^/]+)$/);
        if (userPath) {
          requireRole(user, 'master');
          requireMethod(request, response, ['DELETE']);
          let id;
          try {
            id = decodeURIComponent(userPath[1]);
          } catch {
            throw fail(400, 'Identificador de usuário inválido.');
          }
          await serializeWrite(async () => {
            const actor = requireOperationalActor(request, 'master');
            if (id === actor.id) throw fail(409, 'Você pode excluir apenas outros usuários.');
            const target = usersById.get(id);
            if (!target) throw fail(404, 'Usuário não encontrado.');
            if (target.role === 'master' && [...usersById.values()].filter((record) => record.role === 'master').length <= 1) {
              throw fail(409, 'Não é possível excluir o último MASTER ativo.');
            }
            const deletedAt = new Date().toISOString();
            const nextRecords = records.map((record) => record.id === id
              ? { ...record, deletedAt, deletedById: actor.id }
              : record);
            await persistUsers(nextRecords);
            records = nextRecords;
            reindexUsers();
            for (const [key, session] of sessions) {
              if (session.userId === id) sessions.delete(key);
            }
          });
          json(response, 200, { ok: true });
          return;
        }

        if (pathname === '/api/requests') {
          requireMethod(request, response, ['GET', 'POST']);
          if (request.method === 'GET') {
            const visible = user.role === 'master' ? requests : requests.filter((record) => record.createdById === user.id);
            json(response, 200, { requests: visible.map(publicRequest) });
            return;
          }
          requireRole(user, 'mlp');
          const fields = requestFields(await readJson(request), user);
          const record = await serializeWrite(async () => {
            const actor = requireOperationalActor(request, 'mlp');
            const created = new Date();
            const nextRequest = {
              id: randomUUID(),
              protocol: protocolFor(requests, created),
              ...fields,
              createdAt: created.toISOString(),
              status: 'pendente',
              createdById: actor.id,
              decision: null,
            };
            const nextRequests = [...requests, nextRequest];
            await persistRequests(nextRequests);
            requests = nextRequests;
            return nextRequest;
          });
          json(response, 201, { request: publicRequest(record) });
          return;
        }

        const decisionPath = pathname.match(/^\/api\/requests\/([^/]+)\/decision$/);
        if (decisionPath) {
          requireRole(user, 'master');
          requireMethod(request, response, ['POST']);
          const body = await readJson(request);
          if (body.status !== 'aprovada' && body.status !== 'reprovada') {
            throw fail(400, 'Selecione uma decisão válida.');
          }
          if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000)) {
            throw fail(400, 'A observação deve conter até 1000 caracteres.');
          }
          const id = decodeURIComponent(decisionPath[1]);
          const updated = await serializeWrite(async () => {
            const actor = requireOperationalActor(request, 'master');
            const index = requests.findIndex((record) => record.id === id);
            if (index < 0) throw fail(404, 'Solicitação não encontrada.');
            if (requests[index].status !== 'pendente') throw fail(409, 'Esta solicitação já recebeu uma decisão.');
            const record = {
              ...requests[index],
              status: body.status,
              decision: {
                byId: actor.id,
                byName: actor.name,
                byEmail: actor.email,
                at: new Date().toISOString(),
                note: body.note?.trim() || '',
              },
            };
            const nextRequests = [...requests];
            nextRequests[index] = record;
            await persistRequests(nextRequests);
            requests = nextRequests;
            return record;
          });
          json(response, 200, { request: publicRequest(updated) });
          return;
        }

        const detailPath = pathname.match(/^\/api\/requests\/([^/]+)$/);
        if (detailPath) {
          requireMethod(request, response, ['GET']);
          const id = decodeURIComponent(detailPath[1]);
          const record = requests.find((item) => item.id === id && (user.role === 'master' || item.createdById === user.id));
          if (!record) throw fail(404, 'Solicitação não encontrada.');
          json(response, 200, { request: publicRequest(record) });
          return;
        }

        throw fail(404, 'Recurso não encontrado.');
      }

      requireMethod(request, response, ['GET', 'HEAD']);
      if ((pathname === '/inicio' || pathname === '/inicio.html') && !currentUser(request)) {
        response.writeHead(303, { Location: '/' });
        response.end();
        return;
      }
      const asset = staticFiles.get(pathname);
      if (!asset) throw fail(404, 'Página não encontrada.');
      let content;
      try {
        content = await readFile(join(root, asset[0]));
      } catch (error) {
        if (error.code === 'ENOENT') throw fail(404, 'Arquivo não encontrado.');
        throw error;
      }
      response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
        json(response, error.status || 500, { error: error.status ? error.message : 'Não foi possível concluir. Tente novamente.' });
      }
    }
  });

  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 32;
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
    for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key);
  }, 60000);
  cleanup.unref();
  server.on('close', () => {
    clearInterval(cleanup);
    sessions.clear();
    attempts.clear();
    pendingWrites.then(() => postgresStore?.close()).catch(() => {});
  });
  return server;
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.PORT || process.argv[2] || 8787);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Porta inválida.');
    const publicOrigin = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '';
    const databaseUrl = process.env.DATABASE_URL || '';
    if (process.env.NODE_ENV === 'production' && !databaseUrl) throw new Error('Produção exige DATABASE_URL.');
    const host = process.env.HOST || (publicOrigin ? '0.0.0.0' : '127.0.0.1');
    if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) throw new Error('HOST inválido.');
    const server = await createLocalServer({
      dataDir: process.env.DATA_DIR || join(root, 'data'),
      databaseUrl,
      publicOrigin,
      trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),
      bootstrapAdminJson: process.env.BOOTSTRAP_ADMIN_JSON || '',
    });
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? 'A porta está em uso. Inicie com: node server.mjs 8788' : 'Não foi possível iniciar o servidor local.');
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`Solicitação de Ambulância: ${publicOrigin || `http://127.0.0.1:${port}`}`);
      console.log('Mantenha esta janela aberta enquanto usa o aplicativo. Ctrl+C para encerrar.');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch {
    console.error('Não foi possível iniciar. Confira a configuração, o armazenamento e o README.txt.');
    process.exitCode = 1;
  }
}
