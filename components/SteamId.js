/**
 * Steam 用户标识解析：把好友代码、好友邀请链接、个人资料链接、交易链接、
 * SteamID64 等输入统一解析为 SteamID64。
 *
 * 说明：SteamID64 有 17 位，超过 JS Number 的安全整数范围（2^53-1），
 * 因此全程使用 BigInt 运算，最终以「字符串」形式返回，避免精度丢失。
 */

/** 个人账号 SteamID64 基准值：76561197960265728 */
const STEAMID64_BASE = 76561197960265728n

/** AccountID 为 SteamID64 低 32 位 */
const ACCOUNT_ID_MAX = 0xffffffffn

/** 个人账号（Individual）类型值 */
const INDIVIDUAL_TYPE = 1n

/**
 * s.team 好友邀请码字符表：索引即十六进制半字节。
 * 0->b 1->c 2->d 3->f 4->g 5->h 6->j 7->k 8->m 9->n a->p b->q c->r d->t e->v f->w
 */
const SHORT_CODE_ALPHABET = "bcdfghjkmnpqrtvw"

const INVITE_URL_REG = /s\.team\/p\/([0-9a-z-]+)/i
const PROFILE_URL_REG = /steamcommunity\.com\/profiles\/(\d+)/i
const VANITY_URL_REG = /steamcommunity\.com\/id\/([^/?#\s]+)/i
const USER_URL_REG = /steamcommunity\.com\/user\/([0-9a-z-]+)/i
const TRADE_URL_REG = /steamcommunity\.com\/tradeoffer\/[^\s]*[?&]partner=(\d+)/i
const NUMERIC_REG = /^\d+$/
const VANITY_TOKEN_REG = /^[a-z0-9_-]+$/i

/** 解析失败时抛出的错误类型，便于调用方区分“输入非法”和其它异常 */
export class SteamIdError extends Error {
  constructor(message) {
    super(message)
    this.name = "SteamIdError"
  }
}

function toBigInt(value) {
  if (typeof value === "bigint") return value
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new SteamIdError(`不是有效的整数：${value}`)
    return BigInt(value)
  }
  const text = String(value ?? "").trim()
  if (!NUMERIC_REG.test(text)) throw new SteamIdError(`不是有效的数字：${text || "(空)"}`)
  return BigInt(text)
}

/** AccountID → SteamID64（返回字符串） */
export function accountIdToSteamId64(accountId) {
  const id = toBigInt(accountId)
  if (id <= 0n || id > ACCOUNT_ID_MAX) {
    throw new SteamIdError(`AccountID 超出有效范围：${accountId}`)
  }
  return (STEAMID64_BASE + id).toString()
}

/** SteamID64 → AccountID（返回字符串） */
export function steamId64ToAccountId(steamId64) {
  const id = toBigInt(steamId64)
  return (id & ACCOUNT_ID_MAX).toString()
}

/** 判断是否为有效的个人账号 SteamID64 */
export function isSteamId64(value) {
  let id
  try {
    id = toBigInt(value)
  } catch {
    return false
  }
  if (id <= ACCOUNT_ID_MAX || id >= 2n ** 64n) return false
  const accountId = id & ACCOUNT_ID_MAX
  const instance = (id >> 32n) & 0xfffffn
  const type = (id >> 52n) & 0xfn
  const universe = (id >> 56n) & 0xffn
  return type === INDIVIDUAL_TYPE && accountId > 0n && universe > 0n && instance <= 4n
}

/** AccountID → s.team 邀请码（如 cv-dgb） */
export function encodeInviteCode(accountId) {
  const id = toBigInt(accountId)
  if (id <= 0n || id > ACCOUNT_ID_MAX) {
    throw new SteamIdError(`AccountID 超出有效范围：${accountId}`)
  }
  let code = ""
  for (const char of id.toString(16)) {
    code += SHORT_CODE_ALPHABET[Number.parseInt(char, 16)]
  }
  const mid = Math.floor(code.length / 2)
  return mid > 0 ? `${code.slice(0, mid)}-${code.slice(mid)}` : code
}

/** s.team 邀请码 → SteamID64（返回字符串） */
export function decodeInviteCode(code) {
  const cleaned = String(code ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "")
  if (!cleaned) throw new SteamIdError("邀请码为空")

  let hex = ""
  for (const char of cleaned) {
    const index = SHORT_CODE_ALPHABET.indexOf(char)
    if (index >= 0) hex += index.toString(16)
    else if (/^[0-9a-f]$/.test(char)) hex += char
    else throw new SteamIdError(`邀请码包含非法字符：${char}`)
  }
  return accountIdToSteamId64(BigInt(`0x${hex}`))
}

function resolveNumeric(text) {
  const value = toBigInt(text)
  if (value <= 0n) throw new SteamIdError(`无效的 Steam 标识：${text}`)
  if (value <= ACCOUNT_ID_MAX) return accountIdToSteamId64(value)
  if (isSteamId64(value)) return value.toString()
  throw new SteamIdError(`无效的 SteamID64：${text}`)
}

function resolveProfileId(value) {
  if (!isSteamId64(value)) throw new SteamIdError(`无效的 SteamID64：${value}`)
  return toBigInt(value).toString()
}

async function defaultResolveVanity(vanity, { apiKey, timeout } = {}) {
  if (!apiKey) throw new SteamIdError("解析自定义 ID 需要配置 Steam API Key")
  const { resolveVanityUrl } = await import("./SteamApi.js")
  return resolveVanityUrl(apiKey, vanity, timeout)
}

async function resolveVanity(vanity, options) {
  const resolver = options.resolveVanity ?? defaultResolveVanity
  const steamId = await resolver(vanity, options)
  if (!steamId || !isSteamId64(steamId)) {
    throw new SteamIdError(`未找到自定义 ID 对应的用户：${vanity}`)
  }
  return toBigInt(steamId).toString()
}

/**
 * 解析 Steam 用户标识并返回 SteamID64 字符串。
 *
 * 优先本地解析（好友代码 / 邀请码 / profile 链接 / 交易链接 / SteamID64），
 * 仅自定义 ID（/id/xxx 或裸自定义 ID）才会联网调用 ResolveVanityURL。
 *
 * @param {string} input 待解析的输入
 * @param {object} [options]
 * @param {string} [options.apiKey] Steam Web API Key（解析自定义 ID 时使用）
 * @param {number} [options.timeout] 请求超时（毫秒）
 * @param {(vanity: string, options: object) => Promise<string|null>} [options.resolveVanity]
 *   可注入的自定义 ID 解析器，便于测试与替换实现
 * @returns {Promise<string>} SteamID64
 * @throws {SteamIdError} 输入无法解析或未找到用户时
 */
export async function resolveSteamId(input, options = {}) {
  const text = String(input ?? "").trim()
  if (!text) throw new SteamIdError("请输入 SteamID、好友代码或主页链接")

  const invite = text.match(INVITE_URL_REG)
  if (invite) return decodeInviteCode(invite[1])

  const trade = text.match(TRADE_URL_REG)
  if (trade) return accountIdToSteamId64(trade[1])

  const profile = text.match(PROFILE_URL_REG)
  if (profile) return resolveProfileId(profile[1])

  const vanityUrl = text.match(VANITY_URL_REG)
  if (vanityUrl) return resolveVanity(vanityUrl[1], options)

  const user = text.match(USER_URL_REG)
  if (user) return decodeInviteCode(user[1])

  if (NUMERIC_REG.test(text)) return resolveNumeric(text)

  if (VANITY_TOKEN_REG.test(text)) return resolveVanity(text, options)

  throw new SteamIdError(`无法识别的 Steam 标识：${text}`)
}
