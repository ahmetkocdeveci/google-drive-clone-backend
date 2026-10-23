import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { HttpError } from './errors.mjs'

export function createEdgeProxyGuard(config) {
  const digest = value => createHash('sha256').update(value).digest()
  const expected = config.edgeProxyToken ? digest(config.edgeProxyToken) : null
  return (req, res, next) => {
    if (!expected || !/^\/api(?:\/|$)/i.test(req.path)) return next()
    res.set('Cache-Control', 'no-store')
    const supplied = req.get('X-Drive-Edge-Token') || ''
    const clientIp = req.get('X-Drive-Client-IP') || ''
    if (!timingSafeEqual(expected, digest(supplied)) || !isIP(clientIp) || /[\s,%]/.test(clientIp)) {
      return next(new HttpError(403, 'EDGE_REQUIRED', 'Bu istek kabul edilmiyor.'))
    }
    // Only the authenticated gateway can supply the address used by rate limiting.
    req.edgeClientIp = clientIp
    delete req.headers['x-drive-edge-token']
    delete req.headers['x-drive-client-ip']
    next()
  }
}
