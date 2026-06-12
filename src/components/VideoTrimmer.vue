<script setup>
import { ref, inject, onBeforeUnmount, onMounted, watch } from 'vue'

const showToast = inject('showToast')

const isMtSupported = ref(typeof SharedArrayBuffer !== 'undefined')

// Screen Wake Lock API state
let wakeLock = null

const requestWakeLock = async () => {
  if (wakeLock) return
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
  } catch (err) {
    console.warn('Wake Lock request failed (Trimmer):', err)
  }
}

const releaseWakeLock = async () => {
  if (wakeLock) {
    try {
      await wakeLock.release()
      wakeLock = null
    } catch (err) {
      console.error('Wake Lock release failed (Trimmer):', err)
    }
  }
}

// Re-acquire lock on visibility change
const handleVisibilityChange = async () => {
  if (isTrimming.value && document.visibilityState === 'visible') {
    await requestWakeLock()
  }
}

// Alert before unload during active trimming
const handleBeforeUnload = (e) => {
  if (isTrimming.value) {
    e.preventDefault()
    e.returnValue = '' // Standard browser prompt
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
})

// UI States
const file = ref(null)
const fileUrl = ref(null)
const originalSize = ref(0)
const trimmedSize = ref(0)
const outputUrl = ref(null)

const isDragging = ref(false)
const isTrimming = ref(false)
const progress = ref(0)
const errorMessage = ref('')
const processStartTime = ref(0)
const estimatedTimeRemaining = ref('')
let lastEtaUpdateTime = 0

// Video Duration & Seeking States
const duration = ref(0)
const startTime = ref(0)
const endTime = ref(0)
const trimMode = ref('accurate') // 'accurate' = re-encode (akurat)
const trimSpeed = ref('ultrafast')
const videoPlayer = ref(null)

