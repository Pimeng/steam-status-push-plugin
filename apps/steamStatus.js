import schedule from "node-schedule"
import plugin from "../../../lib/plugins/plugin.js"
import common from "../../../lib/common/common.js"
import { Config } from "../components/Config.js"
import { Store, normalizeGroups } from "../components/Store.js"
import { getPlayerSummaries, testApiKey } from "../components/SteamApi.js"
import { SteamIdError, resolveSteamId as resolveSteamIdInput } from "../components/SteamId.js"
import {
  clearBackgroundCache,
  prepareRenderCache,
  prepareRenderer,
  renderSteamHelpCard,
  renderSteamStatusCard,
} from "../components/Render.js"

const PERSONA_STATE_TEXT = {
  0: "离线",
  1: "在线",
  2: "忙碌",
  3: "离开",
  4: "打盹",
  5: "想交易",
  6: "想玩游戏",
}

/**
 * 帮助内容：图片版与文字兜底版共用同一份数据，避免两处文案不一致
 */
const HELP_SECTIONS = [
  {
    title: "绑定与账号",
    items: [
      { cmd: "#steam 绑定 / bind <标识>", desc: "绑定 Steam 账号（好友代码 / SteamID64 / 链接）" },
      { cmd: "#steam 绑定状态 / bind status", desc: "查看绑定信息与当前实时状态" },
      { cmd: "#steam 解绑 / unbind", desc: "解除绑定" },
    ],
  },
  {
    title: "推送开关",
    items: [
      { cmd: "#steam 开启 / 启用 / 打开推送", desc: "开启当前群聊的状态推送" },
      { cmd: "#steam 关闭 / 禁用 / 停用推送", desc: "关闭当前群聊的状态推送" },
      { cmd: "#steam 禁用所有推送", desc: "移除并关闭全部群聊推送" },
      { cmd: "#steam add / 添加 [群号]", desc: "添加推送群聊（默认当前群）" },
      { cmd: "#steam del / 删除 <群号>", desc: "关闭指定群聊的推送" },
      { cmd: "#steam enablestatus / 查看推送群聊", desc: "私聊查看已开启推送的群聊" },
    ],
  },
  {
    title: "其他",
    items: [
      { cmd: "@某人 在干嘛", desc: "查看 TA 当前在玩的游戏" },
      { cmd: "#steam 重载配置", desc: "立即热重载 config.yaml（仅主人）" },
      { cmd: "#steam 更新 / 强制更新", desc: "更新插件（仅主人）" },
      { cmd: "#steam 更新日志", desc: "查看最近提交" },
    ],
  },
]

/** 帮助图片渲染失败时的文字兜底 */
const HELP_TEXT = [
  "[Steam状态推送]",
  "----------------",
  ...HELP_SECTIONS.flatMap(section => [
    `【${section.title}】`,
    ...section.items.map(item => `${item.cmd}    ${item.desc}`),
  ]),
].join("\n")

const ADD_REG = /^#?steam\s+(?:add|添加)\s*(\d{5,})?\s*$/i
const DEL_REG = /^#?steam\s+(?:del|delete|删除|移除)\s*(\d{5,})?\s*$/i
const LIST_REG =
  /^#?steam\s+(?:enable\s*status|查看\s*推送\s*群聊|推送\s*群聊\s*列表|群聊\s*推送\s*列表)\s*$/i

/**
 * 开启/关闭推送：放宽措辞限制。
 * 支持「开启 / 打开 / 启用 / 开始 / 启动」等开启说法，以及
 * 「关闭 / 关掉 / 禁用 / 停用 / 取消 / 停止」等关闭说法，
 * 中间的「状态」和结尾的「推送」均可省略，也允许中间带空格。
 */
const ENABLE_REG =
  /^#?steam\s+(?:开启|打开|启用|开始|启动|enable|start|on)(?:\s*状态)?(?:\s*推送)?\s*$/i
const DISABLE_REG =
  /^#?steam\s+(?:关闭|关掉|禁用|停用|取消|停止|disable|stop|off)(?:\s*状态)?(?:\s*推送)?\s*$/i
const DISABLE_ALL_REG =
  /^#?steam\s+(?:关闭|关掉|禁用|停用|取消|停止)\s*所有\s*(?:状态\s*)?推送\s*$/i

/** 手动触发配置热重载（仅主人） */
const RELOAD_REG =
  /^#?steam\s+(?:配置\s*)?(?:重载|重新加载|热重载|reload)\s*(?:配置)?\s*$/i

/**
 * 「@某人 在干嘛」：查看被 at 用户当前的 Steam 状态。
 * 未被 at、被 at 者未绑定 Steam 时静默忽略，把消息交还给其他插件。
 */
const ASK_STATUS_REG =
  /^(?:你)?(?:在)?(?:干嘛|干什么|干啥|做什么)(?:呢|啊|呀|嘛|哈|哦|喔)?[？?！!。.~～\s]*$/

const apiState = {
  ready: false,
  error: null,
}

/** 上一次校验通过时使用的 API 连接参数，用于配置热重载时判断是否需要重新校验 */
let apiSignature = ""

/** 配置热重载订阅的取消函数 */
let configUnsubscribe = null

const TIMER_KEY = "__steamStatusPushAdaptiveTimer"
const FIXED_JOB_KEY = "__steamStatusPushFixedJob"

/** 图片并行渲染的最大并发数 */
const RENDER_CONCURRENCY = 6

/** Steam GetPlayerSummaries 官方限制每次最多查询 100 个 SteamID。 */
const PLAYER_BATCH_SIZE = 100

