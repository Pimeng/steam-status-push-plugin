/**
 * 背景素材的「立绘是否压到文字列」检测与重抽
 *
 * 刻意不依赖云崽全局（logger / Bot 等），只吃一个取图回调，方便单独跑测试。
 */

const CARD_W = 1920
const CARD_H = 1080

/** 内容列右边界（px）：背景素材里的立绘左边界越过这条线就会盖到文字上 */
export const CONTENT_RIGHT = { status: 1120, help: 1280 }

/** 默认最多重抽几次 */
export const DEFAULT_MAX_TRIES = 6

/** 判定「非白」的阈值：低于它就当成画面主体 */
const WHITE = 236

/** 扫描纵向范围（避开顶部色条与底部页脚） */
const SCAN_FROM = Math.floor(CARD_H * 0.10)
const SCAN_TO = Math.floor(CARD_H * 0.92)

let canvasModule
/** 按需加载 node-canvas；环境缺原生绑定时返回 null，不影响出图 */
async function getCanvas() {
  if (canvasModule === undefined) {
    try {
      canvasModule = await import("canvas")
    } catch {
      canvasModule = null
    }
  }
  return canvasModule
}

/**
 * 量出背景素材中主体（立绘）的左边界，坐标是 1920×1080 卡片坐标
 * （复刻 .bg-layer 的 object-fit: cover 换算）。
 *
 * 这是 node-canvas 版本，快但只认 jpeg / png。返回 null 表示量不出来，
 * 调用方应回退到浏览器解码（见 Render.js）或按「无法校验」处理。
 */
export async function measureArtLeftEdge(dataUri) {
  if (typeof dataUri !== "string") return null
  const comma = dataUri.indexOf(",")
  if (comma < 0) return null

  const mod = await getCanvas()
  if (!mod?.loadImage || !mod?.createCanvas) return null

  let image
  try {
    image = await mod.loadImage(Buffer.from(dataUri.slice(comma + 1), "base64"))
  } catch {
    return null
  }
  return scanLeftEdge(mod, image)
}

/**
 * 扫描左边界。image 需要有 width / height，并由 ctx.drawImage 可绘制。
 * 独立出来是为了让浏览器解码路径复用同一套扫描逻辑与阈值。
 */
export function scanLeftEdge(mod, image) {
  const nw = image.width
  const nh = image.height
  if (!nw || !nh) return null

  const scale = Math.max(CARD_W / nw, CARD_H / nh)
  const dw = nw * scale
  const dh = nh * scale
  const canvas = mod.createCanvas(CARD_W, CARD_H)
  const ctx = canvas.getContext("2d")
  // 先铺白底，再按 cover 摆图，这样透明区域等同于白底素材
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, CARD_W, CARD_H)
  ctx.drawImage(image, (CARD_W - dw) / 2, (CARD_H - dh) / 2, dw, dh)

  const { data } = ctx.getImageData(0, 0, CARD_W, CARD_H)

  // 场景插画 / 照片本来就会在整张画布上出现非白像素，不能把它们误当成
  // “白底立绘压字”而连续重抽。左侧主要内容区并非大面积近纯白时，直接视为
  // 普通背景图；模板会用局部磨砂保证可读性，无需寻找所谓的立绘左边界。
  let leftCount = 0
  let whiteCount = 0
  const leftTo = Math.floor(CARD_W * 0.58)
  for (let y = 0; y < CARD_H; y += 4) {
    for (let x = 0; x < leftTo; x += 4) {
      const q = (y * CARD_W + x) * 4
      const hi = Math.max(data[q], data[q + 1], data[q + 2])
      const lo = Math.min(data[q], data[q + 1], data[q + 2])
      const value = (data[q] + data[q + 1] + data[q + 2]) / 3
      leftCount++
      if (value > 238 && hi - lo < 18) whiteCount++
    }
  }
  if (leftCount && whiteCount / leftCount <= 0.76) return CARD_W

  for (let x = 0; x < CARD_W; x++) {
    for (let y = SCAN_FROM; y < SCAN_TO; y += 2) {
      const q = (y * CARD_W + x) * 4
      if (data[q] < WHITE || data[q + 1] < WHITE || data[q + 2] < WHITE) return x
    }
  }
  return CARD_W
}

/**
 * 造一个「用 Chromium 解码」的量测函数。
 * node-canvas 解不了 webp，而 t.alcy.cc 这类背景接口常常返回 webp，
 * 所以必须有一条浏览器兜底路径。
 *
 * @param {() => Promise<object|null>} getBrowser 返回一个已连接的 puppeteer Browser
 */