// Format helper: seconds to MM:SS.mmm
const formatTimeSeconds = (sec) => {
  if (isNaN(sec) || !isFinite(sec)) return '00:00.000'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
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

// Watchers to synchronize video seeks when sliders change
const seekVideo = (time) => {
  if (videoPlayer.value) {
    videoPlayer.value.currentTime = time
  }
}

watch(startTime, (newVal) => {
  if (newVal === null || newVal === undefined || isNaN(newVal) || newVal === '') return
  let clamped = Math.max(0, Math.min(newVal, duration.value))
  if (clamped >= endTime.value) {
    clamped = Math.max(0, endTime.value - 0.1)
  }
  if (clamped !== newVal) {
    startTime.value = clamped
  }
  seekVideo(startTime.value)
})

watch(endTime, (newVal) => {
  if (newVal === null || newVal === undefined || isNaN(newVal) || newVal === '') return
  let clamped = Math.max(0, Math.min(newVal, duration.value))
  if (clamped <= startTime.value) {
    clamped = Math.min(duration.value, startTime.value + 0.1)
  }
  if (clamped !== newVal) {
    endTime.value = clamped
  }
  seekVideo(endTime.value)
})

// Video Meta Loaded
const onVideoMetadata = () => {
  if (videoPlayer.value) {
    duration.value = videoPlayer.value.duration
    if (endTime.value === 0) {
      endTime.value = videoPlayer.value.duration
      startTime.value = 0
    }
  }
}

let worker = null

// Initialize Worker
const initWorker = () => {
  if (worker) return
  worker = new Worker(new URL('../workers/ffmpeg-worker.js', import.meta.url), { type: 'module' })

  worker.onmessage = async (e) => {
    const { type, message, progress: progValue, resultBuffer, mimeType } = e.data

    if (type === 'progress') {
      progress.value = Math.min(100, Math.max(0, Math.round(progValue * 100)))
      if (progValue > 0 && progValue < 1) {
        const now = Date.now()
        if (now - lastEtaUpdateTime >= 2000) {
          const elapsed = now - processStartTime.value
          const totalEstimated = elapsed / progValue
          const remaining = totalEstimated - elapsed
          estimatedTimeRemaining.value = formatTime(remaining)
          lastEtaUpdateTime = now
        }
      } else if (progValue === 1) {
        estimatedTimeRemaining.value = 'Selesai'
      }
    } else if (type === 'done') {
      isTrimming.value = false
      await releaseWakeLock()

      const finalBlob = new Blob([resultBuffer], { type: mimeType })
      const downloadUrl = URL.createObjectURL(finalBlob)

      outputUrl.value = downloadUrl
      trimmedSize.value = finalBlob.size
      progress.value = 100
      showToast('Pemotongan Selesai', 'Video berhasil dipotong!', 'success')
    } else if (type === 'error') {
      isTrimming.value = false
      errorMessage.value = message
      await releaseWakeLock()
      showToast('Gagal', 'Terjadi kesalahan saat memotong', 'error')
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

// Handle file selection
const onFileSelect = (event) => {
  const selectedFile = event.target.files?.[0] || event.dataTransfer?.files?.[0]
  if (!selectedFile) return

  const videoExtensions = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.3gp', '.flv']
  const isVideo =
    selectedFile.type.startsWith('video/') ||
    videoExtensions.some((ext) => selectedFile.name.toLowerCase().endsWith(ext))

  if (!isVideo) {
    showToast('Format Salah', 'Harap masukkan file video.', 'error')
    return
  }

  // Intercept >300MB files
  const MAX_FILE_SIZE = 300 * 1024 * 1024 // 300MB
  if (selectedFile.size > MAX_FILE_SIZE) {
    const proceed = window.confirm(
      `Peringatan Batas Memori WASM!\n\nFile ini berukuran lebih dari 300MB (${formatBytes(selectedFile.size)}). Browser memiliki batasan memori WebAssembly. Memproses file sebesar ini dapat menyebabkan tab crash atau macet.\n\nApakah Anda yakin ingin tetap melanjutkan?`,
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
  trimmedSize.value = 0
  errorMessage.value = ''
  progress.value = 0
  duration.value = 0
  startTime.value = 0
  endTime.value = 0
}

// Start Trimming
const startTrimming = async () => {
  if (!file.value) return

  errorMessage.value = ''
  isTrimming.value = true
  progress.value = 0
  processStartTime.value = Date.now()
  lastEtaUpdateTime = 0
  estimatedTimeRemaining.value = 'Menghitung waktu...'

  await requestWakeLock()

  if (!worker) {
    initWorker()
  }

  try {
    const arrayBuffer = await file.value.arrayBuffer()

    worker.postMessage(
      {
        type: 'trim',
        payload: {
          fileData: arrayBuffer,
          fileName: file.value.name.replace(/\s+/g, '_'),
          options: {
            start: startTime.value,
            end: endTime.value,
            mode: trimMode.value,
            speed: trimSpeed.value,
          },
        },
      },
      [arrayBuffer],
    )
  } catch (err) {
    errorMessage.value = err.message
    isTrimming.value = false
    await releaseWakeLock()
    showToast('Gagal', 'Tidak dapat membaca file video.', 'error')
  }
}

// Adjust/re-trim the same video
const adjustTrimming = () => {
  if (outputUrl.value) {
    URL.revokeObjectURL(outputUrl.value)
    outputUrl.value = null
  }
}

// Cancel / Reset
const reset = async () => {
  if (worker) {
    worker.terminate()
    worker = null
  }
  isTrimming.value = false

  await releaseWakeLock()

  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
  if (outputUrl.value) URL.revokeObjectURL(outputUrl.value)

  file.value = null
  fileUrl.value = null
  outputUrl.value = null
  progress.value = 0
  errorMessage.value = ''
  duration.value = 0
  startTime.value = 0
  endTime.value = 0
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
              d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
            />
          </svg>
          Parameter Pemotongan
        </h3>
        <p class="text-xs text-slate-400 mt-1">Tentukan rentang durasi video yang ingin disimpan</p>
      </div>

      <div class="p-5 space-y-5 flex-1">
        <!-- Range Inputs (Hidden / Disabled if no file) -->
        <div v-if="file" class="space-y-4">
          <div v-if="duration > 0" class="space-y-4">
            <!-- Start Time Picker -->
            <div class="space-y-2">
              <div class="flex justify-between items-center">
                <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
                  >Awal Pemotongan</label
                >
                <span class="text-xs font-bold text-brand-400 font-mono">{{
                  formatTimeSeconds(startTime)
                }}</span>
              </div>
              <input
                type="range"
                v-model.number="startTime"
                min="0"
                :max="duration"
                step="0.05"
                class="w-full accent-brand-500 bg-slate-800 h-1 rounded-lg appearance-none cursor-pointer"
              />
              <div class="flex gap-2">
                <input
                  type="number"
                  v-model.number="startTime"
                  min="0"
                  :max="endTime"
                  step="0.1"
                  class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white font-mono text-center"
                />
                <span class="text-slate-500 self-center text-xs">detik</span>
              </div>
            </div>

            <!-- End Time Picker -->
            <div class="space-y-2">
              <div class="flex justify-between items-center">
                <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
                  >Akhir Pemotongan</label
                >
                <span class="text-xs font-bold text-brand-400 font-mono">{{
                  formatTimeSeconds(endTime)
                }}</span>
              </div>
              <input
                type="range"
                v-model.number="endTime"
                min="0"
                :max="duration"
                step="0.05"
                class="w-full accent-brand-500 bg-slate-800 h-1 rounded-lg appearance-none cursor-pointer"
              />
              <div class="flex gap-2">
                <input
                  type="number"
                  v-model.number="endTime"
                  :min="startTime"
                  :max="duration"
                  step="0.1"
                  class="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white font-mono text-center"
                />
                <span class="text-slate-500 self-center text-xs">detik</span>
              </div>
            </div>

            <!-- Selected Duration summary -->
            <div
              class="bg-slate-950 border border-slate-800/80 rounded-xl p-3 flex justify-between text-xs"
            >
              <span class="text-slate-400">Total Durasi Potong:</span>
              <span class="text-white font-bold font-mono">{{
                formatTimeSeconds(endTime - startTime)
              }}</span>
            </div>
          </div>
          <div
            v-else
            class="text-center py-6 text-xs text-slate-500 flex items-center justify-center gap-2"
          >
            <div
              class="w-4 h-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"
            ></div>
            <span>Memuat metadata video...</span>
          </div>
        </div>

        <div v-else class="text-center py-6 text-xs text-slate-500">
          Silakan upload video terlebih dahulu untuk membuka parameter pemotongan.
        </div>

        <!-- Encoding Speed Preset Setting -->
        <div class="space-y-2">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
            >Kecepatan (Preset)</label
          >
          <select
            v-model="trimSpeed"
            class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-brand-500 transition-colors cursor-pointer appearance-none"
          >
            <option value="ultrafast">Ultrafast (Tercepat, ukuran agak besar)</option>
            <option value="fast">Fast (Cepat, seimbang)</option>
            <option value="medium">Medium (Standar, lambat)</option>
            <option value="slow">Slow (Sangat lambat, ukuran optimal)</option>
          </select>
        </div>
      </div>

      <!-- Mode explanation panel -->
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
            <h4 class="text-xs font-bold text-amber-500">Info Pemotongan Video</h4>
            <p class="text-[10px] text-amber-500/80 leading-relaxed mt-0.5">
              Pemotongan dilakukan secara lokal dengan merender ulang (re-encoding) video secara
              presisi tepat pada milidetik yang ditentukan, demi menghindari hasil video
              rusak/corrupt.
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Column: Process & Output Area -->
    <div class="w-full lg:w-2/3 flex flex-col gap-4">
      <!-- Upload Zone -->
      <div
        v-if="!file && !isTrimming"
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
          Video akan dimuat lokal untuk dipotong secara presisi.
        </p>
        <input
          type="file"
          accept="video/*"
          class="hidden"
          id="trim-upload"
          @change="onFileSelect"
        />
        <label
          for="trim-upload"
          class="mt-6 px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold text-sm cursor-pointer transition-colors shadow-lg shadow-slate-900"
        >
          Pilih File Video
        </label>
      </div>

      <!-- File Loaded / Video Preview seeking -->
      <div
        v-if="file && !isTrimming && !outputUrl"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
      >
        <!-- Live seek player -->
        <div
          class="aspect-video max-h-[400px] md:max-h-[450px] bg-black relative border-b border-slate-800 flex items-center justify-center"
        >
          <video
            ref="videoPlayer"
            :src="fileUrl"
            @loadedmetadata="onVideoMetadata"
            controls
            class="w-full h-full object-contain"
          ></video>
          <div
            class="absolute top-4 left-4 bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-lg flex items-center gap-2"
          >
            <span class="w-2 h-2 rounded-full bg-brand-400 animate-pulse"></span>
            <span class="text-[10px] font-bold text-white tracking-wide uppercase"
              >Live Preview</span
            >
          </div>
        </div>

        <div class="p-6 text-center flex flex-col items-center">
          <h4 class="text-lg font-bold text-white break-all max-w-full">{{ file.name }}</h4>
          <p
            class="text-xs text-slate-400 mt-1 font-mono bg-slate-950 px-3 py-1 rounded-full border border-slate-800"
          >
            {{ formatBytes(originalSize) }} • Durasi: {{ formatTimeSeconds(duration) }}
          </p>

          <div class="flex items-center gap-3 mt-8 w-full sm:w-auto">
            <button
              @click="reset"
              class="flex-1 sm:flex-none px-6 py-3 rounded-xl border border-slate-700 text-slate-300 font-bold text-sm hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              @click="startTrimming"
              class="flex-1 sm:flex-none px-8 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-sm shadow-lg shadow-brand-600/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2.5"
                  d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z"
                />
              </svg>
              Mulai Potong Video
            </button>
          </div>
        </div>
      </div>

      <!-- Trimming / Processing UI -->
      <div
        v-if="isTrimming || errorMessage"
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
          <h4 class="text-sm font-bold text-white">Pemotongan Gagal</h4>
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
              {{ progress === 0 ? 'Menyiapkan...' : 'Memotong video...' }}
            </h4>
          </div>

          <div class="w-full max-w-md">
            <div class="flex justify-between text-xs font-bold mb-2">
              <span class="text-brand-400">Progres Pemotongan</span>
              <span class="text-white"> {{ progress }}% </span>
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
              v-if="isTrimming && trimMode === 'accurate' && progress > 0"
              class="text-xs text-emerald-400 mt-3 text-center font-bold font-mono"
            >
              Sisa Waktu: {{ estimatedTimeRemaining }}
            </p>
            <p
              v-if="progress === 0"
              class="text-[10px] text-brand-400 mt-3 text-center leading-relaxed max-w-sm mx-auto"
            >
              💡 Sedang menyiapkan studio media lokal di browser Anda. Unduhan engine ini hanya
              terjadi sekali di kunjungan pertama.
            </p>
            <p class="text-[10px] text-slate-500 mt-2 text-center">
              Mohon jangan menutup tab browser sampai proses pemotongan selesai.
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
                Batalkan Proses
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Trim Result Display -->
      <div
        v-if="outputUrl"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl"
      >
        <!-- Preview Player -->
        <div
          class="aspect-video max-h-[400px] md:max-h-[450px] bg-black relative border-b border-slate-800 flex items-center justify-center"
        >
          <video :src="outputUrl" controls class="w-full h-full object-contain"></video>
          <div
            class="absolute top-4 right-4 bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-lg flex items-center gap-2"
          >
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-[10px] font-bold text-white tracking-wide uppercase"
              >Hasil Potong</span
            >
          </div>
        </div>

        <!-- Result Stats & Download -->
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
              <!-- Trimmed Stat -->
              <div
                class="bg-brand-500/10 border border-brand-500/30 rounded-xl p-4 text-center relative overflow-hidden"
              >
                <div
                  class="absolute top-0 right-0 w-16 h-16 bg-brand-500/20 rounded-bl-full -mr-4 -mt-4"
                ></div>
                <p class="text-[10px] text-brand-400 font-bold uppercase tracking-wider mb-1">
                  Ukuran Hasil
                </p>
                <p class="text-lg font-bold text-white">{{ formatBytes(trimmedSize) }}</p>
                <p
                  class="text-[10px] text-brand-300/80 mt-1 font-semibold border-t border-brand-500/20 pt-1"
                >
                  Ukuran Baru ({{ trimmedSize < originalSize ? 'Berkurang' : 'Bertambah' }}
                  {{ Math.abs(100 - (trimmedSize / originalSize) * 100).toFixed(1) }}%)
                </p>
              </div>
            </div>
          </div>

          <div class="flex flex-col sm:flex-row items-center gap-3">
            <button
              @click="reset"
              class="w-full sm:w-auto px-5 py-3 rounded-xl border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-slate-200 font-bold text-sm transition-colors cursor-pointer"
            >
              Potong Video Lain
            </button>
            <button
              @click="adjustTrimming"
              class="w-full sm:w-auto px-5 py-3 rounded-xl border border-brand-700 hover:bg-brand-700/20 text-brand-400 hover:text-brand-300 font-bold text-sm transition-colors cursor-pointer"
            >
              Sesuaikan Pemotongan
            </button>
            <a
              :href="outputUrl"
              :download="`trimmed_${file?.name || 'video.mp4'}`"
              class="flex-1 w-full text-center px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-sm shadow-lg shadow-brand-600/20 transition-all cursor-pointer"
            >
              Simpan Video Potongan
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
