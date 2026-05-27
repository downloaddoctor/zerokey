const fs = require('fs')
const path = require('path')

const WASM_PATH = path.join(__dirname, 'wasm', 'sha3_wasm_bg.7b9ca65ddd.wasm')

class DeepSeekHash {
  constructor() {
    this.instance = null
    this.memory = null
    this.wasmModule = null
  }

  async init(wasmPath) {
    try {
      const wasmBuffer = fs.readFileSync(wasmPath)

      this.wasmModule = await WebAssembly.compile(wasmBuffer)

      const imports = {
        env: {
          memory: new WebAssembly.Memory({ initial: 256, maximum: 512 }),
          __wbindgen_export_0: (length, alignment) => {
            return this._allocate(length, alignment)
          },
          __wbindgen_add_to_stack_pointer: (delta) => {
            return this._adjustStackPointer(delta)
          },
          abort: () => {
            throw new Error('WASM abort called')
          },
        },
      }

      this.instance = await WebAssembly.instantiate(this.wasmModule, imports)
      this.memory = this.instance.exports.memory || imports.env.memory

      return this
    } catch (error) {
      console.error('Failed to initialize WASM:', error)
      throw error
    }
  }

  _allocate(length, alignment) {
    const ptr = this._currentMemoryOffset
    const aligned = Math.ceil(ptr / alignment) * alignment
    this._currentMemoryOffset = aligned + length
    return aligned
  }

  _adjustStackPointer(delta) {
    this._stackPointer = (this._stackPointer || 0) + delta
    return this._stackPointer
  }

  _writeToMemory(text) {
    const encoded = new TextEncoder().encode(text)
    const length = encoded.length

    const ptr = this.instance.exports.__wbindgen_export_0(length, 1)

    const memoryView = new Uint8Array(this.memory.buffer, ptr, length)
    memoryView.set(encoded)

    return { ptr, length }
  }

  calculateHash(algorithm, challenge, salt, difficulty, expireAt) {
    const prefix = `${salt}_${expireAt}_`

    const retptr = this.instance.exports.__wbindgen_add_to_stack_pointer(-16)

    try {
      const { ptr: challengePtr, length: challengeLen } = this._writeToMemory(challenge)
      const { ptr: prefixPtr, length: prefixLen } = this._writeToMemory(prefix)

      this.instance.exports.wasm_solve(
        retptr,
        challengePtr,
        challengeLen,
        prefixPtr,
        prefixLen,
        difficulty,
      )

      // Read result from memory
      const memoryView = new DataView(this.memory.buffer)
      const status = memoryView.getInt32(retptr, true) // little-endian

      if (status === 0) {
        return null
      }

      // Read the float64 value
      const value = memoryView.getFloat64(retptr + 8, true) // little-endian

      return Math.floor(value)
    } finally {
      this.instance.exports.__wbindgen_add_to_stack_pointer(16)
    }
  }
}

class DeepSeekPOW {
  constructor() {
    this.hashEngine = new DeepSeekHash()
  }

  async initialize() {
    await this.hashEngine.init(WASM_PATH)
  }

  async solveChallenge(config) {
    /** Solves a proof-of-work challenge and returns the encoded response */
    if (!this.hashEngine) {
      throw new Error('DeepSeekPOW not initialized. Call initialize() first.')
    }

    // Offload POW computation to avoid blocking event loop
    const answer = await new Promise((resolve) => {
      setImmediate(() => {
        resolve(
          this.hashEngine.calculateHash(
            config.algorithm,
            config.challenge,
            config.salt,
            config.difficulty,
            config.expire_at,
          ),
        )
      })
    })

    const result = {
      algorithm: config.algorithm,
      challenge: config.challenge,
      salt: config.salt,
      answer,
      signature: config.signature,
      target_path: config.target_path,
    }

    // Encode as base64
    const jsonStr = JSON.stringify(result)
    return Buffer.from(jsonStr).toString('base64')
  }
}

module.exports = { DeepSeekPOW }
