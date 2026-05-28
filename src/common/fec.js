// XOR-parity FEC for HDMI frame sequences.
// 1% redundancy: ceil(N * 0.01) parity frames for N data frames.
//
// Interleaved grouping: group g = frames g, g+pc, g+2*pc, ...  (stride = parityCount)
//   Burst loss of consecutive frames spreads across different groups → each group has
//   at most 1 missing from a burst → recoverable. Sequential grouping would cluster
//   consecutive losses in one group, exceeding the 1-recovery limit.
//
// Parity frame payload   = XOR of all group data payloads (zero-padded to max length).
// Parity frame payloadLenXor = XOR of all group data payloadLen values.
//   → allows recovering the missing frame's exact byte length via XOR.
//
// Can recover exactly 1 missing frame per group. 2+ missing = unrecoverable.

export function parityCount(dataTotal) {
  return Math.ceil(dataTotal * 0.01)
}

export function groupSize(dataTotal) {
  const pc = parityCount(dataTotal)
  return pc > 0 ? Math.ceil(dataTotal / pc) : dataTotal
}

/**
 * Compute parity frames from data chunks.
 * @param {Uint8Array[]} chunks
 * @returns {{ payload: Uint8Array, payloadLenXor: number }[]}
 */
export function computeParityFrames(chunks) {
  const pc = parityCount(chunks.length)
  const result = []
  for (let g = 0; g < pc; g++) {
    let maxLen = 0
    let payloadLenXor = 0
    for (let i = g; i < chunks.length; i += pc) {
      if (chunks[i].length > maxLen) maxLen = chunks[i].length
      payloadLenXor ^= chunks[i].length
    }
    const parity = new Uint8Array(maxLen)
    for (let i = g; i < chunks.length; i += pc)
      for (let j = 0; j < chunks[i].length; j++) parity[j] ^= chunks[i][j]
    result.push({ payload: parity, payloadLenXor })
  }
  return result
}

/**
 * Recover missing data frames using parity.
 * @param {Map<number, Uint8Array>} received  data frames (frameIdx → payload)
 * @param {Map<number, {payload: Uint8Array, payloadLenXor: number}>} parityReceived
 * @param {number} dataTotal
 * @returns {Map<number, Uint8Array>} newly recovered frames
 */
export function recoverWithParity(received, parityReceived, dataTotal) {
  const pc = parityCount(dataTotal)
  const recovered = new Map()
  for (let g = 0; g < pc; g++) {
    const pr = parityReceived.get(g)
    if (!pr) continue
    const missing = []
    for (let i = g; i < dataTotal; i += pc) {
      if (!received.has(i) && !recovered.has(i)) missing.push(i)
    }
    if (missing.length !== 1) continue
    const mi = missing[0]
    const result = new Uint8Array(pr.payload)
    let lenXor = pr.payloadLenXor
    for (let i = g; i < dataTotal; i += pc) {
      if (i === mi) continue
      const frame = received.get(i) ?? recovered.get(i)
      for (let j = 0; j < frame.length; j++) result[j] ^= frame[j]
      lenXor ^= frame.length
    }
    recovered.set(mi, result.slice(0, lenXor))
  }
  return recovered
}
