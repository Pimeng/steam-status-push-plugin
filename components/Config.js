import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const defaultFile = path.join(pluginRoot, "config", "default.yaml")
const configFile = path.join(pluginRoot, "config", "config.yaml")

/** 内置渲染预置：选择一个名称即可同时确定背景源与版式。 */
const RENDER_PRESETS = Object.freeze({
  white: Object.freeze({
    background: "https://t.alcy.cc/bd",
    backgroundMode: "white",
  }),
  blur: Object.freeze({
    background: "https://t.alcy.cc/moemp",
    backgroundMode: "portrait",
  }),
})

const FALLBACK = {
  apiKey: "",
  request: {
    timeout: 10000,
    baseUrl: "",
    auth: { username: "", password: "" },
  },
  poll: {
    enabled: true,
    cron: "0 */3 * * * *",
    adaptive: {
      enabled: true,
      tiers: [
        { count: 50, interval: 30 },
        { count: 200, interval: 60 },
        { count: null, interval: 120 },
      ],
    },
  },
  push: { notifyPersonaState: true, notifyGame: true },
  render: { preset: "blur", background: "", backgroundBlur: 8, backgroundCache: 60, backgroundMode: "" },
}

function merge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = merge({ ...(target[key] || {}) }, value)
    } else {
      target[key] = value
    }
  }
  return target
}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) || {}
  } catch {
    return {}
  }
}

class SteamConfig {
  constructor() {
    this._data = null
    this.ensureUserConfig()
  }

  ensureUserConfig() {
    try {
      fs.mkdirSync(path.dirname(configFile), { recursive: true })
      if (!fs.existsSync(configFile) && fs.existsSync(defaultFile)) {
        fs.copyFileSync(defaultFile, configFile)
      }
    } catch (err) {
      global.logger?.warn?.(`[Steam状态推送] 配置文件创建失败：${err?.message ?? err}`)
    }
  }

  reload() {
    this._data = null
  }

  get data() {
    if (this._data) return this._data
    const base = JSON.parse(JSON.stringify(FALLBACK))
    const defaults = merge(base, readYaml(defaultFile))
    const user = readYaml(configFile)
    this._data = merge(defaults, user)
    return this._data
  }

  get apiKey() {
    const fromConfig = String(this.data.apiKey || "").trim()
    return fromConfig || String(process.env.STEAM_API_KEY || "").trim()
  }

  get timeout() {
    const value = Number(this.data.request?.timeout)
    return Number.isFinite(value) && value > 0 ? value : 10000
  }

  /**
   * 自定义 Steam API 地址（用于连接代理服务器而非直连 Steam）
   * 未配置时返回空字符串，由 SteamApi 回退到官方地址
   */
  get baseUrl() {
    return String(this.data.request?.baseUrl || "").trim()
  }

  /**
   * 是否使用了自定义 Steam API 地址
   */
  get customBaseUrl() {
    return Boolean(this.baseUrl)
  }

  /**
   * 自定义地址的 HTTP Basic 认证账号，未配置时为空字符串
   */
  get auth() {
    const auth = this.data.request?.auth || {}
    return {
      username: String(auth.username ?? "").trim(),
      password: String(auth.password ?? ""),
    }
  }

  get pollEnabled() {
    return this.data.poll?.enabled !== false
  }

  get pollCron() {
    return String(this.data.poll?.cron || FALLBACK.poll.cron)
  }

  get adaptive() {
    return this.data.poll?.adaptive || {}
  }

  /**
   * 自适应轮询是否启用（开启后固定 cron 不生效）
   */
  get adaptiveEnabled() {
    return this.adaptive.enabled !== false
  }

  /**
   * 自适应轮询策略，按顺序匹配：count 为人数上限、interval 为间隔秒数，count 为 null 时兜底
   * @returns {{count: number|null, interval: number}[]}
   */
  get adaptiveTiers() {
    const tiers = Array.isArray(this.adaptive.tiers) ? this.adaptive.tiers : FALLBACK.poll.adaptive.tiers
    const parsed = tiers
      .map(tier => ({
        count: tier?.count === null || tier?.count === undefined ? null : Number(tier.count),
        interval: Number(tier?.interval),
      }))
      .filter(tier => Number.isFinite(tier.interval) && tier.interval > 0)
    return parsed.length ? parsed : FALLBACK.poll.adaptive.tiers
  }

  get push() {
    return this.data.push || {}
  }

  /**
   * 渲染预置：white 白底立绘；blur 竖图模糊羽化
   */
  get renderPreset() {
    const value = String(this.data.render?.preset || "blur").toLowerCase()
    return Object.hasOwn(RENDER_PRESETS, value) ? value : "blur"
  }

  /**
   * 卡片背景图地址。自定义地址优先，留空则使用当前预置的内置地址。
   */
  get background() {
    const custom = String(this.data.render?.background || "").trim()
    return custom || RENDER_PRESETS[this.renderPreset].background
  }

  /**
   * 背景模糊度（px），仅非白底素材生效
   */
  get backgroundBlur() {
    const value = Number(this.data.render?.backgroundBlur)
    return Number.isFinite(value) && value >= 0 ? value : 8
  }

  /**
   * 背景图缓存时间（秒），避免频繁请求随机图 API；为 0 时不缓存
   */
  get backgroundCache() {
    const value = Number(this.data.render?.backgroundCache)
    return Number.isFinite(value) && value >= 0 ? value : 60
  }

  /**
   * 背景模式。显式配置优先，留空则跟随当前预置。
   * 继续接受旧版 auto / white / photo / portrait 配置以保持兼容。
   */
  get backgroundMode() {
    const value = String(this.data.render?.backgroundMode || "").toLowerCase()
    return ["auto", "white", "photo", "portrait"].includes(value)
      ? value
      : RENDER_PRESETS[this.renderPreset].backgroundMode
  }
}

export const Config = new SteamConfig()
export { RENDER_PRESETS, configFile, defaultFile, pluginRoot }
