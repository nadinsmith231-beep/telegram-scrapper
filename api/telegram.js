import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

// Helper: parse combined session (JSON with session and phone_code_hash)
function parseSession(combined) {
  try {
    if (!combined) return { session: '', phone_code_hash: null };
    const parsed = JSON.parse(combined);
    return {
      session: parsed.session || '',
      phone_code_hash: parsed.phone_code_hash || null,
    };
  } catch {
    // Fallback for old format (plain string session)
    return { session: combined, phone_code_hash: null };
  }
}

// Helper: stringify combined session
function stringifySession(sessionStr, phoneCodeHash = null) {
  return JSON.stringify({
    session: sessionStr,
    phone_code_hash: phoneCodeHash,
  });
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

  const apiIdNum = Number(apiId);
  if (isNaN(apiIdNum)) {
    return res.status(400).json({ error: 'API ID must be a number' });
  }

  // Helper to create a GramJS client from a session string
  const getClient = async (sessionStr) => {
    const stringSession = new StringSession(sessionStr || '');
    const client = new TelegramClient(stringSession, apiIdNum, apiHash, {
      connectionRetries: 2,
      useWSS: false, // TCP transport works on Render
      timeout: 30000,
    });
    await client.connect();
    return client;
  };

  try {
    switch (action) {
      case 'sendCode': {
        if (!phone) return res.status(400).json({ error: 'Phone number required' });
        const client = await getClient('');
        try {
          const result = await client.sendCode({ apiId: apiIdNum, apiHash }, phone);
          // result.phone_code_hash is returned
          const newCombinedSession = stringifySession(client.session.save(), result.phone_code_hash);
          await client.disconnect();
          return res.json({ success: true, sessionString: newCombinedSession });
        } catch (err) {
          await client.disconnect();
          return res.status(400).json({ error: err.message });
        }
      }

      case 'signIn': {
        if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
        const { session: savedSession, phone_code_hash } = parseSession(sessionString);
        if (!phone_code_hash) {
          return res.status(400).json({ error: 'Missing phone_code_hash. Please request a new code.' });
        }
        const client = await getClient(savedSession);
        try {
          let result;
          if (password) {
            // 2FA login – you may need to adapt; this example uses standard signIn
            // For 2FA, GramJS provides signInUserWithPassword
            result = await client.signInUserWithPassword(phone, password, { phoneCode: code });
          } else {
            // Regular sign in – we need to use the stored phone_code_hash
            // GramJS's signInUser expects the phone_code_hash
            result = await client.signInUser(phone, code, phone_code_hash);
          }
          const newSession = client.session.save();
          // After successful sign-in, the phone_code_hash is no longer needed; store only session
          const finalSession = stringifySession(newSession, null);
          await client.disconnect();
          return res.json({ success: true, sessionString: finalSession });
        } catch (err) {
          await client.disconnect();
          if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
            return res.status(400).json({ error: '2FA_REQUIRED', message: 'Two‑factor password required' });
          }
          return res.status(400).json({ error: err.message });
        }
      }

      case 'getDialogs': {
        if (!sessionString) return res.status(400).json({ error: 'Session required' });
        const { session: savedSession } = parseSession(sessionString);
        const client = await getClient(savedSession);
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
          await client.disconnect();
          return res.json({ success: true, dialogs: groups });
        } catch (err) {
          await client.disconnect();
          return res.status(400).json({ error: err.message });
        }
      }

      case 'scrapeMembers': {
        if (!sessionString || !groupId || !groupAccessHash) {
          return res.status(400).json({ error: 'Missing parameters' });
        }
        const { session: savedSession } = parseSession(sessionString);
        const client = await getClient(savedSession);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const members = [];
          let offset = 0;
          const batchSize = 200;
          let hasMore = true;
          while (hasMore && members.length < limit) {
            const participants = await client.invoke(
              new Api.channels.GetParticipants({
                channel,
                filter: new Api.ChannelParticipantsRecent(),
                offset,
                limit: Math.min(batchSize, limit - members.length),
              })
            );
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
          await client.disconnect();
          return res.json({ success: true, members, total: members.length });
        } catch (err) {
          await client.disconnect();
          return res.status(400).json({ error: err.message });
        }
      }

      case 'addMember': {
        if (!sessionString || !groupId || !groupAccessHash || !userId || !userAccessHash) {
          return res.status(400).json({ error: 'Missing parameters' });
        }
        const { session: savedSession } = parseSession(sessionString);
        const client = await getClient(savedSession);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const user = { className: 'InputPeerUser', userId: Number(userId), accessHash: String(userAccessHash) };
          await client.invoke(new Api.channels.InviteToChannel({ channel, users: [user] }));
          await client.disconnect();
          return res.json({ success: true });
        } catch (err) {
          await client.disconnect();
          let errorMsg = err.message;
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
        if (!sessionString || !groupId || !groupAccessHash) {
          return res.status(400).json({ error: 'Missing parameters' });
        }
        const { session: savedSession } = parseSession(sessionString);
        const client = await getClient(savedSession);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
          let memberCount = 0;
          if (full.fullChat && full.fullChat.participantsCount) memberCount = full.fullChat.participantsCount;
          else if (full.chats && full.chats[0] && full.chats[0].participantsCount) memberCount = full.chats[0].participantsCount;
          await client.disconnect();
          return res.json({ success: true, memberCount });
        } catch (err) {
          await client.disconnect();
          return res.status(400).json({ error: err.message });
        }
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