/** 首次发送失败后最多额外重试三次。 */
const SEND_MAX_RETRIES = 3
const SEND_RETRY_DELAY_MS = 300

/** 已经提醒过的自定义 Base Url，配置热重载更换地址时会再次提醒 */
let warnedBaseUrl = ""

/**
 * 使用自定义 Steam Base Url 时提醒一次，避免 API Key 泄露风险被忽略
 */
function warnCustomBase() {
  const url = Config.baseUrl
  if (!url || warnedBaseUrl === url) return
  warnedBaseUrl = url
  logger.warn("[Steam状态推送] 您正在使用自定义Steam Base Url，可能造成Key泄露！")
}

function isGroupAdmin(e) {
  return Boolean(e?.isMaster || e?.member?.is_admin || e?.member?.is_owner)
}

function personaStateText(state) {
  return PERSONA_STATE_TEXT[Number(state)] ?? "未知"
}

function statusSnapshot(player) {
  return {
    personastate: Number(player?.personastate ?? 0),
    gameId: player?.gameid ? String(player.gameid) : null,
    gameName: player?.gameextrainfo ? String(player.gameextrainfo) : null,
    personaName: player?.personaname || "",
  }
}

/**
 * 生成用于持久化的状态快照，并维护当前游戏会话的开始时间
 * - 游戏未变化：沿用上一次记录的 gameStartedAt
 * - 开始新游戏 / 切换游戏：以当前时间作为本次会话起点
 * @param {object} player
 * @param {object|null} previous 上一次的 lastStatus
 */
function nextSnapshot(player, previous) {
  const snapshot = statusSnapshot(player)
  if (snapshot.gameId) {
    const sameGame = previous?.gameId && String(previous.gameId) === String(snapshot.gameId)
    snapshot.gameStartedAt =
      sameGame && previous?.gameStartedAt ? Number(previous.gameStartedAt) : Date.now()
  }
  return snapshot
}

/**
 * 把毫秒时长格式化为「x小时y分钟 / x分钟y秒 / y秒」
 */
function formatDuration(ms) {
  const total = Math.floor(Number(ms) / 1000)
  if (!Number.isFinite(total) || total <= 0) return ""
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}小时${minutes}分钟`
  if (minutes > 0) return `${minutes}分钟${seconds}秒`
  return `${seconds}秒`
}

/**
 * 根据会话开始时间生成「（本次游玩时长：...）」，无法计算时返回空字符串
 */
function formatPlaytime(gameStartedAt) {
  const startedAt = Number(gameStartedAt)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return ""
  const text = formatDuration(Date.now() - startedAt)
  return text ? `（本次游玩时长：${text}）` : ""
}

/** 退出游戏通知只展示整分钟；不足一分钟时给出自然文案。 */
function formatEndedPlaytime(gameStartedAt) {
  const startedAt = Number(gameStartedAt)
  const elapsed = Date.now() - startedAt
  if (!Number.isFinite(startedAt) || startedAt <= 0 || elapsed < 0) return ""

  const totalMinutes = Math.floor(elapsed / 60000)
  if (totalMinutes < 1) return "不到1分钟"

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${hours}小时${minutes > 0 ? `${minutes}分钟` : ""}`
  return `${totalMinutes}分钟`
}

