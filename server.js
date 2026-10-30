// 제주 역사문화 탐방기 서버
//  - public/ 의 정적 파일을 제공하고
//  - /api/* 요청을 공공데이터포털(odcloud) API로 중계한다. 서비스키는 환경변수에서만 읽고 브라우저로 내보내지 않는다.
//
//  JEJU_CULTURE_INFO_KEY      제주역사문화 일반정보(15109587) 서비스키
//  JEJU_CULTURE_LOCATION_KEY  제주역사문화 위치정보(15109570) 서비스키
//  PORT                       기본 3000
import http from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { themeOf } from './themes.js'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public')
const BASE = process.env.ODCLOUD_BASE || 'https://api.odcloud.kr/api'
const PORT = Number(process.env.PORT) || 3000
const CACHE_MS = 10 * 60 * 1000

const SOURCES = {
  info: { env: 'JEJU_CULTURE_INFO_KEY', path: '/15109587/v1/uddi:56c2b3a4-4b4b-46cd-a1fa-f928ef731ffb' },
  location: { env: 'JEJU_CULTURE_LOCATION_KEY', path: '/15109570/v1/uddi:8781448b-81a8-487c-bc95-d26335bafa82' },
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// 포털의 Encoding 키(이미 %로 인코딩됨)와 Decoding 키 둘 다 허용
function serviceKey(source) {
  const key = (process.env[source.env] ?? '').trim()
  if (!key) throw new HttpError(503, `환경변수 ${source.env} 가 설정되지 않았습니다.`)
  return key.includes('%') ? key : encodeURIComponent(key)
}

async function odcloud(name, page, perPage) {
  const source = SOURCES[name]
  const url = `${BASE}${source.path}?page=${page}&perPage=${perPage}&serviceKey=${serviceKey(source)}`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  } catch {
    // 오류 객체에 키가 들어간 URL이 있을 수 있어 메시지를 새로 만든다
    throw new HttpError(504, `${name} API에 연결하지 못했습니다.`)
  }
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new HttpError(502, `${name} API 응답을 해석할 수 없습니다. (HTTP ${res.status})`)
  }
  if (!res.ok) {
    throw new HttpError(502, `${name} API 오류 (HTTP ${res.status}): ${json.msg ?? '알 수 없는 오류'}`)
  }
  return json
}

async function fetchAll(name) {
  const rows = []
  for (let page = 1; page <= 50; page++) {
    const json = await odcloud(name, page, 1000)
    rows.push(...(json.data ?? []))
    if (!json.data?.length || rows.length >= json.totalCount) break
  }
  return rows
}

const str = (v) => (v == null ? '' : String(v))

// 일반정보 + 위치정보를 '데이터 고유번호'로 합쳐 화면이 쓰는 모양으로 만든다
function merge(infoRows, locRows) {
  const loc = new Map(locRows.map((r) => [r['데이터 고유번호'], r]))
  return infoRows
    .map((g) => {
      const l = loc.get(g['데이터 고유번호']) ?? {}
      return {
        id: Number(g['데이터 고유번호']),
        name: str(g['장소명']),
        lat: parseFloat(g['위도'] ?? l['위도']),
        lng: parseFloat(g['경도'] ?? l['경도']),
        theme: themeOf(g['장소명'], g['디렉토리1']),
        cat: str(g['분류']),
        d1: str(g['디렉토리1']),
        d2: str(g['디렉토리2']),
        title: str(g['제목']),
        sub: str(g['부제목']),
        author: str(g['저작자']),
        topic: str(g['주제']),
        abs: str(g['초록']),
        body: str(g['내용']),
        toc: str(g['목차']),
        ref: str(g['참고문헌']),
        pub: str(g['발행자']),
        date: str(g['발행일']),
        link: str(g['링크'] || l['데이터 상세보기 URL']),
        zip: str(l['우편번호']),
        addr: str(l['위치']),
        base: str(g['데이터기준일자']),
      }
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
}

let cache = null // { at, data }
let inflight = null
function places() {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.data)
  inflight ??= Promise.all([fetchAll('info'), fetchAll('location')])
    .then(([info, location]) => {
      cache = { at: Date.now(), data: merge(info, location) }
      return cache.data
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// ── 연습 모드: API가 안 될 때 쓰는 1단계 파일 데이터(CSV, CP949) ──
// 컬럼명이 API 필드명과 같아서 merge()를 그대로 쓴다.
function parseCsv(text) {
  const rows = []
  let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { f += '"'; i++ } else q = false
      } else f += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = '' }
    else f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  const [head, ...body] = rows.filter((r) => r.length > 1)
  const keys = head.map((k) => k.replace(/^﻿/, ''))
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])))
}

let practiceCache = null
async function practice() {
  if (practiceCache) return practiceCache
  const dir = resolve(fileURLToPath(new URL('.', import.meta.url)))
  const files = (await readdir(dir)).filter((n) => n.endsWith('.csv'))
  const info = files.find((n) => n.includes('일반정보'))
  const loc = files.find((n) => n.includes('위치정보'))
  if (!info || !loc) throw new HttpError(404, '연습 모드용 CSV 파일(일반정보·위치정보)을 찾을 수 없습니다.')
  const read = async (n) => parseCsv(new TextDecoder('euc-kr').decode(await readFile(join(dir, n))))
  practiceCache = merge(await read(info), await read(loc))
  return practiceCache
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

// 원본 API 그대로 중계 (page, perPage만 허용)
async function passthrough(name, url, res) {
  const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1)
  const perPage = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('perPage')) || 10))
  send(res, 200, await odcloud(name, page, perPage), undefined, { 'Cache-Control': 'no-store' })
}

async function handleApi(url, res) {
  switch (url.pathname) {
    case '/api/places':
      return send(res, 200, await places(), undefined, { 'Cache-Control': 'max-age=300' })
    case '/api/practice':
      return send(res, 200, await practice(), undefined, { 'Cache-Control': 'no-store' })
    case '/api/info':
      return passthrough('info', url, res)
    case '/api/location':
      return passthrough('location', url, res)
    case '/api/health':
      return send(res, 200, {
        ok: true,
        keys: Object.fromEntries(Object.entries(SOURCES).map(([n, s]) => [s.env, Boolean(process.env[s.env])])),
      })
    default:
      throw new HttpError(404, '없는 API입니다.')
  }
}

async function handleStatic(url, res) {
  let rel
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    return send(res, 400, 'Bad Request', 'text/plain; charset=utf-8')
  }
  const file = resolve(join(ROOT, rel === '/' ? 'index.html' : rel))
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8')
  try {
    send(res, 200, await readFile(file), MIME[extname(file)] ?? 'application/octet-stream')
  } catch {
    send(res, 404, 'Not Found', 'text/plain; charset=utf-8')
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method !== 'GET') return send(res, 405, { error: 'GET만 지원합니다.' })
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(url, res)
      else await handleStatic(url, res)
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      if (status === 500) console.error(e.message)
      send(res, status, { error: status === 500 ? '서버 오류' : e.message })
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`http://localhost:${PORT}`)
    for (const s of Object.values(SOURCES)) if (!process.env[s.env]) console.warn(`! ${s.env} 가 설정되지 않았습니다`)
  })
