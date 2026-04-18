import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

/**
 * Main serverless function handler for Telegram API operations.
 * Supports: sendCode, signIn, getDialogs, scrapeMembers, addMember, getGroupInfo.
 */
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  // Handle preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('📩 Received request body:', JSON.stringify(req.body, null, 2));

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

  // Validate API credentials
  if (!apiId || !apiHash) {
    return res.status(400).json({ error: 'API ID and API Hash are required' });
  }
  const apiIdNum = Number(apiId);
  if (isNaN(apiIdNum)) {
    return res.status(400).json({ error: 'API ID must be a number' });
  }

  /**
   * Creates and connects a Telegram client.
   * @param {string} session - Optional session string for authenticated client.
   * @returns {Promise<TelegramClient>}
   */
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

  /**
   * Safely disconnects a client if it exists.
   * @param {TelegramClient|null} client
   */
  const safeDisconnect = async (client) => {
    if (client && typeof client.disconnect === 'function') {
      try {
        await client.disconnect();
      } catch (err) {
        console.warn('Disconnect error:', err.message);
      }
    }
  };

  try {
    switch (action) {
      // ---------- SEND VERIFICATION CODE ----------
      case 'sendCode': {
        if (!phone) {
          return res.status(400).json({ error: 'Phone number required' });
        }
        const client = await getClient();
        try {
          const result = await client.sendCode(
            { apiId: apiIdNum, apiHash },
            phone
          );
          console.log(`✅ Code sent to ${phone}, hash: ${result.phone_code_hash}`);
          return res.json({
            success: true,
            phoneCodeHash: result.phone_code_hash,
          });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- SIGN IN WITH CODE (AND OPTIONAL 2FA) ----------
      case 'signIn': {
        console.log(`🔐 signIn called, phoneCodeHash: ${phoneCodeHash}`);
        if (!phone || !code) {
          return res.status(400).json({ error: 'Phone and verification code required' });
        }
        if (!phoneCodeHash) {
          console.error('❌ Missing phoneCodeHash');
          return res.status(400).json({
            error: 'PHONE_CODE_HASH_MISSING',
            message: 'Missing phone_code_hash. Please request a new code via sendCode.',
          });
        }
        const client = await getClient();
        try {
          let authResult;
          if (password) {
            // 2FA enabled
            authResult = await client.signInUserWithPassword(phone, password, {
              phoneCode: code,
            });
          } else {
            authResult = await client.signInUser(phone, code, phoneCodeHash);
          }
          const savedSession = client.session.save();
          console.log('✅ Sign-in successful, session saved');
          return res.json({
            success: true,
            sessionString: savedSession,
          });
        } catch (err) {
          if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
            return res.status(400).json({
              error: '2FA_REQUIRED',
              message: 'Two‑factor authentication password required',
            });
          }
          // Forward other errors (invalid code, expired, etc.)
          return res.status(400).json({ error: err.message });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- FETCH USER'S DIALOGS (GROUPS/CHANNELS) ----------
      case 'getDialogs': {
        if (!sessionString) {
          return res.status(400).json({ error: 'Active session required' });
        }
        const client = await getClient(sessionString);
        try {
          const dialogs = await client.getDialogs();
          const groups = dialogs
            .filter((d) => d.isGroup || d.isChannel)
            .map((d) => ({
              id: d.id.valueOf(),
              accessHash: d.accessHash?.valueOf(),
              title: d.title,
              type: d.isChannel ? 'channel' : 'supergroup',
            }));
          console.log(`📁 Loaded ${groups.length} groups/channels`);
          return res.json({ success: true, dialogs: groups });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- SCRAPE MEMBERS FROM A GROUP/CHANNEL ----------
      case 'scrapeMembers': {
        if (!sessionString || !groupId || !groupAccessHash) {
          return res.status(400).json({ error: 'Missing session, groupId or groupAccessHash' });
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
          console.log(`🕵️ Scraped ${members.length} members from group ${groupId}`);
          return res.json({ success: true, members, total: members.length });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- ADD A SINGLE MEMBER TO A GROUP/CHANNEL ----------
      case 'addMember': {
        if (!sessionString || !groupId || !groupAccessHash || !userId || !userAccessHash) {
          return res.status(400).json({
            error: 'Missing session, groupId, groupAccessHash, userId or userAccessHash',
          });
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
          console.log(`➕ Added user ${userId} to group ${groupId}`);
          return res.json({ success: true });
        } catch (err) {
          // Handle specific Telegram errors gracefully
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
          } else if (errorMsg.includes('USER_ALREADY_PARTICIPANT')) {
            errorMsg = 'User already in group';
          }
          return res.status(400).json({
            success: false,
            error: errorMsg,
            restricted: isRestricted,
          });
        } finally {
          await safeDisconnect(client);
        }
      }

      // ---------- GET GROUP/CHANNEL MEMBER COUNT ----------
      case 'getGroupInfo': {
        if (!sessionString || !groupId || !groupAccessHash) {
          return res.status(400).json({ error: 'Missing session, groupId or groupAccessHash' });
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
            full.fullChat?.participantsCount ||
            full.chats?.[0]?.participantsCount ||
            0;
          console.log(`📊 Group ${groupId} member count: ${memberCount}`);
          return res.json({ success: true, memberCount });
        } finally {
          await safeDisconnect(client);
        }
      }

      default:
        return res.status(400).json({ error: `Invalid action: ${action}` });
    }
  } catch (err) {
    console.error('Unhandled handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
