import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

const requestedTheme = new URLSearchParams(window.location.search).get('theme')
const startupTheme = requestedTheme === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = startupTheme
document.documentElement.style.colorScheme = startupTheme

createApp(App).mount('#app')
