<template>
  <v-card>
    <v-card-title class="d-flex justify-space-between">
      终端
      <div class="d-flex align-center">
        <v-chip
          :color="connected ? 'success' : 'error'"
          class="mr-2"
          small
        >
          {{ connected ? '已连接' : '未连接' }}
        </v-chip>
        <span v-if="sessionTime" class="text-caption">{{ sessionTime }}</span>
      </div>
    </v-card-title>

    <v-card-text>
      <div ref="terminalContainer" class="terminal-container" style="height: 400px;"></div>
    </v-card-text>

    <v-card-actions>
      <v-spacer></v-spacer>
      <v-btn
        v-if="!connected"
        color="primary"
        @click="connect"
      >
        重新连接
      </v-btn>
      <v-btn
        v-if="connected"
        class="mr-2"
        color="primary"
        @click="runCode"
      >
        运行
      </v-btn>
      <v-btn
        v-if="connected"
        color="error"
        @click="terminateSession"
      >
        终止
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script>
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import programmingLanguages from '@/constants/programming_languages.js'
import axios from '@/axios/axios'
import {createCodeRunWebSocketOptions} from '@/services/codeRunConnection.js'

export default {
  name: 'CodeRunTerminal',

  props: {
    code: {
      type: String,
      default: ''
    },
    language: {
      type: String,
      default: 'python',
      validator: (value) => Object.keys(programmingLanguages).includes(value)
    },
    autoRun: {
      type: Boolean,
      default: false
    },
    projectId: {
      type: [Number, String],
      default: null
    }
  },

  data() {
    return {
      term: null,
      fitAddon: null,
      ws: null,
      connected: false,
      sessionStartTime: null,
      sessionTimer: null,
      sessionTime: '',
      session: null
    }
  },

  async mounted() {
    await this.initializeTerminal()
    await this.connect()

    window.addEventListener('resize', this.handleResize)
  },

  beforeDestroy() {
    this.cleanup()
    window.removeEventListener('resize', this.handleResize)
  },

  methods: {
    async initializeTerminal() {
      this.term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: '#000000',
          foreground: '#ffffff'
        }
      })

      this.fitAddon = new FitAddon()
      this.term.loadAddon(this.fitAddon)

      this.term.open(this.$refs.terminalContainer)
      this.fitAddon.fit()
    },

    handleResize() {
      if (this.connected && this.fitAddon) {
        this.fitAddon.fit()
      }
    },

    async connect() {
      if (this.ws) {
        this.ws.close()
        this.ws = null
      }

      try {
        const response = await axios.post('/coderun/session', {
          project_id: this.projectId
        })
        const data = response.data
        if (!data.success || !data.runner || !data.capability) {
          throw new Error('No runner available')
        }

        this.session = data
        const connection = createCodeRunWebSocketOptions(
          data.runner.request_url,
          data.capability,
          window.location.protocol
        )
        this.ws = new WebSocket(connection.url, connection.protocol)
      } catch (error) {
        console.error('Failed to create CodeRun session:', error)
        this.term.write('\r\n[Error] Unable to create terminal session\r\n')
        return
      }

      this.ws.onopen = () => {
        this.connected = true
        this.sessionStartTime = Date.now()
        this.updateSessionTime()
        this.sessionTimer = setInterval(() => this.updateSessionTime(), 1000)
        this.term.write('\r\n[ZeroCat CodeRun] 🚀 Connected\r\n')

        if (this.code && this.autoRun) {
          this.runCode()
        }
      }

      this.ws.onclose = () => {
        this.connected = false
        this.ws = null
        this.term.write('\r\n[ZeroCat CodeRun] ❌ Disconnected\r\n')
        this.cleanup()
      }

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error)
        this.term.write('\r\n[ZeroCat CodeRun] ❌ Connection error\r\n')
      }

      this.ws.onmessage = (event) => {
        this.term.write(event.data)
      }

      this.term.onData(data => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(data)
        }
      })
    },

    async terminateSession() {
      try {
        if (this.ws) {
          if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: 'terminal.terminate',
              session_id: this.session?.session_id
            }))
          }
          this.ws.close(1000, 'User terminated session')
        }
      } catch (error) {
        console.error('Failed to terminate session:', error)
        this.term.write('\r\n[ZeroCat CodeRun] ❌ Failed to terminate session\r\n')
      }
    },

    updateSessionTime() {
      if (!this.sessionStartTime) return

      const diff = Date.now() - this.sessionStartTime
      const hours = Math.floor(diff / 3600000)
      const minutes = Math.floor((diff % 3600000) / 60000)
      const seconds = Math.floor((diff % 60000) / 1000)

      this.sessionTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    },

    cleanup() {
      if (this.sessionTimer) {
        clearInterval(this.sessionTimer)
        this.sessionTimer = null
      }
      this.sessionStartTime = null
      this.sessionTime = ''
    },

    runCode() {
      if (!this.connected || !this.ws || !this.code) return

      const langConfig = programmingLanguages[this.language]
      if (!langConfig) {
        this.term.write('\r\n[Error] Unsupported programming language\r\n')
        return
      }

      // Convert code to base64 with UTF-8 support
      const encoder = new TextEncoder()
      const utf8Bytes = encoder.encode(this.code)
      const base64Code = btoa(String.fromCharCode.apply(null, utf8Bytes))
      const command = langConfig.command.replace('{code}', base64Code)

      this.ws.send(command + '\n')
    }
  }
}
</script>

<style scoped>
.terminal-container {
  width: 100%;
  border-radius: 4px;
  padding: 8px;
  background-color: #000;
}
</style>
