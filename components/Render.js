import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import puppeteer from "../../../lib/puppeteer/puppeteer.js"
import { Config } from "./Config.js"
import { CACHE_DIR, CACHE_MAX_BYTES, renderTempCache } from "./TempCache.js"
import { CONTENT_RIGHT, createBrowserMeasurer, measureArtLeftEdge, pickClearBackground } from "./background.js"

export { CONTENT_RIGHT }

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TPL_FILE = path.join(pluginRoot, "resources", "steam-status.html")
const HELP_TPL_FILE = path.join(pluginRoot, "resources", "steam-help.html")

/**
 * 渲染字体：Google Sans 优先，MiSans 作为中文回退。
 * 模板会被写入 temp/html 再以 file:// 打开，因此这里转成绝对 file:// 地址，
 * 避免相对路径依赖当前工作目录。缺失时返回空串，模板自动退回系统字体。
 */
const FONT_DIR = path.resolve(pluginRoot, "../../resources/font")

function resolveFontUrl(file) {
  try {
    return fs.existsSync(file) ? pathToFileURL(file).href : ""
  } catch {
    return ""
  }
}

const GOOGLE_SANS_URL = resolveFontUrl(path.join(FONT_DIR, "GoogleSans.ttf"))
const MI_SANS_URL = resolveFontUrl(path.join(FONT_DIR, "MiSans-Regular.ttf"))

const STATE_TEXT = {
  0: "离线",
  1: "在线",
  2: "忙碌",
  3: "离开",
  4: "打盹",
  5: "想交易",
  6: "想玩游戏",
}

const STATE_COLOR = {
  0: "#7d90a8",
  1: "#66c0f4",
  2: "#f59e0b",
  3: "#f472b6",
  4: "#a78bfa",
  5: "#4ade80",
  6: "#4ade80",
}

let renderSeq = 0

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 预热浏览器：渲染器在首次启动时会加锁，此时并发的 browserInit 会直接返回 false。
 * 串行等待浏览器就绪，避免并行渲染的首批请求被丢弃。
 */
export async function prepareRenderer(retries = 50, interval = 200) {
  if (typeof puppeteer.browserInit !== "function") return true
  for (let i = 0; i < retries; i++) {
    const ready = await puppeteer.browserInit().catch(() => false)
    if (ready) return true
    await sleep(interval)
  }
  return false
}

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

/** 图片抓取超时，避免轮询被资源下载拖慢 */
const IMAGE_TIMEOUT = Math.min(Config.timeout, 6000)

/** 实际发起下载，成功时返回 data URI（背景图需要它，因为模板要用 canvas 读它） */
async function downloadImage(url, timeout) {
  const got = await downloadImageBuffer(url, timeout)
  if (!got) return null
  return `data:${got.mime};base64,${got.buffer.toString("base64")}`
}

/** 实际发起下载，返回原始字节；落盘缓存要的是字节，不是 base64 */
async function downloadImageBuffer(url, timeout) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const mime = response.headers.get("content-type") || "image/jpeg"
    if (!mime.startsWith("image/")) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) return null
    return { buffer, mime }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抓一张纯展示用的图（头像 / 游戏封面），落到 temp 缓存里，返回 file:// 地址
 *
 * 不用 data URI 的原因：base64 是字符串，V8 按 UTF-16 双倍占内存，
 * 大图会长期常驻。落盘 + file:// 只占磁盘，Chromium 需要时才读。
 */
async function fetchImageView(url, key, timeout = IMAGE_TIMEOUT) {
  if (!url) return null
  const cached = renderTempCache.get(key)
  if (cached) return cached

  const pending = imagePending.get(key)
  if (pending) return pending

  const promise = (async () => {
    const got = await downloadImageBuffer(url, timeout)
    if (!got) return null
    return renderTempCache.put(key, got.buffer, got.mime)
  })()
  imagePending.set(key, promise)
  try {
    return await promise
  } finally {
    imagePending.delete(key)
  }
}

/** 取玩家头像（纯展示，落 temp 缓存，返回 file:// 地址） */
export async function resolveAvatar(player) {
  const url = player?.avatarfull || player?.avatarmedium || player?.avatar
  return fetchImageView(url, `avatar-${player?.steamid || "unknown"}`)
}

/** 合并同一 key 的并发请求 */
const imagePending = new Map()

/** 初始化时清空临时目录（由插件 init 调用） */
export function prepareRenderCache() {
  renderTempCache.clear()
}

/** 供自检使用 */
export function renderCacheStats() {
  return {
    entries: renderTempCache.size,
    files: renderTempCache.countFiles(),
    bytes: renderTempCache.totalBytes,
    maxBytes: renderTempCache.maxBytes,
    dir: CACHE_DIR,
  }
}

/** 背景素材最多重抽几次（立绘压字就换下一张） */
const BG_MAX_TRIES = 6

