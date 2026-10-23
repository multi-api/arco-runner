export type ServiceName = 'mysql' | 'pgsql' | 'redis';

export type TestsSpec = {
  command: string;
  setup_commands: string[];
  services: ServiceName[];
  primary_database: 'mysql' | 'pgsql' | null;
  timeout_seconds: number;
  env: Record<string, string>;
  mask: string[];
};

const SERVICE_NAMES: readonly string[] = ['mysql', 'pgsql', 'redis'];
const DEFAULT_TESTS_TIMEOUT_SECONDS = 900;

export type JobDocument = {
  deployment_id: string;
  environment: string;
  mode: 'deploy' | 'inventory';
  nonce: string;
  runner_token: string;
  source: { clone_url: string; auth_header: string; sha: string; root_dir: string };
  php_version: string;
  commands: string[];
  env: Record<string, string>;
  mask: string[];
  cache: { restore_url: string; save_url: string; key: string };
  timeout_seconds: number;
  defer_credentials: boolean;
  tests: TestsSpec | null;
};

export type TicketPayload = { ticket: string; api_base: string; deployment_id: string };

export class InvalidJobDocument extends Error {
  constructor(message: string) {
    super(`invalid job document: ${message}`);
    this.name = 'InvalidJobDocument';
  }
}

export class InvalidTicketPayload extends Error {
  constructor(message: string) {
    super(`invalid ticket payload: ${message}`);
    this.name = 'InvalidTicketPayload';
  }
}

type Fail = (message: string) => never;

const obj = (x: unknown, path: string, fail: Fail): Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) fail(`${path} must be an object`);
  return x as Record<string, unknown>;
};

/** PHP's json_encode turns an empty map into `[]`; accept that as an empty object. */
const objOrEmptyList = (x: unknown, path: string, fail: Fail): Record<string, unknown> =>
  Array.isArray(x) && x.length === 0 ? {} : obj(x, path, fail);

const str = (o: Record<string, unknown>, key: string, path: string, fail: Fail): string => {
  const v = o[key];
  if (typeof v !== 'string') fail(`${path}${key} must be a string`);
  return v as string;
};

const strList = (v: unknown, path: string, fail: Fail): string[] => {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) fail(`${path} must be an array of strings`);
  return [...(v as string[])];
};

const parseTests = (x: unknown, fail: Fail): TestsSpec | null => {
  if (x === undefined || x === null) return null;
  const t = obj(x, 'tests', fail);
  const services = strList(t.services, 'tests.services', fail);
  for (const name of services) if (!SERVICE_NAMES.includes(name)) fail(`tests.services has unknown service "${name}"`);
  if (new Set(services).size !== services.length) fail('tests.services must not repeat a service');

  const primaryIn = t.primary_database ?? null;
  if (primaryIn !== null && primaryIn !== 'mysql' && primaryIn !== 'pgsql') {
    fail('tests.primary_database must be "mysql", "pgsql" or null');
  }
  if (primaryIn !== null && !services.includes(primaryIn as string)) {
    fail('tests.primary_database must be one of tests.services');
  }
  const primary = (primaryIn ?? services.find((n) => n === 'mysql' || n === 'pgsql') ?? null) as TestsSpec['primary_database'];

  const timeoutIn = t.timeout_seconds ?? DEFAULT_TESTS_TIMEOUT_SECONDS;
  if (typeof timeoutIn !== 'number' || !Number.isFinite(timeoutIn)) {
    fail('tests.timeout_seconds must be a number or null');
  }

  const envIn = t.env === undefined || t.env === null ? {} : objOrEmptyList(t.env, 'tests.env', fail);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envIn)) {
    if (typeof v !== 'string') fail(`tests.env.${k} must be a string`);
    env[k] = v as string;
  }

  return {
    command: str(t, 'command', 'tests.', fail),
    setup_commands: strList(t.setup_commands ?? [], 'tests.setup_commands', fail),
    services: services as ServiceName[],
    primary_database: primary,
    timeout_seconds: (timeoutIn as number) > 0 ? (timeoutIn as number) : DEFAULT_TESTS_TIMEOUT_SECONDS,
    env,
    mask: strList(t.mask ?? [], 'tests.mask', fail),
  };
};

export function parseJobDocument(x: unknown): JobDocument {
  const fail: Fail = (m) => { throw new InvalidJobDocument(m); };
  const o = obj(x, 'document', fail);
  const mode = o.mode;
  if (mode !== 'deploy' && mode !== 'inventory') fail('mode must be "deploy" or "inventory"');

  const s = obj(o.source, 'source', fail);
  const sha = str(s, 'sha', 'source.', fail);
  if (!/^[0-9a-f]{40}$/.test(sha)) fail('source.sha must be 40 lowercase hex characters');
  const rootDir = s.root_dir ?? '';
  if (typeof rootDir !== 'string') fail('source.root_dir must be a string or null');

  const envIn = objOrEmptyList(o.env, 'env', fail);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envIn)) {
    if (typeof v !== 'string') fail(`env.${k} must be a string`);
    env[k] = v as string;
  }

  const c = obj(o.cache, 'cache', fail);
  if (typeof o.timeout_seconds !== 'number' || !Number.isFinite(o.timeout_seconds)) fail('timeout_seconds must be a number');

  return {
    deployment_id: str(o, 'deployment_id', '', fail),
    environment: str(o, 'environment', '', fail),
    mode: mode as JobDocument['mode'],
    nonce: str(o, 'nonce', '', fail),
    runner_token: str(o, 'runner_token', '', fail),
    source: {
      clone_url: str(s, 'clone_url', 'source.', fail),
      auth_header: str(s, 'auth_header', 'source.', fail),
      sha,
      root_dir: rootDir as string,
    },
    php_version: str(o, 'php_version', '', fail),
    commands: strList(o.commands, 'commands', fail),
    env,
    mask: strList(o.mask, 'mask', fail),
    cache: {
      restore_url: str(c, 'restore_url', 'cache.', fail),
      save_url: str(c, 'save_url', 'cache.', fail),
      key: str(c, 'key', 'cache.', fail),
    },
    timeout_seconds: o.timeout_seconds as number,
    defer_credentials: o.defer_credentials === true,
    tests: parseTests(o.tests, fail),
  };
}

export function parseTicketPayload(x: unknown, allowHttp: boolean): TicketPayload {
  const fail: Fail = (m) => { throw new InvalidTicketPayload(m); };
  const o = obj(x, 'payload', fail);
  const ticket = str(o, 'ticket', '', fail);
  const apiBase = str(o, 'api_base', '', fail);
  const deploymentId = str(o, 'deployment_id', '', fail);
  if (!ticket) fail('ticket must not be empty');
  if (!(apiBase.startsWith('https://') || (allowHttp && apiBase.startsWith('http://')))) {
    fail('api_base must be https://');
  }
  return { ticket, api_base: apiBase, deployment_id: deploymentId };
}
