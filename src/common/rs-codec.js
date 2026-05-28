// GF(2^8), primitive polynomial 0x11d
// Polynomials: encode uses big-endian (BE), decode uses little-endian (LE) internally.

const PRIM = 0x11d
const GF_SIZE = 256

const gfExp = new Uint8Array(512)
const gfLog = new Uint8Array(GF_SIZE)

;(function initTables() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x
    gfLog[x] = i
    x <<= 1
    if (x & 0x100) x ^= PRIM
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return gfExp[(gfLog[a] + gfLog[b]) % 255]
}

function gfInv(a) {
  return gfExp[255 - gfLog[a]]
}

function gfPow(x, power) {
  return gfExp[(gfLog[x] * power) % 255]
}

// Big-endian: p[0] = highest-degree coefficient
function polyEvalBE(p, x) {
  let y = p[0]
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i]
  return y
}

// Little-endian: p[0] = constant term
function polyEvalLE(p, x) {
  let y = 0, xi = 1
  for (let i = 0; i < p.length; i++) {
    y ^= gfMul(p[i], xi)
    xi = gfMul(xi, x)
  }
  return y
}

function polyMulBE(p, q) {
  const r = new Uint8Array(p.length + q.length - 1)
  for (let j = 0; j < q.length; j++)
    for (let i = 0; i < p.length; i++)
      r[i + j] ^= gfMul(p[i], q[j])
  return r
}

// Generator poly (BE): g(x) = prod(x + alpha^i, i=0..nroots-1)
function generatorPoly(nroots) {
  let g = new Uint8Array([1])
  for (let i = 0; i < nroots; i++)
    g = polyMulBE(g, new Uint8Array([1, gfPow(2, i)]))
  return g
}

export const NROOTS = 16
export const MAX_DATA = 255 - NROOTS  // 239 bytes max per RS block

/**
 * Encode: returns Uint8Array [data... , parity(NROOTS bytes)]
 * data.length must be <= MAX_DATA (239)
 */
export function encode(data) {
  if (data.length > MAX_DATA)
    throw new Error(`RS encode: data ${data.length}B > max ${MAX_DATA}B`)
  const gen = generatorPoly(NROOTS)
  const out = new Uint8Array(data.length + NROOTS)
  out.set(data)
  for (let i = 0; i < data.length; i++) {
    const coef = out[i]
    if (coef !== 0)
      for (let j = 1; j < gen.length; j++)
        out[i + j] ^= gfMul(gen[j], coef)
  }
  const result = new Uint8Array(data.length + NROOTS)
  result.set(data)
  result.set(out.slice(data.length), data.length)
  return result
}

// Berlekamp-Massey: returns LE error locator sigma ([1, s1, s2, ...])
function berlekampMassey(syndromes) {
  let C = [1], B = [1], L = 0, m = 1, b = 1
  for (let n = 0; n < syndromes.length; n++) {
    let d = syndromes[n]
    for (let i = 1; i <= L; i++)
      if (i < C.length) d ^= gfMul(C[i], syndromes[n - i])
    if (d === 0) { m++; continue }
    const T = [...C]
    const coef = gfMul(d, gfInv(b))
    while (C.length < B.length + m) C.push(0)
    for (let i = 0; i < B.length; i++) C[i + m] ^= gfMul(coef, B[i])
    if (2 * L <= n) { L = n + 1 - L; B = T; b = d; m = 1 } else m++
  }
  return new Uint8Array(C)
}

/**
 * Decode RS-encoded message.
 * Returns corrected data (Uint8Array, length = msg.length - NROOTS) or null.
 */
export function decode(msg) {
  msg = msg instanceof Uint8Array ? new Uint8Array(msg) : new Uint8Array(msg)
  const n = msg.length
  if (n > 255 || n <= NROOTS) return null

  // Syndromes: evaluate msg(alpha^i) for i=0..NROOTS-1 (BE poly eval)
  const syndromes = new Uint8Array(NROOTS)
  for (let i = 0; i < NROOTS; i++) syndromes[i] = polyEvalBE(msg, gfPow(2, i))
  if (syndromes.every((v) => v === 0)) return msg.slice(0, n - NROOTS)

  // Error locator sigma (LE): sigma(x) = 1 + s1*x + s2*x^2 + ...
  const sigma = berlekampMassey(syndromes)
  const numErrors = sigma.length - 1
  if (numErrors > NROOTS / 2) return null

  // Chien search: sigma(alpha^{-k}) == 0 → error at degree k
  // alpha^{-k} = gfExp[(255-k)%255]
  const errPositions = []
  for (let k = 0; k < n; k++) {
    const alphaInvK = gfExp[(255 - k) % 255]
    if (polyEvalLE(sigma, alphaInvK) === 0) errPositions.push(k)
  }
  if (errPositions.length !== numErrors) return null

  // Error evaluator omega = syndromes*sigma mod x^NROOTS (LE convolution)
  const omega = new Uint8Array(NROOTS)
  for (let i = 0; i < NROOTS; i++) {
    let val = 0
    for (let j = 0; j < sigma.length && j <= i; j++)
      val ^= gfMul(sigma[j], syndromes[i - j])
    omega[i] = val
  }

  // Formal derivative of sigma (GF char=2: even-powered terms vanish)
  // sigma'[i] = sigma[i+1] if i even, else 0
  const sigmaPrime = new Uint8Array(Math.max(1, sigma.length - 1))
  for (let i = 0; i < sigmaPrime.length; i++)
    sigmaPrime[i] = i % 2 === 0 ? (sigma[i + 1] ?? 0) : 0

  // Forney: e_k = alpha^k * omega(alpha^{-k}) / sigma'(alpha^{-k})
  const corrected = new Uint8Array(msg)
  for (const k of errPositions) {
    const XkInv = gfExp[(255 - k) % 255]
    const Xk = gfExp[k % 255]
    const omegaVal = polyEvalLE(omega, XkInv)
    const spVal = polyEvalLE(sigmaPrime, XkInv)
    if (spVal === 0) return null
    const ek = gfMul(Xk, gfMul(omegaVal, gfInv(spVal)))
    const idx = n - 1 - k  // big-endian array index for degree-k coefficient
    if (idx < 0 || idx >= n) return null
    corrected[idx] ^= ek
  }

  // Verify
  for (let i = 0; i < NROOTS; i++)
    if (polyEvalBE(corrected, gfPow(2, i)) !== 0) return null

  return corrected.slice(0, n - NROOTS)
}
