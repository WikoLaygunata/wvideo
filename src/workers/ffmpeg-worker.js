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

// Tambahkan flag busy di tingkat atas
let isBusy = false

self.onmessage = async ({ data }) => {
  const { type, payload } = data

  if (isBusy) {
    self.postMessage({
      type: 'error',
      message: 'FFmpeg sedang memproses tugas lain. Harap tunggu.',
    })
    return
  }

  isBusy = true // Kunci worker

  try {
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
          // MODE CEPAT: Instan (0 detik), urutan diubah jadi Output-Seeking agar lebih presisi
          args.push(
            '-i',
            inputName,
            '-ss',
            String(options.start),
            '-t',
            String(duration),
            '-c',
            'copy', // Salin video & audio langsung tanpa render ulang
            outputName,
          )
        } else {
          // MODE AKURAT: Dioptimalkan agar JAUH lebih efisien dan hemat CPU
          args.push('-i', inputName, '-ss', String(options.start), '-t', String(duration))

          // Alokasi Thread untuk Video Encoding jika Multi-Threading aktif
          if (isMtSupported) {
            let threadCount = 4
            if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
              threadCount = Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1))
            }
            args.push('-threads', String(threadCount))
          }

          args.push(
            '-c:v',
            'libx264', // Video tetap di-encode ulang demi akurasi per frame
            '-crf',
            '26', // Kualitas standar yang seimbang
            '-preset',
            options.speed || 'ultrafast', // Gunakan preset kecepatan pilihan user
            '-c:a',
            'copy', // OPTIMASI: Audio langsung dicopas, gak usah di-encode ulang!
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
    } else if (type === 'merge') {
      const { files, options } = payload
      let ffmpegInstance = null
      let outputName = 'output.mp4'
      let cleanupFiles = [outputName] // Tambahkan outputName sejak awal agar aman dari leak memori

      try {
        ffmpegInstance = await initFFmpeg(self.postMessage)
        self.postMessage({ type: 'status', message: 'Mempersiapkan antrean file video...' })

        // Write all input files
        for (let i = 0; i < files.length; i++) {
          const fileExt = files[i].fileName.split('.').pop() || 'mp4'
          const inputName = `input_${i}.${fileExt}`
          await ffmpegInstance.writeFile(inputName, new Uint8Array(files[i].fileData))
          cleanupFiles.push(inputName)
        }

        let listContent = ''
        for (let i = 0; i < files.length; i++) {
          const fileExt = files[i].fileName.split('.').pop() || 'mp4'
          const inputName = `input_${i}.${fileExt}`
          listContent += `file '${inputName}'\n`
        }

        await ffmpegInstance.writeFile('list.txt', listContent)
        cleanupFiles.push('list.txt')

        self.postMessage({ type: 'status', message: 'Menggabungkan semua video menjadi satu...' })
        const mergeArgs = ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', outputName]

        await ffmpegInstance.exec(mergeArgs)

        self.postMessage({ type: 'status', message: 'Memproses hasil akhir gabungan...' })
        const outputData = await ffmpegInstance.readFile(outputName)

        self.postMessage(
          {
            type: 'done',
            resultBuffer: outputData.buffer,
            mimeType: 'video/mp4',
            message: 'Penggabungan berhasil!',
          },
          [outputData.buffer],
        )
      } catch (err) {
        self.postMessage({
          type: 'error',
          message: err.message || 'Terjadi kesalahan saat menggabungkan video.',
        })
      } finally {
        if (ffmpegInstance) {
          for (const f of cleanupFiles) {
            try {
              await ffmpegInstance.deleteFile(f)
            } catch (e) {}
          }
        }
      }
    } else if (type === 'extract') {
      const { fileData, fileName, options } = payload
      const ext = fileName.split('.').pop() || 'mp4'
      const inputName = `input.${ext}`

      let outputName = 'output.mp4'
      let mimeType = 'video/mp4'

      if (options.mode === 'audio') {
        outputName = 'output.mp3'
        mimeType = 'audio/mp3'
      } else {
        outputName = `output.mp4`
        mimeType = 'video/mp4'
      }

      let ffmpegInstance = null

      try {
        ffmpegInstance = await initFFmpeg(self.postMessage)
        self.postMessage({ type: 'status', message: 'Mempersiapkan file media...' })

        await ffmpegInstance.writeFile(inputName, new Uint8Array(fileData))
        self.postMessage({
          type: 'status',
          message: `Memulai ekstraksi ${options.mode === 'audio' ? 'Audio' : 'Video'}...`,
        })

        const args = ['-i', inputName]

        if (options.mode === 'audio') {
          // Audio Only: Remove video, re-encode audio to MP3 (or use aac if mp3 not supported, but ffmpeg-wasm usually has mp3lame)
          args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '2')
        } else {
          // Video Only: Remove audio, copy video stream (no re-encode = instant)
          args.push('-an', '-c:v', 'copy')
        }

        args.push(outputName)

        await ffmpegInstance.exec(args)

        self.postMessage({ type: 'status', message: 'Memproses hasil ekstraksi...' })
        const outputData = await ffmpegInstance.readFile(outputName)

        self.postMessage(
          {
            type: 'done',
            resultBuffer: outputData.buffer,
            mimeType: mimeType,
            message: 'Ekstraksi berhasil!',
          },
          [outputData.buffer],
        )
      } catch (err) {
        self.postMessage({
          type: 'error',
          message: err.message || 'Terjadi kesalahan saat mengekstrak file.',
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
  } finally {
    isBusy = false // Lepaskan kunci setelah proses selesai/gagal
  }
}
