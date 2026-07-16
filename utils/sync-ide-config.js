const fs = require('fs')
const path = require('path')
const os = require('os')
const fetch = require('node-fetch')

const { isPortActive } = require('./find-port')
const { MODEL_HASH } = require('../config/constants')
const { text } = require('./logger')

async function _fetchHealth(p) {
  try {
    const res = await fetch(`http://localhost:${p}/health`, { timeout: 2000 })
    if (!res.ok) return null
    const data = await res.json()
    return data
  } catch {
    return {}
  }
}

const TARGET_PATH = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Code',
  'User',
  'chatLanguageModels.json',
)

const ZK_ENTRY_NAME = 'ZeroKey'

function _portOf(model) {
  return parseInt(model.id.split('-')[1])
}

async function syncIdeConfig(preSelected, port) {
  try {
    const targetDir = path.dirname(TARGET_PATH)
    if (!fs.existsSync(targetDir)) {
      console.log(`[IDE-CFG] Skipped sync — directory not found: ${targetDir}`)
      return
    }

    let existing = []
    if (fs.existsSync(TARGET_PATH)) {
      try {
        const raw = fs.readFileSync(TARGET_PATH, 'utf8').trim()
        existing = raw ? JSON.parse(raw) : []
        if (!Array.isArray(existing)) existing = []
      } catch {
        console.warn('[IDE-CFG] Existing chatLanguageModels.json unreadable — will recreate.')
        existing = []
      }
    }

    let zeroKeyEntry = existing.find((e) => e.name === ZK_ENTRY_NAME)
    if (zeroKeyEntry) {
      zeroKeyEntry = JSON.parse(JSON.stringify(zeroKeyEntry))
    } else {
      zeroKeyEntry = {
        name: ZK_ENTRY_NAME,
        vendor: 'customendpoint',
        apiType: 'chat-completions',
        models: [],
      }
    }
    if (!Array.isArray(zeroKeyEntry.models)) zeroKeyEntry.models = []

    let modelName = null

    if (preSelected && port) {
      const targetId = `ZK-${port}`

      const liveFlags = await Promise.all(
        zeroKeyEntry.models.map(async (m) => {
          if (m.id === targetId) return true
          const p = _portOf(m)
          if (!p) return true
          return isPortActive(p)
        }),
      )
      zeroKeyEntry.models = zeroKeyEntry.models.filter((_, i) => liveFlags[i])

      modelName = MODEL_HASH[preSelected.provider]?.models?.[preSelected.session.model]?.name

      const activePorts = zeroKeyEntry.models
        .filter((m) => m.id !== targetId)
        .map((m) => _portOf(m))
        .filter(Boolean)

      if (activePorts.length > 0) {
        const activeModels = await Promise.all(
          activePorts.map(async (p) => {
            const data = await _fetchHealth(p)

            if (!data || !data.provider || !data.model) return null
            return MODEL_HASH[data.provider]?.models?.[data.model]?.name || null
          }),
        )

        if (activeModels.includes(modelName)) {
          modelName += ` — ${port}`
        }
      }

      const existingModel = zeroKeyEntry.models.find((m) => m.id === targetId)
      if (existingModel) {
        existingModel.name = modelName
      } else {
        zeroKeyEntry.models.push({
          id: targetId,
          name: modelName,
          url: `http://localhost:${port}/v1`,
          maxInputTokens: 200000,
          maxOutputTokens: 64000,
          editTools: ['apply-patch', 'code-rewrite', 'find-replace', 'multi-find-replace'],
          toolCalling: true,
          vision: true,
        })
      }
    }

    const preserved = existing.filter((e) => e.name !== ZK_ENTRY_NAME)
    const merged = [...preserved, zeroKeyEntry]

    const tmpPath = `${TARGET_PATH}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2))
    fs.renameSync(tmpPath, TARGET_PATH)

    console.success('[Server] ZeroKey model synced to VS Code.')
    console.log('         Select in VS Code Chat →', text.cyan(modelName), '\n')
  } catch (error) {
    console.debug(`[IDE-CFG] Sync skipped (non-fatal): ${error.message}`)
  }
}

module.exports = { syncIdeConfig, TARGET_PATH }
