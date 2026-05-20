import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceConfigPath = resolve(rootDir, 'wrangler.jsonc')
const resolvedConfigPath = resolve(rootDir, '.wrangler', 'resolved.jsonc')
const bindingName = process.env.TAYGEDO_KV_BINDING || 'TAYGEDO_KV'
const writeSourceOnWorkersCi = process.argv.includes('--write-source-on-workers-ci')

if (writeSourceOnWorkersCi && process.env.WORKERS_CI !== '1') {
  process.exit(0)
}

const sourceConfig = parseJsonc(readFileSync(sourceConfigPath, 'utf8'))
const namespaceName =
  process.env.TAYGEDO_KV_NAME ||
  `${sourceConfig.name}-${bindingName.toLowerCase().replaceAll('_', '-')}`
const explicitNamespaceId =
  process.env.TAYGEDO_KV_ID ||
  process.env.KV_NAMESPACE_ID ||
  process.env.CLOUDFLARE_KV_NAMESPACE_ID

const namespaceId = explicitNamespaceId || (await findExistingNamespaceId(namespaceName))
const resolvedConfig = structuredClone(sourceConfig)
const namespaceBinding = resolvedConfig.kv_namespaces?.find((item) => item.binding === bindingName)

if (!namespaceBinding) {
  throw new Error(`wrangler.jsonc 中缺少 KV 绑定 ${bindingName}`)
}

if (namespaceId) {
  namespaceBinding.id = namespaceId
  console.log(`Using existing KV namespace "${namespaceName}" for ${bindingName}.`)
} else if (namespaceBinding.id) {
  console.log(`Using KV namespace id already configured for ${bindingName}.`)
} else {
  console.log(`No existing KV namespace named "${namespaceName}" was found. Wrangler may create it during deploy.`)
}

if (writeSourceOnWorkersCi) {
  writeConfig(sourceConfigPath, resolvedConfig)
} else {
  writeConfig(resolvedConfigPath, resolvedConfig)
}

async function findExistingNamespaceId(title) {
  const namespaces = (await listNamespacesFromApi()) || listNamespacesFromWrangler()
  const namespace = namespaces?.find((item) => item.title === title || item.name === title)
  return namespace?.id
}

async function fetchNamespacesFromApi(accountId, token) {
  const namespaces = []
  let page = 1

  while (true) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    const data = await response.json()

    if (!response.ok || !data.success) {
      throw new Error(data.errors?.[0]?.message || `Cloudflare API returned ${response.status}`)
    }

    namespaces.push(...data.result)

    if (page >= (data.result_info?.total_pages || 1)) {
      return namespaces
    }
    page += 1
  }
}

async function listNamespacesFromApi() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN

  if (!accountId || !token) {
    return null
  }

  try {
    return await fetchNamespacesFromApi(accountId, token)
  } catch (error) {
    console.warn(`Cloudflare API namespace lookup failed: ${error.message}`)
    return null
  }
}

function listNamespacesFromWrangler() {
  try {
    const wrangler = resolveWranglerCommand()
    const output = execFileSync(
      wrangler,
      [
        'kv',
        'namespace',
        'list',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
      ],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return parseWranglerNamespaceList(output)
  } catch (error) {
    const message = error.stderr?.toString().trim() || error.message
    console.warn(`Wrangler namespace lookup failed: ${message}`)
    return null
  }
}

function resolveWranglerCommand() {
  const localBin = resolve(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
  )

  return existsSync(localBin) ? localBin : 'wrangler'
}

function writeConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Wrote ${path}.`)
}

function parseWranglerNamespaceList(output) {
  const trimmed = output.trim()
  const jsonStart = trimmed.indexOf('[')
  const jsonEnd = trimmed.lastIndexOf(']')

  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1))
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...titleParts] = line.split(/\s+/)
      return { id, title: titleParts.join(' ') }
    })
    .filter((item) => /^[a-f0-9]{32}$/i.test(item.id) && item.title)
}

function parseJsonc(source) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(source)))
}

function stripJsonComments(source) {
  let output = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        output += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      output += char
    } else if (char === '/' && next === '/') {
      inLineComment = true
      index += 1
    } else if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
    } else {
      output += char
    }
  }

  return output
}

function stripTrailingCommas(source) {
  return source.replace(/,\s*([}\]])/g, '$1')
}
