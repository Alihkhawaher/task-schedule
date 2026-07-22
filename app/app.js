// Task Schedule App - V7 (Calendar View, Per-User Tasks)
// No server needed — data syncs peer-to-peer

// Auth check — restore session from localStorage if sessionStorage is empty
let familyCode = sessionStorage.getItem('familyCode');
let memberName = sessionStorage.getItem('memberName');
let familyName = sessionStorage.getItem('familyName');

if (!familyCode) {
    const storedData = localStorage.getItem('taskSchedule_lastSession');
    if (storedData) {
        try {
            const session = JSON.parse(storedData);
            const maxAge = 30 * 24 * 60 * 60 * 1000;
            if (session.familyCode && session.memberName && session.timestamp && (Date.now() - session.timestamp) < maxAge) {
                sessionStorage.setItem('familyCode', session.familyCode);
                sessionStorage.setItem('memberName', session.memberName);
                sessionStorage.setItem('familyName', session.familyName || '');
                familyCode = session.familyCode;
                memberName = session.memberName;
                familyName = session.familyName || '';
            } else if (session.familyCode && session.memberName && !session.timestamp) {
                sessionStorage.setItem('familyCode', session.familyCode);
                sessionStorage.setItem('memberName', session.memberName);
                sessionStorage.setItem('familyName', session.familyName || '');
                familyCode = session.familyCode;
                memberName = session.memberName;
                familyName = session.familyName || '';
            }
        } catch (e) { console.warn('[App] Failed to restore session:', e); }
    }
}

if (!familyCode) { window.location.href = '../index.html'; }

if (familyCode && memberName) {
    try {
        localStorage.setItem('taskSchedule_lastSession', JSON.stringify({
            familyCode, memberName, familyName: familyName || '', timestamp: Date.now()
        }));
    } catch (e) {}
}

// Simple hash function
async function hashPin(pin) {
    const encoder = new TextEncoder();
    const data = encoder.encode(pin + 'task-schedule-salt');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Gun.js setup
const gun = Gun({ peers: [], localStorage: true });
const family = gun.get('families').get(familyCode);
const usersNode = family.get('members');
const tasksNode = family.get('tasks');
const completionsNode = family.get('completions');

// Local caches
let localUsers = {};
let localTasks = {};
let localCompletions = {};

// localStorage persistence
const STORAGE_KEY = 'taskSchedule_' + familyCode;

function saveToLocal() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            users: localUsers, tasks: localTasks, completions: localCompletions, timestamp: Date.now()
        }));
    } catch (e) { console.warn('localStorage save failed:', e); }
}

function loadFromLocal() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (data.users) localUsers = data.users;
            if (data.tasks) localTasks = data.tasks;
            if (data.completions) localCompletions = data.completions;
            return true;
        }
    } catch (e) { console.warn('localStorage load failed:', e); }
    return false;
}

// Calendar state
let calYear, calMonth, calView = 'month'; // 'month' | 'week'
let weekStartDay; // day-of-month for Sunday of current week

// PIN grace period
let pinGracePeriod = 60 * 1000;
let lastPinVerification = 0;
let schedulerStartDate = null;

// Arabic day names
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

