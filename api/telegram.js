// ======================= CONFIGURATION =======================
const API_BASE = '/api/telegram';

// DOM Elements (same as before)
const apiIdInput = document.getElementById('apiId');
const apiHashInput = document.getElementById('apiHash');
const phoneInput = document.getElementById('phoneNumber');
const codeSection = document.getElementById('codeSection');
const verificationCodeInput = document.getElementById('verificationCode');
const twoFactorInput = document.getElementById('twoFactorPassword');
const loginBtn = document.getElementById('loginBtn');
const verifyBtn = document.getElementById('verifyBtn');
const resendCodeBtn = document.getElementById('resendCodeBtn');
const sessionStatusDiv = document.getElementById('sessionStatus');
const logoutBtn = document.getElementById('logoutSessionBtn');
const fetchGroupsBtn = document.getElementById('fetchGroupsBtn');
const sourceGroupSelect = document.getElementById('sourceGroupSelect');
const targetGroupSelect = document.getElementById('targetGroupSelect');
const startScrapeAddBtn = document.getElementById('startScrapeAddBtn');
const stopProcessBtn = document.getElementById('stopProcessBtn');
const scrapedCountSpan = document.getElementById('scrapedCount');
const addedCountSpan = document.getElementById('addedCount');
const processStatusSpan = document.getElementById('processStatus');
const logContainer = document.getElementById('logContainer');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const membersPreviewDiv = document.getElementById('membersPreview');
const totalMembersBadge = document.getElementById('totalMembersBadge');
const addDelayInput = document.getElementById('addDelaySec');
const progressFill = document.getElementById('progressFill');

// ======================= GLOBAL STATE =======================
let sessionString = localStorage.getItem('tg_session') || '';
let scrapedMembers = [];
let isAddingActive = false;
let stopRequested = false;
let addedCounter = 0;
let currentGroupMemberCountBefore = 0;
let batchAddCount = 0;
let currentPhoneCodeHash = null;

// ======================= HELPER FUNCTIONS =======================
function addLog(msg, type = 'info') {
    const logDiv = document.createElement('div');
    const timestamp = new Date().toLocaleTimeString();
    let colorClass = 'text-gray-300';
    if (type === 'error') colorClass = 'text-red-400';
    else if (type === 'success') colorClass = 'text-green-400';
    else if (type === 'warning') colorClass = 'text-yellow-400';
    else if (type === 'info') colorClass = 'text-cyan-300';
    logDiv.innerHTML = `<span class="text-gray-500">[${timestamp}]</span> <span class="${colorClass}">${msg}</span>`;
    logContainer.appendChild(logDiv);
    logDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearLogs() {
    logContainer.innerHTML = '<div class="text-gray-500">✨ Logs cleared.</div>';
}
clearLogsBtn.onclick = clearLogs;

function updateProgress(added, total) {
    const percent = total > 0 ? (added / total) * 100 : 0;
    progressFill.style.width = `${percent}%`;
}

function updateMemberPreview(members) {
    totalMembersBadge.innerText = members.length;
    scrapedCountSpan.innerText = members.length;
    if (members.length === 0) {
        membersPreviewDiv.innerHTML = '<div class="text-gray-500 italic p-2">No members scraped.</div>';
        return;
    }
    const previewHtml = members.slice(0, 100).map(m => 
        `<div class="p-1 text-gray-300"><i class="fab fa-telegram-plane text-blue-400 mr-1"></i> ${m.firstName || m.first_name || 'User'} ${m.username ? '@'+m.username : ''}</div>`
    ).join('');
    membersPreviewDiv.innerHTML = previewHtml + (members.length > 100 ? `<div class="text-gray-500 text-center p-1">... and ${members.length-100} more</div>` : '');
}

// Core API caller with detailed logging
async function callApi(action, payload = {}) {
    const apiId = apiIdInput.value.trim();
    const apiHash = apiHashInput.value.trim();
    const phone = phoneInput.value.trim();
    
    const body = {
        action,
        apiId,
        apiHash,
        phone,
        sessionString,
        ...payload
    };
    
    if (action === 'signIn' && currentPhoneCodeHash) {
        body.phoneCodeHash = currentPhoneCodeHash;
    }
    
    try {
        const response = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        console.log(`[callApi] ${action} response:`, data);
        
        if (!response.ok) {
            throw new Error(data.error || data.message || `HTTP ${response.status}`);
        }
        return data;
    } catch (err) {
        addLog(`API Error (${action}): ${err.message}`, 'error');
        throw err;
    }
}

function showResendButton() {
    resendCodeBtn.classList.remove('hidden');
}
function hideResendButton() {
    resendCodeBtn.classList.add('hidden');
}

// ======================= TEST BACKEND VERSION =======================
async function testBackendVersion() {
    try {
        const response = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'ping', apiId: '1', apiHash: 'test' })
        });
        const data = await response.json();
        if (data.version === '2.0.0') {
            addLog('✅ Backend is up-to-date (version 2.0.0)', 'success');
        } else {
            addLog(`⚠️ Backend version mismatch: ${JSON.stringify(data)}. Please restart server.`, 'warning');
        }
    } catch (err) {
        addLog(`Could not test backend: ${err.message}`, 'error');
    }
}

