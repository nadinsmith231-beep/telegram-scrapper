import MTProto from '@mtproto/core';

// In-memory session storage (one per request)
function getSession(sessionString) {
  try {
    return sessionString ? JSON.parse(sessionString) : {};
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    action,
    apiId,
    apiHash,
    phone,
    code,
    password,
    sessionString,
    groupId,
    groupAccessHash,
    userId,
    userAccessHash,
    limit = 500,
  } = req.body;

  if (!apiId || !apiHash) {
    return res.status(400).json({ error: 'API ID and API Hash are required' });
  }

  // Restore session data
  let sessionData = getSession(sessionString);

  // Create MTProto instance with memory storage
  const mtproto = new MTProto({
    api_id: Number(apiId),
    api_hash: apiHash,
    storageOptions: { path: null }, // no file system
    storage: {
      set: (key, value) => { sessionData[key] = value; },
      get: (key) => sessionData[key],
    },
  });

  try {
    switch (action) {
      case 'sendCode': {
        if (!phone) return res.status(400).json({ error: 'Phone number required' });
        const { phone_code_hash } = await mtproto.call('auth.sendCode', {
          phone_number: phone,
          settings: { _: 'codeSettings' },
        });
        sessionData.phone_code_hash = phone_code_hash;
        const newSessionString = JSON.stringify(sessionData);
        return res.json({ success: true, sessionString: newSessionString });
      }

      case 'signIn': {
        if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
        const { phone_code_hash } = sessionData;
        if (!phone_code_hash) return res.status(400).json({ error: 'No active code, please request a new code' });
        try {
          await mtproto.call('auth.signIn', {
            phone_number: phone,
            phone_code: code,
            phone_code_hash,
          });
          // After successful sign-in, the auth key is stored in sessionData via the storage adapter
          const newSessionString = JSON.stringify(sessionData);
          return res.json({ success: true, sessionString: newSessionString });
        } catch (err) {
          if (err.error_message === 'SESSION_PASSWORD_NEEDED') {
            return res.status(400).json({ error: '2FA_REQUIRED', message: 'Two‑factor password required' });
          }
          throw err;
        }
      }

      case 'getDialogs': {
        // No need to check sessionString; mtproto will use stored auth key if available
        const dialogsResult = await mtproto.call('messages.getDialogs', {
          offset_id: 0,
          limit: 100,
        });
        const groups = [];
        for (const dialog of dialogsResult.dialogs) {
          let peerId = null, peerType = null;
          if (dialog.peer._ === 'peerChannel') {
            peerId = dialog.peer.channel_id;
            peerType = 'channel';
          } else if (dialog.peer._ === 'peerChat') {
            peerId = dialog.peer.chat_id;
            peerType = 'chat';
          } else continue;
          const chat = dialogsResult.chats.find(c => c.id === peerId);
          if (chat) {
            groups.push({
              id: peerId,
              title: chat.title,
              type: peerType,
              accessHash: chat.access_hash,
            });
          }
        }
        return res.json({ success: true, dialogs: groups });
      }

      case 'scrapeMembers': {
        if (!groupId) return res.status(400).json({ error: 'Group ID required' });
        const channel = {
          _: 'inputPeerChannel',
          channel_id: Number(groupId),
          access_hash: groupAccessHash ? String(groupAccessHash) : '0',
        };
        const members = [];
        let offset = 0;
        const batchSize = 200;
        let hasMore = true;
        while (hasMore && members.length < limit) {
          const participants = await mtproto.call('channels.getParticipants', {
            channel,
            filter: { _: 'channelParticipantsRecent' },
            offset,
            limit: Math.min(batchSize, limit - members.length),
          });
          for (const user of participants.users) {
            if (!user.bot && user.id) {
              members.push({
                id: user.id,
                accessHash: user.access_hash,
                firstName: user.first_name || '',
                lastName: user.last_name || '',
                username: user.username || '',
              });
            }
          }
          if (participants.users.length < batchSize) hasMore = false;
          offset += batchSize;
        }
        return res.json({ success: true, members, total: members.length });
      }

      case 'addMember': {
        if (!groupId || !userId) return res.status(400).json({ error: 'Group ID and User ID required' });
        const channel = {
          _: 'inputPeerChannel',
          channel_id: Number(groupId),
          access_hash: groupAccessHash ? String(groupAccessHash) : '0',
        };
        const user = {
          _: 'inputPeerUser',
          user_id: Number(userId),
          access_hash: userAccessHash ? String(userAccessHash) : '0',
        };
        try {
          await mtproto.call('channels.inviteToChannel', {
            channel,
            users: [user],
          });
          return res.json({ success: true });
        } catch (err) {
          let errorMsg = err.error_message || err.message;
          let isRestricted = false;
          if (errorMsg.includes('USER_PRIVACY_RESTRICTED')) {
            isRestricted = true;
            errorMsg = 'User privacy settings prevent adding to groups';
          } else if (errorMsg.includes('FLOOD_WAIT')) {
            const wait = errorMsg.match(/\d+/);
            errorMsg = `FLOOD_WAIT_${wait ? wait[0] : 'unknown'}`;
          } else if (errorMsg.includes('PEER_FLOOD')) {
            errorMsg = 'FLOOD_LIMITED';
          }
          return res.status(400).json({ success: false, error: errorMsg, restricted: isRestricted });
        }
      }

      case 'getGroupInfo': {
        if (!groupId) return res.status(400).json({ error: 'Group ID required' });
        const channel = {
          _: 'inputPeerChannel',
          channel_id: Number(groupId),
          access_hash: groupAccessHash ? String(groupAccessHash) : '0',
        };
        const full = await mtproto.call('channels.getFullChannel', { channel });
        let memberCount = 0;
        if (full.fullChat && full.fullChat.participants_count) {
          memberCount = full.fullChat.participants_count;
        } else if (full.fullChat && typeof full.fullChat.participants_count !== 'undefined') {
          memberCount = full.fullChat.participants_count;
        }
        return res.json({ success: true, memberCount });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('MTProto error:', err);
    // Return a clean error message
    const errorMessage = err.error_message || err.message || 'Internal server error';
    return res.status(500).json({ error: errorMessage });
  }
}
