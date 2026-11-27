<template>
  <AuthCard subtitle="登录你的账户">
    <div class="oauth-card">
      <!-- Loading state -->
      <div v-if="loading" class="auth-state auth-loading text-center">
        <v-progress-circular
          color="primary"
          indeterminate
          size="64"
        ></v-progress-circular>
        <h3 class="text-h6 mt-4">验证中...</h3>
        <p class="text-body-1">正在处理您的登录请求，请稍候</p>
      </div>

      <!-- Success state -->
      <div v-else-if="authSuccess" class="auth-state auth-success text-center">
        <v-icon
          class="mb-4"
          color="success"
          size="64"
        >
          mdi-check-circle
        </v-icon>
        <h3 class="text-h6">登录成功</h3>
        <p class="text-body-1">欢迎回来，{{ displayName }}</p>
        <p class="text-body-2 text-medium-emphasis">正在跳转到首页...</p>
      </div>

      <!-- Error state -->
      <div v-else class="auth-state auth-error text-center">
        <v-icon
          class="mb-4"
          color="error"
          size="64"
        >
          mdi-alert-circle
        </v-icon>
        <h3 class="text-h6">登录失败</h3>
        <p class="text-body-1">{{ errorMessage }}</p>
        <v-btn
          class="mt-4"
          color="primary"
          variant="text"
          @click="goToLogin"
        >
          返回登录
        </v-btn>
      </div>
    </div>
  </AuthCard>
</template>

<script setup>
import {ref, onMounted} from 'vue';
import {useRoute, useRouter} from 'vue-router';
import {localuser} from '@/services/localAccount';
import {useAuthStore} from '@/stores/auth';
import axios from '@/axios/axios';
import AuthCard from '@/components/AuthCard.vue';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const loading = ref(true);
const authSuccess = ref(false);
const errorMessage = ref('');
const displayName = ref('');

onMounted(async () => {
  try {
    const redirectFromQuery =
      typeof route.query.redirect === 'string' ? route.query.redirect : null;
    if (redirectFromQuery) {
      authStore.setAuthRedirectUrl(redirectFromQuery);
    }

    // HttpOnly Cookie 中的临时令牌和 OAuth 事务由浏览器自动随请求发送。
    const response = await axios.post('/account/oauth/validate-token');
    const data = response.data;

    if (data.status === 'success') {
      // 使用localuser的setUser方法保存令牌信息和加载用户信息
      await localuser.setUser(data);

      // 更新组件状态
      displayName.value = data.display_name || data.username;
      authSuccess.value = true;


  authStore.navigateToAuthRedirect(router);

    } else {
      throw new Error(data.message || '令牌验证失败');
    }
  } catch (error) {
    console.error('验证临时令牌时出错:', error);
    errorMessage.value = error.message || '登录过程中发生错误，请重试';
    authSuccess.value = false;
  } finally {
    loading.value = false;
  }
});

function goToLogin() {
  const redirectQuery = authStore.authRedirectUrl
    ? `?redirect=${encodeURIComponent(authStore.authRedirectUrl)}`
    : '';
  router.push(`/app/account/login${redirectQuery}`);
}
</script>

<style scoped>
.oauth-card {
  padding: 24px;
}

.auth-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}
</style>
