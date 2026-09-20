import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** 专属临时目录：放在云崽的 temp 下，插件初始化时整目录清空 */
export const CACHE_DIR = path.resolve(pluginRoot, "../../temp/steam-status-push")

/** 目录体积上限：超了按 LRU 淘汰最久未用的 */
export const CACHE_MAX_BYTES = 1024 ** 3 // 1GB

/** 刚取用过的条目在这么久内不参与淘汰（够一次渲染走完） */
const PROTECT_MS = 60 * 1000

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
}

/**
 * 把 key 变成安全的文件名。
 * 纯 appid 这种可读 key 原样保留（方便排查），URL 之类则补一段哈希避免撞名。
 */
function safeName(key) {
  const raw = String(key)
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
  if (cleaned === raw && cleaned.length) return cleaned
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12)
  return `${cleaned || "k"}-${hash}`
}

/**
 * 落盘的临时文件缓存
 *
 * 为什么不用内存缓存：图片转成 base64 之后是字符串，V8 按 UTF-16 算是双倍内存。
 * 一张 library_hero 629KB → data URI 838KB 文本 → 常驻约 1.6MB，
 * 配 300 条上限 + 512M 重启阈值很容易把进程顶爆。
 * 落盘只存原始字节（629KB 就是 629KB），并且初始化时整目录清空，不会越攒越多。
 *
 * 注意：只有「纯展示的 <img>」能用这里返回的 file:// 地址。
 * 背景图必须继续用 data URI —— 模板里要用 canvas 读它做白底检测，
 * file:// 的图会污染 canvas，getImageData 直接抛 SecurityError
 * （实测：file:// 可加载但 canvasReadable=false，data: 则正常）。
 */
export class TempFileCache {
  /**
   * @param {string} dir 专属目录
   * @param {object} [options]
   * @param {number} [options.maxBytes] 目录体积上限，超了就按 LRU 淘汰（默认 1GB）
   * @param {number} [options.protectMs] 刚取用过的条目在这么久内不参与淘汰
   */
  constructor(dir = CACHE_DIR, options = {}) {
    this.dir = dir
    this.maxBytes = options.maxBytes ?? CACHE_MAX_BYTES
    this.protectMs = options.protectMs ?? PROTECT_MS
    /** key -> { file, mime, size, usedAt }；Map 的迭代顺序 = 插入顺序 = LRU 顺序（最久未用在前） */
    this.index = new Map()
    this.bytes = 0
  }

  /** 初始化时调用：删掉整个目录再重建，保证每次启动都是干净的 */
  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(this.dir, { recursive: true })
    this.index.clear()
    this.bytes = 0
  }

  /** 返回 file:// 地址；没有则返回 null。命中会把该条目挪到 LRU 队尾 */
  get(key) {
    const hit = this.index.get(key)
    if (!hit) return null
    if (!fs.existsSync(hit.file)) {
      this.index.delete(key)
      this.bytes -= hit.size
      return null
    }
    // 删了再塞 = 移到队尾（最近使用）
    this.index.delete(key)
    hit.usedAt = Date.now()
    this.index.set(key, hit)
    return pathToFileURL(hit.file).href
  }

  has(key) {
    return this.index.has(key)
  }

  /** 写入原始字节，返回 file:// 地址；必要时按 LRU 淘汰到上限以内 */
  put(key, buffer, mime = "image/jpeg") {
    if (!buffer?.length) return null
    fs.mkdirSync(this.dir, { recursive: true })
    const ext = EXT_BY_MIME[String(mime).split(";")[0].trim().toLowerCase()] || "jpg"
    const file = path.join(this.dir, `${safeName(key)}.${ext}`)
    fs.writeFileSync(file, buffer)

    const prev = this.index.get(key)
    if (prev) {
      this.bytes -= prev.size
      this.index.delete(key)
    }
    const entry = { file, mime, size: buffer.length, usedAt: Date.now() }
    this.index.set(key, entry)
    this.bytes += entry.size

    this.evict()
    return pathToFileURL(file).href
  }

  /**
   * LRU 淘汰：从最久未用的开始删，直到低于上限
   *
   * 刚取用过的条目（protectMs 内）跳过：get() 返回的 file:// 地址是交给
   * Chromium 稍后加载的，淘汰和截图之间有个时间差，删掉就会渲染出碎图。
   * 全部都在保护期内时就先不删，宁可短暂超限。
   */
  evict() {
    if (this.bytes <= this.maxBytes) return 0
    const now = Date.now()
    let removed = 0
    for (const [key, entry] of this.index) {
      if (this.bytes <= this.maxBytes) break
      if (now - entry.usedAt < this.protectMs) continue
      this.index.delete(key)
      this.bytes -= entry.size
      try {
        fs.rmSync(entry.file, { force: true })
      } catch {
        /* 文件已经不在就算了 */
      }
      removed++
    }
    return removed
  }

  get size() {
    return this.index.size
  }

  /** 索引里记录的总体积（字节） */
  get totalBytes() {
    return this.bytes
  }

  /** 目录里的实际文件数（用来核对索引没跑偏） */
  countFiles() {
    try {
      return fs.readdirSync(this.dir).length
    } catch {
      return 0
    }
  }
}

/** 渲染相关的临时文件都放这个实例 */
export const renderTempCache = new TempFileCache()
