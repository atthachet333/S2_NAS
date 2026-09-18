'use strict';

/**
 * Production process definitions only. Storage/backup/model paths deliberately
 * remain in backend/.env so this file cannot switch recovery-sensitive paths.
 */
module.exports = {
  apps: [
    {
      name: 's2-nas-backend',
      cwd: 'D:/S2A_PROJECT/S2_NAS/backend',
      script: 'dist/server.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      kill_timeout: 15000,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 's2-nas-frontend',
      cwd: 'D:/S2A_PROJECT/S2_NAS/frontend',
      script: 'server.mjs',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        FRONTEND_HOST: '0.0.0.0',
        FRONTEND_PORT: '8888',
        FRONTEND_ALLOWED_HOSTS: 's2anas.s2aconsultant.com',
        BACKEND_ORIGIN: 'http://127.0.0.1:8889',
      },
    },
  ],
};
