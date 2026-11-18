const { loadConfig } = require('./server/config');
const { createApp } = require('./server/app');

const config = loadConfig();
const instance = createApp(config);

instance.listen().then((port) => {
  const L = config.limits;
  console.log(`🎤 ezspeak running on http://localhost:${port}`);
  console.log(`   Join a server: http://localhost:${port}/server/myserver`);
  console.log(`   Limits: ${L.maxServers} servers (${L.maxServersPerIp}/IP), ${L.maxUsersPerServer} users/server, ` +
    `${L.maxUsersPerChannel} users/channel, ${L.maxChannelsPerServer} channels/server, ` +
    `${L.maxConnections} connections (${L.maxConnectionsPerIp}/IP)`);
  console.log(`   TURN relay: ${config.ice.relayAvailable ? 'configured' : 'not configured'}` +
    (config.ice.forceRelay ? ' — FORCE_RELAY on (all peer IPs hidden)' : ''));
  if (config.ice.forceRelay && !config.ice.relayAvailable) {
    console.warn('   ⚠️  FORCE_RELAY is on but no TURN server is configured: voice will not connect.');
  }
});

function shutdown() {
  instance.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
