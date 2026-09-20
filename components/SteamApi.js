import { Config } from "./Config.js"

const DEFAULT_API_BASE = "https://api.steampowered.com"

/**
 * 当前生效的 Steam API 地址：配置了自定义 baseUrl 时使用自定义地址（代理服务器），
 * 否则使用官方地址
 */
function apiBase() {
  const custom = Config.baseUrl
  return (custom || DEFAULT_API_BASE).replace(/\/+$/, "")
}

/**
 * 根据配置生成 HTTP Basic 认证头，未配置账号密码时返回 null
 */
function authHeaders() {
  const { username, password } = Config.auth
  if (!username && !password) return null
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64")
  return { Authorization: `Basic ${token}` }
}

/**
 * 展开 fetch 的错误链：undici 只抛出笼统的 "fetch failed"，
 * 真正原因（ECONNREFUSED / ENOTFOUND / 证书错误等）在 error.cause 里
 * @returns {string}
 */
export function describeError(error) {
  const parts = []
  const seen = new Set()
  const queue = [error]
  while (queue.length) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    const message = String(current.message ?? "").trim()
    const code = current.code || current.errno
    if (message || code) {
      parts.push(code && !message.includes(String(code)) ? `${message || code} (${code})` : message)
    }
    if (current.cause) queue.push(current.cause)
    if (Array.isArray(current.errors)) queue.push(...current.errors)
  }
  return parts.length ? parts.join(" <- ") : String(error)
}

/**
 * 打日志用：隐去 URL 中的 API Key，避免泄露
 */
function redactUrl(url) {
  return url.replace(/([?&]key=)[^&]*/i, "$1***")
}

async function requestJson(path, timeout = 10000) {
  const url = `${apiBase()}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: authHeaders() || undefined,
    })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`)
      error.status = response.status
      error.data = data
      throw error
    }
    return data
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${timeout}ms）`)
    }
    if (error?.status) throw error
    throw new Error(`请求失败（${redactUrl(url)}）：${describeError(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量获取玩家概要信息
 * @param {string} key Steam Web API Key
 * @param {string|string[]} steamIds SteamID64
 * @param {number} timeout
 * @returns {Promise<object[]>}
 */
export async function getPlayerSummaries(key, steamIds, timeout = 10000) {
  const ids = (Array.isArray(steamIds) ? steamIds : [steamIds])
    .map(id => String(id || "").trim())
    .filter(Boolean)
  if (!ids.length) return []
  const path =
    `/ISteamUser/GetPlayerSummaries/v0002/` +
    `?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(ids.join(","))}&format=json`
  const data = await requestJson(path, timeout)
  return data?.response?.players ?? []
}

/**
 * 将自定义 ID（个性 URL）解析为 SteamID64
 * @returns {Promise<string|null>}
 */
export async function resolveVanityUrl(key, vanity, timeout = 10000) {
  const path =
    `/ISteamUser/ResolveVanityURL/v0001/` +
    `?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(vanity)}&format=json`
  const data = await requestJson(path, timeout)
  const response = data?.response
  if (Number(response?.success) === 1 && response?.steamid) return String(response.steamid)
  return null
}

/**
 * 校验 API Key 是否可用
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testApiKey(key, timeout = 10000) {
  if (!key) return { ok: false, message: "未配置 apiKey，请填写 config/config.yaml" }
  try {
    await getPlayerSummaries(key, "76561197960287930", timeout)
    return { ok: true, message: "API Key 校验通过" }
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      if (Config.customBaseUrl && Config.auth.username) {
        return { ok: false, message: "代理认证失败（请检查 request.auth）或 API Key 无效" }
      }
      return { ok: false, message: "API Key 无效或未授权" }
    }
    return { ok: false, message: error?.message ?? String(error) }
  }
}
