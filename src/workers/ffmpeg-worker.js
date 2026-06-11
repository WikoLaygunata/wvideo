import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'

let ffmpeg = null

// Determine if SharedArrayBuffer is available for multithreading
const isMtSupported = typeof SharedArrayBuffer !== 'undefined'

const initFFmpeg = async (postMessage) => {
  if (ffmpeg) return ffmpeg
  ffmpeg = new FFmpeg()

  ffmpeg.on('log', ({ message }) => {
    postMessage({ type: 'log', message })
  })

  ffmpeg.on('progress', ({ progress, time }) => {
    postMessage({ type: 'progress', progress, time })
  })

  postMessage({ type: 'status', message: 'Memuat Engine FFmpeg...' })

  const origin = self.location.origin
  const baseURL = isMtSupported ? `${origin}/ffmpeg/multi` : `${origin}/ffmpeg/single`

  try {
    const loadConfig = {
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    }

    if (isMtSupported) {
      loadConfig.workerURL = await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript')
    }

    const loadPromise = ffmpeg.load(loadConfig)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Waktu tunggu habis saat memuat FFmpeg engine (30 detik)')),
        30000,
      ),
    )
    await Promise.race([loadPromise, timeoutPromise])
    postMessage({
      type: 'status',
      message: `Engine FFmpeg siap! (Mode: ${isMtSupported ? 'Multi-Thread' : 'Single-Thread'})`,
    })
    return ffmpeg
  } catch (error) {
    ffmpeg = null // Reset instance so next load retry starts fresh
    postMessage({ type: 'error', message: `Gagal memuat FFmpeg: ${error.message}` })
    throw error
  }
}

self.onmessage = async ({ data }) => {
  const { type, payload } = data

  if (type === 'compress') {
    const { fileData, fileName, options } = payload

    const ext = fileName.split('.').pop() || 'mp4'
    const inputName = `input.${ext}`
    const outputName = `output.${ext}`
    let ffmpegInstance = null

    try {
      ffmpegInstance = await initFFmpeg(self.postMessage)
      self.postMessage({ type: 'status', message: 'Mempersiapkan file video...' })

      // Pastikan dibungkus Uint8Array agar aman dibaca virtual filesystem WASM
      await ffmpegInstance.writeFile(inputName, new Uint8Array(fileData))
      self.postMessage({ type: 'status', message: 'Memulai proses kompresi...' })

      const args = ['-i', inputName]

      if (isMtSupported) {
        let threadCount = 4
        if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
          threadCount = Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1))
        }
        args.push('-threads', String(threadCount))
      }

      if (options.resolution && options.resolution !== 'original') {
        const heights = { '1080p': '1080', '720p': '720', '480p': '480' }
        const targetHeight = heights[options.resolution] || '720'
        args.push('-vf', `scale=-2:${targetHeight}`)
      }

      args.push('-c:v', 'libx264')
      const crfMap = { high: '23', medium: '28', low: '32' }
      args.push('-crf', crfMap[options.quality] || '28')
      args.push('-preset', options.speed || 'ultrafast')

      if (options.audio === 'mute') {
        args.push('-an')
      } else {
        args.push('-c:a', 'aac')
        if (options.audio === '128k' || options.audio === '64k') {
          args.push('-b:a', options.audio)
        }
      }

      args.push(outputName)
      await ffmpegInstance.exec(args)

      self.postMessage({ type: 'status', message: 'Memproses hasil kompresi...' })
      const outputData = await ffmpegInstance.readFile(outputName)

      const mimeMap = {
        mp4: 'video/mp4',
        webm: 'video/webm',
        ogg: 'video/ogg',
        mkv: 'video/x-matroska',
        mov: 'video/quicktime',
      }
      const mimeType = mimeMap[ext.toLowerCase()] || 'video/mp4'

      // KIRIM BUFFER REKAYASA KEMBALI KE MAIN THREAD (VUE) via Transferable Object
      self.postMessage(
        {
          type: 'done',
          resultBuffer: outputData.buffer,
          mimeType: mimeType,
          message: 'Kompresi berhasil!',
        },
        [outputData.buffer],
      ) // <-- Memori langsung dibebaskan dari Worker secara instan
    } catch (err) {
      self.postMessage({
        type: 'error',
        message: err.message || 'Terjadi kesalahan saat memproses video.',
      })
    } finally {
      if (ffmpegInstance) {
        try {
          await ffmpegInstance.deleteFile(inputName)
        } catch (e) {}
        try {
          await ffmpegInstance.deleteFile(outputName)
        } catch (e) {}
      }
    }
  } else if (type === 'trim') {
    const { fileData, fileName, options } = payload

    const ext = fileName.split('.').pop() || 'mp4'
    const inputName = `input.${ext}`
    const outputName = `output.${ext}`
    let ffmpegInstance = null

    try {
      ffmpegInstance = await initFFmpeg(self.postMessage)
      self.postMessage({ type: 'status', message: 'Mempersiapkan file video...' })

      await ffmpegInstance.writeFile(inputName, new Uint8Array(fileData))
      self.postMessage({ type: 'status', message: 'Memotong durasi video...' })

      const args = []
      const duration = Number(options.end) - Number(options.start)

      if (options.mode === 'fast') {
        // Gunakan -t (duration) karena mencari dengan -ss di awal mereset timeline ke 0
        args.push(
          '-ss',
          String(options.start),
          '-t',
          String(duration),
          '-i',
          inputName,
          '-c',
          'copy',
          outputName,
        )
      } else {
        args.push('-ss', String(options.start), '-t', String(duration), '-i', inputName)

        if (isMtSupported) {
          let threadCount = 4
          if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
            threadCount = Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1))
          }
          args.push('-threads', String(threadCount))
        }

        args.push(
          '-c:v',
          'libx264',
          '-crf',
          '23',
          '-preset',
          'ultrafast',
          '-c:a',
          'aac',
          outputName,
        )
      }

      await ffmpegInstance.exec(args)

      self.postMessage({ type: 'status', message: 'Memproses hasil potong...' })
      const outputData = await ffmpegInstance.readFile(outputName)

      const mimeMap = {
        mp4: 'video/mp4',
        webm: 'video/webm',
        ogg: 'video/ogg',
        mkv: 'video/x-matroska',
        mov: 'video/quicktime',
      }
      const mimeType = mimeMap[ext.toLowerCase()] || 'video/mp4'

      // KIRIM BUFFER REKAYASA KEMBALI KE MAIN THREAD (VUE) via Transferable Object
      self.postMessage(
        {
          type: 'done',
          resultBuffer: outputData.buffer,
          mimeType: mimeType,
          message: 'Pemotongan berhasil!',
        },
        [outputData.buffer],
      ) // <-- Memori langsung dibebaskan dari Worker secara instan
    } catch (err) {
      self.postMessage({
        type: 'error',
        message: err.message || 'Terjadi kesalahan saat memotong video.',
      })
    } finally {
      if (ffmpegInstance) {
        try {
          await ffmpegInstance.deleteFile(inputName)
        } catch (e) {}
        try {
          await ffmpegInstance.deleteFile(outputName)
        } catch (e) {}
      }
    }
  }
}