/**
 * 量立绘左边界：先用 node-canvas（快，但只认 jpeg / png），
 * 量不出来再交给共享 Chromium 解码（t.alcy.cc 这类接口常返回 webp）。
 * 两种方式都失败返回 null，调用方按「无法校验」处理。
 */
const measureArtEdgeViaBrowser = createBrowserMeasurer(
  async () => ((await puppeteer.browserInit()) ? puppeteer.browser : null),
  { onWarn: message => logger.warn(`[Steam状态推送] ${message}`) },
)

async function measureArtEdge(dataUri) {
  const edge = await measureArtLeftEdge(dataUri)
  return edge !== null ? edge : measureArtEdgeViaBrowser(dataUri)
}

/**
 * 随机背景图短时缓存：在 TTL 内复用同一张图，避免频繁请求 API
 * 键含 contentRight，因为状态卡与帮助图的容差不同，不能互相复用
 */
const backgroundMemo = new Map()
const backgroundPending = new Map()

/**
 * 配置热重载时清空背景缓存，让新的背景地址 / 缓存时间立即生效
 * （正在进行的下载不强杀，完成后会按新配置重新缓存）
 */
export function clearBackgroundCache() {
  backgroundMemo.clear()
}

/**
 * 抓取背景素材。给了 contentRight 时会校验立绘有没有压到文字列，
 * 压字就重新抽一张（背景接口每次返回随机图），最多 BG_MAX_TRIES 次。
 */
async function resolveBackground(url, ttlSeconds = 60, contentRight = null) {
  if (!url) return null
  const key = `${url}|${contentRight ?? ""}`
  const memo = backgroundMemo.get(key)
  if (memo && memo.expiresAt > Date.now()) return memo.value
  // 合并并发首次请求，避免同时各拿一张不同的随机图
  if (backgroundPending.has(key)) return backgroundPending.get(key)

  const ttl = Math.max(0, Number(ttlSeconds) || 0) * 1000
  const promise = (async () => {
    const { value, edge, tries } = await pickClearBackground(
      () => downloadImage(url, IMAGE_TIMEOUT),
      {
        contentRight,
        maxTries: BG_MAX_TRIES,
        measure: measureArtEdge,
        onReject: (badEdge, limit) => logger.debug(
          `[Steam状态推送] 背景立绘压到文字列（${badEdge}px ≤ ${limit}px），换下一张`,
        ),
        onWarn: message => logger.warn(`[Steam状态推送] ${message}`),
      },
    )
    if (value && edge !== null && contentRight) {
      logger.debug(`[Steam状态推送] 背景立绘左边界 ${edge}px > ${contentRight}px（第 ${tries} 张）`)
    }
    if (value) {
      backgroundMemo.set(key, { value, expiresAt: Date.now() + ttl })
      if (backgroundMemo.size > 8) {
        const oldest = backgroundMemo.keys().next().value
        if (oldest !== undefined) backgroundMemo.delete(oldest)
      }
    }
    return value
  })()

  backgroundPending.set(key, promise)
  try {
    return await promise
  } finally {
    if (backgroundPending.get(key) === promise) backgroundPending.delete(key)
  }
}

/**
 * 游戏封面候选地址，**数组顺序即优先级**
 *
 * 背景：卡片封面框是 1056×360（约 2.93:1），而 Steam 素材有好几种：
 *   - library_hero.jpg  1920×620（3.10:1）比例最贴合，实测 20/20 个游戏都有
 *   - header.jpg         460×215（2.14:1）只有约 90% 有，且放大到 1056 宽会发虚
 *   - capsule_616x353    616×353（1.75:1）裁剪最多
 * 部分游戏（实测：鸣潮 3513350、蔚蓝档案 3557620）根本没发布 header，
 * 只发布了 library_hero —— 老写法只试 header / capsule，于是永远显示「暂无封面」。
 */
