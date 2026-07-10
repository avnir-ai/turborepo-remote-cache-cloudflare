import { defineConfig } from 'nitro';

export default defineConfig({
  compatibilityDate: '2026-07-08',
  preset: process.env.NITRO_PRESET ?? 'cloudflare_module',
  serverDir: './',
  serverEntry: './server.ts',
  alias: {
    '~': './src',
  },
  exportConditions: ['module'],
  rolldownConfig: {
    resolve: {
      mainFields: ['module', 'main'],
    },
  },
  experimental: {
    tasks: true,
  },
  tasks: {
    'cache:delete-expired': {
      description: 'Delete expired cache artifacts',
    },
  },
  scheduledTasks: {
    '0 3 * * *': 'cache:delete-expired',
  },
});
