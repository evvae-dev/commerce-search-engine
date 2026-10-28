module.exports = {
  apps: [
    {
      name: 'commerce-search-engine',
      cwd: './',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 3200',
      exec_mode: 'cluster',
      instances: 1,
      autorestart: true,
      listen_timeout: 50000,
      kill_timeout: 5000,
    },
  ],
};
