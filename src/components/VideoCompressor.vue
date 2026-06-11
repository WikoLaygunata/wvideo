<script setup>
import { ref, inject, onBeforeUnmount, onMounted, computed } from 'vue'

const showToast = inject('showToast')

const isMtSupported = ref(typeof SharedArrayBuffer !== 'undefined')

// Screen Wake Lock API state
let wakeLock = null

const requestWakeLock = async () => {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
  } catch (err) {
    console.warn('Wake Lock request failed:', err)
  }
}

const releaseWakeLock = async () => {
  if (wakeLock) {
    try {
      await wakeLock.release()
      wakeLock = null
    } catch (err) {
      console.error('Wake Lock release failed:', err)
    }
  }
}

// Re-acquire lock on visibility change (e.g. if user minimizes/restores tab)
const handleVisibilityChange = async () => {
  if (isCompressing.value && document.visibilityState === 'visible') {
    await requestWakeLock()
  }
}

// Alert before unload during active compression
const handleBeforeUnload = (e) => {
  if (isCompressing.value) {
    e.preventDefault()
    e.returnValue = '' // Standard browser prompt
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    if (!window.crossOriginIsolated) {
      isMtSupported.value = false
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
})

// UI States
const file = ref(null)
const fileUrl = ref(null)
const originalSize = ref(0)
const compressedSize = ref(0)
const outputUrl = ref(null)

const isDragging = ref(false)
const isCompressing = ref(false)
const progress = ref(0)
const statusMessage = ref('')
const errorMessage = ref('')
const startTime = ref(0)
const estimatedTimeRemaining = ref('')

// Settings
const settings = ref({
  quality: 'medium',
  resolution: 'original',
  audio: 'keep',
  speed: 'ultrafast',
})

const estimatedSize = computed(() => {
  if (!file.value) return null
  const original = file.value.size

  let qFactor = 0.5 // medium
  if (settings.value.quality === 'high') qFactor = 0.8
  if (settings.value.quality === 'low') qFactor = 0.3

  let rFactor = 1.0
  if (settings.value.resolution === '1080p') rFactor = 0.8
  if (settings.value.resolution === '720p') rFactor = 0.5
  if (settings.value.resolution === '480p') rFactor = 0.3

  let aFactor = 1.0
  if (settings.value.audio === 'mute') aFactor = 0.9
  if (settings.value.audio === '64k') aFactor = 0.95

  // Speed factor accounts for compression efficiency.
  // ultrafast does simple/fast analysis, resulting in larger file sizes.
  let sFactor = 1.0
  if (settings.value.speed === 'ultrafast') sFactor = 1.5
  else if (settings.value.speed === 'fast') sFactor = 1.15
  else if (settings.value.speed === 'slow') sFactor = 0.9

  const estimated = original * qFactor * rFactor * aFactor * sFactor
  const cappedMin = Math.max(0, Math.min(original - 2048, estimated * 0.7))
  const cappedMax = Math.max(0, Math.min(original - 1024, estimated * 1.3))
  return {
    min: formatBytes(cappedMin),
    max: formatBytes(cappedMax),
  }
})

let worker = null
let lastEtaUpdateTime = 0
let lastLogTime = 0

// Initialize Worker
const initWorker = () => {
  if (worker) return
  worker = new Worker(new URL('../workers/ffmpeg-worker.js', import.meta.url), { type: 'module' })

  worker.onmessage = async (e) => {
    const { type, message, progress: progValue, resultBuffer, mimeType } = e.data

    if (type === 'log') {
      // Saring log frame/fps bising agar tidak merusak rendering thread UI
      if (message.includes('frame=') || message.includes('fps=')) return

      const now = Date.now()
      if (now - lastLogTime >= 800) {
        statusMessage.value = message
        lastLogTime = now
      }
    } else if (type === 'progress') {
      // progress is a float between 0 and 1
      progress.value = Math.min(100, Math.max(0, Math.round(progValue * 100)))

      if (progValue > 0 && progValue < 1) {
        const now = Date.now()
        // Debounce / throttle ETA changes to every 2 seconds (2000ms)
        if (now - lastEtaUpdateTime >= 2000) {
          const elapsed = now - startTime.value
          const totalEstimated = elapsed / progValue
          const remaining = totalEstimated - elapsed
          estimatedTimeRemaining.value = formatTime(remaining)
          lastEtaUpdateTime = now
        }
      } else if (progValue === 1) {
        estimatedTimeRemaining.value = 'Selesai'
      }
    } else if (type === 'status') {
      statusMessage.value = message
    } else if (type === 'done') {
      isCompressing.value = false

      const finalBlob = new Blob([resultBuffer], { type: mimeType })
      const downloadUrl = URL.createObjectURL(finalBlob)

      outputUrl.value = downloadUrl
      compressedSize.value = finalBlob.size
      progress.value = 100
      showToast('Kompresi Selesai', 'Video berhasil dikompresi!', 'success')
      await releaseWakeLock()
    } else if (type === 'error') {
      isCompressing.value = false
      errorMessage.value = message
      showToast('Gagal', 'Terjadi kesalahan saat mengompres', 'error')
      await releaseWakeLock()
    }
  }
}

// Format bytes to MB/KB
const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

// Format time remaining
const formatTime = (ms) => {
  if (ms < 0 || !isFinite(ms)) return 'Menghitung...'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} detik`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes} menit ${seconds} detik`
}

