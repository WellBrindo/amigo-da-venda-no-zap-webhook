const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(command, args = []) {
  const response = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      command,
      args
    })
  });

  if (!response.ok) {
    throw new Error(`Redis error: ${response.status}`);
  }

  const data = await response.json();
  return data.result;
}

export async function redisGet(key) {
  return redisCommand("GET", [key]);
}

export async function redisSet(key, value) {
  return redisCommand("SET", [key, value]);
}

export async function redisPing() {
  return redisCommand("PING");
}
