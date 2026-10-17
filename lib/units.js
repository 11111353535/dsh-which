/**
 * Small formatting helpers shared by every renderer.
 *
 * @module dsh-which/lib/units
 */

/**
 * Bytes rendered compactly: `0B`, `812B`, `1.4KB`, `12MB`.
 *
 * @param {number} bytes - byte count.
 * @returns {string} rendered size.
 */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rendered = unit > 0 && value < 10 ? value.toFixed(1).replace(/\.0$/u, '') : String(Math.round(value))
  return `${rendered}${units[unit]}`
}

/**
 * Elapsed time rendered compactly: `just now`, `45s`, `10m`, `2h13m`, `3d4h`.
 *
 * @param {number} seconds - elapsed seconds.
 * @returns {string} rendered age.
 */
export function humanAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

/**
 * Trim a path for display, keeping the tail where the information is.
 *
 * @param {string} value - path to shorten.
 * @param {number} [max] - maximum width.
 * @returns {string} display path.
 */
export function shortenPath(value, max = 72) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  return `…${text.slice(text.length - max + 1)}`
}