// ======================= AUTHENTICATION FLOW =======================
loginBtn.onclick = async () => {
    const apiId = apiIdInput.value.trim();
    const apiHash = apiHashInput.value.trim();
    const phone = phoneInput.value.trim();
    if (!apiId || !apiHash || !phone) {
        addLog('❌ Please fill API ID, API Hash and Phone number', 'error');
        return;
    }
    addLog(`📲 Sending verification code to ${phone}...`, 'info');
    try {
        const result = await callApi('sendCode');
        // Accept both camelCase and snake_case
        const hash = result.phoneCodeHash || result.phone_code_hash;
        if (hash) {
            currentPhoneCodeHash = hash;
            addLog(`✅ Code sent! Check your Telegram app.`, 'success');
            codeSection.classList.remove('hidden');
            verifyBtn.classList.remove('hidden');
            loginBtn.classList.add('hidden');
            showResendButton();
            verificationCodeInput.value = '';
            twoFactorInput.value = '';
            twoFactorInput.classList.remove('border-yellow-500');
        } else {
            addLog(`⚠️ Unexpected response: missing phoneCodeHash. Full response: ${JSON.stringify(result)}`, 'error');
            console.error('Full sendCode response:', result);
        }
    } catch (err) {
        addLog(`Failed to send code: ${err.message}`, 'error');
    }
};

verifyBtn.onclick = async () => {
    const code = verificationCodeInput.value.trim();
    const password = twoFactorInput.value;
    if (!code) { addLog('Enter verification code', 'warning'); return; }
    if (!currentPhoneCodeHash) {
        addLog('⚠️ Missing code hash. Please request a new code using "Resend Code".', 'error');
        showResendButton();
        return;
    }
    addLog(`🔐 Verifying code...`, 'info');
    try {
        const result = await callApi('signIn', { code, password: password || undefined });
        if (result.sessionString) {
            sessionString = result.sessionString;
            localStorage.setItem('tg_session', sessionString);
            localStorage.setItem('tg_api_id', apiIdInput.value);
            localStorage.setItem('tg_api_hash', apiHashInput.value);
            localStorage.setItem('tg_phone', phoneInput.value);
            sessionStatusDiv.classList.remove('hidden');
            sessionStatusDiv.innerHTML = `<i class="fas fa-check-circle text-green-400 mr-1"></i> Authenticated & session active`;
            logoutBtn.classList.remove('hidden');
            startScrapeAddBtn.disabled = false;
            addLog(`🎉 Login successful! You can now load groups.`, 'success');
            codeSection.classList.add('hidden');
            verifyBtn.classList.add('hidden');
            loginBtn.classList.remove('hidden');
            hideResendButton();
            currentPhoneCodeHash = null;
            await loadUserGroups();
        }
    } catch (err) {
        if (err.message.includes('2FA_REQUIRED')) {
            addLog(`2FA required. Please enter your two-factor password.`, 'warning');
            twoFactorInput.classList.add('border-yellow-500');
        } else if (err.message.includes('PHONE_CODE_EXPIRED') || err.message.includes('Invalid code')) {
            addLog(`Code expired or invalid. Please request a new code.`, 'error');
            showResendButton();
        } else {
            addLog(`Verification failed: ${err.message}`, 'error');
        }
    }
};

