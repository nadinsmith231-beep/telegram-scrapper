import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  console.log('📩 Incoming body:', JSON.stringify(req.body, null, 2));

  const {
    action,
    apiId,
    apiHash,
    phone,
    code,
    password,
    sessionString,
    phoneCodeHash,
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

  const getClient = async (session = '') => {
    const stringSession = new StringSession(session);
    const client = new TelegramClient(stringSession, apiIdNum, apiHash, {
      connectionRetries: 2,
      useWSS: false,
      timeout: 30000,
    });
    await client.connect();
    return client;
  };

  const safeDisconnect = async (client) => {
    if (client && typeof client.disconnect === 'function') {
      try {
        await client.disconnect();
      } catch (e) {
        console.warn('Disconnect error:', e.message);
      }
    }
  };

  try {
    switch (action) {
      case 'sendCode': {
        if (!phone) return res.status(400).json({ error: 'Phone number required' });
        const client = await getClient();
        try {
          const result = await client.sendCode({ apiId: apiIdNum, apiHash }, phone);
          const hash = result.phone_code_hash || result.phoneCodeHash;
          if (!hash) throw new Error('No phone code hash received');
          console.log(`✅ Code sent, hash: ${hash}`);
          return res.json({ success: true, phoneCodeHash: hash });
        } catch (err) {
          console.error('sendCode error:', err);
          return res.status(400).json({ error: err.message });
        } finally {
          await safeDisconnect(client);
        }
      }

      case 'signIn': {
        if (!phone || !code) {
          return res.status(400).json({ error: 'Phone and verification code required' });
        }
        if (!phoneCodeHash) {
          return res.status(400).json({ error: 'PHONE_CODE_HASH_MISSING', message: 'Missing hash. Request a new code.' });
        }
        console.log(`🔐 signIn for ${phone}, hash: ${phoneCodeHash}`);
        
        // Create client WITHOUT session (new login)
        const client = await getClient();
        try {
          // First, check if we already have a password (2FA) or not
          let authResult;
          if (password) {
            // 2FA case: use signInUserWithPassword
            authResult = await client.signInUserWithPassword(phone, password, {
              phoneCode: code,
              phoneCodeHash: phoneCodeHash,
            });
          } else {
            // Normal case: use signInUser with phoneCodeHash
            authResult = await client.signInUser(phone, code, phoneCodeHash);
          }
          
          // Save the session string
          const savedSession = client.session.save();
          console.log('✅ Sign-in successful, session saved');
          await safeDisconnect(client);
          return res.json({ success: true, sessionString: savedSession });
        } catch (err) {
          console.error('signIn error:', err);
          await safeDisconnect(client);
          
          // Handle 2FA required error (sometimes thrown even if we didn't call with password)
          if (err.message.includes('SESSION_PASSWORD_NEEDED') || err.message.includes('PASSWORD_HASH_INVALID')) {
            return res.status(400).json({ error: '2FA_REQUIRED', message: '2FA password required' });
          }
          return res.status(400).json({ error: err.message });
        }
      }

      // ----- All other actions remain the same as before -----
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

      case 'scrapeMembers': {
        if (!sessionString || !groupId || !groupAccessHash) {
          return res.status(400).json({ error: 'Missing parameters' });
        }
        const client = await getClient(sessionString);
        try {
          const channel = {
            className: 'InputPeerChannel',
            channelId: Number(groupId),
            accessHash: String(groupAccessHash),
          };
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
          return res.json({ success: true, members, total: members.length });
        } finally {
          await safeDisconnect(client);
        }
      }

      case 'addMember': {
        if (!sessionString || !groupId || !groupAccessHash || !userId || !userAccessHash) {
          return res.status(400).json({ error: 'Missing parameters' });
        }
        const client = await getClient(sessionString);
        try {
          const channel = {
            className: 'InputPeerChannel',
            channelId: Number(groupId),
            accessHash: String(groupAccessHash),
          };
          const user = {
            className: 'InputPeerUser',
            userId: Number(userId),
            accessHash: String(userAccessHash),
          };
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
            const waitSeconds = waitMatch ? waitMatch[0] : 'unknown';
            errorMsg = `FLOOD_WAIT_${waitSeconds}`;
          } else if (errorMsg.includes('PEER_FLOOD')) {
            errorMsg = 'FLOOD_LIMITED';
          }
          return res.status(400).json({ success: false, error: errorMsg, restricted: isRestricted });
        } finally {
          await safeDisconnect(client);
        }
      }

      case 'getGroupInfo': {
        if (!sessionString || !groupId || !groupAccessHash) {
          return res.status(400).json({ error: 'Missing parameters' });
        }
        const client = await getClient(sessionString);
        try {
          const channel = {
            className: 'InputPeerChannel',
            channelId: Number(groupId),
            accessHash: String(groupAccessHash),
          };
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
          const memberCount =
            full.fullChat?.participantsCount || full.chats?.[0]?.participantsCount || 0;
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