function extractBindInput(msg) {
  const match = String(msg ?? "").match(/^#?steam\s+(?:绑定|bind)\s+([\s\S]+?)\s*$/i)
  return match ? match[1].trim() : ""
}

/**
 * 从 add / del 指令中取出可选的群号参数
 */
function extractGroupArg(msg, regex) {
  const match = String(msg ?? "").match(regex)
  return match?.[1] ? String(match[1]) : ""
}

function sameGroup(a, b) {
  return Boolean(a) && Boolean(b) && String(a) === String(b)
}

/**
 * 取出消息里被 at 的目标账号
 * - 与框架一致：多个 at 时以最后一个为准
 * - @全体成员、@机器人自身不算目标
 * @returns {string} 未 at 到有效目标时返回空串
 */
function resolveAtTarget(e) {
  const at = e?.at != null ? String(e.at) : ""
  if (at && at !== "all") return at

  const selfId = e?.self_id ?? e?.bot?.uin
  const segments = Array.isArray(e?.message) ? e.message : []
  for (let i = segments.length - 1; i >= 0; i--) {
    const item = segments[i]
    if (item?.type !== "at") continue
    const qq = item.qq ?? item.id
    if (!qq || String(qq) === "all") continue
    if (selfId != null && String(qq) === String(selfId)) continue
    return String(qq)
  }
  return ""
}

/**
 * 疑似邀请/分享链接：无法作为个人资料绑定
 * s.team 好友邀请与 tradeoffer 交易链接已支持解析，不再拦截
 * - steamcommunity.com 的礼物、好友、聊天等非资料页链接
 * - steam:// 客户端协议链接、帮助/商店链接
 */
const INVITE_LINK_REG =
  /steamcommunity\.com\/(?:gift|friend|friends|chat)\/|steam:\/\/|help\.steampowered\.com|store\.steampowered\.com\/(?:gift|sub|bundle)/i

function looksLikeInviteLink(input) {
  return INVITE_LINK_REG.test(String(input ?? ""))
}

function buildInviteTip() {
  return [
    "[Steam状态推送]",
    "----------------",
    "疑似邀请链接",
    "检测到 Steam 邀请/分享短链，无法用于绑定状态推送。",
    "请改用个人资料链接或 17 位 SteamID：",
    "· https://steamcommunity.com/profiles/7656119xxxxxxxxxx",
    "· https://steamcommunity.com/id/自定义ID",
    "· 或直接发送 7656119 开头的 17 位 SteamID",
    "获取方式：Steam 客户端 → 个人资料 → 复制个人资料链接",
  ].join("\n")
}

/**
 * 解析用户输入的 Steam 标识（好友代码 / 邀请链接 / 主页链接 / 交易链接 / SteamID64），
 * 统一得到 SteamID64。本地可解析的输入优先本地处理，仅自定义 ID 才联网。
 */
async function resolveSteamId(input) {
  return resolveSteamIdInput(input, { apiKey: Config.apiKey, timeout: Config.timeout })
}

async function fetchPlayer(steamId) {
  const players = await getPlayerSummaries(Config.apiKey, steamId, Config.timeout)
  return players.find(player => String(player.steamid) === String(steamId)) || null
}

/** 按 Steam 接口上限分批查询玩家，并合并各批结果。 */
export async function fetchPlayerSummariesBatched(
  key,
  steamIds,
  timeout,
  fetcher = getPlayerSummaries,
) {
  const ids = [...new Set(steamIds.map(id => String(id)).filter(Boolean))]
  const players = []
  for (let index = 0; index < ids.length; index += PLAYER_BATCH_SIZE) {
    const batch = ids.slice(index, index + PLAYER_BATCH_SIZE)
    players.push(...(await fetcher(key, batch, timeout)))
  }
  return players
}

/** 当前 API 连接参数的指纹，任一变化都意味着需要重新校验 */
function currentApiSignature() {
  return [
    Config.apiKey,
    Config.baseUrl,
    Config.auth.username,
    Config.auth.password,
    Config.timeout,
  ].join("\u0000")
}

/**
 * 校验 API Key 并更新可用状态
 * @param {object} [options]
 * @param {boolean} [options.force] 为 false 时，连接参数未变化则复用上次结果
 */
async function refreshApiState({ force = false } = {}) {
  const signature = currentApiSignature()
  if (!force && signature === apiSignature) {
    return { ok: apiState.ready, message: apiState.error }
  }
  apiSignature = signature
  const result = await testApiKey(Config.apiKey, Config.timeout)
  apiState.ready = result.ok
  apiState.error = result.message
  return result
}

async function ensureApiReady() {
  if (apiState.ready) return true
  Config.reload()
  warnCustomBase()
  const result = await refreshApiState({ force: true })
  return result.ok
}

/**
 * 向群聊推送消息（状态推送目标固定为群聊，不再私聊推送）
 */
async function pushMessage(groupId, message) {
  const bot = global.Bot
  if (!bot) throw new Error("机器人尚未就绪")
  const target = Number(groupId) || groupId
  const group = bot.pickGroup?.(target)
  if (!group) throw new Error(`无法找到群聊 ${groupId}`)
  return await group.sendMsg(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 执行发送操作；首次失败后最多再重试三次。 */
export async function retrySend(
  send,
  { maxRetries = SEND_MAX_RETRIES, delayMs = SEND_RETRY_DELAY_MS, onRetry } = {},
) {
  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return { ok: true, attempts: attempt + 1, value: await send() }
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries) break
      onRetry?.(error, attempt + 1, maxRetries)
      if (delayMs > 0) await sleep(delayMs * (attempt + 1))
    }
  }
  return { ok: false, attempts: maxRetries + 1, error: lastError }
}

async function pushMessageWithRetry(groupId, message) {
  const result = await retrySend(() => pushMessage(groupId, message), {
    onRetry: (error, retry, maxRetries) => {
      logger.warn(
        `[Steam状态推送] 推送到群 ${groupId} 失败，将进行第 ${retry}/${maxRetries} 次重试：${error?.message ?? error}`,
      )
    },
  })
  if (!result.ok) {
    logger.error(
      `[Steam状态推送] 推送到群 ${groupId} 失败，已重试 ${SEND_MAX_RETRIES} 次：${result.error?.message ?? result.error}`,
    )
  }
  return result.ok
}

function formatStatusLines(player) {
  const lines = [`个人信息：${player.personaname || "未知"}`]
  lines.push(`当前状态：${personaStateText(player.personastate)}`)
  if (player.gameextrainfo) {
    lines.push(`正在玩：${player.gameextrainfo}${player.gameid ? `（AppID ${player.gameid}）` : ""}`)
  }
  return lines
}

/**
 * 该推送任务是否需要渲染卡片。
 * 结束游戏（info.textOnly）只发文字，不参与渲染，也就不会白白拉起渲染器。
 */
export function needsCard(job) {
  return Boolean(job?.info) && !job.info.textOnly
}

/**
 * 计算本次状态变化描述，返回变化行与文本回退内容；无变化时返回 null
 *
 * textOnly 为 true 时只发文字、不渲染卡片（目前用于「结束游戏」：
 * 游戏已经结束，卡片正文的封面与「正在玩」都不再有意义）
 * leadingText 用于在卡片前附带一条文字（目前用于「开始游戏」）。
 */
