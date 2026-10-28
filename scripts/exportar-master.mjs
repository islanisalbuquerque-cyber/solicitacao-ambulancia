import { open, readFile, realpath, stat, unlink, access } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Never print records, credentials, salt, hash, raw filesystem or JSON errors.
class ExportError extends Error {}
const fail = (message) => { throw new ExportError(message); };
const canonicalEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (value) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const inside = (root, target) => {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

function argumentsFrom(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--users', '--email', '--out'].includes(key) || result.has(key)
      || !value || value.startsWith('--')) fail('Use --users CAMINHO --email EMAIL --out CAMINHO, uma vez cada.');
    result.set(key, value);
  }
  if (result.size !== 3) fail('Informe --users CAMINHO --email EMAIL --out CAMINHO.');
  const email = canonicalEmail(result.get('--email'));
  if (!validEmail(email)) fail('Informe um e-mail válido para selecionar o MASTER.');
  return { users: resolve(result.get('--users')), email, out: resolve(result.get('--out')) };
}

async function privateDestination(output) {
  const filename = basename(output);
  if (!filename.toLowerCase().endsWith('.json') || /[:\x00-\x1f]/.test(filename)) {
    fail('O destino deve ser um arquivo .json novo em uma pasta privada.');
  }
  let directory;
  let application;
  try {
    directory = await realpath(dirname(output));
    application = await realpath(fileURLToPath(new URL('../', import.meta.url)));
    if (!(await stat(directory)).isDirectory()) throw new Error();
  } catch {
    fail('Crie antes uma pasta privada de destino fora do código e da publicação, como work/private do workspace.');
  }
  const destination = join(directory, filename);
  const parts = destination.split(/[\\/]+/).map((part) => part.toLowerCase());
  const blocked = new Set(['.git', '.github', 'data', 'src', 'scripts', 'res', 'node_modules',
    'publicacao-ambulancia', 'android-app', 'ambulancia-android']);
  if (inside(application, destination) || parts.some((part) => blocked.has(part))) {
    fail('Destino recusado: mantenha o segredo fora de código, publicação, .git e dados do aplicativo.');
  }
  // The surrounding Codex workspace may itself be a Git repository. Its explicit
  // work/private staging area is allowed, but a repository's source tree is not.
  let ancestor = directory;
  while (true) {
    let repository = false;
    try { await access(join(ancestor, '.git')); repository = true; } catch { /* No Git marker here. */ }
    if (repository) {
      const relativeParts = relative(ancestor, directory).split(sep).map((part) => part.toLowerCase());
      const privateWork = relativeParts.some((part, index) => part === 'work' && relativeParts[index + 1] === 'private');
      if (!privateWork) fail('Destino dentro de um repositório: use uma pasta privada externa, ou work/private do workspace fora da aplicação.');
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return destination;
}

function selectMaster(records, email) {
  if (!Array.isArray(records) || !records.length) fail('O cadastro de usuários deve ser uma lista JSON não vazia.');
  const matches = records.filter((user) => user && typeof user === 'object'
    && !Array.isArray(user) && canonicalEmail(user.email) === email);
  if (matches.length !== 1 || matches[0].role !== 'master' || matches[0].deletedAt) {
    fail('O e-mail deve corresponder a exatamente um MASTER ativo no cadastro.');
  }
  const user = matches[0];
  if (Object.hasOwn(user, 'password') || user.algorithm !== 'scrypt'
    || typeof user.salt !== 'string' || !/^[a-f0-9]{64}$/.test(user.salt)
    || typeof user.hash !== 'string' || !/^[a-f0-9]{128}$/.test(user.hash)
    || typeof user.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(user.id)
    || typeof user.name !== 'string' || !user.name.trim() || user.name.trim().length > 120
    || typeof user.createdAt !== 'string' || user.createdAt.length > 64 || !Number.isFinite(Date.parse(user.createdAt))) {
    fail('O MASTER selecionado não possui um registro scrypt válido com identificador, nome e data.');
  }
  return {
    id: user.id,
    name: user.name.trim(),
    email,
    role: 'master',
    createdAt: user.createdAt,
    algorithm: 'scrypt',
    salt: user.salt,
    hash: user.hash,
  };
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (!args) {
    console.log('Uso: node scripts/exportar-master.mjs --users CAMINHO --email EMAIL --out CAMINHO');
    console.log('Exporta um MASTER ativo para arquivo JSON novo e privado. Não exibe o conteúdo.');
    console.log('Use pasta externa ao código/publicação; work/private do workspace é aceito.');
    console.log('Trate o resultado como segredo e use-o somente em BOOTSTRAP_ADMIN_JSON no painel do Render.');
    return;
  }
  const destination = await privateDestination(args.out);
  let records;
  try {
    const metadata = await stat(args.users);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new Error();
    records = JSON.parse((await readFile(args.users, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    fail('Não foi possível ler um cadastro JSON local válido. Nenhum conteúdo foi exibido.');
  }
  const payload = JSON.stringify(selectMaster(records, args.email));
  if (Buffer.byteLength(payload, 'utf8') > 8192) fail('O registro ultrapassa o limite do bootstrap do servidor.');
  let handle;
  let created = false;
  try {
    handle = await open(destination, 'wx', 0o600);
    created = true;
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(destination).catch(() => {});
    if (error.code === 'EEXIST') fail('O destino já existe. Escolha um arquivo novo; nenhum arquivo foi sobrescrito.');
    fail('Não foi possível criar o arquivo privado. Confira as permissões da pasta de destino.');
  }
  await handle.close();
  console.log('Arquivo privado criado. Nenhum registro ou segredo foi exibido.');
  console.log('Use o conteúdo somente em BOOTSTRAP_ADMIN_JSON no painel do Render; nunca envie ao GitHub.');
  if (process.platform === 'win32') console.log('No Windows, proteja também o acesso à pasta privada; modo600 não substitui as permissões NTFS.');
}

await main().catch((error) => {
  console.error(error instanceof ExportError ? error.message : 'A exportação não pôde ser concluída. Nenhum segredo foi exibido.');
  process.exitCode = 1;
});