// Handle file selection
const onFileSelect = (event) => {
  const selectedFile = event.target.files?.[0] || event.dataTransfer?.files?.[0]
  if (!selectedFile) return

  if (!selectedFile.type.startsWith('video/')) {
    showToast('Format Salah', 'Harap masukkan file video.', 'error')
    return
  }

  // Intercept >300MB files
  const MAX_FILE_SIZE = 300 * 1024 * 1024 // 300MB
  if (selectedFile.size > MAX_FILE_SIZE) {
    const proceed = window.confirm(
      `Peringatan Batas Memori WASM!\n\nFile ini berukuran lebih dari 300MB (${formatBytes(selectedFile.size)}). Browser memiliki batasan memori WebAssembly (2GB-4GB). Memproses file sebesar ini dapat menyebabkan tab crash atau macet.\n\nApakah Anda yakin ingin tetap melanjutkan?`,
    )
    if (!proceed) {
      event.target.value = '' // reset input
      return
    }
  }

  // Revoke existing URLs before selecting new file
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
  if (outputUrl.value) URL.revokeObjectURL(outputUrl.value)

  file.value = selectedFile
  originalSize.value = selectedFile.size
  fileUrl.value = URL.createObjectURL(selectedFile)

  // Reset states
  outputUrl.value = null
  compressedSize.value = 0
  errorMessage.value = ''
  progress.value = 0
}

// Start Compression
const startCompression = async () => {
  if (!file.value) return

  errorMessage.value = ''
  isCompressing.value = true
  progress.value = 0
  statusMessage.value = 'Mempersiapkan FFmpeg...'
  startTime.value = Date.now()
  lastEtaUpdateTime = 0 // Reset ETA timer
  estimatedTimeRemaining.value = 'Menghitung waktu...'

  // Request Screen Wake Lock to prevent sleeping
  await requestWakeLock()

  initWorker()

  try {
    const arrayBuffer = await file.value.arrayBuffer()

    worker.postMessage(
      {
        type: 'compress',
        payload: {
          fileData: arrayBuffer,
          fileName: file.value.name.replace(/\s+/g, '_'),
          options: {
            quality: settings.value.quality,
            resolution: settings.value.resolution,
            audio: settings.value.audio,
            speed: settings.value.speed,
          },
        },
      },
      [arrayBuffer],
    )
  } catch (err) {
    errorMessage.value = err.message
    isCompressing.value = false
    await releaseWakeLock()
    showToast('Gagal', 'Tidak dapat membaca file video.', 'error')
  }
}



// Garbage Collection Download
const handleDownload = () => {
  // Tunggu sejenak agar browser menginisiasi pengunduhan, lalu hapus objectUrl untuk membebaskan RAM.
  setTimeout(() => {
    if (outputUrl.value) {
      URL.revokeObjectURL(outputUrl.value)
      showToast('Memori Dibersihkan', 'URL file telah dihapus dari memori browser.', 'info')
    }
  }, 5000)
}

// Cancel / Reset
const reset = async () => {
  if (worker && isCompressing.value) {
    worker.terminate()
    worker = null
    isCompressing.value = false
  }

  await releaseWakeLock()

  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
  if (outputUrl.value) URL.revokeObjectURL(outputUrl.value)

  file.value = null
  fileUrl.value = null
  outputUrl.value = null
  progress.value = 0
  errorMessage.value = ''
}

onBeforeUnmount(async () => {
  if (worker) worker.terminate()
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
  if (outputUrl.value) URL.revokeObjectURL(outputUrl.value)

  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
  await releaseWakeLock()
})
</script>