export function buildChangeInfo(binding, player, previous) {
  const pushConfig = Config.push
  const stateChanged = Number(previous.personastate) !== Number(player.personastate)
  const gameChanged = String(previous.gameId || "") !== String(player.gameid || "")
  const name = player.personaname || binding.personaName || player.steamid

  const lines = []
  let gameEnded = false
  let gameEndedText = ""
  let leadingText = ""
  if (stateChanged && pushConfig.notifyPersonaState !== false) {
    lines.push(
      `状态：${personaStateText(previous.personastate)} → ${personaStateText(player.personastate)}`,
    )
  }
  if (gameChanged && pushConfig.notifyGame !== false) {
    const previousGame = previous.gameName || null
    const nextGame = player.gameextrainfo || null
    const playtime = formatPlaytime(previous.gameStartedAt)
    if (!nextGame) {
      const duration = formatEndedPlaytime(previous.gameStartedAt) || "一会儿"
      gameEndedText = `${name} 玩了 ${duration} ${previousGame || "未知游戏"} 后不玩了`
      lines.push(gameEndedText)
      gameEnded = true
    }
    // 开始游戏时卡片正文已经展示「正在玩 <游戏名>」，变化行不再重复游戏名
    else if (!previousGame) {
      leadingText = `${name} 开始玩 ${nextGame} 了`
      lines.push("开始游戏")
    } else lines.push(`切换游戏：${previousGame} → ${nextGame}${playtime}`)
  }
  if (!lines.length) return null

  const text = gameEnded
    ? [gameEndedText, ...lines.filter(line => line !== gameEndedText)].join("\n")
    : leadingText || ["[Steam状态推送]", `${name}（${player.steamid}）`, ...lines].join("\n")
  return { lines, text, textOnly: gameEnded, leadingText }
}

const LONG_GAME_NAME = "一个非常非常长的游戏名称测试换行效果 Ultimate Deluxe Edition"

const TEST_SCOPE_ALIAS = {
  "": "",
  game: "game",
  "游戏": "game",
  status: "status",
  "状态": "status",
}

/**
 * 解析 #steam test 的可选范围，非法范围返回 null
 * @returns {"game"|"status"|""|null}
 */
