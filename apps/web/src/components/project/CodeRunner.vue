<template>
  <div class="code-runner">
    <v-card class="editor-card" elevation="2">
      <v-card-title class="d-flex align-center pa-4">
        <v-icon :icon="currentLanguage.icon || 'mdi-code-tags'" class="me-3" size="24"></v-icon>
        <span class="text-h6">代码编辑器</span>
        <v-spacer></v-spacer>
        <v-chip
          :color="getLanguageColor(selectedLanguage)"
          variant="flat"
          size="small"
          class="text-caption"
        >
          {{ currentLanguage.name || selectedLanguage }}
        </v-chip>
      </v-card-title>

      <v-divider></v-divider>

      <v-card-text class="pa-4">
        <v-row>
          <v-col cols="12">
            <v-select
              v-model="selectedLanguage"
              :items="languageOptions"
              class="mb-4"
              item-title="name"
              item-value="key"
              label="选择编程语言"
              variant="outlined"
              prepend-inner-icon="mdi-code-braces"
              hide-details
            >
              <template #item="{ props, item }">
                <v-list-item v-bind="props">
                  <template #prepend>
                    <v-icon :icon="programmingLanguages[item.value]?.icon || 'mdi-code-tags'" class="me-3"></v-icon>
                  </template>
                </v-list-item>
              </template>
            </v-select>
          </v-col>
          <v-col cols="12">
            <v-textarea
              v-model="code"
              :label="currentLanguage.placeholder || '在此输入代码'"
              :placeholder="currentLanguage.sample"

              class="mb-4"
              rows="12"
              variant="outlined"
              @keydown.enter="runCode"

            >
              <template #prepend-inner>
                <v-icon icon="mdi-code-tags" class="mt-1" size="20" color="grey"></v-icon>
              </template>
            </v-textarea>
          </v-col>
        </v-row>

        <v-row class="mt-2">
          <v-col cols="12" class="d-flex justify-end">

            <v-btn
              @click="clearCode"
              color="grey"
              variant="outlined"
              prepend-icon="mdi-eraser"              class="me-2"

            >
              撤销所有编辑
            </v-btn>    <v-btn
              @click="runCode"
              color="primary"
              variant="elevated"
              prepend-icon="mdi-play"
            >
              运行代码
            </v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <CodeRunTerminal
      ref="terminal"
      :auto-run="false"
      :code="code"
      :language="selectedLanguage"
      :project-id="projectId"
    ></CodeRunTerminal>
  </div>
</template>

<script>
import { defineAsyncComponent } from 'vue'
import programmingLanguages from '@/constants/programming_languages.js'

const CodeRunTerminal = defineAsyncComponent(() =>
  import('@/components/admin/CodeRunTerminal.vue')
)

export default {
  name: 'CodeRunner',

  components: {
    CodeRunTerminal
  },

  props: {
    projectType: {
      type: String,
      default: 'python'
    },
    initialCode: {
      type: String,
      default: ''
    },
    projectId: {
      type: [Number, String],
      default: null
    },
  },

  data() {
    return {
      code: this.initialCode || '',
      selectedLanguage: this.getValidLanguage(),
      programmingLanguages,
      originalCode: this.initialCode || ''
    }
  },

  computed: {
    languageOptions() {
      return Object.entries(this.programmingLanguages).map(([key, lang]) => ({
        key,
        name: lang.name
      }))
    },
    currentLanguage() {
      return this.programmingLanguages[this.selectedLanguage] || {}
    }
  },

  methods: {
    runCode() {
      if (this.$refs.terminal) {
        this.$refs.terminal.runCode()
      }
    },
    clearCode() {
      this.code = this.originalCode
    },
    getValidLanguage() {

        if (Object.keys(programmingLanguages).includes(this.projectType)) {
        return this.projectType
      }
      return 'python'
    },
    getLanguageColor(language) {
      const colorMap = {
        python: 'blue',
        'python-2.7': 'blue-darken-1',
        'python-3.11': 'blue',
        'python-3.12': 'blue-darken-2',
        'python-3.13': 'blue-darken-3',
        javascript: 'yellow-darken-3',
        'javascript-nodejs18': 'green',
        'javascript-nodejs20': 'green-darken-1',
        'javascript-nodejs22': 'green-darken-2',
        'javascript-nodejs24': 'green-darken-3',
        rust: 'orange-darken-3',
        golang: 'cyan',
        ruby: 'red',
        java: 'orange',
        'java-openjdk17': 'orange-darken-1',
        'java-openjdk21': 'orange-darken-2',
        'java-openjdk24': 'orange-darken-3'
      }
      return colorMap[language] || 'grey'
    }
  },

  watch: {
    initialCode(newVal) {
      this.code = newVal || ''
    },
    projectType: {
      handler(newVal) {
        this.selectedLanguage = newVal
      },
      immediate: true
    },

  }
}
</script>

<style scoped>
.code-runner {
  width: 100%;
}

.editor-card {
  margin-bottom: 1.5rem;
  border-radius: 12px;
  overflow: hidden;
}

.v-textarea {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.v-textarea :deep(.v-field__input) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.5;
}

.v-select :deep(.v-field__input) {
  font-weight: 500;
}

.v-btn {
  border-radius: 8px;
  text-transform: none;
  font-weight: 500;
}

.v-chip {
  font-weight: 600;
}
</style>