function gameImageCandidates(appId) {
  const cdn = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}`
  const assets = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}`
  return [
    `${cdn}/library_hero.jpg`,
    `${assets}/library_hero.jpg`,
    `${cdn}/header.jpg`,
    `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
    `${assets}/header.jpg`,
    `${cdn}/capsule_616x353.jpg`,
  ]
}

const GAME_IMAGE_CACHE_PREFIX = "game-image-"

const gameImagePending = new Map()

/**
 * 取游戏封面。
 *
 * 候选**全部并发**拉取（服务器带宽充足，不想为了省流量牺牲延迟），
 * 结果按候选列表顺序取第一个成功的 —— 所以「顺序 = 优先级」，
 * 而延迟只取决于最快的那一张。
 *
 * 只有选中的那张会落盘：落选的没人用，没必要占 temp 空间。
 * 落盘后返回 file:// 地址，模板里当普通 <img> 显示（纯展示，不需要 canvas 读回）。
 */
export async function resolveGameImage(appId, timeout = IMAGE_TIMEOUT) {
  if (!appId) return null
  const key = `${GAME_IMAGE_CACHE_PREFIX}${appId}`

  const cached = renderTempCache.get(key)
  if (cached) return cached

  // 同一个游戏可能被多个绑定同时渲染，合并并发请求
  const pending = gameImagePending.get(key)
  if (pending) return pending

  const promise = (async () => {
    const candidates = gameImageCandidates(appId)
    const results = await Promise.all(candidates.map(url => downloadImageBuffer(url, timeout)))
    const hit = results.find(Boolean)
    if (!hit) return null
    return renderTempCache.put(key, hit.buffer, hit.mime)
  })()

  gameImagePending.set(key, promise)
  try {
    return await promise
  } finally {
    gameImagePending.delete(key)
  }
}

function personaStateText(state) {
  return STATE_TEXT[Number(state)] ?? "未知"
}

function personaStateColor(state) {
  return STATE_COLOR[Number(state)] ?? "#7d90a8"
}

function formatTime(value = Date.now()) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  try {
    return DATE_FORMATTER.format(date)
  } catch {
    return date.toISOString()
  }
}

/**
 * 渲染 Steam 状态卡片图片
 * @param {object} player GetPlayerSummaries 返回的玩家对象
 * @param {object} [options]
 * @param {string[]} [options.changes] 状态变化描述列表
 * @param {string} [options.playtime] 本次游玩时长文案（可选）
 * @returns {Promise<object|null>} 图片 segment，渲染失败返回 null
 */
export async function renderSteamStatusCard(player, options = {}) {
  if (!player) return null
  const appId = player.gameid ? String(player.gameid) : ""
  const backgroundUrl = Config.background
  const [avatar, gameImage, background] = await Promise.all([
    resolveAvatar(player),
    resolveGameImage(appId),
    backgroundUrl ? resolveBackground(backgroundUrl, Config.backgroundCache, CONTENT_RIGHT.status) : Promise.resolve(null),
  ])

  const state = Number(player.personastate ?? 0)
  const personaName = player.personaname || "未知"
  const playing = Boolean(player.gameextrainfo)

  const data = {
    avatar,
    initial: String(personaName).trim().charAt(0).toUpperCase() || "?",
    personaName,
    steamId: String(player.steamid || ""),
    stateText: personaStateText(state),
    stateColor: personaStateColor(state),
    offline: state === 0,
    playing,
    gameName: player.gameextrainfo || "",
    gameImage,
    playtime: String(options.playtime || ""),
    emptyGameText: "当前未在游戏中",
    changes: Array.isArray(options.changes) ? options.changes : [],
    time: formatTime(),
    background,
    backgroundBlur: Config.backgroundBlur,
    backgroundMode: Config.backgroundMode,
    googleSansFont: GOOGLE_SANS_URL,
    miSansFont: MI_SANS_URL,
  }

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      renderSeq = (renderSeq + 1) % Number.MAX_SAFE_INTEGER
      const card = await puppeteer.screenshot("steam-status", {
        tplFile: TPL_FILE,
        saveId: `steam-status-${player.steamid || "unknown"}-${Date.now()}-${renderSeq}`,
        imgType: "jpeg",
        quality: 92,
        ...data,
      })
      if (card) return card
      // 浏览器可能仍在启动，稍后重试
      await sleep(250)
    }
    return null
  } catch (error) {
    logger.error(`[Steam状态推送] 图片渲染失败：${error?.message ?? error}`)
    return null
  }
}

/**
 * 渲染帮助图片
 *
 * 背景与主题完全复用状态卡：同一张 render.background 素材，由模板内的脚本
 * 自动识别白底、横版场景图或右侧竖版插画，并选择对应布局。
 * @param {Array<{title: string, items: Array<{cmd: string, desc: string}>}>} sections
 * @returns {Promise<object|null>} 图片 segment，渲染失败返回 null
 */
export async function renderSteamHelpCard(sections) {
  if (!Array.isArray(sections) || !sections.length) return null

  const backgroundUrl = Config.background
  const background = backgroundUrl
    ? await resolveBackground(backgroundUrl, Config.backgroundCache, CONTENT_RIGHT.help)
    : null

  const data = {
    sections,
    background,
    backgroundBlur: Config.backgroundBlur,
    backgroundMode: Config.backgroundMode,
    googleSansFont: GOOGLE_SANS_URL,
    miSansFont: MI_SANS_URL,
  }

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      renderSeq = (renderSeq + 1) % Number.MAX_SAFE_INTEGER
      const card = await puppeteer.screenshot("steam-help", {
        tplFile: HELP_TPL_FILE,
        saveId: `steam-help-${Date.now()}-${renderSeq}`,
        imgType: "jpeg",
        quality: 92,
        ...data,
      })
      if (card) return card
      // 浏览器可能仍在启动，稍后重试
      await sleep(250)
    }
    return null
  } catch (error) {
    logger.error(`[Steam状态推送] 帮助图片渲染失败：${error?.message ?? error}`)
    return null
  }
}
