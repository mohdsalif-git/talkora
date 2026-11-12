/**
 * STUN / TURN configuration.
 *
 * Read from environment so operators can plug in a TURN relay for NAT traversal.
 * Without TURN credentials, WebRTC still works over STUN + direct (LAN / public-IP)
 * paths; clients behind symmetric NATs will fall back to text-only chat.
 */
export const ICE_SERVERS = (() => {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrls = process.env.TURN_URLS;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (turnUrls && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrls.split(',').map((u) => u.trim()),
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
})();

export const hasTurn = ICE_SERVERS.length > 1;

if (hasTurn) {
  console.log(`[ice] TURN relay configured (${ICE_SERVERS[1].urls.length} URL(s))`);
} else {
  console.log('[ice] TURN not configured — STUN and direct paths only');
}
