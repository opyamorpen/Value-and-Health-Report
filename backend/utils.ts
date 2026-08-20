import { join } from 'node:path'

export const isDev = () => {
  return process.env.NODE_ENV === 'development'
}

export const isProd = () => {
  return !isDev()
}

export const getHostedPort = () => {
  return Number(process.env.ONES_HOSTED_PORT) || 8201
}

export const getWebDevPort = () => {
  return Number(process.env.ONES_DEV_WEB_SERVER_PORT) || 8202
}

export const getRootPath = () => {
  return __dirname
}

export const getPublicPath = () => {
  return join(getRootPath(), '..', 'public')
}

export const createPublicURL = (path: string) => {
  return `/public/${path}`
}

export const getWebPath = () => {
  return join(getRootPath(), '..', 'web')
}

export const createWebURL = (path: string) => {
  return `/web/${path}`
}

export const createWebPageURL = (path: string) => {
  return `/web/pages/${path}`
}
