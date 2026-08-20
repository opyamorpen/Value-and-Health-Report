/* eslint-disable no-control-regex */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, basename, extname, relative } from 'node:path'
import fse from 'fs-extra'
import { glob } from 'glob'
import { build, defineConfig, mergeConfig } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import type { InlineConfig, UserConfig, ViteDevServer } from 'vite'

const { existsSync, readdirSync, remove, copy } = fse

const backendHostedPort = Number(process.env.ONES_HOSTED_PORT) || 8201
const webDevPort = Number(process.env.ONES_DEV_WEB_SERVER_PORT) || 8202
const NODE_ENV = process.env.NODE_ENV === 'development' ? 'development' : 'production'
const __dirname = dirname(fileURLToPath(import.meta.url))

const distDir = resolve(__dirname, 'dist')
const distWebDir = resolve(distDir, 'web')
const distPublicDir = resolve(distDir, 'public')

const webDir = resolve(__dirname, 'web')
const publicDir = resolve(__dirname, 'public')
const viteDir = resolve(__dirname, '.vite')

const sleep = (number: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, number)
  })
}

const defaultConfig: InlineConfig = {
  root: __dirname,
  configFile: false,
  build: {
    lib: {
      entry: '',
      name: '',
      fileName: '',
      formats: ['iife'],
    },
    emptyOutDir: false,
    copyPublicDir: false,
    // Image assets under 128KB are inlined by default
    // External assets must be placed in the public directory and referenced by URL
    assetsInlineLimit: 128 * 1024,
  },
  resolve: {
    alias: {
      '@': webDir,
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
  },
  plugins: [cssInjectedByJsPlugin() as InlineConfig['plugins']],
}

const devConfig: UserConfig = {
  build: {
    outDir: viteDir,
    minify: false,
    sourcemap: true,
  },
  esbuild: {
    keepNames: true,
  },
}

const prodConfig: UserConfig = {
  mode: 'production',
  build: {
    outDir: distWebDir,
  },
}

const buildJS = async (filename: string) => {
  const appConfig: UserConfig = {
    build: {
      lib: {
        name: 'index',
        entry: resolve(webDir, `pages/${filename}/index.tsx`),
        fileName: () => `pages/${filename}.js`,
      },
    },
  }
  const envConfig = NODE_ENV === 'development' ? devConfig : prodConfig
  return await build(mergeConfig(defaultConfig, mergeConfig(envConfig, appConfig)))
}

const htmlTemplate = readFileSync(resolve(__dirname, 'web/template/index.html'), {
  encoding: 'utf-8',
})

const createdHTML = (...scripts: string[]) => {
  return htmlTemplate.replace('<!-- SCRIPT -->', scripts.join('\n'))
}

const messagePlugin = () => {
  return {
    name: 'message-plugin',
    configureServer(server: ViteDevServer) {
      server.printUrls = () => {
        const base = `http://localhost:${backendHostedPort}`
        sleep(2000).then(() => {
          glob(resolve(webDir, 'pages/**/index.tsx')).then((entryFiles) => {
            for (const entryFile of entryFiles) {
              const entryName = basename(dirname(entryFile))
              console.log(`Entry "${entryName}" URL: ${base}/web/pages/${entryName}.html`)
            }
          })
        })
      }
    },
  }
}

const devPlugin = () => {
  const codeMap: Record<string, string> = {}
  const visitMap: Record<string, boolean> = {}
  const counterMap: Record<string, number> = {}
  const timerMap: Record<string, ReturnType<typeof setTimeout>> = {}
  const htmlType = 'text/html; charset=utf-8'
  const plainType = 'text/plain; charset=utf-8'
  const jsType = 'application/javascript; charset=utf-8'
  const jsonType = 'application/json; charset=utf-8'
  const debounceTime = 300
  return {
    name: 'dev-plugin',
    configureServer(server: ViteDevServer) {
      server.watcher.on('add', (path) => {
        if (!path.startsWith(webDir)) return
        const rel = relative(webDir, path).replace(/\\/g, '/')
        const match = rel.match(/^pages\/([^/]+)\/index\.tsx$/)
        if (match) {
          const entryName = match[1]
          const base = `http://localhost:${backendHostedPort}`
          console.log(
            `Entry "${entryName}" created successfully: ${base}/web/pages/${entryName}.html`,
          )
        }
      })
      server.watcher.on('change', (path) => {
        if (!path.startsWith(webDir)) return
        const rel = relative(webDir, path).replace(/\\/g, '/')
        const match = rel.match(/^pages\/([^/]+)\//)
        if (match) {
          const entryName = match[1]
          const hasVisit = visitMap[entryName]
          if (hasVisit) {
            if (timerMap[entryName]) clearTimeout(timerMap[entryName])
            timerMap[entryName] = setTimeout(() => {
              const invoke = async () => {
                try {
                  codeMap[entryName] = ''
                  console.log(`Entry "${entryName}" recompiling...`)
                  await buildJS(entryName)
                  console.log(`Entry "${entryName}" compiled successfully`)
                  const js = readFileSync(resolve(viteDir, `pages/${entryName}.js`), {
                    encoding: 'utf-8',
                  })
                  codeMap[entryName] = js
                  counterMap[entryName] = counterMap[entryName] || 0
                  counterMap[entryName] += 1
                } catch (err) {
                  console.log(`Entry "${entryName}" compiled failed`)
                  const error = err as Error
                  console.log(error)
                }
              }
              invoke()
            }, debounceTime)
          }
        }
      })
      server.middlewares.use((req, res) => {
        const invoke = async () => {
          const pathString = req.url?.split('?')[0] ?? ''
          const trimString = pathString.replace(/^\//, '')
          const firstString = trimString.split('/')[0] ?? ''
          const ext = extname(firstString)
          if (ext === '.html' || ext === '.js') {
            const filename = firstString.replace(ext, '')
            const entry = resolve(webDir, `pages/${filename}/index.tsx`)
            const exists = existsSync(entry)
            if (exists) {
              visitMap[filename] = true
              if (ext === '.html') {
                res.statusCode = 200
                res.setHeader('Content-Type', htmlType)
                res.end(createdHTML(`<script src="./${filename}.js"></script>`))
                return
              }
              if (codeMap[filename]) {
                console.log(`Entry "${filename}" using cached code`)
                res.setHeader('Content-Type', jsType)
                res.statusCode = 200
                res.end(codeMap[filename])
                return
              }
              try {
                console.log(`Entry "${filename}" compiling...`)
                await buildJS(filename)
                console.log(`Entry "${filename}" compiled successfully`)
                const js = readFileSync(resolve(viteDir, `pages/${filename}.js`), {
                  encoding: 'utf-8',
                })
                codeMap[filename] = js
                counterMap[filename] = counterMap[filename] || 0
                counterMap[filename] += 1
                res.setHeader('Content-Type', jsType)
                res.statusCode = 200
                res.end(js)
              } catch (err) {
                console.log(`Entry "${filename}" compiled failed`)
                const error = err as Error
                console.log(error)
                res.statusCode = 200
                res.setHeader('Content-Type', jsType)
                const string = error.stack?.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '') ?? ''
                const message = '`' + string + '`'
                res.end(`console.error(${message})`)
              }
              return
            }
            res.statusCode = 500
            res.setHeader('Content-Type', plainType)
            res.end(`Entry not found, ${entry}`)
            return
          }
          if (/\.js\.map$/.test(firstString)) {
            const filename = firstString
            try {
              const json = readFileSync(resolve(viteDir, `pages/${filename}`), {
                encoding: 'utf-8',
              })
              res.statusCode = 200
              res.setHeader('Content-Type', jsonType)
              res.end(json)
              return
            } catch (error) {
              String(error)
            }
          }
          res.statusCode = 500
          res.setHeader('Content-Type', plainType)
          res.end('File not found')
        }
        invoke()
      })
    },
  }
}

export default defineConfig(async ({ command }) => {
  const isDev = command === 'serve'
  if (isDev) {
    return {
      root: __dirname,
      server: {
        port: webDevPort,
      },
      plugins: [messagePlugin(), devPlugin()],
    }
  }
  const sources = readdirSync(resolve(distDir))
  for (const source of sources) {
    if (source === 'backend') continue
    await remove(resolve(distDir, source))
  }
  await copy(publicDir, distPublicDir)
  const pages = await glob(resolve(webDir, 'pages/**/index.tsx'))
  for (const page of pages) {
    const filename = basename(dirname(page))
    await buildJS(filename)
    writeFileSync(
      resolve(distWebDir, `pages/${filename}.html`),
      createdHTML(`<script src="./${filename}.js"></script>`),
      {
        encoding: 'utf-8',
      },
    )
  }
  process.exit(0)
})
