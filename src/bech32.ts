/**
 * Minimal bech32 encoder for converting Nibiru EVM addresses (0x...) into
 * the Cosmos-side bech32 form (nibi1...). The sai-keeper indexes trades by
 * the bech32 address, so any read query that filters by trader must use
 * this form.
 *
 * Ported from nibiru-agent/test-open-long.ts.
 */

import { ethers } from "ethers"

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i] ?? 0
    }
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = []
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5)
  ret.push(0)
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31)
  return ret
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = polymod(values) ^ 1
  const ret: number[] = []
  for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 31)
  return ret
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const ret: number[] = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("convertBits: invalid value")
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      ret.push((acc >> bits) & maxv)
    }
  }
  if (pad && bits > 0) ret.push((acc << (to - bits)) & maxv)
  return ret
}

export function evmToBech32(evmAddr: string, hrp = "nibi"): string {
  const bytes = Array.from(ethers.getBytes(evmAddr))
  const words = convertBits(bytes, 8, 5, true)
  const checksum = createChecksum(hrp, words)
  return hrp + "1" + [...words, ...checksum].map((d) => CHARSET[d]).join("")
}
