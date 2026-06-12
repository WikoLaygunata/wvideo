<script setup>
import { ref, inject, onBeforeUnmount, onMounted, computed } from 'vue'

const showToast = inject('showToast')

// UI States
const isDragging = ref(false)
const isExtracting = ref(false) // Flag baru untuk mengunci proses upload
const files = ref([]) 
const isProcessing = ref(false)
const progress = ref(0)
const errorMessage = ref('')
const processStartTime = ref(0)
const estimatedTimeRemaining = ref('')
let lastEtaUpdateTime = 0

// Output State
const outputUrl = ref(null)
const outputSize = ref(0)

// Format helper
const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

const formatTimeSeconds = (sec) => {
  if (isNaN(sec) || !isFinite(sec)) return '00:00.000'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

const formatTime = (ms) => {
  if (ms < 0 || !isFinite(ms)) return 'Menghitung...'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} detik`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes} menit ${seconds} detik`
}

// Detect Resolution mismatch
const hasMixedResolutions = computed(() => {
  if (files.value.length <= 1) return false
  const firstW = files.value[0].width
  const firstH = files.value[0].height
  return files.value.some((f) => f.width !== firstW || f.height !== firstH)
})

const totalDuration = computed(() => {
  return files.value.reduce((acc, curr) => acc + (curr.duration || 0), 0)
})

const totalSize = computed(() => {
  return files.value.reduce((acc, curr) => acc + (curr.size || 0), 0)
})

// File handling
const extractVideoMetadata = (file) => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'

    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        url: url,
      })
    }

    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Gagal memuat metadata video'))
    }

    video.src = url
  })
}

const onFileSelect = async (event) => {
  if (isExtracting.value) return
  const selectedFiles = event.target.files || event.dataTransfer?.files
  if (!selectedFiles || selectedFiles.length === 0) return

  const videoExtensions = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.3gp', '.flv']
  const validFiles = Array.from(selectedFiles).filter((f) => {
    return f.type.startsWith('video/') ||
           videoExtensions.some(ext => f.name.toLowerCase().endsWith(ext))
  })

  if (validFiles.length === 0) {
    showToast('Format Salah', 'Harap masukkan file video.', 'error')
    return
  }

  const MAX_TOTAL_SIZE = 500 * 1024 * 1024
  const newSize = validFiles.reduce((acc, f) => acc + f.size, 0)
  if (totalSize.value + newSize > MAX_TOTAL_SIZE) {
    const proceed = window.confirm(
      `Peringatan: Total ukuran video akan melebihi 500MB.\nBrowser mungkin crash karena batasan memori WebAssembly. Lanjutkan?`,
    )
    if (!proceed) {
      if (event.target) event.target.value = ''
      return
    }
  }

  isExtracting.value = true // Kunci state
  
  try {
    // Jalankan ekstraksi metadata secara PARALEL
    const metaPromises = Array.from(validFiles).map(async (file) => {
      try {
        const meta = await extractVideoMetadata(file)
        return {
          id: Math.random().toString(36).substr(2, 9),
          file,
          name: file.name,
          size: file.size,
          width: meta.width,
          height: meta.height,
          duration: meta.duration,
          url: meta.url,
        }
      } catch (e) {
        console.error(e)
        showToast('Gagal', `Gagal membaca file ${file.name}`, 'warning')
        return null // skip jika ada 1 file yang korup metadatanya
      }
    })

    const resolvedFiles = await Promise.all(metaPromises)
    files.value.push(...resolvedFiles.filter(f => f !== null))
  } catch (err) {
    showToast('Gagal', 'Terjadi kesalahan membaca klip video.', 'error')
  } finally {
    isExtracting.value = false // Buka kunci state
    if (event.target) event.target.value = ''
  }
}

// Queue Management
const moveUp = (index) => {
  if (index === 0) return
  const temp = files.value[index - 1]
  files.value[index - 1] = files.value[index]
  files.value[index] = temp
}

const moveDown = (index) => {
  if (index === files.value.length - 1) return
  const temp = files.value[index + 1]
  files.value[index + 1] = files.value[index]
  files.value[index] = temp
}

