#!/usr/bin/env node
/**
 * weather-watch.mjs —— 北京海淀的天气与预警
 *
 * 两个来源都不需要 key：
 *   中央气象台预警  https://www.nmc.cn/rest/findAlarm?province=北京市
 *   open-meteo     https://api.open-meteo.com/v1/forecast
 *
 * 两种用法（主人 2026-11-04 定下的两条，互不冲突）：
 *   1. 补课  每跑一次，把「还没跟她说过的预警」追加进 pending，她醒来先读这个
 *   2. 现查  --check 时现拉一次当下天气，看此刻到底是什么状况
 *
 * 命令：
 *   node weather-watch.mjs            跑一次（更新 latest + 追加 pending）
 *   node weather-watch.mjs --check    只打印当下，不写文件
 *   node weather-watch.mjs --ack      清空 pending（她已经说过了）
 *
 * 只盯北京海淀。全国只在有人问的时候临时查，不进自动流程。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const cfgPath = process.env.WEATHER_CONFIG || path.join(ROOT, 'config.json')
let CFG = {}
try { CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { /* 没配置就用默认值 */ }
const STATE_DIR = process.env.WEATHER_STATE_DIR || CFG.stateDir || path.join(ROOT, 'state')
const LATEST = path.join(STATE_DIR, 'weather-latest.json')
const PENDING = path.join(STATE_DIR, 'weather-pending.json')

// 北京海淀
const PLACE = {
  city: CFG.place?.city ?? '北京',
  district: CFG.place?.district ?? '海淀',
  province: CFG.place?.province ?? '北京市',
  lat: Number(CFG.place?.lat ?? 39.96),
  lon: Number(CFG.place?.lon ?? 116.30),
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) lanxi-weather/1.0' }

const WMO = {
  0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
  45: '雾', 48: '冻雾',
  51: '小毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
}

function nowISO() {
  const d = new Date(Date.now() + 8 * 3600e3)
  return d.toISOString().replace('Z', '+08:00')
}

async function getJSON(url, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

/** 中央气象台：按省拉一批，再按市/区筛，分三档 */
// 北京下辖的县市区（这些地方发预警跟他没关系，只当参考）
const NEARBY = Array.isArray(CFG.nearby) && CFG.nearby.length
  ? CFG.nearby
  : ['昌平', '朝阳', '东城', '西城', '丰台', '石景山', '门头沟', '房山', '通州', '顺义', '大兴', '怀柔', '平谷', '密云', '延庆']

async function fetchWarnings() {
  const url = `https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=50&signaltype=&signallevel=&province=${encodeURIComponent(PLACE.province)}`
  const j = await getJSON(url)
  const list = j?.data?.page?.list ?? []
  const out = []
  for (const it of list) {
    const title = String(it.title ?? '')
    if (!title.includes(PLACE.city) && !title.includes(PLACE.district)) continue
    // 分档：本地 > 市本级 > 周边县市
    let level = 'nearby'
    if (title.includes(PLACE.district)) level = 'local'
    else if (!NEARBY.some((c) => title.includes(c))) level = 'city'
    out.push({
      id: String(it.alertid ?? ''),
      time: String(it.issuetime ?? ''),
      title,
      level,
      url: it.url ? `https://www.nmc.cn${it.url}` : '',
    })
  }
  return out
}

/** open-meteo：此刻 */
async function fetchNow() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${PLACE.lat}&longitude=${PLACE.lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
    `&timezone=Asia/Shanghai`
  const j = await getJSON(url)
  const c = j?.current ?? {}
  return {
    time: c.time,
    temp: c.temperature_2m,
    feels: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    precip: c.precipitation,
    code: c.weather_code,
    text: WMO[c.weather_code] ?? `代码 ${c.weather_code}`,
    wind: c.wind_speed_10m,
  }
}

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

// 注意：不能用 PowerShell 的 Set-Content 写这些文件（会带 BOM，插件读不了）
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
}

async function main() {
  const argv = new Set(process.argv.slice(2))

  if (argv.has('--ack')) {
    writeJSON(PENDING, { updatedAt: nowISO(), items: [] })
    console.log('pending 已清空')
    return
  }

  let warnings = []
  let warnErr = null
  try {
    warnings = await fetchWarnings()
  } catch (e) {
    warnErr = e.message
  }

  let nowWeather = null
  let nowErr = null
  try {
    nowWeather = await fetchNow()
  } catch (e) {
    nowErr = e.message
  }

  const latest = {
    updatedAt: nowISO(),
    place: PLACE,
    warnings,
    wantErr: warnErr,
    now: nowWeather,
    nowErr,
  }

  if (argv.has('--check')) {
    console.log(JSON.stringify(latest, null, 2))
    return
  }

  writeJSON(LATEST, latest)

  // 补课：只把「本地/市本级」的、没见过的预警追加进 pending
  // 周边县市的预警只记在 latest 里当参考，不主动说
  const prev = readJSON(PENDING, { items: [] })
  const seen = new Set((prev.items ?? []).map((x) => x.id))
  const fresh = warnings.filter(
    (w) => w.id && w.level !== 'nearby' && !seen.has(w.id),
  )

  if (fresh.length) {
    const merged = { updatedAt: nowISO(), items: [...(prev.items ?? []), ...fresh] }
    writeJSON(PENDING, merged)
    console.log(`新增预警 ${fresh.length} 条`)
    for (const f of fresh) console.log(`  ${f.time} ${f.title}`)
  } else {
    console.log('没有新预警')
  }

  if (nowWeather) {
    console.log(`此刻 ${PLACE.city}${PLACE.district} ${nowWeather.temp}℃ ${nowWeather.text} 体感${nowWeather.feels}℃`)
  }
  if (warnErr) console.error('预警接口出错：' + warnErr)
  if (nowErr) console.error('天气接口出错：' + nowErr)
}

main().catch((e) => {
  console.error('跑挂了：' + e.message)
  process.exit(1)
})
