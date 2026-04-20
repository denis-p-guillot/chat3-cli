/**
 * One-off / repeatable: reads legacy grid (yearlyPriceUsd = B2C 1y) and writes
 * web/src/lib/data/purpleCloudProductGrid.json with B2B + optional 3y columns.
 *
 * Run: node scripts/expand-purplecloud-product-grid.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const gridPath = path.join(__dirname, '../src/lib/data/purpleCloudProductGrid.json')

/** Exact DO yearly B2B / B2C from commercial sheet (3y not offered on DO in this catalog). */
const DO_YEARLY = {
  'DO-1vcpu-1gbram-25gbssd-NoBackup': [108, 132],
  'DO-1vcpu-2gbram-50gbssd-NoBackup': [187.2, 220.8],
  'DO-2vcpu-2gbram-60gbssd-NoBackup': [240, 288],
  'DO-2vcpu-4gbram-80gbssd-NoBackup': [384, 480],
  'DO-4vcpu-8gbram-160gbssd-NoBackup': [768, 960],
  'DO-8vcpu-16gbram-320gbssd-NoBackup': [1536, 1920],
  'DO-1vcpu-1gbram-25gbssd-Backup': [150, 240],
  'DO-1vcpu-2gbram-50gbssd-Backup': [246, 372],
  'DO-2vcpu-2gbram-60gbssd-Backup': [324, 504],
  'DO-2vcpu-4gbram-80gbssd-Backup': [552, 912],
  'DO-4vcpu-8gbram-160gbssd-Backup': [1104, 1824],
  'DO-8vcpu-16gbram-320gbssd-Backup': [2208, 3648],
}

/**
 * Approximate B2B 1y from B2C 1y using family-specific ratio from the commercial sheet
 * (first row of each ladder). Replace with exact per-SKU values when importing full sheet.
 */
function approxB2bFromB2c(productName, b2c) {
  if (productName.startsWith('DO-')) {
    const pair = DO_YEARLY[productName]
    if (pair) return pair[0]
    return Math.round(b2c * 0.82 * 100) / 100
  }
  if (productName.startsWith('GCP-')) {
    return Math.round(b2c * (657.17 / 897.17) * 100) / 100
  }
  if (productName.startsWith('AWS-')) {
    if (productName.includes('2vcpu-1gbram-')) return Math.round(b2c * (360 / 600) * 100) / 100
    if (productName.includes('2vcpu-2gbram-')) return Math.round(b2c * (600 / 1080) * 100) / 100
    if (productName.includes('2vcpu-4gbram-')) return Math.round(b2c * (840 / 1560) * 100) / 100
    if (productName.includes('2vcpu-8gbram-')) return Math.round(b2c * (1080 / 2040) * 100) / 100
    // Sheet shows same B2B and B2C yearly on this ladder (e.g. 50 GB row).
    if (productName.includes('2vcpu-16gbram-')) return b2c
    if (productName.includes('4vcpu-8gbram-')) return Math.round(b2c * (1560 / 3000) * 100) / 100
    if (productName.includes('4vcpu-16gbram-')) return Math.round(b2c * (4440 / 9120) * 100) / 100
    if (productName.includes('8vcpu-16gbram-')) return Math.round(b2c * (5880 / 11640) * 100) / 100
    if (productName.includes('8vcpu-32gbram-')) return Math.round(b2c * (9240 / 13920) * 100) / 100
    if (productName.includes('16vcpu-32gbram-')) return Math.round(b2c * (11640 / 16320) * 100) / 100
    return Math.round(b2c * 0.55 * 100) / 100
  }
  return Math.round(b2c * 0.55 * 100) / 100
}

/** 3y totals: DO has no 3y in sheet. AWS/GCP: approximate from 1y B2C using ratio from AWS 50 GB row (1512/600). */
function approx3yB2c(productName, b2c1y) {
  if (productName.startsWith('DO-')) return null
  if (productName.startsWith('AWS-') || productName.startsWith('GCP-')) {
    return Math.round(b2c1y * (1512 / 600) * 100) / 100
  }
  return null
}

function approx3yB2b(productName, b2b1y) {
  if (productName.startsWith('DO-')) return null
  if (productName.startsWith('AWS-') || productName.startsWith('GCP-')) {
    return Math.round(b2b1y * (936 / 360) * 100) / 100
  }
  return null
}

function expand(row) {
  if (row.priceYearlyB2c != null && row.priceYearlyB2b != null) {
    return row
  }
  const b2c = row.yearlyPriceUsd ?? row.priceYearlyB2c
  const b2b = DO_YEARLY[row.productName]?.[0] ?? approxB2bFromB2c(row.productName, b2c)
  return {
    productName: row.productName,
    lightUsers: row.lightUsers,
    cloudSpecifications: row.cloudSpecifications,
    workersOdoo: row.workersOdoo,
    priceYearlyB2b: b2b,
    priceYearlyB2c: b2c,
    price3yB2b: row.price3yB2b ?? approx3yB2b(row.productName, b2b),
    price3yB2c: row.price3yB2c ?? approx3yB2c(row.productName, b2c),
  }
}

const raw = JSON.parse(fs.readFileSync(gridPath, 'utf8'))
const out = raw.map(expand)
fs.writeFileSync(gridPath, JSON.stringify(out, null, 0), 'utf8')
console.log(`Expanded ${out.length} rows in ${gridPath}`)