<template>
  <div class="flex flex-col lg:flex-row gap-6 items-start w-full">
    <!-- Left Column: Settings -->
    <div
      class="w-full lg:w-1/3 bg-slate-950/80 border border-slate-800/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col backdrop-blur-sm"
    >
      <div class="p-5 border-b border-slate-800/80 bg-slate-950/60">
        <h3 class="text-lg font-bold text-white flex items-center gap-2">
          <svg class="w-5 h-5 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2.5"
              d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
            />
          </svg>
          Parameter Kompresi
        </h3>
        <p class="text-xs text-slate-400 mt-1">Atur rasio kualitas dan ukuran file output</p>
      </div>

      <div class="p-5 space-y-5 flex-1">
        <!-- Quality Setting -->
        <div class="space-y-2">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
            >Kualitas Video (CRF)</label
          >
          <div class="grid grid-cols-3 gap-2">
            <label
              class="flex flex-col items-center justify-center p-2 rounded-xl border border-slate-800 cursor-pointer transition-all hover:bg-slate-800/50"
              :class="{
                'bg-brand-600/10 border-brand-500 shadow-sm shadow-brand-500/20':
                  settings.quality === 'high',
              }"
            >
              <input type="radio" v-model="settings.quality" value="high" class="sr-only" />
              <span
                class="text-xs font-bold"
                :class="settings.quality === 'high' ? 'text-brand-400' : 'text-slate-400'"
                >Bagus</span
              >
              <span class="text-[10px] text-slate-500 mt-0.5">CRF 23</span>
            </label>
            <label
              class="flex flex-col items-center justify-center p-2 rounded-xl border border-slate-800 cursor-pointer transition-all hover:bg-slate-800/50"
              :class="{
                'bg-brand-600/10 border-brand-500 shadow-sm shadow-brand-500/20':
                  settings.quality === 'medium',
              }"
            >
              <input type="radio" v-model="settings.quality" value="medium" class="sr-only" />
              <span
                class="text-xs font-bold"
                :class="settings.quality === 'medium' ? 'text-brand-400' : 'text-slate-400'"
                >Normal</span
              >
              <span class="text-[10px] text-slate-500 mt-0.5">CRF 28</span>
            </label>
            <label
              class="flex flex-col items-center justify-center p-2 rounded-xl border border-slate-800 cursor-pointer transition-all hover:bg-slate-800/50"
              :class="{
                'bg-brand-600/10 border-brand-500 shadow-sm shadow-brand-500/20':
                  settings.quality === 'low',
              }"
            >
              <input type="radio" v-model="settings.quality" value="low" class="sr-only" />
              <span
                class="text-xs font-bold"
                :class="settings.quality === 'low' ? 'text-brand-400' : 'text-slate-400'"
                >Kecil</span
              >
              <span class="text-[10px] text-slate-500 mt-0.5">CRF 32</span>
            </label>
          </div>
        </div>

        <!-- Resolution Setting -->
        <div class="space-y-2">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
            >Resolusi / Skala</label
          >
          <select
            v-model="settings.resolution"
            class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors cursor-pointer appearance-none"
          >
            <option value="original">Original (Tidak Diubah)</option>
            <option value="1080p">1080p (FHD)</option>
            <option value="720p">720p (HD)</option>
            <option value="480p">480p (SD)</option>
          </select>
        </div>

        <!-- Audio Setting -->
        <div class="space-y-2">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
            >Audio Output</label
          >
          <select
            v-model="settings.audio"
            class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors cursor-pointer appearance-none"
          >
            <option value="keep">Pertahankan Original</option>
            <option value="128k">Kompres Audio (128 kbps)</option>
            <option value="64k">Sangat Kecil (64 kbps)</option>
            <option value="mute">Hapus Audio (Mute)</option>
          </select>
        </div>

        <!-- Encoding Speed Preset Setting -->
        <div class="space-y-2">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
            >Kecepatan (Preset)</label
          >
          <select
            v-model="settings.speed"
            class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors cursor-pointer appearance-none"
          >
            <option value="ultrafast">Ultrafast (Tercepat, ukuran agak besar)</option>
            <option value="fast">Fast (Cepat, seimbang)</option>
            <option value="medium">Medium (Standar, lambat)</option>
            <option value="slow">Slow (Sangat lambat, ukuran optimal)</option>
          </select>
        </div>
      </div>

      <!-- Disclaimer RAM & Fallback -->
      <div v-if="!isMtSupported" class="p-4 bg-rose-500/10 border-t border-rose-500/20">
        <div class="flex items-start gap-2.5">
          <svg
            class="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2.5"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <h4 class="text-xs font-bold text-rose-500">Mode Single-Thread Aktif</h4>
            <p class="text-[10px] text-rose-400/80 leading-relaxed mt-0.5">
              Browser/Perangkat Anda tidak mendukung fitur multi-threading (SharedArrayBuffer).
              Kompresi mungkin berjalan lebih lambat. Gunakan Chrome/Desktop untuk performa
              maksimal.
            </p>
          </div>
        </div>
      </div>

      <div class="p-4 bg-amber-500/10 border-t border-amber-500/20">
        <div class="flex items-start gap-2.5">
          <svg
            class="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2.5"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
          <div>
            <h4 class="text-xs font-bold text-amber-500">Peringatan Penggunaan RAM</h4>
            <p class="text-[10px] text-amber-500/80 leading-relaxed mt-0.5">
              Proses kompresi ini berjalan 100% lokal. Memproses file besar membutuhkan kapasitas
              RAM yang cukup. Tutup tab lain jika browser terasa melambat.
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Column: Process & Output Area -->
    <div class="w-full lg:w-2/3 flex flex-col gap-4">
      <!-- Upload Zone (Shows when no file is selected and not compressing) -->
      <div
        v-if="!file && !isCompressing"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="((isDragging = false), onFileSelect($event))"
        class="border-2 border-dashed rounded-2xl flex flex-col items-center justify-center p-12 transition-all duration-300 relative group min-h-[300px]"
        :class="
          isDragging
            ? 'border-brand-400 bg-brand-500/10'
            : 'border-slate-800/80 bg-slate-950/60 hover:bg-slate-950/80 hover:border-slate-700 backdrop-blur-sm'
        "
      >
        <div
          class="absolute inset-0 w-full h-full pointer-events-none rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-b from-transparent to-brand-500/5"
        ></div>
        <div
          class="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-lg"
        >
          <svg class="w-8 h-8 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
        </div>
        <h4 class="text-base font-bold text-white">Upload atau Tarik Video ke sini</h4>
        <p class="text-xs text-slate-400 mt-2 max-w-sm text-center">
          Mendukung MP4, WebM, MOV. Ukuran file optimal < 2GB.
        </p>
        <input
          type="file"
          accept="video/*"
          class="hidden"
          id="video-upload"
          @change="onFileSelect"
        />
        <label
          for="video-upload"
          class="mt-6 px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold text-sm cursor-pointer transition-colors shadow-lg shadow-slate-900"
        >
          Pilih File Video
        </label>
      </div>

      <!-- File Loaded / Ready to Compress -->
      <div
        v-if="file && !isCompressing && !outputUrl"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center"
      >
        <div
          class="w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4 border border-emerald-500/20"
        >
          <svg
            class="w-8 h-8 text-emerald-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h4 class="text-lg font-bold text-white break-all max-w-full">{{ file.name }}</h4>
        <p
          class="text-sm text-slate-400 mt-1 font-mono bg-slate-950 px-3 py-1 rounded-full border border-slate-800"
        >
          {{ formatBytes(originalSize) }}
        </p>

        <div
          v-if="estimatedSize"
          class="mt-4 bg-slate-950/50 border border-brand-500/20 rounded-lg px-4 py-2.5 flex items-center gap-2"
        >
          <svg class="w-4 h-4 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p class="text-xs text-slate-400">
            Estimasi akhir:
            <span class="text-brand-300 font-bold ml-1"
              >~{{ estimatedSize.min }} - {{ estimatedSize.max }}</span
            >
          </p>
        </div>

        <div class="flex items-center gap-3 mt-8 w-full sm:w-auto">
          <button
            @click="reset"
            class="flex-1 sm:flex-none px-6 py-3 rounded-xl border border-slate-700 text-slate-300 font-bold text-sm hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Batal
          </button>
          <button
            @click="startCompression"
            class="flex-1 sm:flex-none px-8 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-sm shadow-lg shadow-brand-600/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.5"
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            Mulai Kompresi
          </button>
        </div>
      </div>

      <!-- Processing UI & Error Indicator -->
      <div
        v-if="isCompressing || errorMessage"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl p-6 shadow-2xl relative overflow-hidden"
      >
        <!-- Error State -->
        <div v-if="errorMessage" class="flex flex-col items-center text-center p-4">
          <div
            class="w-12 h-12 rounded-full bg-rose-500/10 flex items-center justify-center mb-3 border border-rose-500/20"
          >
            <svg
              class="w-6 h-6 text-rose-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.5"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <h4 class="text-sm font-bold text-white">Kompresi Gagal</h4>
          <p class="text-xs text-rose-400 mt-2 max-w-sm">{{ errorMessage }}</p>
          <button
            @click="reset"
            class="mt-6 px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-bold transition-colors"
          >
            Coba Lagi
          </button>
        </div>

        <!-- Progress State -->
        <div v-else class="flex flex-col items-center">
          <div class="flex items-center gap-3 mb-6">
            <div
              class="w-8 h-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"
            ></div>
            <h4 class="text-sm font-bold text-white">
              {{ progress === 0 ? (statusMessage || 'Menyiapkan...') : 'Memproses...' }}
            </h4>
          </div>

          <div class="w-full max-w-md">
            <div class="flex justify-between text-xs font-bold mb-2">
              <span class="text-brand-400">Progres Kompresi</span>
              <span class="text-white">{{ progress }}%</span>
            </div>
            <div
              class="h-2.5 w-full bg-slate-950 rounded-full overflow-hidden border border-slate-800"
            >
              <div
                class="h-full bg-gradient-to-r from-emerald-500 to-brand-400 rounded-full transition-all duration-300 ease-out relative"
                :style="{ width: `${progress}%` }"
              >
                <div class="absolute inset-0 bg-white/20 animate-shimmer"></div>
              </div>
            </div>
            <p
              v-if="isCompressing && progress > 0"
              class="text-xs text-emerald-400 mt-3 text-center font-bold font-mono"
            >
              Sisa Waktu: {{ estimatedTimeRemaining }}
            </p>
            <p v-if="progress === 0" class="text-[10px] text-brand-400 mt-3 text-center leading-relaxed max-w-sm mx-auto">
              💡 Sedang menyiapkan studio media lokal di browser Anda. Unduhan engine ini hanya terjadi sekali di kunjungan pertama.
            </p>
            <p class="text-[10px] text-slate-500 mt-2 text-center">
              Pastikan tab browser tetap terbuka selama proses berlangsung.
            </p>

            <div class="mt-8 flex justify-center">
              <button
                @click="reset"
                class="px-5 py-2.5 border border-rose-500/30 text-rose-400 hover:text-white hover:bg-rose-500 hover:border-rose-500 rounded-xl text-xs font-bold transition-all shadow-lg shadow-rose-500/10 cursor-pointer flex items-center gap-2"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2.5"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
                Batalkan Kompresi
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Result UI: Preview & Download -->
      <div
        v-if="outputUrl"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl"
      >
        <!-- Preview Player -->
        <div class="aspect-video bg-black relative border-b border-slate-800">
          <video :src="outputUrl" controls class="w-full h-full object-contain"></video>
          <div
            class="absolute top-4 right-4 bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-lg flex items-center gap-2"
          >
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-[10px] font-bold text-white tracking-wide uppercase">Preview</span>
          </div>
        </div>

        <!-- Results Info & Download -->
        <div class="p-6">
          <div class="flex flex-col sm:flex-row items-center justify-between gap-6 mb-8">
            <div class="flex-1 grid grid-cols-2 gap-4 w-full">
              <!-- Original Stat -->
              <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 text-center">
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">
                  Ukuran Asli
                </p>
                <p class="text-lg font-bold text-slate-300">{{ formatBytes(originalSize) }}</p>
              </div>
              <!-- Compressed Stat -->
              <div
                class="bg-brand-500/10 border border-brand-500/30 rounded-xl p-4 text-center relative overflow-hidden"
              >
                <div
                  class="absolute top-0 right-0 w-16 h-16 bg-brand-500/20 rounded-bl-full -mr-4 -mt-4"
                ></div>
                <p class="text-[10px] text-brand-400 font-bold uppercase tracking-wider mb-1">
                  Hasil Kompresi
                </p>
                <p class="text-lg font-bold text-white">{{ formatBytes(compressedSize) }}</p>
                <p
                  class="text-[10px] text-brand-300/80 mt-1 font-semibold border-t border-brand-500/20 pt-1"
                >
                  Hemat {{ (100 - (compressedSize / originalSize) * 100).toFixed(1) }}%
                </p>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <button
              @click="reset"
              class="px-5 py-3 rounded-xl border border-slate-700 hover:bg-slate-800 text-slate-300 font-bold text-sm transition-colors cursor-pointer"
            >
              Kompres Lainnya
            </button>
            <a
              :href="outputUrl"
              :download="`wvideo_${file?.name || 'video.mp4'}`"
              @click="handleDownload"
              class="flex-1 block text-center px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-sm shadow-lg shadow-brand-600/20 transition-all cursor-pointer"
            >
              Simpan Video
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
