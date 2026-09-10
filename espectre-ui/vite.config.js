import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Set your ESP32 IP here — find it from serial output or router
const DEVICE_IP = '192.168.0.103' // ← replace with your ESP32's actual IP
// To find the IP, run this in one terminal:

// cd /home/athomas2/Projects/ESP-PD-SN/espectre
// source .venv/bin/activate
// ./espectre monitor --chip s3 --reset --port /dev/ttyACM0
const DEVICE_PORT = 62587

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // Proxy all /api calls to the device, injecting the allowed Origin
      '/api': {
        target: `http://${DEVICE_IP}:${DEVICE_PORT}`,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '/espectre/v1'),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Inject the origin the firmware allows
            proxyReq.setHeader('Origin', 'https://espectre.dev')
          })
        },
      },
    },
  },
})
