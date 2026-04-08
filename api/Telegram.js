import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

// Helper to create client
async function getClient(apiId, apiHash, sessionString) {
  const stringSession = new StringSession(sessionString || '');
  const client = new TelegramClient(stringSession, Number(apiId), apiHash, {
    connectionRetries: 5,
    useWSS: true,
  });
  await client.connect();
  return { client, stringSession };
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { action, apiId, apiHash, phone, code, password, sessionString, groupId, groupAccessHash, userId, userAccessHash, limit = 500 } = req.body;
  
  try {
    // Validate required fields based on action
    if (!apiId || !apiHash) {
      return res.status(400).json({ error: 'API ID and Hash are required' });
    }
    
    switch (action) {
      case 'sendCode': {
        if (!phone) return res.status(400).json({ error: 'Phone required' });
        const { client } = await getClient(apiId, apiHash, '');
        try {
          await client.sendCode({ apiId: Number(apiId), apiHash }, phone);
          await client.disconnect();
          return res.json({ success: true, message: 'Code sent' });
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }
      
      case 'signIn': {
        if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });
        const { client, stringSession } = await getClient(apiId, apiHash, '');
        try {
          let result;
          if (password) {
            result = await client.signInUserWithPassword(phone, password, { phoneCode: code });
          } else {
            result = await client.signInUser(phone, code);
          }
          const newSession = stringSession.save();
          await client.disconnect();
          return res.json({ success: true, sessionString: newSession });
        } catch (err) {
          await client.disconnect();
          if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
            return res.status(400).json({ error: '2FA_REQUIRED', message: '2FA password required' });
          }
          return res.status(400).json({ error: err.message });
        }
      }
      
      case 'getDialogs': {
        if (!sessionString) return res.status(400).json({ error: 'Session required' });
        const { client } = await getClient(apiId, apiHash, sessionString);
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
        const { client } = await getClient(apiId, apiHash, sessionString);
        try {
          const entity = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const members = [];
          let offset = 0;
          const batchSize = 200;
          let hasMore = true;
          
          while (hasMore && members.length < limit) {
            const participants = await client.invoke(
              new Api.channels.GetParticipants({
                channel: entity,
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
        const { client } = await getClient(apiId, apiHash, sessionString);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const user = { className: 'InputPeerUser', userId: Number(userId), accessHash: String(userAccessHash) };
          
          const result = await client.invoke(
            new Api.channels.InviteToChannel({
              channel,
              users: [user],
            })
          );
          await client.disconnect();
          return res.json({ success: true, result });
        } catch (err) {
          await client.disconnect();
          let errorMsg = err.message;
          let isRestricted = false;
          if (errorMsg.includes('USER_PRIVACY_RESTRICTED')) {
            isRestricted = true;
            errorMsg = 'User has privacy settings that prevent adding to groups';
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
        const { client } = await getClient(apiId, apiHash, sessionString);
        try {
          const channel = { className: 'InputPeerChannel', channelId: Number(groupId), accessHash: String(groupAccessHash) };
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
          const memberCount = full.fullChat.participantsCount || 0;
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
    console.error('API Error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
