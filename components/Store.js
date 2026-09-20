import fs from "node:fs/promises"
import path from "node:path"

const EMPTY_DATA = Object.freeze({ version: 1, bindings: {} })

function cloneEmpty() {
  return JSON.parse(JSON.stringify(EMPTY_DATA))
}

/**
 * 归一化推送群列表：兼容旧数据的单个 groupId 字段
 * @param {object|null} binding
 * @returns {string[]}
 */
export function normalizeGroups(binding) {
  if (!binding) return []
  const list = Array.isArray(binding.groupIds) ? binding.groupIds : []
  const legacy = binding.groupId ? [binding.groupId] : []
  return [...new Set([...list, ...legacy].map(id => String(id)).filter(Boolean))]
}

export class SteamStore {
  constructor(file = path.join(process.cwd(), "data", "steam-status-push-plugin", "bindings.json")) {
    this.file = file
    this.data = null
    this.loading = null
    this.writeQueue = Promise.resolve()
  }

  async load() {
    if (this.data) return this.data
    if (this.loading) return this.loading
    this.loading = (async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, "utf8"))
        this.data = { ...cloneEmpty(), ...parsed, bindings: parsed?.bindings || {} }
      } catch (error) {
        if (error.code !== "ENOENT") {
          const broken = `${this.file}.broken-${Date.now()}`
          await fs.copyFile(this.file, broken).catch(() => {})
          global.logger?.error?.(`[Steam状态推送] 数据文件损坏，已备份至 ${broken}`)
        }
        this.data = cloneEmpty()
        await this.persist()
      }
      return this.data
    })()
    try {
      return await this.loading
    } finally {
      this.loading = null
    }
  }

  async persist() {
    const json = JSON.stringify(this.data || cloneEmpty(), null, 2)
    const temp = `${this.file}.tmp`
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(temp, json, "utf8")
    try {
      await fs.rename(temp, this.file)
    } catch {
      await fs.writeFile(this.file, json, "utf8")
      await fs.unlink(temp).catch(() => {})
    }
  }

  async update(mutator) {
    const run = async () => {
      const data = await this.load()
      const result = await mutator(data)
      await this.persist()
      return result
    }
    this.writeQueue = this.writeQueue.then(run, run)
    return this.writeQueue
  }

  async get(userId) {
    return (await this.load()).bindings[String(userId)] || null
  }

  async list() {
    return Object.values((await this.load()).bindings)
  }

  async save(userId, binding) {
    const key = String(userId)
    return this.update(data => {
      data.bindings[key] = {
        ...(data.bindings[key] || {}),
        ...binding,
        userId: key,
        updatedAt: Date.now(),
      }
      if (!data.bindings[key].createdAt) data.bindings[key].createdAt = Date.now()
      return data.bindings[key]
    })
  }

  async remove(userId) {
    const key = String(userId)
    return this.update(data => {
      const existed = Boolean(data.bindings[key])
      delete data.bindings[key]
      return existed
    })
  }

  async setEnabled(userId, enabled) {
    const key = String(userId)
    return this.update(data => {
      const item = data.bindings[key]
      if (!item) return null
      item.enabled = Boolean(enabled)
      item.updatedAt = Date.now()
      return item
    })
  }

  async setLastStatus(userId, status) {
    const key = String(userId)
    return this.update(data => {
      const item = data.bindings[key]
      if (!item) return null
      item.lastStatus = { ...status, updatedAt: Date.now() }
      return item
    })
  }

  /**
   * 添加推送群聊并启用推送
   * @returns {Promise<{bound: boolean, added: boolean, groups: string[]}>}
   */
  async addGroup(userId, groupId) {
    const key = String(userId)
    const target = String(groupId)
    return this.update(data => {
      const item = data.bindings[key]
      if (!item) return { bound: false, added: false, groups: [] }
      // 兼容旧版“全局禁用但保留群列表”的数据：重新启用时只加入明确指定的群。
      const groups = item.enabled === false ? [] : normalizeGroups(item)
      const added = !groups.includes(target)
      if (added) groups.push(target)
      item.groupIds = groups
      item.groupId = groups[0] || null
      item.enabled = true
      item.updatedAt = Date.now()
      return { bound: true, added, groups }
    })
  }

  /**
   * 移除推送群聊，列表为空时自动禁用推送
   * @returns {Promise<{bound: boolean, removed: boolean, groups: string[]}>}
   */
  async removeGroup(userId, groupId) {
    const key = String(userId)
    const target = String(groupId)
    return this.update(data => {
      const item = data.bindings[key]
      if (!item) return { bound: false, removed: false, groups: [] }
      const groups = normalizeGroups(item)
      const removed = groups.includes(target)
      const next = groups.filter(id => id !== target)
      item.groupIds = next
      item.groupId = next[0] || null
      if (!next.length) item.enabled = false
      item.updatedAt = Date.now()
      return { bound: true, removed, groups: next }
    })
  }

  /** 清空全部推送群聊并禁用推送。 */
  async clearGroups(userId) {
    const key = String(userId)
    return this.update(data => {
      const item = data.bindings[key]
      if (!item) return { bound: false, removed: 0 }
      const removed = normalizeGroups(item).length
      item.groupIds = []
      item.groupId = null
      item.enabled = false
      item.updatedAt = Date.now()
      return { bound: true, removed }
    })
  }

  async snapshot() {
    return JSON.parse(JSON.stringify(await this.load()))
  }
}

export const Store = new SteamStore()
