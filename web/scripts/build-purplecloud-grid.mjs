/**
 * Generates web/src/lib/data/purpleCloudProductGrid.json
 * from PurpleCloud product definitions (same columns as commercial grid).
 * Run: node scripts/build-purplecloud-grid.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(__dirname, '../src/lib/data/purpleCloudProductGrid.json')

function doSpec({ workerLabel, ssdGb, backup }) {
  const backupLine = backup
    ? 'Automatic backup: 7 Days, 4 Weeks, and 3 Months'
    : 'Automatic backup: None'
  const w = Number(workerLabel)
  const workerLine =
    Number.isFinite(w) && w > 1 ? `Odoo Workers: ${workerLabel}` : `Odoo Worker: ${workerLabel}`
  return [
    'Backed by Digital Ocean infrastructure (SLA 99.98%)',
    'Server monitoring (24/7/365)',
    workerLine,
    `SSD Storage: ${ssdGb} GB`,
    'Cloudflare Pro: Included',
    'Antivirus scan: Not included',
    backupLine,
  ].join('\n')
}

function awsSpec({ workers, ssdGb }) {
  return [
    'Backed by AWS EC2 infrastructure (SLA 99.99%)',
    'Server monitoring (24/7/365)',
    `Odoo Workers: ${workers}`,
    `SSD Storage: ${ssdGb} GB`,
    'Cloudflare Pro: Included',
    'Antivirus scan: Included',
    'Automatic backup: 7 Days, 4 Weeks, and 3 Months',
  ].join('\n')
}

function gcpSpec({ workers, ssdGb }) {
  return [
    'Backed by GCP infrastructure (SLA 99.99%)',
    'Server monitoring (24/7/365)',
    `Odoo Workers: ${workers}`,
    `SSD Storage: ${ssdGb} GB`,
    'Cloudflare Pro: Included',
    'Antivirus scan: Included',
    'Automatic backup: 7 Days, 4 Weeks, and 3 Months',
  ].join('\n')
}

function row(productName, lightUsers, cloudSpecifications, workersOdoo, yearlyPriceUsd) {
  return { productName, lightUsers, cloudSpecifications, workersOdoo, yearlyPriceUsd }
}

const SSD_TIERS = [50, 100, 200, 400, 600, 800, 1000, 1500, 2000]

const rows = []

// ——— Digital Ocean (exact product names & pricing from grid) ———
rows.push(
  row(
    'DO-1vcpu-1gbram-25gbssd-NoBackup',
    12.5,
    doSpec({ workerLabel: '0.5', ssdGb: 25, backup: false }),
    1,
    132.0,
  ),
  row(
    'DO-1vcpu-2gbram-50gbssd-NoBackup',
    17.5,
    doSpec({ workerLabel: '0.7', ssdGb: 50, backup: false }),
    1,
    220.8,
  ),
  row(
    'DO-2vcpu-2gbram-60gbssd-NoBackup',
    25,
    doSpec({ workerLabel: '1', ssdGb: 60, backup: false }),
    2,
    288.0,
  ),
  row(
    'DO-2vcpu-4gbram-80gbssd-NoBackup',
    50,
    doSpec({ workerLabel: '2', ssdGb: 80, backup: false }),
    3,
    480.0,
  ),
  row(
    'DO-4vcpu-8gbram-160gbssd-NoBackup',
    100,
    doSpec({ workerLabel: '4', ssdGb: 160, backup: false }),
    5,
    960.0,
  ),
  row(
    'DO-8vcpu-16gbram-320gbssd-NoBackup',
    200,
    doSpec({ workerLabel: '8', ssdGb: 320, backup: false }),
    10,
    1920.0,
  ),
  row(
    'DO-1vcpu-1gbram-25gbssd-Backup',
    12.5,
    doSpec({ workerLabel: '0.5', ssdGb: 25, backup: true }),
    1,
    240.0,
  ),
  row(
    'DO-1vcpu-2gbram-50gbssd-Backup',
    17.5,
    doSpec({ workerLabel: '0.7', ssdGb: 50, backup: true }),
    1,
    372.0,
  ),
  row(
    'DO-2vcpu-2gbram-60gbssd-Backup',
    25,
    doSpec({ workerLabel: '1', ssdGb: 60, backup: true }),
    2,
    504.0,
  ),
  row(
    'DO-2vcpu-4gbram-80gbssd-Backup',
    50,
    doSpec({ workerLabel: '2', ssdGb: 80, backup: true }),
    3,
    912.0,
  ),
  row(
    'DO-4vcpu-8gbram-160gbssd-Backup',
    100,
    doSpec({ workerLabel: '4', ssdGb: 160, backup: true }),
    5,
    1824.0,
  ),
  row(
    'DO-8vcpu-16gbram-320gbssd-Backup',
    200,
    doSpec({ workerLabel: '8', ssdGb: 320, backup: true }),
    10,
    3648.0,
  ),
)

function addAws2vcpu(ramGb, lightUsers, workers, prices) {
  SSD_TIERS.forEach((ssd, i) => {
    const name = `AWS-2vcpu-${ramGb}gbram-${ssd}gbssd-Backup`
    rows.push(row(name, lightUsers, awsSpec({ workers, ssdGb: ssd }), workers, prices[i]))
  })
}

// AWS 2 vCPU ladders (light users & yearly USD from grid)
addAws2vcpu(1, 25, 1, [600, 720, 960, 1440, 1920, 2400, 2880, 4080, 5280])
addAws2vcpu(2, 50, 2, [1080, 1200, 1440, 1920, 2400, 2880, 3360, 4560, 5760])
addAws2vcpu(4, 75, 3, [1560, 1680, 1920, 2400, 2880, 3360, 3840, 5040, 6240])
addAws2vcpu(8, 100, 4, [2040, 2160, 2400, 2880, 3360, 3840, 4320, 5520, 6720])
addAws2vcpu(16, 125, 5, [2520, 2640, 2880, 3360, 3840, 4320, 4800, 6000, 7200])

function addAws4vcpu8gbram(lightBase, workersBase, priceMatrix) {
  const light = priceMatrix.map((_, r) => lightBase + r * 25)
  const workers = priceMatrix.map((_, r) => workersBase + r)
  for (let r = 0; r < priceMatrix.length; r++) {
    SSD_TIERS.forEach((ssd, i) => {
      const name = `AWS-4vcpu-8gbram-${ssd}gbssd-Backup`
      rows.push(
        row(name, light[r], awsSpec({ workers: workers[r], ssdGb: ssd }), workers[r], priceMatrix[r][i]),
      )
    })
  }
}

addAws4vcpu8gbram(150, 6, [
  [3000, 3120, 3360, 3840, 4320, 4800, 5280, 6480, 7680],
  [3480, 3600, 3840, 4320, 4800, 5280, 5760, 6960, 8160],
  [3960, 4080, 4320, 4800, 5280, 5760, 6240, 7440, 8640],
])

function addAws4vcpu16gbram(lightBase, workersBase, priceMatrix) {
  const light = priceMatrix.map((_, r) => lightBase + r * 25)
  const workers = priceMatrix.map((_, r) => workersBase + r)
  for (let r = 0; r < priceMatrix.length; r++) {
    SSD_TIERS.forEach((ssd, i) => {
      const name = `AWS-4vcpu-16gbram-${ssd}gbssd-Backup`
      rows.push(
        row(name, light[r], awsSpec({ workers: workers[r], ssdGb: ssd }), workers[r], priceMatrix[r][i]),
      )
    })
  }
}

addAws4vcpu16gbram(225, 9, [
  [4440, 4560, 4800, 5280, 5760, 6240, 6720, 7920, 9120],
  [4920, 5040, 5280, 5760, 6240, 6720, 7200, 8400, 9600],
])

function addAws8vcpu16gbram(lightStart, workersStart, priceRows) {
  // 5 light steps x 9 SSD
  for (let s = 0; s < 5; s++) {
    const light = lightStart + s * 25
    const workers = workersStart + s
    SSD_TIERS.forEach((ssd, i) => {
      const name = `AWS-8vcpu-16gbram-${ssd}gbssd-Backup`
      rows.push(row(name, light, awsSpec({ workers, ssdGb: ssd }), workers, priceRows[s][i]))
    })
  }
}

addAws8vcpu16gbram(300, 12, [
  [5880, 6000, 6240, 6720, 7200, 7680, 8160, 9360, 10560],
  [6360, 6480, 6720, 7200, 7680, 8160, 8640, 9840, 11040],
  [6840, 6960, 7200, 7680, 8160, 8640, 9120, 10320, 11520],
  [7320, 7440, 7680, 8160, 8640, 9120, 9600, 10800, 12000],
  [7800, 7920, 8160, 8640, 9120, 9600, 10080, 11280, 12480],
])

function addAws8vcpu32gbram(lightStart, workersStart, priceRows) {
  for (let s = 0; s < 5; s++) {
    const light = lightStart + s * 25
    const workers = workersStart + s
    SSD_TIERS.forEach((ssd, i) => {
      const name = `AWS-8vcpu-32gbram-${ssd}gbssd-Backup`
      rows.push(row(name, light, awsSpec({ workers, ssdGb: ssd }), workers, priceRows[s][i]))
    })
  }
}

addAws8vcpu32gbram(475, 19, [
  [9240, 9360, 9600, 10080, 10560, 11040, 11520, 12720, 13920],
  [9720, 9840, 10080, 10560, 11040, 11520, 12000, 13200, 14400],
  [10200, 10320, 10560, 11040, 11520, 12000, 12480, 13680, 14880],
  [10680, 10800, 11040, 11520, 12000, 12480, 12960, 14160, 15360],
  [11160, 11280, 11520, 12000, 12480, 12960, 13440, 14640, 15840],
])

function addAws16vcpu32gbram(lightStart, workersStart, priceRows) {
  for (let s = 0; s < 5; s++) {
    const light = lightStart + s * 25
    const workers = workersStart + s
    SSD_TIERS.forEach((ssd, i) => {
      const name = `AWS-16vcpu-32gbram-${ssd}gbssd-Backup`
      rows.push(row(name, light, awsSpec({ workers, ssdGb: ssd }), workers, priceRows[s][i]))
    })
  }
}

addAws16vcpu32gbram(600, 24, [
  [11640, 11760, 12000, 12480, 12960, 13440, 13920, 15120, 16320],
  [12120, 12240, 12480, 12960, 13440, 13920, 14400, 15600, 16800],
  [12600, 12720, 12960, 13440, 13920, 14400, 14880, 16080, 17280],
  [13080, 13200, 13440, 13920, 14400, 14880, 15360, 16560, 17760],
  [13560, 13680, 13920, 14400, 14880, 15360, 15840, 17040, 18240],
])

function addGcp2vcpu(ramGb, lightUsers, workers, prices) {
  SSD_TIERS.forEach((ssd, i) => {
    const name = `GCP-2vcpu-${ramGb}gbram-${ssd}gbssd-Backup`
    rows.push(row(name, lightUsers, gcpSpec({ workers, ssdGb: ssd }), workers, prices[i]))
  })
}

addGcp2vcpu(1, 25, 1, [897.17, 1017.17, 1257.17, 1737.17, 2217.17, 2697.17, 3177.17, 4377.17, 5577.17])
addGcp2vcpu(2, 50, 2, [1316.57, 1436.57, 1676.57, 2156.57, 2636.57, 3116.57, 3596.57, 4796.57, 5996.57])
addGcp2vcpu(4, 75, 3, [1716.92, 1836.92, 2076.92, 2556.92, 3036.92, 3516.92, 3996.92, 5196.92, 6396.92])

function addGcp2vcpu8gbram(priceRow) {
  SSD_TIERS.forEach((ssd, i) => {
    const name = `GCP-2vcpu-8gbram-${ssd}gbssd-Backup`
    rows.push(row(name, 100, gcpSpec({ workers: 4, ssdGb: ssd }), 4, priceRow[i]))
  })
}

addGcp2vcpu8gbram([2244, 2376, 2640, 3168, 3696, 4224, 4752, 6072, 7392])

function addGcp2vcpu16gbram(priceRow) {
  SSD_TIERS.forEach((ssd, i) => {
    const name = `GCP-2vcpu-16gbram-${ssd}gbssd-Backup`
    rows.push(row(name, 125, gcpSpec({ workers: 5, ssdGb: ssd }), 5, priceRow[i]))
  })
}

addGcp2vcpu16gbram([2772, 2904, 3168, 3696, 4224, 4752, 5280, 6600, 7920])

function addGcp4vcpu8gbramSegment(light, workers, priceRow) {
  SSD_TIERS.forEach((ssd, i) => {
    const name = `GCP-4vcpu-8gbram-${ssd}gbssd-Backup`
    rows.push(row(name, light, gcpSpec({ workers, ssdGb: ssd }), workers, priceRow[i]))
  })
}

addGcp4vcpu8gbramSegment(150, 6, [3300, 3432, 3696, 4224, 4752, 5280, 5808, 7128, 8448])
addGcp4vcpu8gbramSegment(175, 7, [3828, 3960, 4224, 4752, 5280, 5808, 6336, 7656, 8976])
addGcp4vcpu8gbramSegment(200, 8, [4356, 4488, 4752, 5280, 5808, 6336, 6864, 8184, 9504])

function addGcp4vcpu16gbram250(priceRow) {
  SSD_TIERS.forEach((ssd, i) => {
    const name = `GCP-4vcpu-16gbram-${ssd}gbssd-Backup`
    rows.push(row(name, 250, gcpSpec({ workers: 10, ssdGb: ssd }), 10, priceRow[i]))
  })
}

addGcp4vcpu16gbram250([7380, 7560, 7920, 8640, 9360, 10080, 10800, 12600, 14400])

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(rows, null, 0), 'utf8')
console.log(`Wrote ${rows.length} rows to ${out}`)