const removeFile = (index) => {
  const item = files.value[index]
  if (item.url) URL.revokeObjectURL(item.url)
  files.value.splice(index, 1)
}

// Worker logic
let worker = null

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
      isProcessing.value = false
      const finalBlob = new Blob([resultBuffer], { type: mimeType })
      const downloadUrl = URL.createObjectURL(finalBlob)

      outputUrl.value = downloadUrl
      outputSize.value = finalBlob.size
      progress.value = 100
      showToast('Gabung Selesai', 'Video berhasil digabungkan!', 'success')
    } else if (type === 'error') {
      isProcessing.value = false
      errorMessage.value = message
      showToast('Gagal', 'Terjadi kesalahan saat menggabung', 'error')
    }
  }
}

const startMerging = async () => {
  if (files.value.length < 2) {
    showToast('Info', 'Butuh minimal 2 video untuk digabungkan.', 'warning')
    return
  }

  // Tambahan pengunci validasi di sisi JavaScript
  if (hasMixedResolutions.value) {
    showToast('Gagal', 'Resolusi video harus sama untuk penggabungan instan.', 'error')
    return
  }

  errorMessage.value = ''
  isProcessing.value = true
  progress.value = 0
  processStartTime.value = Date.now()
  lastEtaUpdateTime = 0
  estimatedTimeRemaining.value = 'Menghitung waktu...'

  if (!worker) {
    initWorker()
  }

  try {
    const filePayloads = []
    for (const f of files.value) {
      const arrBuf = await f.file.arrayBuffer()
      filePayloads.push({
        fileData: arrBuf,
        fileName: f.name,
      })
    }

    worker.postMessage(
      {
        type: 'merge',
        payload: {
          files: filePayloads,
          options: { mode: 'fast' },
        },
      },
      filePayloads.map((f) => f.fileData),
    )
  } catch (err) {
    errorMessage.value = err.message
    isProcessing.value = false
    showToast('Gagal', 'Tidak dapat memproses file.', 'error')
  }
}

const reset = () => {
  isExtracting.value = false // Batalkan semua loop upload yang tersisa
  
  if (worker) {
    worker.terminate()
    worker = null
  }
  isProcessing.value = false

  if (outputUrl.value) {
    URL.revokeObjectURL(outputUrl.value)
    outputUrl.value = null
  }

  files.value.forEach((f) => {
    if (f.url) URL.revokeObjectURL(f.url)
  })
  files.value = []

  progress.value = 0
  errorMessage.value = ''
}

const resetOutputOnly = () => {
  if (outputUrl.value) {
    URL.revokeObjectURL(outputUrl.value)
    outputUrl.value = null
  }
}

const handleBeforeUnload = (e) => {
  if (isProcessing.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }
})

onBeforeUnmount(() => {
  if (worker) worker.terminate()
  files.value.forEach((f) => {
    if (f.url) URL.revokeObjectURL(f.url)
  })
  if (outputUrl.value) URL.revokeObjectURL(outputUrl.value)
  
  // Lepaskan event listener global agar memori bersih
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
})
</script>


