const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function ensureRedisEnv() {
  if (!redisUrl || !redisToken) {
    throw new Error('Missing Redis env: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
  }
}

async function runCommand(command) {
  ensureRedisEnv();

  const response = await fetch(redisUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`Redis request failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`Redis command error: ${data.error}`);
  }

  return data.result;
}

export async function redisSetJson(key, value) {
  return runCommand(['SET', key, JSON.stringify(value)]);
}

export async function redisGetJson(key) {
  const raw = await runCommand(['GET', key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function redisZadd(key, score, member) {
  return runCommand(['ZADD', key, String(score), member]);
}

export async function redisZrevrange(key, start, stop) {
  return runCommand(['ZREVRANGE', key, String(start), String(stop)]);
}

export async function redisZrem(key, member) {
  return runCommand(['ZREM', key, member]);
}

export async function redisSadd(key, member) {
  return runCommand(['SADD', key, member]);
}

export async function redisSrem(key, member) {
  return runCommand(['SREM', key, member]);
}

export async function redisSmembers(key) {
  return runCommand(['SMEMBERS', key]);
}

export async function redisDel(key) {
  return runCommand(['DEL', key]);
}

export async function redisIncr(key) {
  return runCommand(['INCR', key]);
}

export async function redisExpire(key, seconds) {
  return runCommand(['EXPIRE', key, String(seconds)]);
}

export async function redisSetNx(key, value, ttlSeconds) {
  return runCommand(['SET', key, value, 'EX', String(ttlSeconds), 'NX']);
}
