import { Readable } from 'stream'
import { isProd, getWebDevPort } from './utils'
import type { NextFunction, Request, Response } from 'express'

export function WebProxyMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isProd()) {
    return next()
  }

  const { originalUrl, method } = req
  if (originalUrl.startsWith('/web/pages') && method === 'GET') {
    const url = originalUrl.replace('/web/pages', `http://localhost:${getWebDevPort()}`)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'host' || key === 'connection') {
        continue
      }
      if (value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
      }
    }
    fetch(url, {
      method: 'GET',
      headers,
    })
      .then((response) => {
        res.status(response.status)
        response.headers.forEach((value, key) => {
          res.setHeader(key, value)
        })
        if (response.body == null) {
          res.end()
          return
        }
        const nodeReadable = Readable.fromWeb(response.body as any)
        nodeReadable.pipe(res)
        nodeReadable.on('error', (err) => next(err))
      })
      .catch((error) => {
        next(error)
      })
    return
  }

  return next()
}
