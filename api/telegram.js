import MTProto from '@mtproto/core';

// Simple synchronous storage (works in serverless)
class MemoryStorage {
  constructor(initialData = {}) {
    this.data = { ...initialData };
  }
  set(key, value) {
    this.data[key] = value;
  }
  get(key) {
    return this.data[key];
  }
  getAll() {
    return this.data;
  }
  save() {
    return JSON.stringify(this.data);
  }
  static load(jsonString) {
    try {
      const data = JSON.parse(jsonString || '{}');
      return new MemoryStorage(data);
    } catch {
      return new MemoryStorage({});
    }
  }
}

export default async function handler(req, res) {
  // CORS and JSON headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  // Convert apiId to number, validate
  const apiIdNum = Number(apiId);
  if (isNaN(apiIdNum)) {
    return res.status(400).json({ error: 'API ID must be a number' });
  }

  // Restore session from frontend
  const storage = MemoryStorage.load(sessionString);
  let mtproto;

  try {
    // Create MTProto instance with a clean storage adapter
    mtproto = new MTProto({
      api_id: apiIdNum,
      api_hash: apiHash,
      storage: {
        set: (key, value) => storage.set(key, value),
        get: (key) => storage.get(key),
      },
    });
  } catch (err) {
    console.error('MTProto instantiation error:', err);
    return res.status(500).json({
      error: 'MTProto initialization failed',
      details: err.message,
    });
  }

  try {
    switch (action) {
      case 'sendCode': {
        if (!phone) return res.status(400).json({ error: 'Phone number required' });
        console.log(`Sending code to ${phone}...`);
        const result = await mtproto.call('auth.sendCode', {
          phone_number: phone,
          settings: { _: 'codeSettings' },
        });
        storage.set('phone_code_hash', result.phone_code_hash);
        const newSessionString = storage.save();
        console.log('Code sent successfully');
        return res.json({ success: true, sessionString: newSessionString });
      }

      case 'signIn': {
        if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
        const phone_code_hash = storage.get('phone_code_hash');
        if (!phone_code_hash) {
          return res.status(400).json({ error: 'No active code. Please request a new one.' });
        }
        try {
          await mtproto.call('auth.signIn', {
            phone_number: phone,
            phone_code: code,
            phone_code_hash,
          });
          const newSessionString = storage.save();
          return res.json({ success: true, sessionString: newSessionString });
        } catch (err) {
          if (err.error_message === 'SESSION_PASSWORD_NEEDED') {
            return res.status(400).json({ error: '2FA_REQUIRED', message: 'Two‑factor password required' });
          }
          throw err;
        }
      }

      case 'getDialogs': {
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
          await mtproto.call('channels.inviteToChannel', { channel, users: [user] });
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
        }
        return res.json({ success: true, memberCount });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('MTProto call error:', err);
    const errorMessage = err.error_message || err.message || 'Internal server error';
    return res.status(500).json({ error: errorMessage });
  }
}
