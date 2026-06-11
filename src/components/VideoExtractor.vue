<script setup>
import { ref, inject, onBeforeUnmount, onMounted } from 'vue'

const showToast = inject('showToast')

// Screen Wake Lock API state
let wakeLock = null

const requestWakeLock = async () => {
  if (wakeLock) return
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
  } catch (err) {
    console.warn('Wake Lock request failed (Extractor):', err)
  }
}

const releaseWakeLock = async () => {
  if (wakeLock) {
    try {
      await wakeLock.release()
      wakeLock = null
    } catch (err) {
      console.error('Wake Lock release failed (Extractor):', err)
    }
  }
}

// Re-acquire lock on visibility change
const handleVisibilityChange = async () => {
  if (isExtracting.value && document.visibilityState === 'visible') {
    await requestWakeLock()
  }
}

// UI States
const file = ref(null)
const fileUrl = ref(null)
const originalSize = ref(0)
const outputSize = ref(0)
const outputUrl = ref(null)

const isDragging = ref(false)
const isExtracting = ref(false)
const progress = ref(0)
const errorMessage = ref('')
const startTime = ref(0)
const estimatedTimeRemaining = ref('')

// Settings
const settings = ref({
  mode: 'audio', // 'audio' or 'video'
})

// Result type for rendering the correct player
const resultMode = ref('audio')

let worker = null
let lastEtaUpdateTime = 0

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
          const elapsed = now - startTime.value
          const totalEstimated = elapsed / progValue
          const remaining = totalEstimated - elapsed
          estimatedTimeRemaining.value = formatTime(remaining)
          lastEtaUpdateTime = now
        }
      } else if (progValue === 1) {
        estimatedTimeRemaining.value = 'Selesai'
      }
    } else if (type === 'done') {
      isExtracting.value = false

      const finalBlob = new Blob([resultBuffer], { type: mimeType })
      const downloadUrl = URL.createObjectURL(finalBlob)

      outputUrl.value = downloadUrl
      outputSize.value = finalBlob.size
      progress.value = 100
      showToast(
        'Ekstraksi Selesai',
        `Berhasil mengekstrak ${resultMode.value === 'audio' ? 'Audio' : 'Video'}!`,
        'success',
      )
      await releaseWakeLock()
    } else if (type === 'error') {
      isExtracting.value = false
      errorMessage.value = message
      showToast('Gagal', 'Terjadi kesalahan saat mengekstrak file', 'error')
      await releaseWakeLock()
    }
  }
}

// Format bytes
const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

// Format time
const formatTime = (ms) => {
  if (ms < 0 || !isFinite(ms)) return 'Menghitung waktu...'
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

  const videoExtensions = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.3gp', '.flv']
  const isVideo = selectedFile.type.startsWith('video/') ||
                  videoExtensions.some(ext => selectedFile.name.toLowerCase().endsWith(ext))

  if (!isVideo) {
    showToast('Format Salah', 'Harap masukkan file video.', 'error')
    return
  }

  // Revoke old URLs
  if (fileUrl.value) URL.revokeObjectURL(fileUrl.value)
  if (outputUrl.value) URL.revokeObjectURL(outputUrl.value)

  file.value = selectedFile
  originalSize.value = selectedFile.size
  fileUrl.value = URL.createObjectURL(selectedFile)

  // Reset states
  outputUrl.value = null
  outputSize.value = 0
  errorMessage.value = ''
  progress.value = 0
}

// Start Extraction
const startExtraction = async () => {
  if (!file.value) return

  errorMessage.value = ''
  isExtracting.value = true
  progress.value = 0
  startTime.value = Date.now()
  lastEtaUpdateTime = 0
  estimatedTimeRemaining.value = 'Menghitung waktu...'
  resultMode.value = settings.value.mode

  await requestWakeLock()

  initWorker()

  try {
    const arrayBuffer = await file.value.arrayBuffer()

    worker.postMessage(
      {
        type: 'extract',
        payload: {
          fileData: arrayBuffer,
          fileName: file.value.name.replace(/\s+/g, '_'),
          options: {
            mode: settings.value.mode,
          },
        },
      },
      [arrayBuffer],
    )
  } catch (err) {
    errorMessage.value = err.message
    isExtracting.value = false
    await releaseWakeLock()
    showToast('Gagal', 'Tidak dapat membaca file media.', 'error')
  }
}