resendCodeBtn.onclick = async () => {
    const phone = phoneInput.value.trim();
    if (!phone) {
        addLog('Phone number missing', 'error');
        return;
    }
    addLog(`⟳ Requesting new verification code for ${phone}...`, 'info');
    try {
        const result = await callApi('sendCode');
        const hash = result.phoneCodeHash || result.phone_code_hash;
        if (hash) {
            currentPhoneCodeHash = hash;
            addLog(`✅ New code sent!`, 'success');
            verificationCodeInput.value = '';
            twoFactorInput.value = '';
            twoFactorInput.classList.remove('border-yellow-500');
            showResendButton();
        } else {
            addLog(`Failed: no phoneCodeHash in response. Full: ${JSON.stringify(result)}`, 'error');
        }
    } catch (err) {
        addLog(`Resend failed: ${err.message}`, 'error');
    }
};

logoutBtn.onclick = () => {
    sessionString = '';
    currentPhoneCodeHash = null;
    localStorage.removeItem('tg_session');
    localStorage.removeItem('tg_api_id');
    localStorage.removeItem('tg_api_hash');
    localStorage.removeItem('tg_phone');
    sessionStatusDiv.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    startScrapeAddBtn.disabled = true;
    codeSection.classList.add('hidden');
    verifyBtn.classList.add('hidden');
    loginBtn.classList.remove('hidden');
    hideResendButton();
    sourceGroupSelect.innerHTML = '<option>-- Login first --</option>';
    targetGroupSelect.innerHTML = '<option>-- Login first --</option>';
    addLog('Session cleared.', 'info');
};

// ======================= GROUP MANAGEMENT =======================
async function loadUserGroups() {
    if (!sessionString) { addLog('No active session', 'error'); return; }
    addLog('Fetching your groups & channels...', 'info');
    try {
        const result = await callApi('getDialogs');
        if (result.dialogs && result.dialogs.length) {
            sourceGroupSelect.innerHTML = '<option value="">-- Select source group --</option>';
            targetGroupSelect.innerHTML = '<option value="">-- Select target group --</option>';
            result.dialogs.forEach(d => {
                const option = `<option value='${JSON.stringify({ id: d.id, accessHash: d.accessHash, title: d.title, type: d.type })}'>${d.title} (${d.type})</option>`;
                sourceGroupSelect.innerHTML += option;
                targetGroupSelect.innerHTML += option;
            });
            addLog(`Loaded ${result.dialogs.length} groups/channels`, 'success');
        } else {
            addLog('No groups found', 'warning');
        }
    } catch (err) {
        addLog(`Failed to load groups: ${err.message}`, 'error');
    }
}

fetchGroupsBtn.onclick = loadUserGroups;

async function scrapeMembersFromSource(sourceObj) {
    addLog(`🕵️ Scraping members from ${sourceObj.title}... (this may take a moment)`, 'info');
    try {
        const result = await callApi('scrapeMembers', {
            groupId: sourceObj.id,
            groupAccessHash: sourceObj.accessHash,
            limit: 500
        });
        if (result.members) {
            addLog(`✅ Scraped ${result.members.length} members`, 'success');
            return result.members;
        }
        return [];
    } catch (err) {
        addLog(`Scraping error: ${err.message}`, 'error');
        return [];
    }
}

async function getGroupMemberCount(groupObj) {
    try {
        const result = await callApi('getGroupInfo', {
            groupId: groupObj.id,
            groupAccessHash: groupObj.accessHash
        });
        return result.memberCount;
    } catch (err) {
        addLog(`Could not fetch member count: ${err.message}`, 'warning');
        return -1;
    }
}

