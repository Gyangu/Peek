/**
 * Rasterize build/icon.svg into every shipped desktop icon.
 *
 * macOS ships `iconutil`, which turns a .iconset directory into a .icns, but it
 * cannot rasterize SVG. So this script shells out to whichever rasterizer the
 * machine has, in descending order of output quality:
 *
 *   1. rsvg-convert  (librsvg; crisp at every size, honours the requested size)
 *   2. magick        (ImageMagick 7; `-density` keeps small sizes from blurring)
 *   3. sips          (always present on macOS, but rasterizes at the SVG's
 *                     nominal size and then resamples, so it is the last resort)
 *
 * Outputs:
 *   - build/icon.icns       macOS packager input
 *   - resources/icon.icns   platform asset mirror
 *   - resources/icon.png    BrowserWindow and macOS Dock runtime icon
 *   - resources/icon.ico    Windows multi-resolution icon
 *
 * ICO supports PNG-compressed frames, so the container is assembled here with
 * Node buffers rather than adding another image dependency. The generated
 * assets are committed; packaging never depends on a rasterizer.
 */

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(packageDir, 'build', 'icon.svg')
const iconsetDir = join(packageDir, 'build', 'icon.iconset')
const icnsPath = join(packageDir, 'build', 'icon.icns')
const resourcesDir = join(packageDir, 'resources')
const runtimePngPath = join(resourcesDir, 'icon.png')
const resourceIcnsPath = join(resourcesDir, 'icon.icns')
const icoPath = join(resourcesDir, 'icon.ico')
const icoFramesDir = join(packageDir, 'build', 'icon.ico-frames')

/**
 * The exact set `iconutil` expects. Anything missing makes it fail, and anything
 * extra makes it complain, so this list is the contract.
 */
const VARIANTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** True when `name` resolves on PATH. */
function hasCommand(name) {
  try {
    execFileSync('/usr/bin/which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Pick a rasterizer once, so every size comes out of the same renderer. */
function pickRasterizer() {
  if (hasCommand('rsvg-convert')) {
    return {
      name: 'rsvg-convert',
      render: (size, out) =>
        execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, svgPath]),
    }
  }
  if (hasCommand('magick')) {
    return {
      name: 'magick',
      render: (size, out) =>
        // The SVG is authored on a 1024 canvas; density scales the rasterizer
        // itself rather than resampling a 1024 bitmap down.
        execFileSync('magick', [
          '-background',
          'none',
          '-density',
          String(Math.round((size / 1024) * 96 * 4)),
          svgPath,
          '-resize',
          `${size}x${size}`,
          out,
        ]),
    }
  }
  if (hasCommand('sips')) {
    return {
      name: 'sips',
      render: (size, out) =>
        execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), svgPath, '--out', out], {
          stdio: 'ignore',
        }),
    }
  }
  throw new Error(
    'No SVG rasterizer found. Install one of: rsvg-convert (brew install librsvg), '
      + 'ImageMagick (brew install imagemagick). sips ships with macOS and should always be present.',
  )
}

/** Assemble PNG-compressed frames into a standards-compliant ICO container. */
function writeIco(frames, outputPath) {
  const headerSize = 6
  const entrySize = 16
  const dataOffset = headerSize + entrySize * frames.length
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  let offset = dataOffset
  const entries = frames.map(({ size, data }) => {
    const entry = Buffer.alloc(entrySize)
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += data.length
    return entry
  })

  writeFileSync(outputPath, Buffer.concat([header, ...entries, ...frames.map(({ data }) => data)]))
}

function main() {
  if (!existsSync(svgPath)) throw new Error(`Icon source missing: ${svgPath}`)

  const rasterizer = pickRasterizer()
  console.log(`[icon] rasterizing with ${rasterizer.name}`)

  rmSync(iconsetDir, { recursive: true, force: true })
  rmSync(icoFramesDir, { recursive: true, force: true })
  mkdirSync(iconsetDir, { recursive: true })
  mkdirSync(icoFramesDir, { recursive: true })
  mkdirSync(resourcesDir, { recursive: true })

  for (const [fileName, size] of VARIANTS) {
    rasterizer.render(size, join(iconsetDir, fileName))
  }

  execFileSync('iconutil', ['--convert', 'icns', '--output', icnsPath, iconsetDir], { stdio: 'inherit' })
  copyFileSync(icnsPath, resourceIcnsPath)
  rasterizer.render(1024, runtimePngPath)

  const icoFrames = ICO_SIZES.map((size) => {
    const framePath = join(icoFramesDir, `icon-${size}.png`)
    rasterizer.render(size, framePath)
    return { size, data: readFileSync(framePath) }
  })
  writeIco(icoFrames, icoPath)

  // These directories are scaffolding; only the SVG and final assets persist.
  rmSync(iconsetDir, { recursive: true, force: true })
  rmSync(icoFramesDir, { recursive: true, force: true })

  console.log(`[icon] wrote ${icnsPath}`)
  console.log(`[icon] wrote ${runtimePngPath}`)
  console.log(`[icon] wrote ${resourceIcnsPath}`)
  console.log(`[icon] wrote ${icoPath}`)
}

main()