function resolveTestScope(msg) {
  const match = String(msg ?? "").match(/^#?steam\s+(?:test|测试)\s*(\S*)\s*$/i)
  if (!match) return null
  const key = match[1].toLowerCase()
  return Object.prototype.hasOwnProperty.call(TEST_SCOPE_ALIAS, key) ? TEST_SCOPE_ALIAS[key] : null
}

/**
 * 游戏相关测试样本：有封面 / 无封面 / 未在游戏
 * @param {object} base 基础玩家信息（提供头像与昵称）
 */
function buildGameSamples(base) {
  const make = extra => ({ ...base, ...extra })
  return [
    {
      player: make({ personastate: 1, gameid: "730", gameextrainfo: "Counter-Strike 2" }),
      changes: ["开始游戏"],
      playtime: "本次游玩时长：12分钟",
    },
    {
      player: make({ personastate: 6, gameid: "999999999", gameextrainfo: LONG_GAME_NAME }),
      changes: ["开始游戏"],
      playtime: "本次游玩时长：3小时8分钟",
    },
    {
      player: make({ personastate: 1, gameid: null, gameextrainfo: null }),
      changes: ["状态：离线 → 在线"],
      playtime: "",
    },
  ]
}

/**
 * 个人状态测试样本：覆盖 0-6 全部状态
 * @param {object} base 基础玩家信息（提供头像与昵称）
 */
function buildStatusSamples(base) {
  const make = extra => ({ ...base, ...extra })
  const states = [
    [0, "离线"],
    [1, "在线"],
    [2, "忙碌"],
    [3, "离开"],
    [4, "打盹"],
    [5, "想交易"],
    [6, "想玩游戏"],
  ]
  return states.map(([state, text]) => ({
    player: make({ personastate: state, gameid: null, gameextrainfo: null }),
    changes:
      state === 0
        ? ["状态：在线 → 离线", `${base.personaname} 玩了 1小时2分钟 Counter-Strike 2 后不玩了`]
        : [`状态：在线 → ${text}`],
    playtime: "",
  }))
}

/**
 * 根据已启用绑定人数计算自适应轮询间隔（秒）
 */
function adaptiveInterval(count) {
  const tiers = Config.adaptiveTiers
  for (const tier of tiers) {
    if (tier.count === null || count < tier.count) return tier.interval
  }
  return tiers[tiers.length - 1]?.interval ?? 120
}

function stopAdaptive() {
  if (global[TIMER_KEY]) {
    clearTimeout(global[TIMER_KEY])
    global[TIMER_KEY] = null
  }
}

async function adaptiveTick() {
  global[TIMER_KEY] = null
  try {
    await pollStatuses()
  } catch (error) {
    logger.error(`[Steam状态推送] 轮询任务异常：${error?.message ?? error}`)
  }
  await scheduleAdaptive()
}

/**
 * 自适应轮询：每次轮询结束后按当前绑定人数重新计算下一次间隔
 */
async function scheduleAdaptive() {
  stopAdaptive()
  Config.reload()
  if (!Config.pollEnabled || !Config.adaptiveEnabled) return
  let count = 0
  try {
    count = (await Store.list()).filter(item => item.enabled && item.steamId).length
  } catch {
    count = 0
  }
  const interval = adaptiveInterval(count)
  global[TIMER_KEY] = setTimeout(() => {
    adaptiveTick()
  }, interval * 1000)
}

function stopFixed() {
  if (global[FIXED_JOB_KEY]) {
    global[FIXED_JOB_KEY].cancel()
    global[FIXED_JOB_KEY] = null
  }
}

/**
 * 按配置的 cron 注册固定轮询（仅当未启用自适应时）
 * @returns {boolean} 是否注册成功
 */
function startFixed() {
  stopFixed()
  const cron = Config.pollCron
  try {
    const job = schedule.scheduleJob(cron, () => {
      pollStatuses().catch(error => {
        logger.error(`[Steam状态推送] 轮询任务异常：${error?.message ?? error}`)
      })
    })
    global[FIXED_JOB_KEY] = job || null
    return Boolean(job)
  } catch (error) {
    logger.error(`[Steam状态推送] 固定轮询 cron 无效（${cron}）：${error?.message ?? error}`)
    return false
  }
}

/** 停止全部轮询调度 */
function stopSchedules() {
  stopAdaptive()
  stopFixed()
}

/**
 * 按当前配置启动轮询调度。
 * 启动时与配置热重载后都会调用，保证 poll 相关配置改动立即生效。
 */
async function applyPollConfig() {
  stopSchedules()
  if (!Config.pollEnabled) {
    logger.info("[Steam状态推送] 状态轮询已禁用")
    return
  }
  if (Config.adaptiveEnabled) {
    await scheduleAdaptive()
    logger.info("[Steam状态推送] 自适应轮询已启动（cron 不生效）")
    return
  }
  if (startFixed()) logger.info(`[Steam状态推送] 固定轮询已启用：${Config.pollCron}`)
}

/**
 * 并发受限的 map，避免同时渲染过多图片压垮浏览器
 * @template T, R
 * @param {T[]} items
 * @param {number} limit 最大并发数
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  if (!items.length) return results
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await mapper(items[index], index)
      }
    },
  )
  await Promise.all(workers)
  return results
}

/**
 * 定时轮询所有已启用绑定的 Steam 状态，状态变化时推送到绑定群聊
 */
async function pollStatuses() {
  if (!Config.pollEnabled) return

  const bindings = (await Store.list()).filter(item => item.enabled && item.steamId)
  if (!bindings.length) return

  if (!(await ensureApiReady())) {
    logger.warn(`[Steam状态推送] 跳过轮询：${apiState.error}`)
    return
  }

  const steamIds = [...new Set(bindings.map(item => String(item.steamId)))]
  let players
  try {
    players = await fetchPlayerSummariesBatched(Config.apiKey, steamIds, Config.timeout)
  } catch (error) {
    logger.error(`[Steam状态推送] 轮询失败：${error?.message ?? error}`)
    return
  }

  const playerMap = new Map(players.map(player => [String(player.steamid), player]))
  const jobs = []
  for (const binding of bindings) {
    const player = playerMap.get(String(binding.steamId))
    if (!player) continue
    jobs.push({
      binding,
      player,
      info: binding.lastStatus ? buildChangeInfo(binding, player, binding.lastStatus) : null,
      groups: normalizeGroups(binding),
    })
  }

  // 需要推送的卡片并行渲染，随后按顺序发送与落库
  // 结束游戏只发文字，所以这类任务不参与渲染，也就不会白白拉起渲染器
  if (jobs.some(needsCard)) await prepareRenderer()
  const cards = await mapLimit(jobs, RENDER_CONCURRENCY, job =>
    needsCard(job) ? renderSteamStatusCard(job.player, { changes: job.info.lines }) : null,
  )

  for (let i = 0; i < jobs.length; i++) {
    const { binding, player, info, groups } = jobs[i]
    if (info) {
      if (!groups.length) {
        logger.warn(`[Steam状态推送] 绑定 ${binding.userId} 未设置推送群聊，已跳过推送`)
      }
      // 开始游戏发送「文字 + 状态图」；其余卡片消息保持原样，渲染失败时回退到文字。
      const message = cards[i] ? [info.leadingText, cards[i]].filter(Boolean) : info.text
      for (const groupId of groups) {
        await pushMessageWithRetry(groupId, message)
      }
    }
    await Store.setLastStatus(binding.userId, nextSnapshot(player, binding.lastStatus))
  }
}

export class steamStatusPush extends plugin {
  constructor() {
    super({
      name: "Steam状态推送",
      dsc: "监控绑定用户的 Steam 在线状态与游戏动态并推送到群聊",
      event: "message",
      priority: 5000,
      // 轮询调度由 applyPollConfig 自行管理（自适应 / 固定 cron），
      // 这样修改 poll 配置后无需重启即可热重载
      rule: [
        { reg: /^#?steam\s+(?:绑定\s*(?:状态|信息)|bind\s+status)\s*$/i, fnc: "bindStatus" },
        { reg: /^#?steam\s+(?:绑定|bind)\s+([\s\S]+?)\s*$/i, fnc: "bind" },
        { reg: /^#?steam\s+(?:解绑|unbind)\s*$/i, fnc: "unbind" },
        { reg: LIST_REG, fnc: "enableStatus" },
        { reg: DEL_REG, fnc: "deleteGroup" },
        { reg: ADD_REG, fnc: "addGroup" },
        { reg: DISABLE_ALL_REG, fnc: "disableAll" },
        { reg: DISABLE_REG, fnc: "disable" },
        { reg: ENABLE_REG, fnc: "enable" },
        { reg: RELOAD_REG, fnc: "reloadConfig" },
        // 「@某人 在干嘛」不走规则表：它需要绕过 onlyReplyAt（群内前缀/@机器人）过滤，
        // 由下方 getContext 钩子在规则匹配之前抢先处理
        { reg: /^#?steam\s+(?:test|测试)(?:\s+\S+)?\s*$/i, fnc: "test" },
        { reg: /^#?steam\s*(?:帮助|help)?\s*$/i, fnc: "help" },
      ],
    })
  }

  async init() {
    // 临时图缓存每次启动都清空，避免旧素材越攒越多
    prepareRenderCache()

    try {
      Config.reload()
      await Store.load()

      warnCustomBase()

      const result = await refreshApiState({ force: true })
      if (result.ok) {
        logger.info("[Steam状态推送] API Key 校验通过")
      } else {
        logger.error(`[Steam状态推送] API Key 不可用：${result.message}`)
      }
    } catch (error) {
      apiState.ready = false
      apiState.error = error?.message ?? String(error)
      logger.error(`[Steam状态推送] 初始化失败：${apiState.error}`)
    }

    // 订阅配置热重载：config.yaml 变化时自动应用新配置
    if (configUnsubscribe) configUnsubscribe()
    configUnsubscribe = Config.onChange(() => {
      this.handleConfigChange().catch(error => {
        logger.error(`[Steam状态推送] 配置热重载失败：${error?.message ?? error}`)
      })
    })

    await applyPollConfig()
  }

  /**
   * 应用热重载后的配置：重新校验 API、刷新背景缓存并重排轮询调度
   */
  async handleConfigChange() {
    Config.reload()
    warnCustomBase()
    clearBackgroundCache()

    try {
      const result = await refreshApiState()
      if (result.ok) {
        logger.info("[Steam状态推送] 配置热重载：API Key 校验通过")
      } else {
        logger.warn(`[Steam状态推送] 配置热重载：API Key 不可用：${result.message}`)
      }
    } catch (error) {
      logger.warn(`[Steam状态推送] 配置热重载：API Key 校验失败：${error?.message ?? error}`)
    }

    await applyPollConfig()
    logger.info("[Steam状态推送] 配置已热重载")
  }

  /**
   * #steam 重载配置：手动触发配置热重载（仅主人）
   */
  async reloadConfig(e) {
    if (!e.isMaster) {
      await e.reply("该指令仅限主人使用")
      return true
    }
    await this.handleConfigChange()
    await e.reply("[Steam状态推送]\n配置已热重载")
    return true
  }

  async bind(e) {
    const input = extractBindInput(e.msg)
    if (!input) {
      await e.reply(HELP_TEXT)
      return true
    }

    // 邀请/分享短链无法解析为个人资料，先给出明确提示
    if (looksLikeInviteLink(input)) {
      await e.reply(buildInviteTip())
      return true
    }

    if (!(await ensureApiReady())) return this.replyUnavailable(e)

    let steamId
    try {
      steamId = await resolveSteamId(input)
    } catch (error) {
      const title = error instanceof SteamIdError ? "绑定失败" : "查询失败"
      await e.reply(this.buildMessage(title, error?.message ?? String(error)))
      return true
    }
    if (!steamId) {
      await e.reply(this.buildMessage("绑定失败", "未找到对应的 Steam 用户，请检查 SteamID 或主页链接"))
      return true
    }

    let player
    try {
      player = await fetchPlayer(steamId)
    } catch (error) {
      await e.reply(this.buildMessage("查询失败", error?.message ?? String(error)))
      return true
    }
    if (!player) {
      await e.reply(this.buildMessage("绑定失败", `未找到 Steam 用户：${steamId}`))
      return true
    }

    const existing = await Store.get(e.user_id)
    // 旧版全局禁用会保留群列表；重新绑定时不能顺带恢复全部旧群。
    const existingGroups = existing?.enabled === false ? [] : normalizeGroups(existing)
    const previousStatus =
      existing?.steamId && String(existing.steamId) === String(steamId)
        ? existing.lastStatus
        : null
    // 群内绑定时把当前群加入推送列表，同时保留已添加的群
    const groupIds = e.isGroup && e.group_id
      ? [...new Set([...existingGroups, String(e.group_id)])]
      : existingGroups
    await Store.save(e.user_id, {
      steamId,
      personaName: player.personaname || "",
      groupIds,
      groupId: groupIds[0] || null,
      enabled: groupIds.length > 0,
      lastStatus: nextSnapshot(player, previousStatus),
    })

    const lines = ["[Steam状态推送]", "绑定成功", `Steam 用户：${player.personaname || "未知"}`, `Steam ID：${steamId}`]
    lines.push(...formatStatusLines(player))
    if (e.isGroup && e.group_id) {
      lines.push("当前群推送：已启用")
    } else if (groupIds.length) {
      lines.push(`推送群：${groupIds.join("、")}`)
      lines.push("推送：已启用")
    } else {
      lines.push("推送：未启用（请在群聊中发送 #steam add 或 #steam 启用推送）")
    }
    await e.reply(lines.join("\n"))
    return true
  }

  /**
   * 拉取并回复某个绑定用户当前的 Steam 状态卡片
   * @param {object} e 消息事件
   * @param {object} binding Store 中的绑定信息
   * @param {object} [options]
   * @param {boolean} [options.requireGame] 仅在该用户正在游戏时才回复
   * @param {boolean} [options.fallbackToText] 图片失败时是否发送文字状态
   * @returns {Promise<{status: "ok"|"no-game"|"render-failed"|"unavailable", player: object|null}>}
   *   ok：取到实时状态（已尝试回复卡片）
   *   no-game：取到了，但该用户没在游戏（requireGame 时出现，未回复）
   *   render-failed：取到了实时状态，但图片渲染失败且未启用文字降级
   *   unavailable：API 不可用或查询失败（未回复）
   */
  async replyCurrentStatusCard(
    e,
    binding,
    { requireGame = false, fallbackToText = false } = {},
  ) {
    let player = null
    if (await ensureApiReady()) {
      try {
        player = await fetchPlayer(binding.steamId)
      } catch (error) {
        logger.error(`[Steam状态推送] 查询状态失败：${error?.message ?? error}`)
      }
    }
    if (!player) return { status: "unavailable", player: null }

    // 「@某人 在干嘛」只关心正在游戏的情况，空闲/离线不打扰
    if (requireGame && !player.gameextrainfo) return { status: "no-game", player }

    const snapshot = nextSnapshot(player, binding.lastStatus)

    const duration = snapshot.gameId ? formatDuration(Date.now() - snapshot.gameStartedAt) : ""
    const playtime = duration ? `本次游玩时长：${duration}` : ""
    const card = await renderSteamStatusCard(player, { playtime })
    if (card) {
      await e.reply(card)
      return { status: "ok", player }
    }
    if (fallbackToText) {
      const lines = ["[Steam状态推送]", ...formatStatusLines(player)]
      if (playtime) lines.push(playtime)
      await e.reply(lines.join("\n"))
      return { status: "ok", player }
    }
    return { status: "render-failed", player }
  }

  async bindStatus(e) {
    const binding = await Store.get(e.user_id)
    if (!binding) {
      await e.reply("当前未绑定 Steam 账号，请使用 #steam 绑定 <SteamID或主页链接>")
      return true
    }

    const groups = normalizeGroups(binding)
    const lines = [
      "[Steam状态推送]",
      "绑定信息",
      `Steam ID：${binding.steamId}`,
    ]
    if (e.isGroup && e.group_id) {
      const enabledHere = binding.enabled && groups.includes(String(e.group_id))
      lines.push(`当前群推送：${enabledHere ? "已启用" : "未启用"}`)
    } else {
      lines.push(`推送群：${groups.length ? groups.join("、") : "未设置"}`)
      lines.push(`推送：${binding.enabled && groups.length ? "已启用" : "已禁用"}`)
    }

    const { player } = await this.replyCurrentStatusCard(e, binding)
    if (player) {
      lines.push(...formatStatusLines(player))
    } else if (binding.lastStatus) {
      lines.push(`当前状态：${personaStateText(binding.lastStatus.personastate)}`)
      if (binding.lastStatus.gameName) lines.push(`正在玩：${binding.lastStatus.gameName}`)
    } else {
      lines.push("当前状态：暂时无法获取")
    }

    await e.reply(lines.join("\n"))
    return true
  }

  /**
   * 上下文钩子：在框架的 onlyReplyAt（群内需 @机器人 或带前缀）过滤之前
   * 抢先识别「@某人 在干嘛」。
   *
   * 注意父类 plugin.js 的 getContext 承担的是「会话上下文」功能
   * （awaitContext / setContext），这里必须先原样保留它，只做追加：
   * - 认不出该指令时原样返回父类结果，绝不吞消息
   * - 正在进行中的会话（父类上下文非空）优先，不抢占
   */
  getContext(type, isGroup) {
    const context = super.getContext(type, isGroup)

    // 框架的两次调用：getContext()（用户维度）与 getContext(false, true)（群维度），
    // 只在用户维度那次追加，避免重复
    if (type !== undefined) return context
    if (context && Object.keys(context).length) return context

    try {
      const e = this.e
      if (!e || !ASK_STATUS_REG.test(String(e.msg ?? ""))) return context
      if (!resolveAtTarget(e)) return context
      return { ...context, askStatus: e }
    } catch (error) {
      // getContext 里抛异常会中断整条消息的处理，这里兜底并留下日志
      logger.error(`[Steam状态推送] 解析「在干嘛」指令失败：${error?.message ?? error}`)
      return context
    }
  }

  /**
   * @某人 在干嘛：发送被 at 用户当前正在玩的游戏卡片
   *
   * 该方法的调用来自 getContext，返回 "continue" 表示「本插件不处理，
   * 把消息还给其他插件」；返回 true 表示已回复并结束本条消息的后续处理。
   *
   * 只有确认对方「正在游戏」时才发卡片，以下情况一律不打扰：
   * 未被 at、对方未绑定、对方在线但没玩游戏、对方离线、实时状态查询失败。
   */
  async askStatus(e) {
    const targetId = resolveAtTarget(e)
    if (!targetId) return "continue"

    const binding = await Store.get(targetId)
    if (!binding?.steamId) return "continue"

    const { status } = await this.replyCurrentStatusCard(e, binding, {
      requireGame: true,
      fallbackToText: true,
    })
    return status === "ok" ? true : "continue"
  }

  async unbind(e) {
    const existed = await Store.remove(e.user_id)
    await e.reply(existed ? "已解除 Steam 绑定" : "当前未绑定 Steam 账号")
    return true
  }

  async disable(e) {
    const binding = await Store.get(e.user_id)
    if (!binding) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }
    if (!e.isGroup || !e.group_id) {
      await e.reply("请在需要关闭推送的群聊中发送该指令；如需全部关闭，请发送 #steam 禁用所有推送")
      return true
    }

    const groupId = String(e.group_id)
    const result = await Store.removeGroup(e.user_id, groupId)
    await e.reply(result.removed ? "已关闭当前群聊的 Steam 状态推送" : "当前群聊未开启 Steam 状态推送")
    return true
  }

  async disableAll(e) {
    const result = await Store.clearGroups(e.user_id)
    if (!result.bound) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }
    await e.reply(
      result.removed
        ? `已禁用所有 Steam 状态推送，共移除 ${result.removed} 个群聊`
        : "当前未开启任何 Steam 状态推送",
    )
    return true
  }

  async enable(e) {
    const binding = await Store.get(e.user_id)
    if (!binding) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }

    // 启用操作始终只作用于当前群，不提供“一次恢复全部群”的入口。
    if (!e.isGroup || !e.group_id) {
      await e.reply("请在群聊中发送 #steam 启用推送，状态将推送到该群")
      return true
    }

    const groupId = String(e.group_id)
    await Store.addGroup(e.user_id, groupId)
    await e.reply("已启用当前群聊的 Steam 状态推送")
    return true
  }

  /**
   * #steam add [群号]：添加推送群聊（默认当前群）
   */
  async addGroup(e) {
    const binding = await Store.get(e.user_id)
    if (!binding) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }

    const arg = extractGroupArg(e.msg, ADD_REG)
    const current = e.isGroup && e.group_id ? String(e.group_id) : ""
    const groupId = arg || current

    if (!groupId) {
      await e.reply("请在群聊中发送 #steam add，或使用 #steam add <群号>")
      return true
    }
    if (arg && !sameGroup(arg, current) && !isGroupAdmin(e)) {
      await e.reply("只有管理员可以添加其他群聊的推送")
      return true
    }

    const result = await Store.addGroup(e.user_id, groupId)
    if (!result.bound) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }

    const lines = [result.added ? `已添加推送群聊：${groupId}` : `该群聊已在推送列表中：${groupId}`]
    if (!e.isGroup) lines.push(`当前推送群聊：${result.groups.join("、")}`)
    await e.reply(lines.join("\n"))
    return true
  }

  /**
   * #steam del/删除 [群号]：关闭指定群聊的推送（默认当前群）
   */
  async deleteGroup(e) {
    const binding = await Store.get(e.user_id)
    if (!binding) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }

    const arg = extractGroupArg(e.msg, DEL_REG)
    const current = e.isGroup && e.group_id ? String(e.group_id) : ""
    const groupId = arg || current

    if (!groupId) {
      await e.reply("请使用 #steam del <群号> 指定要关闭推送的群聊")
      return true
    }
    if (!sameGroup(groupId, current) && !isGroupAdmin(e)) {
      await e.reply("只有管理员可以关闭其他群聊的推送")
      return true
    }

    const result = await Store.removeGroup(e.user_id, groupId)
    if (!result.bound) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }

    const lines = [
      result.removed ? `已关闭群聊推送：${groupId}` : `推送列表中不存在该群聊：${groupId}`,
    ]
    if (!e.isGroup) {
      lines.push(`当前推送群聊：${result.groups.length ? result.groups.join("、") : "无"}`)
    }
    if (!result.groups.length) lines.push("推送列表为空，禁用推送")
    await e.reply(lines.join("\n"))
    return true
  }

  /**
   * #steam enablestatus / 查看推送群聊：查看已开启推送的群聊
   */
  async enableStatus(e) {
    if (e.isGroup) {
      await e.reply("为保护群聊隐私，请私聊机器人查询全部推送群聊")
      return true
    }

    const binding = await Store.get(e.user_id)
    if (!binding) {
      await e.reply("当前未绑定 Steam 账号，请先使用 #steam 绑定")
      return true
    }

    const groups = normalizeGroups(binding)
    const lines = ["[Steam状态推送]", "推送群聊"]
    if (!groups.length) {
      lines.push("当前未开启任何群聊推送")
    } else {
      groups.forEach((groupId, index) => lines.push(`${index + 1}. ${groupId}`))
    }
    lines.push(`推送：${binding.enabled && groups.length ? "已启用" : "已禁用"}`)
    await e.reply(lines.join("\n"))
    return true
  }

  /**
   * #steam test [game/status]：生成游戏/状态测试图并合并转发（仅管理员）
   */
  async test(e) {
    if (!isGroupAdmin(e)) {
      await e.reply("该测试指令仅限管理员使用")
      return true
    }

    const scope = resolveTestScope(e.msg)
    if (scope === null) {
      await e.reply("用法：#steam test [game/status]\n· game：游戏场景\n· status：个人状态\n· 不填：全部")
      return true
    }

    const scopeText = scope === "game" ? "游戏" : scope === "status" ? "状态" : "全部"
    await e.reply(`正在生成${scopeText}测试图片，请稍候……`)

    let base = { personaname: "Steam 用户", steamid: "76561197960287930", avatarfull: "" }
    try {
      const binding = await Store.get(e.user_id)
      if (binding?.steamId && (await ensureApiReady())) {
        const player = await fetchPlayer(binding.steamId)
        if (player) base = player
      }
    } catch (error) {
      logger.warn(`[Steam状态推送] 测试指令获取头像失败：${error?.message ?? error}`)
    }

    const samples =
      scope === "game"
        ? buildGameSamples(base)
        : scope === "status"
          ? buildStatusSamples(base)
          : [...buildGameSamples(base), ...buildStatusSamples(base)]

    await prepareRenderer()
    const rendered = await mapLimit(samples, RENDER_CONCURRENCY, sample =>
      renderSteamStatusCard(sample.player, {
        changes: sample.changes,
        playtime: sample.playtime,
      }),
    )
    const messages = rendered.filter(Boolean)

    if (!messages.length) {
      await e.reply("测试图片生成失败，请查看日志")
      return true
    }

    const forward = await common.makeForwardMsg(e, messages, `Steam 状态推送 · ${scopeText}预览`)
    await e.reply(forward)
    return true
  }

  async help(e) {
    // 优先发图片版；渲染失败（如浏览器异常）时退回文字版
    const card = await renderSteamHelpCard(HELP_SECTIONS)
    await e.reply(card || HELP_TEXT)
    return true
  }

  buildMessage(title, detail) {
    return ["[Steam状态推送]", "----------------", title, detail].join("\n")
  }

  async replyUnavailable(e) {
    await e.reply(
      this.buildMessage(
        "功能不可用",
        apiState.error || "请检查 config/config.yaml 中的 apiKey 配置",
      ),
    )
    return true
  }
}
