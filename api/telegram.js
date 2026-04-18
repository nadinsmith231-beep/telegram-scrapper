import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, apiId, apiHash, phone, code, password, sessionString, phoneCodeHash, groupId, groupAccessHash, userId, userAccessHash, limit = 500 } = req.body;

  // Validate API credentials
  if (!apiId || !apiHash) return res.status(400).json({ error: 'API ID and API Hash are required' });
  const apiIdNum = Number(apiId);
  if (isNaN(apiIdNum)) return res.status(400).json({ error: 'API ID must be a number' });

  // Helper to create a connected client
  const getClient = async (session = '') => {
    const client = new TelegramClient(new StringSession(session), apiIdNum, apiHash, {
      connectionRetries: 2,
      useWSS: false,
      timeout: 30000,
    });
    await client.connect();
    return client;
  };

  // Helper to safely disconnect
  const safeDisconnect = async (client) => {
    if (client && typeof client.disconnect === 'function') {
      try { await client.disconnect(); } catch (e) { console.warn('Disconnect error:', e.message); }
    }
  };

  try {
    switch (action) {
      // ---------- SEND CODE (low‑level API) ----------
      case 'sendCode': {
        if (!phone) return res.status(400).json({ error: 'Phone number required' });
        const client = await getClient();
        try {
          const result = await client.invoke(new Api.auth.SendCode({
            phoneNumber: phone,
            apiId: apiIdNum,
            apiHash: apiHash,
            settings: new Api.CodeSettings({}),
          }));
          console.log('SendCode result:', result);
          const hash = result.phoneCodeHash;
          if (!hash) throw new Error('No phoneCodeHash returned');
          return res.json({ success: true, phoneCodeHash: hash });
        } catch (err) {
          console.error('sendCode error:', err);
          return res.status(400).json({ error: err.message });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- SIGN IN (low‑level API) ----------
      case 'signIn': {
        if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
        if (!phoneCodeHash) return res.status(400).json({ error: 'Missing phoneCodeHash. Request a new code.' });
        const client = await getClient();
        try {
          // Attempt normal sign in
          const result = await client.invoke(new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: code,
          }));
          // If successful, save session
          const savedSession = client.session.save();
          console.log('SignIn success, session saved');
          await safeDisconnect(client);
          return res.json({ success: true, sessionString: savedSession });
        } catch (err) {
          await safeDisconnect(client);
          // Check if 2FA is required
          if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
            return res.status(400).json({ error: '2FA_REQUIRED', message: '2FA password required' });
          }
          // Handle invalid code / expired
          return res.status(400).json({ error: err.message });
        }
      }

      // ---------- 2FA SIGN IN (if password provided) ----------
      case 'signInWithPassword': {
        if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
        const client = await getClient();
        try {
          // First we need to get the password hash (simplified: use client.checkPassword)
          // For simplicity, we assume the client already has the session from previous step
          // Actually, we need to call auth.checkPassword. But the library provides a helper:
          await client.checkPassword(password);
          const savedSession = client.session.save();
          await safeDisconnect(client);
          return res.json({ success: true, sessionString: savedSession });
        } catch (err) {
          await safeDisconnect(client);
          return res.status(400).json({ error: err.message });
        }
      }

      // ---------- GET DIALOGS ----------
      case 'getDialogs': {
        if (!sessionString) return res.status(400).json({ error: 'Session required' });
        const client = await getClient(sessionString);
        try {
          const dialogs = await client.getDialogs();
          const groups = dialogs
            .filter(d => d.isGroup || d.isChannel)
            .map(d => ({
              id: d.id.valueOf(),
              accessHash: d.accessHash?.valueOf(),
              title: d.title,
              type: d.isChannel ? 'channel' : 'supergroup',
            }));
          return res.json({ success: true, dialogs: groups });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- SCRAPE MEMBERS ----------
      case 'scrapeMembers': {
        if (!sessionString || !groupId || !groupAccessHash) return res.status(400).json({ error: 'Missing parameters' });
        const client = await getClient(sessionString);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const members = [];
          let offset = 0, batchSize = 200, hasMore = true;
          while (hasMore && members.length < limit) {
            const participants = await client.invoke(new Api.channels.GetParticipants({
              channel,
              filter: new Api.ChannelParticipantsRecent(),
              offset,
              limit: Math.min(batchSize, limit - members.length),
            }));
            const users = participants.users || [];
            for (const user of users) {
              if (!user.bot && user.id) {
                members.push({
                  id: user.id.valueOf(),
                  accessHash: user.accessHash?.valueOf(),
                  firstName: user.firstName || '',
                  lastName: user.lastName || '',
                  username: user.username || '',
                });
              }
            }
            if (users.length < batchSize) hasMore = false;
            offset += batchSize;
          }
          return res.json({ success: true, members, total: members.length });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- ADD MEMBER ----------
      case 'addMember': {
        if (!sessionString || !groupId || !groupAccessHash || !userId || !userAccessHash) {
          return res.status(400).json({ error: 'Missing parameters' });
        }
        const client = await getClient(sessionString);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const user = { className: 'InputPeerUser', userId: Number(userId), accessHash: String(userAccessHash) };
          await client.invoke(new Api.channels.InviteToChannel({ channel, users: [user] }));
          return res.json({ success: true });
        } catch (err) {
          let errorMsg = err.message;
          let isRestricted = false;
          if (errorMsg.includes('USER_PRIVACY_RESTRICTED')) {
            isRestricted = true;
            errorMsg = 'User privacy settings prevent adding to groups';
          } else if (errorMsg.includes('FLOOD_WAIT')) {
            const waitMatch = errorMsg.match(/\d+/);
            errorMsg = `FLOOD_WAIT_${waitMatch ? waitMatch[0] : 'unknown'}`;
          } else if (errorMsg.includes('PEER_FLOOD')) {
            errorMsg = 'FLOOD_LIMITED';
          }
          return res.status(400).json({ success: false, error: errorMsg, restricted: isRestricted });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- GET GROUP INFO ----------
      case 'getGroupInfo': {
        if (!sessionString || !groupId || !groupAccessHash) return res.status(400).json({ error: 'Missing parameters' });
        const client = await getClient(sessionString);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
          const memberCount = full.fullChat?.participantsCount || full.chats?.[0]?.participantsCount || 0;
          return res.json({ success: true, memberCount });
        } finally {
          await safeDisconnect(client);
        }
      }

      default:
        return res.status(400).json({ error: `Invalid action: ${action}` });
    }
  } catch (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
