import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

// Helper to encode session data (authKey + phone_code_hash) into a single string
function encodeSession(authKey = '', phoneCodeHash = '') {
  const data = { authKey, phoneCodeHash };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

function decodeSession(sessionString) {
  if (!sessionString) return { authKey: '', phoneCodeHash: '' };
  try {
    const json = Buffer.from(sessionString, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return { authKey: sessionString, phoneCodeHash: '' };
  }
}

export default async function handler(req, res) {
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
    sessionString,   // this now carries both authKey and temporary hash
    groupId,
    groupAccessHash,
    userId,
    userAccessHash,
    limit = 500,
  } = req.body;

  if (!apiId || !apiHash) return res.status(400).json({ error: 'API ID and API Hash are required' });
  const apiIdNum = Number(apiId);
  if (isNaN(apiIdNum)) return res.status(400).json({ error: 'API ID must be a number' });

  const getClient = async (authKey = '') => {
    const stringSession = new StringSession(authKey);
    const client = new TelegramClient(stringSession, apiIdNum, apiHash, {
      connectionRetries: 2,
      useWSS: false,
      timeout: 30000,
    });
    await client.connect();
    return client;
  };

  try {
    switch (action) {
      case 'sendCode': {
        if (!phone) return res.status(400).json({ error: 'Phone number required' });
        const client = await getClient();
        try {
          const result = await client.sendCode({ apiId: apiIdNum, apiHash }, phone);
          await client.disconnect();
          // Store the hash in a new session string (authKey is empty for now)
          const newSession = encodeSession('', result.phone_code_hash);
          return res.json({ success: true, sessionString: newSession });
        } catch (err) {
          await client.disconnect();
          return res.status(400).json({ error: err.message });
        }
      }

      case 'signIn': {
        if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
        const { authKey, phoneCodeHash } = decodeSession(sessionString);
        if (!phoneCodeHash) {
          return res.status(400).json({ error: 'Missing phone_code_hash. Please request a new code.' });
        }
        const client = await getClient(authKey);
        try {
          let result;
          if (password) {
            result = await client.signInUserWithPassword(phone, password, { phoneCode: code });
          } else {
            result = await client.signInUser(phone, code, phoneCodeHash);
          }
          const newAuthKey = client.session.save();
          await client.disconnect();
          // After successful login, return a session string that contains only the authKey
          const finalSession = encodeSession(newAuthKey, '');
          return res.json({ success: true, sessionString: finalSession });
        } catch (err) {
          await client.disconnect();
          if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
            return res.status(400).json({ error: '2FA_REQUIRED', message: '2FA password required' });
          }
          return res.status(400).json({ error: err.message });
        }
      }

      // -------- all other actions remain unchanged, using sessionString as is ---------
      case 'getDialogs': {
        if (!sessionString) return res.status(400).json({ error: 'Session required' });
        const { authKey } = decodeSession(sessionString);
        const client = await getClient(authKey);
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
        if (!sessionString || !groupId || !groupAccessHash) return res.status(400).json({ error: 'Missing parameters' });
        const { authKey } = decodeSession(sessionString);
        const client = await getClient(authKey);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const members = [];
          let offset = 0, batchSize = 200, hasMore = true;
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
        const { authKey } = decodeSession(sessionString);
        const client = await getClient(authKey);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const user = { className: 'InputPeerUser', userId: Number(userId), accessHash: String(userAccessHash) };
          await client.invoke(new Api.channels.InviteToChannel({ channel, users: [user] }));
          await client.disconnect();
          return res.json({ success: true });
        } catch (err) {
          await client.disconnect();
          let errorMsg = err.message, isRestricted = false;
          if (errorMsg.includes('USER_PRIVACY_RESTRICTED')) { isRestricted = true; errorMsg = 'User privacy settings prevent adding to groups'; }
          else if (errorMsg.includes('FLOOD_WAIT')) { const wait = errorMsg.match(/\d+/); errorMsg = `FLOOD_WAIT_${wait ? wait[0] : 'unknown'}`; }
          else if (errorMsg.includes('PEER_FLOOD')) errorMsg = 'FLOOD_LIMITED';
          return res.status(400).json({ success: false, error: errorMsg, restricted: isRestricted });
        }
      }

      case 'getGroupInfo': {
        if (!sessionString || !groupId || !groupAccessHash) return res.status(400).json({ error: 'Missing parameters' });
        const { authKey } = decodeSession(sessionString);
        const client = await getClient(authKey);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
          let memberCount = full.fullChat?.participantsCount || full.chats?.[0]?.participantsCount || 0;
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