export function createBrowserMeasurer(getBrowser, options = {}) {
  const { onWarn } = options
  return async function measureViaBrowser(dataUri) {
    let page
    try {
      const browser = await getBrowser()
      if (!browser) return null
      page = await browser.newPage()
      return await page.evaluate(async (uri) => {
        const img = new Image()
        img.src = uri
        await img.decode()
        const c = document.createElement("canvas")
        c.width = 1920
        c.height = 1080
        const ctx = c.getContext("2d")
        // 与 node-canvas 路径保持同一套 cover 换算与阈值
        ctx.fillStyle = "#ffffff"
        ctx.fillRect(0, 0, 1920, 1080)
        const s = Math.max(1920 / img.naturalWidth, 1080 / img.naturalHeight)
        const dw = img.naturalWidth * s
        const dh = img.naturalHeight * s
        ctx.drawImage(img, (1920 - dw) / 2, (1080 - dh) / 2, dw, dh)
        const { data } = ctx.getImageData(0, 0, 1920, 1080)

        // 与 node-canvas 一致：只有左侧大面积近纯白才是需要避让的白底立绘。
        let leftCount = 0
        let whiteCount = 0
        for (let y = 0; y < 1080; y += 4) {
          for (let x = 0; x < Math.floor(1920 * 0.58); x += 4) {
            const q = (y * 1920 + x) * 4
            const hi = Math.max(data[q], data[q + 1], data[q + 2])
            const lo = Math.min(data[q], data[q + 1], data[q + 2])
            const value = (data[q] + data[q + 1] + data[q + 2]) / 3
            leftCount++
            if (value > 238 && hi - lo < 18) whiteCount++
          }
        }
        if (leftCount && whiteCount / leftCount <= 0.76) return 1920

        for (let x = 0; x < 1920; x++) {
          for (let y = 108; y < 994; y += 2) {
            const q = (y * 1920 + x) * 4
            if (data[q] < 236 || data[q + 1] < 236 || data[q + 2] < 236) return x
          }
        }
        return 1920
      }, dataUri)
    } catch (error) {
      onWarn?.(`浏览器解码背景失败：${error?.message ?? error}`)
      return null
    } finally {
      await page?.close().catch(() => {})
    }
  }
}

/**
 * 反复取图，直到立绘左边界越过 contentRight（也就是不压字）
 *
 * @param {() => Promise<string|null>} fetchOne 每次调用取一张新图（data URI），失败返回 null
 * @param {object} [options]
 * @param {number|null} [options.contentRight] 内容列右边界；不传则只取一张、不校验
 * @param {number} [options.maxTries] 最多取几张
 * @param {(dataUri: string) => Promise<number|null>} [options.measure] 量边界的方式
 * @param {(edge: number, contentRight: number) => void} [options.onReject] 每次因压字被丢弃时回调
 * @param {(message: string) => void} [options.onWarn] 无法校验 / 全部压字时的提示
 * @returns {Promise<{value: string|null, edge: number|null, tries: number, ok: boolean}>}
 *   value: 选中的图；edge: 它的立绘左边界（未校验时为 null）；
 *   ok: 是否确认不压字（无法校验时按 true 处理，避免无谓重抽）
 */
export async function pickClearBackground(fetchOne, options = {}) {
  const {
    contentRight = null,
    maxTries = DEFAULT_MAX_TRIES,
    measure = measureArtLeftEdge,
    onReject,
    onWarn,
  } = options
  // 不给阈值就只取一张，连量都不用量
  const tries = contentRight ? Math.max(1, Number(maxTries) || 1) : 1

  let best = null
  let bestEdge = -1
  let warned = false

  for (let i = 0; i < tries; i++) {
    const value = await fetchOne()
    if (!value) continue
    if (!contentRight) return { value, edge: null, tries: i + 1, ok: true }

    let edge = null
    try {
      edge = await measure(value)
    } catch {
      edge = null
    }
    if (edge === null) {
      // 量不出来（所有解码方式都失败）：按原样使用，不做无谓重抽
      if (!warned) { onWarn?.("背景压字检测不可用（图片无法解码），本次不校验"); warned = true }
      return { value, edge: null, tries: i + 1, ok: true }
    }

    if (edge > bestEdge) { best = value; bestEdge = edge }
    if (edge > contentRight) return { value, edge, tries: i + 1, ok: true }

    if (i < tries - 1) onReject?.(edge, contentRight)
  }

  if (best) {
    onWarn?.(`连抽 ${tries} 张背景立绘都压到文字列，使用其中最好的一张（立绘左边界 ${bestEdge}px ≤ ${contentRight}px）`)
    return { value: best, edge: bestEdge, tries, ok: false }
  }
  onWarn?.(`连抽 ${tries} 张背景都没取到，本次不使用背景`)
  return { value: null, edge: null, tries, ok: false }
}