<template>
  <div class="flex flex-col lg:flex-row gap-6 items-start w-full">
    <!-- Left Column: Settings & Queue -->
    <div
      class="w-full lg:w-1/3 bg-slate-950/80 border border-slate-800/80 rounded-2xl shadow-2xl flex flex-col backdrop-blur-sm h-[600px] max-h-screen"
    >
      <div class="p-5 border-b border-slate-800/80 bg-slate-950/60 flex-shrink-0">
        <h3 class="text-lg font-bold text-white flex items-center gap-2">
          <svg class="w-5 h-5 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2.5"
              d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
            />
          </svg>
          Antrean & Pengaturan
        </h3>
        <p class="text-xs text-slate-400 mt-1">Gabungkan file sesuai urutan dari atas ke bawah</p>
      </div>

      <div class="p-5 flex flex-col gap-5 flex-1 overflow-hidden">
        <!-- Settings Info -->
        <div class="space-y-4 flex-shrink-0">
          <div class="p-4 bg-brand-500/10 border border-brand-500/20 rounded-xl">
            <p class="text-[11px] text-slate-300 leading-relaxed font-medium">
              Penggabungan video di sini menggunakan mode instan tanpa re-encode. Mode ini sangat
              cepat (hanya beberapa detik), tetapi
              <strong>hanya cocok untuk video-video dengan resolusi (ukuran) yang sama</strong>.
            </p>
          </div>

          <!-- Warning for Mixed Resolutions -->
          <div
            v-if="hasMixedResolutions"
            class="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl"
          >
            <p class="text-[11px] text-rose-400 font-bold leading-relaxed">
              ⚠️ Terdeteksi video dengan resolusi berbeda. Penggabungan dibatalkan karena akan
              menyebabkan video patah-patah atau rusak. Silakan pastikan semua video memiliki ukuran
              yang sama!
            </p>
          </div>
        </div>

        <div class="border-t border-slate-800 my-1"></div>

        <!-- Queue List -->
        <div class="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-2">
          <div v-if="files.length === 0" class="text-center py-8 text-xs text-slate-500">
            Belum ada video di antrean.<br />Silakan tambahkan video.
          </div>
          <transition-group name="fade">
            <div
              v-for="(item, index) in files"
              :key="item.id"
              class="bg-slate-900 border border-slate-800 rounded-xl p-3 flex gap-3 items-center group transition-all hover:border-slate-700"
            >
              <!-- Index -->
              <div
                class="w-6 h-6 rounded bg-slate-950 flex items-center justify-center text-xs font-bold text-slate-400"
              >
                {{ index + 1 }}
              </div>

              <!-- Info -->
              <div class="flex-1 min-w-0">
                <p class="text-xs font-bold text-white truncate" :title="item.name">
                  {{ item.name }}
                </p>
                <div class="flex items-center gap-2 text-[10px] text-slate-500 mt-1 font-mono">
                  <span>{{ formatTimeSeconds(item.duration) }}</span>
                  <span>•</span>
                  <span>{{ item.width }}x{{ item.height }}</span>
                </div>
              </div>

              <!-- Controls -->
              <div
                class="flex flex-col gap-1 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <button
                  @click="moveUp(index)"
                  :disabled="index === 0"
                  class="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-white"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                </button>
                <button
                  @click="moveDown(index)"
                  :disabled="index === files.length - 1"
                  class="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-white"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
              </div>

              <button
                @click="removeFile(index)"
                class="p-1.5 ml-1 rounded text-rose-500 hover:bg-rose-500/20 opacity-100 lg:opacity-0 group-hover:opacity-100 transition-all"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </transition-group>
        </div>
      </div>
    </div>

    <!-- Right Column: Upload, Processing & Output -->
    <div class="w-full lg:w-2/3 flex flex-col gap-4">
      <!-- Upload Zone -->
      <div
        v-if="!isProcessing && !outputUrl"
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
          class="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform shadow-lg"
        >
          <svg class="w-8 h-8 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
        </div>
        <h4 class="text-base font-bold text-white">Upload / Tambah Video</h4>
        <p class="text-xs text-slate-400 mt-2 max-w-sm text-center">
          Pilih beberapa file sekaligus untuk dimasukkan ke dalam antrean penggabungan.
        </p>
        <input
          type="file"
          accept="video/*"
          multiple
          class="hidden"
          id="merge-upload"
          @change="onFileSelect"
        />
        <label
          for="merge-upload"
          class="mt-6 px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold text-sm cursor-pointer transition-colors shadow-lg shadow-slate-900"
        >
          Pilih File Video
        </label>
      </div>

      <!-- Action Panel (Visible if there are files and not processing/output) -->
      <div
        v-if="files.length > 0 && !isProcessing && !outputUrl"
        class="bg-slate-950/80 border border-slate-800/80 rounded-2xl p-6 shadow-2xl flex flex-col sm:flex-row items-center justify-between gap-6 backdrop-blur-sm"
      >
        <div>
          <h4 class="text-lg font-bold text-white">Siap Digabung</h4>
          <p class="text-xs text-slate-400 mt-1 font-mono">
            {{ files.length }} Video • Total Durasi: {{ formatTimeSeconds(totalDuration) }}
          </p>
        </div>
        <div class="flex w-full sm:w-auto gap-3">
          <button
            @click="reset"
            class="flex-1 sm:flex-none px-6 py-3 rounded-xl border border-slate-700 text-slate-300 font-bold text-sm hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Bersihkan
          </button>
          <button
            @click="startMerging"
            :disabled="files.length < 2 || hasMixedResolutions"
            class="flex-1 sm:flex-none px-8 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm shadow-lg shadow-brand-600/20 transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            Mulai Gabung
          </button>
        </div>
      </div>

      <!-- Processing UI -->
      <div
        v-if="isProcessing || errorMessage"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl p-6 shadow-2xl relative overflow-hidden"
      >
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
          <h4 class="text-sm font-bold text-white">Penggabungan Gagal</h4>
          <p class="text-xs text-rose-400 mt-2 max-w-sm">{{ errorMessage }}</p>
          <button
            @click="resetOutputOnly"
            class="mt-6 px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-bold transition-colors"
          >
            Coba Lagi
          </button>
        </div>

        <div v-else class="flex flex-col items-center">
          <div class="flex items-center gap-3 mb-6">
            <div
              class="w-8 h-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"
            ></div>
            <h4 class="text-sm font-bold text-white">
              {{ progress === 0 ? 'Menyiapkan...' : 'Menggabungkan video...' }}
            </h4>
          </div>
          <div class="w-full max-w-md">
            <div class="flex justify-between text-xs font-bold mb-2">
              <span class="text-brand-400">Progres Keseluruhan</span>
              <span class="text-white">{{ progress }}%</span>
            </div>
            <div
              class="h-2.5 w-full bg-slate-950 rounded-full overflow-hidden border border-slate-800"
            >
              <div
                class="h-full bg-gradient-to-r from-emerald-500 to-brand-400 rounded-full transition-all duration-300 relative"
                :style="{ width: `${progress}%` }"
              >
                <div class="absolute inset-0 bg-white/20 animate-shimmer"></div>
              </div>
            </div>
            <p class="text-xs text-emerald-400 mt-3 text-center font-bold font-mono">
              Sisa Waktu: {{ estimatedTimeRemaining }}
            </p>
            <div class="mt-8 flex justify-center">
              <button
                @click="reset"
                class="px-5 py-2.5 border border-rose-500/30 text-rose-400 hover:text-white hover:bg-rose-500 hover:border-rose-500 rounded-xl text-xs font-bold transition-all shadow-lg shadow-rose-500/10 flex items-center gap-2"
              >
                Batalkan Proses
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Output Result -->
      <div
        v-if="outputUrl"
        class="bg-slate-950/80 backdrop-blur-sm border border-slate-800/80 rounded-2xl overflow-hidden shadow-2xl"
      >
        <div
          class="aspect-video max-h-[400px] md:max-h-[450px] bg-black relative border-b border-slate-800 flex items-center justify-center"
        >
          <video :src="outputUrl" controls class="w-full h-full object-contain"></video>
          <div
            class="absolute top-4 right-4 bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-1.5 rounded-lg flex items-center gap-2"
          >
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-[10px] font-bold text-white tracking-wide uppercase"
              >Hasil Gabungan</span
            >
          </div>
        </div>
        <div class="p-6">
          <div class="flex flex-col sm:flex-row items-center gap-3">
            <button
              @click="resetOutputOnly"
              class="w-full sm:w-auto px-5 py-3 rounded-xl border border-brand-700 hover:bg-brand-700/20 text-brand-400 hover:text-brand-300 font-bold text-sm transition-colors cursor-pointer"
            >
              Kembali ke Pengaturan
            </button>
            <button
              @click="reset"
              class="w-full sm:w-auto px-5 py-3 rounded-xl border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-slate-200 font-bold text-sm transition-colors cursor-pointer"
            >
              Mulai Baru
            </button>
            <a
              :href="outputUrl"
              download="wvideo_merged.mp4"
              class="flex-1 w-full text-center px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-sm shadow-lg shadow-brand-600/20 transition-all cursor-pointer"
            >
              Simpan Video ({{ formatBytes(outputSize) }})
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
.fade-move {
  transition: transform 0.3s ease;
}
</style>