async function addSingleMember(userId, accessHash, groupObj) {
    try {
        const result = await callApi('addMember', {
            groupId: groupObj.id,
            groupAccessHash: groupObj.accessHash,
            userId: userId,
            userAccessHash: accessHash
        });
        return result;
    } catch (err) {
        if (err.message.includes('FLOOD_WAIT')) {
            const waitMatch = err.message.match(/\d+/);
            const waitTime = waitMatch ? parseInt(waitMatch[0]) : 60;
            addLog(`⏳ Flood wait: ${waitTime} seconds`, 'warning');
            await new Promise(r => setTimeout(r, waitTime * 1000));
            return { success: false, error: 'FLOOD_WAIT', retry: true };
        }
        return { success: false, error: err.message };
    }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function startScrapeAndAdd() {
    if (!sessionString) { addLog('No active session, login first', 'error'); return; }
    const sourceRaw = sourceGroupSelect.value;
    const targetRaw = targetGroupSelect.value;
    if (!sourceRaw || !targetRaw) { addLog('Select both source and target groups', 'warning'); return; }
    const sourceObj = JSON.parse(sourceRaw);
    const targetObj = JSON.parse(targetRaw);
    const addDelay = parseInt(addDelayInput.value);
    if (isNaN(addDelay) || addDelay < 10) { addLog('Delay must be at least 10 seconds', 'error'); return; }
    
    stopRequested = false;
    isAddingActive = true;
    startScrapeAddBtn.classList.add('hidden');
    stopProcessBtn.classList.remove('hidden');
    processStatusSpan.innerText = 'Scraping...';
    updateProgress(0, 1);
    
    try {
        const members = await scrapeMembersFromSource(sourceObj);
        if (stopRequested) throw new Error('Process interrupted');
        if (members.length === 0) throw new Error('No members found');
        
        scrapedMembers = members;
        updateMemberPreview(scrapedMembers);
        addedCounter = 0;
        addedCountSpan.innerText = '0';
        batchAddCount = 0;
        
        currentGroupMemberCountBefore = await getGroupMemberCount(targetObj);
        if (currentGroupMemberCountBefore !== -1) {
            addLog(`📊 Target group member count: ${currentGroupMemberCountBefore}`, 'info');
        }
        
        processStatusSpan.innerText = 'Adding members...';
        
        for (let i = 0; i < scrapedMembers.length; i++) {
            if (stopRequested) break;
            const member = scrapedMembers[i];
            addLog(`➕ Adding: ${member.firstName || 'User'} (${i+1}/${scrapedMembers.length})`, 'info');
            
            const addResp = await addSingleMember(member.id, member.accessHash, targetObj);
            if (addResp.success) {
                addedCounter++;
                addedCountSpan.innerText = addedCounter;
                batchAddCount++;
                addLog(`✅ Added successfully (${addedCounter} total)`, 'success');
                updateProgress(addedCounter, scrapedMembers.length);
            } else {
                if (addResp.restricted) {
                    addLog(`⚠️ Privacy restriction: ${addResp.error}. Cannot add this user.`, 'warning');
                } else if (addResp.error.includes('FLOOD')) {
                    addLog(`🚫 Flood limit reached. Stopping process to avoid ban.`, 'error');
                    break;
                } else {
                    addLog(`❌ Failed: ${addResp.error}`, 'error');
                }
            }
            
            if (batchAddCount >= 20 && currentGroupMemberCountBefore !== -1) {
                const newCount = await getGroupMemberCount(targetObj);
                addLog(`🔍 Member count: before=${currentGroupMemberCountBefore}, now=${newCount}`, 'info');
                if (newCount - currentGroupMemberCountBefore < 20) {
                    addLog(`⚠️ Many users may have privacy restrictions preventing addition.`, 'warning');
                }
                currentGroupMemberCountBefore = newCount;
                batchAddCount = 0;
            }
            
            await delay(addDelay * 1000);
        }
        
        if (!stopRequested) addLog(`🎉 Completed! Added ${addedCounter} members.`, 'success');
        else addLog(`Process stopped early.`, 'warning');
    } catch (err) {
        addLog(`Critical error: ${err.message}`, 'error');
    } finally {
        isAddingActive = false;
        startScrapeAddBtn.classList.remove('hidden');
        stopProcessBtn.classList.add('hidden');
        processStatusSpan.innerText = 'Idle';
        stopRequested = false;
    }
}

stopProcessBtn.onclick = () => {
    stopRequested = true;
    addLog('🛑 Stopping process...', 'warning');
};

startScrapeAddBtn.onclick = startScrapeAndAdd;

// ======================= RESTORE SESSION & TEST BACKEND =======================
if (sessionString) {
    const savedApiId = localStorage.getItem('tg_api_id');
    const savedApiHash = localStorage.getItem('tg_api_hash');
    const savedPhone = localStorage.getItem('tg_phone');
    if (savedApiId) apiIdInput.value = savedApiId;
    if (savedApiHash) apiHashInput.value = savedApiHash;
    if (savedPhone) phoneInput.value = savedPhone;
    sessionStatusDiv.classList.remove('hidden');
    sessionStatusDiv.innerHTML = `<i class="fas fa-check-circle text-green-400 mr-1"></i> Session restored`;
    logoutBtn.classList.remove('hidden');
    startScrapeAddBtn.disabled = false;
    addLog('🔁 Session restored. Click "Load my groups" to continue.', 'info');
}


testBackendVersion();