// Helpers
function escapeHtml(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
function dateKey(y, m, d) { return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }

// Init
$(document).ready(function() {
    moment.locale('ar');

    const today = new Date();
    calYear = today.getFullYear();
    calMonth = today.getMonth();
    weekStartDay = today.getDate() - today.getDay(); // Sunday of current week

    loadFromLocal();

    // Gun.js listeners
    family.get('members').map().on((data, id) => { if (data && data.name) { localUsers[id] = data; saveToLocal(); } });
    tasksNode.map().on((data, id) => { if (data && data.name) { localTasks[id] = data; saveToLocal(); } });
    completionsNode.map().on((data, id) => { if (data) { localCompletions[id] = data; saveToLocal(); } });

    family.get('settings').once((settings) => {
        if (settings) {
            if (settings.pinGracePeriod) pinGracePeriod = settings.pinGracePeriod * 60 * 1000;
            if (settings.startDate) schedulerStartDate = settings.startDate;
        }
    });

    // Render
    setTimeout(() => { renderCalendar(); }, 200);
    setTimeout(() => { renderCalendar(); }, 2000);

    // Toolbar events
    $('#btnPrev').click(() => { navigate(-1); });
    $('#btnNext').click(() => { navigate(1); });
    $('#btnToday').click(() => { goToday(); });
    $('#btnMonth').click(() => { setView('month'); });
    $('#btnWeek').click(() => { setView('week'); });

    // Settings
    $('#btnOpenSettings').click(() => { openSettings(); });
    $('#btnCloseSettings').click(() => { closeSettings(); });
    $('#settingsBackdrop').click(() => { closeSettings(); });

    // DOW picker toggle
    $('#taskDaysPicker').on('click', '.dow-pick', function() { $(this).toggleClass('selected'); });
});

// ==================== NAVIGATION ====================
function navigate(dir) {
    if (calView === 'month') {
        calMonth += dir;
        if (calMonth < 0) { calMonth = 11; calYear--; }
        if (calMonth > 11) { calMonth = 0; calYear++; }
    } else {
        weekStartDay += dir * 7;
        // Adjust month/year if week crosses boundaries
        const ref = new Date(calYear, calMonth, weekStartDay);
        calYear = ref.getFullYear();
        calMonth = ref.getMonth();
        weekStartDay = ref.getDate();
    }
    renderCalendar();
}

function goToday() {
    const today = new Date();
    calYear = today.getFullYear();
    calMonth = today.getMonth();
    weekStartDay = today.getDate() - today.getDay();
    renderCalendar();
}

function setView(v) {
    calView = v;
    $('#btnMonth').toggleClass('active', v === 'month');
    $('#btnWeek').toggleClass('active', v === 'week');
    $('#viewMonth').toggleClass('active', v === 'month');
    $('#viewWeek').toggleClass('active', v === 'week');
    renderCalendar();
}

// ==================== TASK HELPERS ====================
function tasksForUserOnDate(userId, y, m, d) {
    const ds = dateKey(y, m, d);
    const dow = new Date(y, m, d).getDay();
    return Object.entries(localTasks)
        .map(([id, t]) => ({ id, ...t }))
        .filter(t =>
            t.userId === userId &&
            (t.daysOfWeek || []).includes(dow) &&
            ds >= (t.startDate || '0000-00-00') &&
            (!t.endDate || ds <= t.endDate)
        );
}

function pctForUserOnDate(userId, y, m, d) {
    const tasks = tasksForUserOnDate(userId, y, m, d);
    if (tasks.length === 0) return null;
    const ds = dateKey(y, m, d);
    const done = tasks.filter(t => {
        const c = localCompletions[`${userId}_${ds}_${t.id}`];
        return c && c.completed === true;
    }).length;
    return Math.round((done / tasks.length) * 100);
}

function avatarClass(pct) {
    if (pct === null) return 'none';
    if (pct >= 100) return 'p100';
    if (pct >= 80) return 'p80';
    if (pct >= 60) return 'p60';
    if (pct >= 40) return 'p40';
    if (pct > 0) return 'p20';
    return 'p0';
}

function avatarHtml(u, pct) {
    const initial = u.name ? u.name.charAt(0) : '?';
    return `<span class="avatar ${avatarClass(pct)}" title="${escapeHtml(u.name)} — ${pct === null ? 'لا مهام' : pct + '%'}"
        onclick="event.stopPropagation(); openUserPanel('${u.id}')">${escapeHtml(initial)}</span>`;
}

// Task overall progress for dashboard
function taskProgress(t) {
    const today = dateKey(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    const from = t.startDate && t.startDate > today ? t.startDate : today;
    const to = (t.endDate && t.endDate < today) ? t.endDate : today;
    let total = 0, done = 0;
    const dt = new Date(from + 'T00:00:00');
    const endDt = new Date(to + 'T00:00:00');
    while (dt <= endDt) {
        const ds = dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
        if ((t.daysOfWeek || []).includes(dt.getDay()) && ds >= (t.startDate || '0000-00-00')) {
            total++;
            const c = localCompletions[`${t.userId}_${ds}_${t.id}`];
            if (c && c.completed === true) done++;
        }
        dt.setDate(dt.getDate() + 1);
    }
    return total === 0 ? 0 : Math.round((done / total) * 100);
}

// ==================== RENDER CALENDAR ====================
function renderCalendar() {
    updatePeriodLabel();
    if (calView === 'month') renderMonth();
    else renderWeek();
}

function updatePeriodLabel() {
    if (calView === 'month') {
        $('#periodLabel').text(`${MONTH_NAMES[calMonth]} ${calYear}`);
    } else {
        const start = new Date(calYear, calMonth, weekStartDay);
        const end = new Date(calYear, calMonth, weekStartDay + 6);
        const sm = MONTH_NAMES[start.getMonth()];
        const em = MONTH_NAMES[end.getMonth()];
        if (start.getMonth() === end.getMonth()) {
            $('#periodLabel').text(`${start.getDate()} – ${end.getDate()} ${sm} ${end.getFullYear()}`);
        } else {
            $('#periodLabel').text(`${start.getDate()} ${sm} – ${end.getDate()} ${em} ${end.getFullYear()}`);
        }
    }
}

function renderMonth() {
    const grid = $('#monthGrid');
    let html = '';
    for (const n of DAY_NAMES) html += `<div class="dow">${n}</div>`;

    const first = new Date(calYear, calMonth, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const prevDays = new Date(calYear, calMonth, 0).getDate();
    const today = new Date();

    for (let i = 0; i < startDow; i++) {
        html += `<div class="day-cell other-month"><span class="day-num">${prevDays - startDow + 1 + i}</span></div>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const isToday = d === today.getDate() && calMonth === today.getMonth() && calYear === today.getFullYear();
        html += `<div class="day-cell ${isToday ? 'today' : ''}" onclick="openDayPanel(${d})">
            <span class="day-num">${d}</span>
            <div class="avatar-row">`;
        const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
        for (const u of users) {
            html += avatarHtml(u, pctForUserOnDate(u.id, calYear, calMonth, d));
        }
        html += `</div></div>`;
    }
    const total = startDow + daysInMonth;
    const trailing = (7 - (total % 7)) % 7;
    for (let i = 1; i <= trailing; i++) {
        html += `<div class="day-cell other-month"><span class="day-num">${i}</span></div>`;
    }
    grid.html(html);
}

function renderWeek() {
    const grid = $('#weekGrid');
    let html = '';
    const today = new Date();

    for (let i = 0; i < 7; i++) {
        const dt = new Date(calYear, calMonth, weekStartDay + i);
        const d = dt.getDate();
        const m = dt.getMonth();
        const y = dt.getFullYear();
        const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
        const inMonth = m === calMonth || (Math.abs(m - calMonth) <= 1);

        html += `<div class="week-day">
            <div class="week-day-header ${isToday ? 'today' : ''}">
                <div class="dow-name">${DAY_NAMES[i]}</div>
                <div class="d-num">${d}</div>
            </div>
            <div class="week-day-body" ${inMonth ? `onclick="openDayPanel(${d},${m},${y})"` : ''}>`;
        if (inMonth) {
            const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
            for (const u of users) {
                const tasks = tasksForUserOnDate(u.id, y, m, d);
                if (tasks.length === 0) continue;
                const pct = pctForUserOnDate(u.id, y, m, d);
                const ds = dateKey(y, m, d);
                html += `<div class="week-user-block">
                    <div class="week-user-head">${avatarHtml(u, pct)}<span class="week-user-name">${escapeHtml(u.name)}</span></div>`;
                for (const t of tasks) {
                    const c = localCompletions[`${u.id}_${ds}_${t.id}`];
                    const done = c && c.completed === true;
                    html += `<div class="task-chip ${done ? 'done' : ''}" style="background:${t.color}18;"
                        onclick="event.stopPropagation(); toggleTask('${u.id}','${ds}','${t.id}')">
                        <span class="t-dot" style="background:${t.color}"></span> ${escapeHtml(t.name)}
                        ${done ? '<i class="bi bi-check-lg t-check" style="color:#10b981"></i>' : ''}
                    </div>`;
                }
                html += `</div>`;
            }
        }
        html += `</div></div>`;
    }
    grid.html(html);
}

// ==================== DAY DETAIL PANEL ====================
function openDayPanel(d, m, y) {
    if (m === undefined) { m = calMonth; y = calYear; }
    const dow = new Date(y, m, d).getDay();
    $('#dayPanelTitle').text(`${DAY_NAMES[dow]} ${d} ${MONTH_NAMES[m]} ${y}`);
    const ds = dateKey(y, m, d);
    let html = '';
    const users = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));

    for (const u of users) {
        const tasks = tasksForUserOnDate(u.id, y, m, d);
        if (tasks.length === 0) continue;
        const pct = pctForUserOnDate(u.id, y, m, d);
        html += `<div class="day-user-section">
            <div class="day-user-head">
                ${avatarHtml(u, pct)}
                <span class="day-user-name">${escapeHtml(u.name)}</span>
                <span class="day-user-pct">${pct}%</span>
            </div>`;
        for (const t of tasks) {
            const c = localCompletions[`${u.id}_${ds}_${t.id}`];
            const done = c && c.completed === true;
            html += `<div class="check-task ${done ? 'done' : ''}" onclick="toggleTask('${u.id}','${ds}','${t.id}')">
                <span class="ct-box">${done ? '<i class="bi bi-check-lg"></i>' : ''}</span>
                <span class="ct-name">${escapeHtml(t.name)}</span>
                <span class="ct-dot" style="background:${t.color}"></span>
            </div>`;
        }
        html += `</div>`;
    }
    if (!html) html = '<p style="color:var(--text-muted);text-align:center;padding:30px 0;">لا مهام مجدولة لهذا اليوم</p>';
    $('#dayPanelBody').html(html);
    $('#panelOverlay').addClass('open');
    $('#dayPanel').addClass('open');
}

// ==================== USER DASHBOARD PANEL ====================
function openUserPanel(userId) {
    const u = localUsers[userId];
    if (!u) return;
    const myTasks = Object.entries(localTasks)
        .map(([id, t]) => ({ id, ...t }))
        .filter(t => t.userId === userId);
    const progresses = myTasks.map(t => taskProgress(t));
    const overall = progresses.length ? Math.round(progresses.reduce((a,b)=>a+b,0) / progresses.length) : 0;

    let html = `
        <div class="dash-hero">
            <div class="dash-avatar" style="background:${u.color || '#6366f1'}">${escapeHtml(u.name ? u.name.charAt(0) : '?')}</div>
            <div>
                <div class="dash-name">${escapeHtml(u.name)}</div>
                <div class="dash-sub">${myTasks.length} مهام نشطة</div>
            </div>
        </div>
        <div class="dash-overall">
            <div><div class="pct">${overall}%</div><div class="lbl">نسبة الإنجاز الكلية</div></div>
            <i class="bi bi-graph-up-arrow" style="font-size:2rem;opacity:0.6"></i>
        </div>
        <p class="dash-section-title">تقدم المهام</p>`;

    for (const t of myTasks) {
        const p = taskProgress(t);
        const daysTxt = (t.daysOfWeek || []).map(i => DAY_NAMES[i].replace('ال','')).join('، ');
        const rangeTxt = `${t.startDate || '—'} ← ${t.endDate || 'بدون نهاية'}`;
        html += `<div class="task-progress">
            <div class="tp-head">
                <span class="tp-name"><span class="legend-dot" style="background:${t.color};width:10px;height:10px;border-radius:50%;display:inline-block"></span> ${escapeHtml(t.name)}</span>
                <span class="tp-pct">${p}%</span>
            </div>
            <div class="tp-bar"><div class="tp-fill" style="width:${p}%;background:${t.color}"></div></div>
            <div class="tp-range">${daysTxt || 'كل الأيام'} • ${rangeTxt}</div>
        </div>`;
    }
    if (myTasks.length === 0) html += '<p style="color:var(--text-muted);text-align:center;">لا مهام لهذا المستخدم</p>';

    $('#userPanelBody').html(html);
    $('#panelOverlay').addClass('open');
    $('#userPanel').addClass('open');
}

// ==================== TOGGLE TASK ====================
function toggleTask(userId, ds, taskId) {
    const key = `${userId}_${ds}_${taskId}`;
    const existing = localCompletions[key];
    const completed = !(existing && existing.completed === true);

    completionsNode.get(key).put({ userId, taskId, date: ds, completed, timestamp: Date.now() });
    localCompletions[key] = { userId, taskId, date: ds, completed, timestamp: Date.now() };
    saveToLocal();
    broadcastCurrentData();

    renderCalendar();
    // Refresh open panels
    if ($('#dayPanel').hasClass('open')) {
        const parts = ds.split('-');
        openDayPanel(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    }
}

function closePanels() {
    $('#panelOverlay').removeClass('open');
    $('#dayPanel').removeClass('open');
    $('#userPanel').removeClass('open');
}

// ==================== P2P BROADCAST ====================
function broadcastCurrentData() {
    if (typeof P2P === 'undefined' || !P2P.actions || !P2P.actions.family) return;
    P2P.broadcast && P2P.broadcast({
        type: 'family-sync',
        familyCode: familyCode,
        familyName: sessionStorage.getItem('familyName') || '',
        members: localUsers,
        tasks: localTasks,
        completions: localCompletions
    });
}

// ==================== P2P SHARE & DEVICES ====================
let pendingJoinRequests = [];
let joinRequestRateLimit = {};

$(document).ready(function() {
    if (typeof P2P !== 'undefined') {
        P2P.init({
            familyCode: familyCode,
            onMessage: function(peerId, message) {
                if (message.type === 'peer-name' && message.name) {
                    if (P2P.peerList[peerId]) {
                        P2P.peerList[peerId].name = message.name;
                        P2P._savePeerList();
                        loadConnectedDevices();
                    }
                }
                if (message.type === 'family-sync') {
                    let changed = false;
                    if (message.members) {
                        Object.entries(message.members).forEach(([id, member]) => {
                            if (!localUsers[id] || member.createdAt > (localUsers[id].createdAt || 0)) {
                                localUsers[id] = member; changed = true;
                            }
                        });
                    }
                    if (message.tasks) {
                        Object.entries(message.tasks).forEach(([id, task]) => {
                            if (!localTasks[id] || task.createdAt > (localTasks[id].createdAt || 0)) {
                                localTasks[id] = task; changed = true;
                            }
                        });
                    }
                    if (message.completions) {
                        Object.entries(message.completions).forEach(([id, comp]) => {
                            if (!localCompletions[id] || comp.timestamp > (localCompletions[id].timestamp || 0)) {
                                localCompletions[id] = comp; changed = true;
                            }
                        });
                    }
                    if (changed) {
                        saveToLocal();
                        renderCalendar();
                    }
                }
                if (message.type === 'connection-approved') {
                    Swal.close();
                    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تمت الموافقة! جاري تحميل البيانات...', showConfirmButton: false, timer: 3000 });
                }
                if (message.type === 'connection-rejected') {
                    Swal.close();
                    Swal.fire({ icon: 'error', title: 'تم رفض الاتصال', text: 'رفض مسؤول العائلة طلب الاتصال.', confirmButtonText: 'حسناً' });
                }
            },
            onPeerJoin: function(peerId) { updateSyncIndicator(); loadConnectedDevices(); },
            onPeerLeave: function(peerId) { updateSyncIndicator(); loadConnectedDevices(); },
            onJoinRequest: function(peerId, requestData) { handleJoinRequest(peerId, requestData); }
        });
    }
});

function handleJoinRequest(peerId, requestData) {
    const deviceName = requestData.deviceName || 'Unknown Device';
    const now = Date.now();
    if (!joinRequestRateLimit[peerId]) joinRequestRateLimit[peerId] = { count: 0, firstAttempt: now };
    const rateInfo = joinRequestRateLimit[peerId];
    if (now - rateInfo.firstAttempt > 5 * 60 * 1000) joinRequestRateLimit[peerId] = { count: 1, firstAttempt: now };
    else rateInfo.count++;
    if (rateInfo.count > 5) { P2P.rejectPeer(peerId); return; }

    const existing = pendingJoinRequests.findIndex(r => r.peerId === peerId);
    if (existing >= 0) { pendingJoinRequests[existing].deviceName = deviceName; pendingJoinRequests[existing].timestamp = now; }
    else pendingJoinRequests.push({ peerId, deviceName, timestamp: now });
    updateJoinRequestsBadge();
    renderJoinRequests();
}

function updateJoinRequestsBadge() {
    const badge = document.getElementById('joinRequestsBadge');
    if (badge) {
        if (pendingJoinRequests.length > 0) { badge.textContent = pendingJoinRequests.length; badge.style.display = 'flex'; }
        else badge.style.display = 'none';
    }
}

function renderJoinRequests() {
    const container = document.getElementById('joinRequestsList');
    if (!container) return;
    if (pendingJoinRequests.length === 0) { container.innerHTML = '<p class="text-muted"><small>لا توجد طلبات حالياً</small></p>'; return; }
    let html = '';
    pendingJoinRequests.forEach((req) => {
        const timeAgo = getTimeAgo(req.timestamp);
        html += `<div class="join-request-card" id="request-${req.peerId}">
            <div class="d-flex justify-content-between align-items-center">
                <div><div class="request-info"><i class="bi bi-phone"></i> ${escapeHtml(req.deviceName)}</div><div class="request-time">${timeAgo}</div></div>
                <div class="d-flex gap-2">
                    <button class="btn btn-sm btn-success" onclick="approveRequest('${req.peerId}')"><i class="bi bi-check-lg"></i> قبول</button>
                    <button class="btn btn-sm btn-danger" onclick="rejectRequest('${req.peerId}')"><i class="bi bi-x-lg"></i> رفض</button>
                </div>
            </div></div>`;
    });
    container.innerHTML = html;
}

function approveRequest(peerId) {
    const req = pendingJoinRequests.find(r => r.peerId === peerId);
    if (!req) return;
    P2P.approvePeer(peerId, req.deviceName);
    pendingJoinRequests = pendingJoinRequests.filter(r => r.peerId !== peerId);
    updateJoinRequestsBadge();
    renderJoinRequests();
    loadConnectedDevices();
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `تمت الموافقة على: ${escapeHtml(req.deviceName)}`, showConfirmButton: false, timer: 3000 });
}

function rejectRequest(peerId) {
    P2P.rejectPeer(peerId);
    pendingJoinRequests = pendingJoinRequests.filter(r => r.peerId !== peerId);
    updateJoinRequestsBadge();
    renderJoinRequests();
    Swal.fire({ toast: true, position: 'top-end', icon: 'info', title: 'تم رفض الاتصال', showConfirmButton: false, timer: 2000 });
}

function loadShareSection() {
    const qrEl = document.getElementById('shareQRCode');
    const linkEl = document.getElementById('shareLink');
    const statusEl = document.getElementById('shareRoomStatus');
    const isP2PReady = typeof P2P !== 'undefined' && P2P._joined && P2P.room;
    const roomId = typeof P2P !== 'undefined' ? P2P.getStoredRoomId(familyCode) : null;

    if (statusEl) {
        if (isP2PReady) {
            const peerCount = P2P.connectedPeers.size;
            statusEl.innerHTML = `<div class="alert alert-success mb-3"><i class="bi bi-check-circle-fill"></i> <strong>الغرفة نشطة</strong> — جاهز لاستقبال الأجهزة الجديدة${peerCount > 0 ? `<br><small><i class="bi bi-wifi"></i> ${peerCount} جهاز متصل حالياً</small>` : ''}</div>`;
        } else {
            statusEl.innerHTML = `<div class="alert alert-warning mb-3"><i class="bi bi-hourglass-split"></i> <strong>جاري الاتصال بالغرفة...</strong><br><small>يرجى الانتظار حتى يتم تأسيس الاتصال</small></div>`;
        }
    }
    if (!roomId) { if (qrEl) qrEl.innerHTML = '<p class="text-muted">لم يتم العثور على معرف الغرفة</p>'; return; }

    const baseUrl = window.location.origin + window.location.pathname.replace(/\/app\/index\.html$/, '/index.html');
    const shareUrl = baseUrl + '?join=' + encodeURIComponent(familyCode) + '&room=' + encodeURIComponent(roomId);

    if (typeof qrcode !== 'undefined') {
        const qr = qrcode(0, 'M'); qr.addData(shareUrl); qr.make();
        if (qrEl) qrEl.innerHTML = qr.createSvgTag(4, 0);
    }
    if (linkEl) linkEl.value = shareUrl;

    if (!isP2PReady && typeof P2P !== 'undefined') {
        const checkReady = setInterval(() => { if (P2P._joined && P2P.room) { clearInterval(checkReady); loadShareSection(); } }, 1000);
        setTimeout(() => clearInterval(checkReady), 10000);
    }
    renderJoinRequests();
}

function copyShareLink() {
    const link = document.getElementById('shareLink');
    if (link) { navigator.clipboard.writeText(link.value); Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم النسخ', showConfirmButton: false, timer: 1500 }); }
}

function shareViaWhatsApp() {
    const link = document.getElementById('shareLink');
    if (link) { window.open('https://wa.me/?text=' + encodeURIComponent('انضم لجدول المهام العائلي: ' + link.value), '_blank'); }
}

function updateSyncIndicator() {
    const connected = typeof P2P !== 'undefined' ? Object.keys(P2P.getConnectedPeers()).length : 0;
    const dot = document.querySelector('.sync-dot');
    if (dot) { dot.style.background = connected > 0 ? '#34d399' : '#94a3b8'; dot.title = connected > 0 ? `${connected} جهاز متصل` : 'غير متصل'; }
}

function loadConnectedDevices() {
    if (typeof P2P === 'undefined') return;
    const peers = P2P.getAllPeers();
    const connected = P2P.getConnectedPeers();
    const peerEntries = Object.entries(peers);
    const approvedTokens = P2P.getApprovedTokens();
    const approvedEntries = Object.entries(approvedTokens);
    let html = '';

    if (approvedEntries.length > 0) {
        html += '<h6 class="mb-2 mt-1"><i class="bi bi-shield-check text-success"></i> الأجهزة الموثقة</h6>';
        approvedEntries.forEach(([hash, info]) => {
            const timeAgo = info.lastSeen ? getTimeAgo(info.lastSeen) : '';
            const approvedDate = info.approvedAt ? new Date(info.approvedAt).toLocaleDateString('ar-SA') : '';
            html += `<div class="d-flex justify-content-between align-items-center p-2 mb-2" style="background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
                <div><strong>${escapeHtml(info.deviceName || 'جهاز غير معروف')}</strong><br><small style="color:#94a3b8;">موثق منذ ${approvedDate} ${timeAgo ? '· آخر اتصال: ' + timeAgo : ''}</small></div>
                <div class="d-flex align-items-center gap-2"><span style="width:8px;height:8px;border-radius:50%;background:var(--success);"></span><button class="btn btn-sm btn-outline-danger" onclick="revokeApprovedDevice('${hash}','${escapeHtml(info.deviceName || '')}')"><i class="bi bi-x-lg"></i></button></div></div>`;
        });
    }
    if (peerEntries.length > 0) {
        html += '<h6 class="mb-2 mt-3"><i class="bi bi-wifi text-primary"></i> الأجهزة المتصلة</h6>';
        peerEntries.forEach(([id, peer]) => {
            const isConnected = !!connected[id];
            const statusColor = isConnected ? 'var(--success)' : '#94a3b8';
            const statusText = isConnected ? 'متصل' : 'غير متصل';
            const timeAgo = peer.lastSeen ? getTimeAgo(peer.lastSeen) : '';
            html += `<div class="d-flex justify-content-between align-items-center p-2 mb-2" style="background:#f8fafc;border-radius:10px;">
                <div><strong>${escapeHtml(peer.name || id)}</strong><br><small style="color:#94a3b8;">${statusText} ${timeAgo ? '· ' + timeAgo : ''}</small></div>
                <div class="d-flex align-items-center gap-2"><span style="width:8px;height:8px;border-radius:50%;background:${statusColor};"></span><button class="btn btn-sm btn-outline-danger" onclick="disconnectDevice('${id}')"><i class="bi bi-x-lg"></i></button></div></div>`;
        });
    }
    if (peerEntries.length === 0 && approvedEntries.length === 0) html = '<p class="text-muted"><i class="bi bi-info-circle"></i> لا توجد أجهزة متصلة أو موثقة.</p>';
    $('#connectedDevicesList').html(html);
}

function disconnectDevice(peerId) {
    if (typeof P2P !== 'undefined') { P2P.removePeer(peerId); loadConnectedDevices(); updateSyncIndicator(); Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم قطع الاتصال', showConfirmButton: false, timer: 1500 }); }
}

async function revokeApprovedDevice(tokenHash, deviceName) {
    const result = await Swal.fire({ title: 'إزالة التوثيق', html: `هل تريد إزالة توثيق الجهاز: <strong>${escapeHtml(deviceName)}</strong>؟<br><small class="text-muted">سيحتاج الجهاز إلى موافقة جديدة للاتصال.</small>`, icon: 'warning', showCancelButton: true, confirmButtonText: 'نعم، أزل التوثيق', cancelButtonText: 'إلغاء', confirmButtonColor: '#ef4444' });
    if (result.isConfirmed) { await P2P.revokeApprovedToken(tokenHash); loadConnectedDevices(); Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم إزالة توثيق الجهاز', showConfirmButton: false, timer: 1500 }); }
}

function getTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'الآن';
    if (mins < 60) return `منذ ${mins} دقيقة`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `منذ ${hours} ساعة`;
    return `منذ ${Math.floor(hours / 24)} يوم`;
}

// ==================== SETTINGS ====================
function openSettings() {
    promptPinForSettings(function() {
        $('#settingsOverlay').addClass('active');
        $('body').addClass('settings-open');
        if (typeof loadSettingsData === 'function') loadSettingsData();
    });
}

function closeSettings() {
    $('#settingsOverlay').removeClass('active');
    $('body').removeClass('settings-open');
}

async function promptPinForSettings(callback) {
    const usersWithPins = Object.values(localUsers).filter(u => u.pinHash);
    if (usersWithPins.length === 0) { callback(); return; }
    const allUsers = Object.entries(localUsers).map(([id, u]) => ({ id, ...u }));
    const inputOptions = {};
    allUsers.forEach(u => { inputOptions[u.id] = u.name; });

    const { value: formValues } = await Swal.fire({
        title: '<i class="bi bi-shield-lock"></i> الدخول للإعدادات',
        html: '<p class="text-muted mb-3">أدخل الرمز الشخصي للوصول</p>',
        input: 'select', inputOptions, inputPlaceholder: 'اختر المستخدم',
        showCancelButton: true, confirmButtonText: 'متابعة', cancelButtonText: 'إلغاء',
        inputValidator: (value) => { if (!value) return 'يرجى اختيار مستخدم'; }
    });
    if (!formValues) return;

    const selectedUser = localUsers[formValues];
    if (!selectedUser || !selectedUser.pinHash) { lastPinVerification = Date.now(); callback(); return; }

    const { value: pin } = await Swal.fire({
        title: `<i class="bi bi-person-fill"></i> ${escapeHtml(selectedUser.name)}`,
        html: '<p class="text-muted mb-3">أدخل الرمز الشخصي</p>',
        input: 'password', inputPlaceholder: '••••',
        inputAttributes: { maxlength: 6, inputmode: 'numeric', pattern: '[0-9]*', style: 'text-align:center;font-size:28px;letter-spacing:12px;' },
        showCancelButton: true, confirmButtonText: 'تأكيد', cancelButtonText: 'إلغاء',
        showLoaderOnConfirm: true, allowOutsideClick: () => !Swal.isLoading(),
        preConfirm: async (p) => {
            if (!p) { Swal.showValidationMessage('يرجى إدخال الرمز'); return false; }
            const pinHash = await hashPin(p);
            if (pinHash !== selectedUser.pinHash) { Swal.showValidationMessage('الرمز غير صحيح'); return false; }
            return p;
        }
    });
    if (pin) { lastPinVerification = Date.now(); callback(); }
}

function logout() {
    sessionStorage.clear();
    localStorage.removeItem('taskSchedule_lastSession');
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: 'تم تسجيل الخروج', showConfirmButton: false, timer: 1500 });
    setTimeout(() => { window.location.href = '../index.html'; }, 1500);
}

// Keyboard shortcuts
$(document).keydown(function(e) { if (e.ctrlKey && e.key === 'r') { e.preventDefault(); location.reload(); } });
$(document).ready(function() { $(document).on('keydown', function(e) { if (e.key === 'Escape') { if ($('#settingsOverlay').hasClass('active')) { closeSettings(); } else { closePanels(); } } }); });