const reset = async () => {
  if (worker && isExtracting.value) {
    worker.terminate()
    worker = null
    isExtracting.value = false
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

// Alert before unload during active extraction
const handleBeforeUnload = (e) => {
  if (isExtracting.value) {
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
              d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
            />
          </svg>
          Parameter Ekstraksi
        </h3>
        <p class="text-xs text-slate-400 mt-1">Pilih bagian media yang ingin Anda simpan</p>
      </div>

      <div class="p-5 space-y-5 flex-1">
        <div class="space-y-3">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider"
            >Mode Ekstraksi</label
          >
          <div class="grid grid-cols-1 gap-3">
            <label
              class="flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all hover:bg-slate-800/50"
              :class="{
                'bg-brand-600/10 border-brand-500 shadow-sm shadow-brand-500/20':
                  settings.mode === 'audio',
                'border-slate-800': settings.mode !== 'audio',
              }"
            >
              <input type="radio" v-model="settings.mode" value="audio" class="sr-only" />
              <div
                class="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                :class="settings.mode === 'audio' ? 'bg-brand-500/20' : 'bg-slate-800'"
              >
                <svg
                  class="w-5 h-5"
                  :class="settings.mode === 'audio' ? 'text-brand-400' : 'text-slate-400'"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                  />
                </svg>
              </div>
              <div>
                <h4
                  class="text-sm font-bold"
                  :class="settings.mode === 'audio' ? 'text-brand-400' : 'text-slate-300'"
                >
                  Audio Saja (MP3)
                </h4>
                <p class="text-[10px] text-slate-400 mt-0.5">Ambil suaranya saja, buang video.</p>
              </div>
            </label>

            <label
              class="flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all hover:bg-slate-800/50"
              :class="{
                'bg-brand-600/10 border-brand-500 shadow-sm shadow-brand-500/20':
                  settings.mode === 'video',
                'border-slate-800': settings.mode !== 'video',
              }"
            >
              <input type="radio" v-model="settings.mode" value="video" class="sr-only" />
              <div
                class="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                :class="settings.mode === 'video' ? 'bg-brand-500/20' : 'bg-slate-800'"
              >
                <svg
                  class="w-5 h-5"
                  :class="settings.mode === 'video' ? 'text-brand-400' : 'text-slate-400'"
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
              <div>
                <h4
                  class="text-sm font-bold"
                  :class="settings.mode === 'video' ? 'text-brand-400' : 'text-slate-300'"
                >
                  Video Saja (Tanpa Suara)
                </h4>
                <p class="text-[10px] text-slate-400 mt-0.5">
                  Simpan video asli tanpa ada audio (Mute).
                </p>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div
        class="p-4 bg-slate-900/50 border-t border-slate-800 flex items-start gap-3 text-[10px] text-slate-400"
      >
        <svg
          class="w-4 h-4 text-brand-400 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p>
          Proses ini sepenuhnya aman dan berjalan offline di browser Anda. Kualitas hasil video
          maupun audio akan sama baiknya dengan aslinya.
        </p>
      </div>
    </div>

    <!-- Right Column: Process & Output Area -->
    <div class="w-full lg:w-2/3 flex flex-col gap-4">
      <!-- Upload Zone -->
      <div
        v-if="!file && !isExtracting"
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
          Format didukung: MP4, WebM, MOV.
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

      <!-- File Loaded / Ready to Extract -->
      <div
        v-if="file && !isExtracting && !outputUrl"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center"
      >
        <div
          class="w-16 h-16 rounded-full bg-brand-500/10 flex items-center justify-center mb-4 border border-brand-500/20"
        >
          <svg class="w-8 h-8 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <h4 class="text-lg font-bold text-white break-all max-w-full">{{ file.name }}</h4>
        <p
          class="text-sm text-slate-400 mt-1 font-mono bg-slate-950 px-3 py-1 rounded-full border border-slate-800"
        >
          {{ formatBytes(originalSize) }}
        </p>

        <div class="flex items-center gap-3 mt-8 w-full sm:w-auto">
          <button
            @click="reset"
            class="flex-1 sm:flex-none px-6 py-3 rounded-xl border border-slate-700 text-slate-300 font-bold text-sm hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Batal
          </button>
          <button
            @click="startExtraction"
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
            Ekstrak Sekarang
          </button>
        </div>
      </div>

      <!-- Processing UI & Error Indicator -->
      <div
        v-if="isExtracting || errorMessage"
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
          <h4 class="text-sm font-bold text-white">Ekstraksi Gagal</h4>
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
              {{ progress === 0 ? 'Menyiapkan...' : 'Memproses...' }}
            </h4>
          </div>

          <div class="w-full max-w-md">
            <div class="flex justify-between text-xs font-bold mb-2">
              <span class="text-brand-400">Progres Ekstraksi</span>
              <span class="text-white">{{ progress }}%</span>
            </div>
            <div
              class="h-2.5 w-full bg-slate-950 rounded-full overflow-hidden border border-slate-800"
            >
              <div
                class="h-full bg-gradient-to-r from-brand-500 to-emerald-400 rounded-full transition-all duration-300 ease-out relative"
                :style="{ width: `${progress}%` }"
              >
                <div class="absolute inset-0 bg-white/20 animate-shimmer"></div>
              </div>
            </div>
            <p
              v-if="isExtracting && progress > 0"
              class="text-xs text-emerald-400 mt-3 text-center font-bold font-mono"
            >
              Sisa Waktu: {{ estimatedTimeRemaining }}
            </p>

            <div class="mt-8 flex justify-center">
              <button
                @click="reset"
                class="px-5 py-2.5 border border-rose-500/30 text-rose-400 hover:text-white hover:bg-rose-500 hover:border-rose-500 rounded-xl text-xs font-bold transition-all shadow-lg shadow-rose-500/10 cursor-pointer flex items-center gap-2"
              >
                Batalkan
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Result UI -->
      <div
        v-if="outputUrl"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl"
      >
        <!-- Preview Player -->
        <div
          class="w-full max-h-[400px] md:max-h-[450px] bg-black relative border-b border-slate-800 flex flex-col items-center justify-center p-6"
          :class="resultMode === 'audio' ? 'aspect-auto' : 'aspect-video'"
        >
          <template v-if="resultMode === 'audio'">
            <!-- Audio Player UI -->
            <div
              class="w-16 h-16 rounded-full bg-brand-500/10 flex items-center justify-center mb-6 border border-brand-500/20"
            >
              <svg
                class="w-8 h-8 text-brand-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
                />
              </svg>
            </div>
            <audio :src="outputUrl" controls class="w-full max-w-md rounded-xl"></audio>
          </template>

          <template v-else>
            <!-- Video Player UI -->
            <video :src="outputUrl" controls class="w-full h-full object-contain"></video>
            <div
              class="absolute top-4 right-4 bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-lg flex items-center gap-2"
            >
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span class="text-[10px] font-bold text-white tracking-wide uppercase"
                >Video Saja</span
              >
            </div>
          </template>
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
              <!-- Extracted Stat -->
              <div
                class="bg-brand-500/10 border border-brand-500/30 rounded-xl p-4 text-center relative overflow-hidden"
              >
                <p class="text-[10px] text-brand-400 font-bold uppercase tracking-wider mb-1">
                  Hasil Ekstraksi
                </p>
                <p class="text-lg font-bold text-white">{{ formatBytes(outputSize) }}</p>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <button
              @click="reset"
              class="px-5 py-3 rounded-xl border border-slate-700 hover:bg-slate-800 text-slate-300 font-bold text-sm transition-colors cursor-pointer"
            >
              Ekstrak Lainnya
            </button>
            <a
              :href="outputUrl"
              :download="`wvideo_extract_${resultMode === 'audio' ? 'audio.mp3' : 'video.mp4'}`"
              class="flex-1 block text-center px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-sm shadow-lg shadow-brand-600/20 transition-all cursor-pointer"
            >
              Simpan File
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
