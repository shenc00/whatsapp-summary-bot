module.exports = {
  apps: [
    {
      name: 'whatsapp-bot',
      script: 'src/index.js',
      cwd: '/home/ubuntu/whatsapp-summary-bot',
      autorestart: true,
      max_restarts: 10,
      min_uptime: 15000,
      restart_delay: 5000,
      // Chrome under puppeteer creeps up over days; recycle the bot before it
      // can squeeze the ktmb containers sharing this 4GB box.
      max_memory_restart: '900M',
    },
  ],
};
